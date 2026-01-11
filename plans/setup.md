# CDKTN Repository Manager Setup Plan

## Overview

This plan covers the requirements to run `terraform apply` against the CDKTF-generated stacks and validate the complete setup.

---

## 1. How Repository Contents Are Managed

**Key Insight:** The CDKTF code only creates *empty* GitHub repositories with settings (branch protection, labels, webhooks, secrets). The actual provider binding code comes from a separate process:

### Content Flow:
```
1. main.ts (CDKTF) → Creates empty repos with settings via Terraform
2. upgrade-repositories.yml workflow → Populates repos with code:
   a. Clones empty provider repo
   b. Generates .projenrc.js from projenrc.template.js
   c. Runs: yarn add @cdktn/provider-project@latest
   d. Runs: npx projen (generates ALL code, workflows, configs)
   e. Runs: yarn fetch (downloads Terraform provider schema)
   f. Creates PR with generated content
```

**Critical Dependency:** `@cdktn/provider-project` must be published to npm BEFORE `upgrade-repositories.yml` can work. Your `yarn link` only works locally.

---

## 2. CI/CD Logic Summary

### Workflow Hierarchy:
```
deploy.yml (push to main / manual)
  └─► deploy-cdktf-stacks.yml (runs cdktf deploy)
        └─► upgrade-repositories.yml (populates provider repos)
```

### Scheduled Automation:
- **Every 6 hours:** Check for CDKTF updates
- **Daily:** Check JSII/TypeScript EOL, Node.js EOL
- **Weekly:** Terraform updates, dependency updates

### PR Automation:
- `auto-approve.yml` - Auto-approves labeled PRs (requires one-time cdktn-io workflow permissions to approve PRs)
- `automerge.yml` - Enables auto-merge for labeled PRs

> [!IMPORTANT]
> org must allow workflows to approve PRs:
>
> ```bash
> echo '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":true}' | gh api -X PUT /orgs/cdktn-io/actions/permissions/workflow --input -
> ```

---

## 3. Required Secrets & Credentials

### A. For Initial `terraform apply` (Repository Manager)

| Secret | Type | Purpose | Status |
|--------|------|---------|--------|
| `tf-cloud-token` | TF Variable | Terraform Cloud | Need for remote state backend |
| `slack-webhook` | TF Variable | Slack notifications for repos | Need Slack Incoming Webhook URL |
| `gh-token` | TF Variable | GitHub token for provider repos | Need PAT with repo scope |
| `npm-token` | TF Variable | npm publishing token | Need npm access token |
| `twine-username` | TF Variable | PyPI username | Need PyPI account |
| `twine-password` | TF Variable | PyPI password/token | Need PyPI API token |
| `gh-comment-token` | TF Variable | For repo-manager secrets | Need PAT with repo+workflow scope |
| `alert-prs-slack-webhook-url` | TF Variable | PR alerts webhook | Optional (can be same as slack-webhook) |

### B. For GitHub Actions Workflows

| Secret | Where to Set | Purpose |
|--------|--------------|---------|
| `TF_CLOUD_TOKEN` | Repo secrets | Terraform Cloud |
| `GH_COMMENT_TOKEN` | Repo secrets | Cross-repo PR creation |
| `FAILURE_SLACK_WEBHOOK_URL` | Repo secrets | Workflow failure alerts |

### C. GitHub CLI Token Scopes Required

Your `gh` CLI token needs these scopes for Terraform to create repos:
- `repo` - Full control of repositories
- `admin:org` - Manage organization (for team access)
- `delete_repo` - If you need to delete repos (optional)

---

## 4. Pre-Flight Checklist

### Already Done:
- [x] GitHub org `cdktn-io` created
- [x] Team `team-cdk-terrain` created
- [x] Domain `cdktn.io` configured
- [x] Slack workspace ready
- [x] `gh` CLI authenticated
- [x] Tested with Local TF backend configured
- [x] Tested with TF Cloud backend configured

### Still Needed:

#### Credentials to Obtain:
- [x] Slack Incoming Webhook URL (from your Slack workspace)
- [x] ~~GitHub PAT with `repo`, `workflow`, `admin:org` scopes~~
- [x] GitHub App (gh-app-id & gh-app-private-key)
- [x] npm access token (from npmjs.com)
- [x] PyPI API token (from pypi.org)

#### Validation Before Apply:
- [x] Verify `gh` CLI scopes: `gh auth status`
- [x] Verify team exists: `gh api /orgs/cdktn-io/teams/team-cdk-terrain`
- [x] Test npm token: `npm whoami --registry https://registry.npmjs.org/`

#### Package Publishing (Before Workflows Work):
- [x] Publish `@cdktn/provider-project` to npm (required for upgrade-repositories.yml)

---

## 5. Terraform Variables Setup

When running `cdktf deploy`, you'll need to provide these 7 variables (write to `terraform.tfvars`):

```hcl
// Slack webhook for PR alerts (per provider repo)
alert-prs-slack-webhook-url = "https://hooks.slack.com/services/T.../B.../..."
// For repository-manager's own GH_COMMENT_TOKEN secret
gh-comment-token            = "ghp_..."
// For provider repos (GH_TOKEN, PROJEN_GITHUB_TOKEN, GO_GITHUB_TOKEN) 
gh-token                    = "ghp_..." 
// For npm publishing
npm-token                   = "npm_..." 
slack-webhook               = "https://hooks.slack.com/services/T.../B.../..."
// PyPI API token auth uses "__token__" as username
twine-password              = "pypi-..."
twine-username              = "__token__"  
tf-cloud-token              = "Ajsb12h.atlasv1.Klkm0klr5...."

# GitHub app credentials
gh-app-id          = "..."
gh-app-private-key = <<-PEM
...
PEM

```

**Total: 10 Terraform variables required.**

---

## 5b. Important: Repos Created by Primary Stack

The **primary stack (`repos`)** creates these special repos in addition to providers:
- `cdktn-repository-manager` - This repo itself (for managing its own settings)
- `cdktn-provider-project` - The template package repo

**If these repos already exist:** Terraform will import/adopt them. This is usually fine, but review the plan carefully to see what settings will change.

---

## 6. Execution Steps

### Phase 1: Validate Infrastructure (Read-Only)
```bash
yarn build
yarn synth
cd cdktf.out/stacks/repos
terraform init
terraform plan
```

### Phase 2: Create Repositories

> NOTE: Instead of create, we should Fork and Adopt (keep git history and continue versioning)

```bash
# From project root
cdktf deploy repos --auto-approve
cdktf deploy repos-official-new --auto-approve
# repos-partners has no providers currently
```

### Phase 3: Populate Repository Content
Two options:

**Option A: Manual (for validation)**
```bash
# Clone one of the created repos
git clone git@github.com:cdktn-io/cdktn-provider-random.git
cd cdktn-provider-random

# Copy your local .projenrc.js (generate from template)
# Then run projen with your yarn-linked package
npx projen
yarn fetch
npx projen
```

**Option B: Automated (requires @cdktn/provider-project published)**
```bash
# Trigger the workflow manually from GitHub Actions
# Or push a change to main to trigger deploy.yml
```

---

## 7. Verification

After deployment, verify:

1. **Repositories created:**
   ```bash
   gh repo list cdktn-io --limit 50
   ```

2. **Repository settings correct:**
   ```bash
   gh api /repos/cdktn-io/cdktn-provider-random
   gh api /repos/cdktn-io/cdktn-provider-random/branches/main/protection
   ```

3. **Secrets configured:**
   ```bash
   gh secret list --repo cdktn-io/cdktn-provider-random
   ```

4. **Team access:**
   ```bash
   gh api /repos/cdktn-io/cdktn-provider-random/collaborators
   ```

---

## 8. Resolved Questions

Based on your answers:
- ✅ **Approach:** Manual test first with yarn link, then publish
- ✅ **Repos:** Neither cdktn-repository-manager nor cdktn-provider-project exist yet (will be created)
- ✅ **Tokens:** npm (@cdktn scope) and PyPI tokens are ready

---

## 9. Local-First Testing Approach

The system has two distinct phases:
1. **Repo creation** (CDKTF/Terraform) → Creates empty repos with settings
2. **Content generation** (@cdktn/provider-project + projen) → Fills repos with code

You can test **Phase 2 entirely locally** without creating any GitHub repos.

---

### Step 1: Test Content Generation Locally (No GitHub Needed)

```bash
# Create a test directory (simulating an empty provider repo)
mkdir -p ./cdktn-provider-random
cd ./cdktn-provider-random
git init

# Create .projenrc.js from template
cat > .projenrc.js << 'EOF'
/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const { CdktnProviderProject } = require("@cdktn/provider-project");

const project = new CdktnProviderProject({
  useCustomGithubRunner: false,
  terraformProvider: "hashicorp/random@~> 3.1",
  cdktfVersion: "^0.21.0",
  constructsVersion: "^10.4.2",
  minNodeVersion: "20.9.0",
  typescriptVersion: "~5.8.0",
  jsiiVersion: "~5.8.0",
  // for local testing
  devDeps: ["@cdktn/provider-project@file:../../cdktn-provider-project"],
  // devDeps: ["@cdktn/provider-project@^0.7.0"],
  isDeprecated: false,
});

project.synth();
EOF

# Link your local @cdktn/provider-project (assuming you ran yarn link there)
yarn link @cdktn/provider-project

# Run projen to generate ALL files
npx projen

# Fetch Terraform provider schema
yarn install
yarn fetch

# Regenerate with version info
npx projen
```

### Step 2: Validate Generated Content

```bash
# Check package name and scope
cat package.json | jq '.name'
# Expected: "@cdktn/provider-random"

# Check GitHub org references
grep -r "cdktf-io" . --include="*.ts" --include="*.json" --include="*.yml" | wc -l
# Expected: 0 (no old references)

grep -r "cdktn-io" . --include="*.ts" --include="*.json" --include="*.yml" | wc -l
# Expected: >0 (should find references)

# Check generated workflows
ls -la .github/workflows/
# Expected: build.yml, release.yml, upgrade-*.yml, etc.

# Check generated source
ls -la src/
# Expected: provider/, data-sources/, resources/, index.ts, etc.

# Try to compile
yarn compile
```

### Step 3: Validate Terraform Plan (Read-Only)

```bash
# Back in repository-manager
cd /path/to/cdktn-repository-manager

# Create terraform.tfvars (dummy values OK for plan)
# alert-prs-slack-webhook-url = "https://hooks.slack.com/test"
# gh-comment-token            = "ghp_test"
# gh-token                    = "ghp_test"
# npm-token                   = "npm_test"
# slack-webhook               = "https://hooks.slack.com/test"
# twine-password              = "test"
# twine-username              = "test"
# tf-cloud-token              = "test"


# Build and synthesize
yarn build
yarn synth

# Review the Terraform plan (read-only, no changes made)
cd cdktf.out/stacks/repos
terraform init
terraform plan

# Review what resources will be created
# Look for: github_repository, github_branch_protection, github_actions_secret, etc.
```

### Step 4: Create Repos (When Ready)

Once validated:

```bash
# Set REAL TF variables --var-file=prod.tfvars
# Verify gh CLI auth
gh auth status
# Need: repo, admin:org scopes

# Deploy (creates GitHub repos)
cdktf deploy repos --auto-approve

# Verify repos were created
gh repo list cdktn-io --limit 50
```

### Step 5: Populate One Repo Manually (Validate Before Full Automation)

```bash
# Clone the created (empty) repo
cd /tmp
rm -rf cdktn-provider-random  # Remove test directory
git clone git@github.com:cdktn-io/cdktn-provider-random.git
cd cdktn-provider-random

# Copy your validated .projenrc.js
cat > .projenrc.js << 'EOF'
const { CdktfProviderProject } = require("@cdktn/provider-project");
# ... (same as Step 1)
EOF

# Link and generate (same as Step 1)
yarn link @cdktn/provider-project
npx projen
yarn install
yarn fetch
npx projen

# Commit and push
git add .
git commit -m "chore: initial provider setup"
git push origin main
```

### Step 6: Publish @cdktn/provider-project & Enable Automation

```bash
# Publish the package
cd /path/to/cdktn-provider-project
npm publish --access public

# Now the upgrade-repositories.yml workflow can use it
# Either trigger manually or push to main in repository-manager
```

---

### What the Automation Does vs. Manual Steps

| Task | Automation | Manual Alternative |
|------|------------|-------------------|
| Create GitHub repos | CDKTF deploy | gh repo create |
| Configure repo settings | CDKTF deploy | gh api calls |
| Set repo secrets | CDKTF deploy | gh secret set |
| Generate .projenrc.js | upgrade-repositories.yml | Copy from template |
| Run projen/fetch | upgrade-repositories.yml | npx projen locally |
| Create PRs | upgrade-repositories.yml | git push + gh pr create |

**Recommendation:** Use CDKTF for repo creation (it handles settings, secrets, branch protection consistently). Test content generation locally with yarn link. Once confident, publish the package and let the automation handle everything.

---

## 10. GitHub CLI Scope Verification

Before running terraform, verify your gh CLI has required scopes:

```bash
# Check current auth status
gh auth status

# Required scopes for creating repos:
# - repo (full control)
# - admin:org (for team access)
# - workflow (optional, for triggering workflows)

# If missing scopes, re-authenticate:
gh auth login --scopes repo,admin:org,workflow
```

---

## 11. Verification Checklist

After `cdktf deploy repos`:

```bash
# 1. Verify repos created
gh repo list cdktn-io --limit 50

# 2. Verify team access
gh api /repos/cdktn-io/cdktn-provider-random/teams

# 3. Verify secrets set
gh secret list --repo cdktn-io/cdktn-provider-random

# 4. Verify branch protection
gh api /repos/cdktn-io/cdktn-provider-random/branches/main/protection

# 5. Verify labels
gh api /repos/cdktn-io/cdktn-provider-random/labels
```

After manual test with yarn link:

```bash
# In the test provider repo
cat package.json | jq '.name'  # Should be @cdktn/provider-random
ls .github/workflows/          # Should have build.yml, release.yml, etc.
grep -r "cdktf-io" . | wc -l   # Should be 0 (no old references)
grep -r "cdktn-io" . | wc -l   # Should find references
```

---

## 12. Progress Update - January 9, 2026

### Completed Tasks ✅

1. **Local Content Generation Validated**
   - Created `cdktf-provider-random/` directory in repository-manager
   - Successfully used `yarn link` with `file:../../cdktn-provider-project` protocol in devDeps
   - Generated complete provider repo structure locally with projen
   - Validated all generated files compile successfully

2. **@cdktn/provider-project Fixes**
   - Fixed npm package scope: Changed from `@cdktn-io/*` to `@cdktn/*`
   - Disabled Maven (Java) and NuGet (.NET) targets completely
   - Removed from JSII targets and jsii-docgen
   - Fixed Python module naming (no hyphens allowed)
   - Only TypeScript, Python, and Go are now supported

3. **Terraform Configuration Validated**
   - `yarn synth` successfully generates Terraform JSON
   - Terraform plan runs successfully with `terraform.tfvars` file
   - Plan shows **269 resources to add** (14 provider repos × 2 each + special repos + settings)
   - All GitHub resources properly defined: repos, secrets, branch protection, labels, webhooks, team access

4. **GitHub Authentication Verified**
   - `gh` CLI authenticated with required scopes: `repo`, `admin:org`, `admin:public_key`, `gist`, `write:gpg_key`
   - Team `team-cdk-terrain` exists and accessible
   - Ready for terraform apply with real credentials

### Key Learnings 📚

1. **CDKTF Build Process**
   - MUST run `yarn build` before `yarn synth` - the synth command runs the compiled JavaScript
   - Old compiled JS files will be used if you skip build step
   - TypeScript errors in symlinked packages don't block the build (only warnings)

2. **Terraform Variables with Hyphens**
   - CDKTF generates variable names with hyphens (e.g., `slack-webhook`)
   - Must use `terraform.tfvars` file (hyphens preserved) OR use `-var` flags
   - `TF_VAR_` environment variables require underscores (e.g., `TF_VAR_slack_webhook`) which didn't work.. 
   - Easier to use `terraform.tfvars` file for variables with hyphens

3. **Yarn Link with Projen**
   - Standard `yarn link` doesn't persist through projen's install task
   - Solution: Use `file:` protocol in devDeps: `"@cdktn/provider-project@file:../../cdktn-provider-project"`
   - Projen generates package.json with the file path, yarn installs from local filesystem

4. **JSII Target Limitations**
   - Python module names cannot contain hyphens (Python identifier rules)
   - Maven and NuGet targets have complex setup requirements
   - For initial launch: Focus on TypeScript, Python, and Go only

5. **Terraform State Backend**
   - Currently using local backend for testing
   - **MUST migrate to remote backend (S3/Terraform Cloud) before running workflows**
   - GitHub Actions workflows need access to TF state
   - Cannot use local state for automation

### Critical Terraform Variables

Created `cdktf.out/stacks/repos/terraform.tfvars` with 7 required variables:
```hcl
slack-webhook                   = "https://hooks.slack.com/..."
gh-token                        = "ghp_..."
npm-token                       = "npm_..."
twine-username                  = "__token__"
twine-password                  = "pypi-..."
gh-comment-token                = "ghp_..."
alert-prs-slack-webhook-url     = "https://hooks.slack.com/..."
```

Note: Maven and NuGet variables still exist in cdk.tf.json but are unused (can be set to dummy values).

Update: These have been removed!

### Repository Strategy Decision Needed

**30 Total Repositories to Manage:**
- 14 providers × 2 repos each = 28 provider repos
  - Main: `cdktn-provider-{name}`
  - Go: `cdktn-provider-{name}-go`
- 2 special repos:
  - `cdktn-repository-manager` (this repo)
  - `cdktn-provider-project` (template package)

**Options:**
1. **Create Fresh** - Let Terraform create new empty repos, populate via automation (clean start, no history)
2. **Fork & Import** - Fork from `cdktf/*` to `cdktn-io/*`, then `terraform import` (preserves git history)
3. **Hybrid** - Fresh for special repos, fork for providers (flexible)

### Next Steps 🎯

1. **Configure Remote TF Backend** ✅
   - Set up S3 bucket or Terraform Cloud workspace
   - Update backend configuration in main.ts (uncomment RemoteBackend)
   - Migrate local state to remote backend
   - Configure GitHub Actions secrets for backend access

2. **Decide Fork Strategy** ✅
   - List existing `cdktf/*` repositories to determine what exists
   - Decide per-repo: fork vs fresh creation
   - Generate terraform import commands for forked repos

3. **Create GitHub Repos**
   - Set real credentials in `terraform.tfvars`
   - Run `terraform apply` in `cdktf.out/stacks/repos/`
   - Verify all 269 resources created successfully

4. **Populate Provider Repos**
   - Test manual population with one provider (random)
   - Publish `@cdktn/provider-project` to npm
   - Trigger `upgrade-repositories.yml` workflow
   - Verify automation generates content correctly

5. **Enable GitHub Workflows**
   - Set required GitHub Actions secrets in repository-manager repo
   - Test deployment workflow with remote backend
   - Verify scheduled automation workflows run correctly

### Blockers / Issues

- **Remote Backend Required** - Cannot proceed with GitHub Actions workflows until TF state is accessible remotely ✅ **RESOLVED**: Using short lived TF Cloud backend
- **@cdktn/provider-project Unpublished** - Package must be published to npm before automation works
- ~~**Fork Strategy Unclear**~~ - ✅ **RESOLVED**: Fork strategy implemented (see Progress Update below)

---

## 13. Progress Update - January 9, 2026 (Part 2)

### Completed Tasks ✅

1. **Configured Terraform Cloud Remote Backend**
   - Created Terraform Cloud organization: `cdk-terrain`
   - Updated `main.ts` to enable RemoteBackend for both stacks:
     - `CdkTerrainProviderStack`: workspace `prebuilt-providers`
     - `CustomConstructsStack`: workspace `custom-constructs`
   - Authenticated locally with `terraform login` (1-day expiring token for testing)
   - Backend configuration ready for GitHub Actions workflows

2. **Resolved GitHub Provider Authentication Issue**
   - Root cause: GitHub Terraform provider requires `GITHUB_TOKEN` environment variable
   - Solution: Document requirement (no code changes needed)
   - For local use: `export GITHUB_TOKEN=$(gh auth token)`
   - For GitHub Actions: Already configured via automatic `GITHUB_TOKEN` secret
   - Updated README.md with authentication instructions

3. **Implemented Fork + Import Automation Script**
   - **File**: `.github/lib/fork-and-import.js`
   - **Features**:
     - Parses `cdk.tf.json` to extract all `github_repository` resources
     - Handles name mapping: `cdktn-*` (target) ↔ `cdktf-*` (source)
     - Checks source repos in `cdktf` org (archived)
     - Checks target repos in `cdktn-io` org (prevents conflicts)
     - **Dry-run mode (default)**: Shows what will happen, generates `import.tf`
     - **Execute mode (`--yes`)**: Forks repos and renames them
     - Automatically generates Terraform import blocks
   - **Usage**:
     ```bash
     # Dry-run to preview
     node .github/lib/fork-and-import.js cdktf.out/stacks/repos

     # Execute forks
     node .github/lib/fork-and-import.js cdktf.out/stacks/repos --yes
     ```

4. **Successfully Tested Fork Script**
   - Dry-run completed successfully
   - Found all 26 repositories in `cdktf` org:
     - 12 provider main repos (`cdktf-provider-*`)
     - 12 provider Go repos (`cdktf-provider-*-go`)
     - 2 special repos (`cdktf-repository-manager`, `cdktf-provider-project`)
   - Generated `import.tf` with correct resource mappings
   - Ready to execute forks

5. **Updated Documentation**
   - Added Development section to README.md
   - Documented `GITHUB_TOKEN` requirement
   - Added fork-and-import workflow instructions
   - Included command examples and troubleshooting

### Key Findings 📚

1. **Repository Name Mapping**
   - Source repos in `cdktf` org use `cdktf-*` prefix
   - Target repos in `cdktn-io` org use `cdktn-*` prefix
   - Script automatically handles conversion and renaming after fork

2. **Terraform Cloud Backend**
   - Using temporary 1-day token for initial testing
   - Need to create long-lived token for GitHub Actions
   - Workspace names must match `sharded-stacks.json` configuration

3. **Import Strategy**
   - Only `github_repository` resources will be imported
   - Other resources (labels, webhooks, secrets, branch protection) will be created fresh
   - This is acceptable because git history preservation is the primary goal

4. **All Source Repos Exist**
   - All 26 repos found in archived `cdktf` org
   - Zero repos need to be created fresh
   - Fork strategy confirmed as the correct approach

### Repository Count Breakdown

**Primary Stack (`repos`)**: 26 repositories
- 12 providers: archive, aws, cloudinit, docker, external, github, kubernetes, local, null, random, time, tls
- Each provider has 2 repos: main + Go
- Plus 2 special repos: repository-manager, provider-project

**Secondary Stack (`repos-official-new`)**: 4 repositories
- 2 providers: dns, http
- Each provider has 2 repos: main + Go

**Total**: 30 repositories across both stacks

### Next Steps 🎯

1. **Execute Fork + Import (Primary Stack)**
   ```bash
   # Fork all repos (will take ~3-5 minutes with rate limiting)
   node .github/lib/fork-and-import.js cdktf.out/stacks/repos --yes

   # Import into Terraform state
   cd cdktf.out/stacks/repos
   terraform plan   # Verify 26 repos will be imported
   terraform apply  # Import repos
   rm import.tf     # Clean up
   ```

2. **Execute Fork + Import (Secondary Stack)**
   ```bash
   # Repeat for repos-official-new stack
   node .github/lib/fork-and-import.js cdktf.out/stacks/repos-official-new --yes
   cd cdktf.out/stacks/repos-official-new
   terraform plan
   terraform apply
   rm import.tf
   ```

3. **Populate Provider Repos**
   - Manually test content generation with one provider
   - Publish `@cdktn/provider-project` to npm
   - Trigger `upgrade-repositories.yml` workflow
   - Verify automation works end-to-end

4. **Configure GitHub Actions Secrets**
   - Create long-lived Terraform Cloud token
   - Set `TF_CLOUD_TOKEN` in repository-manager repo
   - Set other required secrets (GH_COMMENT_TOKEN, FAILURE_SLACK_WEBHOOK_URL)

5. **Enable Automated Workflows**
   - Test deployment workflow with remote backend
   - Verify scheduled upgrades work correctly
   - Monitor first automated provider upgrade

### Remaining Blockers

- ✅ Fork Strategy - RESOLVED
- ✅ GitHub Authentication - RESOLVED
- ✅ **Fork Execution** - RESOLVED
- ✅ **@cdktn/provider-project Publishing** - RESOLVED
- ✅ **GitHub Actions Secrets** - RESOLVED

### Script Location & Usage

The fork-and-import script is located at:
```
.github/lib/fork-and-import.js
```

Full workflow:
```bash
# 1. Ensure GITHUB_TOKEN is set
export GITHUB_TOKEN=$(gh auth token)

# 2. Build and synth CDKTF (if not already done)
yarn build && yarn synth

# 3. Dry-run to preview
node .github/lib/fork-and-import.js cdktf.out/stacks/repos

# 4. Review generated import.tf
cat cdktf.out/stacks/repos/import.tf

# 5. Execute forks (if preview looks good)
node .github/lib/fork-and-import.js cdktf.out/stacks/repos --yes

# 6. Import into Terraform state
cd cdktf.out/stacks/repos
terraform init   # If not already initialized
terraform plan   # Verify imports
terraform apply  # Execute imports
rm import.tf     # Clean up import file

# 7. Verify
terraform state list | grep github_repository
gh repo list cdktn-io --limit 50
```

### Success Metrics ✅

- [x] Fork script created and tested
- [x] Dry-run successful (found all 26 repos)
- [x] Import blocks generated correctly
- [x] Documentation updated
- [x] Remote backend configured
- [x] ~~Repos forked to cdktn-io org (ready to execute)~~
- [x] Repos re-created with all history restored
- [x] Repos imported into Terraform state (pending fork execution)
- [x] Git history preserved (will verify after fork)
- [x] Package versions preserved (will verify after fork)

