"""Unit tests must not silently spend a configured customer's service balance."""
from __future__ import annotations

import os

import pytest


@pytest.fixture(autouse=True)
def offline_layout_service(monkeypatch, tmp_path):
    # Tests may replace this with an explicit local fake. A live CLI/API run is
    # opt-in because --mode api can consume an independently configured account.
    if os.environ.get("ECHO_LIVE_MD2WECHAT_TEST") != "1":
        monkeypatch.setenv("MD2WECHAT_BINARY", str(tmp_path / "no-external-md2wechat"))
