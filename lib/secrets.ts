/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { Construct } from "constructs";
import { TerraformVariable } from "cdktn";
import { constantCase } from "change-case";
import { Repository } from "@cdktn/provider-github/lib/repository";
import { DataGithubRepository } from "@cdktn/provider-github/lib/data-github-repository";
import { GithubProvider } from "@cdktn/provider-github/lib/provider";
import { ActionsSecret } from "@cdktn/provider-github/lib/actions-secret";
import { ActionsEnvironmentSecret } from "@cdktn/provider-github/lib/actions-environment-secret";
import { RepositoryEnvironment } from "@cdktn/provider-github/lib/repository-environment";

export interface DeploymentEnvironment {
  /**
   * The environment's literal name. Needed separately from `resource`:
   * `RepositoryEnvironment.environment` is a resource attribute (a token),
   * and a token cannot be part of a construct id.
   */
  readonly name: string;
  readonly resource: RepositoryEnvironment;
}

export interface SecretFromVariableOptions {
  /**
   * Marks this secret's own name (its aliases are marked separately, on
   * `addAlias`) as one that only a release job ever reads.
   *
   * On its own this changes nothing. It only takes effect when `for()` is
   * given a deployment environment: marked names are then created as
   * `github_actions_environment_secret` inside that environment instead of as
   * repo-level `github_actions_secret`, so a workflow job that does not
   * declare the environment cannot read them. Unmarked names stay repo-level
   * even then, because non-release workflows in the same repository need them.
   */
  readonly releaseScoped?: boolean;
}

export class SecretFromVariable extends Construct {
  public readonly name: string;
  public readonly variable: TerraformVariable;
  public secretNames: string[] = [];
  /**
   * Secret names (this secret's own name and/or its aliases) that `for()` may
   * scope to a deployment environment. See SecretFromVariableOptions.
   */
  private readonly releaseScopedNames = new Set<string>();

  constructor(
    scope: Construct,
    name: string,
    options: SecretFromVariableOptions = {},
  ) {
    super(scope, name);

    if (options.releaseScoped) {
      this.releaseScopedNames.add(name);
    }

    this.variable = new TerraformVariable(this, name, {
      sensitive: true,
      type: "string",
    });

    this.variable.overrideLogicalId(name);

    this.name = name;
  }

  public addAlias(alias: string, options: SecretFromVariableOptions = {}) {
    this.secretNames.push(alias);
    if (options.releaseScoped) {
      this.releaseScopedNames.add(alias);
    }
  }

  /**
   * @param environment when set, every name marked `releaseScoped` is created
   * as an environment secret of that environment instead of a repo-level one.
   * Omitted (the provider repos' path) means everything stays repo-level.
   */
  public for(
    repository: Repository | DataGithubRepository,
    ghProvider: GithubProvider,
    environment?: DeploymentEnvironment,
  ) {
    const secret = this.secretFor(
      repository,
      ghProvider,
      this.name,
      `secret-${this.name}`,
      environment,
    );

    this.secretNames.forEach((name) => {
      this.secretFor(
        repository,
        ghProvider,
        name,
        `secret-${this.name}-alias-${name}`,
        environment,
      );
    });

    return secret;
  }

  private secretFor(
    repository: Repository | DataGithubRepository,
    ghProvider: GithubProvider,
    name: string,
    id: string,
    environment?: DeploymentEnvironment,
  ) {
    if (environment && this.releaseScopedNames.has(name)) {
      return new ActionsEnvironmentSecret(
        repository,
        `${id}-in-${environment.name}`,
        {
          plaintextValue: this.variable.value,
          secretName: constantCase(name),
          repository: repository.name,
          environment: environment.name,
          provider: ghProvider,
          // The environment is a separate resource we only reference by its
          // literal name, so nothing else makes Terraform create it first.
          dependsOn: [environment.resource],
        },
      );
    }

    return new ActionsSecret(repository, id, {
      plaintextValue: this.variable.value,
      secretName: constantCase(name),
      repository: repository.name,
      provider: ghProvider,
    });
  }
}

export class PublishingSecretSet extends Construct {
  private readonly secrets: SecretFromVariable[] = [];
  public readonly ghSecret: SecretFromVariable;
  public readonly npmSecret: SecretFromVariable;
  public readonly ghAppId: SecretFromVariable;
  public readonly ghAppPrivateKey: SecretFromVariable;

  constructor(scope: Construct, name: string) {
    super(scope, name);

    // Credentials no workflow other than a release job has any use for. They
    // become environment secrets on repositories that opt into a deployment
    // environment (see `SecretFromVariableOptions.releaseScoped`), and stay
    // repo-level everywhere else.
    //
    // Not in this set, deliberately: `npm-token` and `twine-*`, because the
    // TypeScript/Python publishes have moved to OIDC trusted publishing and
    // these are only still provisioned as a fallback; and `gh-token` /
    // `gh-app-*`, which projen's non-release workflows (upgrade, auto-merge)
    // read on every provider repo. `gh-token`'s GO_GITHUB_TOKEN alias is
    // marked individually below.
    const releaseScoped = new Set([
      "nuget-api-key",
      "maven-username",
      "maven-password",
      "maven-gpg-private-key",
      "maven-gpg-private-key-passphrase",
    ]);

    this.secrets = [
      "gh-token", // TODO: Remove PAT
      "gh-app-id",
      "gh-app-private-key",
      "npm-token",
      "twine-username",
      "twine-password",
      "nuget-api-key",
      "maven-username", // Set up Maven Central and store credentials in BitWarden
      "maven-password", // Use the user token password (same as above)
      "maven-gpg-private-key",
      "maven-gpg-private-key-passphrase",
    ].map(
      (name) =>
        new SecretFromVariable(this, name, {
          releaseScoped: releaseScoped.has(name),
        }),
    );

    const npmSecret = this.secrets.find((s) => s.name === "npm-token");
    if (!npmSecret) throw new Error("npm-token secret not found");

    // TODO: Remove PAT
    const ghSecret = this.secrets.find((s) => s.name === "gh-token");
    if (!ghSecret) throw new Error("gh-token secret not found");
    ghSecret.addAlias("PROJEN_GITHUB_TOKEN");
    // TODO: Remove - blocked by https://github.com/cdktn-io/cdktn-provider-project/issues/4
    // used for publishing Go packages to separate repo -- only ever read by a
    // release job, unlike GH_TOKEN/PROJEN_GITHUB_TOKEN which the upgrade and
    // auto-merge workflows read, so this alias alone is release-scopable.
    ghSecret.addAlias("GO_GITHUB_TOKEN", { releaseScoped: true });

    const ghAppId = this.secrets.find((s) => s.name === "gh-app-id")
    if (!ghAppId) throw new Error("gh-app-id secret not found");
    ghAppId.addAlias("PROJEN_APP_ID")

    const ghAppPrivateKey = this.secrets.find((s) => s.name === "gh-app-private-key")
    if (!ghAppPrivateKey) throw new Error("gh-app-private-key secret not found");
    ghAppPrivateKey.addAlias("PROJEN_APP_PRIVATE_KEY")

    this.ghSecret = ghSecret;
    this.npmSecret = npmSecret;
    this.ghAppId = ghAppId;
    this.ghAppPrivateKey = ghAppPrivateKey;
  }

  public forAllLanguages(
    repository: Repository | DataGithubRepository,
    ghProvider: GithubProvider,
  ) {
    this.secrets.forEach((secret) => secret.for(repository, ghProvider));
  }

  private forPrefixedSecrets(
    repository: Repository | DataGithubRepository,
    ghProvider: GithubProvider,
    prefix: string,
    environment?: DeploymentEnvironment,
  ) {
    this.secrets
      .filter((secret) => secret.name.startsWith(prefix))
      .forEach((secret) => secret.for(repository, ghProvider, environment));
  }

  public forGitHub(
    repository: Repository | DataGithubRepository,
    ghProvider: GithubProvider,
    environment?: DeploymentEnvironment,
  ) {
    this.forPrefixedSecrets(repository, ghProvider, "gh-", environment);
  }

  public forTypescript(
    repository: Repository | DataGithubRepository,
    ghProvider: GithubProvider,
    environment?: DeploymentEnvironment,
  ) {
    this.forPrefixedSecrets(repository, ghProvider, "npm-", environment);
  }

  public forPython(
    repository: Repository | DataGithubRepository,
    ghProvider: GithubProvider,
    environment?: DeploymentEnvironment,
  ) {
    this.forPrefixedSecrets(repository, ghProvider, "twine-", environment);
  }

  public forCsharp(
    repository: Repository | DataGithubRepository,
    ghProvider: GithubProvider,
    environment?: DeploymentEnvironment,
  ) {
    this.forPrefixedSecrets(repository, ghProvider, "nuget-", environment);
  }

  public forJava(
    repository: Repository | DataGithubRepository,
    ghProvider: GithubProvider,
    environment?: DeploymentEnvironment,
  ) {
    this.forPrefixedSecrets(repository, ghProvider, "maven-", environment);
  }

  public forGo(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _repository: Repository | DataGithubRepository,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ghProvider: GithubProvider,
  ) {
    // No additional go secrets required, this method exists for consistency
  }
}
