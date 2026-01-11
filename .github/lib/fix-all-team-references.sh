#!/bin/bash
set -e

# Comprehensive script to fix all team references in provider repositories
# This script:
# 1. Temporarily disables branch protection
# 2. Updates team names and email addresses in all workflow files
# 3. Commits and pushes changes
# 4. Optionally re-enables branch protection via terraform

ORG="cdktn-io"
OLD_TEAM="team-tf-cdk"
NEW_TEAM="team-cdk-terrain[bot]"
OLD_EMAIL="github-team-tf-cdk@hashicorp.com"
# gh api /users/${NEW_TEAM} --jq .id // HARDCODED FOR NOW
APP_USER_ID='254218809'
NEW_EMAIL="${APP_USER_ID}-${NEW_TEAM}@users.noreply.github.com";
BRANCH="main"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "======================================================================"
echo "Fix All Team References in Provider Repositories"
echo "======================================================================"
echo "Organization: $ORG"
echo "Old team: $OLD_TEAM → New: $NEW_TEAM"
echo "Old email: $OLD_EMAIL"
echo "New email: $NEW_EMAIL"
echo "======================================================================"
echo ""

# Confirm with user
read -p "This will modify all cdktn-provider-* repositories. Continue? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

# Get list of all provider repositories
echo "🔍 Fetching repository list..."
REPOS=$(gh repo list $ORG --limit 100 --json name --jq '.[] | select(.name | startswith("cdktn-provider-")) | .name')

if [ -z "$REPOS" ]; then
  echo -e "${RED}❌ No repositories found${NC}"
  exit 1
fi

REPO_COUNT=$(echo "$REPOS" | wc -l)
echo -e "${GREEN}✓ Found $REPO_COUNT repositories${NC}"
echo ""

# Statistics
SUCCESS_COUNT=0
SKIP_COUNT=0
ERROR_COUNT=0

# Process each repository
for REPO in $REPOS; do
  echo "======================================================================"
  echo "📦 $REPO"
  echo "======================================================================"

  FULL_REPO="$ORG/$REPO"

  # Step 1: Disable branch protection
  echo "  🔓 Disabling branch protection..."
  if gh api -X DELETE "repos/$FULL_REPO/branches/$BRANCH/protection" 2>/dev/null; then
    echo -e "  ${GREEN}✓ Branch protection disabled${NC}"
    PROTECTION_DISABLED=true
  else
    echo -e "  ${YELLOW}⚠️  No branch protection or already disabled${NC}"
    PROTECTION_DISABLED=false
  fi

  # Step 2: Clone repository
  TEMP_DIR=$(mktemp -d)
  cd "$TEMP_DIR"

  echo "  📥 Cloning..."
  if ! gh repo clone "$FULL_REPO" . -- --quiet 2>/dev/null; then
    echo -e "  ${RED}❌ Failed to clone${NC}"
    cd - &>/dev/null
    rm -rf "$TEMP_DIR"
    ((ERROR_COUNT++))
    continue
  fi

  # Step 3: Check if updates are needed
  WORKFLOW_FILES=(.github/workflows/*.yml)
  NEEDS_UPDATE=false

  for FILE in "${WORKFLOW_FILES[@]}"; do
    if [ -f "$FILE" ] && (grep -q "$OLD_TEAM" "$FILE" || grep -q "$OLD_EMAIL" "$FILE"); then
      NEEDS_UPDATE=true
      break
    fi
  done

  if [ "$NEEDS_UPDATE" = false ]; then
    echo -e "  ${GREEN}✓ Already up to date${NC}"
    cd - &>/dev/null
    rm -rf "$TEMP_DIR"
    ((SKIP_COUNT++))
    echo ""
    continue
  fi

  # Step 4: Update all occurrences
  echo "  ✏️  Updating team references..."
  FILES_CHANGED=0

  for FILE in "${WORKFLOW_FILES[@]}"; do
    if [ -f "$FILE" ]; then
      BEFORE=$(md5sum "$FILE" 2>/dev/null | cut -d' ' -f1)

      # Replace email address first (before team name, to avoid partial replacement)
      sed -i "s|$OLD_EMAIL|$NEW_EMAIL|g" "$FILE"

      # Replace team name
      sed -i "s/$OLD_TEAM/$NEW_TEAM/g" "$FILE"

      AFTER=$(md5sum "$FILE" 2>/dev/null | cut -d' ' -f1)

      if [ "$BEFORE" != "$AFTER" ]; then
        echo "    - Updated: $FILE"
        ((FILES_CHANGED++))
      fi
    fi
  done

  if [ $FILES_CHANGED -eq 0 ]; then
    echo -e "  ${YELLOW}⚠️  No changes made${NC}"
    cd - &>/dev/null
    rm -rf "$TEMP_DIR"
    ((SKIP_COUNT++))
    echo ""
    continue
  fi

  echo -e "  ${GREEN}✓ Updated $FILES_CHANGED workflow files${NC}"

  # Step 5: Commit and push
  git config user.name "$NEW_TEAM"
  git config user.email "$NEW_EMAIL"

  echo "  📝 Committing..."
  git add .github/workflows/*.yml
  git commit -m "fix: update team references from $OLD_TEAM to $NEW_TEAM

- Replace team name in workflow conditions
- Update git config email addresses
- Align with CDKTN organization migration" --quiet

  echo "  📤 Pushing to $BRANCH..."
  if git push origin $BRANCH --quiet 2>&1; then
    echo -e "  ${GREEN}✅ Successfully pushed ($FILES_CHANGED files)${NC}"
    ((SUCCESS_COUNT++))
  else
    echo -e "  ${RED}❌ Failed to push${NC}"
    ((ERROR_COUNT++))
  fi

  # Cleanup
  cd - &>/dev/null
  rm -rf "$TEMP_DIR"
  echo ""
done

# Summary
echo "======================================================================"
echo "📊 Summary"
echo "======================================================================"
echo -e "${GREEN}✅ Success:  $SUCCESS_COUNT repositories${NC}"
echo -e "${YELLOW}⏭️  Skipped:  $SKIP_COUNT repositories${NC}"
echo -e "${RED}❌ Errors:   $ERROR_COUNT repositories${NC}"
echo "======================================================================"
echo ""

# Offer to re-enable branch protection via Terraform
echo -e "${BLUE}🔒 Branch Protection${NC}"
echo "Branch protection was temporarily disabled for all repositories."
echo ""
echo "To re-enable branch protection, run:"
echo -e "${YELLOW}  cd cdktf.out/stacks/repos && terraform apply${NC}"
echo -e "${YELLOW}  cd cdktf.out/stacks/repos-official-new && terraform apply${NC}"
echo ""

if [ $ERROR_COUNT -gt 0 ]; then
  exit 1
fi
