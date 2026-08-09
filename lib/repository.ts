/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { Construct } from "constructs";
import { SecretFromVariable } from "./secrets";
import { GithubProvider } from "@cdktf/provider-github/lib/provider";
import { Repository } from "@cdktf/provider-github/lib/repository";
import { DataGithubRepository } from "@cdktf/provider-github/lib/data-github-repository";
import { IssueLabel } from "@cdktf/provider-github/lib/issue-label";
import { BranchProtection } from "@cdktf/provider-github/lib/branch-protection";
import { TeamRepository } from "@cdktf/provider-github/lib/team-repository";
import { RepositoryWebhook } from "@cdktf/provider-github/lib/repository-webhook";
import { RepositoryDependabotSecurityUpdates } from "@cdktf/provider-github/lib/repository-dependabot-security-updates";

export interface ITeam {
  id: string;
}

export interface RepositoryConfig {
  description?: string;
  topics?: string[];
  team: ITeam;
  protectMain?: boolean;
  protectMainChecks?: string[];
  /**
   * Minimal branch protection: blocks deletion and force-pushes on main, but
   * requires no status checks and no reviews, so an automated job can push
   * straight to main. Only consulted when `protectMain` is false.
   */
  protectMainMinimal?: boolean;
  webhookUrl: string;
  provider: GithubProvider;
  /**
   * Marks this repository as a GitHub template repository.
   */
  isTemplate?: boolean;
  /**
   * Defaults to true for main repos and false for -go repos.
   */
  hasIssues?: boolean;
  /**
   * Provisions this repository by generating it from cdktn-provider-template
   * instead of from an empty initial commit, so it is born with the
   * base-branch workflows its first pull request needs.
   * See docs/template-repo.md.
   */
  fromProviderTemplate?: boolean;
}

export class RepositorySetup extends Construct {
  constructor(
    scope: Construct,
    name: string,
    config: Pick<
      RepositoryConfig,
      | "team"
      | "webhookUrl"
      | "provider"
      | "protectMain"
      | "protectMainChecks"
      | "protectMainMinimal"
    > & {
      repository: Repository | DataGithubRepository;
    },
  ) {
    super(scope, name);

    const {
      protectMain = false,
      // TODO: Re-add license/cla ?
      protectMainChecks = ["build"], // , "license/cla"],
      protectMainMinimal = false,
      provider,
      repository,
      team,
      webhookUrl,
    } = config;

    new IssueLabel(this, `automerge-label`, {
      color: "5DC8DB",
      name: "automerge",
      repository: repository.name,
      provider,
    });

    new IssueLabel(this, `no-auto-close-label`, {
      color: "EE2222",
      name: "no-auto-close",
      repository: repository.name,
      provider,
    });

    new IssueLabel(this, `auto-approve-label`, {
      color: "8BF8BD",
      name: "auto-approve",
      repository: repository.name,
      provider,
    });

    if (protectMain) {
      new BranchProtection(this, "main-protection", {
        pattern: "main",
        repositoryId: repository.name,
        enforceAdmins: true,
        allowsDeletions: false,
        allowsForcePushes: false,
        requiredPullRequestReviews: [
          {
            requiredApprovingReviewCount: 1,
            requireCodeOwnerReviews: false, // NOTE: In the future, Security wants to enforce this, so be warned...
            dismissStaleReviews: true,
          },
        ],
        requireConversationResolution: true,
        requiredLinearHistory: true,
        requiredStatusChecks: [
          {
            strict: false,
            contexts: protectMainChecks,
          },
        ],
        provider,
      });
    } else if (protectMainMinimal) {
      new BranchProtection(this, "main-protection", {
        pattern: "main",
        repositoryId: repository.name,
        enforceAdmins: true,
        allowsDeletions: false,
        allowsForcePushes: false,
        provider,
      });
    }

    new TeamRepository(this, "managing-team", {
      repository: repository.name,
      teamId: team.id,
      permission: "admin",
      provider,
    });

    // Slack integration so we can be notified about new PRs and Issues
    new RepositoryWebhook(this, "slack-webhook", {
      repository: repository.name,

      configuration: {
        url: webhookUrl,
        contentType: "json",
      },

      // We don't need to notify about PRs since they are auto-created
      events: ["issues"],
      provider,
    });
  }
}

export class GithubRepository extends Construct {
  public readonly resource: Repository;
  private readonly provider: GithubProvider;
  public static defaultTopics = [
    "cdktn",
    "cdk-terrain",
    "opentofu",
    "cdktf",
    "terraform",
    "terraform-cdk",
    "cdk",
    "provider",
    "pre-built-provider",
  ];

  constructor(scope: Construct, name: string, config: RepositoryConfig) {
    super(scope, name);

    const {
      topics = GithubRepository.defaultTopics,
      description = "Repository management for prebuilt CDK Terrain providers",
      provider,
      isTemplate = false,
      fromProviderTemplate = false,
    } = config;
    this.provider = provider;

    this.resource = new Repository(this, "repo", {
      name,
      description,
      archiveOnDestroy: true,
      visibility: "public",
      homepageUrl: "https://cdktn.io",
      hasIssues: config.hasIssues ?? !name.endsWith("-go"),
      hasWiki: false,
      autoInit: true,
      isTemplate,
      hasProjects: false,
      deleteBranchOnMerge: true,
      allowAutoMerge: true,
      allowUpdateBranch: true,
      squashMergeCommitMessage: "PR_BODY",
      squashMergeCommitTitle: "PR_TITLE",
      vulnerabilityAlerts: !name.endsWith("-go"),
      topics,
      provider,
      ...(fromProviderTemplate
        ? {
            template: {
              owner: "cdktn-io",
              repository: "cdktn-provider-template",
            },
          }
        : {}),
      // Unconditional, on every repo this construct creates. `template` and
      // `auto_init` are creation-time-only inputs that GitHub never reports
      // back, so ignoring them keeps `template{}` a plan no-op on repositories
      // that already exist or are being imported. Upstream
      // integrations/terraform-provider-github#2090 flags maintainer intent to
      // make setting `template` on an existing repository stricter -- re-check
      // this on provider upgrades past 6.6.0. See docs/template-repo.md.
      lifecycle: { ignoreChanges: ["template", "auto_init"] },
    });

    new RepositorySetup(this, "repository-setup", {
      ...config,
      repository: this.resource,
    });

    if (!name.endsWith("-go")) {
      new RepositoryDependabotSecurityUpdates(this, "dependabot-security", {
        provider,
        repository: this.resource.name,
        enabled: true,
      });
    }
  }

  addSecret(name: string) {
    const variable = new SecretFromVariable(this, name);
    variable.for(this.resource, this.provider);
  }

  importFrom(id: string) {
    this.resource.importFrom(id);
  }
}

export class GithubRepositoryFromExistingRepository extends Construct {
  public readonly resource: DataGithubRepository;

  constructor(
    scope: Construct,
    name: string,
    config: RepositoryConfig & {
      repositoryName: string;
    },
  ) {
    super(scope, name);

    this.resource = new DataGithubRepository(this, "repo", {
      name: config.repositoryName,
      provider: config.provider,
    });

    new RepositorySetup(this, "repository-setup", {
      ...config,
      repository: this.resource,
    });

    if (!name.endsWith("-go")) {
      new RepositoryDependabotSecurityUpdates(this, "dependabot-security", {
        provider: config.provider,
        repository: this.resource.name,
        enabled: true,
      });
    }
  }
}
