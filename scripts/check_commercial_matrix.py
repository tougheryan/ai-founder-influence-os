#!/usr/bin/env python3
"""Fail when the Echo Founder commercial capability inventory drifts."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
MATRIX_PATH = REPO_ROOT / "quality" / "commercial-readiness-matrix.json"
SUMMARY_PATH = REPO_ROOT / "quality" / "commercial-readiness-matrix.md"
MATRIX_SCHEMA = "echo-founder.commercial-capability-matrix.v1"
PRODUCT_VERSION = "0.2.0-beta.2"
ALLOWED_STATUSES = {"pass", "degraded", "blocked", "demo_only", "retired"}
SOURCE_INVENTORIES = {
    "pages": (REPO_ROOT / "ui" / "app", "page.tsx"),
    "api_routes": (REPO_ROOT / "ui" / "app", "route.ts"),
}
REQUIRED_DATA_SCHEMAS = {
    "aifios.run.v1",
    "aifios.market-snapshot.v1",
    "aifios.content-radar.v5",
    "aifios.visual-asset-manifest.v1",
    "aifios.publication-draft-queue.v1",
    "aifios.publication-ledger.v1",
    "aifios.weekly-learning-record.v1",
    "aifios.project-backup.v1",
    "echo-founder.publication-transaction.v1",
    "echo-founder.trusted-qa-public-keys.v1",
    "echo-founder.real-account-acceptance.v3",
    "echo-founder.image-account-policy.v1",
}
REQUIRED_AUTHORITY_SCHEMAS = {
    "echo-founder.publication-authority.v1",
}
FORBIDDEN_REPORT_PATTERNS = (
    re.compile(r"/Users/[^\s\"']+"),
    re.compile(r"/private/(?:tmp|var)/[^\s\"']+"),
    re.compile(r"(?i)(?:authorization\s*:\s*bearer|api[_-]?key\s*[:=]|cookie\s*:)[^\s\"']+"),
)


class MatrixError(AssertionError):
    pass


def repo_relative(path: Path) -> str:
    return path.relative_to(REPO_ROOT).as_posix()


def source_paths(root: Path, filename: str) -> set[str]:
    return {repo_relative(path) for path in root.rglob(filename) if path.is_file()}


def electron_bridge_paths() -> set[str]:
    root = REPO_ROOT / "ui" / "electron"
    return {
        repo_relative(path)
        for path in root.glob("*.cjs")
        if path.is_file() and not path.name.endswith(".test.cjs")
    }


def runtime_script_paths() -> set[str]:
    root = REPO_ROOT / "skills" / "content-runtime" / "scripts"
    return {
        repo_relative(path)
        for path in root.iterdir()
        if path.is_file() and path.suffix in {".py", ".mjs", ".swift"}
    }


def read_matrix(path: Path = MATRIX_PATH) -> tuple[dict[str, Any], str]:
    try:
        raw = path.read_text(encoding="utf-8")
        value = json.loads(raw)
    except (OSError, json.JSONDecodeError) as exc:
        raise MatrixError(f"commercial matrix is missing or invalid: {exc}") from exc
    if not isinstance(value, dict):
        raise MatrixError("commercial matrix root must be an object")
    return value, raw


def inventory_paths(inventory: Any, label: str, *, require_schema: bool = False) -> set[str]:
    if not isinstance(inventory, list):
        raise MatrixError(f"inventory {label} must be a list")
    paths: set[str] = set()
    for index, item in enumerate(inventory):
        if not isinstance(item, dict):
            raise MatrixError(f"inventory {label}[{index}] must be an object")
        path = item.get("path")
        status = item.get("status")
        capability = item.get("capability")
        if not isinstance(path, str) or not path or path.startswith("/") or ".." in path.split("/"):
            raise MatrixError(f"inventory {label}[{index}] has an unsafe path")
        if path in paths:
            raise MatrixError(f"inventory {label} repeats path: {path}")
        if status not in ALLOWED_STATUSES:
            raise MatrixError(f"inventory {label} has invalid status for {path}: {status}")
        if not isinstance(capability, str) or not capability.strip():
            raise MatrixError(f"inventory {label} has no capability for {path}")
        if require_schema and (not isinstance(item.get("schema"), str) or not item["schema"].strip()):
            raise MatrixError(f"data contract has no schema: {path}")
        paths.add(path)
    return paths


def assert_exact_inventory(label: str, actual: set[str], expected: set[str]) -> None:
    missing = sorted(expected - actual)
    stale = sorted(actual - expected)
    if missing or stale:
        raise MatrixError(f"{label} inventory drift; missing={missing}, stale={stale}")


def validate_matrix(path: Path = MATRIX_PATH, summary_path: Path = SUMMARY_PATH) -> dict[str, int]:
    matrix, raw = read_matrix(path)
    if matrix.get("schema") != MATRIX_SCHEMA:
        raise MatrixError("commercial matrix schema does not match the release contract")
    if matrix.get("product") != "Echo Founder" or matrix.get("product_version") != PRODUCT_VERSION:
        raise MatrixError("commercial matrix product/version does not match the release")
    target = matrix.get("target")
    if not isinstance(target, dict) or target.get("architecture") != "arm64" or "macOS 13+" not in str(target.get("os")):
        raise MatrixError("commercial matrix target must be macOS 13+ arm64")
    if matrix.get("overall_status") not in ALLOWED_STATUSES:
        raise MatrixError("commercial matrix overall status is invalid")
    blockers = matrix.get("blockers")
    if not isinstance(blockers, list):
        raise MatrixError("commercial matrix blockers must be a list")
    if blockers and matrix.get("overall_status") == "pass":
        raise MatrixError("commercial matrix cannot be pass while blockers remain")
    for pattern in FORBIDDEN_REPORT_PATTERNS:
        if pattern.search(raw):
            raise MatrixError("commercial matrix contains a local path or secret-shaped value")

    inventories = matrix.get("inventories")
    if not isinstance(inventories, dict):
        raise MatrixError("commercial matrix inventories are missing")
    counts: dict[str, int] = {}
    for label, (root, filename) in SOURCE_INVENTORIES.items():
        actual = inventory_paths(inventories.get(label), label)
        expected = source_paths(root, filename)
        assert_exact_inventory(label, actual, expected)
        counts[label] = len(actual)

    desktop = inventory_paths(inventories.get("desktop_bridges"), "desktop_bridges")
    assert_exact_inventory("desktop_bridges", desktop, electron_bridge_paths())
    counts["desktop_bridges"] = len(desktop)

    runtime = inventory_paths(inventories.get("runtime_scripts"), "runtime_scripts")
    assert_exact_inventory("runtime_scripts", runtime, runtime_script_paths())
    counts["runtime_scripts"] = len(runtime)

    data_items = inventories.get("data_contracts")
    data_paths = inventory_paths(data_items, "data_contracts", require_schema=True)
    schemas = {item["schema"] for item in data_items if isinstance(item, dict)}
    missing_schemas = sorted(REQUIRED_DATA_SCHEMAS - schemas)
    if missing_schemas:
        raise MatrixError(f"commercial data contracts miss required schemas: {missing_schemas}")
    authority_schemas = {
        item["authority_schema"]
        for item in data_items
        if isinstance(item, dict) and isinstance(item.get("authority_schema"), str)
    }
    missing_authority_schemas = sorted(REQUIRED_AUTHORITY_SCHEMAS - authority_schemas)
    if missing_authority_schemas:
        raise MatrixError(f"commercial data contracts miss required authority schemas: {missing_authority_schemas}")
    if not any(path.endswith(".aifios-backup/manifest.json") for path in data_paths):
        raise MatrixError("commercial data contracts do not describe the implemented backup directory manifest")
    counts["data_contracts"] = len(data_paths)

    try:
        summary = summary_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise MatrixError(f"human-readable commercial matrix is missing: {exc}") from exc
    for marker in ("Echo Founder 0.2.0-beta.2", MATRIX_SCHEMA, "macOS 13+ Apple Silicon"):
        if marker not in summary:
            raise MatrixError(f"human-readable commercial matrix misses: {marker}")
    return counts


def main() -> int:
    try:
        counts = validate_matrix()
    except MatrixError as exc:
        print(f"FAIL commercial capability matrix: {exc}")
        return 1
    print("PASS commercial capability matrix")
    for label, count in counts.items():
        print(f"{label}={count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
