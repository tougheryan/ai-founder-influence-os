from __future__ import annotations

import copy
import hashlib
from pathlib import Path
import re
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from wechat_fidelity import _source_blocks, check_wechat_html
from wechat_layout_refinement import (
    prepare_wechat_markdown,
    refine_wechat_html,
    validate_refinement_source,
    validate_wechat_layout,
)


PACKAGE_SHA = "a" * 64
TITLE = "保留经验，开始尝试"
BODY = "第一段。\n\n**找到问题，明确边界**\n\n正文。[依据](https://example.org/article?a=1&b=2)\n\n**这是普通加粗句。**"
BASE_STYLE = "font-size: 26px; color: #4B6EF5; margin-bottom: 28px; line-height: 1.4em; padding-bottom: 4px; letter-spacing: 0.5px; border-left: 5px solid #4B6EF5;"
H2_STYLE = "font-size: 22px; color: #4B6EF5; margin-top: 36px; margin-bottom: 24px; line-height: 1.4em; padding-left: 10px;"
RAW = (
    '<section style="padding: 8px 12px; width: 100%;">'
    f'<h1 style="{BASE_STYLE}">{TITLE}</h1>'
    '<p style="font-size:16px;line-height:1.75em;">第一段。</p>'
    f'<h2 style="{H2_STYLE}">找到问题，明确边界</h2>'
    '<p>正文。<a href="https://example.org/article?a=1&amp;b=2">依据</a></p>'
    '<p><strong>这是普通加粗句。</strong></p></section>'
)


def anchor(body, index, segments=None):
    text = _source_blocks("", body)[0][index + 1]
    return {"block_index": index, "text_sha256": hashlib.sha256(text.encode()).hexdigest(), "segments": segments or [text]}


def layout(body=BODY, title=TITLE, index=1, segments=None):
    return {
        "theme": "elegant-blue",
        "source_package_sha256": PACKAGE_SHA,
        "refinement": {
            "profile": "title-spacing-v1",
            "title_lines": [title],
            "heading_blocks": [anchor(body, index, segments)],
        },
    }


def test_realistic_article_refinement_preserves_unselected_bold_paragraph_and_links():
    choice = layout(segments=["找到问题，", "明确边界"])
    choice["refinement"]["title_lines"] = ["保留经验，", "开始尝试"]
    prepared = prepare_wechat_markdown(TITLE, BODY, choice, PACKAGE_SHA)
    assert "## 找到问题，明确边界" in prepared
    assert "**这是普通加粗句。**" in prepared
    assert _source_blocks(TITLE, prepared.split("\n\n", 1)[1]) == _source_blocks(TITLE, BODY)
    refined = refine_wechat_html(RAW, TITLE, BODY, choice, PACKAGE_SHA)
    assert '<span style="display:block;white-space:nowrap;">保留经验，</span><span style="display:block;white-space:nowrap;">开始尝试</span>' in refined
    assert '<span style="display:inline-block;white-space:nowrap;">找到问题，</span><span style="display:inline-block;white-space:nowrap;">明确边界</span>' in refined
    assert 'padding: 20px 16px 24px;' in refined
    assert 'font-size: 20px;' in refined
    assert re.findall(r"<p\b.*?</p>", refined) == re.findall(r"<p\b.*?</p>", RAW)
    assert check_wechat_html(TITLE, BODY, refined)["status"] == "pass"


def test_title_without_comma_uses_explicit_segments_and_single_heading_stays_plain():
    title = "无需逗号的标题"
    body = "**简短小节**"
    choice = layout(body, title, 0)
    choice["refinement"]["title_lines"] = ["无需逗号", "的标题"]
    raw = f'<section style="padding:8px 12px"><h1 style="{BASE_STYLE}">{title}</h1><h2 style="{H2_STYLE}">简短小节</h2></section>'
    result = refine_wechat_html(raw, title, body, choice, PACKAGE_SHA)
    assert '>无需逗号</span><span style="display:block;white-space:nowrap;">的标题</span>' in result
    assert re.search(r'<h2[^>]*>简短小节</h2>', result)


def test_duplicate_heading_text_is_selected_by_source_position():
    body = "**同名小节**\n\n保留正文。\n\n**同名小节**"
    choice = layout(body, index=2)
    prepared = prepare_wechat_markdown(TITLE, body, choice, PACKAGE_SHA)
    assert prepared == f"# {TITLE}\n\n**同名小节**\n\n保留正文。\n\n## 同名小节\n"
    raw = f'<section style="padding:8px"><h1 style="{BASE_STYLE}">{TITLE}</h1><p><strong>同名小节</strong></p><p>保留正文。</p><h2 style="{H2_STYLE}">同名小节</h2></section>'
    result = refine_wechat_html(raw, TITLE, body, choice, PACKAGE_SHA)
    assert '<p><strong>同名小节</strong></p>' in result
    assert result.count('font-size: 20px;') == 1


@pytest.mark.parametrize("body", [
    "> **引用标题**",
    "- **列表标题**",
    "1. **有序列表标题**",
    "```text\n**代码标题**\n```",
    "~~~text\n**代码标题**\n~~~",
    "    **缩进代码**",
    "普通正文",
    "**不是独立段落**\n还有下一行",
    "**含有 [链接](https://example.org) 的标题**",
    "<!--\n**注释标题**\n-->\n\n保留正文。",
])
def test_nonheading_blocks_cannot_be_promoted_even_with_matching_digest(body):
    choice = layout(body, index=0)
    assert validate_refinement_source(TITLE, body, choice, PACKAGE_SHA)
    with pytest.raises(ValueError):
        prepare_wechat_markdown(TITLE, body, choice, PACKAGE_SHA)


@pytest.mark.parametrize("body", [
    "## 原生标题\n正文。",
    "引言。\n\n```text\n保留代码\n```\n\n**确定小节**",
    "引言。\r\n\r\n**确定小节**\r\n\r\n尾段。",
    "<!-- 注释 **不是小节** -->\n\n**确定小节**",
])
def test_explicit_headings_after_other_content_keep_canonical_block_numbering(body):
    blocks = _source_blocks(TITLE, body)[0][1:]
    index = next(i for i, block in enumerate(blocks) if block in {"原生标题", "确定小节"})
    choice = layout(body, index=index)
    assert validate_refinement_source(TITLE, body, choice, PACKAGE_SHA) == []
    result = prepare_wechat_markdown(TITLE, body, choice, PACKAGE_SHA)
    assert _source_blocks(TITLE, result.split("\n\n", 1)[1]) == _source_blocks(TITLE, body)


@pytest.mark.parametrize("mutation", [
    lambda d: d.update(css="p{display:none}"),
    lambda d: d.update(html="<p>replacement</p>"),
    lambda d: d.update(theme="../../theme"),
    lambda d: d.update(source_package_sha256="bad"),
    lambda d: d["refinement"].update(padding=0),
    lambda d: d["refinement"].update(profile="other"),
    lambda d: d["refinement"].update(title_lines=["<script>bad</script>"]),
    lambda d: d["refinement"].update(title_lines=["a\nb"]),
    lambda d: d["refinement"].update(title_lines=["a" * 501]),
    lambda d: d["refinement"].update(title_lines=[]),
    lambda d: d["refinement"].update(title_lines=["a", "b", "c", "d"]),
    lambda d: d["refinement"]["heading_blocks"][0].update(block_index=True),
    lambda d: d["refinement"]["heading_blocks"][0].update(block_index=-1),
    lambda d: d["refinement"]["heading_blocks"][0].update(block_index=10000),
    lambda d: d["refinement"]["heading_blocks"][0].update(segments=["<b>text</b>"]),
    lambda d: d["refinement"]["heading_blocks"][0].update(text_sha256="A" * 64),
    lambda d: d["refinement"]["heading_blocks"].append(copy.deepcopy(d["refinement"]["heading_blocks"][0])),
])
def test_shape_rejects_unknown_fields_or_unbounded_input(mutation):
    choice = layout()
    mutation(choice)
    assert validate_wechat_layout(choice)
    with pytest.raises(ValueError):
        prepare_wechat_markdown(TITLE, BODY, choice, PACKAGE_SHA)


@pytest.mark.parametrize("change", ["package", "title", "digest", "segments", "out_of_range"])
def test_source_change_invalidates_old_typography_anchors(change):
    choice = layout()
    title = TITLE
    source_sha = PACKAGE_SHA
    if change == "package":
        source_sha = "b" * 64
    elif change == "title":
        title += "更新"
    elif change == "digest":
        choice["refinement"]["heading_blocks"][0]["text_sha256"] = "c" * 64
    elif change == "segments":
        choice["refinement"]["heading_blocks"][0]["segments"] = ["不相同"]
    else:
        choice["refinement"]["heading_blocks"][0]["block_index"] = 9999
    assert validate_refinement_source(title, BODY, choice, source_sha)
    with pytest.raises(ValueError):
        refine_wechat_html(RAW, title, BODY, choice, source_sha)


@pytest.mark.parametrize("changed", [
    RAW.replace("第一段。", "第一段"),
    RAW.replace('https://example.org/article?', 'https://example.org/wrong?'),
    RAW.replace("</section>", ""),
    RAW.replace("</h1>", "</h2>"),
    RAW.replace(f">{TITLE}</h1>", f"><span>{TITLE}</span></h1>"),
    RAW.replace(f'<h1 style="{BASE_STYLE}">', '<h1>'),
    RAW.replace('<section style="padding: 8px 12px; width: 100%;">', '<div style="padding:8px">').replace('</section>', '</div>'),
    RAW.replace(f'<h2 style="{H2_STYLE}">找到问题，明确边界</h2>', '<p><strong>找到问题，明确边界</strong></p>'),
    RAW.replace('<h1 style=', '<h1 style="color:black" style=', 1),
    RAW.replace('<h1 style=', '<h1 onclick="alert(1)" style=', 1),
])
def test_changed_or_unsupported_renderer_output_fails_closed(changed):
    with pytest.raises(ValueError):
        refine_wechat_html(changed, TITLE, BODY, layout(), PACKAGE_SHA)


def test_full_html_wrapper_and_entities_are_supported_without_rewriting_paragraphs():
    raw = '<!doctype html><html><head><meta charset="utf-8"><title>预览</title></head><body>' + RAW + '</body></html>'
    result = refine_wechat_html(raw, TITLE, BODY, layout(), PACKAGE_SHA)
    assert result.startswith('<!doctype html><html><head><meta charset="utf-8">')
    assert '<p>正文。<a href="https://example.org/article?a=1&amp;b=2">依据</a></p>' in result


def test_theme_only_request_preserves_original_input_and_html():
    choice = {"theme": "elegant-blue", "source_package_sha256": PACKAGE_SHA}
    assert validate_wechat_layout(choice) == []
    assert prepare_wechat_markdown(TITLE, BODY, choice, PACKAGE_SHA) == f"# {TITLE}\n\n{BODY}\n"
    assert refine_wechat_html(RAW, TITLE, BODY, choice, PACKAGE_SHA) == RAW
