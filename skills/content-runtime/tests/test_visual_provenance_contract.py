from __future__ import annotations

import importlib.util
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
CONTRACT_CHECK = REPO_ROOT / "scripts" / "check_runtime_contracts.py"


def load_contract_checker():
    spec = importlib.util.spec_from_file_location("runtime_contract_checker", CONTRACT_CHECK)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_visual_provider_contract_requires_provenance_for_executable_provider() -> None:
    checker = load_contract_checker()

    errors = checker.validate_visual_provider_registry([
        {"id": "bad", "status": "verified", "tasks": ["xhs_cards"]},
    ])

    assert errors == [
        "bad: missing license",
        "bad: missing upstream",
        "bad: missing pinned_revision",
        "bad: missing permitted_use",
        "bad: missing license_review",
    ]


def test_visual_provider_contract_allows_incomplete_candidate() -> None:
    checker = load_contract_checker()

    assert checker.validate_visual_provider_registry([
        {"id": "research-only", "status": "candidate", "tasks": ["diagram"]},
    ]) == []


def test_visual_provider_contract_rejects_machine_specific_source_paths() -> None:
    checker = load_contract_checker()

    errors = checker.validate_visual_provider_registry([{
        "id": "local-leak",
        "status": "verified",
        "license": "MIT",
        "upstream": "https://example.com/source",
        "pinned_revision": "abc123",
        "permitted_use": "local rendering",
        "license_review": "approved",
        "source": "/Users/developer/.codex/skills/private/SKILL.md",
    }])

    assert errors == ["local-leak: source must be portable, not an absolute local path"]


def test_xhs_card_license_metadata_matches_the_vendored_agpl_license() -> None:
    package = json.loads((REPO_ROOT / "skills" / "xhs-card" / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((REPO_ROOT / "skills" / "xhs-card" / "package-lock.json").read_text(encoding="utf-8"))
    providers = json.loads(
        (REPO_ROOT / "skills" / "content-runtime" / "config" / "visual_providers.json").read_text(encoding="utf-8")
    )
    provider = next(item for item in providers if item["id"] == "xhs-card")

    assert provider["license"] == "AGPL-3.0-only"
    assert package["license"] == "AGPL-3.0-only"
    assert lock["packages"][""]["license"] == "AGPL-3.0-only"
    assert "GNU AFFERO GENERAL PUBLIC LICENSE" in (REPO_ROOT / "skills" / "xhs-card" / "LICENSE").read_text(encoding="utf-8")
    for readme_name in ("README.md", "README.en.md"):
        readme = (REPO_ROOT / "skills" / "xhs-card" / readme_name).read_text(encoding="utf-8")
        assert "AGPL-3.0-only" in readme
        assert "LICENSE" in readme
        assert "No paid-only distribution" not in readme
        assert "可以收费和商业使用" not in readme


def test_permitted_baoyu_visual_skills_are_vendored_and_registered() -> None:
    providers = json.loads(
        (REPO_ROOT / "skills" / "content-runtime" / "config" / "visual_providers.json").read_text(encoding="utf-8")
    )
    manifest = json.loads((REPO_ROOT / "skills" / "manifest.json").read_text(encoding="utf-8"))
    by_id = {item["id"]: item for item in providers}
    included = {item["name"]: item for item in manifest["included_skills"]}

    for skill_name, task in (("baoyu-diagram", "diagram"), ("baoyu-comic", "comic")):
        skill_dir = REPO_ROOT / "skills" / skill_name
        assert (skill_dir / "SKILL.md").is_file()
        assert (skill_dir / "LICENSE").is_file()
        assert included[skill_name]["path"] == f"skills/{skill_name}/SKILL.md"
        assert by_id[skill_name]["tasks"] == [task]
        assert by_id[skill_name]["pinned_revision"] == "6b7a2e417500561a5ecdd0b168332f4142584617"
