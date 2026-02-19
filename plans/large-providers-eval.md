# Plan: Evaluate Grafana Provider for Custom Runners Requirement

## Context

The `providersWithCustomRunners.json` list controls whether a provider's CI uses Depot's `depot-ubuntu-24.04-8` (8-core, 32 GB) runner vs standard `ubuntu-latest` (2-core, 7 GB). The flag cascades via `create-projen-files.js` → `.projenrc.js` → `CdktnProviderProject` → `useCustomGithubRunner` boolean → runner selection and `NODE_OPTIONS --max-old-space-size` (31744 MB vs 6656 MB).

**Root cause of needing custom runners:** JSII compilation of provider bindings to multiple languages (especially Go) exhausts standard runner memory for large provider schemas.

**Current custom-runner providers:** aws, azurerm, datadog, google, googlebeta, kubernetes
**Standard providers (sample):** cloudflare, github, vault, snowflake, helm, azuread, docker
**New candidate:** grafana (grafana/grafana)

## Key Metric: What Determines Schema Size?

The provider schema JSON encodes every resource, data source, attribute, and nested block. Large schemas → more generated TypeScript → larger JSII compilation unit → more Node.js heap required. Relevant metrics:

1. **Resource count** (`resource_schemas | length`)
2. **Data source count** (`data_source_schemas | length`)
3. **Total attribute count** (sum of all attributes across all resources + data sources)
4. **Schema JSON file size** (raw bytes of `terraform providers schema -json` output)
5. **Provider binary size** (bytes of `.terraform/providers/…/*.zip` or binary after init)
6. **Max nesting depth** (deepest nested block chain across all resources)

## Selected Approaches (User Confirmed: A + C + E, starting with C)

### C. Provider Binary Size — START HERE (fastest, no analysis needed)
**Script:** For each provider, create an isolated temp dir with a `versions.tf` defining `required_providers`, run `terraform init -backend=false`, then `stat` the provider binary under `.terraform/providers/`.
```bash
# For each provider in sample set:
mkdir -p /tmp/tf-bench/<provider>
cat > /tmp/tf-bench/<provider>/versions.tf << EOF
terraform { required_providers { <provider> = { source = "<namespace>/<name>" } } }
EOF
terraform -chdir=/tmp/tf-bench/<provider> init -backend=false -no-color
find /tmp/tf-bench/<provider>/.terraform/providers -name '*.zip' -o -type f | xargs du -sh
```
**Output metric:** Provider binary size in MB.

### E. Terraform Registry API — second (zero local execution)
**Script:** For each provider, curl the Registry v2 API and count resource + data source docs.
```bash
# Get provider version listing and doc counts:
curl -s "https://registry.terraform.io/v2/providers?filter[namespace]=<ns>&filter[name]=<name>" | jq '.data[0].attributes'
# Then for doc count per category:
curl -s "https://registry.terraform.io/v2/provider-docs?filter[provider-version-id]=<id>&filter[category]=resources&page[size]=1" | jq '.meta.pagination."total-count"'
```
**Output metrics:** resource_count, data_source_count, guide_count.

### A. Terraform Schema JSON + jq — third (most precise, slowest)
**Script:** Same terraform init dirs as C, then run `terraform providers schema -json` and slice with jq.
```bash
terraform -chdir=/tmp/tf-bench/<provider> providers schema -json > /tmp/tf-bench/<provider>/schema.json
# Metrics:
jq '.provider_schemas | to_entries[0].value | {
  resources: (.resource_schemas | length),
  data_sources: (.data_source_schemas | length),
  total_attrs: ([.resource_schemas[], .data_source_schemas[]] | [.[].block.attributes // {} | length] | add)
}' /tmp/tf-bench/<provider>/schema.json
wc -c /tmp/tf-bench/<provider>/schema.json  # schema JSON byte size
```
**Output metrics:** resource_count (exact), data_source_count (exact), total_attributes, schema_json_bytes.

## Recommended Sample Set

| Provider | Custom Runner? | Notes |
|---|---|---|
| aws | ✓ | Largest provider (~1000+ resources) |
| google | ✓ | Very large |
| azurerm | ✓ | Very large |
| kubernetes | ✓ | Large |
| datadog | ✓ | Large |
| googlebeta | ✓ | Mirror of google |
| cloudflare | ✗ | Mid-size |
| vault | ✗ | Mid-size |
| azuread | ✗ | Mid-size |
| github | ✗ | Small-mid |
| snowflake | ✗ | Mid-size |
| helm | ✗ | Small |
| docker | ✗ | Small |
| **grafana** | **?** | **Candidate** |

## Grafana Registry Address

The Grafana provider on the Terraform Registry is at `grafana/grafana`. The E approach will confirm the exact version and resource/data source counts before we add it to `provider.json`.

## Proposed Rule of Thumb (hypothesis, to be validated)

Based on current data:
- Custom runner providers are the "mega-providers" of cloud infrastructure (aws, google, azure, k8s, datadog)
- Hypothesis thresholds (to be confirmed by data): binary_size > 150 MB OR resource_count > 250 OR schema_json_bytes > 8 MB
- Grafana is mid-sized (~170 resources documented) — likely borderline, data will decide

## Execution Order

1. **C (Binary Size):** Write a bash script to `terraform init` all providers in the sample set concurrently in `/tmp/tf-bench/`, collect binary sizes. Fast — should complete in 2-5 min total.
2. **E (Registry API):** For each provider, curl the Registry v2 API to get resource + data source doc counts. Instant — a few seconds total.
3. **A (Schema JSON):** Re-use the same `/tmp/tf-bench/` dirs from step 1, run `terraform providers schema -json` per provider, extract precise metrics with jq.
4. **Analysis:** Build a combined table, identify the natural threshold(s) separating the two groups, evaluate grafana, then ask user to confirm which metrics to include in the final rule.

## Output

After running all three approaches on the full sample set:
- Combined table: provider | binary_mb | resource_count | data_source_count | total_attrs | schema_json_mb | runner_tier
- Identified threshold(s) that correctly classify all existing providers
- Grafana's position relative to those thresholds
- Recommendation: add or don't add `grafana` to `providersWithCustomRunners.json`
- AskUserQuestion to confirm which metrics become the official rule of thumb

## Files to Potentially Modify

- `providersWithCustomRunners.json` - add "grafana" if it exceeds threshold
- `provider.json` - add grafana entry (if not already present)
- `sharded-stacks.json` - assign grafana to a stack

## Verification

After adding grafana to provider.json + custom runners (if needed), run:
```bash
yarn build && yarn synth
```
to verify the stack synthesizes without errors.
