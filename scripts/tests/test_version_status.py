from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "version_status.py"


def load_module():
    spec = importlib.util.spec_from_file_location("version_status_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_checked_in_product_version_is_aligned() -> None:
    module = load_module()

    assert module.read_version() == "0.2.0-beta.2"
    assert module.check_version_alignment() == []


def test_newest_artifact_reports_dirty_internal_snapshot(tmp_path: Path) -> None:
    module = load_module()
    dist = tmp_path / "dist"
    dist.mkdir()
    dmg = dist / "Echo-Founder-0.2.0-beta.2-internal-2026-08-25-mac-arm64.dmg"
    dmg.write_bytes(b"fixture")
    dmg.with_suffix(".manifest.json").write_text(
        json.dumps(
            {
                "created_at": "2026-08-25T09:31:59+08:00",
                "package_manifest": {
                    "source_control": {
                        "current_sha": "abc123",
                        "dirty": True,
                        "dirty_entry_count": 7,
                    }
                },
            }
        ),
        encoding="utf-8",
    )

    artifact = module.newest_artifact("0.2.0-beta.2", tmp_path)

    assert artifact is not None
    assert artifact.source_sha == "abc123"
    assert artifact.dirty_entry_count == 7
    assert artifact.classification == "internal snapshot (not a formal release)"
