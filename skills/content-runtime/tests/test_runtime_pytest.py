from __future__ import annotations

from test_runtime import run


def test_runtime_suite() -> None:
    assert run() == 0

