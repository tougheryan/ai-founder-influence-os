from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = REPO_ROOT / "skills" / "manifest.json"
MANIFEST_CHECK = REPO_ROOT / "skills" / "content-runtime" / "scripts" / "check_manifest.py"
CONTRACT_CHECK = REPO_ROOT / "scripts" / "check_runtime_contracts.py"
INSTALL_SCRIPT = REPO_ROOT / "scripts" / "install.py"


def _load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _manifest() -> dict[str, object]:
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def test_manifest_tiers_cover_all_skills_once_and_default_to_production_core() -> None:
    manifest_check = _load_module("manifest_tier_check", MANIFEST_CHECK)
    manifest = _manifest()
    included = {item["name"] for item in manifest["included_skills"]}  # type: ignore[index]

    assert manifest_check.validate_capability_tiers(manifest, included) == []
    tiers = manifest["capability_tiers"]["tiers"]  # type: ignore[index]
    assert manifest["capability_tiers"]["default_tiers"] == ["core"]  # type: ignore[index]
    assert "content-package" in tiers["core"]["skills"]
    assert "baoyu-diagram" in tiers["optional"]["skills"]
    assert set(tiers) == {"core", "optional"}
    assert "content-angle" not in included
    assert "douyin-script" not in included


def test_manifest_tier_contract_rejects_optional_capabilities_in_the_default_surface() -> None:
    manifest_check = _load_module("manifest_tier_check_default", MANIFEST_CHECK)
    manifest = copy.deepcopy(_manifest())
    manifest["capability_tiers"]["default_tiers"] = ["core", "optional"]  # type: ignore[index]
    included = {item["name"] for item in manifest["included_skills"]}  # type: ignore[index]

    failures = manifest_check.validate_capability_tiers(manifest, included)

    assert "default_tiers must be [core]" in " ".join(failures)


def test_runtime_contract_keeps_only_the_active_install_surface() -> None:
    contracts = _load_module("skill_tier_contract_check", CONTRACT_CHECK)
    manifest = _manifest()
    included = {item["name"] for item in manifest["included_skills"]}  # type: ignore[index]

    contracts.check_skill_capability_tiers(manifest, included)


def test_installer_can_select_a_tier_without_changing_its_all_skills_default() -> None:
    installer = _load_module("skill_tier_installer", INSTALL_SCRIPT)
    manifest = _manifest()

    all_names = [item["name"] for item in installer.included_skills_for_tier(manifest, "all")]
    core_names = [item["name"] for item in installer.included_skills_for_tier(manifest, "core")]
    optional_names = [item["name"] for item in installer.included_skills_for_tier(manifest, "optional")]

    assert all_names == [item["name"] for item in manifest["included_skills"]]  # type: ignore[index]
    assert "content-package" in core_names
    assert "baoyu-diagram" in optional_names
    assert "content-angle" not in all_names
    assert "douyin-script" not in all_names
    assert set(core_names) | set(optional_names) == set(all_names)
