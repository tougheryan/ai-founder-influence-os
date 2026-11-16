#!/usr/bin/env python3
"""Report the active Echo Founder version and reject version drift."""
from __future__ import annotations

import argparse
import json
import re
import subprocess
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
VERSION_RE = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-(?:alpha|beta|rc)\.[1-9]\d{0,2})?$"
)

JSON_VERSION_FIELDS = {
    "ui/package.json": ("version",),
    "ui/package-lock.json": ("version",),
    "quality/commercial-readiness-matrix.json": ("product_version",),
    "quality/acceptance/real-account-acceptance.template.json": ("product_version",),
}

ACTIVE_VERSION_FILES = (
    "README.md",
    "RELEASE.md",
    "docs/commercial-delivery-sop.md",
    "docs/desktop-electron.md",
    "docs/echo-founder-api-platform-setup.md",
    "docs/echo-founder-backup-upgrade.md",
    "docs/echo-founder-installation.md",
    "docs/friend-demo-install.md",
    "docs/versioning.md",
    "quality/commercial-readiness-matrix.md",
    "scripts/check_commercial_matrix.py",
    "scripts/commercial_readiness_gate.py",
    "scripts/desktop_dmg_open_smoke.py",
    "scripts/desktop_dmg_smoke.py",
    "scripts/desktop_notarize.py",
    "scripts/desktop_package.py",
    "scripts/desktop_release_assessment.py",
    "ui/app/api/desktop/diagnostics/package/route.ts",
    "ui/lib/material-analysis.ts",
    "ui/lib/public-research.ts",
)

SEMVER_CAPTURE = r"(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?)"
PRODUCT_VERSION_PATTERNS = (
    re.compile(rf"Echo-Founder-{SEMVER_CAPTURE}"),
    re.compile(rf"Echo Founder(?: material reference reader)?/{SEMVER_CAPTURE}"),
    re.compile(rf"Echo Founder\s+{SEMVER_CAPTURE}"),
    re.compile(
        rf"(?:DEFAULT_PRODUCT_VERSION|PRODUCT_VERSION|(?<![A-Z_])VERSION)"
        rf"\s*=\s*[\"']{SEMVER_CAPTURE}[\"']"
    ),
)


class VersionError(RuntimeError):
    """Raised when an active version declaration disagrees with VERSION."""


@dataclass(frozen=True)
class ArtifactStatus:
    path: Path
    created_at: str
    source_sha: str
    dirty: bool | None
    dirty_entry_count: int | None

    @property
    def classification(self) -> str:
        if "internal" in self.path.name or self.dirty is True:
            return "internal snapshot (not a formal release)"
        if self.dirty is False:
            return "clean build candidate (formal acceptance still required)"
        return "unclassified local artifact"


def read_version(root: Path = REPO_ROOT) -> str:
    path = root / "VERSION"
    try:
        version = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise VersionError(f"cannot read {path}: {exc}") from exc
    if not VERSION_RE.fullmatch(version):
        raise VersionError(f"VERSION is not a supported product version: {version!r}")
    return version


def nested_value(value: Any, keys: tuple[str, ...]) -> Any:
    for key in keys:
        if not isinstance(value, dict) or key not in value:
            return None
        value = value[key]
    return value


def check_version_alignment(root: Path = REPO_ROOT) -> list[str]:
    version = read_version(root)
    errors: list[str] = []

    for relative, keys in JSON_VERSION_FIELDS.items():
        path = root / relative
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            errors.append(f"{relative}: cannot read JSON: {exc}")
            continue
        declared = nested_value(value, keys)
        if declared != version:
            errors.append(f"{relative}: {'.'.join(keys)}={declared!r}, expected {version!r}")

    lock_path = root / "ui" / "package-lock.json"
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
        lock_root_version = nested_value(lock, ("packages", "", "version"))
        if lock_root_version != version:
            errors.append(
                "ui/package-lock.json: packages[''].version="
                f"{lock_root_version!r}, expected {version!r}"
            )
    except (OSError, json.JSONDecodeError):
        pass

    for relative in ACTIVE_VERSION_FILES:
        path = root / relative
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:
            errors.append(f"{relative}: cannot read: {exc}")
            continue
        declarations = {
            match.group(1)
            for pattern in PRODUCT_VERSION_PATTERNS
            for match in pattern.finditer(text)
        }
        competing = sorted(item for item in declarations if item != version)
        if version not in text:
            errors.append(f"{relative}: active product version {version!r} is not declared")
        if competing:
            errors.append(f"{relative}: competing active product versions: {', '.join(competing)}")

    makefile = (root / "Makefile").read_text(encoding="utf-8")
    expected_make_source = "ECHO_FOUNDER_VERSION ?= $(shell tr -d '[:space:]' < $(AIFIOS_HOME)/VERSION)"
    if expected_make_source not in makefile:
        errors.append("Makefile: ECHO_FOUNDER_VERSION must be read from VERSION")
    return errors


def git_text(root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=root,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def newest_artifact(version: str, root: Path = REPO_ROOT) -> ArtifactStatus | None:
    candidates = list((root / "dist").glob(f"Echo-Founder-{version}*-mac-*.dmg"))
    if not candidates:
        return None
    path = max(candidates, key=lambda item: item.stat().st_mtime)
    manifest_path = path.with_suffix(".manifest.json")
    manifest: dict[str, Any] = {}
    if manifest_path.is_file():
        try:
            loaded = json.loads(manifest_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                manifest = loaded
        except (OSError, json.JSONDecodeError):
            manifest = {}
    source = nested_value(manifest, ("package_manifest", "source_control"))
    if not isinstance(source, dict):
        source = {}
    created_at = manifest.get("created_at")
    if not isinstance(created_at, str) or not created_at:
        created_at = datetime.fromtimestamp(path.stat().st_mtime).astimezone().isoformat(timespec="seconds")
    dirty = source.get("dirty") if isinstance(source.get("dirty"), bool) else None
    dirty_count = source.get("dirty_entry_count")
    return ArtifactStatus(
        path=path,
        created_at=created_at,
        source_sha=str(source.get("current_sha") or "unknown"),
        dirty=dirty,
        dirty_entry_count=dirty_count if isinstance(dirty_count, int) else None,
    )


def print_status(root: Path = REPO_ROOT) -> None:
    version = read_version(root)
    branch = git_text(root, "branch", "--show-current")
    head = git_text(root, "rev-parse", "--short=12", "HEAD")
    dirty_lines = git_text(root, "status", "--porcelain=v1")
    dirty_count = 0 if not dirty_lines else len(dirty_lines.splitlines())
    artifact = newest_artifact(version, root)

    print(f"Product version: {version}")
    print(f"Source: {branch or '(detached)'} @ {head}; working tree changes: {dirty_count}")
    if artifact is None:
        print("Newest local artifact: none")
    else:
        print(f"Newest local artifact: {artifact.path.relative_to(root)}")
        print(f"Built at: {artifact.created_at}")
        print(
            f"Artifact source: {artifact.source_sha}; dirty={artifact.dirty}; "
            f"dirty entries={artifact.dirty_entry_count}"
        )
        print(f"Classification: {artifact.classification}")
    print("Version rules: docs/versioning.md")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail when active version declarations drift")
    args = parser.parse_args()
    try:
        errors = check_version_alignment()
    except VersionError as exc:
        print(f"FAIL product version: {exc}")
        return 1
    if errors:
        print("FAIL product version alignment")
        for error in errors:
            print(f"- {error}")
        return 1
    if args.check:
        print(f"PASS product version alignment: {read_version()}")
    else:
        print_status()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
