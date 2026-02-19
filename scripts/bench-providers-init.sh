#!/usr/bin/env bash
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

# bench-providers-init.sh
#
# Downloads provider binaries via `terraform init` for a given set of providers
# and reports their binary sizes. Used to evaluate whether a provider needs a
# custom (high-memory) GitHub runner for JSII compilation.
#
# Usage:
#   ./scripts/bench-providers-init.sh [provider:namespace/name ...]
#
# Example (run the default sample set):
#   ./scripts/bench-providers-init.sh
#
# Example (add a custom provider):
#   ./scripts/bench-providers-init.sh newprovider:mynamespace/newprovider
#
# Output: binary size (MB) per provider, sorted descending.
#
# Requirements: terraform CLI, bc

set -euo pipefail

BENCH_DIR="${BENCH_DIR:-/tmp/tf-bench}"

# Default sample set: "alias:namespace/name"
DEFAULT_PROVIDERS=(
  "aws:hashicorp/aws"
  "google:hashicorp/google"
  "azurerm:hashicorp/azurerm"
  "kubernetes:hashicorp/kubernetes"
  "datadog:datadog/datadog"
  "googlebeta:hashicorp/google-beta"
  "cloudflare:cloudflare/cloudflare"
  "vault:hashicorp/vault"
  "azuread:hashicorp/azuread"
  "github:integrations/github"
  "snowflake:snowflakedb/snowflake"
  "helm:hashicorp/helm"
  "docker:kreuzwerker/docker"
  "grafana:grafana/grafana"
)

PROVIDERS=("${@:-${DEFAULT_PROVIDERS[@]}}")

echo "==> Creating provider directories in $BENCH_DIR"
mkdir -p "$BENCH_DIR"

for item in "${PROVIDERS[@]}"; do
  alias="${item%%:*}"
  src="${item##*:}"
  mkdir -p "$BENCH_DIR/$alias"
  cat > "$BENCH_DIR/$alias/versions.tf" << EOF
terraform {
  required_providers {
    $alias = {
      source = "$src"
    }
  }
}
EOF
done

echo "==> Running terraform init for ${#PROVIDERS[@]} providers concurrently..."
pids=()
for item in "${PROVIDERS[@]}"; do
  alias="${item%%:*}"
  terraform -chdir="$BENCH_DIR/$alias" init -backend=false -no-color \
    > "$BENCH_DIR/$alias/init.log" 2>&1 &
  pids+=($!)
done

# Wait for all background jobs
for pid in "${pids[@]}"; do
  wait "$pid" || true
done

echo ""
echo "==> Results: Provider Binary Sizes"
echo "---"

# Collect sizes for sorting
declare -a RESULTS=()
for item in "${PROVIDERS[@]}"; do
  alias="${item%%:*}"
  if ! grep -q "Terraform has been successfully initialized" "$BENCH_DIR/$alias/init.log" 2>/dev/null; then
    echo "  FAILED: $alias"
    tail -3 "$BENCH_DIR/$alias/init.log" | sed 's/^/    /'
    continue
  fi

  # Find provider binary (exclude doc/license files)
  binary=$(find "$BENCH_DIR/$alias/.terraform/providers" -type f \
    ! -name "LICENSE*" ! -name "CHANGELOG*" ! -name "README*" \
    ! -name "*.lock" ! -name "*.csv" 2>/dev/null | head -1)

  if [ -z "$binary" ]; then
    echo "  NO BINARY: $alias"
    continue
  fi

  bytes=$(stat -f%z "$binary" 2>/dev/null || stat -c%s "$binary" 2>/dev/null)
  mb=$(echo "scale=1; $bytes / 1048576" | bc)
  RESULTS+=("$mb $alias $bytes")
done

# Sort by size descending
printf '%s\n' "${RESULTS[@]}" | sort -rn | while read -r mb alias bytes; do
  printf "  %-14s %8s MB  (%s bytes)\n" "$alias" "$mb" "$bytes"
done

echo ""
echo "==> Init logs written to $BENCH_DIR/<provider>/init.log"
echo "==> Run scripts/bench-providers-schema.py to extract schema metrics from these dirs"
