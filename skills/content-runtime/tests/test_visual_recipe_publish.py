from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
TESTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "tests"
for directory in (SCRIPTS_DIR, TESTS_DIR):
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))

from content_runtime import ContentRuntime  # noqa: E402
from visual_test_fixtures import VALID_PACKAGE_BODY  # noqa: E402
from visual_director import build_visual_recipe  # noqa: E402
from visual_publish import (  # noqa: E402
    VisualOutputError,
    build_visual_tasks_from_recipe,
    choose_provider,
    generate_publish_outputs,
    load_provider_registry,
    parse_package_body,
    _write_png,
    _build_local_deck_html,
    _prepare_render_task,
    _read_screenshot_evidence_ratios,
    _inject_inline_assets,
    _render_html,
    _render_md2wechat_html,
)
import visual_publish  # noqa: E402


FIXTURE_DIR = REPO_ROOT / "skills" / "content-runtime" / "fixtures" / "visual-director"


def native_package_body() -> str:
    rows = "\n".join(
        f"| P{page} | 页面 {page} | 第 {page} 页独立说明一个判断。 | 概念图解（非事实证据）：第 {page} 页结构 |"
        for page in range(1, 9)
    )
    return f"""# 平台原生成稿

## 0. 共享事实底稿
- 本期平台：公众号、小红书

## 1. 公众号原生长文
- 发布标题：先把问题讲清楚，再谈表达
- 摘要：一篇用于验证排版链路的真实结构文章。
- 头图文案：先讲清问题
- 排版提示：极简、克制、适合手机阅读。

### 正文
#### 为什么先讲问题

用户先判断你是否理解他的处境，才会继续看你的表达。这是一个认知顺序问题。

#### 怎样组织正文

每一节只推进一个判断，并给出可以执行的下一步。

### 评论区承接
你最想先解决哪个具体问题？

## 2. 小红书原生图文
### 封面三句话
- 主句：先讲清问题
- 副句：再谈你的判断
- 补充句：八页讲透

### 发布正文
- 标题：内容不是越多越好
- 正文：把一个判断拆成八页，每页只完成一个沟通任务。
- 结尾问题：你最容易卡在哪一页？

### 图文卡片脚本
| 页码 | 页面标题 | 页面正文 | 视觉提示 |
| --- | --- | --- | --- |
{rows}

### 结尾标签
#内容创作 #公众号 #小红书
"""


def test_wechat_html_uses_the_dbs_markdown_renderer(tmp_path: Path) -> None:
    output = tmp_path / "wechat.html"

    _render_html(output, "真实文章", "#### 先讲清问题\n\n> 这是一句关键判断。\n\n- 第一步\n- 第二步")

    rendered = output.read_text(encoding="utf-8")
    assert "<h4>先讲清问题</h4>" in rendered
    assert "<blockquote>这是一句关键判断。</blockquote>" in rendered
    assert "<li>第一步</li>" in rendered
    assert "#### 先讲清问题" not in rendered
    assert "&gt; 这是一句关键判断" not in rendered


def test_installed_md2wechat_cli_renders_publishable_html(tmp_path: Path) -> None:
    if os.environ.get("ECHO_LIVE_MD2WECHAT_TEST") != "1":
        pytest.skip("live md2wechat API test requires explicit ECHO_LIVE_MD2WECHAT_TEST=1")
    if not shutil.which("md2wechat"):
        pytest.skip("optional md2wechat CLI is not installed")
    output = tmp_path / "wechat-md2wechat.html"

    result = _render_md2wechat_html(output, "真实文章", "## 先讲清问题\n\n这是一句关键判断。", "minimal")

    rendered = output.read_text(encoding="utf-8")
    assert result["renderer_source"] == "md2wechat-cli"
    assert result["renderer_theme"] == "minimal-green"
    assert "真实文章" in rendered
    assert "先讲清问题" in rendered
    assert "<script" not in rendered.lower()


def test_inline_visuals_are_injected_into_full_md2wechat_html_before_body_end() -> None:
    rendered = _inject_inline_assets(
        '<!doctype html><html><body><h2><span>先讲清问题</span></h2><p>正文</p></body></html>',
        [{
            "id": "inline-01",
            "src": "../inline/inline-01.png",
            "insert_after": "先讲清问题",
            "caption": "图解：先讲清问题",
        }, {
            "id": "inline-02",
            "src": "../inline/inline-02.png",
            "insert_after": "没有匹配的小节",
            "caption": "图解：补充说明",
        }],
    )

    assert rendered.index('data-aifios-asset-id="inline-01"') > rendered.index('</h2>')
    assert rendered.index('data-aifios-asset-id="inline-02"') < rendered.index('</body>')
    assert 'style="display:block;width:100%;height:auto;"' in rendered


def test_native_package_renders_only_wechat_html_and_xhs_p1_to_p8(tmp_path: Path) -> None:
    project = tmp_path / "native-layout"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "native-layout", native_package_body(), source="test")

    result = generate_publish_outputs(
        project=project,
        slug="native-layout",
        package_path=Path(package["path"]),
        renderer="local",
        write_runtime_record=False,
        visual_preferences={"mode": "stable", "direction_count": 2, "provider_policy": "auto"},
    )

    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    output_ids = [output["id"] for output in index["outputs"]]
    assert output_ids == [*[f"xhs-01-p{page}" for page in range(1, 9)], "wechat-html"]
    assert not any("cover" in asset_id or asset_id.startswith("inline-") for asset_id in output_ids)
    wechat = index["outputs"][-1]
    assert wechat["format"] == "HTML"
    assert wechat["renderer_source"] in {"md2wechat-cli", "skills/dbs-wechat-html/generate_preview.py"}
    # These generic assertions are not recognizable advice or sourced facts.
    # Complete copy and a concept-image label cannot silently waive review.
    assert index["quality_summary"]["status"] == "review_required", index["quality_summary"]
    assert not index["quality_summary"]["blocking_issues"]
    assert any("无法自动确认" in item for item in index["quality_summary"]["review_issues"])
    assert index["quality_summary"]["checks"]["density"] == "not_applicable"
    assert index["quality_summary"]["checks"]["native_text_layout"] == "pass"
    render_dir = project / "pipeline/visual/native-layout/publish/r001/render"
    metrics_files = list(render_dir.glob("screenshot-*.metrics.json"))
    assert metrics_files
    for path in metrics_files:
        metrics = json.loads(path.read_text())
        assert all(item["copy_fidelity"]["status"] == "pass" for item in metrics["targets"].values())


def test_ai_enhanced_request_is_blocked_before_recipe_or_backend_call(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "native-auto-images"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "native-auto-images", native_package_body(), source="test")

    backend_calls: list[str] = []

    def paid_runtime_must_not_run() -> dict:
        backend_calls.append("paid-runtime")
        raise AssertionError("disabled AI request reached the paid image backend")

    monkeypatch.setattr(visual_publish, "_paid_runtime_context", paid_runtime_must_not_run)
    with pytest.raises(VisualOutputError, match="AI image generation is disabled"):
        generate_publish_outputs(
            project=project,
            slug="native-auto-images",
            package_path=Path(package["path"]),
            renderer="local",
            write_runtime_record=False,
            visual_preferences={"mode": "ai_enhanced", "direction_count": 2, "provider_policy": "auto"},
        )

    visual_root = project / "pipeline" / "visual" / "native-auto-images"
    assert backend_calls == []
    assert not visual_root.exists()


@pytest.mark.parametrize("heading", ["B-roll", "B-Roll"])
def test_package_parser_accepts_all_supported_broll_headings(heading: str) -> None:
    body = VALID_PACKAGE_BODY.replace("#### B-roll 素材建议", f"#### {heading}", 1)

    parsed = parse_package_body(body)

    assert parsed["videos"][0]["broll"]


def test_visual_screenshot_measures_evidence_from_each_target_dom_geometry(tmp_path: Path) -> None:
    html_path = tmp_path / "geometry.html"
    html_path.write_text(
        """<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{margin:0}.poster{position:relative;width:400px;height:400px;overflow:hidden}
        .large{width:300px;height:400px}.small{width:100px;height:400px}
        </style></head><body>
        <section class="poster" id="large"><div class="large" data-evidence="true"></div></section>
        <section class="poster" id="small"><div class="small" data-evidence="true"></div></section>
        </body></html>""",
        encoding="utf-8",
    )
    metrics_path = tmp_path / "geometry.metrics.json"
    spec_path = tmp_path / "geometry.json"
    spec_path.write_text(
        json.dumps({
            "html": str(html_path),
            "metrics": str(metrics_path),
            "targets": [
                {"id": "large", "output": str(tmp_path / "large.png")},
                {"id": "small", "output": str(tmp_path / "small.png")},
            ],
        }),
        encoding="utf-8",
    )

    proc = subprocess.run(
        ["node", str(SCRIPTS_DIR / "visual_screenshot.mjs"), str(spec_path)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
    )

    assert proc.returncode == 0, proc.stderr or proc.stdout
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))["targets"]
    assert metrics["large"]["evidence_ratio"] == pytest.approx(0.75)
    assert metrics["small"]["evidence_ratio"] == pytest.approx(0.25)
    assert metrics["large"]["evidence_ratio"] != metrics["small"]["evidence_ratio"]


def test_visual_screenshot_distinguishes_blank_and_informative_evidence_images(tmp_path: Path) -> None:
    blank = tmp_path / "blank.png"
    _write_png(blank, 640, 400)
    informative = FIXTURE_DIR / "product-flow.png"
    blank_url = "data:image/png;base64," + base64.b64encode(blank.read_bytes()).decode("ascii")
    informative_url = "data:image/png;base64," + base64.b64encode(informative.read_bytes()).decode("ascii")
    html_path = tmp_path / "detail.html"
    html_path.write_text(
        f"""<!doctype html><html><head><meta charset="utf-8"><style>
        html,body{{margin:0}}.poster{{width:640px;height:400px}}img{{width:100%;height:100%;object-fit:cover}}
        </style></head><body>
        <section class="poster" id="blank"><div data-evidence="true"><img src="{blank_url}"></div></section>
        <section class="poster" id="informative"><div data-evidence="true"><img src="{informative_url}"></div></section>
        </body></html>""",
        encoding="utf-8",
    )
    metrics_path = tmp_path / "detail.metrics.json"
    spec_path = tmp_path / "detail.json"
    spec_path.write_text(
        json.dumps({
            "html": str(html_path),
            "metrics": str(metrics_path),
            "targets": [
                {"id": "blank", "output": str(tmp_path / "blank-card.png")},
                {"id": "informative", "output": str(tmp_path / "informative-card.png")},
            ],
        }),
        encoding="utf-8",
    )

    proc = subprocess.run(
        ["node", str(SCRIPTS_DIR / "visual_screenshot.mjs"), str(spec_path)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
    )

    assert proc.returncode == 0, proc.stderr or proc.stdout
    metrics = json.loads(metrics_path.read_text(encoding="utf-8"))["targets"]
    assert metrics["blank"]["evidence_detail_score"] < 0.08
    assert metrics["informative"]["evidence_detail_score"] >= 0.08
    assert metrics["informative"]["evidence_detail_score"] > metrics["blank"]["evidence_detail_score"]


def test_evidence_ratio_is_never_invented_without_screenshot_measurement(tmp_path: Path) -> None:
    evidence = tmp_path / "materials" / "evidence.txt"
    evidence.parent.mkdir(parents=True)
    evidence.write_text("source-backed evidence", encoding="utf-8")
    prepared = _prepare_render_task(tmp_path, {
        "id": "xhs-01-p2",
        "role": "evidence",
        "evidence_sources": ["materials/evidence.txt"],
    })
    assert "evidence_ratio" not in prepared

    metrics_path = tmp_path / "missing-ratio.metrics.json"
    metrics_path.write_text(
        json.dumps({"targets": {"xhs-01-p2": {"poster_area": 100, "evidence_area": 45}}}),
        encoding="utf-8",
    )
    with pytest.raises(VisualOutputError, match="missing evidence_ratio"):
        _read_screenshot_evidence_ratios(metrics_path, ["xhs-01-p2"])


def test_structured_evidence_parser_preserves_tsv_and_json_fields(tmp_path: Path) -> None:
    tsv = tmp_path / "retention.tsv"
    tsv.write_text("segment\tretention\tsource\nnew\t42%\t2026-Q2\n", encoding="utf-8")
    payload = tmp_path / "retention.json"
    payload.write_text(
        json.dumps([
            {"segment": "new", "retention": "42%", "source": "2026-Q2"},
            {"segment": "returning", "retention": "71%", "source": "2026-Q2"},
        ]),
        encoding="utf-8",
    )

    assert visual_publish._diagram_evidence_items(tsv) == [
        ("new", "retention: 42% · source: 2026-Q2"),
    ]
    assert visual_publish._diagram_evidence_items(payload) == [
        ("new", "retention: 42% · source: 2026-Q2"),
        ("returning", "retention: 71% · source: 2026-Q2"),
    ]
    prepared = _prepare_render_task(tmp_path, {
        "id": "xhs-01-p2",
        "role": "evidence",
        "evidence_sources": ["retention.json"],
    })
    assert prepared["evidence_kind"] == "dataset"
    assert prepared["evidence_items"][0][0] == "new"


def test_markdown_evidence_excludes_frontmatter_paths_and_code(tmp_path: Path) -> None:
    source = tmp_path / "interview.md"
    source.write_text(
        """---
source_path: materials/intake/interview-39.md
source_name: interview-39.md
created_at: 2026-08-23T09:46:06
---
# 客户访谈

> 客户最常问的是第一次合作应该怎么开始。

```text
pipeline/private/debug.json
```

- 我们先确认场景，再讨论方案。
""",
        encoding="utf-8",
    )

    items = visual_publish._diagram_evidence_items(source)
    visible = " ".join(value for _, value in items)

    assert "source_path" not in visible
    assert "materials/" not in visible
    assert "pipeline/" not in visible
    assert ".md" not in visible
    assert "客户最常问的是第一次合作应该怎么开始" in visible
    assert "我们先确认场景，再讨论方案" in visible


def test_title_line_break_preserves_all_copy_and_uses_semantic_boundary() -> None:
    rendered = visual_publish._line_break_title("内容没询盘，缺的是完整过程", 6)

    assert rendered.replace("<br>", "") == "内容没询盘，缺的是完整过程"
    assert rendered == "内容没询盘，<br>缺的是完整过程"
    assert visual_publish._line_break_title("真正稳定的是客户原话", 8) == "真正稳定的是<br>客户原话"


def test_square_wechat_cover_keeps_each_direction_visual_structure() -> None:
    base = {
        "kind": "wechat_cover",
        "width": 1080,
        "height": 1080,
        "template_style": "swiss",
        "payload": {
            "title": "内容没询盘，缺的是完整过程",
            "summary": "客户先看见自己的问题，才会继续理解你的方法和服务。",
        },
    }
    directions = [
        {**base, "id": "wechat-share", "cover_strategy": "typographic_judgment"},
        {**base, "id": "wechat-share-alt-01", "cover_strategy": "editorial_quote"},
        {**base, "id": "wechat-share-alt-02", "cover_strategy": "structured_metaphor"},
    ]

    posters = [visual_publish._poster_for_task(task) for task in directions]

    assert 'class="comparison-panel"' in posters[0]
    assert 'class="cover-quote"' in posters[1]
    assert 'class="step-path-panel"' in posters[2]
    assert len(set(posters)) == 3


def test_echo_founder_brand_tokens_are_applied_to_the_rendered_deck() -> None:
    task = {
        "id": "wechat-share",
        "kind": "wechat_cover",
        "width": 1080,
        "height": 1080,
        "template_style": "swiss",
        "cover_strategy": "editorial_quote",
        "brand_system": {
            "name": "echo-founder",
            "tokens": {
                "colors": {
                    "paper": "#FDF8F3",
                    "ink": "#1A1A1A",
                    "accent": "#E85D4C",
                },
                "typography": {
                    "sans_zh": "Noto Sans SC",
                    "serif_zh": "Noto Serif SC",
                    "mono": "IBM Plex Mono",
                },
            },
        },
        "payload": {"title": "客户问题先于能力履历", "summary": "先让客户看见自己的处境。"},
    }

    deck = _build_local_deck_html([task])

    assert 'data-brand-profile="echo-founder"' in deck
    assert "--paper:#FDF8F3" in deck
    assert "--ink:#1A1A1A" in deck
    assert "--accent:#E85D4C" in deck
    assert '--sans-zh:"Noto Sans SC"' in deck


def test_density_validator_does_not_count_an_empty_filled_wrapper(tmp_path: Path) -> None:
    html_path = tmp_path / "empty-stage.html"
    html_path.write_text(
        """<!doctype html><html data-accent="blue"><head><meta charset="utf-8"><style>
        html,body{margin:0}.poster{width:1080px;height:1440px;overflow:hidden;background:#fff}
        .copy{margin:64px;font:400 28px/1.5 sans-serif}.visual-stage{height:900px;background:#eee}
        </style></head><body><section class="poster xhs" id="empty-stage">
        <p class="copy">只有这一行真实内容。</p><div class="visual-stage"></div>
        </section></body></html>""",
        encoding="utf-8",
    )

    proc = subprocess.run(
        ["node", str(REPO_ROOT / "skills" / "xhs-card" / "validate-social-deck.mjs"), str(html_path)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
    )

    assert proc.returncode == 0, proc.stderr or proc.stdout
    assert "R5  density" in proc.stdout
    assert "empty-stage" in proc.stdout


@pytest.mark.parametrize("suffix", [".xls", ".xlsx", ".pdf", ".docx"])
def test_renderer_rejects_evidence_formats_without_a_structured_parser(
    tmp_path: Path,
    suffix: str,
) -> None:
    source = tmp_path / f"evidence{suffix}"
    source.write_bytes(b"unsupported binary evidence")

    with pytest.raises(VisualOutputError, match="unsupported structured evidence format"):
        _prepare_render_task(tmp_path, {
            "id": "xhs-01-p2",
            "role": "evidence",
            "evidence_sources": [source.name],
        })


def test_unsupported_evidence_format_is_preflighted_before_any_customer_output(tmp_path: Path) -> None:
    project = tmp_path / "unsupported-preflight"
    package_path, recipe_path = _write_explicit_recipe_fixture(project, slug="unsupported-preflight")
    source = project / "materials" / "research" / "findings.pdf"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"not structurally parsed")
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    evidence = next(asset for asset in recipe["assets"] if asset["id"] == "xhs-01-p2")
    evidence["source"] = "materials/research/findings.pdf"
    recipe["source_assets"] = ["materials/research/findings.pdf"]
    recipe_path.write_text(json.dumps(recipe, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(VisualOutputError, match="unsupported structured evidence format"):
        generate_publish_outputs(
            project=project,
            slug="unsupported-preflight",
            package_path=package_path,
            recipe_path=recipe_path,
            renderer="local",
            write_runtime_record=False,
        )

    publish_revision = project / "pipeline" / "visual" / "unsupported-preflight" / "publish" / "r001"
    assert not publish_revision.exists()


@pytest.mark.parametrize("suffix", [".png", ".csv"])
@pytest.mark.parametrize("target_location", ["inside", "outside"])
def test_prepare_render_task_rejects_symlinked_evidence_before_uri_or_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    suffix: str,
    target_location: str,
) -> None:
    project = tmp_path / "project"
    materials = project / "materials"
    materials.mkdir(parents=True)
    target_root = materials if target_location == "inside" else tmp_path / "outside"
    target_root.mkdir(exist_ok=True)
    target = target_root / f"source{suffix}"
    target.write_bytes(b"image evidence" if suffix == ".png" else b"metric,value\nretention,42\n")
    link = materials / f"evidence{suffix}"
    link.symlink_to(target)
    uri_calls: list[Path] = []
    read_calls: list[Path] = []

    monkeypatch.setattr(Path, "as_uri", lambda path: uri_calls.append(path) or "file:///should-not-exist")
    monkeypatch.setattr(
        visual_publish,
        "_diagram_evidence_items",
        lambda path: read_calls.append(path) or [("metric", "42")],
    )

    with pytest.raises(VisualOutputError, match="symlink"):
        _prepare_render_task(project, {
            "id": "xhs-01-p2",
            "role": "evidence",
            "evidence_sources": [f"materials/evidence{suffix}"],
        })

    assert uri_calls == []
    assert read_calls == []


def test_prepare_render_task_validates_every_evidence_source_before_rendering(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "project"
    materials = project / "materials"
    materials.mkdir(parents=True)
    first = materials / "primary.png"
    first.write_bytes(b"primary evidence")
    outside = tmp_path / "outside.csv"
    outside.write_text("metric,value\nretention,42\n", encoding="utf-8")
    second = materials / "secondary.csv"
    second.symlink_to(outside)
    uri_calls: list[Path] = []
    monkeypatch.setattr(Path, "as_uri", lambda path: uri_calls.append(path) or "file:///should-not-exist")

    with pytest.raises(VisualOutputError, match="symlink"):
        _prepare_render_task(project, {
            "id": "xhs-01-p2",
            "role": "evidence",
            "evidence_sources": ["materials/primary.png", "materials/secondary.csv"],
        })

    assert uri_calls == []


def png_has_visual_detail(path: Path) -> bool:
    data = path.read_bytes()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        return False
    cursor = 8
    compressed = bytearray()
    while cursor + 12 <= len(data):
        length = struct.unpack(">I", data[cursor:cursor + 4])[0]
        chunk_type = data[cursor + 4:cursor + 8]
        chunk_data = data[cursor + 8:cursor + 8 + length]
        if chunk_type == b"IDAT":
            compressed.extend(chunk_data)
        cursor += 12 + length
        if chunk_type == b"IEND":
            break
    return bool(compressed) and len(set(zlib.decompress(compressed))) >= 64


def fixture_package_body(package: dict) -> str:
    wechat = package["wechat"]
    lines = [
        "# 最终内容 · Canonical Visual",
        "",
        "## 1. 公众号母稿",
        f"- 发布标题：{wechat['title']}",
        f"- 封面字：{wechat['cover_text']}",
        f"- 摘要：{wechat.get('summary', wechat['body'])}",
        "- 公众号排版提示：正文短段落，证据和结论分层排版。",
        "- 配图位建议：使用配方声明的真实证据资产。",
        "",
        "### 正文",
        wechat["body"],
        "",
        "### 评论区引导",
        "围绕本页判断提出一个可回答的问题。",
        "",
        "## 3. 图文内容",
    ]
    source_post = package["xhs_posts"][0]
    for post_index in range(1, 4):
        lines.extend([
            "",
            f"### 图文 {post_index}：Canonical",
            f"- 发布标题：{source_post['title']}",
            f"- 封面字：{source_post['cover_text']}",
            f"- 正文文案：{source_post['body']}",
            "",
            "#### 页卡脚本",
            "| 页码 | 页面标题 | 页面正文 | 画面/配图建议 | 视觉层级 | 排版重点 |",
            "|---|---|---|---|---|---|",
        ])
        for page in source_post["pages"]:
            lines.append(
                "| {page_id} | {title} | {body} | {image_prompt} | {visual_hierarchy} | {layout_note} |".format(**page)
            )
    return "\n".join(lines) + "\n"


def editorial_recipe() -> dict:
    assets = [
        {"id": "wechat-html", "platform": "wechat", "role": "article", "layout_recipe": "html", "renderer": "dbs-wechat-html", "status": "planned"},
        {"id": "wechat-cover", "platform": "wechat", "role": "cover", "layout_recipe": "M01", "renderer": "xhs-card", "status": "planned"},
        {"id": "wechat-share", "platform": "wechat", "role": "share", "layout_recipe": "M01", "renderer": "xhs-card", "status": "planned"},
    ]
    for page in range(1, 6):
        item = {
            "id": f"xhs-01-p{page}",
            "platform": "xhs",
            "role": "cover" if page == 1 else ("cta" if page == 5 else "supporting"),
            "layout_recipe": ["M01", "M05", "M08", "M11", "M15"][page - 1],
            "renderer": "xhs-card",
            "status": "planned",
            "copy": {"headline": f"编辑页 {page}", "supporting": "用可读的细节承接原文判断。"},
        }
        if page == 2:
            item["role"] = "evidence"
            item["source"] = "materials/notes/customer-meeting.md"
        assets.append(item)
    return {
        "schema": "aifios.visual-recipe.v1",
        "revision_id": "r001",
        "parent_revision_id": "r000",
        "slug": "editorial-recipe",
        "source_package": "pipeline/package/editorial-recipe-package.md",
        "source_assets": ["materials/notes/customer-meeting.md"],
        "content_archetype": "founder_story",
        "evidence_mode": "artifact_first",
        "brand_profile": "adaptive",
        "platforms": {
            "wechat": {"system": "editorial", "cover_recipe": "M01", "asset_ids": ["wechat-html", "wechat-cover", "wechat-share"]},
            "xhs": {"system": "editorial", "page_recipes": ["M01", "M05", "M08", "M11", "M15"], "asset_ids": [f"xhs-01-p{page}" for page in range(1, 6)]},
        },
        "assets": assets,
        "quality_policy": {"min_density": 0.62, "require_evidence_ratio": 0.4},
    }


def test_recipe_publish_records_revision_layouts_and_evidence(tmp_path: Path) -> None:
    project = tmp_path / "recipe-publish"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "editorial-recipe", VALID_PACKAGE_BODY, source="test")
    recipe_path = project / "pipeline" / "visual" / "editorial-recipe" / "recipes" / "r001.visual-recipe.json"
    recipe_path.parent.mkdir(parents=True)
    recipe_path.write_text(json.dumps(editorial_recipe(), ensure_ascii=False), encoding="utf-8")

    result = generate_publish_outputs(
        project=project,
        slug="editorial-recipe",
        package_path=Path(package["path"]),
        recipe_path=recipe_path,
        renderer="fake",
        write_runtime_record=False,
    )

    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    xhs_outputs = [item for item in index["outputs"] if item["kind"] == "xhs_card"]
    evidence = next(item for item in xhs_outputs if item["id"] == "xhs-01-p2")
    assert index["revision_id"] == "r001"
    assert index["visual_system"] == "editorial"
    assert index["recipe_path"].endswith("r001.visual-recipe.json")
    assert [item["layout_recipe"] for item in xhs_outputs] == ["M01", "M05", "M08", "M11", "M15"]
    assert evidence["evidence_sources"] == ["materials/notes/customer-meeting.md"]
    for output in index["outputs"]:
        assert output["recipe_path"].endswith("r001.visual-recipe.json")
        assert output["revision_id"] == "r001"
        assert output["parent_revision_id"] == "r000"
        assert output["visual_system"] == "editorial"
        assert isinstance(output["evidence_sources"], list)
        payload = (project / output["output"]).read_bytes()
        assert output["size"] == len(payload)
        assert output["sha256"] == hashlib.sha256(payload).hexdigest()


def _write_explicit_recipe_fixture(project: Path, slug: str = "editorial-recipe") -> tuple[Path, Path]:
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", slug, VALID_PACKAGE_BODY, source="test")
    recipe = editorial_recipe()
    recipe["slug"] = slug
    recipe["source_package"] = str(Path(package["path"]).relative_to(project))
    recipe_path = project / "pipeline" / "visual" / slug / "recipes" / "r001.visual-recipe.json"
    recipe_path.parent.mkdir(parents=True)
    recipe_path.write_text(json.dumps(recipe, ensure_ascii=False), encoding="utf-8")
    return Path(package["path"]), recipe_path


def test_explicit_recipe_slug_must_match_requested_visual_root(tmp_path: Path) -> None:
    project = tmp_path / "slug-boundary"
    package_path, recipe_path = _write_explicit_recipe_fixture(project)
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    recipe["slug"] = "other-topic"
    recipe_path.write_text(json.dumps(recipe, ensure_ascii=False), encoding="utf-8")

    with pytest.raises(VisualOutputError, match="slug does not match"):
        generate_publish_outputs(
            project,
            "editorial-recipe",
            package_path,
            recipe_path,
            renderer="fake",
            write_runtime_record=False,
        )

    assert not (project / "pipeline" / "visual" / "editorial-recipe" / "publish").exists()
    assert not (project / "pipeline" / "visual" / "other-topic").exists()


def test_explicit_recipe_file_must_stay_in_the_requested_slug_recipe_directory(tmp_path: Path) -> None:
    project = tmp_path / "recipe-directory-boundary"
    package_path, recipe_path = _write_explicit_recipe_fixture(project)
    misplaced = project / "pipeline" / "visual" / "other-topic" / "recipes" / recipe_path.name
    misplaced.parent.mkdir(parents=True)
    misplaced.write_bytes(recipe_path.read_bytes())

    with pytest.raises(VisualOutputError, match="recipe path must be inside"):
        generate_publish_outputs(
            project,
            "editorial-recipe",
            package_path,
            misplaced,
            renderer="fake",
            write_runtime_record=False,
        )

    assert not (project / "pipeline" / "visual" / "editorial-recipe" / "publish").exists()


def test_recipe_output_traversal_is_rejected_without_creating_external_paths(tmp_path: Path) -> None:
    project = tmp_path / "output-boundary"
    package_path, recipe_path = _write_explicit_recipe_fixture(project)
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    recipe["assets"][0]["output"] = "../../outside/escaped.html"
    recipe_path.write_text(json.dumps(recipe, ensure_ascii=False), encoding="utf-8")
    outside = tmp_path / "outside"

    with pytest.raises(VisualOutputError, match="safe project-relative path"):
        generate_publish_outputs(
            project,
            "editorial-recipe",
            package_path,
            recipe_path,
            renderer="fake",
            write_runtime_record=False,
        )

    assert not outside.exists()
    assert not (project / "pipeline" / "visual" / "editorial-recipe" / "publish").exists()


def test_derived_output_traversal_is_rejected_before_any_renderer_writes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = tmp_path / "derived-output-boundary"
    package_path, recipe_path = _write_explicit_recipe_fixture(project)
    outside = tmp_path / "outside"
    monkeypatch.setattr(
        visual_publish,
        "_recipe_asset_output",
        lambda _base, _asset: ("../../outside/escaped.png", 16, 16, "wechat_cover"),
    )

    with pytest.raises(VisualOutputError, match="publish output must be inside"):
        generate_publish_outputs(
            project,
            "editorial-recipe",
            package_path,
            recipe_path,
            renderer="fake",
            write_runtime_record=False,
        )

    assert not outside.exists()
    assert not (project / "pipeline" / "visual" / "editorial-recipe" / "publish").exists()


def test_revision_only_publish_preserves_the_current_publish_index(tmp_path: Path) -> None:
    project = tmp_path / "revision-only-index"
    package_path, recipe_path = _write_explicit_recipe_fixture(project)
    current_index = project / "pipeline" / "visual" / "editorial-recipe" / "publish" / "index.json"
    current_index.parent.mkdir(parents=True)
    current_index.write_text(
        json.dumps({"slug": "editorial-recipe", "revision_id": "r999", "status": "generated"}),
        encoding="utf-8",
    )

    result = generate_publish_outputs(
        project,
        "editorial-recipe",
        package_path,
        recipe_path,
        renderer="fake",
        write_runtime_record=False,
        publish_current_index=False,
    )

    revision_index = project / "pipeline" / "visual" / "editorial-recipe" / "revisions" / "r001.index.json"
    assert Path(result["index_path"]) == revision_index
    assert revision_index.is_file()
    assert json.loads(revision_index.read_text(encoding="utf-8"))["revision_id"] == "r001"
    assert json.loads(current_index.read_text(encoding="utf-8"))["revision_id"] == "r999"


@pytest.mark.parametrize(
    ("renderer", "role", "provider_task"),
    [
        ("baoyu-diagram", "diagram", "diagram"),
        ("baoyu-comic", "comic", "comic"),
        ("ian-xiaohei-illustrations", "illustration", "illustration"),
    ],
)
def test_inline_assets_use_the_requested_provider(renderer: str, role: str, provider_task: str) -> None:
    recipe = editorial_recipe()
    recipe["content_archetype"] = "research"
    recipe["assets"].append({
        "id": "inline-01",
        "platform": "wechat",
        "role": role,
        "layout_recipe": "evidence-diagram",
        "renderer": renderer,
        "status": "planned",
        "source": "materials/research/retention.csv",
    })

    tasks = build_visual_tasks_from_recipe(
        parse_package_body(VALID_PACKAGE_BODY),
        recipe,
        slug="editorial-recipe",
        package_rel=recipe["source_package"],
    )
    inline = next(task for task in tasks if task["id"] == "inline-01")
    provider = choose_provider(load_provider_registry(), inline["provider_task"])

    assert inline["provider_task"] == provider_task
    assert provider["id"] == renderer


def _write_image_backend_fixture(
    project: Path,
    *,
    requested_renderer: str,
    role: str,
) -> tuple[Path, Path]:
    package_path, recipe_path = _write_explicit_recipe_fixture(project, slug="concept-image")
    recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
    recipe.update({
        "source_assets": [],
        "content_archetype": "concept",
        "evidence_mode": "illustration_allowed",
        "assets": [{
            "id": "inline-01",
            "platform": "wechat",
            "role": role,
            "layout_recipe": f"inline-{role}",
            "renderer": requested_renderer,
            "status": "planned",
            "image_prompt": "把内容生产比作一条有检查站的流水线",
        }],
    })
    recipe_path.write_text(json.dumps(recipe, ensure_ascii=False), encoding="utf-8")
    return package_path, recipe_path


@pytest.mark.parametrize(
    ("requested_renderer", "role"),
    [
        ("baoyu-comic", "comic"),
        ("ian-xiaohei-illustrations", "illustration"),
    ],
)
def test_explicit_ai_renderer_recipe_is_blocked_before_backend_call(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    requested_renderer: str,
    role: str,
) -> None:
    project = tmp_path / role
    package_path, recipe_path = _write_image_backend_fixture(
        project,
        requested_renderer=requested_renderer,
        role=role,
    )
    recipe_before = recipe_path.read_bytes()
    calls: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        del kwargs
        calls.append(command)
        raise AssertionError("disabled AI recipe reached a subprocess backend")

    monkeypatch.setattr(visual_publish.subprocess, "run", fake_run)

    with pytest.raises(VisualOutputError, match="AI image generation is disabled"):
        generate_publish_outputs(
            project=project,
            slug="concept-image",
            package_path=package_path,
            recipe_path=recipe_path,
            renderer="local",
            write_runtime_record=False,
        )

    assert calls == []
    assert recipe_path.read_bytes() == recipe_before
    assert not (project / "pipeline" / "visual" / "concept-image" / "publish").exists()
    assert not list(project.rglob("r002*"))


def test_ai_recipe_generate_cli_reports_disabled_without_outputs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    project = tmp_path / "disabled-cli-recipe"
    package_path, recipe_path = _write_image_backend_fixture(
        project,
        requested_renderer="baoyu-comic",
        role="comic",
    )
    calls: list[list[str]] = []
    monkeypatch.setattr(
        visual_publish.subprocess,
        "run",
        lambda command, **_kwargs: calls.append(command) or (_ for _ in ()).throw(
            AssertionError("disabled AI recipe reached a subprocess backend")
        ),
    )

    exit_code = visual_publish.main([
        "--project", str(project),
        "generate",
        "--slug", "concept-image",
        "--package", str(package_path),
        "--recipe", str(recipe_path),
    ])

    assert exit_code == 1
    error = json.loads(capsys.readouterr().err)
    assert "AI image generation is disabled" in error["error"]
    assert calls == []
    assert not (project / "pipeline" / "visual" / "concept-image" / "publish").exists()
    assert not list(project.rglob("r002*"))


def test_historical_ai_review_is_read_only_and_does_not_promote_request(tmp_path: Path) -> None:
    project = tmp_path / "historical-ai"
    revisions = project / "pipeline" / "visual" / "concept-image" / "revisions"
    revisions.mkdir(parents=True)
    index_path = revisions / "r001.index.json"
    request_path = revisions / "r001-request.json"
    index_path.write_text('{"schema":"historical","status":"generated"}\n', encoding="utf-8")
    request_path.write_text(
        '{"schema":"aifios.visual-revision-request.v1","status":"review_required"}\n',
        encoding="utf-8",
    )
    before_index = index_path.read_bytes()
    before_request = request_path.read_bytes()

    with pytest.raises(VisualOutputError, match="historical AI visual artifacts are read-only"):
        visual_publish.record_ai_raster_human_review(
            project,
            "concept-image",
            "r001",
            "inline-01",
            "0" * 64,
            confirm_no_text=True,
            confirm_concept_boundary=True,
        )

    assert index_path.read_bytes() == before_index
    assert request_path.read_bytes() == before_request
    assert not list(project.rglob("r002*"))


def test_ai_review_cli_returns_clear_read_only_error_without_creating_files(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    project = tmp_path / "review-cli"

    exit_code = visual_publish.main([
        "--project", str(project),
        "review-ai-raster",
        "--slug", "concept-image",
        "--revision", "r001",
        "--asset", "inline-01",
        "--output-sha256", "0" * 64,
        "--confirm-no-text",
        "--confirm-concept-boundary",
    ])

    assert exit_code == 1
    error = json.loads(capsys.readouterr().err)
    assert error == {
        "status": "failed",
        "error": "AI image review is disabled; historical AI visual artifacts are read-only",
    }
    assert not project.exists()


def test_visual_publish_cli_exposes_only_stable_generation_mode(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        visual_publish.main(["--project", ".", "generate", "--help"])

    assert exit_info.value.code == 0
    help_text = " ".join(capsys.readouterr().out.split())
    assert "{stable}" in help_text
    assert "ai_enhanced" not in help_text
    assert "AI image generation is disabled" in help_text


def test_review_cli_help_marks_historical_ai_artifacts_read_only(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        visual_publish.main(["--project", ".", "--help"])

    assert exit_info.value.code == 0
    help_text = " ".join(capsys.readouterr().out.split())
    assert "review-ai-raster" in help_text
    assert "historical AI visual artifacts are read-only" in help_text


def test_aesthetic_report_persists_only_stable_render_targets(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    render_dir = tmp_path / "project" / "pipeline" / "visual" / "topic" / "publish" / "r001" / "render"
    deck_path = render_dir / "swiss.html"
    deck_path.parent.mkdir(parents=True)
    deck_path.write_text("<!doctype html>", encoding="utf-8")
    leaked_target = "../../../../private/var/folders/tmp/project/pipeline/visual/topic/publish/r001/render/swiss.html"
    monkeypatch.setattr(
        visual_publish.subprocess,
        "run",
        lambda command, **_kwargs: subprocess.CompletedProcess(
            command,
            0,
            stdout=f"target: {leaked_target}\n[PASS] xhs-01-p1 · xhs\n  R5 density 68% PASS\n",
            stderr="",
        ),
    )

    quality = visual_publish._run_local_aesthetic_gate(render_dir, {"swiss": deck_path})

    report = quality["render_quality_report"]
    assert "target: render/swiss.html" in report
    assert "[PASS] xhs-01-p1 · xhs" in report
    assert "R5 density 68% PASS" in report
    assert "/private/" not in report
    assert "/Users/" not in report
    assert "../../" not in report


def test_visual_node_runner_uses_the_embedded_electron_node_runtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    script = tmp_path / "renderer.mjs"
    script.write_text("console.log('renderer')\n", encoding="utf-8")
    electron = tmp_path / "AIFIOS"
    electron.write_text("placeholder\n", encoding="utf-8")
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((command, kwargs))
        return subprocess.CompletedProcess(command, 0, stdout="ok", stderr="")

    monkeypatch.setenv("AIFIOS_NODE_BINARY", str(electron))
    monkeypatch.setenv("AIFIOS_NODE_RUN_AS_NODE", "1")
    monkeypatch.delenv("ELECTRON_RUN_AS_NODE", raising=False)
    monkeypatch.setattr(visual_publish.subprocess, "run", fake_run)

    result = visual_publish._run_visual_node_script(
        script,
        ["--fixture"],
        cwd=tmp_path,
        purpose="fixture renderer",
    )

    assert result.returncode == 0
    assert calls[0][0] == [str(electron), str(script), "--fixture"]
    assert calls[0][1]["env"]["ELECTRON_RUN_AS_NODE"] == "1"
    assert calls[0][1]["cwd"] == str(tmp_path)


def test_visual_node_runner_does_not_fall_back_to_path_in_desktop_mode(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    script = tmp_path / "renderer.mjs"
    script.write_text("console.log('renderer')\n", encoding="utf-8")
    monkeypatch.setenv("AIFIOS_DESKTOP", "1")
    monkeypatch.delenv("AIFIOS_NODE_BINARY", raising=False)

    with pytest.raises(VisualOutputError, match="内置 Node"):
        visual_publish._run_visual_node_script(
            script,
            [],
            cwd=tmp_path,
            purpose="fixture renderer",
        )


def test_local_diagram_renderer_emits_source_traceable_svg_and_png(tmp_path: Path) -> None:
    project = tmp_path / "diagram-render"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "diagram-render", VALID_PACKAGE_BODY, source="test")
    source = project / "materials" / "research" / "retention.csv"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text(
        "segment,retention,source\nnew,42,2026-Q2 cohort\nreturning,71,2026-Q2 cohort\nenterprise,83,2026-Q2 cohort\n",
        encoding="utf-8",
    )
    recipe = editorial_recipe()
    recipe.update({
        "slug": "diagram-render",
        "source_package": str(Path(package["path"]).relative_to(project)),
        "content_archetype": "research",
        "source_assets": ["materials/research/retention.csv"],
    })
    recipe["assets"] = [{
        "id": "inline-01",
        "platform": "wechat",
        "role": "diagram",
        "layout_recipe": "evidence-diagram",
        "renderer": "baoyu-diagram",
        "status": "planned",
        "source": "materials/research/retention.csv",
    }]
    recipe_path = project / "pipeline" / "visual" / "diagram-render" / "recipes" / "r001.visual-recipe.json"
    recipe_path.parent.mkdir(parents=True)
    recipe_path.write_text(json.dumps(recipe, ensure_ascii=False), encoding="utf-8")

    result = generate_publish_outputs(
        project=project,
        slug="diagram-render",
        package_path=Path(package["path"]),
        recipe_path=recipe_path,
        renderer="local",
        write_runtime_record=False,
    )

    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    output = index["outputs"][0]
    assert output["provider"] == "baoyu-diagram"
    assert output["renderer_source"] == "skills/baoyu-diagram/SKILL.md"
    assert output["source_svg"].endswith("inline-01.svg")
    source_svg = project / output["source_svg"]
    assert source_svg.is_file()
    svg = source_svg.read_text(encoding="utf-8")
    assert "retention: 42" in svg
    assert "source: 2026-Q2 cohort" in svg
    assert (project / output["output"]).is_file()


def test_local_product_recipe_has_no_r5_density_warning(tmp_path: Path) -> None:
    project = tmp_path / "product-render"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "product-render", VALID_PACKAGE_BODY, source="test")
    screenshot = project / "materials" / "screenshots" / "product-flow.png"
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURE_DIR / "product-flow.png", screenshot)

    result = generate_publish_outputs(
        project=project,
        slug="product-render",
        package_path=Path(package["path"]),
        renderer="local",
        write_runtime_record=False,
    )

    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    evidence = next(item for item in index["outputs"] if item["id"] == "xhs-01-p2")
    assert index["density_warnings"] == []
    assert index["quality_summary"]["status"] == "pass"
    assert index["golden_sample_readiness"]["status"] == "ready"
    assert set(index["golden_sample_readiness"]["checks"].values()) == {"pass"}
    assert evidence["evidence_ratio"] >= 0.4


def test_default_rerun_preserves_an_adopted_revision_byte_for_byte(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from visual_release import build_visual_selection_manifest, resolve_selected_visual_release

    project = tmp_path / "immutable-selected"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "immutable-selected", VALID_PACKAGE_BODY, source="test")
    screenshot = project / "materials" / "screenshots" / "product-flow.png"
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(FIXTURE_DIR / "product-flow.png", screenshot)

    first = generate_publish_outputs(
        project=project,
        slug="immutable-selected",
        package_path=Path(package["path"]),
        renderer="local",
        write_runtime_record=False,
    )
    first_index_path = Path(first["index_path"])
    first_index = json.loads(first_index_path.read_text(encoding="utf-8"))
    assert first_index["quality_summary"]["status"] == "pass"
    selection = build_visual_selection_manifest(project, "immutable-selected", "r001")
    selection_path = project / "pipeline" / "visual" / "immutable-selected" / "selected-revision.json"
    selection_path.write_text(json.dumps(selection, ensure_ascii=False, indent=2), encoding="utf-8")
    revision_index = project / "pipeline" / "visual" / "immutable-selected" / "revisions" / "r001.index.json"
    current_index = project / "pipeline" / "visual" / "immutable-selected" / "publish" / "index.json"
    immutable_paths = [
        revision_index,
        current_index,
        *(project / output["output"] for output in first_index["outputs"]),
    ]
    snapshots = {path: path.read_bytes() for path in immutable_paths}
    monkeypatch.setattr(
        visual_publish,
        "_render_local_outputs",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("selected renderer must not run")),
    )

    second = generate_publish_outputs(
        project=project,
        slug="immutable-selected",
        package_path=Path(package["path"]),
        renderer="local",
        write_runtime_record=False,
    )

    assert second["status"] == "selected"
    assert second["quality_summary"]["status"] == "pass"
    assert all(path.read_bytes() == payload for path, payload in snapshots.items())
    assert resolve_selected_visual_release(project, "immutable-selected")["status"] == "pass"

    selected_recipe_path = project / first_index["recipe_path"]
    direct_recipe = json.loads(selected_recipe_path.read_text(encoding="utf-8"))
    direct_recipe["revision_id"] = "r002"
    direct_recipe["parent_revision_id"] = "r001"
    r002_path = selected_recipe_path.with_name("r002.visual-recipe.json")
    r002_path.write_text(json.dumps(direct_recipe, ensure_ascii=False), encoding="utf-8")
    with pytest.raises(VisualOutputError, match="revision consumer"):
        generate_publish_outputs(
            project=project,
            slug="immutable-selected",
            package_path=Path(package["path"]),
            recipe_path=r002_path,
            renderer="local",
            write_runtime_record=False,
        )
    assert not (project / "pipeline" / "visual" / "immutable-selected" / "publish" / "r002").exists()


def test_recipe_page_intent_stays_out_of_the_reader_facing_layout() -> None:
    recipe = editorial_recipe()
    target = next(item for item in recipe["assets"] if item["id"] == "xhs-01-p3")
    target.update({
        "layout_recipe": "S06",
        "image_prompt": "客户卡点便签组",
        "visual_hierarchy": "三步判断逐层展开",
        "layout_note": "高亮问题被说中",
    })
    tasks = build_visual_tasks_from_recipe(
        parse_package_body(VALID_PACKAGE_BODY),
        recipe,
        slug="editorial-recipe",
        package_rel=recipe["source_package"],
    )
    target_task = next(task for task in tasks if task["id"] == "xhs-01-p3")
    target_task["template_style"] = "swiss"

    deck = _build_local_deck_html([target_task])

    assert "客户卡点便签组" not in deck
    assert "三步判断逐层展开" not in deck
    assert "高亮问题被说中" not in deck
    assert target_task["payload"]["page"]["body"][:16] in deck
    assert deck.count('class="ledger-row"') >= 1


def test_local_editorial_recipe_has_real_density_without_decorative_canvas(tmp_path: Path) -> None:
    project = tmp_path / "editorial-render"
    runtime = ContentRuntime(project)
    runtime.init()
    package = runtime.write("package", "editorial-recipe", VALID_PACKAGE_BODY, source="test")
    note = project / "materials" / "notes" / "customer-meeting.md"
    note.parent.mkdir(parents=True)
    note.write_text("客户先沉默，然后说自己最担心第一篇内容像推销。\n现场笔记保留了这句原话。", encoding="utf-8")
    recipe_path = project / "pipeline" / "visual" / "editorial-recipe" / "recipes" / "r001.visual-recipe.json"
    recipe_path.parent.mkdir(parents=True)
    recipe_path.write_text(json.dumps(editorial_recipe(), ensure_ascii=False), encoding="utf-8")

    result = generate_publish_outputs(
        project=project,
        slug="editorial-recipe",
        package_path=Path(package["path"]),
        recipe_path=recipe_path,
        renderer="local",
        write_runtime_record=False,
    )

    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    assert index["density_warnings"] == []
    assert index["quality_summary"]["status"] == "pass"
    wechat_html = next(output for output in index["outputs"] if output["id"] == "wechat-html")
    assert wechat_html["renderer_source"] in {
        "md2wechat-cli",
        "skills/dbs-wechat-html/generate_preview.py",
    }
    deck = project / "pipeline" / "visual" / "editorial-recipe" / "publish" / "r001" / "render" / "editorial.html"
    html_body = deck.read_text(encoding="utf-8")
    assert 'class="recipe-evidence evidence-document"' in html_body
    assert "客户先沉默，然后说自己最担心第一篇内容像推销。" in html_body
    assert "现场笔记保留了这句原话。" in html_body


@pytest.mark.parametrize(
    ("fixture_name", "slug"),
    [
        ("product-demo.json", "canonical-product"),
        ("founder-story.json", "canonical-founder"),
        ("research-analysis.json", "canonical-research"),
    ],
)
def test_canonical_fixture_renders_a_publishable_recipe(fixture_name: str, slug: str, tmp_path: Path) -> None:
    fixture = json.loads((FIXTURE_DIR / fixture_name).read_text(encoding="utf-8"))
    project = tmp_path / slug
    runtime = ContentRuntime(project)
    runtime.init()
    for asset in fixture["materials"]["assets"]:
        path = project / asset["path"]
        if asset.get("fixture_kind") == "product_screenshot":
            fixture_asset = FIXTURE_DIR / str(asset["fixture_asset"])
            assert png_has_visual_detail(fixture_asset)
            path.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(fixture_asset, path)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(asset.get("fixture_content", "source evidence"), encoding="utf-8")
    package_result = runtime.write("package", slug, fixture_package_body(fixture["package"]), source="canonical-test")
    package = dict(fixture["package"])
    package["source_package"] = str(Path(package_result["path"]).relative_to(project))
    routing = json.loads((REPO_ROOT / "skills" / "content-runtime" / "config" / "visual-routing.json").read_text(encoding="utf-8"))
    brands = json.loads((REPO_ROOT / "skills" / "content-runtime" / "config" / "visual-brand-profiles.json").read_text(encoding="utf-8"))
    recipe = build_visual_recipe(package, fixture["materials"], slug, routing, brands)
    recipe_path = project / "pipeline" / "visual" / slug / "recipes" / "r001.visual-recipe.json"
    recipe_path.parent.mkdir(parents=True, exist_ok=True)
    recipe_path.write_text(json.dumps(recipe, ensure_ascii=False, indent=2), encoding="utf-8")

    result = generate_publish_outputs(
        project=project,
        slug=slug,
        package_path=Path(package_result["path"]),
        recipe_path=recipe_path,
        renderer="local",
        write_runtime_record=False,
    )

    index = json.loads(Path(result["index_path"]).read_text(encoding="utf-8"))
    assert recipe["content_archetype"] == fixture["expected"]["content_archetype"]
    assert recipe["platforms"]["xhs"]["page_recipes"] == fixture["expected"]["xhs_recipes"]
    assert index["density_warnings"] == []
    assert "WARN" not in index["render_quality_report"]
    assert index["quality_summary"]["status"] == "pass", index["quality_summary"]
    if fixture_name in {"product-demo.json", "research-analysis.json"}:
        evidence = next(output for output in index["outputs"] if output["id"] == "xhs-01-p2")
        metrics_path = project / "pipeline" / "visual" / slug / "publish" / "r001" / "render" / "screenshot-swiss.metrics.json"
        measured = json.loads(metrics_path.read_text(encoding="utf-8"))["targets"]["xhs-01-p2"]["evidence_ratio"]
        assert evidence["evidence_ratio"] == pytest.approx(measured)
        assert evidence["evidence_ratio"] >= recipe["quality_policy"]["require_evidence_ratio"]
    if fixture_name == "research-analysis.json":
        diagram = next(output for output in index["outputs"] if output["id"] == "inline-01")
        assert diagram["provider"] == "baoyu-diagram"
        assert diagram["source_svg"].endswith("inline-01.svg")
