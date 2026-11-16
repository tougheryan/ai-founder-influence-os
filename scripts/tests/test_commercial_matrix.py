from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "scripts" / "check_commercial_matrix.py"


def load_module():
    spec = importlib.util.spec_from_file_location("check_commercial_matrix", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_checked_in_matrix_covers_every_commercial_source_surface() -> None:
    module = load_module()

    counts = module.validate_matrix()

    assert counts == {
        "pages": 14,
        "api_routes": 78,
        "desktop_bridges": 23,
        "runtime_scripts": 64,
        "data_contracts": 33,
    }


def test_duplicate_or_unknown_status_fails_closed(tmp_path: Path) -> None:
    module = load_module()
    matrix = json.loads(module.MATRIX_PATH.read_text(encoding="utf-8"))
    matrix["inventories"]["pages"][0]["status"] = "maybe"
    path = tmp_path / "matrix.json"
    path.write_text(json.dumps(matrix, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(module.MatrixError, match="invalid status"):
        module.validate_matrix(path=path)
