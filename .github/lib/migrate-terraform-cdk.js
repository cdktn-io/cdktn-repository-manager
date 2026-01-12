/**
 * Copyright (c) CDK Terrain Contributors
 * SPDX-License-Identifier: MPL-2.0
 */

/**
 * Migrate terraform-cdk Repository Script
 *
 * Migrates the hashicorp/terraform-cdk repository to a new location
 * using bare clone + mirror push strategy to preserve complete history.
 *
 * This is a one-off migration script (not managed by Terraform).
 *
 * Usage:
 *   node migrate-terraform-cdk.js                              # Dry-run (default)
 *   node migrate-terraform-cdk.js --yes                        # Execute to so0k
 *   node migrate-terraform-cdk.js --target=open-constructs --yes  # Execute to org
 *
 * Environment:
 *   USE_SSH=1     Use SSH instead of HTTPS for pushing (more reliable)
 *   GITHUB_TOKEN  GitHub token (required if not using SSH)
 */

const { execSync } = require('child_process');
const fs = require('fs');

// Configuration
const SOURCE_OWNER = 'hashicorp';
const SOURCE_REPO = 'terraform-cdk';
const TARGET_REPO = 'cdk-terrain';
const DEFAULT_TARGET_OWNER = 'so0k';

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = !args.includes('--yes');
const targetFlag = args.find(arg => arg.startsWith('--target='));
const targetOwner = targetFlag ? targetFlag.split('=')[1] : DEFAULT_TARGET_OWNER;

/**
 * Execute a command and return stdout
 */
function exec(cmd, options = {}) {
  return execSync(cmd, { encoding: 'utf-8', ...options }).trim();
}

/**
 * Execute a command silently, return true if success
 */
function execSilent(cmd) {
  try {
    execSync(cmd, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if user is authenticated with gh CLI
 */
function checkAuthentication() {
  try {
    const user = exec('gh api user --jq .login');
    console.log(`   Authenticated as: ${user}`);
    return user;
  } catch (err) {
    console.error('   Not authenticated with gh CLI');
    console.error('   Run: gh auth login');
    return null;
  }
}

/**
 * Check if target is a user or org and verify permissions
 */
async function checkTargetPermissions(targetOwner, currentUser) {
  // Check if target is an org or user
  try {
    const orgInfo = exec(`gh api orgs/${targetOwner} --jq '{type: "org", can_create: .members_can_create_public_repositories}'`);
    const parsed = JSON.parse(orgInfo);

    // Check membership
    try {
      const membership = exec(`gh api orgs/${targetOwner}/memberships/${currentUser} --jq '.role'`);
      console.log(`   Target: ${targetOwner} (organization)`);
      console.log(`   Role: ${membership}`);

      if (membership === 'admin') {
        console.log(`   Permission: Can create repos (admin)`);
        return true;
      } else if (parsed.can_create) {
        console.log(`   Permission: Can create repos (member)`);
        return true;
      } else {
        console.error(`   Permission: Cannot create repos (org policy)`);
        return false;
      }
    } catch {
      console.error(`   Not a member of ${targetOwner} organization`);
      return false;
    }
  } catch {
    // Not an org, check if it's the current user
    if (targetOwner === currentUser) {
      console.log(`   Target: ${targetOwner} (your user account)`);
      console.log(`   Permission: Can create repos`);
      return true;
    } else {
      // Check if it's another user
      try {
        exec(`gh api users/${targetOwner} --jq .login`);
        console.error(`   Target: ${targetOwner} (another user's account)`);
        console.error(`   Permission: Cannot create repos in another user's account`);
        return false;
      } catch {
        console.error(`   Target: ${targetOwner} not found`);
        return false;
      }
    }
  }
}

/**
 * Check if source repository exists and get its info
 */
function checkSourceRepo() {
  try {
    const info = exec(`gh api repos/${SOURCE_OWNER}/${SOURCE_REPO} --jq '{size_kb: .size, archived: .archived, default_branch: .default_branch}'`);
    const parsed = JSON.parse(info);
    const sizeMB = (parsed.size_kb / 1024).toFixed(1);

    console.log(`   Source: ${SOURCE_OWNER}/${SOURCE_REPO}`);
    console.log(`   Size: ${sizeMB} MB`);
    console.log(`   Status: ${parsed.archived ? 'Archived' : 'Active'}`);
    console.log(`   Default branch: ${parsed.default_branch}`);

    if (parsed.size_kb > 500 * 1024) {
      console.log(`   Warning: Large repository (>500MB) - migration may take a while`);
    }

    return { exists: true, sizeMB: parseFloat(sizeMB), defaultBranch: parsed.default_branch };
  } catch {
    console.error(`   Source repo not found: ${SOURCE_OWNER}/${SOURCE_REPO}`);
    return { exists: false };
  }
}

/**
 * Check if target repository already exists
 */
function checkTargetRepo(targetOwner) {
  const exists = execSilent(`gh api repos/${targetOwner}/${TARGET_REPO} --silent`);

  if (exists) {
    console.log(`   Target: ${targetOwner}/${TARGET_REPO} - EXISTS (conflict)`);
    return true;
  } else {
    console.log(`   Target: ${targetOwner}/${TARGET_REPO} - Does not exist (good)`);
    return false;
  }
}

/**
 * Get branch and tag counts from source repo
 */
function getRefCounts() {
  try {
    // Count branches
    const branches = exec(`gh api repos/${SOURCE_OWNER}/${SOURCE_REPO}/branches --paginate --jq 'length'`);
    const branchCount = branches.split('\n').reduce((sum, n) => sum + parseInt(n || 0), 0);

    // Count tags (paginate and sum)
    const tags = exec(`gh api repos/${SOURCE_OWNER}/${SOURCE_REPO}/tags --paginate --jq 'length'`);
    const tagCount = tags.split('\n').reduce((sum, n) => sum + parseInt(n || 0), 0);

    console.log(`   Branches: ${branchCount}`);
    console.log(`   Tags: ${tagCount}`);

    return { branches: branchCount, tags: tagCount };
  } catch (err) {
    console.log(`   Could not count refs: ${err.message}`);
    return { branches: 0, tags: 0 };
  }
}

/**
 * Create empty target repository
 */
async function createTargetRepository(targetOwner) {
  console.log(`   Creating repository ${targetOwner}/${TARGET_REPO}...`);

  try {
    execSync(`gh repo create ${targetOwner}/${TARGET_REPO} --public`, { stdio: 'pipe' });
  } catch (err) {
    throw new Error(`Failed to create repository: ${err.message}`);
  }

  // Poll until accessible (max 20 seconds)
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    if (execSilent(`gh api repos/${targetOwner}/${TARGET_REPO} --silent`)) {
      console.log(`   Repository created: https://github.com/${targetOwner}/${TARGET_REPO}`);
      return true;
    }
    process.stdout.write('.');
    await new Promise(resolve => setTimeout(resolve, 2000));
    attempts++;
  }

  throw new Error(`Repository creation timeout after ${maxAttempts * 2} seconds`);
}

/**
 * Disable GitHub Actions on the repository
 * Prevents workflows from running after migration
 */
async function disableGitHubActions(targetOwner) {
  try {
    console.log(`   Disabling GitHub Actions...`);
    execSync(
      `echo '{"enabled":false}' | gh api -X PUT /repos/${targetOwner}/${TARGET_REPO}/actions/permissions --input -`,
      { stdio: 'pipe', shell: '/bin/bash' }
    );
    console.log(`   GitHub Actions disabled`);
  } catch (err) {
    console.error(`   Warning: Failed to disable Actions: ${err.message}`);
    // Don't fail migration, just warn
  }
}

/**
 * Clone source and push to target using bare clone + mirror strategy
 */
async function migrateRepository(targetOwner, sizeMB) {
  // Use /var/tmp to avoid tmpfs space limits
  const tempDir = exec('mktemp -d -p /var/tmp');
  const originalDir = process.cwd();

  try {
    console.log(`   Cloning ${SOURCE_OWNER}/${SOURCE_REPO}...`);
    console.log(`   Temp directory: ${tempDir}`);

    // Bare clone captures all refs
    process.chdir(tempDir);
    execSync(
      `git clone --bare https://github.com/${SOURCE_OWNER}/${SOURCE_REPO}.git repo.git`,
      { stdio: 'inherit' }
    );

    // Enter bare repo
    process.chdir('repo.git');

    // Set up remote for target
    const useSSH = process.env.USE_SSH === '1' || process.env.USE_SSH === 'true';
    let remoteUrl;

    if (useSSH) {
      remoteUrl = `git@github.com:${targetOwner}/${TARGET_REPO}.git`;
      console.log(`   Using SSH for push`);
    } else {
      const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || exec('gh auth token');
      if (!token) {
        throw new Error('GITHUB_TOKEN not found (set USE_SSH=1 or provide token)');
      }
      remoteUrl = `https://x-access-token:${token}@github.com/${targetOwner}/${TARGET_REPO}.git`;
      console.log(`   Using HTTPS for push`);
    }

    execSync(`git remote add target "${remoteUrl}"`, { stdio: 'pipe' });

    // Configure git for reliability
    execSync('git config http.postBuffer 524288000', { stdio: 'pipe' }); // 500 MB
    execSync('git config http.lowSpeedTime 999999', { stdio: 'pipe' });

    // For repos under 1GB, try --mirror first (much faster)
    // Falls back to one-at-a-time if mirror fails (e.g., 2GB pack limit)
    const tryMirrorFirst = sizeMB < 1000;

    if (tryMirrorFirst) {
      console.log(`   Pushing with --mirror (repo is ${sizeMB} MB, under 1GB threshold)...`);
      try {
        execSync('git push --mirror target', { stdio: 'inherit' });
        console.log(`   Mirror push complete`);
        // Success - skip to cleanup
        process.chdir(originalDir);
        execSync(`rm -rf ${tempDir}`, { stdio: 'pipe' });
        return;
      } catch (mirrorErr) {
        console.log(`   Mirror push failed, falling back to one-at-a-time...`);
      }
    }

    // Fallback: push refs one at a time (for large repos or if mirror fails)
    const allRefs = exec('git show-ref')
      .split('\n')
      .map(line => line.split(' ')[1]);

    const branches = allRefs.filter(ref => ref.startsWith('refs/heads/'));
    const tags = allRefs.filter(ref => ref.startsWith('refs/tags/'));

    console.log(`   Found ${branches.length} branches, ${tags.length} tags`);

    // Push main branch first (contains most objects)
    const mainBranch = branches.find(b => b === 'refs/heads/main' || b === 'refs/heads/master');
    if (mainBranch) {
      console.log(`   Pushing ${mainBranch.replace('refs/heads/', '')} branch...`);
      execSync(`git push target ${mainBranch}`, { stdio: 'inherit' });
      console.log(`   Main branch pushed`);
    }

    // Push other branches one at a time
    const otherBranches = branches.filter(b => b !== mainBranch);
    if (otherBranches.length > 0) {
      console.log(`   Pushing ${otherBranches.length} other branches...`);
      for (let i = 0; i < otherBranches.length; i++) {
        const branch = otherBranches[i];
        const branchName = branch.replace('refs/heads/', '');
        process.stdout.write(`\r   Branch ${i + 1}/${otherBranches.length}: ${branchName.padEnd(30)}`);
        execSync(`git push target ${branch}`, { stdio: 'pipe' });
      }
      console.log('\n   Branches complete');
    }

    // Push tags one at a time
    if (tags.length > 0) {
      console.log(`   Pushing ${tags.length} tags...`);
      let successCount = 0;
      let failCount = 0;

      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];

        // Show progress every 50 tags
        if (i % 50 === 0 || i === tags.length - 1) {
          process.stdout.write(`\r   Tags: ${i + 1}/${tags.length} (${successCount} ok, ${failCount} failed)          `);
        }

        try {
          execSync(`git push target ${tag}`, { stdio: 'pipe' });
          successCount++;
        } catch {
          // Retry once
          try {
            execSync('sleep 1', { stdio: 'pipe' });
            execSync(`git push target ${tag}`, { stdio: 'pipe' });
            successCount++;
          } catch {
            failCount++;
          }
        }
      }
      console.log(`\n   Tags complete: ${successCount} pushed, ${failCount} failed`);
    }

    console.log(`   Migration complete`);

  } catch (err) {
    console.error(`   Migration failed: ${err.message}`);
    console.error(`   Temp directory preserved: ${tempDir}`);
    console.error(`   Manual retry:`);
    console.error(`     cd ${tempDir}/repo.git`);
    console.error(`     git push target --mirror`);
    process.chdir(originalDir);
    throw err;
  }

  // Cleanup on success
  process.chdir(originalDir);
  execSync(`rm -rf ${tempDir}`, { stdio: 'pipe' });
}

/**
 * Main execution
 */
async function main() {
  console.log('');
  console.log('='.repeat(60));
  console.log('  Migrate terraform-cdk Repository');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Mode: ${dryRun ? 'DRY-RUN (no changes)' : 'EXECUTE'}`);
  console.log(`Source: ${SOURCE_OWNER}/${SOURCE_REPO}`);
  console.log(`Target: ${targetOwner}/${TARGET_REPO}`);
  console.log('');

  // Step 1: Check authentication
  console.log('1. Checking authentication...');
  const currentUser = checkAuthentication();
  if (!currentUser) {
    process.exit(1);
  }
  console.log('');

  // Step 2: Check target permissions
  console.log('2. Checking target permissions...');
  const hasPermission = await checkTargetPermissions(targetOwner, currentUser);
  if (!hasPermission) {
    console.error('');
    console.error('Cannot proceed without permission to create repositories.');
    if (targetOwner !== currentUser) {
      console.error(`Try: node migrate-terraform-cdk.js --target=${currentUser}`);
    }
    process.exit(1);
  }
  console.log('');

  // Step 3: Check source repo
  console.log('3. Checking source repository...');
  const sourceInfo = checkSourceRepo();
  if (!sourceInfo.exists) {
    process.exit(1);
  }
  console.log('');

  // Step 4: Check target doesn't exist
  console.log('4. Checking target repository...');
  const targetExists = checkTargetRepo(targetOwner);
  if (targetExists) {
    console.error('');
    console.error('Target repository already exists. To proceed:');
    console.error(`  1. Delete it: gh repo delete ${targetOwner}/${TARGET_REPO} --yes`);
    console.error('  2. Run this script again');
    process.exit(1);
  }
  console.log('');

  // Step 5: Get ref counts
  console.log('5. Counting refs to migrate...');
  const refCounts = getRefCounts();
  console.log('');

  // Summary
  console.log('='.repeat(60));
  console.log('Summary:');
  console.log(`  Source: https://github.com/${SOURCE_OWNER}/${SOURCE_REPO}`);
  console.log(`  Target: https://github.com/${targetOwner}/${TARGET_REPO}`);
  console.log(`  Size: ${sourceInfo.sizeMB} MB`);
  console.log(`  Branches: ${refCounts.branches}`);
  console.log(`  Tags: ${refCounts.tags}`);
  console.log('='.repeat(60));
  console.log('');

  if (dryRun) {
    console.log('DRY-RUN complete. No changes made.');
    console.log('');
    console.log('To execute migration:');
    console.log(`  node .github/lib/migrate-terraform-cdk.js --target=${targetOwner} --yes`);
    console.log('');
    console.log('To use SSH (recommended for reliability):');
    console.log(`  USE_SSH=1 node .github/lib/migrate-terraform-cdk.js --target=${targetOwner} --yes`);
    process.exit(0);
  }

  // Execute migration
  console.log('6. Creating target repository...');
  await createTargetRepository(targetOwner);
  console.log('');

  console.log('7. Migrating repository...');
  await migrateRepository(targetOwner, sourceInfo.sizeMB);
  console.log('');

  console.log('8. Disabling GitHub Actions...');
  await disableGitHubActions(targetOwner);
  console.log('');

  // Success
  console.log('='.repeat(60));
  console.log('Migration complete!');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Repository: https://github.com/${targetOwner}/${TARGET_REPO}`);
  console.log('');
  console.log('Note: GitHub Actions is DISABLED on this repository.');
  console.log('');
  console.log('Verify migration:');
  console.log(`  gh repo view ${targetOwner}/${TARGET_REPO}`);
  console.log(`  gh api repos/${targetOwner}/${TARGET_REPO}/branches --jq 'length'`);
  console.log('');
  console.log('To re-enable Actions later:');
  console.log(`  gh api -X PUT /repos/${targetOwner}/${TARGET_REPO}/actions/permissions -f enabled=true -f allowed_actions=all`);
  console.log('');
  console.log('To delete and try again:');
  console.log(`  gh repo delete ${targetOwner}/${TARGET_REPO} --yes`);
}

main().catch(err => {
  console.error('');
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
