# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Context

This is the **CDK Terrain (CDKTN) Repository Manager**, a fork from HashiCorp's CDKTF project after its sunset on December 10, 2025. The project has been renamed from "Terraform CDK" (CDKTF) to "CDK Terrain" (CDKTN) due to trademark considerations.

**Key Naming Changes:**
- Old GitHub org: `cdktf` → New org: `cdktn-io`
- Old npm scope: `@cdktf/` → New scope: `@cdktn`
- The core CDKTF packages (cdktf, cdktf-cli) are still used temporarily for generation
- The Projen project has been migrated to `@cdktn/provider-project`

**Current Milestone:**
Re-activate provider bindings using the last CDKTF release (0.21.0) to generate like-for-like bindings under the new CDKTN namespace. Priority languages: TypeScript, Python, and Golang. NuGet (.NET) and Maven (Java) support is commented out pending infrastructure setup.

## What This Repository Does

This repository uses **CDKTF (Infrastructure as Code)** to manage GitHub repositories that publish prebuilt Terraform provider bindings. It:

1. Defines GitHub repositories as CDKTF constructs
2. Creates provider repositories (e.g., `cdktn-provider-aws`)
3. Creates companion Go repositories (e.g., `cdktn-provider-aws-go`)
4. Configures repository settings: branch protection, labels, webhooks, team permissions
5. Manages GitHub Actions secrets for publishing to npm, PyPI, and Go
6. Orchestrates automated provider upgrades across all repositories

## Architecture Overview

### Stack-Based Architecture

The infrastructure is divided into **sharded stacks** defined in `sharded-stacks.json`:
- **Primary stack (`repos`)**: Contains the core providers and creates the repository manager and provider-project repos
- **Secondary stacks** (`repos-official-new`, `repos-partners`): Organize providers by category
- Each stack manages a subset of providers to avoid hitting infrastructure limits

### Key Files

- **`main.ts`**: Entry point that creates CDKTF stacks and validates configuration
- **`provider.json`**: Maps provider names to Terraform registry versions (e.g., `"aws": "hashicorp/aws@~> 6.0"`)
- **`sharded-stacks.json`**: Defines which providers belong to which stack
- **`providersWithCustomRunners.json`**: Maps providers requiring custom GitHub runners to their settings, e.g. `{"datadog": {"nodeHeapSizeMb": 24576}, "aws": {}}`. An empty object means "custom runner, default settings". A legacy plain-array form is still accepted.
- **`projenrc.template.js`**: Template for `.projenrc.js` files generated in provider repositories
- **`lib/repository.ts`**: Defines `GithubRepository` and `GithubRepositoryFromExistingRepository` constructs
- **`lib/secrets.ts`**: Manages GitHub Actions secrets for package publishing

### Core Components

1. **`CdkTerrainProviderStack`** (main.ts:70): Creates provider repositories for a given stack
   - Validates provider names (no `-go` suffix, names must match registry)
   - Creates main provider repos and companion `-go` repos
   - Configures secrets for multi-language publishing
   - Only the primary stack creates the repository-manager and provider-project repos

2. **`CustomConstructsStack`** (main.ts:245): Manages custom construct repositories (currently empty)

3. **`GithubRepository`** (lib/repository.ts:123): Creates a new GitHub repository with:
   - Branch protection on main
   - Issue labels: `automerge`, `no-auto-close`, `auto-approve`
   - Team permissions (admin access for `team-cdk-terrain`)
   - Slack webhook integration
   - Dependabot security updates

4. **`PublishingSecretSet`** (lib/secrets.ts:60): Manages publishing secrets per language:
   - GitHub: `gh-token` (also aliased as `PROJEN_GITHUB_TOKEN`, `GO_GITHUB_TOKEN`)
   - TypeScript/npm: `npm-token`
   - Python: `twine-username`, `twine-password`
   - Go: Uses GitHub token for publishing to separate repo
   - .NET/Java: Commented out (Maven, NuGet secrets)

## Common Commands

### Build and Deployment

```bash
# Install dependencies
pnpm install

# Generate CDKTF providers (GitHub provider)
pnpm run get

# Compile TypeScript
pnpm run build

# Run full build (get + compile)
pnpm run build

# Synthesize Terraform configuration
pnpm run synth

# Watch mode (recompile on changes)
pnpm run watch
```

### Code Quality

```bash
# Format code
pnpm run format

# Run linter
pnpm run lint

# Run tests (currently a placeholder)
pnpm run test
```

### CDKTN Operations

```bash
# Deploy a specific stack
cdktn deploy repos
cdktn deploy repos-official-new
cdktn deploy repos-partners

# Deploy with auto-approve
cdktn deploy --auto-approve repos

# Show Terraform output
pnpm run output

# Get list of provider repo URLs
pnpm run repos
```

### Upgrading Dependencies

```bash
# Upgrade CDKTN to latest
pnpm run upgrade

# Upgrade to next/beta version
pnpm run upgrade:next
```

Note the `run` is required here: `pnpm upgrade` (without `run`) is pnpm's own
builtin command (an alias for `pnpm update`) and shadows the `upgrade` script
defined in `package.json`, so it silently does something different from what
you want. Always use `pnpm run upgrade` / `pnpm run upgrade:next`.

## Development Workflow

### Adding a New Provider

1. Add the provider to `provider.json` with version constraint:
   ```json
   "providername": "namespace/providername@~> X.Y"
   ```

2. Add the provider to a stack in `sharded-stacks.json`:
   ```json
   "providers": ["archive", "aws", "newprovider"]
   ```

3. If the provider needs custom runners, add it to `providersWithCustomRunners.json` with an empty object: `"newprovider": {}`. Only add `nodeHeapSizeMb` if the provider has demonstrably OOMed on the default ceiling.

4. Validate and deploy:
   ```bash
   pnpm run build
   pnpm run synth
   cdktn deploy <stack-name>
   ```

5. The workflow will create two repos:
   - `cdktn-provider-<name>`: Main repo for all languages except Go
   - `cdktn-provider-<name>-go`: Separate repo for Go packages

### Provider Name Validation

The code enforces two rules:
1. **No `-go` suffix**: Provider names in `provider.json` cannot end with `-go` (conflicts with Go package repos)
2. **Name matching**: The key in `provider.json` must match the provider name from the Terraform registry (with hyphens removed)

Example:
```json
"googlebeta": "hashicorp/google-beta@~> 6.0"  // ✓ Key matches provider name (google-beta → googlebeta)
"google-beta": "hashicorp/google-beta@~> 6.0" // ✗ Key must have hyphens removed
```

## GitHub Workflows

### Critical Workflows

- **`deploy-cdktf-stacks.yml`**: Deploys infrastructure changes to GitHub
  - Triggered by other workflows
  - Runs `cdktn deploy` for specified stacks
  - Can trigger repository upgrades after deployment

- **`upgrade-repositories.yml`**: Upgrades all provider repositories
  - Builds matrix from `provider.json`
  - Checks out both this repo and each provider repo
  - Creates `.projenrc.js` from template
  - Runs `pnpm add -D @cdktn/provider-project@latest` and `npx projen`
  - Provider repos use **pnpm**; this repo's own build has also migrated to pnpm.
  - Note `pnpm run fetch`, never `pnpm fetch` — the latter is a pnpm builtin that
    fetches from the lockfile, exits 0, and regenerates nothing.
  - Detects breaking changes
  - Creates PRs with appropriate labels

- **`upgrade-cdktf.yml`**, **`upgrade-dependencies.yml`**, etc.: Automated dependency updates

### Automation Scripts

Located in `.github/lib/`:

- **`create-projen-files.js`**: Generates `.projenrc.js` for provider repos using the template
  - Replaces `__PROVIDER__` with version from `provider.json`
  - Replaces `__CUSTOM_RUNNER__` with a boolean derived from `providersWithCustomRunners.json` (provider present = true)
  - Replaces `__NODE_HEAP_MB__` with that provider's `nodeHeapSizeMb`, or `undefined` to take the runner-class default

- **`collect-changes.js`**: Detects breaking vs non-breaking changes in provider updates
- **`create-pr.js`**: Creates pull requests for provider upgrades
- **`copy-codeowners-file.js`**: Maintains CODEOWNERS files across repos

## Important Configuration Details

### Secrets Required

The following secrets must be configured in GitHub Actions:

- `TF_CLOUD_TOKEN`: Terraform Cloud token (commented out, TODO: set up remote backend)
- `GH_COMMENT_TOKEN`: GitHub token for creating PRs
- `FAILURE_SLACK_WEBHOOK_URL`: Slack webhook for failure notifications
- `slack-webhook`: Terraform variable for repository webhook configuration

Per-repository secrets (managed by code):
- `GH_TOKEN`, `PROJEN_GITHUB_TOKEN`, `GO_GITHUB_TOKEN`
- `NPM_TOKEN`
- `TWINE_USERNAME`, `TWINE_PASSWORD`
- `ALERT_PRS_SLACK_WEBHOOK_URL`

### CDKTN Configuration

- **CDKTN version**: 0.21.0 (pinned in package.json and template)
- **Terraform version**: 1.13.3 (specified in package.json)
- **Node version**: 24+ (see engines in package.json)
- **TypeScript/JSII version**: ~5.8.0 (must match major/minor)

### Repository Settings

All provider repositories are configured with:
- Public visibility
- Auto-merge enabled
- Delete branch on merge enabled
- Squash merge with PR title and body
- Branch protection requiring 1 approval
- Required status checks: build, package-js, package-python, package-go
- Team `team-cdk-terrain` has admin access

## Migration Notes

When working with this codebase, remember:

1. **CDKTF → CDKTN naming**: Comments and TODOs reference the old "cdktf" name
2. **Projen migration complete**: Provider repos use `@cdktn/provider-project`, not `@cdktf/provider-project`
3. **Java/C# on hold**: NuGet and Maven publishing is commented out throughout the code
4. **Remote backend TODO**: S3 or Terraform Cloud backend not yet configured
