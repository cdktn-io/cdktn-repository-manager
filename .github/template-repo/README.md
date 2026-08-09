# cdktn-provider-template

This repository is a [GitHub template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template). Every `cdktn-provider-<name>` repository in the `cdktn-io` organization is generated from it, so that it is born carrying the workflows its first pull request needs in order to merge unattended.

**Do not open pull requests here, and do not edit files on `main` directly.** GitHub Actions are disabled on this repository, so nothing would run on a pull request, and the next sync would silently overwrite any hand edit.

## Contents

- `.github/workflows/pull-request-lint.yml` — provides the required `Validate PR title` status check
- `.github/workflows/auto-approve.yml` — supplies the required approving review on bot-authored pull requests
- `.github/workflows/automerge.yml` — merges a pull request once its checks and review are satisfied
- `README.md` — this file

The three workflow files are synthesized from `@cdktn/provider-project`, exactly as they are in a real provider repository. The `README.md` is hand-authored.

## Where the content comes from

All of it is maintained by [`cdktn-repository-manager`](https://github.com/cdktn-io/cdktn-repository-manager): the `sync-template` job in `.github/workflows/upgrade-repositories.yml` re-synthesizes the workflows and pushes them here whenever the repository fan-out runs. That repository is the source of truth — see [`docs/template-repo.md`](https://github.com/cdktn-io/cdktn-repository-manager/blob/main/docs/template-repo.md) for the full design, and `.github/template-repo/README.md` there for the source of this file.

## What generated repositories keep

A repository generated from this template starts with the files above. Its first pull request — opened by the same fan-out that maintains this repository — replaces this `README.md` with the provider's own generated README and adds the rest of the provider project. The three workflow files are regenerated there from the provider repository's own `@cdktn/provider-project` and `projen` versions, so they never depend on how fresh this template happens to be.
