#!/usr/bin/env python3
"""Verify the smallest stable local desktop artifact layout.

The minimal local release keeps the DMG, DMG manifest and bound portable
package manifest in dist/, and prunes
the expanded ``dist/desktop/Echo Founder.app`` after the DMG has passed install smoke.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from desktop_dmg import (
    DEFAULT_APP_NAME,
    DEFAULT_BUNDLE_ID,
    DEFAULT_DMG_PATH,
    DEFAULT_VOLUME_NAME,
    sha256_file,
    verify_checksum_sidecar,
    verify_dmg,
)
from desktop_package import assert_release_manifest_portable


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def read_manifest(path: Path) -> tuple[dict[str, Any], str]:
    if not path.exists():
        return {}, "missing"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        return {}, f"invalid-json: {exc}"
    if not isinstance(payload, dict):
        return {}, "invalid-root"
    return payload, ""


def expected_mounted_app_path(volume_name: str, app_name: str) -> str:
    return f"/Volumes/{volume_name}/{app_name}.app"


def check_manifest(
    dmg_path: Path,
    app_name: str,
    volume_name: str,
    bundle_id: str,
) -> tuple[dict[str, Any], list[str]]:
    manifest_path = dmg_path.with_suffix(".manifest.json")
    payload, error = read_manifest(manifest_path)
    checks: dict[str, Any] = {
        "path": str(manifest_path),
        "exists": manifest_path.exists(),
        "valid_json": not error,
        "payload": payload,
    }
    failures: list[str] = []
    if error:
        failures.append(f"dmg manifest {error}: {manifest_path}")
        return checks, failures

    try:
        assert_release_manifest_portable(payload)
        checks["portable_paths"] = True
    except RuntimeError as exc:
        checks["portable_paths"] = False
        failures.append(str(exc))

    actual_sha = sha256_file(dmg_path) if dmg_path.exists() else ""
    try:
        checksum_sidecar = verify_checksum_sidecar(dmg_path, str(payload.get("checksum_file") or ""))
        checks["checksum_sidecar"] = checksum_sidecar
    except RuntimeError as exc:
        checks["checksum_sidecar"] = {"status": "fail"}
        failures.append(str(exc))
    checks.update(
        {
            "declared_sha256": payload.get("sha256", ""),
            "actual_sha256": actual_sha,
            "sha256_matches": bool(actual_sha and payload.get("sha256") == actual_sha),
            "size_matches": payload.get("size_bytes") == (dmg_path.stat().st_size if dmg_path.exists() else 0),
            "artifact": payload.get("artifact", ""),
            "app_name": payload.get("app_name", ""),
            "mounted_app_path": payload.get("mounted_app_path", ""),
            "bundle_id": payload.get("bundle_id", ""),
        }
    )
    if not checks["sha256_matches"]:
        failures.append("dmg manifest SHA256 does not match the DMG")
    if not checks["size_matches"]:
        failures.append("dmg manifest size_bytes does not match the DMG")
    if payload.get("artifact") != "dmg":
        failures.append("dmg manifest artifact must be 'dmg'")
    if payload.get("app_name") not in ("", f"{app_name}.app"):
        failures.append(f"dmg manifest app_name is unexpected: {payload.get('app_name')}")
    mounted_app = expected_mounted_app_path(volume_name, app_name)
    if payload.get("mounted_app_path") not in ("", mounted_app):
        failures.append(f"dmg manifest mounted_app_path is unexpected: {payload.get('mounted_app_path')}")
    if payload.get("bundle_id") != bundle_id:
        failures.append(f"dmg manifest bundle_id mismatch: {payload.get('bundle_id')} != {bundle_id}")
    package_binding = payload.get("package_manifest")
    checks["package_manifest_binding"] = package_binding
    if not isinstance(package_binding, dict) or package_binding.get("schema") != "echo-founder.package-manifest-binding.v1":
        failures.append("dmg manifest is missing the versioned package-manifest binding")
    elif not isinstance(package_binding.get("source_control", {}).get("dirty"), bool):
        failures.append("dmg manifest package binding does not explicitly record source dirty state")
    elif not isinstance(package_binding.get("shipped_runtime", {}).get("tree_sha256"), str):
        failures.append("dmg manifest package binding does not record the shipped runtime tree digest")
    else:
        relative_package_manifest = Path(str(package_binding.get("path") or ""))
        if relative_package_manifest.is_absolute() or ".." in relative_package_manifest.parts:
            failures.append("dmg manifest package binding path is not portable")
        else:
            package_manifest_path = dmg_path.parent / relative_package_manifest
            checks["package_manifest_path"] = str(package_manifest_path)
            checks["package_manifest_exists"] = package_manifest_path.is_file()
            if not package_manifest_path.is_file():
                failures.append(f"bound package manifest is missing: {package_manifest_path}")
            elif sha256_file(package_manifest_path) != package_binding.get("sha256"):
                failures.append("bound package manifest SHA256 does not match the DMG manifest")
    return checks, failures


def minimal_artifact_check(
    dmg_path: Path,
    app_name: str,
    volume_name: str,
    bundle_id: str,
    allow_expanded_app: bool,
) -> tuple[dict[str, Any], list[str]]:
    dist_dir = dmg_path.parent
    expanded_dir = dist_dir / "desktop"
    expanded_app = expanded_dir / f"{app_name}.app"
    report: dict[str, Any] = {
        "checked_at": now_iso(),
        "dmg_path": str(dmg_path),
        "dist_dir": str(dist_dir),
        "expanded_app_path": str(expanded_app),
        "expanded_app_exists": expanded_app.exists(),
        "expanded_dir_exists": expanded_dir.exists(),
        "allow_expanded_app": allow_expanded_app,
    }
    failures: list[str] = []
    if not dmg_path.exists():
        failures.append(f"DMG is missing: {dmg_path}")
        report["status"] = "fail"
        return report, failures
    if expanded_dir.exists() and not allow_expanded_app:
        failures.append(f"expanded desktop package should be pruned for minimal layout: {expanded_dir}")

    manifest, manifest_failures = check_manifest(dmg_path, app_name, volume_name, bundle_id)
    report["manifest"] = manifest
    failures.extend(manifest_failures)

    try:
        dmg_verification = verify_dmg(dmg_path, app_name, volume_name, bundle_id)
        report["dmg_verification"] = dmg_verification
    except Exception as exc:
        failures.append(f"DMG verification failed: {exc}")

    report["status"] = "pass" if not failures else "fail"
    report["failures"] = failures
    report["size_bytes"] = dmg_path.stat().st_size if dmg_path.exists() else 0
    return report, failures


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify a DMG-only minimal Echo Founder desktop artifact layout")
    parser.add_argument("--dmg-path", default=str(DEFAULT_DMG_PATH))
    parser.add_argument("--app-name", default=DEFAULT_APP_NAME)
    parser.add_argument("--volume-name", default=DEFAULT_VOLUME_NAME)
    parser.add_argument("--bundle-id", default=DEFAULT_BUNDLE_ID)
    parser.add_argument("--allow-expanded-app", action="store_true")
    parser.add_argument("--report", default="")
    args = parser.parse_args()

    report, failures = minimal_artifact_check(
        dmg_path=Path(args.dmg_path).expanduser().resolve(),
        app_name=args.app_name,
        volume_name=args.volume_name,
        bundle_id=args.bundle_id,
        allow_expanded_app=args.allow_expanded_app,
    )
    if args.report:
        report_path = Path(args.report).expanduser().resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if failures:
        print("FAIL desktop minimal artifact check", file=sys.stderr)
        for failure in failures:
            print(f"- {failure}", file=sys.stderr)
        return 1

    print("PASS desktop minimal artifact check")
    print(f"dmg_path={report['dmg_path']}")
    print(f"size_bytes={report['size_bytes']}")
    print(f"expanded_app_exists={report['expanded_app_exists']}")
    if args.report:
        print(f"report={Path(args.report).expanduser().resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
