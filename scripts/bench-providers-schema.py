#!/usr/bin/env python3
# Copyright (c) HashiCorp, Inc.
# SPDX-License-Identifier: MPL-2.0

"""
bench-providers-schema.py

Extracts schema complexity metrics for Terraform providers that have already
been initialised by bench-providers-init.sh (i.e. their binaries exist under
/tmp/tf-bench/<provider>/.terraform/providers/).

Runs `terraform providers schema -json` via subprocess, then analyses the
resulting JSON to produce:
  - schema JSON file size (MB)
  - resource count
  - data source count
  - total attribute count (recursive — includes all nested block attributes)

These metrics are compared against known thresholds to decide whether a
provider needs a custom (high-memory) GitHub runner for JSII compilation.

Usage:
    python3 scripts/bench-providers-schema.py [--bench-dir /tmp/tf-bench]

Requirements: terraform CLI, python3 >= 3.8
"""

import argparse
import json
import os
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

# ---------------------------------------------------------------------------
# Thresholds (validated against the 13-provider reference dataset, Feb 2026)
# ---------------------------------------------------------------------------
SCHEMA_MB_THRESHOLD = (
    2.25  # MB — gap: 2.18 (cloudflare, std) < X < 2.34 (datadog, custom)
)
TOTAL_ATTRS_THRESHOLD = (
    6000  # — gap: 4970 (cloudflare, std) < X < 9283 (kubernetes, custom)
)

# Known custom-runner providers (for reference column in output)
CUSTOM_RUNNER_PROVIDERS = {
    "aws",
    "azurerm",
    "datadog",
    "google",
    "googlebeta",
    "kubernetes",
}

DEFAULT_PROVIDERS = [
    "aws",
    "google",
    "azurerm",
    "kubernetes",
    "datadog",
    "googlebeta",
    "cloudflare",
    "vault",
    "azuread",
    "github",
    "snowflake",
    "helm",
    "docker",
    "grafana",
]


def count_attrs_recursive(block: dict) -> int:
    """Count all attributes at all nesting levels within a block definition."""
    count = len(block.get("attributes", {}))
    for btype in block.get("block_types", {}).values():
        count += count_attrs_recursive(btype.get("block", {}))
    return count


def extract_schema(provider: str, bench_dir: str) -> dict:
    """Run terraform providers schema -json and parse the output."""
    provider_dir = os.path.join(bench_dir, provider)
    schema_file = os.path.join(provider_dir, "schema.json")

    # Run terraform providers schema -json (re-uses existing .terraform dir)
    result = subprocess.run(
        ["terraform", f"-chdir={provider_dir}", "providers", "schema", "-json"],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return {"error": result.stderr.strip()[:200]}

    with open(schema_file, "w") as f:
        f.write(result.stdout)

    schema = json.loads(result.stdout)
    provider_schemas = schema.get("provider_schemas", {})
    if not provider_schemas:
        return {"error": "no provider_schemas in output"}

    pschema = list(provider_schemas.values())[0]
    resources = pschema.get("resource_schemas", {})
    data_sources = pschema.get("data_source_schemas", {})

    total_attrs = sum(
        count_attrs_recursive(r.get("block", {})) for r in resources.values()
    )
    total_attrs += sum(
        count_attrs_recursive(d.get("block", {})) for d in data_sources.values()
    )

    schema_bytes = len(result.stdout.encode())
    schema_mb = schema_bytes / (1024 * 1024)

    return {
        "provider": provider,
        "schema_mb": round(schema_mb, 2),
        "resources": len(resources),
        "data_sources": len(data_sources),
        "total_attrs": total_attrs,
    }


def classify(metrics: dict) -> str:
    if metrics.get("error"):
        return "ERROR"
    exceeds_schema = metrics["schema_mb"] > SCHEMA_MB_THRESHOLD
    exceeds_attrs = metrics["total_attrs"] > TOTAL_ATTRS_THRESHOLD
    if exceeds_schema or exceeds_attrs:
        return "CUSTOM"
    return "standard"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--bench-dir",
        default="/tmp/tf-bench",
        help="Directory created by bench-providers-init.sh (default: /tmp/tf-bench)",
    )
    parser.add_argument(
        "providers",
        nargs="*",
        default=DEFAULT_PROVIDERS,
        help="Provider aliases to analyse (default: all 14 in sample set)",
    )
    args = parser.parse_args()

    # Filter to providers that have been initialised
    available = [
        p
        for p in args.providers
        if os.path.isdir(os.path.join(args.bench_dir, p, ".terraform"))
    ]
    missing = [p for p in args.providers if p not in available]
    if missing:
        print(
            f"WARNING: not initialised (run bench-providers-init.sh first): {', '.join(missing)}"
        )

    if not available:
        print("No initialised providers found. Aborting.")
        sys.exit(1)

    print(f"Extracting schemas for {len(available)} providers (parallel)...")
    results = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(extract_schema, p, args.bench_dir): p for p in available}
        for future in as_completed(futures):
            provider = futures[future]
            results[provider] = future.result()
            print(f"  done: {provider}")

    # Sort: custom-runner candidates first, then by schema size desc
    ordered = sorted(
        available,
        key=lambda p: (
            -1 if classify(results[p]) == "CUSTOM" else 0,
            -(results[p].get("schema_mb", 0)),
        ),
    )

    # Print table
    header = f"\n{'Provider':<14} {'Schema MB':>10} {'Resources':>10} {'DataSrcs':>9} {'TotalAttrs':>12} {'Verdict':<10} {'Official?'}"
    print(header)
    print("-" * len(header))
    for p in ordered:
        m = results[p]
        if m.get("error"):
            print(f"{p:<14} ERROR: {m['error']}")
            continue
        verdict = classify(m)
        expected_class = "CUSTOM" if p in CUSTOM_RUNNER_PROVIDERS else "standard"
        official = "CUSTOM ✓" if p in CUSTOM_RUNNER_PROVIDERS else "standard"
        flag = ""
        if verdict != expected_class:
            flag = " ← mismatch"
        print(
            f"{p:<14} {m['schema_mb']:>10.2f} {m['resources']:>10} {m['data_sources']:>9} "
            f"{m['total_attrs']:>12} {verdict:<10} {official}{flag}"
        )

    print(
        f"\nThresholds: schema_json > {SCHEMA_MB_THRESHOLD} MB  OR  total_attrs > {TOTAL_ATTRS_THRESHOLD}"
    )
    print(
        f"Schema MB gap validated: 2.18 (cloudflare, std) < threshold < 2.34 (datadog, custom)"
    )
    print(
        f"TotalAttrs gap validated: 4970 (cloudflare, std) < threshold < 9283 (kubernetes, custom)"
    )


if __name__ == "__main__":
    main()
