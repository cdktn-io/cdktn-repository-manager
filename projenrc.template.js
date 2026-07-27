/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const { CdktnProviderProject } = require("@cdktn/provider-project");

const project = new CdktnProviderProject({
  useCustomGithubRunner: __CUSTOM_RUNNER__,
  terraformProvider: "__PROVIDER__",
  cdktnVersion: "^0.23.0",
  constructsVersion: "^10.6.0",
  // engines.node -- the compat floor we publish to consumers. First Node 24 LTS;
  // Node 20 went EOL 2026-04-30.
  minNodeVersion: "24.11.0",
  // CI runs current 24 LTS, not the floor. projen defaults workflowNodeVersion to
  // minNodeVersion, which pinned every setup-node step to the oldest version we
  // support -- backwards for CI, and 24.11.0 specifically has a reported memory
  // leak (nodejs/node#60482) fixed in 24.12.
  workflowNodeVersion: "24.18.0",
  typescriptVersion: "~5.9.0", // JSII and TS should always use the same major/minor version range
  jsiiVersion: "~5.9.0", // JSII and TS should always use the same major/minor version range
  devDeps: ["@cdktn/provider-project@^0.9.0"],
  isDeprecated: false,
  npmTrustedPublishing: true,
  pypiTrustedPublishing: __PYPI_TRUSTED__,
});

project.synth();
