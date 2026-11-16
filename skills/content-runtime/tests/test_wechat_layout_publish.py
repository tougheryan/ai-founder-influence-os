"""Exercise the renderer boundary, not just the typography transform."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import visual_publish as publish


TITLE = "工具如何帮上忙，先看任务？"
BODY = "开头正文。\n\n**先看任务**\n\n说明。[出处](https://example.com/source)"
RAW_HTML = (
    '<section style="padding:8px 12px;box-sizing:border-box;">'
    f'<h1 style="font-size:26px;color:#4B6EF5;">{TITLE}</h1>'
    '<p style="font-size:16px;">开头正文。</p>'
    '<h2 style="font-size:22px;color:#4B6EF5;">先看任务</h2>'
    '<p>说明。<a href="https://example.com/source">出处</a></p></section>'
)


def layout_for(source: Path) -> dict:
    return {
        "theme": "elegant-blue",
        "source_package_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "refinement": {
            "profile": "title-spacing-v1",
            "title_lines": ["工具如何帮上忙，", "先看任务？"],
            "heading_blocks": [{
                "block_index": 1,
                "text_sha256": hashlib.sha256("先看任务".encode()).hexdigest(),
                "segments": ["先看任务"],
            }],
        },
    }


@pytest.mark.parametrize("line_break", ["", "\r\n"])
def test_render_records_real_raw_and_refined_provenance(tmp_path, monkeypatch, line_break):
    source = tmp_path / "package.md"
    source.write_text(BODY)
    layout = layout_for(source)
    destination = tmp_path / "wechat-article.html"
    captured = []
    raw = RAW_HTML.replace("</p>", "</p>" + line_break).encode()
    monkeypatch.setenv("MD2WECHAT_BINARY", "test-md2wechat")

    def convert(command, **kwargs):
        captured.append(Path(command[2]).read_text())
        assert command[command.index("--theme") + 1] == "elegant-blue"
        assert "--preview" in command and "--draft" not in command and "--upload" not in command
        Path(command[command.index("--output") + 1]).write_bytes(raw)
        response = {"success": True, "data": {"theme": "elegant-blue", "mode": "api", "preview": True, "upload": False, "draft": False}}
        return subprocess.CompletedProcess(command, 0, json.dumps(response), "")

    monkeypatch.setattr(publish.subprocess, "run", convert)
    result = publish._render_md2wechat_html(
        destination, TITLE, BODY, "elegant-blue", wechat_layout=layout,
        source_package_sha256=layout["source_package_sha256"],
    )
    assert "## 先看任务" in captured[0]
    assert "**先看任务**" not in captured[0]
    assert result["base_renderer"] == "md2wechat-cli"
    assert result["base_theme"] == "elegant-blue"
    assert result["local_refinements"] == layout["refinement"]
    assert result["output_is_raw_api_result"] is False
    assert result["raw_html_sha256"] == hashlib.sha256(raw).hexdigest()
    assert (tmp_path / result["raw_html_path"]).read_bytes() == raw
    refined = destination.read_text()
    assert re.findall(r'<p\b.*?</p>', refined) == re.findall(r'<p\b.*?</p>', RAW_HTML)
    assert refined != RAW_HTML


def test_invalid_utf8_is_rejected_instead_of_silently_dropping_bytes(tmp_path, monkeypatch):
    source = tmp_path / "package.md"
    source.write_text(BODY)
    layout = layout_for(source)
    monkeypatch.setenv("MD2WECHAT_BINARY", "test-md2wechat")

    def convert(command, **kwargs):
        Path(command[command.index("--output") + 1]).write_bytes(RAW_HTML.encode() + b"\xff")
        return subprocess.CompletedProcess(command, 0, json.dumps({
            "success": True, "data": {"theme": "elegant-blue", "mode": "api", "preview": True, "upload": False, "draft": False},
        }), "")

    monkeypatch.setattr(publish.subprocess, "run", convert)
    with pytest.raises(publish.VisualOutputError, match="编码无效"):
        publish._render_md2wechat_html(
            tmp_path / "out.html", TITLE, BODY, "elegant-blue", wechat_layout=layout,
            source_package_sha256=layout["source_package_sha256"],
        )


def test_source_change_is_rejected_before_conversion(tmp_path, monkeypatch):
    source = tmp_path / "package.md"
    source.write_text(BODY)
    layout = layout_for(source)
    monkeypatch.setenv("MD2WECHAT_BINARY", "test-md2wechat")
    monkeypatch.setattr(publish.subprocess, "run", lambda *a, **k: pytest.fail("must not call renderer"))
    with pytest.raises(publish.VisualOutputError):
        publish._render_md2wechat_html(
            tmp_path / "out.html", TITLE, BODY, "elegant-blue", wechat_layout=layout,
            source_package_sha256="f" * 64,
        )


def test_service_response_cannot_mislabel_the_actual_theme(tmp_path, monkeypatch):
    source = tmp_path / "package.md"
    source.write_text(BODY)
    layout = layout_for(source)
    monkeypatch.setenv("MD2WECHAT_BINARY", "test-md2wechat")

    def convert(command, **kwargs):
        Path(command[command.index("--output") + 1]).write_text(RAW_HTML)
        return subprocess.CompletedProcess(command, 0, json.dumps({
            "success": True, "data": {"theme": "wechat-native", "mode": "api", "preview": True, "upload": False, "draft": False},
        }), "")

    monkeypatch.setattr(publish.subprocess, "run", convert)
    with pytest.raises(publish.VisualOutputError, match="实际主题"):
        publish._render_md2wechat_html(
            tmp_path / "out.html", TITLE, BODY, "elegant-blue", wechat_layout=layout,
            source_package_sha256=layout["source_package_sha256"],
        )


def test_requested_refinement_failure_never_returns_basic_fallback(tmp_path, monkeypatch):
    source = tmp_path / "package.md"
    source.write_text(BODY)
    layout = layout_for(source)
    output_root = tmp_path / "pipeline/visual/test/publish/r002"
    output_root.mkdir(parents=True)
    task = {"output": "pipeline/visual/test/publish/r002/wechat/wechat-article.html",
            "source": "package.md", "layout_style": "elegant-blue",
            "payload": {"title": TITLE, "body": BODY, "wechat_layout": layout}}

    def unavailable(*args, **kwargs):
        raise publish.VisualOutputError("service unavailable")

    monkeypatch.setattr(publish, "_render_md2wechat_html", unavailable)
    monkeypatch.setattr(publish, "_render_html", lambda *a, **k: pytest.fail("must not silently fall back"))
    with pytest.raises(publish.VisualOutputError, match="指定排版未完成"):
        publish._render_wechat_layout_package(tmp_path, task, output_root, [])
    assert not (output_root / "wechat/layout-options.json").exists()
