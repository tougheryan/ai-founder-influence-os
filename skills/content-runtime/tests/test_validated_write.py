"""A rejected generated report must not replace a usable current artifact."""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from content_runtime import ContentRuntime, RuntimeOutputValidationError  # noqa: E402


def valid_body() -> str:
    return (Path(__file__).parent / "fixtures" / "intake_valid.md").read_text(encoding="utf-8").split("---", 2)[-1].strip()


def test_rejected_first_intake_does_not_become_a_current_artifact(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(run_id="new-draft")
    before = runtime.run_state(run_id=run["run_id"])
    with pytest.raises(RuntimeOutputValidationError) as caught:
        runtime.write("intake", run["slug"], "Incomplete report", "test", run["run_id"], require_valid=True)
    assert caught.value.validation["valid"] is False
    assert runtime.run_state(run_id=run["run_id"]) == before
    assert list((tmp_path / "pipeline" / "intake").glob("*.md")) == []


def test_rejected_replacement_preserves_run_indexes_approvals_and_old_files(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(run_id="existing-draft")
    saved = runtime.write("intake", run["slug"], valid_body(), "test", run["run_id"], require_valid=True)
    assert saved["validation"]["valid"] is True
    runtime.write("blueprint", run["slug"], "Previously saved plan", "test", run["run_id"])
    run_file = Path(saved["run_file"])
    state = json.loads(run_file.read_text())
    state["approvals"] = {"topic_template": {"approved_at": "2026-09-16T00:00:00", "sha256": "test-old-digest"}}
    run_file.write_text(json.dumps(state), encoding="utf-8")
    before = {path: path.read_bytes() for path in tmp_path.rglob("*") if path.is_file() and path.suffix != ".lock"}
    with pytest.raises(RuntimeOutputValidationError):
        runtime.write("intake", run["slug"], "Incomplete replacement", "test", run["run_id"], require_valid=True)
    after = {path: path.read_bytes() for path in tmp_path.rglob("*") if path.is_file() and path.suffix != ".lock"}
    assert after == before


def test_validation_exception_does_not_leave_a_candidate_or_mutate_run(tmp_path: Path, monkeypatch) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(run_id="validation-exception")
    before = runtime.run_state(run_id=run["run_id"])
    def fail(*_args):
        raise OSError("read interrupted")
    monkeypatch.setattr(runtime, "validate", fail)
    with pytest.raises(OSError, match="read interrupted"):
        runtime.write("intake", run["slug"], valid_body(), "test", run["run_id"], require_valid=True)
    assert runtime.run_state(run_id=run["run_id"]) == before
    assert list((tmp_path / "pipeline" / "intake").glob("*.md")) == []
