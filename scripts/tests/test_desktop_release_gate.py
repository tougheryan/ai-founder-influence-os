from __future__ import annotations

import importlib.util
import sys
from argparse import Namespace
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "desktop_release_gate.py"


def load_module():
    spec = importlib.util.spec_from_file_location("desktop_release_gate", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def step_labels(mode: str) -> list[str]:
    module = load_module()
    args = Namespace(mode=mode, require_external_ready=False)
    return [label for label, _command, _timeout in module.gate_steps(args)]


def test_quick_gate_uses_dmg_only_minimal_artifact_checks() -> None:
    labels = step_labels("quick")

    assert labels == [
        "desktop-check",
        "runtime-contracts",
        "content-loop-check",
        "desktop-minimal-artifact-check",
        "desktop-dmg-smoke",
    ]
    assert "desktop-packaged-smoke" not in labels
    assert "desktop-packaged-open-smoke" not in labels


def test_standard_gate_keeps_expanded_app_release_checks() -> None:
    labels = step_labels("standard")

    assert "desktop-package" in labels
    assert "desktop-dmg" in labels
    assert "desktop-packaged-smoke" in labels
    assert "desktop-dmg-smoke" in labels
