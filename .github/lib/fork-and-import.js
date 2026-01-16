/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * Fork and Import Script
 *
 * Automates the process of creating independent GitHub repositories in cdktn-io org
 * from archived cdktf org repositories. Preserves complete git history using
 * bare clone + mirror push strategy.
 *
 * Creates truly independent repositories (NOT GitHub forks) to avoid:
 * - Pull requests defaulting to archived upstream
 * - Fork network limitations (one fork per user)
 * - Contribution graph visibility issues
 * - Search discoverability problems
 *
 * See plans/fork-vs-new.md for detailed rationale.
 *
 * Usage:
 *   node fork-and-import.js <stack-dir>                 # Dry-run mode (default)
 *   node fork-and-import.js <stack-dir> --yes            # Execute migration
 *   node fork-and-import.js <stack-dir> --yes --adopt    # Adopt repos migrated via GitHub Importer
 *
 * Example:
 *   node .github/lib/fork-and-import.js cdktf.out/stacks/repos
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = !args.includes("--yes");
const adopt = args.includes("--adopt");
const stackDir = args.find((arg) => !arg.startsWith("--"));

// Parse filtering flags
const onlyFlag = args.find((arg) => arg.startsWith("--only="));
const excludeFlag = args.find((arg) => arg.startsWith("--exclude="));

const onlyRepos = onlyFlag
  ? onlyFlag
      .split("=")[1]
      .split(",")
      .map((s) => s.trim())
  : null;
const excludeRepos = excludeFlag
  ? excludeFlag
      .split("=")[1]
      .split(",")
      .map((s) => s.trim())
  : [];

if (!stackDir) {
  console.error("Usage: node fork-and-import.js <stack-dir> [options]");
  console.error("");
  console.error("Options:");
  console.error(
    "  --yes                    Execute migration (default: dry-run)",
  );
  console.error("  --only=repo1,repo2       Only process these repos");
  console.error("  --exclude=repo1,repo2    Exclude these repos");
  console.error("");
  console.error("Example:");
  console.error(
    "  node fork-and-import.js cdktf.out/stacks/repos --only=cdktn-provider-project --yes",
  );
  process.exit(1);
}

// Validate mutually exclusive flags
if (onlyRepos && excludeRepos.length > 0) {
  console.error("❌ Error: --only and --exclude cannot be used together");
  process.exit(1);
}

// Verify stack directory exists
if (!fs.existsSync(stackDir)) {
  console.error(`❌ Error: Stack directory does not exist: ${stackDir}`);
  process.exit(1);
}

const cdkTfJsonPath = path.join(stackDir, "cdk.tf.json");
if (!fs.existsSync(cdkTfJsonPath)) {
  console.error(`❌ Error: cdk.tf.json not found in ${stackDir}`);
  console.error('   Make sure you run "yarn synth" first.');
  process.exit(1);
}

/**
 * Convert target repo name (cdktn-*) to source repo name (cdktf-*)
 * The repos in the cdktf org use "cdktf" prefix, not "cdktn"
 */
function getSourceRepoName(targetRepoName) {
  // Convert cdktn-provider-* to cdktf-provider-*
  // Convert cdktn-repository-manager to cdktf-repository-manager
  // etc.
  return targetRepoName.replace(/^cdktn-/, "cdktf-");
}

/**
 * Parse cdk.tf.json to extract repository resources
 */
function parseCdkTfJson(cdkTfJson) {
  const repos = [];
  const githubRepos = cdkTfJson.resource?.github_repository || {};

  for (const [resourceName, config] of Object.entries(githubRepos)) {
    const targetName = config.name; // e.g., "cdktn-provider-aws"
    const sourceName = getSourceRepoName(targetName); // e.g., "cdktf-provider-aws"

    repos.push({
      resourceName, // e.g., "cdktn-provider-aws_repo_45EAAAF4"
      name: targetName, // Target name in cdktn-io org
      sourceName: sourceName, // Source name in cdktf org
    });
  }

  return repos;
}

/**
 * Filter repositories based on --only or --exclude flags
 * @param {Array} repos - List of repository objects
 * @param {Array|null} onlyRepos - Only include these repos (null = all)
 * @param {Array} excludeRepos - Exclude these repos (empty = none)
 */
function filterRepositories(repos, onlyRepos, excludeRepos) {
  let filtered = repos;

  // Apply --only filter (whitelist)
  if (onlyRepos && onlyRepos.length > 0) {
    filtered = filtered.filter((repo) => onlyRepos.includes(repo.name));

    // Warn about repos not found
    const foundNames = filtered.map((r) => r.name);
    const notFound = onlyRepos.filter((name) => !foundNames.includes(name));
    if (notFound.length > 0) {
      console.warn(
        `⚠️  Warning: The following repos were not found in stack: ${notFound.join(", ")}`,
      );
    }
  }

  // Apply --exclude filter (blacklist)
  if (excludeRepos && excludeRepos.length > 0) {
    filtered = filtered.filter((repo) => !excludeRepos.includes(repo.name));
  }

  return filtered;
}

/**
 * Check if repo exists in source org (cdktf)
 * @param {string} sourceRepoName - The repo name in the cdktf org (e.g., "cdktf-provider-aws")
 */
function checkSourceRepo(sourceRepoName) {
  try {
    execSync(`gh api /repos/cdktf/${sourceRepoName} --silent`, {
      stdio: "pipe",
    });
    console.log(`   ✅ Found in cdktf org (${sourceRepoName})`);
    return true;
  } catch (err) {
    console.log(`   ⚠️  NOT found in cdktf org (will create fresh)`);
    return false;
  }
}

/**
 * Check if repo exists in target org (cdktn-io)
 */
function checkTargetRepo(repoName) {
  try {
    execSync(`gh api /repos/cdktn-io/${repoName} --silent`, { stdio: "pipe" });
    console.log(`   ❌ EXISTS in cdktn-io org (conflict!)`);
    return true;
  } catch (err) {
    console.log(`   ✅ Not in cdktn-io org (good)`);
    return false;
  }
}

/**
 * Create an empty repository in cdktn-io org
 * @param {string} targetRepoName - The desired repo name (e.g., "cdktn-provider-aws")
 * @returns {Promise<boolean>} Success status
 */
async function createEmptyRepository(targetRepoName) {
  try {
    console.log(`   🔨 Creating empty repository...`);

    // Create public repository in cdktn-io org
    execSync(`gh repo create cdktn-io/${targetRepoName} --public`, {
      stdio: "pipe",
    });

    // Poll until accessible (max 10 attempts = 20 seconds)
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      try {
        execSync(`gh api /repos/cdktn-io/${targetRepoName} --silent`, {
          stdio: "pipe",
        });
        console.log(`   ✅ Repository created: cdktn-io/${targetRepoName}`);
        return true;
      } catch {
        process.stdout.write(".");
        await new Promise((resolve) => setTimeout(resolve, 2000));
        attempts++;
      }
    }

    throw new Error(
      `Repository creation timeout after ${maxAttempts * 2} seconds`,
    );
  } catch (err) {
    console.error(`   ❌ Failed to create repository: ${err.message}`);
    throw err;
  }
}

/**
 * Disable GitHub Actions on a repository
 * Prevents workflows from running during migration setup
 * @param {string} targetRepoName - The repo name (e.g., "cdktn-provider-aws")
 */
async function disableGitHubActions(targetRepoName) {
  try {
    console.log(`   🔒 Disabling GitHub Actions...`);
    execSync(
      `echo '{"enabled":false}' | gh api -X PUT /repos/cdktn-io/${targetRepoName}/actions/permissions --input -`,
      { stdio: "pipe", shell: "/bin/bash" },
    );
    console.log(`   ✅ Actions disabled`);
  } catch (err) {
    console.error(`   ⚠️  Failed to disable Actions: ${err.message}`);
    // Don't fail the migration, just warn
  }
}

/**
 * Re-enable GitHub Actions on a repository
 * Called after migration and team name fixes are complete
 * @param {string} targetRepoName - The repo name (e.g., "cdktn-provider-aws")
 */
async function enableGitHubActions(targetRepoName) {
  try {
    console.log(`   🔓 Re-enabling GitHub Actions...`);
    execSync(
      `echo '{"enabled":true,"allowed_actions":"all"}' | gh api -X PUT /repos/cdktn-io/${targetRepoName}/actions/permissions --input -`,
      { stdio: "pipe", shell: "/bin/bash" },
    );
    console.log(`   ✅ Actions re-enabled`);
  } catch (err) {
    console.error(`   ⚠️  Failed to re-enable Actions: ${err.message}`);
    // Don't fail the migration, just warn
  }
}

/**
 * Enable GitHub Actions to approve pull requests
 * This setting is not available in Terraform GitHub provider
 * See: https://github.com/integrations/terraform-provider-github/issues/1228
 * @param {string} targetRepoName - The repo name (e.g., "cdktn-provider-aws")
 */
async function enableActionsToApprovePRs(targetRepoName) {
  try {
    console.log(`   🔐 Enabling Actions to approve PRs...`);
    execSync(
      `echo '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":true}' | gh api -X PUT /repos/cdktn-io/${targetRepoName}/actions/permissions/workflow --input -`,
      { stdio: "pipe", shell: "/bin/bash" },
    );
    console.log(`   ✅ Actions can now approve PRs`);
  } catch (err) {
    console.error(`   ⚠️  Failed to enable PR approvals: ${err.message}`);
    // Don't fail the migration, just warn
  }
}

/**
 * Clone source repository and push all history to target repository
 * Uses bare clone + mirror push to preserve all branches, tags, and refs
 *
 * @param {string} sourceRepoName - Source repo in cdktf org (e.g., "cdktf-provider-aws")
 * @param {string} targetRepoName - Target repo in cdktn-io org (e.g., "cdktn-provider-aws")
 */
async function migrateRepositoryHistory(sourceRepoName, targetRepoName) {
  // Use /var/tmp instead of /tmp to avoid tmpfs space limits
  // /var/tmp uses the root filesystem which has more space
  const tempDir = execSync("mktemp -d -p /var/tmp").toString().trim();
  const originalDir = process.cwd();

  try {
    console.log(`   📥 Cloning source repository...`);

    // Bare clone captures all refs (branches, tags, etc.)
    process.chdir(tempDir);
    execSync(
      `git clone --bare https://github.com/cdktf/${sourceRepoName}.git repo.git`,
      { stdio: "inherit" },
    );

    // Enter bare repo directory
    process.chdir("repo.git");

    console.log(`   🔄 Pushing all history to new repository...`);

    // Use SSH for pushing - more reliable for large repos (no HTTP timeouts)
    // Requires: gh ssh-key add ~/.ssh/id_ed25519.pub (or similar)
    const useSSH =
      process.env.USE_SSH === "1" || process.env.USE_SSH === "true";

    let remoteUrl;
    if (useSSH) {
      remoteUrl = `git@github.com:cdktn-io/${targetRepoName}.git`;
      console.log(`   🔑 Using SSH for push (more reliable for large repos)`);
    } else {
      // Get GitHub token from environment
      const githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (!githubToken) {
        throw new Error(
          "GITHUB_TOKEN or GH_TOKEN environment variable is required (or set USE_SSH=1)",
        );
      }
      remoteUrl = `https://x-access-token:${githubToken}@github.com/cdktn-io/${targetRepoName}.git`;
    }

    execSync(`git remote add cdktn-io "${remoteUrl}"`, { stdio: "pipe" });

    // Configure git for large repository pushes
    execSync("git config http.postBuffer 524288000", { stdio: "pipe" }); // 500 MB
    execSync("git config http.lowSpeedTime 999999", { stdio: "pipe" }); // Very long timeout
    // execSync('git config pack.windowMemory 256m', { stdio: 'pipe' }); // Limit memory for packing
    // execSync('git config pack.threads 4', { stdio: 'pipe' }); // Limit threads

    // Get all refs to push
    const allRefs = execSync("git show-ref", { encoding: "utf-8" })
      .trim()
      .split("\n")
      .map((line) => line.split(" ")[1]); // Extract ref names

    // Separate branches and tags
    const branches = allRefs.filter((ref) => ref.startsWith("refs/heads/"));
    const tags = allRefs.filter((ref) => ref.startsWith("refs/tags/"));
    const other = allRefs.filter(
      (ref) => !ref.startsWith("refs/heads/") && !ref.startsWith("refs/tags/"),
    );

    console.log(
      `   📊 Found ${branches.length} branches, ${tags.length} tags, ${other.length} other refs`,
    );

    // Helper function to push with retry
    const pushWithRetry = (refs, description, maxRetries = 3) => {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          execSync(`git push cdktn-io ${refs.join(" ")}`, { stdio: "inherit" });
          return; // Success
        } catch (err) {
          if (attempt === maxRetries) {
            throw err;
          }
          console.log(
            `   ⚠️  Push failed (attempt ${attempt}/${maxRetries}), retrying in 5s...`,
          );
          execSync("sleep 5");
        }
      }
    };

    // For large repos, we must push ONE REF AT A TIME to avoid GitHub's 2GB pack limit
    // After the first push, subsequent pushes only send delta objects (much smaller)

    // Push main branch first (contains most objects - this is the big one)
    const mainBranch = branches.find(
      (b) => b === "refs/heads/main" || b === "refs/heads/master",
    );
    if (mainBranch) {
      console.log(
        `   ⬆️  Pushing ${mainBranch.replace("refs/heads/", "")} branch (this is the big one, may take a while)...`,
      );
      pushWithRetry([mainBranch], "main branch");
      console.log(
        `   ✅ Main branch pushed - subsequent pushes will be much faster (delta only)`,
      );
    }

    // Push other branches ONE AT A TIME
    const otherBranches = branches.filter((b) => b !== mainBranch);
    if (otherBranches.length > 0) {
      console.log(
        `   ⬆️  Pushing ${otherBranches.length} other branches (one at a time)...`,
      );
      for (let i = 0; i < otherBranches.length; i++) {
        const branch = otherBranches[i];
        const branchName = branch.replace("refs/heads/", "");
        process.stdout.write(
          `   📦 Branch ${i + 1}/${otherBranches.length}: ${branchName}...`,
        );
        try {
          execSync(`git push cdktn-io ${branch}`, { stdio: "inherit" });
          console.log(" ✓");
        } catch (err) {
          console.log(" ✗ (will retry)");
          pushWithRetry([branch], branchName);
        }
      }
    }

    // Push tags ONE AT A TIME to avoid 2GB pack limit
    // After main is pushed, each tag only sends its unique objects (small delta)
    if (tags.length > 0) {
      console.log(
        `   ⬆️  Pushing ${tags.length} tags (one at a time for large repo compatibility)...`,
      );
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        const tagName = tag.replace("refs/tags/", "");

        // Show progress every 10 tags or on specific milestones
        if (i % 10 === 0 || i === tags.length - 1) {
          process.stdout.write(
            `\r   📦 Tags: ${i + 1}/${tags.length} (${successCount} ok, ${failCount} failed)`,
          );
        }

        try {
          execSync(`git push cdktn-io ${tag}`, { stdio: "inherit" });
          successCount++;
        } catch (err) {
          // Retry once
          try {
            execSync("sleep 1");
            execSync(`git push cdktn-io ${tag}`, { stdio: "inherit" });
            successCount++;
          } catch (retryErr) {
            failCount++;
            // Log failed tags for manual retry
            console.log(`\n   ⚠️  Failed to push tag: ${tagName}`);
          }
        }
      }
      console.log(
        `\n   ✅ Tags complete: ${successCount} pushed, ${failCount} failed`,
      );
    }

    // Push other refs ONE AT A TIME
    if (other.length > 0) {
      console.log(
        `   ⬆️  Pushing ${other.length} other refs (one at a time)...`,
      );
      for (const ref of other) {
        try {
          execSync(`git push cdktn-io ${ref}`, { stdio: "inherit" });
        } catch (err) {
          console.log(`   ⚠️  Failed to push: ${ref}`);
        }
      }
    }

    console.log(`   ✅ History migration complete`);
  } catch (err) {
    console.error(`   ❌ History migration failed: ${err.message}`);
    console.error(`   📁 Temp directory preserved for debugging: ${tempDir}`);
    console.error(`   💡 You can retry manually:`);
    console.error(`      cd ${tempDir}/repo.git`);
    console.error(`      git push cdktn-io --all`);
    console.error(`      git push cdktn-io --tags`);
    // Don't cleanup temp dir on error - preserve for manual retry
    process.chdir(originalDir);
    throw err;
  }

  // Only cleanup on success
  process.chdir(originalDir);
  execSync(`rm -rf ${tempDir}`, { stdio: "pipe" });
}

/**
 * Create independent repository and migrate full history
 * This creates a new repository (not a GitHub fork) and pushes complete history
 *
 * @param {string} sourceRepoName - Source repo in cdktf org
 * @param {string} targetRepoName - Target repo in cdktn-io org
 */
async function createIndependentRepository(sourceRepoName, targetRepoName) {
  let repoCreated = false;

  try {
    console.log(`   🚀 Creating independent repository...`);

    // Step 1: Create empty repo in cdktn-io org
    await createEmptyRepository(targetRepoName);
    repoCreated = true;

    // Step 2: Disable GitHub Actions to prevent workflows from running during setup
    // This matches fork behavior where actions are disabled by default
    await disableGitHubActions(targetRepoName);

    // Step 3: Clone source and push all history
    await migrateRepositoryHistory(sourceRepoName, targetRepoName);

    console.log(`   ✅ Independent repository created successfully`);
    return true;
  } catch (err) {
    console.error(`   ❌ Failed: ${err.message}`);

    if (repoCreated) {
      // Don't auto-delete! The push might have partially succeeded
      // Check if the repo has any content before deciding
      console.log(`   🔍 Checking if repository has content...`);
      try {
        const branchCount = execSync(
          `gh api /repos/cdktn-io/${targetRepoName}/branches --jq 'length'`,
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        ).trim();

        if (branchCount && parseInt(branchCount) > 0) {
          console.log(
            `   ⚠️  Repository has ${branchCount} branches - data may have been pushed!`,
          );
          console.log(
            `   💡 Check the repo: https://github.com/cdktn-io/${targetRepoName}`,
          );
          console.log(
            `   💡 If incomplete, delete manually: gh repo delete cdktn-io/${targetRepoName} --yes`,
          );
        } else {
          console.log(`   📭 Repository is empty - cleaning up...`);
          execSync(`gh repo delete cdktn-io/${targetRepoName} --yes`, {
            stdio: "pipe",
          });
          console.log(`   🧹 Cleaned up empty repository`);
        }
      } catch (checkErr) {
        console.log(
          `   ⚠️  Could not check repo state. Manual cleanup may be needed:`,
        );
        console.log(`      gh repo delete cdktn-io/${targetRepoName} --yes`);
      }
    }

    throw err;
  }
}

/**
 * Fix team names and email addresses in workflow files after creating independent repository
 * @param {string} repoName - The repository name (e.g., "cdktn-provider-http")
 */
async function fixTeamNames(repoName) {
  const OLD_TEAM = "team-tf-cdk";
  const OLD_EMAIL = "github-team-tf-cdk@hashicorp.com";

  const NEW_TEAM = "team-cdk-terrain[bot]";
  // `gh api /users/${NEW_TEAM} --jq .id`
  const APP_USER_ID = "254218809"; // HARDCODED FOR NOW
  const NEW_EMAIL = `<${APP_USER_ID}-${NEW_TEAM}@users.noreply.github.com>`;

  try {
    console.log(`   🔧 Fixing team references...`);

    // Create temp directory (use /var/tmp to avoid tmpfs space limits)
    const tempDir = execSync("mktemp -d -p /var/tmp").toString().trim();
    const originalDir = process.cwd();

    try {
      // Shallow clone - we only need latest files to fix team names, not history
      process.chdir(tempDir);
      execSync(`gh repo clone cdktn-io/${repoName} . -- --depth 1 --quiet`, {
        stdio: "pipe",
      });
      let filesChanged = 0;

      // update CODEOWNERS (skip on any error)
      const codeOwnersFile = ".github/CODEOWNERS";
      try {
        const content = fs.readFileSync(codeOwnersFile, "utf8");
        let newContent = content.replaceAll(
          "@cdktf/tf-cdk-team",
          "@cdktn-io/team-cdk-terrain",
        );
        fs.writeFileSync(codeOwnersFile, newContent);
        filesChanged++;
        console.log(`   ✅  Updated CODEOWNERS`);
      } catch (err) {
        console.log(`   ⏭️  Skipped CODEOWNERS`);
      }

      // Check if any workflow files need updating
      const workflowFiles = execSync(
        'find .github/workflows -name "*.yml" 2>/dev/null || true',
      )
        .toString()
        .trim()
        .split("\n")
        .filter((f) => f);

      if (workflowFiles.length === 0) {
        console.log(`   ⏭️  No workflow files to update`);
        return;
      }

      for (const file of workflowFiles) {
        try {
          const content = fs.readFileSync(file, "utf8");
          if (content.includes(OLD_TEAM) || content.includes(OLD_EMAIL)) {
            let newContent = content
              .replaceAll(OLD_TEAM, NEW_TEAM)
              .replaceAll(OLD_EMAIL, NEW_EMAIL);

            fs.writeFileSync(file, newContent);
            filesChanged++;
          }
        } catch (err) {
          // Skip files we can't read/write
        }
      }

      if (filesChanged === 0) {
        console.log(`   ⏭️  No changes needed`);
        return;
      }

      console.log(`   ✓ Updated ${filesChanged} workflow files`);

      // Commit and push
      execSync(`git config user.name "${NEW_TEAM}"`, { stdio: "pipe" });
      execSync(`git config user.email "${NEW_EMAIL}"`, { stdio: "pipe" });
      execSync("git add .github/workflows/*.yml", { stdio: "pipe" });
      execSync(
        `git commit -m "fix: update team references from ${OLD_TEAM} to ${NEW_TEAM}" --quiet`,
        { stdio: "pipe" },
      );
      execSync("git push origin main --quiet", { stdio: "pipe" });

      console.log(`   ✅ Pushed team reference fixes to main`);
    } finally {
      // Cleanup
      process.chdir(originalDir);
      execSync(`rm -rf ${tempDir}`, { stdio: "pipe" });
    }
  } catch (err) {
    console.error(`   ⚠️  Failed to fix team names: ${err.message}`);
    // Don't fail the whole process, team names can be fixed later
  }
}

/**
 * Generate Terraform target flags for filtered repositories
 * Scans all resource types in cdk.tf.json and finds resources matching filtered repo names
 * @param {Object} cdkTfJson - The parsed cdk.tf.json content
 * @param {Array} filteredRepos - List of filtered repository objects with 'name' property
 * @returns {Array} Array of terraform target flags (e.g., ['-target=github_repository.cdktn-provider-project_repo_*'])
 */
function generateTerraformTargets(cdkTfJson, filteredRepos) {
  const targets = [];
  const repoNames = filteredRepos.map((r) => r.name);

  // Iterate through all resource types in the Terraform configuration
  const resources = cdkTfJson.resource || {};

  for (const [resourceType, resourceInstances] of Object.entries(resources)) {
    // For each resource instance of this type
    for (const [resourceName, resourceConfig] of Object.entries(
      resourceInstances,
    )) {
      // Check if this resource belongs to any of the filtered repos
      // Resource names typically follow pattern: <repo-name>_<resource-type>_<hash>
      // e.g., "cdktn-provider-project_repo_11A4EE37"
      //       "cdktn-provider-project_webhook_ABC123"
      //       "cdktn-provider-project_secret_npm_token_DEF456"

      const matchesFilteredRepo = repoNames.some((repoName) =>
        resourceName.startsWith(`${repoName}_`),
      );

      if (matchesFilteredRepo) {
        targets.push(`-target=${resourceType}.${resourceName}`);
      }
    }
  }

  return targets;
}

/**
 * Generate import.tf content
 */
function generateImportBlocks(repos) {
  const blocks = [];

  blocks.push("# Generated by fork-and-import.js");
  blocks.push(`# Generated at: ${new Date().toISOString()}`);
  blocks.push("# Import blocks for forked GitHub repositories");
  blocks.push("");
  blocks.push(
    "# Only repository resources are imported. Other resources (labels, webhooks, etc.)",
  );
  blocks.push(
    "# will be created fresh by Terraform, which is acceptable for settings.",
  );
  blocks.push("");

  for (const repo of repos) {
    if (repo.action === "fork" || repo.action === "adopt") {
      blocks.push("import {");
      blocks.push(`  to = github_repository.${repo.resourceName}`);
      blocks.push(`  id = "${repo.name}"`);
      blocks.push("}");
      blocks.push("");
    }
  }

  // Add a note about repos that will be created fresh
  const freshRepos = repos.filter((r) => r.action === "create-fresh");
  if (freshRepos.length > 0) {
    blocks.push(
      "# The following repositories will be created fresh (not imported):",
    );
    for (const repo of freshRepos) {
      blocks.push(`#   - ${repo.name}`);
    }
    blocks.push("");
  }

  return blocks.join("\n");
}

/**
 * Main execution flow
 */
async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Fork and Import Script for CDKTN Repository Manager     ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  console.log(
    `🔍 Mode: ${dryRun ? "DRY-RUN (no changes will be made)" : "EXECUTE (will migrate repos)"}`,
  );
  console.log(`📁 Stack: ${stackDir}`);
  console.log("");

  // 1. Parse cdk.tf.json
  console.log("📖 Reading Terraform configuration...");
  const cdkTfJson = JSON.parse(fs.readFileSync(cdkTfJsonPath, "utf-8"));
  const repos = parseCdkTfJson(cdkTfJson);
  console.log(`   Found ${repos.length} repository resources`);

  // Apply filtering
  const filteredRepos = filterRepositories(repos, onlyRepos, excludeRepos);

  if (onlyRepos) {
    console.log(
      `   Filtered to ${filteredRepos.length} repos (--only=${onlyRepos.join(",")})`,
    );
  } else if (excludeRepos.length > 0) {
    console.log(
      `   Filtered to ${filteredRepos.length} repos (--exclude=${excludeRepos.join(",")})`,
    );
  }

  console.log("");

  if (filteredRepos.length === 0) {
    console.log("⚠️  No repositories match the filter criteria");
    process.exit(0);
  }

  // 2. Check source and target repos
  console.log("🔍 Checking repository status...");
  console.log("");

  const results = [];
  let hasConflicts = false;

  for (const repo of filteredRepos) {
    console.log(`📦 ${repo.name}`);
    if (repo.sourceName !== repo.name) {
      console.log(`   Source: cdktf/${repo.sourceName}`);
    }

    // Check if exists in cdktf org (using source name)
    const sourceExists = checkSourceRepo(repo.sourceName);

    // Check if already exists in cdktn-io org (using target name)
    const targetExists = checkTargetRepo(repo.name);

    if (targetExists) {
      if (adopt) {
        console.log(`   ✅ Found in cdktn-io org (will adopt)`);
      } else {
        hasConflicts = true;
        console.error(`   💥 CONFLICT: Delete it manually to re-fork`);
      }
    }

    results.push({
      ...repo,
      sourceExists,
      targetExists,
      action: adopt && targetExists ? "adopt" : sourceExists ? "fork" : "create-fresh",
    });

    console.log("");
  }

  // Exit if conflicts found
  if (hasConflicts) {
    console.error(
      "❌ ERROR: One or more repositories already exist in cdktn-io org",
    );
    console.error("");
    console.error("To resolve:");
    console.error("  1. Delete conflicting repos manually:");
    console.error("     gh repo delete cdktn-io/<repo-name>");
    console.error("  2. Or rename them if you want to keep them");
    console.error("  3. Then run this script again");
    process.exit(1);
  }

  // 3. Create independent repositories or adopt existing ones (only if --yes flag)
  if (!dryRun) {
    // Handle adopt mode - repos already exist via GitHub Importer
    const toAdopt = results.filter((r) => r.action === "adopt");

    if (toAdopt.length > 0) {
      console.log("🔗 Adopting repositories migrated via GitHub Importer...");
      console.log("");

      for (let i = 0; i < toAdopt.length; i++) {
        const repo = toAdopt[i];
        console.log(`[${i + 1}/${toAdopt.length}] ${repo.name}`);

        try {
          // Fix team names in workflow files
          await fixTeamNames(repo.name);

          // Enable GitHub Actions (may be disabled by importer)
          await enableGitHubActions(repo.name);

          // Enable Actions to approve PRs
          await enableActionsToApprovePRs(repo.name);

          // Add delay between repos to avoid rate limiting
          if (i < toAdopt.length - 1) {
            console.log(`   ⏸️  Waiting 2 seconds before next repository...`);
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        } catch (err) {
          console.error(`   ❌ Adopt failed: ${err.message}`);
          // Continue with next repo instead of aborting
        }

        console.log("");
      }
    }

    // Handle fork mode - create new repos with history migration
    const toFork = results.filter((r) => r.action === "fork");

    if (toFork.length === 0 && toAdopt.length === 0) {
      console.log("ℹ️  No repositories to migrate (all will be created fresh)");
    } else if (toFork.length > 0) {
      console.log("🚀 Creating independent repositories with full history...");
      console.log("");

      for (let i = 0; i < toFork.length; i++) {
        const repo = toFork[i];
        console.log(`[${i + 1}/${toFork.length}] ${repo.name}`);

        try {
          // Create independent repository (not a fork!)
          // This also disables GitHub Actions to prevent workflows from running during setup
          await createIndependentRepository(repo.sourceName, repo.name);

          // Fix team names in workflow files
          // NOTE: No branch protection exists yet on new repos
          await fixTeamNames(repo.name);

          // Re-enable GitHub Actions now that setup is complete
          // This allows the migrate-provider workflow to auto-approve
          await enableGitHubActions(repo.name);

          // Add delay between repos to avoid rate limiting
          if (i < toFork.length - 1) {
            console.log(`   ⏸️  Waiting 5 seconds before next repository...`);
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        } catch (err) {
          console.error(`   ❌ Migration failed: ${err.message}`);
          console.error("");
          console.error("Aborting. You may need to:");
          console.error(
            "  1. Check your GitHub token has repo, workflow and admin:org scopes",
          );
          console.error("  2. Verify the source repo exists and is accessible");
          console.error("  3. Check GitHub API rate limits");
          console.error(
            "  4. If repo was partially created, delete it: gh repo delete cdktn-io/" +
              repo.name,
          );
          process.exit(1);
        }

        console.log("");
      }
    }
  }

  // 4. Generate import.tf
  const importBlocks = generateImportBlocks(results);
  const importPath = path.join(stackDir, "import.tf");
  fs.writeFileSync(importPath, importBlocks);

  // 5. Summary
  console.log("");
  console.log("═".repeat(60));
  console.log("📊 Summary");
  console.log("═".repeat(60));

  const toAdoptCount = results.filter((r) => r.action === "adopt").length;
  const toForkCount = results.filter((r) => r.action === "fork").length;
  const toCreate = results.filter((r) => r.action === "create-fresh").length;

  if (toAdoptCount > 0) {
    console.log(`   Repositories to adopt:     ${toAdoptCount}`);
  }
  if (toForkCount > 0) {
    console.log(`   Repositories to migrate:   ${toForkCount}`);
  }
  if (toCreate > 0) {
    console.log(`   Repositories to create:    ${toCreate}`);
  }
  console.log(`   Total (filtered):          ${results.length}`);

  // Show filtering info
  if (onlyRepos) {
    console.log(`   Filter: --only=${onlyRepos.join(",")}`);
  } else if (excludeRepos.length > 0) {
    console.log(`   Filter: --exclude=${excludeRepos.join(",")}`);
  }

  console.log("");
  console.log(`📝 Generated: ${importPath}`);
  console.log("");

  if (dryRun) {
    console.log("⚠️  DRY-RUN MODE: No repos were migrated.");
    console.log("");
    console.log("Next steps:");
    console.log(`  1. Review the generated import.tf file:`);
    console.log(`     cat ${importPath}`);
    console.log("");
    console.log("  2. If everything looks good, run with --yes flag:");
    console.log(`     node .github/lib/fork-and-import.js ${stackDir} --yes`);
  } else {
    console.log("✅ Migration completed successfully!");
    console.log("");
    console.log("Next steps:");
    console.log(`  1. cd ${stackDir}`);
    console.log("  2. terraform plan  # Verify imports");

    // Add -target flags if filtering is used
    if (onlyRepos || excludeRepos.length > 0) {
      console.log("");
      console.log(
        "💡 To apply only the filtered repositories, use -target flags:",
      );

      // Generate comprehensive target flags for all related resources
      const targetFlags = generateTerraformTargets(cdkTfJson, filteredRepos);

      if (targetFlags.length > 0) {
        // Format for display (wrap long lines)
        const formattedTargets = targetFlags.join(" \\\n      ");
        console.log(`     terraform apply \\`);
        console.log(`      ${formattedTargets}`);
      } else {
        console.log("     (No matching resources found for filtering)");
      }

      console.log("");
      console.log("   Or apply all changes (including related resources):");
    }

    console.log("  3. terraform apply # Import into state");
    console.log("  4. rm import.tf    # Clean up after import");
    console.log("");
    console.log("🔄 Migrate providers to @cdktn scope:");
    console.log("");
    console.log(
      "After Terraform import completes, trigger the migrate-provider workflow",
    );
    console.log("for each repository to create PRs that:");
    console.log("  - Update .projenrc.js to use @cdktn/provider-project");
    console.log("  - Remove isDeprecated flag");
    console.log("  - Regenerate all files with projen");
    console.log("");

    // Get list of provider names (without -go suffix)
    const providerNames = new Set();
    for (const repo of results.filter((r) => r.action === "fork" || r.action === "adopt")) {
      // Extract provider name: cdktn-provider-aws -> aws, cdktn-provider-aws-go -> skip
      if (!repo.name.endsWith("-go")) {
        const match = repo.name.match(/^cdktn-provider-(.+)$/);
        if (match) {
          providerNames.add(match[1]);
        }
      }
    }

    if (providerNames.size > 0) {
      console.log(
        "Step 5: Trigger migrate-provider workflows (one command per provider):",
      );
      console.log("");
      for (const provider of Array.from(providerNames).sort()) {
        console.log(
          `  gh workflow run migrate-provider.yml -f provider=${provider}`,
        );
      }
      console.log("");
      console.log("Or use a loop to trigger all:");
      console.log(
        "  for provider in " +
          Array.from(providerNames).sort().join(" ") +
          "; do",
      );
      console.log(
        "    gh workflow run migrate-provider.yml -f provider=$provider",
      );
      console.log("    sleep 2");
      console.log("  done");
      console.log("");
      console.log("Step 6: Wait for migration PRs to be created and merged");
      console.log("  - PRs should be auto-approved and auto-merged");
      console.log(
        "  - Check PR status: gh pr list -R cdktn-io/cdktn-provider-<name>",
      );
      console.log("");
      console.log(
        "✅ GitHub Actions and PR approval permissions have been configured at org level.",
      );
      console.log("");
      console.log(
        "💡 Note: Migration uses GitHub App token (team-cdk-terrain[bot])",
      );
      console.log(
        "   Make sure GH_APP_ID and GH_APP_PRIVATE_KEY secrets are set.",
      );
    }
  }
}

// Run main function
main().catch((err) => {
  console.error("");
  console.error("❌ Unexpected error:", err.message);
  console.error(err.stack);
  process.exit(1);
});
