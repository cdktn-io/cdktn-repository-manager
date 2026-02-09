# Provider Update Flows

How provider repositories get updated, built, and released.

---

## 1. Orchestrated Updates (from repository-manager)

### Push to main -> Deploy -> Upgrade All Providers

```
push to main (or manual dispatch)
  |
  v
deploy.yml
  |-- builds shard matrix from sharded-stacks.json
  |-- calls deploy-cdktf-stacks.yml (terraform apply per stack)
  '-- on success, calls upgrade-repositories.yml
        |
        v  (for each provider in provider.json, max 5 parallel)
      - checks out repository-manager + provider repo
      - generates .projenrc.js from projenrc.template.js
      - runs: yarn add --dev @cdktn/provider-project@latest
              npx projen              (regenerate project files)
              yarn install --check-files
              yarn fetch              (regenerate bindings from provider schema)
              npx projen              (re-run: README needs src/version.json from fetch)
      - .github/lib/collect-changes.js detects breaking vs non-breaking:
          isBreaking = major increased, or (0.x dev version && minor increased)
          checks: terraformProvider, cdktfVersion, constructsVersion, minNodeVersion, jsiiVersion
          if breaking: commit prefix is feat!: or chore(deps)!:
          if non-breaking: commit prefix is fix: or chore(deps):
      - creates PR (labeled: auto-approve, automerge)
```

### Scheduled Dependency Upgrades (repository-manager level)

| Workflow | Schedule | What it does |
|----------|----------|-------------|
| `upgrade-cdktf.yml` | Every 6h, weekdays | Checks for new cdktf version, updates template + repo |
| `upgrade-node.yml` | Daily, weekdays | Bumps Node version if current approaches EOL |
| `upgrade-jsii-typescript.yml` | Daily, weekdays | Bumps jsii/TypeScript if current approaches EOS |
| `upgrade-terraform.yml` | Thursdays | Updates Terraform CLI version |
| `upgrade-dependencies.yml` | Sundays | Runs `yarn upgrade` on repository-manager itself |

### Manual Triggers (repository-manager)

| Workflow | Purpose |
|----------|---------|
| `upgrade-main-providers.yml` | Triggers `upgrade-main.yml` inside each provider repo (sequential) |
| `migrate-provider.yml` | One-time migration from @cdktf to @cdktn scope |
| `deprecate-provider.yml` | Marks provider deprecated, archives repo |

---

## 2. Per-Provider Workflows (inside each provider repo)

### Provider Version Upgrade (daily)

```
provider-upgrade.yml (cron: daily at 03:13 UTC)
  |
  |-- yarn check-if-new-provider-version
  |     '-- scripts/check-for-upgrades.js
  |         checks Terraform registry for newer version within major pin (~> X.0)
  |
  |-- if new version found:
  |     yarn fetch  (regenerates bindings from Terraform provider schema)
  |     copywrite headers
  |
  |-- compares minor version component of old vs new provider version:
  |     minor changed → feat: (triggers minor semver bump)
  |     patch only    → fix:  (triggers patch semver bump)
  |     (never produces feat!: — major bumps only come from upgrade-repositories.yml)
  '-- creates PR (labeled: auto-approve, automerge)
```

### Dependency Upgrade (weekly)

```
upgrade-main.yml (cron: Mondays at 01:13 UTC, or triggered by repository-manager)
  |
  |-- npx projen upgrade (upgrades all dependencies)
  '-- creates PR if changes detected (labeled: automerge, auto-approve, dependencies)
```

### Build (on every PR)

```
build.yml (trigger: pull_request, workflow_dispatch)
  |
  |-- npx projen build
  |-- self-mutation check:
  |     if generated files differ → uploads patch, fails build
  |     self-mutation job auto-pushes fixup commit to PR branch
  '-- parallel packaging jobs (only if no self-mutation):
      |-- package-js   (jsii-pacmak for TypeScript)
      |-- package-python (jsii-pacmak for Python)
      '-- package-go   (jsii-pacmak for Go)
```

### Release (on merge to main)

```
release.yml (trigger: push to main, workflow_dispatch)
  |
  |-- npx projen release (semantic versioning from commit messages)
  |-- scripts/should-release.js (additional gate check)
  |-- checks if version tag already exists (skip if so)
  '-- parallel publish jobs:
      |-- npm        (@cdktn/provider-X)
      |-- PyPI       (cdktn-provider-X)
      |-- Go         (push to cdktn-provider-X-go repo)
      '-- GitHub Releases (tag + release notes)
  |
  '-- deprecation job: marks old versions deprecated on npm if isDeprecated=true
```

### Force Release (manual)

```
force-release.yml (trigger: workflow_dispatch)
  |
  inputs: sha, publish_to_npm, publish_to_pypi, publish_to_go,
          publish_to_maven, publish_to_nuget (legacy, dormant)
  |
  '-- same publish jobs as release.yml but for a specific commit
      (uses npx projen unconditional-release instead of npx projen release)
```

---

## 3. PR Automation (both repos)

| Workflow | Trigger | Action |
|----------|---------|--------|
| `auto-approve.yml` | PR labeled `auto-approve` | Approves PR via GH App token |
| `automerge.yml` | PR labeled `automerge` | Enables squash auto-merge |
| `pull-request-lint.yml` | PR opened/edited | Validates conventional commit title |
| `alert-open-prs.yml` | Weekdays (provider repos) | Slack alert for PRs open >2 hours |

---

## 4. End-to-End Flow: New Terraform Provider Version

```
                    Terraform Registry
                          |
                    (new version published)
                          |
                          v
              provider-upgrade.yml (daily cron)
                    detects new version
                          |
                          v
                    creates PR on provider repo
                    (feat: or fix: commit)
                          |
             +------------+------------+
             |                         |
       auto-approve.yml          build.yml
       (approves PR)          (builds + packages)
             |                         |
             +------------+------------+
                          |
                    automerge.yml
                    (squash merges)
                          |
                          v
                    release.yml (push to main)
                    semantic version bump
                          |
              +-----------+-----------+
              |           |           |
           npm         PyPI         Go
     @cdktn/provider  cdktn-provider  cdktn-provider-go
```

## 5. End-to-End Flow: Template/Toolchain Change

```
              repository-manager (push to main)
                          |
                          v
                    deploy.yml
                    terraform apply (GitHub repos/secrets)
                          |
                          v
              upgrade-repositories.yml
              (yarn add @cdktn/provider-project@latest + npx projen + yarn fetch + npx projen)
                          |
                    for each provider:
                          |
                    collect-changes.js detects breaking vs non-breaking
                    (feat!: / chore(deps)!: if breaking, fix: / chore(deps): otherwise)
                          |
                          v
                    creates PR with updated
                    workflows + package.json
                          |
             +------------+------------+
             |                         |
       auto-approve.yml          build.yml
             |                         |
             +------------+------------+
                          |
                    automerge.yml -> release.yml
                          |
                    new version published
```
