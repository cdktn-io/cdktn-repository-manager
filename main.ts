/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { Construct } from "constructs";
import {
  App,
  TerraformStack,
  TerraformOutput,
  TerraformVariable,
  Annotations,
  Aspects,
  MigrateIds,
  S3BackendConfig,
  S3Backend,
  Token,
} from "cdktn";
import {
  GitHubActionsRoleStack,
  GithubRepository,
  GithubRepositoryFromExistingRepository,
  SecretFromVariable,
  PublishingSecretSet,
} from "./lib";
import * as fs from "fs";
import * as path from "path";
import { GithubProvider } from "@cdktn/provider-github/lib/provider";
import { DataGithubTeam } from "@cdktn/provider-github/lib/data-github-team";
import { ActionsSecret } from "@cdktn/provider-github/lib/actions-secret";
import { ActionsRepositoryPermissions } from "@cdktn/provider-github/lib/actions-repository-permissions";
import { RepositoryEnvironment } from "@cdktn/provider-github/lib/repository-environment";

type StackShards = {
  primaryStack: string;
  stacks: {
    [name: string]: {
      backend: {
        workspaceName: string;
      };
      providers: string[];
    };
  };
};

// TODO: Remove hardcoded s3 backend props
const region = "us-east-1";
const backendProps: Omit<S3BackendConfig, "key"> = {
  region,
  encrypt: true,
  bucket: "cdktn-tf-state",
  dynamodbTable: "cdktn-tf-state-locks",
  kmsKeyId: "arn:aws:kms:us-east-1:237921648970:key/bb9c9c7b-ed27-48da-8da6-fc08e73c3916",
}

const allProviders: Record<string, string> = JSON.parse(
  fs.readFileSync(path.join(__dirname, "provider.json"), "utf8"),
);

const shardedStacks: StackShards = JSON.parse(
  fs.readFileSync(path.join(__dirname, "sharded-stacks.json"), "utf8"),
);

const pendingImports: string[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, "pending-imports.json"), "utf8"),
);

interface GitUrls {
  html: string;
  ssh: string;
}

/**
 * Get list of providers that need to be generated for a stack with name
 *
 * @param name name of stack as defined in sharded-stacks.json
 * @returns Object containing provider name to terraform provider version
 */
function getShardedStackProviders(name: string): Record<string, string> {
  const stackShardInformation = shardedStacks.stacks[name];
  const stackProvidersList = stackShardInformation.providers;

  return Object.fromEntries(
    Object.entries(allProviders).filter(([key]) =>
      stackProvidersList.includes(key),
    ),
  );
}

class CdkTerrainProviderStack extends TerraformStack {
  constructor(scope: Construct, name: string, isPrimaryStack: boolean) {
    super(scope, name);

    const providers = getShardedStackProviders(name);
    this.validateProviderNames(providers);

    const githubProvider = new GithubProvider(this, "github-provider-cdktf", {
      owner: "cdktn-io",
      alias: "cdktn",
    });

    const githubTeam = new DataGithubTeam(this, "cdktn-team-cdk-terrain", {
      slug: "team-cdk-terrain",
      provider: githubProvider,
    });

    new S3Backend(this, {
      ...backendProps,
      key: `cdktn-io/cdktn-repository-manager/${shardedStacks.stacks[name].backend.workspaceName}/terraform.tfstate`,
    });

    const slackWebhook = new TerraformVariable(this, "slack-webhook", {
      type: "string",
    });
    slackWebhook.overrideLogicalId("slack-webhook");

    const secrets = new PublishingSecretSet(this, "secret-set");

    if (isPrimaryStack) {
      this.createRepositoryManagerRepo(
        slackWebhook,
        secrets,
        githubProvider,
        githubTeam,
      );
      this.createProviderProjectRepo(
        slackWebhook,
        secrets.npmSecret,
        secrets.ghAppId,
        secrets.ghAppPrivateKey,
        githubProvider,
        githubTeam,
      );
      this.createProviderTemplateRepo(slackWebhook, githubProvider, githubTeam);
    }

    const providerRepos: GitUrls[] = Object.keys(providers).map((provider) => {
      const repo = new GithubRepository(this, `cdktn-provider-${provider}`, {
        description: `Prebuilt CDK Terrain (cdktn) provider for ${provider}.`,
        topics: [...GithubRepository.defaultTopics, provider],
        team: githubTeam,
        protectMain: true,
        protectMainChecks: [
          "build",
          "package-js",
          "package-java",
          "package-python",
          "package-dotnet",
          "package-go",
          "Validate PR title",
        ],
        webhookUrl: slackWebhook.stringValue,
        provider: githubProvider,
        fromProviderTemplate: true,
      });

      // repo to publish go packages to
      const goRepo = new GithubRepository(this, `cdktn-provider-${provider}-go`, {
        description: `CDK Terrain Go provider bindings for ${provider}.`,
        topics: [...GithubRepository.defaultTopics, provider],
        team: githubTeam,
        protectMain: false,
        webhookUrl: slackWebhook.stringValue,
        provider: githubProvider,
      });

      if (pendingImports.includes(provider)) {
        repo.importFrom(`cdktn-provider-${provider}`);
        goRepo.importFrom(`cdktn-provider-${provider}-go`);
      }

      secrets.forAllLanguages(repo.resource, githubProvider);
      repo.addSecret("alert-prs-slack-webhook-url");

      return {
        html: repo.resource.htmlUrl,
        ssh: repo.resource.sshCloneUrl,
      };
    });

    new TerraformOutput(this, `providerRepos`, {
      value: `\${[${providerRepos.map((e) => `"${e.ssh}"`).join(",")}]}`,
    });
  }

  private createProviderProjectRepo(
    slackWebhook: TerraformVariable,
    npmSecret: SecretFromVariable,
    ghAppIdSecret: SecretFromVariable,
    ghAppPrivateKeySecret: SecretFromVariable,
    githubProvider: GithubProvider,
    githubTeam: DataGithubTeam,
  ) {
    const templateRepository = new GithubRepository(
      this,
      "cdktn-provider-project",
      {
        team: githubTeam,
        webhookUrl: slackWebhook.stringValue,
        protectMain: true,
        // TODO: Re-add license/cla ?
        protectMainChecks: ["build", "package-js"], // "license/cla"],
        provider: githubProvider,
      },
    );

    npmSecret.for(templateRepository.resource, githubProvider);
    ghAppIdSecret.for(templateRepository.resource, githubProvider);
    ghAppPrivateKeySecret.for(templateRepository.resource, githubProvider);

    new TerraformOutput(this, "templateRepoUrl", {
      value: templateRepository?.resource.htmlUrl,
    });
  }

  /**
   * cdktn-provider-template: the GitHub template repository every
   * cdktn-provider-<name> repo is generated from. Its content (three
   * base-branch workflows plus a README) is kept current by
   * upgrade-repositories.yml's sync-template job, not by Terraform.
   * See docs/template-repo.md.
   */
  private createProviderTemplateRepo(
    slackWebhook: TerraformVariable,
    githubProvider: GithubProvider,
    githubTeam: DataGithubTeam,
  ) {
    const templateRepo = new GithubRepository(this, "cdktn-provider-template", {
      description:
        "Template repository new cdktn-io provider repositories are generated from.",
      topics: ["cdktn", "cdk-terrain", "template"],
      team: githubTeam,
      webhookUrl: slackWebhook.stringValue,
      provider: githubProvider,
      isTemplate: true,
      // Issues are pointless on a repo whose content is generated; problems
      // belong in cdktn-repository-manager or cdktn-provider-project.
      hasIssues: false,
      // The sync job pushes straight to main, so main carries no required
      // checks and no required reviews -- only deletion/force-push guards.
      protectMainMinimal: true,
    });

    // The workflows stored here are `pull_request_target` workflows meant to
    // run in the repositories generated FROM this one. This repository is
    // public, holds no credentials and has nothing to build, so they must
    // never execute here. Disabling Actions is a repository setting and does
    // not affect generate-from-template or the sync job's push, both of which
    // only read and write contents.
    new ActionsRepositoryPermissions(this, "template-actions-disabled", {
      repository: templateRepo.resource.name,
      enabled: false,
      provider: githubProvider,
    });

    new TerraformOutput(this, "providerTemplateRepoUrl", {
      value: templateRepo.resource.htmlUrl,
    });
  }

  private createRepositoryManagerRepo(
    slackWebhook: TerraformVariable,
    secrets: PublishingSecretSet,
    githubProvider: GithubProvider,
    githubTeam: DataGithubTeam,
  ) {
    const selfTokens = [
      new SecretFromVariable(this, "gh-comment-token"),
    ];

    const self = new GithubRepository(this, "cdktn-repository-manager", {
      team: githubTeam,
      webhookUrl: slackWebhook.stringValue,
      provider: githubProvider,
    });

    selfTokens.forEach((token) => token.for(self.resource, githubProvider));
    secrets.forAllLanguages(self.resource, githubProvider);
    self.addSecret("alert-prs-slack-webhook-url");

    new ActionsSecret(self.resource, "secret-slack-webhook", {
      plaintextValue: slackWebhook.stringValue,
      secretName: "SLACK_WEBHOOK",
      repository: self.resource.name,
      provider: githubProvider,
    });

    new TerraformOutput(this, "selfRepoUrl", {
      value: self.resource.htmlUrl,
    });
  }

  private validateProviderNames(providers: Record<string, string>) {
    // validate that providers contain only valid names (-go suffix is forbidden)
    const goSuffixProviders = Object.keys(providers).filter((key) =>
      key.endsWith("-go"),
    );
    if (goSuffixProviders.length > 0) {
      Annotations.of(this).addError(
        `Providers contain a provider key with a suffix -go which is not allowed due to conflicts with go package repositories. Please remove the -go suffix from these provider keys ${goSuffixProviders.join(
          ", ",
        )}`,
      );
    }

    // validate key matches provider name
    const notMatchingProviders = Object.entries(providers).filter(
      ([key, value]) => {
        const fullProviderName = new RegExp("(.*)@", "g").exec(value)![1];
        const providerName = fullProviderName.includes("/")
          ? fullProviderName.split("/")[1]
          : fullProviderName;

        const sanitizedProviderName = providerName.replace(/-/g, "");
        return key !== sanitizedProviderName;
      },
    );
    if (notMatchingProviders.length > 0) {
      Annotations.of(this).addError(
        `Provider name and provider key do not match for ${notMatchingProviders.join(
          ", ",
        )}. This leads to issues when deploying go packages. Please rename the provider key to match the provider name.`,
      );
    }
  }
}

class CustomConstructsStack extends TerraformStack {
  constructor(
    scope: Construct,
    name: string,
    constructRepos: {
      name: string;
      languages: ("typescript" | "python" | "csharp" | "java" | "go")[];
      topics?: string[];
      /**
       * Description for the companion `<name>-go` repository, created only
       * when `languages` includes "go". Defaults to a generic message.
       * (`GithubRepositoryFromExistingRepository` reads an existing repo via
       * a data source, so there is no `description` field for the main repo
       * itself -- GitHub already has whatever description it was created
       * with.)
       */
      goDescription?: string;
      /**
       * Overrides the derived `protectMain` required-status-check contexts.
       *
       * By default this is `["build", "package-<language>", ...]`, mirroring
       * the per-language job names projen generates for provider repos. That
       * default only holds for repos whose CI actually exposes a job per
       * `languages` entry -- a hand-rolled workflow (no projen boilerplate)
       * may expose only a single job. Required status checks that never
       * report leave every PR permanently unmergeable (worse, with
       * `enforce_admins: true` admins can't override), so verify the repo's
       * actual `pull_request`-triggered workflow's job names before relying
       * on the default here.
       */
      protectMainChecks?: string[];
      /**
       * Puts this repository's publishing behind a GitHub deployment
       * environment. Opt-in, and only correct for repositories whose release
       * workflow is dispatched from a *branch*.
       *
       * When true:
       * - a `release` environment is created, and both it and the `pypi`
       *   environment are restricted to protected branches (i.e. `main`,
       *   which `protectMain: true` protects) with `team-cdk-terrain` as
       *   required reviewer;
       * - the credentials only a release job reads (MAVEN_*, NUGET_API_KEY,
       *   GO_GITHUB_TOKEN) become environment secrets of `release` instead
       *   of repo-level Actions secrets, so a job that does not declare
       *   `environment: release` cannot read them at all.
       *
       * This is the infrastructure half of the cdktn-aws PR #1 security
       * review finding: with repo-level publishing secrets and no
       * environment, anyone able to dispatch release.yml from an arbitrary
       * branch runs attacker-controlled code with those credentials in
       * scope.
       *
       * NOT enabled for cdktn-awscc, deliberately: its release.yml is
       * triggered by `push: tags: ["v*"]`, and a "protected branches only"
       * deployment policy rejects a run whose ref is a tag -- turning this
       * on there would block every tag release. A repo that gains a tag
       * trigger later needs a custom branch/tag policy instead of this flag.
       */
      protectedReleaseEnvironment?: boolean;
    }[],
  ) {
    super(scope, name);
    const githubProvider = new GithubProvider(this, "github-provider-cdktf", {
      owner: "cdktn-io",
      alias: "cdktn",
    });

    const githubTeam = new DataGithubTeam(this, "cdktf-team-cdktf", {
      slug: "team-cdk-terrain",
      provider: githubProvider,
    });

    new S3Backend(this, {
      ...backendProps,
      key: "cdktn-io/cdktn-repository-manager/custom-constructs/terraform.tfstate",
    });
    const slackWebhook = new TerraformVariable(this, "slack-webhook", {
      type: "string",
    });
    slackWebhook.overrideLogicalId("slack-webhook");

    const secrets = new PublishingSecretSet(this, "secret-set");

    // TODO: Re-add license/cla to protectMainChecks ?
    constructRepos.forEach(
      ({
        name: repoName,
        languages,
        topics,
        goDescription,
        protectMainChecks: protectMainChecksOverride,
        protectedReleaseEnvironment = false,
      }) => {
        const protectMainChecks =
          protectMainChecksOverride ??
          ["build"].concat(
            languages.map((language) => {
              return `package-${
                language === "typescript"
                  ? "js"
                  : language === "csharp"
                    ? "dotnet"
                    : language
              }`;
            }),
          );

        const repo = new GithubRepositoryFromExistingRepository(
          this,
          `cdktn-construct-${repoName}`,
          {
            repositoryName: repoName,
            team: githubTeam,
            webhookUrl: slackWebhook.stringValue,
            provider: githubProvider,
            protectMain: true,
            protectMainChecks,
          },
        );

        // Deployment protection shared by every environment of a repo that
        // opted in: only refs of protected branches (i.e. `main`) may deploy,
        // and a team-cdk-terrain member has to approve the run.
        //
        // `preventSelfReview: false` because the team is small enough that
        // the person dispatching a release is usually the only one who can
        // approve it; true would deadlock every release. `canAdminsBypass:
        // false` so the approval is not silently optional for the admins who
        // do the releasing -- the branch policy, not the click, is the actual
        // control, but a bypassable gate is worse than an honest one.
        const deploymentProtection = protectedReleaseEnvironment
          ? {
              deploymentBranchPolicy: {
                protectedBranches: true,
                customBranchPolicies: false,
              },
              reviewers: {
                // github_repository_environment wants numeric team IDs;
                // data.github_team's id *is* the numeric ID, as a string.
                teams: [Token.asNumber(githubTeam.id)],
              },
              canAdminsBypass: false,
              preventSelfReview: false,
            }
          : {};

        // release.yml's publishing jobs run with `environment: release`; the
        // credentials they need live in this environment rather than on the
        // repository, so a job dispatched from another branch -- or a job
        // that just omits the environment -- cannot read them.
        const releaseEnvironmentName = "release";
        const releaseEnvironment = protectedReleaseEnvironment
          ? {
              name: releaseEnvironmentName,
              resource: new RepositoryEnvironment(
                this,
                `${repoName}-${releaseEnvironmentName}-environment`,
                {
                  environment: releaseEnvironmentName,
                  repository: repo.resource.name,
                  provider: githubProvider,
                  ...deploymentProtection,
                },
              ),
            }
          : undefined;

        secrets.forGitHub(repo.resource, githubProvider, releaseEnvironment);
        if (languages.includes("typescript")) {
          secrets.forTypescript(repo.resource, githubProvider);
        }
        if (languages.includes("python")) {
          secrets.forPython(repo.resource, githubProvider);

          // release.yml's release_pypi job runs with `environment: pypi`
          // (PyPI trusted publishing / OIDC) -- that job silently fails to
          // start on the first release unless the environment already
          // exists on the repo.
          new RepositoryEnvironment(this, `${repoName}-pypi-environment`, {
            environment: "pypi",
            repository: repo.resource.name,
            provider: githubProvider,
            ...deploymentProtection,
          });
        }
        if (languages.includes("csharp")) {
          secrets.forCsharp(repo.resource, githubProvider, releaseEnvironment);
        }
        if (languages.includes("java")) {
          secrets.forJava(repo.resource, githubProvider, releaseEnvironment);
        }
        if (languages.includes("go")) {
          secrets.forGo(repo.resource, githubProvider);

          // repo to publish go packages to
          new GithubRepository(this, `${repoName}-go`, {
            description:
              goDescription ?? `CDK Terrain Go bindings for ${repoName}.`,
            topics,
            team: githubTeam,
            protectMain: false,
            webhookUrl: slackWebhook.stringValue,
            provider: githubProvider,
          });
        }
      },
    );
  }
}

const app = new App();

const primaryStackName = shardedStacks.primaryStack;
const stackNames = Object.keys(shardedStacks.stacks);
const allProvidersInShards = Object.values(shardedStacks.stacks)
  .map((stack) => stack.providers)
  .flat() as string[];
const allProviderNames = Object.keys(allProviders);

// Validations for provider names
const shardProviderSet = new Set(allProvidersInShards);
const allProviderSet = new Set(allProviderNames);
const missingProvidersInShards = new Set(
  [...allProviderSet].filter((provider) => !shardProviderSet.has(provider)),
);
const missingProvidersInAllProviders = new Set(
  [...shardProviderSet].filter((provider) => !allProviderSet.has(provider)),
);

if (shardProviderSet.size < allProvidersInShards.length) {
  throw new Error("Duplicates present in sharded-stacks.json");
}

if (missingProvidersInShards.size > 0) {
  throw new Error(
    `One or more providers present in provider.json are missing in sharded-stacks.json: ${[
      ...missingProvidersInShards,
    ]}`,
  );
}

if (missingProvidersInAllProviders.size > 0) {
  throw new Error(
    `One or more providers present in sharded-stacks.json are missing in provider.json: ${[
      ...missingProvidersInAllProviders,
    ]}`,
  );
}

if (!primaryStackName) {
  throw new Error("Cannot proceed without a primary stack");
}
if (!stackNames.includes(primaryStackName)) {
  throw new Error("Cannot proceed with a non-existent stack as primary");
}

stackNames.forEach((stackName) => {
  const providerStack = new CdkTerrainProviderStack(
    app,
    stackName,
    primaryStackName === stackName,
  );
  Aspects.of(providerStack).add(new MigrateIds());
});

new CustomConstructsStack(app, "custom-constructs", [
  {
    name: "cdktn-awscc",
    languages: ["typescript", "python", "java", "csharp", "go"],
    // cdktn-awscc is hand-authored (jsii + jsii-pacmak), not a generated
    // provider binding -- drop the provider-repo-only topics that
    // GithubRepository.defaultTopics carries.
    topics: [
      ...GithubRepository.defaultTopics.filter(
        (topic) => topic !== "provider" && topic !== "pre-built-provider",
      ),
      "awscc",
      "aws-cdk",
    ],
    goDescription:
      "Go bindings for @cdktn/awscc (AWS-CDK-shaped AWSCC bindings)",
    // cdktn-awscc has no projen boilerplate and no per-language build
    // matrix: build.yml's only pull_request-triggered job is `build`
    // (verified against cdktn-io/cdktn-awscc@feat/ci-release). The
    // package-js/package-python/package-java/package-dotnet/package-go
    // contexts the default derivation would produce never report on a PR,
    // which -- combined with enforce_admins: true -- would make every PR
    // (including admin merges) permanently unmergeable. Revisit this once
    // that repo's build.yml exposes a check per language.
    protectMainChecks: ["build"],
  },
  {
    name: "cdktn-aws",
    languages: ["typescript", "python", "java", "csharp", "go"],
    // cdktn-aws is hand-authored tooling (jsii + jsii-pacmak) that regroups
    // terraform-provider-aws into per-service modules -- it is not one of the
    // projen-generated `cdktn-provider-*` packages, and `cdktn-provider-aws`
    // already carries the provider/pre-built-provider topics for the AWS
    // provider. Keeping them here too would make the two AWS repos
    // indistinguishable in topic search, so drop them (same call as
    // cdktn-awscc above).
    topics: [
      ...GithubRepository.defaultTopics.filter(
        (topic) => topic !== "provider" && topic !== "pre-built-provider",
      ),
      "aws",
      "aws-cdk",
    ],
    goDescription:
      "Go bindings for @cdktn/aws (terraform-provider-aws regrouped into service modules)",
    // Verified against cdktn-io/cdktn-aws's actual ci.yml (the only
    // pull_request-triggered workflow) -- these are the job `name:` values,
    // which is what GitHub reports as the check context. The default
    // package-js/package-python/... derivation does not apply: cdktn-aws has
    // no projen boilerplate and no per-language build matrix.
    //
    // The last two names are the reconcile jobs that `needs:` the sharded
    // matrices (`jsii shard N/8`, `pacmak + size shard N/8`); the 10 matrix
    // children are deliberately not listed, because matrix-expanded context
    // names go stale the moment ci.yml re-shards.
    //
    // That substitution only holds because ci.yml makes those two jobs run
    // and fail when a shard is red: each carries `if: ${{ !cancelled() }}`
    // plus a first step asserting `needs.<matrix>.result == 'success'`.
    // Without that pair the reconcile job would be *skipped* when a shard
    // fails, and GitHub reports a skipped job to branch protection as
    // passing -- so a red CI run would leave all five required contexts
    // green. If either guard is ever removed from ci.yml, this list must
    // grow to the 10 shard contexts.
    protectMainChecks: [
      "typecheck, tests and invariants",
      "groups, generate determinism and runtime contract",
      "synth smoke (validation on)",
      "every group compiled exactly once, JSII3/JSII6 zero",
      "PR size coverage (2 of 8 shards)",
    ],
    // release.yml is workflow_dispatch-only today, so restricting deployments
    // to protected branches costs nothing and closes the PR #1 review finding
    // (dispatch from an arbitrary branch reaching the publish credentials).
    // If the tag trigger that release.yml's header describes as future state
    // is ever added, this flag has to become a custom branch/tag policy --
    // "protected branches only" refuses a run whose ref is a tag.
    protectedReleaseEnvironment: true,
  },
]);
new GitHubActionsRoleStack(app, "github-actions-role",{
  environmentName: "CdktnIoRepositories",
  gridUUID: "repo-manager",
  providerConfig: {
    region: "us-east-1",
  },
  repoInfo: {
    githubOrg: "cdktn-io",
    githubRepo: "cdktn-repository-manager",
  }
})

app.synth();
