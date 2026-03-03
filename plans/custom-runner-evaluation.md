# Evaluating Whether a Provider Needs a Custom Runner

This document explains how to determine whether a new provider should be added to
`providersWithCustomRunners.json`, and how the rule of thumb encoded there was derived.
It uses the Grafana provider evaluation (Feb 2026) as the worked example.

---

## Background: The Two Runner Tiers

`providersWithCustomRunners.json` controls a single boolean — `useCustomGithubRunner` —
that cascades from `create-projen-files.js` into each provider repo's `.projenrc.js` and
ultimately into the `CdktnProviderProject` construct.

| Tier | Runner | Cores | RAM | `NODE_OPTIONS` |
|---|---|---|---|---|
| Standard | `ubuntu-latest` | 2 | 7 GB | `--max-old-space-size=6656` |
| Custom | `depot-ubuntu-24.04-8` (Depot) | 8 | 32 GB | `--max-old-space-size=31744` |

**Root cause of needing a custom runner:** JSII compilation of provider bindings exhausts
the standard runner's heap. The CDKTF toolchain generates TypeScript interfaces from the
provider's Terraform schema, then compiles that TypeScript with `jsii`. Every resource,
data source, nested block, and attribute becomes a TypeScript type. For large providers
with deep block nesting (e.g. kubernetes pods, AWS IAM policies), the heap requirement
during compilation can exceed 6 GB.

The question is therefore: *how complex is this provider's schema?*

---

## Metrics Considered

When evaluating a new provider, the following metrics were considered as potential proxies
for schema complexity:

| # | Metric | How to measure | Intuition |
|---|---|---|---|
| 1 | **Provider binary size** | `stat` after `terraform init` | Larger binary → more code → bigger schema? |
| 2 | **Registry doc counts** | Terraform Registry v2 API | Resource + data source page count |
| 3 | **Schema JSON file size** | `terraform providers schema -json` | Direct measure of schema bytes |
| 4 | **Recursive attribute count** | Python traversal of schema JSON | Deep nesting → lots of TypeScript interfaces |

All four were collected for the 14-provider reference set. The analysis below shows which
metrics are reliable separators and which are not.

---

## Approach: How the Data Was Collected

### Step 1 — Download provider binaries

For each provider, an isolated temp dir is created with a minimal `versions.tf` and
`terraform init -backend=false` is run concurrently to download binaries:

```bash
# scripts/bench-providers-init.sh
mkdir -p /tmp/tf-bench/<provider>
cat > /tmp/tf-bench/<provider>/versions.tf <<EOF
terraform {
  required_providers {
    <alias> = { source = "<namespace>/<name>" }
  }
}
EOF
terraform -chdir=/tmp/tf-bench/<provider> init -backend=false -no-color
```

This also stages the binary on disk so the next step can extract the schema without
re-downloading.

### Step 2 — Extract schema and count attributes

With the provider binary already present, `terraform providers schema -json` runs in the
same directory. A Python script (`scripts/bench-providers-schema.py`) then traverses the
full schema tree recursively — counting every attribute at every nesting depth — and
reports schema file size alongside the counts.

```python
def count_attrs_recursive(block: dict) -> int:
    count = len(block.get("attributes", {}))
    for btype in block.get("block_types", {}).values():
        count += count_attrs_recursive(btype.get("block", {}))
    return count
```

A naïve top-level-only attribute count (`jq '… | length'`) severely undercounts providers
with deep nesting. Kubernetes, for example, shows only **287** top-level attributes but
**9,283** when counted recursively — because Kubernetes resources encode pod specs,
container definitions, and volume mounts as deeply nested block types, not flat attributes.

### Approach considered but not used: Terraform Registry API

The Terraform Registry v2 API (`/v2/provider-docs`) can return resource and data-source
doc page counts without downloading any binary. This was the planned "fast path" (step E
in the original evaluation plan). In practice it was dropped for two reasons:

1. The pagination endpoint is fragile — the v2 filter parameters failed silently for all
   providers in our environment, returning empty results. The simpler v1 endpoint
   (`/v1/providers/<ns>/<name>`) works but only returns version metadata, not doc counts.
2. Doc page counts can differ from schema resource counts (e.g. a provider may document
   multiple resources on one page, or list sub-resources separately). Schema JSON gives
   exact counts that match what JSII actually compiles.

The registry API remains useful for a quick sanity-check on the provider version, but
schema JSON is the authoritative source.

---

## The Reference Dataset (14 providers, Feb 2026)

All 14 providers were evaluated. The 6 known custom-runner providers act as the "positive"
class; the 7 known standard providers (plus grafana as the candidate) act as the negative
class.

```
Provider       Binary MB   Schema MB   Resources   DataSrcs  TotalAttrs(rec)  Runner
──────────────────────────────────────────────────────────────────────────────────────
aws              727.4       14.07       1614         644        90,903        CUSTOM ✓
googlebeta       129.1        7.68       1313         436        32,387        CUSTOM ✓
google           122.1        7.14       1182         406        29,830        CUSTOM ✓
azurerm          213.8        3.05       1124         393        28,469        CUSTOM ✓
kubernetes        59.8        2.98         81          26         9,283        CUSTOM ✓
datadog           59.2        2.34        129          76        11,917        CUSTOM ✓
─── threshold ─────────────── ~2.25 ─────────────────────────── ~6,000 ─────────────
cloudflare       154.4        2.18        211         357         4,970        standard
snowflake         57.5        1.13        107          54         3,248        standard
vault             38.5        0.58        160          45         3,440        standard
grafana           83.2        0.39         93          49         1,927        standard (candidate)
github            22.1        0.19         85          73         1,261        standard
azuread           55.1        0.18         54          20         1,105        standard
docker            62.3        0.08         11           6           431        standard
helm              62.9        0.03          1           1            95        standard
```

---

## Why Binary Size Is Not a Reliable Separator

The first instinct is to use binary size — it is fast to measure (no schema extraction
needed) and intuitively correlates with provider complexity. The data shows this
intuition breaks down:

```
Provider    Binary MB   Runner     Problem?
──────────────────────────────────────────────────────────────────────────────
cloudflare    154.4     standard   ← 154 MB binary, yet standard runner suffices
helm           62.9     standard   ← 63 MB binary, yet standard runner suffices
docker         62.3     standard   ← 62 MB binary, yet standard runner suffices
kubernetes     59.8     CUSTOM     ← 60 MB binary, needs custom runner
datadog        59.2     CUSTOM     ← 59 MB binary, needs custom runner
snowflake      57.5     standard   ← 58 MB binary, yet standard runner suffices
```

Cloudflare (154 MB) sits comfortably on standard runners, while datadog (59 MB) and
kubernetes (60 MB) require custom ones. The binary size reflects compiled Go code,
optimisation flags, and bundled static assets — not the schema complexity that drives
JSII heap usage.

**Binary size should not be used as the primary decision metric.** It can serve as a
rough upper bound (a 700+ MB binary is almost certainly a custom-runner provider), but
it cannot distinguish the 50–200 MB "middle tier" where most decisions need to be made.

---

## Why Schema JSON Size and Recursive Attribute Count Work

Both metrics directly measure the schema that JSII has to compile:

- **Schema JSON size** is the raw byte count of `terraform providers schema -json`. Larger
  JSON → more TypeScript to generate → more types for the compiler to check in a single
  pass → more heap.

- **Recursive attribute count** counts every attribute at every nesting depth. For deeply
  nested providers (kubernetes in particular) this matters more than flat resource counts:
  kubernetes has only 81 resources but 9,283 recursive attributes because each resource
  definition encodes the entire Kubernetes API object graph.

Both metrics produce a **clean gap** in the reference dataset with no overlap:

| Metric | Standard maximum | GAP | Custom minimum |
|---|---|---|---|
| Schema JSON | 2.18 MB (cloudflare) | 0.16 MB | 2.34 MB (datadog) |
| Recursive attrs | 4,970 (cloudflare) | 4,313 | 9,283 (kubernetes) |

Cloudflare is the hardest standard provider to classify correctly: it is large by binary
size (154 MB) and by resource count (211 + 357 data sources), but its schema is relatively
flat (no deep nesting), keeping both schema JSON and recursive attrs comfortably below the
threshold.

---

## The Rule

> **A provider needs a custom runner if:**
>
> `schema_json > 2.25 MB`  **OR**  `total_attrs_recursive > 6,000`

Either condition is sufficient. In practice both metrics agree for all providers in the
reference set — if you're near the boundary, both should be checked.

The `OR` is intentional: a provider could have a modest schema file size but extreme
nesting depth (pushing up recursive attrs without much raw JSON), or vice versa.

---

## Worked Example: Grafana (Feb 2026)

**Provider:** `grafana/grafana`, latest version `4.25.0`

```
Metric                 Grafana value   Threshold    Decision
──────────────────────────────────────────────────────────────────────
Schema JSON size       0.39 MB         > 2.25 MB    below
Recursive attrs        1,927           > 6,000      below
Binary size            83.2 MB         (informational only)
```

Grafana sits between vault (0.58 MB, 3,440 attrs) and snowflake (1.13 MB, 3,248 attrs)
in schema complexity. Both are standard-runner providers. Grafana is approximately 6× below
both thresholds.

**Verdict:** Grafana does **not** need a custom runner.

---

## Running the Evaluation

Two scripts in `scripts/` automate the data collection:

```bash
# Step 1 — download provider binaries (concurrent, ~3 min for 14 providers)
./scripts/bench-providers-init.sh

# Step 2 — extract schema metrics and print the classification table
python3 scripts/bench-providers-schema.py
```

To evaluate a single new provider, pass it to both scripts:

```bash
# Add one entry: alias:namespace/name
./scripts/bench-providers-init.sh newprovider:mynamespace/newprovider

# Then re-run the schema script for just that provider
python3 scripts/bench-providers-schema.py newprovider
```

The schema script prints a table with a `Verdict` column (CUSTOM or standard) and an
`Official?` column showing the current assignment. Any mismatch is flagged.

---

## Updating the Thresholds

The thresholds (2.25 MB, 6,000 attrs) should be revisited if:

- A provider is added to `providersWithCustomRunners.json` based on observed CI failures
  rather than pre-emptive evaluation (the failure is new data that may shift the gap)
- The JSII version or TypeScript compilation pipeline changes significantly
- The runner specs change (a different Depot tier with more or less RAM)

Re-run `bench-providers-schema.py` on the full sample set and verify the gap still holds
before updating the threshold constants in the script.
