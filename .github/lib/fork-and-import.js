/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * Fork and Import Script
 *
 * Automates the process of forking GitHub repositories from the cdktf org
 * to the cdktn-io org and generating Terraform import blocks.
 *
 * Usage:
 *   node fork-and-import.js <stack-dir>         # Dry-run mode (default)
 *   node fork-and-import.js <stack-dir> --yes   # Execute forks
 *
 * Example:
 *   node .github/lib/fork-and-import.js cdktf.out/stacks/repos
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = !args.includes('--yes');
const stackDir = args.find(arg => !arg.startsWith('--'));

// Parse filtering flags
const onlyFlag = args.find(arg => arg.startsWith('--only='));
const excludeFlag = args.find(arg => arg.startsWith('--exclude='));

const onlyRepos = onlyFlag ? onlyFlag.split('=')[1].split(',').map(s => s.trim()) : null;
const excludeRepos = excludeFlag ? excludeFlag.split('=')[1].split(',').map(s => s.trim()) : [];

if (!stackDir) {
  console.error('Usage: node fork-and-import.js <stack-dir> [options]');
  console.error('');
  console.error('Options:');
  console.error('  --yes                    Execute forks (default: dry-run)');
  console.error('  --only=repo1,repo2       Only process these repos');
  console.error('  --exclude=repo1,repo2    Exclude these repos');
  console.error('');
  console.error('Example:');
  console.error('  node fork-and-import.js cdktf.out/stacks/repos --only=cdktn-provider-project --yes');
  process.exit(1);
}

// Validate mutually exclusive flags
if (onlyRepos && excludeRepos.length > 0) {
  console.error('❌ Error: --only and --exclude cannot be used together');
  process.exit(1);
}

// Verify stack directory exists
if (!fs.existsSync(stackDir)) {
  console.error(`❌ Error: Stack directory does not exist: ${stackDir}`);
  process.exit(1);
}

const cdkTfJsonPath = path.join(stackDir, 'cdk.tf.json');
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
  return targetRepoName.replace(/^cdktn-/, 'cdktf-');
}

/**
 * Parse cdk.tf.json to extract repository resources
 */
function parseCdkTfJson(cdkTfJson) {
  const repos = [];
  const githubRepos = cdkTfJson.resource?.github_repository || {};

  for (const [resourceName, config] of Object.entries(githubRepos)) {
    const targetName = config.name;  // e.g., "cdktn-provider-aws"
    const sourceName = getSourceRepoName(targetName);  // e.g., "cdktf-provider-aws"

    repos.push({
      resourceName,  // e.g., "cdktn-provider-aws_repo_45EAAAF4"
      name: targetName,  // Target name in cdktn-io org
      sourceName: sourceName,  // Source name in cdktf org
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
    filtered = filtered.filter(repo => onlyRepos.includes(repo.name));

    // Warn about repos not found
    const foundNames = filtered.map(r => r.name);
    const notFound = onlyRepos.filter(name => !foundNames.includes(name));
    if (notFound.length > 0) {
      console.warn(`⚠️  Warning: The following repos were not found in stack: ${notFound.join(', ')}`);
    }
  }

  // Apply --exclude filter (blacklist)
  if (excludeRepos && excludeRepos.length > 0) {
    filtered = filtered.filter(repo => !excludeRepos.includes(repo.name));
  }

  return filtered;
}

/**
 * Check if repo exists in source org (cdktf)
 * @param {string} sourceRepoName - The repo name in the cdktf org (e.g., "cdktf-provider-aws")
 */
function checkSourceRepo(sourceRepoName) {
  try {
    execSync(`gh api /repos/cdktf/${sourceRepoName} --silent`, { stdio: 'pipe' });
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
    execSync(`gh api /repos/cdktn-io/${repoName} --silent`, { stdio: 'pipe' });
    console.log(`   ❌ EXISTS in cdktn-io org (conflict!)`);
    return true;
  } catch (err) {
    console.log(`   ✅ Not in cdktn-io org (good)`);
    return false;
  }
}

/**
 * Fork repository from cdktf to cdktn-io
 * @param {string} sourceRepoName - The repo name in cdktf org (e.g., "cdktf-provider-aws")
 * @param {string} targetRepoName - The desired repo name in cdktn-io org (e.g., "cdktn-provider-aws")
 */
async function forkRepository(sourceRepoName, targetRepoName) {
  try {
    console.log(`   🔄 Initiating fork of cdktf/${sourceRepoName}...`);

    // Initiate fork and rename it to cdktn-provider-*
    execSync(
      `gh repo fork cdktf/${sourceRepoName} --org=cdktn-io --fork-name="${targetRepoName}"`,
      { stdio: 'pipe' }
    );

    // Wait for fork to complete (poll until accessible)
    let attempts = 0;
    const maxAttempts = 30;  // Max 30 attempts (60 seconds)

    while (attempts < maxAttempts) {
      try {
        // Check if fork exists with target name
        execSync(`gh api /repos/cdktn-io/${targetRepoName} --silent`, { stdio: 'pipe' });
        console.log(`   ✅ Fork created as ${targetRepoName}`);

        // // Rename if target name is different
        // if (sourceRepoName !== targetRepoName) {
        //   console.log(`   🔄 Renaming to ${targetRepoName}...`);
        //   execSync(
        //     `gh api PATCH /repos/cdktn-io/${sourceRepoName} -f name="${targetRepoName}"`,
        //     { stdio: 'pipe' }
        //   );
        //   console.log(`   ✅ Renamed successfully`);
        // }

        return true;
      } catch {
        process.stdout.write('.');
        await new Promise(resolve => setTimeout(resolve, 2000));  // Wait 2 seconds
        attempts++;
      }
    }

    throw new Error(`Fork timeout for ${sourceRepoName} after ${maxAttempts * 2} seconds`);
  } catch (err) {
    console.error(`   ❌ Failed: ${err.message}`);
    throw err;
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
  const repoNames = filteredRepos.map(r => r.name);

  // Iterate through all resource types in the Terraform configuration
  const resources = cdkTfJson.resource || {};

  for (const [resourceType, resourceInstances] of Object.entries(resources)) {
    // For each resource instance of this type
    for (const [resourceName, resourceConfig] of Object.entries(resourceInstances)) {
      // Check if this resource belongs to any of the filtered repos
      // Resource names typically follow pattern: <repo-name>_<resource-type>_<hash>
      // e.g., "cdktn-provider-project_repo_11A4EE37"
      //       "cdktn-provider-project_webhook_ABC123"
      //       "cdktn-provider-project_secret_npm_token_DEF456"

      const matchesFilteredRepo = repoNames.some(repoName =>
        resourceName.startsWith(`${repoName}_`)
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

  blocks.push('# Generated by fork-and-import.js');
  blocks.push(`# Generated at: ${new Date().toISOString()}`);
  blocks.push('# Import blocks for forked GitHub repositories');
  blocks.push('');
  blocks.push('# Only repository resources are imported. Other resources (labels, webhooks, etc.)');
  blocks.push('# will be created fresh by Terraform, which is acceptable for settings.');
  blocks.push('');

  for (const repo of repos) {
    if (repo.action === 'fork') {
      blocks.push('import {');
      blocks.push(`  to = github_repository.${repo.resourceName}`);
      blocks.push(`  id = "${repo.name}"`);
      blocks.push('}');
      blocks.push('');
    }
  }

  // Add a note about repos that will be created fresh
  const freshRepos = repos.filter(r => r.action === 'create-fresh');
  if (freshRepos.length > 0) {
    blocks.push('# The following repositories will be created fresh (not imported):');
    for (const repo of freshRepos) {
      blocks.push(`#   - ${repo.name}`);
    }
    blocks.push('');
  }

  return blocks.join('\n');
}

/**
 * Main execution flow
 */
async function main() {
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║  Fork and Import Script for CDKTN Repository Manager     ║');
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🔍 Mode: ${dryRun ? 'DRY-RUN (no changes will be made)' : 'EXECUTE (will fork repos)'}`);
  console.log(`📁 Stack: ${stackDir}`);
  console.log('');

  // 1. Parse cdk.tf.json
  console.log('📖 Reading Terraform configuration...');
  const cdkTfJson = JSON.parse(fs.readFileSync(cdkTfJsonPath, 'utf-8'));
  const repos = parseCdkTfJson(cdkTfJson);
  console.log(`   Found ${repos.length} repository resources`);

  // Apply filtering
  const filteredRepos = filterRepositories(repos, onlyRepos, excludeRepos);

  if (onlyRepos) {
    console.log(`   Filtered to ${filteredRepos.length} repos (--only=${onlyRepos.join(',')})`);
  } else if (excludeRepos.length > 0) {
    console.log(`   Filtered to ${filteredRepos.length} repos (--exclude=${excludeRepos.join(',')})`);
  }

  console.log('');

  if (filteredRepos.length === 0) {
    console.log('⚠️  No repositories match the filter criteria');
    process.exit(0);
  }

  // 2. Check source and target repos
  console.log('🔍 Checking repository status...');
  console.log('');

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
      hasConflicts = true;
      console.error(`   💥 CONFLICT: Delete it manually to re-fork`);
    }

    results.push({
      ...repo,
      sourceExists,
      targetExists,
      action: sourceExists ? 'fork' : 'create-fresh'
    });

    console.log('');
  }

  // Exit if conflicts found
  if (hasConflicts) {
    console.error('❌ ERROR: One or more repositories already exist in cdktn-io org');
    console.error('');
    console.error('To resolve:');
    console.error('  1. Delete conflicting repos manually:');
    console.error('     gh repo delete cdktn-io/<repo-name>');
    console.error('  2. Or rename them if you want to keep them');
    console.error('  3. Then run this script again');
    process.exit(1);
  }

  // 3. Fork repos (only if --yes flag)
  if (!dryRun) {
    const toFork = results.filter(r => r.action === 'fork');

    if (toFork.length === 0) {
      console.log('ℹ️  No repositories to fork (all will be created fresh)');
    } else {
      console.log('🚀 Forking repositories...');
      console.log('');

      for (let i = 0; i < toFork.length; i++) {
        const repo = toFork[i];
        console.log(`[${i + 1}/${toFork.length}] ${repo.name}`);

        try {
          await forkRepository(repo.sourceName, repo.name);

          // Add delay between forks to avoid rate limiting
          if (i < toFork.length - 1) {
            console.log(`   ⏸️  Waiting 3 seconds before next fork...`);
            await new Promise(resolve => setTimeout(resolve, 3000));
          }
        } catch (err) {
          console.error(`   ❌ Fork failed: ${err.message}`);
          console.error('');
          console.error('Aborting. You may need to:');
          console.error('  1. Check your GitHub token has repo and admin:org scopes');
          console.error('  2. Verify the source repo exists and is accessible');
          console.error('  3. Check GitHub API rate limits');
          process.exit(1);
        }

        console.log('');
      }
    }
  }

  // 4. Generate import.tf
  const importBlocks = generateImportBlocks(results);
  const importPath = path.join(stackDir, 'import.tf');
  fs.writeFileSync(importPath, importBlocks);

  // 5. Summary
  console.log('');
  console.log('═'.repeat(60));
  console.log('📊 Summary');
  console.log('═'.repeat(60));

  const toFork = results.filter(r => r.action === 'fork').length;
  const toCreate = results.filter(r => r.action === 'create-fresh').length;

  console.log(`   Repositories to fork:   ${toFork}`);
  console.log(`   Repositories to create: ${toCreate}`);
  console.log(`   Total (filtered):       ${results.length}`);

  // Show filtering info
  if (onlyRepos) {
    console.log(`   Filter: --only=${onlyRepos.join(',')}`);
  } else if (excludeRepos.length > 0) {
    console.log(`   Filter: --exclude=${excludeRepos.join(',')}`);
  }

  console.log('');
  console.log(`📝 Generated: ${importPath}`);
  console.log('');

  if (dryRun) {
    console.log('⚠️  DRY-RUN MODE: No repos were forked.');
    console.log('');
    console.log('Next steps:');
    console.log(`  1. Review the generated import.tf file:`);
    console.log(`     cat ${importPath}`);
    console.log('');
    console.log('  2. If everything looks good, run with --yes flag:');
    console.log(`     node .github/lib/fork-and-import.js ${stackDir} --yes`);
  } else {
    console.log('✅ Forks completed successfully!');
    console.log('');
    console.log('Next steps:');
    console.log(`  1. cd ${stackDir}`);
    console.log('  2. terraform plan  # Verify imports');

    // Add -target flags if filtering is used
    if (onlyRepos || excludeRepos.length > 0) {
      console.log('');
      console.log('💡 To apply only the filtered repositories, use -target flags:');

      // Generate comprehensive target flags for all related resources
      const targetFlags = generateTerraformTargets(cdkTfJson, filteredRepos);

      if (targetFlags.length > 0) {
        // Format for display (wrap long lines)
        const formattedTargets = targetFlags.join(' \\\n      ');
        console.log(`     terraform apply \\`);
        console.log(`      ${formattedTargets}`);
      } else {
        console.log('     (No matching resources found for filtering)');
      }

      console.log('');
      console.log('   Or apply all changes (including related resources):');
    }

    console.log('  3. terraform apply # Import into state');
    console.log('  4. rm import.tf    # Clean up after import');
  }
}

// Run main function
main().catch(err => {
  console.error('');
  console.error('❌ Unexpected error:', err.message);
  console.error(err.stack);
  process.exit(1);
});
