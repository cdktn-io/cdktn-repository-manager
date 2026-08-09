/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

const OWNER = "cdktn-io";
const REPO = "cdktn-provider-template";

// The workflows a newly generated provider repository needs on its base branch
// for its first pull request to merge unattended. Authoritative list lives in
// upgrade-repositories.yml's sync-template job; see docs/template-repo.md.
const REQUIRED_WORKFLOWS = [
  "pull-request-lint.yml",
  "auto-approve.yml",
  "automerge.yml",
];

const SEED_INSTRUCTIONS =
  "Run the 'Upgrade Provider Repositories' workflow (.github/workflows/upgrade-repositories.yml, job sync-template) to seed it, then re-run this deploy.";

module.exports = async ({ github, core }) => {
  let entries;

  try {
    const { data } = await github.rest.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path: ".github/workflows",
    });
    entries = data;
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }

    // A 404 here means either the repository does not exist yet, or it exists
    // but has no workflows directory. Only the first is acceptable: it is the
    // bootstrap deploy that creates the template repository itself.
    try {
      await github.rest.repos.get({ owner: OWNER, repo: REPO });
    } catch (repoError) {
      if (repoError.status === 404) {
        core.info(
          `${OWNER}/${REPO} does not exist yet; this deploy is expected to create it.`,
        );
        return;
      }
      throw repoError;
    }

    core.setFailed(
      `${OWNER}/${REPO} exists but has no .github/workflows on its default branch, so repositories generated from it could not merge their first pull request. ${SEED_INSTRUCTIONS}`,
    );
    return;
  }

  const present = new Set(
    (Array.isArray(entries) ? entries : []).map((entry) => entry.name),
  );
  const missing = REQUIRED_WORKFLOWS.filter((name) => !present.has(name));

  if (missing.length > 0) {
    core.setFailed(
      `${OWNER}/${REPO} is missing required workflow(s) on its default branch: ${missing.join(", ")}. Repositories generated from it could not merge their first pull request. ${SEED_INSTRUCTIONS}`,
    );
    return;
  }

  core.info(`${OWNER}/${REPO} carries all required workflows.`);
};
