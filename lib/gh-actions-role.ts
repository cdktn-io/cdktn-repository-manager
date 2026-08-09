/**
 * Copyright IBM Corp. 2020, 2026
 * SPDX-License-Identifier: MPL-2.0
 */

import { Construct } from "constructs";
import { TerraformOutput } from "cdktn";
import { AwsStack, AwsStackProps } from "terraconstructs/lib/aws";
import { OpenIdConnectProvider, Role, FederatedPrincipal } from "terraconstructs/lib/aws/iam";
import { Duration } from "terraconstructs";

export interface GitHubActionsRoleStackProps extends AwsStackProps {
  readonly repoInfo: RepoInfo;
}

export interface RepoInfo {
    readonly githubOrg: string;
    readonly githubRepo: string;
}

/**
 * Stack to provision IAM Role (granted TF Backend permissions by core IaC)
 */
export class GitHubActionsRoleStack extends AwsStack {
  constructor(scope: Construct, id: string, props: GitHubActionsRoleStackProps) {
    super(scope, id, props);
    const { repoInfo } = props;

    // const coreState = new DataTerraformRemoteStateS3(this, "CoreStackRemoteState", coreStackBackend);

    // Reference existing GitHub OIDC provider (account-level resource)
    const providerArn = `arn:aws:iam::${this.account}:oidc-provider/token.actions.githubusercontent.com`;
    const provider = OpenIdConnectProvider.fromOpenIdConnectProviderArn(this, 'GitHubOIDCProvider', providerArn);
    
    // Deploy role
    const { githubOrg, githubRepo } = repoInfo;
    // 2. Define the role that GitHub Actions will assume
    const githubActionsRole = new Role(this, 'GitHubActionsRole', {
      assumedBy: new FederatedPrincipal(
        provider.openIdConnectProviderArn,
        [{
          test: "StringLike",
          // Constrain the role to a specific repository
          variable: 'token.actions.githubusercontent.com:sub',
          values: [`repo:${githubOrg}/${githubRepo}:*`],
          },
          {
          test: "StringEquals",
          // Constrain the audience (aud) to sts.amazonaws.com
          variable: 'token.actions.githubusercontent.com:aud',
          values: ['sts.amazonaws.com'],
        }],
        'sts:AssumeRoleWithWebIdentity'
      ),
      description: 'IAM role for GitHub Actions to deploy CDK stacks',
      maxSessionDuration: Duration.hours(1), // Set max session duration
    });

    // Outputs for GitHub Actions setup
    new TerraformOutput(this, "deploy_role_arn", {
      value: githubActionsRole.roleArn,
    });
  }
}
