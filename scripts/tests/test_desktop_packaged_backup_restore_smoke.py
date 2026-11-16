from __future__ import annotations

import importlib.util
import json
import plistlib
import shutil
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "desktop_packaged_backup_restore_smoke.py"


def load_module():
    spec = importlib.util.spec_from_file_location("desktop_packaged_backup_restore_smoke", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_packaged_paths_use_plist_executable_and_require_backup_module(tmp_path: Path) -> None:
    module = load_module()
    app = tmp_path / "Echo Founder.app"
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Resources" / "app" / "electron").mkdir(parents=True)
    with (contents / "Info.plist").open("wb") as handle:
        plistlib.dump({"CFBundleExecutable": "Echo Founder"}, handle)
    executable = contents / "MacOS" / "Echo Founder"
    executable.write_bytes(b"runtime")
    backup_module = contents / "Resources" / "app" / "electron" / "project-backup.cjs"
    backup_module.write_text("module.exports = {};\n", encoding="utf-8")

    assert module.packaged_paths(app) == (executable.resolve(), backup_module.resolve())

    backup_module.unlink()
    with pytest.raises(RuntimeError, match="backup module is missing"):
        module.packaged_paths(app)


def test_markdown_records_security_and_corruption_checks() -> None:
    module = load_module()
    body = module.render_markdown({
        "status": "pass",
        "app": "Echo Founder.app",
        "checks": {
            "schema": "aifios.project-backup.v1",
            "fileCount": 3,
            "secretsExcluded": True,
            "transientDataExcluded": True,
            "cookiesDatabaseExcluded": True,
            "redactedTikomniRawPreserved": True,
            "schemaMigrationBackupCreated": True,
            "corruptionRejected": True,
            "recomputedManifestAttackRejected": True,
        },
    })

    assert "状态：`pass`" in body
    assert "凭据剔除：`True`" in body
    assert "损坏包拒绝：`True`" in body
    assert "Chromium Cookies 剔除：`True`" in body
    assert "已脱敏 TikOmni raw 保留：`True`" in body
    assert "重算 manifest 攻击拒绝：`True`" in body


def test_failure_record_never_persists_raw_exception_canaries() -> None:
    module = load_module()
    raw = RuntimeError(
        "Authorization: Bearer report-secret pairingToken=pair-secret "
        "/Users/alice/private /private/tmp/customer /Volumes/Customer/project"
    )

    record = module.safe_failure_record(raw)

    assert record == {
        "error_code": "packaged_backup_restore_smoke_failed",
        "error_summary": "Packaged backup/restore smoke failed.",
    }
    serialized = json.dumps(record)
    assert "report-secret" not in serialized
    assert "pair-secret" not in serialized
    assert "/Users/" not in serialized
    assert "/private/tmp" not in serialized
    assert "/Volumes/" not in serialized


def test_node_harness_exercises_migration_redacted_raw_cookie_and_rehashed_attack(tmp_path: Path) -> None:
    node = shutil.which("node")
    if not node:
        pytest.skip("Node.js is required for the packaged backup harness contract")
    module = load_module()
    harness = tmp_path / "harness.cjs"
    harness.write_text(module.HARNESS, encoding="utf-8")
    backup_module = REPO_ROOT / "ui" / "electron" / "project-backup.cjs"

    completed = subprocess.run(
        [node, str(harness), str(backup_module), str(tmp_path / "work")],
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
    )

    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout.splitlines()[-1])
    assert result["status"] == "pass"
    assert result["cookiesDatabaseExcluded"] is True
    assert result["redactedTikomniRawPreserved"] is True
    assert result["schemaMigrationBackupCreated"] is True
    assert result["recomputedManifestAttackRejected"] is True
