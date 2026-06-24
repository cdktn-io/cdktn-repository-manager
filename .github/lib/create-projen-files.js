/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

module.exports = ({ providerName }) => {
  const path = require("path");
  const fs = require("fs");
  const mainFolder = path.join(process.env.GITHUB_WORKSPACE, "main");
  const provider = require(path.join(mainFolder, "provider.json"));
  const providerVersion = provider[providerName];
  const providersWithCustomRunners = require(
    path.join(mainFolder, "providersWithCustomRunners.json"),
  );
  const useCustomGithubRunner =
    providersWithCustomRunners.includes(providerName);
  // PyPI Trusted Publishing (OIDC) rollout allowlist. During the canary phase
  // this lists individual providers; set it to ["*"] to enable for all.
  const providersWithPypiTrustedPublishing = require(
    path.join(mainFolder, "providersWithPypiTrustedPublishing.json"),
  );
  const usePypiTrustedPublishing =
    providersWithPypiTrustedPublishing.includes("*") ||
    providersWithPypiTrustedPublishing.includes(providerName);
  const template = fs.readFileSync(
    path.join(mainFolder, "projenrc.template.js"),
    "utf-8",
  );
  const projenrc = template
    .replace("__PROVIDER__", providerVersion)
    .replace("__CUSTOM_RUNNER__", useCustomGithubRunner)
    .replace("__PYPI_TRUSTED__", usePypiTrustedPublishing);
  fs.writeFileSync(
    path.join(process.env.GITHUB_WORKSPACE, "provider", ".projenrc.js"),
    projenrc,
  );
};
