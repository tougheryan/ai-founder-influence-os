#!/usr/bin/env python3
"""Install AIFIOS skills into a Codex-compatible skills directory."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
MANIFEST = REPO_ROOT / "skills" / "manifest.json"
INSTALL_TIERS = ("all", "core", "optional")


def load_manifest() -> dict[str, Any]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def remove_target(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.is_dir():
        shutil.rmtree(path)


def install_skill(source: Path, target: Path, mode: str, force: bool, dry_run: bool) -> str:
    if target.exists() or target.is_symlink():
        if target.is_symlink() and target.resolve(strict=False) == source.resolve(strict=False):
            return f"OK already linked {target.name}"
        if not force:
            raise FileExistsError(f"{target} already exists; rerun with FORCE=1 to replace it")
        if dry_run:
            return f"DRY remove {target}"
        remove_target(target)

    if dry_run:
        return f"DRY install {target.name} <- {source}"

    target.parent.mkdir(parents=True, exist_ok=True)
    if mode == "copy":
        shutil.copytree(source, target, ignore=shutil.ignore_patterns(".git", "__pycache__", ".DS_Store", "*.pyc"))
    else:
        target.symlink_to(source, target_is_directory=True)
    return f"OK installed {target.name} ({mode})"


def external_plan(manifest: dict[str, Any]) -> list[str]:
    lines = ["External dependency plan:"]
    for item in manifest.get("external_skills", []):
        name = item.get("name", "")
        status = item.get("status", "unknown")
        required_for = ", ".join(item.get("required_for", []))
        resolution = item.get("resolution", "No resolution documented.")
        lines.append(f"- {name} [{status}]")
        lines.append(f"  Used for: {required_for or 'n/a'}")
        lines.append(f"  Resolution: {resolution}")
    return lines


def included_skills_for_tier(manifest: dict[str, Any], tier: str) -> list[dict[str, Any]]:
    """Select an installable production or optional capability tier."""
    included = manifest.get("included_skills", [])
    if not isinstance(included, list):
        raise ValueError("manifest included_skills must be a list")
    if tier == "all":
        return included
    tiers = ((manifest.get("capability_tiers") or {}).get("tiers") or {})
    definition = tiers.get(tier)
    if not isinstance(definition, dict) or not isinstance(definition.get("skills"), list):
        raise ValueError(f"manifest does not define capability tier: {tier}")
    names = set(definition["skills"])
    return [item for item in included if item.get("name") in names]


def main() -> int:
    parser = argparse.ArgumentParser(description="Install AIFIOS skills")
    parser.add_argument("--install-dir", default="~/.agents/skills", help="target skills directory")
    parser.add_argument("--mode", choices=["symlink", "copy"], default="symlink", help="installation mode")
    parser.add_argument("--force", action="store_true", help="replace existing targets")
    parser.add_argument("--dry-run", action="store_true", help="show actions without changing files")
    parser.add_argument(
        "--tier",
        choices=INSTALL_TIERS,
        default="all",
        help="install the active production surface or one active capability tier",
    )
    parser.add_argument("--external-plan", action="store_true", help="print external dependency plan and exit")
    args = parser.parse_args()

    install_dir = Path(args.install_dir).expanduser().resolve(strict=False)
    manifest = load_manifest()
    if args.external_plan:
        for line in external_plan(manifest):
            print(line)
        return 0
    messages: list[str] = []

    try:
        for item in included_skills_for_tier(manifest, args.tier):
            name = item["name"]
            source = (REPO_ROOT / item["path"]).parent.resolve(strict=True)
            target = install_dir / name
            messages.append(install_skill(source, target, args.mode, args.force, args.dry_run))
    except Exception as exc:
        for message in messages:
            print(message)
        print(f"FAIL {exc}")
        return 1

    for message in messages:
        print(message)
    print(f"PASS install target: {install_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
