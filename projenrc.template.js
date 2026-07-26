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
  minNodeVersion: "20.16.0",
  typescriptVersion: "~5.9.0", // JSII and TS should always use the same major/minor version range
  jsiiVersion: "~5.9.0", // JSII and TS should always use the same major/minor version range
  devDeps: ["@cdktn/provider-project@^0.8.0"],
  isDeprecated: false,
  npmTrustedPublishing: true,
  pypiTrustedPublishing: __PYPI_TRUSTED__,
});

project.synth();
