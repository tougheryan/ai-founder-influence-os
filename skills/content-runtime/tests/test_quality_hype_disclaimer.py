from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from quality_check import gate_checks


def _hype_gate(text: str) -> bool:
    return next(item for item in gate_checks("wechat", text, []) if item.id == "gate_no_severe_hype").passed


def test_explicit_no_guarantee_disclaimer_is_not_treated_as_hype() -> None:
    assert _hype_gate("这不是任何人可以照抄的结果，更不该被理解成收益保证。") is True


def test_positive_guarantee_remains_a_blocking_hype_signal() -> None:
    assert _hype_gate("我们保证收益，稳赚不赔。") is False
