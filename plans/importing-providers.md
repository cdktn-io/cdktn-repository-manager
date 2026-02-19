# Importing a Provider into CDKTN

This document describes the end-to-end process for importing an archived CDKTF provider repository into the `cdktn-io` GitHub org and bringing it under CDKTN management.

## Overview

Importing a provider involves two phases:

1. **Repository import** — copying the archived `cdktf/cdktf-provider-<name>` repository into `cdktn-io` via GitHub's import tool, then running Terraform to take ownership of it (branch protection, secrets, team permissions, etc.)
2. **Provider migration** — updating the provider repository's toolchain from `@cdktf/provider-project` to `@cdktn/provider-project` and publishing under the `@cdktn` npm scope

Both phases are automated via GitHub Actions workflows and gated behind a PR review + `/migrate` command. After `/migrate` succeeds the import PR auto-merges, which triggers `upgrade-repositories` to handle the provider migration automatically.

---

## Prerequisites

Before starting, confirm:

- [ ] The provider exists in `original-providers.json` (inherited from the archived CDKTF list)
- [ ] The provider is **not** already in `provider.json` (not yet imported)
- [ ] A maintainer with write access to `cdktn-io` will perform the review

---

## Step 1 — Import the GitHub repositories

GitHub's import tool creates copies of the archived source repos in `cdktn-io`.

For each provider `<name>`, import **two** repositories:

| Source (archived) | Target |
|---|---|
| `https://github.com/cdktf/cdktf-provider-<name>` | `cdktn-io/cdktn-provider-<name>` (Public) |
| `https://github.com/cdktf/cdktf-provider-<name>-go` | `cdktn-io/cdktn-provider-<name>-go` (Public) |

Go to [github.com/new/import](https://github.com/new/import) for each.

---

## Step 2 — Trigger the import workflow

Once both repos exist in `cdktn-io`, trigger the `import-provider` workflow from the Actions tab (or via `gh`):

```sh
gh workflow run import-provider.yml \
  --repo cdktn-io/cdktn-repository-manager \
  -f provider=<name>
```

This workflow will:

1. Validate the provider exists in `original-providers.json` and is not already in `provider.json`
2. Verify both `cdktn-provider-<name>` and `cdktn-provider-<name>-go` exist in `cdktn-io`
3. Fix CODEOWNERS and workflow team references on `main` of each repo (`adopt-repo.js`)
4. Create a branch `import/<name>` in this repository with:
   - `provider.json` — adds `<name>` with its version constraint
   - `sharded-stacks.json` — places `<name>` in the correct stack shard
   - `pending-imports.json` — marks `<name>` for Terraform import
5. Open a pull request from `import/<name>` → `main`

---

## Step 3 — Review the Terraform plan

CI automatically runs a Terraform plan (`diff.yml`) on the PR and posts the output as a comment.

**Review checklist:**

- [ ] Plan shows `import` blocks for `cdktn-provider-<name>` and `cdktn-provider-<name>-go`
- [ ] Expected resource configuration (branch protection, labels, secrets, team permissions)
- [ ] No unexpected deletions or modifications to unrelated resources

---

## Step 4 — Approve and trigger `/migrate`

1. **Approve** the PR
2. **Comment `/migrate`** on the PR

The `/migrate` comment triggers `import-apply.yml`, which:

1. Validates the PR is approved and the commenter has write access
2. Runs `terraform apply` on the relevant stack shard — importing both repos into Terraform state and applying all configuration (branch protection, secrets, team permissions, labels, webhooks)
3. Removes `<name>` from `pending-imports.json` and commits to the branch
4. Posts a success comment on the PR with instructions to merge

**Merge this PR** once the success comment appears.

---

## Step 5 — Migration (automatic, triggered by import PR merge)

When the import PR merges to `main`, `deploy.yml` runs:

1. **Terraform deploy** — applies all stack shards (idempotent; the newly imported provider is already in state)
2. **`upgrade-repositories.yml`** — runs for all providers including the newly imported one:
   - Creates a fresh `.projenrc.js` from `projenrc.template.js` (already uses `@cdktn/provider-project`)
   - Upgrades to `@cdktn/provider-project@latest`
   - Regenerates all files with `npx projen` + `yarn fetch`
   - Opens a migration PR on `cdktn-provider-<name>` with `automerge` + `auto-approve` labels
   - The migration PR auto-merges, triggering a release to npm/PyPI/Go

No manual action required after commenting `/migrate`.

---

## Sequence Diagram

```
Contributor          import-provider         import-apply          deploy + upgrade-repos   cdktn-provider-<name>
    |                       |                     |                      |                        |
    | github.com/new/import |                     |                      |                        |
    | (x2 repos)            |                     |                      |                        |
    |                       |                     |                      |                        |
    | gh workflow run       |                     |                      |                        |
    | import-provider.yml   |                     |                      |                        |
    |---------------------->|                     |                      |                        |
    |                       | validate + adopt    |                      |                        |
    |                       | create import/<name>|                      |                        |
    |                       | open PR #N          |                      |                        |
    |                       |-------------------->|                      |                        |
    |                       |                     |                      |                        |
    |     CI: TF plan runs, posts output as PR comment                   |                        |
    |<--------------------------------------------------------------------|                        |
    |                       |                     |                      |                        |
    | Reviewer approves     |                     |                      |                        |
    | Reviewer: /migrate    |                     |                      |                        |
    |-------------------> issue_comment --------->|                      |                        |
    |                       |                     | validate guards      |                        |
    |                       |                     | terraform apply      |                        |
    |                       |                     | update pending-imports                        |
    |                       |                     | post success comment |                        |
    |<--------------------------------------------------------------------|                        |
    |                       |                     |                      |                        |
    | Maintainer merges     |                     |                      |                        |
    | import PR             |                     |                      |                        |
    |                       |                     |                      |                        |
    |                       |                     |            deploy.yml triggers                |
    |                       |                     |            terraform apply (idempotent)        |
    |                       |                     |            upgrade-repositories.yml ---------->|
    |                       |                     |            (migration PR, automerge)           |
    |                       |                     |                      |<-----(merged)-----------|
    |                       |                     |                      | release triggered       |
```

---

## Troubleshooting

### TF plan not triggered on the import PR

If the Terraform plan CI check doesn't appear, push an empty commit to `import/<name>` to trigger a `synchronize` event:

```sh
git fetch origin import/<name>
git checkout import/<name>
git commit --allow-empty -m "chore: trigger CI plan"
git push origin import/<name>
```

### `/migrate` guard failures

| Error | Fix |
|---|---|
| `Branch does not match 'import/*'` | `/migrate` only works on PRs from `import/` branches |
| `PR must be approved` | Get at least one approval before commenting `/migrate` |
| `User does not have write access` | Only org members with write/admin access can trigger `/migrate` |

### Migration PR not created / upgrade-repositories didn't run

If `upgrade-repositories` didn't open a migration PR after the import PR merged (e.g. the deploy run was skipped or failed), trigger it manually:

```sh
gh workflow run upgrade-repositories.yml --repo cdktn-io/cdktn-repository-manager
```

Alternatively, use `migrate-provider.yml` as a manual fallback for a specific provider:

```sh
gh workflow run migrate-provider.yml \
  --repo cdktn-io/cdktn-repository-manager \
  -f provider=<name>
```

### Release not triggered after migration PR merges

If the provider repo's `release.yml` doesn't fire (no version bump detected), trigger it manually:

```sh
gh workflow run force-release.yml --repo cdktn-io/cdktn-provider-<name>
```
