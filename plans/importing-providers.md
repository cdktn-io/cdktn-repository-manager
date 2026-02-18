# Importing a Provider into CDKTN

This document describes the end-to-end process for importing an archived CDKTF provider repository into the `cdktn-io` GitHub org and bringing it under CDKTN management.

## Overview

Importing a provider involves two phases:

1. **Repository import** — copying the archived `cdktf/cdktf-provider-<name>` repository into `cdktn-io` via GitHub's import tool, then running Terraform to take ownership of it (branch protection, secrets, team permissions, etc.)
2. **Provider migration** — updating the provider repository's toolchain from `@cdktf/provider-project` to `@cdktn/provider-project` and publishing under the `@cdktn` npm scope

Both phases are automated via GitHub Actions workflows and gated behind a PR review + `/migrate` command.

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

> **Note for large providers (e.g. AWS):** GitHub's import tool may time out for repositories larger than ~2 GiB. See [plans/large-providers.md](large-providers.md) for the EC2-based workaround.

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
4. Dispatches `migrate-provider.yml` (passing the import PR number)
5. Posts a success comment on the PR confirming apply completed

---

## Step 5 — Migration PR (automatic)

`migrate-provider.yml` runs in the background and:

1. Checks out `cdktn-provider-<name>`
2. Modifies `.projenrc.js`:
   - `@cdktf/provider-project` → `@cdktn/provider-project`
   - `CdktfProviderProject` → `CdktnProviderProject`
   - `isDeprecated: true` → `isDeprecated: false`
   - `minNodeVersion` bumped to `20.16.0`
3. Upgrades to `@cdktn/provider-project@latest`
4. Regenerates all files with `npx projen`
5. Runs `yarn fetch` to pull the latest provider schema
6. Runs `yarn build` to verify compilation
7. Opens a PR on `cdktn-provider-<name>` from `auto/migrate-to-cdktn-scope` with `automerge` + `auto-approve` labels
8. Enables auto-merge on that PR
9. Posts a follow-up comment on the import PR with a direct link to the migration PR

---

## Step 6 — Merge and release

Once the migration PR auto-merges in `cdktn-provider-<name>`:

1. **Merge the import PR** in `cdktn-repository-manager`
2. **Check for an automatic release** — the provider repo's `release.yml` workflow should trigger and publish to npm/PyPI/Go. If it does not (e.g. no version bump was detected):
   - Trigger `force-release` manually on `cdktn-provider-<name>` from the Actions tab

---

## Sequence Diagram

```
Contributor          import-provider         import-apply          migrate-provider        cdktn-provider-<name>
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
    |                       |                     | dispatch ----------->|                        |
    |                       |                     | (provider, pr_number)|                        |
    |                       |                     | post success comment |                        |
    |<--------------------------------------------------------------------|                        |
    |                       |                     |                      | migrate .projenrc.js   |
    |                       |                     |                      | npx projen + build     |
    |                       |                     |                      | open migration PR ---->|
    |                       |                     |                      | post follow-up comment |
    |<--------------------------------------------------------------------|                        |
    |                       |                     |                      |                        |
    |                                        migration PR auto-merges    |<-----(merged)----------|
    |                       |                     |                      |                        |
    | Reviewer merges       |                     |                      |                        |
    | import PR #N          |                     |                      |                        |
    | (optional) force-release on cdktn-provider-<name>                 |                        |
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

### Migration PR build fails (node version)

If CI on the migration PR fails with `engine "node" is incompatible`, the `minNodeVersion` in `.projenrc.js` needs bumping to `20.16.0`. Check out `auto/migrate-to-cdktn-scope` in the provider repo, update the value, run `npx projen`, and push.

This is now fixed in `migrate-provider.yml` for future imports.

### Migration PR already exists

If `migrate-provider.yml` posts `no PR was created`, a branch `auto/migrate-to-cdktn-scope` likely already exists from a previous run. Either close the old PR/branch and re-trigger, or manually push fixes to the existing branch.
