# Migrating Large Provider Repositories

This document captures the challenges and solutions discovered while migrating very large provider repositories (like `cdktf-provider-aws` at 6.88 GiB with 2.5 million git objects) from the archived `cdktf` org to `cdktn-io`.

## Problem Summary

Large provider repositories like AWS cannot be migrated using standard `git push --mirror` due to multiple GitHub limitations:

| Issue | Error Message | Root Cause |
|-------|--------------|------------|
| HTTP timeout | `HTTP 500 curl 22` | GitHub's HTTP endpoint times out on large uploads |
| Pack size limit | `pack exceeds maximum allowed size (2.00 GiB)` | GitHub rejects packs larger than 2GB |
| Slow upload | Hangs indefinitely | Local internet too slow for 7GB upload |

## Solutions Implemented

### 1. Use EC2 Instance Near GitHub Servers

For repositories larger than ~1GB, use an EC2 instance in US regions for faster upload speeds:

```bash
# Recommended: Amazon Linux 2023, ARM64, 8 cores, 32GB RAM
# Instance type: m6g.2xlarge or similar
# Region: us-east-1

# Bootstrap the instance (see scripts/al2023-bootstrap.sh)
```

**Performance comparison:**
- EC2 US (95 Mbps+): ~10 minutes for 7GB, reliable

### 2. Push Refs One at a Time

GitHub has a **2GB pack size limit**. When pushing multiple refs at once, git creates a single pack with all objects, which exceeds this limit for large repos.

**Solution:** Push refs individually. After the first push (main branch), subsequent pushes only send delta objects (objects not already on the remote), keeping each pack small.

```javascript
// Push main branch first (this is the big one)
git push cdktn-io refs/heads/main

// After main is pushed, each tag only sends its unique objects
for (const tag of tags) {
  git push cdktn-io ${tag}  // Only delta objects - very small
}
```

### 3. Use SSH Instead of HTTPS

SSH is more reliable for large pushes - no HTTP timeouts:

```bash
# Set up SSH key
ssh-keygen -t ed25519 -C "migration" -f ~/.ssh/migration_key -N ""
gh ssh-key add ~/.ssh/migration_key.pub --title "EC2 Migration"
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/migration_key

# Run with SSH
USE_SSH=1 node .github/lib/fork-and-import.js cdktf.out/stacks/repos --only=cdktn-provider-aws --yes
```

### 4. Use /var/tmp Instead of /tmp

On many Linux systems, `/tmp` is mounted as tmpfs (RAM-backed), which has limited space. The 7GB bare clone won't fit.

```javascript
// Use /var/tmp which is on the root filesystem
const tempDir = execSync('mktemp -d -p /var/tmp').toString().trim();
```

### 5. Configure Git for Large Repos

```bash
git config http.postBuffer 524288000  # 500 MB buffer
git config http.lowSpeedLimit 0       # Disable speed timeout
git config http.lowSpeedTime 999999   # Very long timeout
git config pack.windowMemory 256m     # Limit memory for packing
git config pack.threads 4             # Limit CPU threads
```

### 6. Preserve Temp Directory on Failure

If the push fails partway through, preserve the temp directory so it can be manually retried:

```javascript
} catch (err) {
  console.error(`Temp directory preserved: ${tempDir}`);
  console.error(`Retry: cd ${tempDir}/repo.git && git push cdktn-io --all`);
  // Don't cleanup - preserve for manual retry
  throw err;
}
```

### 7. Smart Cleanup on Failure

Don't auto-delete the target repository on push failure - the data might have been pushed successfully despite the error:

```javascript
// Check if repo has content before deleting
const branchCount = gh api /repos/cdktn-io/${repo}/branches --jq 'length'
if (branchCount > 0) {
  console.log("Data may have been pushed - check manually");
} else {
  gh repo delete cdktn-io/${repo} --yes
}
```

## Manual Recovery

If the script fails but the temp directory is preserved:

```bash
# Navigate to the preserved temp directory
cd /var/tmp/tmp.XXXXXX/repo.git

# Check what's already pushed
git ls-remote cdktn-io

# Push main branch first (this sends most objects)
git push cdktn-io refs/heads/main

# Push remaining tags one at a time
for tag in $(git tag); do
  echo "Pushing $tag..."
  git push cdktn-io "refs/tags/$tag" 2>/dev/null || echo "  Failed: $tag"
done

# Or push tags in parallel (4 at a time)
git tag | xargs -P4 -I{} sh -c 'git push cdktn-io refs/tags/{} 2>/dev/null && echo "OK: {}" || echo "FAIL: {}"'
```

## Provider Size Reference

| Provider | Objects | Size | Difficulty |
|----------|---------|------|------------|
| aws | 2.5M | 6.88 GB | Hard - requires EC2 + one-at-a-time |
| aws-go | 2.4M | 7.42 GB | Hard - requires EC2 + one-at-a-time |
| google | ~500K | ~1.5 GB | Medium - may need EC2 |
| azurerm | ~400K | ~1.2 GB | Medium - may need EC2 |
| kubernetes | ~50K | ~200 MB | Easy - local works fine |
| github | ~30K | ~100 MB | Easy - local works fine |

## Script Changes Summary

The `fork-and-import.js` script was updated with these improvements:

1. **Progress visibility**: `stdio: 'inherit'` for git clone/push
2. **SSH support**: `USE_SSH=1` environment variable
3. **Batched pushing**: Push refs one at a time to avoid 2GB limit
4. **Retry logic**: 3 retries with 5-second delays
5. **/var/tmp usage**: Avoid tmpfs space limits
6. **Preserved temp dir**: Don't cleanup on error
7. **Smart cleanup**: Check if repo has content before deleting
8. **Git config**: Large repo settings for buffers and timeouts

## Future Improvements

- [ ] Add `--parallel` flag for tag pushing (safe after main is pushed)
- [ ] Add progress bar for tag pushing (using `readline`)
- [ ] Add `--resume` flag to continue from preserved temp directory
- [ ] Consider GitHub's Import API for very large repos
- [ ] Add size estimation before starting migration