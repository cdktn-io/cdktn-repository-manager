/**
 * Copyright (c) CDK Terrain Contributors
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * Adopt Repository Script
 *
 * Prepares a GitHub-imported repository in the cdktn-io org for Terraform management.
 * Fixes team references, ensures correct default branch, and enables GitHub Actions.
 *
 * Inspired by fork-and-import.js but focused only on repo preparation (no TF/import logic).
 *
 * Usage:
 *   node adopt-repo.js <repo-name>
 *
 * Example:
 *   node .github/lib/adopt-repo.js cdktn-provider-vault
 *
 * Environment:
 *   GH_TOKEN or GITHUB_TOKEN must be set for gh CLI authentication.
 *   For cross-repo pushes, use a GitHub App token with repo write access.
 */

const { execSync } = require("child_process");
const fs = require("fs");

const ORG = "cdktn-io";

// Team reference replacements
const OLD_CODEOWNERS_TEAM = "@cdktf/tf-cdk-team";
const NEW_CODEOWNERS_TEAM = "@cdktn-io/team-cdk-terrain";

const OLD_WORKFLOW_TEAM = "team-tf-cdk";
const NEW_WORKFLOW_TEAM = "team-cdk-terrain[bot]";
// `gh api /users/${NEW_WORKFLOW_TEAM} --jq .id`
const APP_USER_ID = "254218809";
const OLD_EMAIL = "github-team-tf-cdk@hashicorp.com";
const NEW_EMAIL = `${APP_USER_ID}+${NEW_WORKFLOW_TEAM}@users.noreply.github.com`;

const repoName = process.argv[2];

if (!repoName) {
  console.error("Usage: node adopt-repo.js <repo-name>");
  console.error("");
  console.error("Example:");
  console.error("  node .github/lib/adopt-repo.js cdktn-provider-vault");
  process.exit(1);
}

/**
 * Ensure the default branch is set to 'main'.
 * GitHub's import feature sometimes sets a different branch as default.
 */
async function ensureDefaultBranch(repoName) {
  try {
    console.log(`   🔀 Ensuring default branch is 'main'...`);
    const result = execSync(
      `gh api /repos/${ORG}/${repoName} --jq .default_branch`,
      { stdio: "pipe" },
    ).toString().trim();

    if (result === "main") {
      console.log(`   ✅ Default branch is already 'main'`);
      return;
    }

    console.log(`   ⚠️  Default branch is '${result}', updating to 'main'...`);
    execSync(
      `gh api -X PATCH /repos/${ORG}/${repoName} -f default_branch=main`,
      { stdio: "pipe" },
    );
    console.log(`   ✅ Default branch set to 'main'`);
  } catch (err) {
    console.error(`   ❌ Failed to set default branch: ${err.message}`);
    throw err;
  }
}

/**
 * Enable GitHub Actions on the repository.
 */
async function enableGitHubActions(repoName) {
  try {
    console.log(`   🔓 Enabling GitHub Actions...`);
    execSync(
      `echo '{"enabled":true,"allowed_actions":"all"}' | gh api -X PUT /repos/${ORG}/${repoName}/actions/permissions --input -`,
      { stdio: "pipe", shell: "/bin/bash" },
    );
    console.log(`   ✅ Actions enabled`);
  } catch (err) {
    console.error(`   ⚠️  Failed to enable Actions: ${err.message}`);
    // Non-fatal: Actions may already be enabled
  }
}

/**
 * Fix team names and email addresses in CODEOWNERS and workflow files.
 * Clones the repo, applies fixes, commits and pushes to main.
 */
async function fixTeamNames(repoName) {
  try {
    console.log(`   🔧 Fixing team references...`);

    // Create temp directory (use /var/tmp to avoid tmpfs space limits)
    const tempDir = execSync("mktemp -d -p /var/tmp").toString().trim();
    const originalDir = process.cwd();

    try {
      process.chdir(tempDir);
      execSync(`gh repo clone ${ORG}/${repoName} . -- --depth 1 --quiet`, {
        stdio: "pipe",
      });
      let filesChanged = 0;

      // Update CODEOWNERS
      const codeOwnersFile = ".github/CODEOWNERS";
      try {
        const content = fs.readFileSync(codeOwnersFile, "utf8");
        if (content.includes(OLD_CODEOWNERS_TEAM)) {
          const newContent = content.replaceAll(
            OLD_CODEOWNERS_TEAM,
            NEW_CODEOWNERS_TEAM,
          );
          fs.writeFileSync(codeOwnersFile, newContent);
          filesChanged++;
          console.log(`   ✅ Updated CODEOWNERS`);
        } else {
          console.log(`   ⏭️  CODEOWNERS already up to date`);
        }
      } catch (err) {
        console.log(`   ⏭️  Skipped CODEOWNERS (not found)`);
      }

      // Update workflow files
      const workflowFiles = execSync(
        'find .github/workflows -name "*.yml" 2>/dev/null || true',
      )
        .toString()
        .trim()
        .split("\n")
        .filter((f) => f);

      if (workflowFiles.length === 0) {
        console.log(`   ⏭️  No workflow files to update`);
      } else {
        for (const file of workflowFiles) {
          try {
            const content = fs.readFileSync(file, "utf8");
            if (
              content.includes(OLD_WORKFLOW_TEAM) ||
              content.includes(OLD_EMAIL)
            ) {
              const newContent = content
                .replaceAll(OLD_WORKFLOW_TEAM, NEW_WORKFLOW_TEAM)
                .replaceAll(OLD_EMAIL, NEW_EMAIL);
              fs.writeFileSync(file, newContent);
              filesChanged++;
            }
          } catch (err) {
            // Skip files we can't read/write
          }
        }
      }

      if (filesChanged === 0) {
        console.log(`   ⏭️  No changes needed`);
        return;
      }

      console.log(`   ✓ Updated ${filesChanged} file(s)`);

      // Commit and push
      execSync(`git config user.name "${NEW_WORKFLOW_TEAM}"`, {
        stdio: "pipe",
      });
      execSync(`git config user.email "${NEW_EMAIL}"`, { stdio: "pipe" });
      execSync("git add -A", { stdio: "pipe" });
      execSync(
        `git commit -m "fix: update team references for cdktn-io org" --quiet`,
        { stdio: "pipe" },
      );
      execSync("git push origin main --quiet", { stdio: "pipe" });

      console.log(`   ✅ Pushed team reference fixes to main`);
    } finally {
      process.chdir(originalDir);
      execSync(`rm -rf ${tempDir}`, { stdio: "pipe" });
    }
  } catch (err) {
    console.error(`   ❌ Failed to fix team names: ${err.message}`);
    throw err;
  }
}

/**
 * Main execution
 */
async function main() {
  console.log(`📦 Adopting repository: ${ORG}/${repoName}`);
  console.log("");

  // Verify the repo exists
  try {
    execSync(`gh api /repos/${ORG}/${repoName} --jq .name`, { stdio: "pipe" });
  } catch (err) {
    console.error(`❌ Repository ${ORG}/${repoName} does not exist`);
    process.exit(1);
  }

  await ensureDefaultBranch(repoName);
  await enableGitHubActions(repoName);
  await fixTeamNames(repoName);

  console.log("");
  console.log(`✅ Repository ${ORG}/${repoName} adopted successfully`);
}

main().catch((err) => {
  console.error(`❌ Adoption failed: ${err.message}`);
  process.exit(1);
});
