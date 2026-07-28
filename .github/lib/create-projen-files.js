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
  // Maps a provider to its custom-runner settings, e.g.
  //   { "datadog": { "nodeHeapSizeMb": 24576 }, "aws": {} }
  // An empty object means "use the custom runner with default settings".
  //
  // This was historically a plain array of provider names. Accept that shape
  // too, so an in-flight PR that appends a bare name still synths correctly
  // instead of silently dropping every provider off the custom runner.
  const customRunnerConfig = require(
    path.join(mainFolder, "providersWithCustomRunners.json"),
  );
  const customRunners = Array.isArray(customRunnerConfig)
    ? Object.fromEntries(customRunnerConfig.map((name) => [name, {}]))
    : customRunnerConfig;
  const runnerOptions = customRunners[providerName];
  const useCustomGithubRunner = runnerOptions !== undefined;
  // Leave unset to take the default for the runner class; the provider-project
  // template decides what that is. Only override for a provider that still OOMs.
  const nodeHeapSizeMb = runnerOptions?.nodeHeapSizeMb;
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
    .replace("__NODE_HEAP_MB__", nodeHeapSizeMb ?? "undefined")
    .replace("__PYPI_TRUSTED__", usePypiTrustedPublishing);
  fs.writeFileSync(
    path.join(process.env.GITHUB_WORKSPACE, "provider", ".projenrc.js"),
    projenrc,
  );
};
