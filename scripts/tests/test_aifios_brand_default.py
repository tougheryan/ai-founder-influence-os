from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "aifios.py"


def load_module():
    spec = importlib.util.spec_from_file_location("aifios_under_test", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_default_project_uses_echo_founder_and_preserves_an_existing_legacy_directory(tmp_path, monkeypatch) -> None:
    module = load_module()
    preferred = tmp_path / "Echo Founder"
    legacy = tmp_path / "ai-content-system"
    module.DEFAULT_PROJECT = str(preferred)
    module.LEGACY_DEFAULT_PROJECT = str(legacy)
    monkeypatch.delenv("AIFIOS_PROJECT", raising=False)

    legacy.mkdir()
    selected, _ = module.extract_project([])
    assert selected == str(legacy.resolve())

    preferred.mkdir()
    selected, _ = module.extract_project([])
    assert selected == str(preferred.resolve())


def test_explicit_project_keeps_precedence_over_branded_and_legacy_defaults(tmp_path, monkeypatch) -> None:
    module = load_module()
    explicit = tmp_path / "client-project"
    monkeypatch.setenv("AIFIOS_PROJECT", str(explicit))

    selected, _ = module.extract_project([])

    assert selected == str(explicit.resolve())
