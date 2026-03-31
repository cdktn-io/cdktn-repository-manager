#!/usr/bin/env bash
#
# scan-axios.sh — Audit cdktn-io org repos for the axios supply chain attack.
#
# Compromised versions: axios 1.14.1, axios 0.30.4
# Malicious dependency: plain-crypto-js
#
# Uses the GitHub API (via gh cli) to fetch yarn.lock files remotely — no cloning required.
#
# Usage: ./scripts/scan-axios.sh [--org ORG_NAME]

set -euo pipefail

ORG="cdktn-io"
if [[ "${1:-}" == "--org" ]]; then
	ORG="${2:-cdktn-io}"
fi

COMPROMISED_VERSIONS=("1.14.1" "0.30.4")
MALICIOUS_DEP="plain-crypto-js"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

compromised_count=0
scanned_count=0
skipped_count=0
has_axios_count=0

echo ""
echo -e "${BOLD}Axios Supply Chain Attack Audit${NC}"
echo -e "${BOLD}================================${NC}"
echo -e "Org:                  ${ORG}"
echo -e "Compromised versions: ${COMPROMISED_VERSIONS[*]}"
echo -e "Malicious dependency: ${MALICIOUS_DEP}"
echo ""

# Get all non-Go repos (exclude -go suffix and .github)
repo_list=$(gh repo list "$ORG" --limit 200 --json name --jq '.[].name' | grep -v '\-go$' | grep -v '^\.' | sort)

printf "${BOLD}%-45s %-15s %-15s %s${NC}\n" "REPO" "AXIOS VERSION" "COMPROMISED" "PLAIN-CRYPTO-JS"
echo "-----------------------------------------------------------------------------------------------------------"

while IFS= read -r repo; do
	# Try to get yarn.lock download URL
	download_url=$(gh api "repos/${ORG}/${repo}/contents/yarn.lock" --jq '.download_url' 2>/dev/null || echo "")

	if [[ -z "$download_url" ]]; then
		printf "%-45s %-15s %-15s %s\n" "$repo" "-" "SKIPPED" "(no yarn.lock)"
		skipped_count=$((skipped_count + 1))
		continue
	fi

	scanned_count=$((scanned_count + 1))

	# Download and scan yarn.lock
	lockfile_content=$(curl -sL "$download_url")

	# Extract all axios resolved versions from yarn.lock
	# yarn.lock v1 format: axios@^x.y.z:\n  version "x.y.z"
	axios_versions=$(echo "$lockfile_content" | grep -A1 '^axios@' | grep 'version ' | sed 's/.*version "\(.*\)"/\1/' | sort -u || true)

	# Check for malicious dependency
	has_malicious=$(echo "$lockfile_content" | grep -c "$MALICIOUS_DEP" || true)

	if [[ -z "$axios_versions" ]]; then
		malicious_indicator="no"
		if [[ "$has_malicious" -gt 0 ]]; then
			malicious_indicator="${RED}YES${NC}"
			compromised_count=$((compromised_count + 1))
		fi
		printf "%-45s %-15s %-15s %b\n" "$repo" "(none)" "n/a" "$malicious_indicator"
		continue
	fi

	has_axios_count=$((has_axios_count + 1))

	for version in $axios_versions; do
		is_compromised="no"
		for bad_version in "${COMPROMISED_VERSIONS[@]}"; do
			if [[ "$version" == "$bad_version" ]]; then
				is_compromised="YES"
				compromised_count=$((compromised_count + 1))
				break
			fi
		done

		malicious_indicator="no"
		if [[ "$has_malicious" -gt 0 ]]; then
			malicious_indicator="YES"
		fi

		if [[ "$is_compromised" == "YES" || "$malicious_indicator" == "YES" ]]; then
			printf "${RED}%-45s %-15s %-15s %s${NC}\n" "$repo" "$version" "$is_compromised" "$malicious_indicator"
		else
			printf "${GREEN}%-45s %-15s %-15s %s${NC}\n" "$repo" "$version" "$is_compromised" "$malicious_indicator"
		fi
	done
done <<<"$repo_list"

echo ""
echo -e "${BOLD}Summary${NC}"
echo "-----------------------------------------------------------------------------------------------------------"
echo "Repos scanned (with yarn.lock): $scanned_count"
echo "Repos skipped (no yarn.lock):   $skipped_count"
echo "Repos with axios dependency:    $has_axios_count"

if [[ "$compromised_count" -gt 0 ]]; then
	echo ""
	echo -e "${RED}${BOLD}ALERT: $compromised_count compromised version(s) or malicious dependency found!${NC}"
	echo -e "${RED}Action required: Downgrade axios to safe version (1.14.0 or 0.30.3) and rotate all secrets/credentials.${NC}"
	exit 1
else
	echo ""
	echo -e "${GREEN}${BOLD}No compromised axios versions or malicious dependencies found.${NC}"
	exit 0
fi
