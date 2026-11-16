from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "real_account_acceptance.py"


def load_module():
    spec = importlib.util.spec_from_file_location("real_account_acceptance", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def workspace_fixture(module, root: Path) -> tuple[Path, dict, dict]:
    workspace = root / "acceptance-workspace"
    workspace.mkdir(mode=0o700)
    state = {
        "schema": module.STATE_SCHEMA,
        "created_at": "2026-08-26T16:00:00+08:00",
        "product_version": module.gate.VERSION,
        "workspace_id": "acceptance-workspace-001",
        "release_root": "dist",
        "build": {"source_git_sha": "a" * 40},
        "run_id": "acceptance-run-001",
        "slug": "acceptance-topic",
    }
    record = json.loads(
        (REPO_ROOT / "quality" / "acceptance" / "real-account-acceptance.template.json").read_text(encoding="utf-8")
    )
    record["run"]["run_id"] = state["run_id"]
    record["run"]["slug"] = state["slug"]
    module.write_json(workspace / module.STATE_FILE, state, replace=False)
    module.write_json(workspace / module.RECORD_FILE, record, replace=False)
    return workspace, state, record


def material_artifact(module, state: dict) -> dict:
    kind = "material-import"
    role, producer = module.gate.REQUIRED_ARTIFACT_ROLE_AND_PRODUCER[kind]
    return {
        "schema": module.gate.DOMAIN_ARTIFACT_SCHEMA,
        "kind": kind,
        "role": role,
        "producer": producer,
        "result": "pass",
        "captured_at": "2026-08-26T16:01:00+08:00",
        "run_id": state["run_id"],
        "slug": state["slug"],
        "evidence_id": "material-evidence-001",
        "source_sha256": "b" * 64,
        "facts": dict(module.gate.REQUIRED_EVIDENCE_ASSERTIONS[kind]),
    }


def test_complete_historical_workspace_never_claims_current_release_eligibility(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_module()
    monkeypatch.setattr(module, 'load_workspace', lambda _: (tmp_path, {'product_version': module.gate.VERSION}, {'status': 'pass', 'attestation': {'signature_base64': 'fixture'}}))
    monkeypatch.setattr(module, 'binding_status', lambda *args: (True, []))
    monkeypatch.setattr(module, 'evidence_progress', lambda _: (set(module.gate.REQUIRED_ACCEPTANCE_EVIDENCE), set()))
    monkeypatch.setattr(module, 'fault_progress', lambda _: (set(module.REQUIRED_FAULT_SCENARIOS), set()))
    result = module.status_workspace(tmp_path)
    assert result['status'] == 'historical_record_complete'
    assert result['current_release_eligible'] is False and result['commercial_ready'] is False


def test_capture_accepts_only_matching_real_domain_artifact(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_module()
    workspace, state, _ = workspace_fixture(module, tmp_path)
    artifact = tmp_path / "material-import.json"
    artifact.write_text(json.dumps(material_artifact(module, state)), encoding="utf-8")
    monkeypatch.setattr(module, "binding_status", lambda state, release_root: (True, []))
    args = argparse.Namespace(
        workspace=workspace,
        release_root=tmp_path / "dist",
        artifact=artifact,
        observation="QA observed the authorized material import and isolated failure.",
        kind="material-import",
        scenario=None,
        replace=False,
    )

    result = module.capture(args)

    assert "material-import" in result["passed_evidence"]
    envelope = json.loads((workspace / "evidence" / "material-import.json").read_text(encoding="utf-8"))
    assert envelope["schema"] == module.gate.EVIDENCE_SCHEMA
    assert envelope["artifacts"][0]["sha256"] == module.sha256_file(workspace / "artifacts" / "material-import.json")
    record = json.loads((workspace / module.RECORD_FILE).read_text(encoding="utf-8"))
    row = next(item for item in record["evidence"] if item["kind"] == "material-import")
    assert row["result"] == "pass"


def test_capture_rejects_claims_that_do_not_match_required_facts(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_module()
    workspace, state, _ = workspace_fixture(module, tmp_path)
    payload = material_artifact(module, state)
    payload["facts"]["failed_file_isolated"] = False
    artifact = tmp_path / "invalid-material-import.json"
    artifact.write_text(json.dumps(payload), encoding="utf-8")
    monkeypatch.setattr(module, "binding_status", lambda state, release_root: (True, []))
    args = argparse.Namespace(
        workspace=workspace,
        release_root=tmp_path / "dist",
        artifact=artifact,
        observation="QA observed a result that must not be accepted as passing.",
        kind="material-import",
        scenario=None,
        replace=False,
    )

    with pytest.raises(module.AcceptanceWorkspaceError, match="failed_file_isolated"):
        module.capture(args)

    assert not (workspace / "evidence" / "material-import.json").exists()


def test_status_invalidates_workspace_when_frozen_binding_changes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_module()
    workspace, _, _ = workspace_fixture(module, tmp_path)
    monkeypatch.setattr(module, "binding_status", lambda state, release_root: (False, ["DMG SHA changed"]))

    result = module.status_workspace(workspace, release_root=tmp_path / "dist")

    assert result["status"] == "invalidated"
    assert result["binding_valid"] is False
    assert result["binding_errors"] == ["DMG SHA changed"]


def test_finalize_refuses_incomplete_evidence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    module = load_module()
    workspace, _, _ = workspace_fixture(module, tmp_path)
    monkeypatch.setattr(
        module,
        "status_workspace",
        lambda workspace, release_root: {
            "binding_valid": True,
            "binding_errors": [],
            "missing_evidence": ["platform-draft-fill"],
            "missing_fault_scenarios": ["network-offline"],
        },
    )
    args = argparse.Namespace(workspace=workspace, release_root=tmp_path / "dist")

    with pytest.raises(module.AcceptanceWorkspaceError, match="all main evidence"):
        module.finalize(args)
