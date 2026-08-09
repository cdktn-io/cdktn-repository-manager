# The provider template repository

`cdktn-io/cdktn-provider-template` is a GitHub template repository. Every
`cdktn-provider-<name>` repository is generated from it, so that a brand-new
provider repository can merge its first pull request without a human touching
it.

## The bootstrap problem

A provider repository gets its content from the fan-out in
`.github/workflows/upgrade-repositories.yml`: the job synthesizes the projen
project and opens a pull request against the new repository's `main`. For that
pull request to merge unattended, three things must happen inside the new
repository:

1. the required status check `Validate PR title` must report success —
   `pull-request-lint.yml`;
2. an approving review must appear, because branch protection requires one —
   `auto-approve.yml`;
3. something must press merge — `automerge.yml`.

All three are `pull_request_target` workflows, and GitHub runs
`pull_request_target` workflows **from the base branch**, not from the pull
request's head. On a repository created empty the base branch contains nothing,
so none of the three exist, so none of them run: the first pull request sits
there with a missing required check and no approval, forever.

Making these `pull_request` (head-branch) workflows instead would "fix" the
first pull request and break the security model. A required check that runs the
head branch's own definition is defined by the pull request's author, who can
rewrite the workflow that judges it. Required checks and the auto-approval must
run the base branch's definition — which means the base branch has to have them
before the first pull request is opened.

Hence: create the repository with those files already on `main`.

## The mechanism

`cdktn-provider-template` is created and owned by this repository like every
other repository in the organization — `createProviderTemplateRepo` in
`main.ts`, using the same `GithubRepository` construct. It differs in three
ways:

- `isTemplate: true`, so GitHub allows generating from it;
- minimal branch protection (`protectMainMinimal`): deletion and force-push are
  blocked, but there are no required status checks and no required reviews,
  because the sync job pushes straight to `main`;
- GitHub Actions disabled, via `ActionsRepositoryPermissions { enabled: false }`.

Actions are disabled because the files stored there are `pull_request_target`
workflows intended to run in the repositories generated from the template. The
template repository is public, holds no credentials, and has nothing to build,
so those workflows must never execute in it. Disabling Actions is a repository
setting: it does not affect generate-from-template (a contents copy) or the
sync job's push (a contents write).

### Every provider main repo is template-born

`fromProviderTemplate: true` is set unconditionally on every
`cdktn-provider-<name>` repository in the provider loop, which emits

```hcl
template {
  owner      = "cdktn-io"
  repository = "cdktn-provider-template"
}
```

on the `github_repository` resource. `template` and `auto_init` are
creation-time-only inputs — GitHub never reports them back on a read — so
`lib/repository.ts` sets, unconditionally and on **every** repository the
construct creates:

```hcl
lifecycle {
  ignore_changes = ["template", "auto_init"]
}
```

`lifecycle` is a Terraform meta-argument rather than a provider attribute, so
this produces no plan diff for the ~60 repositories that already exist
(verified against live state): they were not created from a template, they
never will be, and Terraform stops comparing the field. The block only has an
effect at creation time, for repositories Terraform creates fresh.

The consequence is that onboarding a new provider needs no extra configuration
file and no allowlist: add it to `provider.json` and `sharded-stacks.json`, and
its repository is template-born automatically. Repositories brought in through
`pending-imports.json` are equally unaffected, for the same reason.

Upstream issue [integrations/terraform-provider-github#2090][2090] records
maintainer intent to make setting `template` on a repository that already
exists stricter. Today it is inert for existing repositories, and
`ignore_changes` keeps it inert. **Re-check this when upgrading the GitHub
provider past 6.6.0** — if the provider starts diffing or forcing replacement
on `template`, the unconditional application above is what has to change.

[2090]: https://github.com/integrations/terraform-provider-github/issues/2090

### `-go` repositories are excluded

The companion `cdktn-provider-<name>-go` repositories are not generated from
the template. They have no pull request flow at all: release workflows push
content into them directly, and they run `protectMain: false`. There is nothing
for the three workflows to gate, so seeding them would only add files that must
later be removed.

## Content contract

The template holds exactly four files:

| File                                      | Origin                                                              |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `.github/workflows/pull-request-lint.yml` | synthesized                                                         |
| `.github/workflows/auto-approve.yml`      | synthesized                                                         |
| `.github/workflows/automerge.yml`         | synthesized                                                         |
| `README.md`                               | hand-authored, `.github/template-repo/README.md` in this repository |

The selection rule is: **a file belongs in the template if and only if (a) it is
a base-branch workflow required for the first pull request to merge unattended,
and (b) its content is provider-independent.** Everything else a provider
repository needs arrives with that first pull request.

A documented exclusion: `auto-close-community-prs.yml` is also a
`pull_request_target` workflow, and is therefore also missing from a newborn
repository's base branch — but it fails both halves of the rule. Its close
comment embeds the upstream provider's URL, so it is provider-shaped, and it is
not needed for the first pull request, because the fan-out bot that authors
that pull request is exempt from it. Newborn repositories gain the file minutes
later, when the first pull request merges.

The three-file list lives in exactly one place, the `sync-template` job. If
`@cdktn/provider-project` stops emitting one of them — a rename, a merge into
another workflow — the job fails loudly with the file name rather than pushing
a silently incomplete template. That failure is the drift alarm; the fix is to
update the list in the job and the table above.

## Freshness

`sync-template` is a job in `.github/workflows/upgrade-repositories.yml`,
sibling to `upgrade-provider` and outside its matrix. It therefore rides the
existing fan-out: same workflow, same triggers, same cadence, same credentials,
and it runs after `terraform apply` through the usual chain (`deploy.yml` →
`deploy-cdktf-stacks.yml` → `upgrade`).

The job synthesizes a throwaway provider project through the same resolution
path the fan-out uses — `.github/lib/create-projen-files.js` against
`projenrc.template.js`, then `pnpm add -D @cdktn/provider-project@latest` and
`npx projen` — runs `copywrite headers` over the output so the bytes match what
provider repositories actually commit, copies the three workflows plus the
README into the template checkout, and pushes to `main` only if
`git status --porcelain` reports a change. There is no pull request: Actions
are disabled on the template, so no check could ever run there.

Version drift between the template and the fleet is self-healing. A newborn
repository's first pull request re-synthesizes all of its workflows from its
own resolved `@cdktn/provider-project` and `projen`, so whatever versions
produced the template's copies stop mattering the moment that pull request
merges. The only contract that has to hold across versions is the name of the
required status check, `Validate PR title`, which is also what
`protectMainChecks` lists in `main.ts`.

## Birth of a provider repository, end to end

1. A provider is added to `provider.json` and `sharded-stacks.json`.
2. `deploy.yml` → `deploy-cdktf-stacks.yml` runs the `terraform` job. Before
   applying, the preflight step calls `.github/lib/check-template-seeded.js`
   and confirms the template carries the three workflows.
3. Terraform creates `cdktn-provider-<name>` from the template. The repository
   exists with `main` already containing the three workflows and the template
   README, plus branch protection requiring `Validate PR title` and one
   approving review.
4. The `upgrade` job fans out. `sync-template` refreshes the template;
   `upgrade-provider` synthesizes the full provider project and opens pull
   request #1 against the new repository.
5. In the new repository, `pull-request-lint.yml` reports `Validate PR title`,
   `auto-approve.yml` approves, `automerge.yml` merges. The merge replaces the
   template README, adds the rest of the project, and regenerates the three
   workflows from the repository's own toolchain versions.

## The deploy preflight

`.github/lib/check-template-seeded.js` runs in the `terraform` job of
`deploy-cdktf-stacks.yml`, using the job's organization-wide app token. It
lists `.github/workflows` on the template's default branch:

- template missing all three, or any one, of the workflows → the deploy fails
  with a message naming the missing files and pointing at `sync-template`;
- template repository does not exist → the check logs and passes.

That last case is the first-ever deploy, the one that creates the template
repository. On that deploy the template is created empty (an `auto_init`
README), so any provider repository created in the **same** apply would be
generated from an empty template and would still be stuck. If a bootstrap
deploy ever has to create both, run `upgrade-repositories.yml` (which seeds the
template) after the apply and before relying on the new provider repository's
first pull request — or re-run the fan-out, which will open a fresh pull
request once the base branch has the workflows. In steady state the template
exists and is seeded, and the preflight is the guard that keeps it that way.
