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
  // Node 20 went EOL 2026-04-30. This is also forced: @cdktn/provider-project
  // declares engines node>=22.11.0 as of v0.8.0, and yarn classic *errors* on an
  // engines mismatch, so provider repos cannot install ^0.8.0 on Node 20 at all.
  // 24.11.0 is the first Node 24 LTS (supported to 2028-04-30); going to 22 would
  // schedule another breaking engines bump before 2027-04-30.
  // NOTE: projen derives @types/node@^24 from this automatically.
  minNodeVersion: "24.11.0",
  typescriptVersion: "~5.9.0", // JSII and TS should always use the same major/minor version range
  jsiiVersion: "~5.9.0", // JSII and TS should always use the same major/minor version range
  devDeps: ["@cdktn/provider-project@^0.8.0"],
  isDeprecated: false,
  npmTrustedPublishing: true,
  pypiTrustedPublishing: __PYPI_TRUSTED__,
});

project.synth();
