#!/usr/bin/env python3
"""Validate the AIFIOS skills manifest against files in the repository."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFEST = REPO_ROOT / "skills" / "manifest.json"
CAPABILITY_TIER_SCHEMA = "aifios.skill-capability-tiers.v2"
CAPABILITY_TIERS = ("core", "optional")
CORE_PRODUCTION_SKILLS = {
    "content-runtime",
    "content-intake",
    "content-hit-collector",
    "content-validate",
    "content-blueprint",
    "wechat-writer",
    "content-package",
    "content-visual",
    "xhs-card",
    "dbs-wechat-html",
}
OPTIONAL_ENHANCEMENT_SKILLS = {"baoyu-diagram", "baoyu-comic"}
RETIRED_COMPATIBILITY_SOURCE_SKILLS = {
    "content",
    "content-angle",
    "content-audit",
    "content-breakdown",
    "content-compliance",
    "content-dbs-fusion",
    "content-performance-collector",
    "content-prelaunch",
    "content-repurpose",
    "content-review",
    "content-twin",
    "douyin-script",
    "self-archive",
}
EXPOSED_SKILLS = CORE_PRODUCTION_SKILLS | OPTIONAL_ENHANCEMENT_SKILLS


def _load_manifest() -> dict[str, Any]:
    if not MANIFEST.exists():
        raise FileNotFoundError(f"manifest not found: {MANIFEST}")
    return json.loads(MANIFEST.read_text(encoding="utf-8"))


def _fail(message: str) -> str:
    return f"FAIL {message}"


def validate_capability_tiers(data: dict[str, Any], included_names: set[str]) -> list[str]:
    """Keep the installable surface limited to active production domains."""
    failures: list[str] = []
    config = data.get("capability_tiers")
    if not isinstance(config, dict):
        return [_fail("capability_tiers must be an object")]
    if config.get("schema") != CAPABILITY_TIER_SCHEMA:
        failures.append(_fail("capability_tiers has an unsupported schema"))
    if config.get("default_tiers") != ["core"]:
        failures.append(_fail("capability_tiers default_tiers must be [core]"))

    tiers = config.get("tiers")
    if not isinstance(tiers, dict) or set(tiers) != set(CAPABILITY_TIERS):
        return failures + [_fail("capability_tiers must define exactly core and optional")]

    names_by_tier: dict[str, set[str]] = {}
    seen: set[str] = set()
    for tier in CAPABILITY_TIERS:
        definition = tiers.get(tier)
        if not isinstance(definition, dict):
            failures.append(_fail(f"capability tier {tier} must be an object"))
            continue
        if not isinstance(definition.get("label"), str) or not definition["label"].strip():
            failures.append(_fail(f"capability tier {tier} missing label"))
        if not isinstance(definition.get("description"), str) or not definition["description"].strip():
            failures.append(_fail(f"capability tier {tier} missing description"))
        skills = definition.get("skills")
        if not isinstance(skills, list) or not skills or not all(isinstance(name, str) and name for name in skills):
            failures.append(_fail(f"capability tier {tier} must declare non-empty skills"))
            continue
        tier_names = set(skills)
        if len(tier_names) != len(skills):
            failures.append(_fail(f"capability tier {tier} contains duplicate skills"))
        overlap = seen & tier_names
        if overlap:
            failures.append(_fail(f"capability tiers overlap: {', '.join(sorted(overlap))}"))
        seen.update(tier_names)
        names_by_tier[tier] = tier_names

    if seen != included_names:
        missing = sorted(included_names - seen)
        extra = sorted(seen - included_names)
        if missing:
            failures.append(_fail(f"capability tiers omit included skills: {', '.join(missing)}"))
        if extra:
            failures.append(_fail(f"capability tiers reference unknown skills: {', '.join(extra)}"))

    core = names_by_tier.get("core", set())
    optional = names_by_tier.get("optional", set())
    if core != CORE_PRODUCTION_SKILLS:
        failures.append(_fail("core tier must contain exactly the default production capabilities"))
    if optional != OPTIONAL_ENHANCEMENT_SKILLS:
        failures.append(_fail("optional tier must contain exactly the approved creative enhancements"))
    if included_names != EXPOSED_SKILLS:
        failures.append(_fail("included_skills must contain exactly the active production and enhancement skills"))
    return failures


def validate_manifest() -> list[str]:
    data = _load_manifest()
    failures: list[str] = []

    for name, path in data.get("runtime", {}).get("entrypoints", {}).items():
        if not path:
            failures.append(_fail(f"entrypoint {name} missing path"))
            continue
        target = REPO_ROOT / path
        if not target.exists():
            failures.append(_fail(f"entrypoint {name} path missing: {path}"))

    seen: set[str] = set()
    for item in data.get("included_skills", []):
        name = item.get("name")
        path = item.get("path")
        if not name:
            failures.append(_fail("included skill missing name"))
            continue
        if name in seen:
            failures.append(_fail(f"duplicate included skill: {name}"))
        seen.add(name)
        if not path:
            failures.append(_fail(f"{name} missing path"))
            continue
        target = REPO_ROOT / path
        if not target.exists():
            failures.append(_fail(f"{name} path missing: {path}"))
            continue
        text = target.read_text(encoding="utf-8")
        expected = f"name: {name}"
        if expected not in text:
            failures.append(_fail(f"{name} SKILL.md missing frontmatter name"))

    actual_skills = {
        p.parent.name
        for p in (REPO_ROOT / "skills").glob("*/SKILL.md")
    }
    if actual_skills - seen != RETIRED_COMPATIBILITY_SOURCE_SKILLS:
        unexpected = sorted((actual_skills - seen) - RETIRED_COMPATIBILITY_SOURCE_SKILLS)
        missing = sorted(RETIRED_COMPATIBILITY_SOURCE_SKILLS - (actual_skills - seen))
        details = []
        if unexpected:
            details.append("unclassified source skills: " + ", ".join(unexpected))
        if missing:
            details.append("missing compatibility source skills: " + ", ".join(missing))
        failures.append(_fail("; ".join(details) or "compatibility source skill inventory drifted"))

    failures.extend(validate_capability_tiers(data, seen))

    external_seen = set()
    for item in data.get("external_skills", []):
        name = item.get("name")
        if not name:
            failures.append(_fail("external skill missing name"))
            continue
        if name in external_seen:
            failures.append(_fail(f"duplicate external skill: {name}"))
        external_seen.add(name)
        if not item.get("status"):
            failures.append(_fail(f"{name} missing status"))
        if not item.get("resolution"):
            failures.append(_fail(f"{name} missing resolution"))

    return failures


def main() -> int:
    try:
        failures = validate_manifest()
    except Exception as exc:
        print(_fail(str(exc)))
        return 1

    if failures:
        for failure in failures:
            print(failure)
        return 1

    print(f"PASS manifest: {MANIFEST.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
