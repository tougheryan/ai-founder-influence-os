#!/usr/bin/env python3
"""Echo Founder visual publish generator."""
from __future__ import annotations

import csv
import base64
import hashlib
import importlib.util
import json
import html
import math
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from datetime import datetime
from contextlib import nullcontext
from pathlib import Path
from typing import Any
from layout_call_records import record_article_layout

from image_account_policy import (
    ImageAccountPolicyError,
    accepted_route_candidates,
    budget_limits,
    load_runtime_route_catalog,
    load_policy as load_image_account_policy,
    runtime_route_candidates,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_ROOT = Path(__file__).resolve().parents[1]
PROVIDER_REGISTRY_PATH = RUNTIME_ROOT / "config" / "visual_providers.json"
VISUAL_ROUTING_PATH = RUNTIME_ROOT / "config" / "visual-routing.json"
VISUAL_BRAND_PROFILES_PATH = RUNTIME_ROOT / "config" / "visual-brand-profiles.json"
XHS_TEMPLATE_PATH = REPO_ROOT / "skills" / "xhs-card" / "assets" / "template-swiss-card.html"
EDITORIAL_TEMPLATE_PATH = REPO_ROOT / "skills" / "xhs-card" / "assets" / "template-editorial-card.html"
VISUAL_SCREENSHOT_SCRIPT = RUNTIME_ROOT / "scripts" / "visual_screenshot.mjs"
PAID_IMAGE_GATEWAY_SCRIPT = RUNTIME_ROOT / "scripts" / "paid_image_gateway.py"
WECHAT_HTML_RENDERER_PATH = REPO_ROOT / "skills" / "dbs-wechat-html" / "generate_preview.py"
MD2WECHAT_THEME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
# Read-only compatibility for runs created before md2wechat became the
# product-side source of truth. New runs persist the md2wechat theme directly.
LEGACY_MD2WECHAT_THEME_ALIASES = {
    "publish_template": "wechat-native",
    "minimal": "minimal-green",
    "medium": "coffee-house",
    "wired": "sspai-red",
    "verge": "bytedance",
    "stripe": "github-readme",
    "apple": "apple",
    "ft": "nyt-classic",
    "linear": "minimal-blue",
    "github": "github-readme",
    "notion": "ink-minimal",
    "magazine": "coffee-house",
    "editorial": "coffee-house",
    "newspaper": "nyt-classic",
    "course": "focus-green",
    "event": "bold-green",
}
DISABLED_AI_VISUAL_RENDERERS = frozenset({"baoyu-comic", "ian-xiaohei-illustrations"})
AI_IMAGE_DISABLED_MESSAGE = "AI image generation is disabled; use stable local layout and existing materials"
EXECUTABLE_PROVIDER_STATUSES = {"default", "verified"}
EXECUTABLE_PROVIDER_FIELDS = ("license", "upstream", "pinned_revision", "license_review", "permitted_use")
_SAFE_SLUG_RE = re.compile(r"[A-Za-z0-9\u4e00-\u9fff-]{1,80}$")
_REVISION_ID_RE = re.compile(r"r[0-9]{3,}$")
_PENDING_RECIPE_RE = re.compile(
    r"\.(r[0-9]{3,})\.r[0-9]{3,}-request(?:-[0-9]{2})?\.visual-recipe\.pending\.json$"
)


class VisualPublishError(RuntimeError):
    """Base error for visual publish generation."""


class ProviderError(VisualPublishError):
    """Raised when no suitable visual provider can be selected."""


class PackageParseError(VisualPublishError):
    """Raised when package markdown cannot produce required visual tasks."""


class VisualOutputError(VisualPublishError):
    """Raised when rendered visual files are missing or invalid."""


def _visual_node_command(script: Path, arguments: list[str]) -> tuple[list[str], dict[str, str]]:
    """Resolve a JavaScript renderer without assuming a user-installed Node.

    The desktop shell passes its own Electron executable through
    ``AIFIOS_NODE_BINARY``. Electron becomes a regular Node runtime when
    ``ELECTRON_RUN_AS_NODE=1`` is present, so the local HTML renderers remain
    usable on a clean recipient Mac. CLI/source usage retains the normal
    system-Node fallback.
    """
    configured = str(os.environ.get("AIFIOS_NODE_BINARY") or "").strip()
    desktop_runtime = os.environ.get("AIFIOS_DESKTOP") == "1"
    if desktop_runtime and (not configured or not Path(configured).is_absolute()):
        raise VisualOutputError("Echo Founder 桌面运行时缺少有效的内置 Node。请重新安装 Echo Founder。")
    binary = configured or shutil.which("node") or ""
    if not binary:
        raise VisualOutputError(
            "本机视觉渲染需要内置 Node 运行时，但当前未找到。"
            "请从 Echo Founder 桌面端重新启动，或在开发环境安装 Node。"
        )
    env = os.environ.copy()
    if env.get("AIFIOS_NODE_RUN_AS_NODE") == "1":
        env["ELECTRON_RUN_AS_NODE"] = "1"
    return [binary, str(script), *arguments], env


def _run_visual_node_script(
    script: Path,
    arguments: list[str],
    *,
    cwd: Path,
    purpose: str,
) -> subprocess.CompletedProcess[str]:
    command, env = _visual_node_command(script, arguments)
    try:
        return subprocess.run(
            command,
            cwd=str(cwd),
            env=env,
            text=True,
            capture_output=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise VisualOutputError(f"{purpose} 无法启动：{exc}") from exc


def load_provider_registry(path: Path | str = PROVIDER_REGISTRY_PATH) -> list[dict[str, Any]]:
    registry_path = Path(path).expanduser().resolve(strict=False)
    data = json.loads(registry_path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ProviderError(f"provider registry must be a list: {registry_path}")
    return data


def validate_visual_provider_registry(registry: list[dict[str, Any]]) -> list[str]:
    """Return missing provenance fields for providers that may execute."""
    errors: list[str] = []
    for provider in registry:
        if provider.get("status") not in EXECUTABLE_PROVIDER_STATUSES:
            continue
        provider_id = str(provider.get("id") or "<unnamed-provider>")
        for field in EXECUTABLE_PROVIDER_FIELDS:
            if not str(provider.get(field) or "").strip():
                errors.append(f"{provider_id}: missing {field}")
        source = str(provider.get("source") or "").strip()
        if source.startswith(("/", "~")) or re.match(r"^[A-Za-z]:[\\/]", source):
            errors.append(f"{provider_id}: source must be portable, not an absolute local path")
    return errors


def choose_provider(registry: list[dict[str, Any]], task: str) -> dict[str, Any]:
    candidates = [
        item for item in registry
        if task in item.get("tasks", []) and item.get("status") in {"default", "verified"}
    ]
    if not candidates:
        raise ProviderError(f"no usable provider for task: {task}")
    candidates.sort(key=lambda item: (
        -int(item.get("quality_rank", 0)),
        int(item.get("estimated_cost_rank", 50)),
        int(item.get("estimated_latency_seconds", 999)),
        str(item.get("id") or ""),
    ))
    return candidates[0]


def _heading_body(body: str, heading: str, level: int = 2) -> str:
    hashes = "#" * level
    next_same_or_higher = r"(?=^#{1,%d}\s+|\Z)" % level
    match = re.search(
        rf"(?ms)^{hashes}\s*{re.escape(heading)}[^\n]*\n(.*?){next_same_or_higher}",
        body or "",
    )
    return match.group(1).strip() if match else ""


def _numbered_section(body: str, index: int, labels: tuple[str, ...]) -> str:
    """Read the current 1/2/3 package shape while keeping legacy packages usable."""
    label_pattern = "|".join(re.escape(label) for label in labels)
    match = re.search(
        rf"(?ms)^##\s*{index}\.\s*(?:{label_pattern})[^\n]*\n(.*?)(?=^##\s*\d+\.|\Z)",
        body or "",
    )
    return match.group(1).strip() if match else ""


def _subsections(body: str, prefix: str, level: int = 3) -> list[tuple[str, str]]:
    hashes = "#" * level
    pattern = rf"(?ms)^{hashes}\s*({re.escape(prefix)}\s*\d+[^\n]*)\n(.*?)(?=^{hashes}\s*{re.escape(prefix)}\s*\d+|^##\s+|\Z)"
    return [(match.group(1).strip(), match.group(2).strip()) for match in re.finditer(pattern, body or "")]


def _field(section: str, label: str) -> str:
    match = re.search(rf"(?m)^\s*[-*]\s*{re.escape(label)}\s*[：:]\s*(.+?)\s*$", section or "")
    return match.group(1).strip() if match else ""


def _body_after_heading(section: str, heading: str, level: int = 3) -> str:
    return _heading_body(section, heading, level=level)


def _table_rows(section: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in (section or "").splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or "---" in stripped:
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        rows.append(cells)
    return rows


def _parse_page_rows(post_section: str) -> list[dict[str, str]]:
    page_section = _heading_body(post_section, "页卡脚本", level=4)
    if not page_section:
        raise PackageParseError("图文内容缺少页卡脚本。")
    rows = _table_rows(page_section)
    if not rows:
        raise PackageParseError("页卡脚本缺少 Markdown 表格。")
    header = rows[0]
    required = ["页码", "页面标题", "页面正文", "画面/配图建议", "视觉层级", "排版重点"]
    if any(item not in header for item in required):
        raise PackageParseError("页卡脚本缺少视觉层级或排版重点。")
    indexes = {name: header.index(name) for name in required}
    pages: list[dict[str, str]] = []
    for row in rows[1:]:
        if len(row) < len(header):
            continue
        page_id = row[indexes["页码"]]
        if not re.fullmatch(r"P[1-5]", page_id):
            continue
        pages.append({
            "page_id": page_id,
            "title": row[indexes["页面标题"]],
            "body": row[indexes["页面正文"]],
            "image_prompt": row[indexes["画面/配图建议"]],
            "visual_hierarchy": row[indexes["视觉层级"]],
            "layout_note": row[indexes["排版重点"]],
        })
    missing = [f"P{idx}" for idx in range(1, 6) if f"P{idx}" not in {item["page_id"] for item in pages}]
    if missing:
        raise PackageParseError(f"页卡脚本缺少：{', '.join(missing)}。")
    return pages


def _parse_native_xhs_pages(section: str) -> list[dict[str, str]]:
    """Parse the v2 Xiaohongshu card table and expand compact page ranges."""
    page_section = _heading_body(section, "图文卡片脚本", level=3)
    rows = _table_rows(page_section)
    if not rows:
        raise PackageParseError("小红书原生图文缺少图文卡片脚本表格。")
    header = rows[0]
    required = ["页码", "页面标题", "页面正文", "视觉提示"]
    if any(item not in header for item in required):
        raise PackageParseError("小红书图文卡片脚本缺少页码、标题、正文或视觉提示。")
    indexes = {name: header.index(name) for name in required}
    pages: list[dict[str, str]] = []
    for row in rows[1:]:
        if len(row) < len(header):
            continue
        raw_page = row[indexes["页码"]].upper().replace(" ", "")
        if match := re.fullmatch(r"P([1-8])", raw_page):
            page_numbers = [int(match.group(1))]
        elif match := re.fullmatch(r"P([1-8])-P?([1-8])", raw_page):
            start, end = int(match.group(1)), int(match.group(2))
            page_numbers = list(range(start, end + 1)) if start <= end else []
        else:
            continue
        for page_number in page_numbers:
            pages.append({
                "page_id": f"P{page_number}",
                "title": row[indexes["页面标题"]],
                "body": row[indexes["页面正文"]],
                "image_prompt": row[indexes["视觉提示"]],
                "visual_hierarchy": "",
                "layout_note": row[indexes["视觉提示"]],
            })
    by_page = {item["page_id"]: item for item in pages}
    missing = [f"P{page}" for page in range(1, 9) if f"P{page}" not in by_page]
    if missing:
        raise PackageParseError(f"小红书图文卡片脚本缺少：{', '.join(missing)}。")
    return [by_page[f"P{page}"] for page in range(1, 9)]


def _parse_native_package_body(body: str, package_title: str) -> dict[str, Any]:
    from release_gate import build_package_manifest, _native_field_values

    manifest = build_package_manifest(body)
    if not manifest["valid"]:
        raise PackageParseError("；".join(manifest["errors"]))
    selected_platforms = manifest["target_platforms"]

    def _field(section: str, label: str) -> str:
        values = _native_field_values(section, label)
        if len(values) > 1:
            raise PackageParseError(f"“{label}”重复或冲突，请保留一个明确值。")
        return values[0] if values else ""

    wechat: dict[str, Any] | None = None
    wechat_section = _numbered_section(body, 1, ("公众号原生长文",))
    if "wechat" in selected_platforms:
        if not wechat_section:
            raise PackageParseError("已选择公众号，但内容包缺少公众号原生长文。")
        title = _field(wechat_section, "发布标题")
        article_body = _body_after_heading(wechat_section, "正文", level=3)
        if not title or not article_body:
            raise PackageParseError("公众号原生长文缺少发布标题或正文。")
        wechat = {
            "title": title,
            "cover_text": _field(wechat_section, "头图文案"),
            "summary": _field(wechat_section, "摘要"),
            "公众号排版提示": _field(wechat_section, "排版提示"),
            "配图位建议": _field(wechat_section, "排版提示"),
            "body": article_body,
            "comment_hook": _body_after_heading(wechat_section, "评论区承接", level=3),
        }
    elif wechat_section:
        raise PackageParseError("未选择公众号，不应生成公众号原生长文。")

    xhs_posts: list[dict[str, Any]] = []
    xhs_section = _numbered_section(body, 2, ("小红书原生图文",))
    if "xhs" in selected_platforms:
        if not xhs_section:
            raise PackageParseError("已选择小红书，但内容包缺少小红书原生图文。")
        publish = _body_after_heading(xhs_section, "发布正文", level=3)
        cover = _body_after_heading(xhs_section, "封面三句话", level=3)
        title = _field(publish, "标题")
        body_copy = _field(publish, "正文")
        if not title or not body_copy:
            raise PackageParseError("小红书原生图文缺少发布标题或正文。")
        cover_lines = [
            _field(cover, "主句"), _field(cover, "副句"), _field(cover, "补充句"),
        ]
        xhs_posts.append({
            "index": 1,
            "heading": "小红书原生图文",
            "title": title,
            "cover_text": " / ".join(item for item in cover_lines if item),
            "cover_lines": [item for item in cover_lines if item],
            "body": body_copy,
            "ending_tags": _body_after_heading(xhs_section, "结尾标签", level=3),
            "pages": _parse_native_xhs_pages(xhs_section),
        })
    elif xhs_section:
        raise PackageParseError("未选择小红书，不应生成小红书原生图文。")

    return {
        "schema": "echo-founder.platform-native-package.v2",
        "package_title": package_title,
        "title": (wechat or {}).get("title") or (xhs_posts[0].get("title") if xhs_posts else package_title),
        "selected_platforms": selected_platforms,
        "wechat": wechat,
        "videos": [],
        "xhs_posts": xhs_posts,
    }


def parse_package_body(body: str) -> dict[str, Any]:
    package_title_match = re.search(r"(?m)^#(?!#)\s+(.+?)\s*$", body or "")
    package_title = package_title_match.group(1).strip() if package_title_match else ""
    if "## 0. 共享事实底稿" in (body or ""):
        return _parse_native_package_body(body, package_title)
    wechat_section = _numbered_section(body, 1, ("公众号母稿", "公众号长文")) or _heading_body(body, "1. 公众号母稿", level=2)
    if not wechat_section:
        raise PackageParseError("package 缺少公众号母稿。")

    title = _field(wechat_section, "发布标题")
    cover_text = _field(wechat_section, "封面字")
    summary = _field(wechat_section, "摘要")
    layout_hint = _field(wechat_section, "公众号排版提示")
    image_slots = _field(wechat_section, "配图位建议")
    article_body = _body_after_heading(wechat_section, "正文", level=3)
    comment_hook = _body_after_heading(wechat_section, "评论区引导", level=3)
    if not title or not cover_text or not article_body:
        raise PackageParseError("公众号母稿缺少发布标题、封面字或正文。")

    video_root = _numbered_section(body, 2, ("短视频内容", "短视频口播", "短视频口播稿"))
    videos = []
    for idx, (heading, section) in enumerate(_subsections(video_root, "短视频", level=3), start=1):
        videos.append({
            "index": idx,
            "heading": heading,
            "title": _field(section, "发布标题"),
            "cover_text": _field(section, "封面字"),
            "hook": _field(section, "3 秒钩子") or _field(section, "3秒钩子") or _field(section, "开场钩子"),
            "duration": _field(section, "时长") or _field(section, "视频时长"),
            "script": _heading_body(section, "分段口播稿", level=4),
            "shots": _heading_body(section, "镜头清单", level=4),
            "subtitles": _heading_body(section, "字幕重点", level=4),
            # Keep this parser aligned with package_quality.py. Existing
            # content may use either the long or compact B-roll heading.
            "broll": (
                _heading_body(section, "B-roll 素材建议", level=4)
                or _heading_body(section, "B-roll素材建议", level=4)
                or _heading_body(section, "B-roll", level=4)
                or _heading_body(section, "B-Roll", level=4)
            ),
            "publish_notes": _heading_body(section, "发布备注", level=4),
        })

    # Current packages put share posts in section 3. Read the old section-2
    # shape as a migration path, but never confuse the new short-video section
    # with a carousel package.
    xhs_root = (
        _numbered_section(body, 3, ("图文内容", "分享观点图文", "分享观点"))
        or _numbered_section(body, 2, ("图文内容", "分享观点图文", "分享观点"))
    )
    if not xhs_root:
        raise PackageParseError("package 缺少图文内容。")
    xhs_posts = []
    for idx, (heading, section) in enumerate(_subsections(xhs_root, "图文", level=3), start=1):
        post_title = _field(section, "发布标题")
        post_cover = _field(section, "封面字")
        post_body = _field(section, "正文文案") or _field(section, "分享文案")
        pages = _parse_page_rows(section)
        xhs_posts.append({
            "index": idx,
            "heading": heading,
            "title": post_title,
            "cover_text": post_cover,
            "body": post_body,
            "pages": pages,
        })
    if len(xhs_posts) < 3:
        raise PackageParseError("图文内容少于 3 条。")

    return {
        "package_title": package_title,
        "title": title,
        "wechat": {
            "title": title,
            "cover_text": cover_text,
            "summary": summary,
            "公众号排版提示": layout_hint,
            "配图位建议": image_slots,
            "body": article_body,
            "comment_hook": comment_hook,
        },
        "videos": videos[:2],
        "xhs_posts": xhs_posts[:3],
    }


def build_visual_tasks(parsed: dict[str, Any], slug: str, package_rel: str) -> list[dict[str, Any]]:
    base = f"pipeline/visual/{slug}/publish"
    tasks: list[dict[str, Any]] = []
    if isinstance(parsed.get("wechat"), dict):
        tasks.extend([{
            "id": "wechat-html",
            "kind": "wechat_html",
            "provider_task": "wechat_html",
            "source": package_rel,
            "output": f"{base}/wechat/wechat-article.html",
            "payload": parsed["wechat"],
        },
        {
            "id": "wechat-cover-21x9",
            "kind": "wechat_cover",
            "provider_task": "wechat_cover_pair",
            "source": package_rel,
            "output": f"{base}/wechat/wechat-cover-21x9.png",
            "width": 2100,
            "height": 900,
            "payload": parsed["wechat"],
        },
        {
            "id": "wechat-share-1x1",
            "kind": "wechat_cover",
            "provider_task": "wechat_cover_pair",
            "source": package_rel,
            "output": f"{base}/wechat/wechat-share-1x1.png",
            "width": 1080,
            "height": 1080,
            "payload": parsed["wechat"],
        }])
    for post in parsed["xhs_posts"]:
        post_no = f"{post['index']:02d}"
        for page_idx, page in enumerate(post["pages"], start=1):
            name = "cover" if page_idx == 1 else ("cta" if page_idx == len(post["pages"]) else "page")
            tasks.append({
                "id": f"xhs-post-{post_no}-page-{page_idx:02d}",
                "kind": "xhs_card",
                "provider_task": "xhs_cards",
                "source": package_rel,
                "output": f"{base}/xhs/post-{post_no}/{page_idx:02d}-{name}.png",
                "width": 1080,
                "height": 1440,
                "payload": {"post": post, "page": page},
            })
    if not isinstance(parsed.get("wechat"), dict):
        return tasks
    image_slots = parsed["wechat"].get("配图位建议", "")
    inline_specs = [
        ("inline-01-flow", "流程图", "01-flow.png"),
        ("inline-02-matrix", "四象限检查卡", "02-matrix.png"),
        ("inline-03-process", "流程卡片", "03-process.png"),
    ]
    for task_id, label, filename in inline_specs:
        tasks.append({
            "id": task_id,
            "kind": "inline_image",
            "provider_task": "inline_infographic",
            "source": package_rel,
            "output": f"{base}/inline/{filename}",
            "width": 1600,
            "height": 900,
            "payload": {
                "title": parsed["title"],
                "label": label,
                "image_slots": image_slots,
                "display_copy": parsed["wechat"].get("summary") or parsed["wechat"].get("body") or parsed["title"],
            },
        })
    return tasks


def _collect_material_paths(value: Any, output: set[str]) -> None:
    """Collect project-relative material paths from a run-owned JSON record."""
    if isinstance(value, str):
        normalized = value.strip().replace("\\", "/")
        if normalized.startswith("materials/") and ".." not in Path(normalized).parts:
            output.add(normalized)
        return
    if isinstance(value, list):
        for item in value:
            _collect_material_paths(item, output)
        return
    if isinstance(value, dict):
        for item in value.values():
            _collect_material_paths(item, output)


def _run_material_paths(project: Path, slug: str) -> set[str]:
    """Return material files explicitly owned or referenced by the current run."""
    if not _SAFE_SLUG_RE.fullmatch(slug):
        return set()
    records = [
        project / "sessions" / "material-analysis" / f"{slug}.json",
        project / "runs" / f"{slug}.json",
    ]
    tasks = project / "runs" / slug / "tasks"
    if tasks.is_dir():
        records.extend(sorted(tasks.glob("*.json")))

    paths: set[str] = set()
    for record in records:
        try:
            payload = json.loads(record.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        _collect_material_paths(payload, paths)
    return paths


def _project_material_assets(project: Path, slug: str | None = None) -> dict[str, Any]:
    """Build a deterministic, run-scoped local material index for Visual Director."""
    root = project / "materials"
    if not root.exists():
        return {"assets": []}

    scoped_paths = _run_material_paths(project, slug) if slug else set()
    # Production runs have an input inventory, which may intentionally contain
    # no files. Legacy CLI projects without one still use their material folder.
    has_run_scope = bool(slug and (project / "sessions" / "material-analysis" / f"{slug}.json").exists())
    screenshot_suffixes = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    data_suffixes = {".csv", ".tsv", ".json"}
    document_suffixes = {".md", ".txt"}
    assets: list[dict[str, str]] = []
    for candidate in sorted(path for path in root.rglob("*") if path.is_file()):
        try:
            relative = _project_rel(project, candidate)
        except ValueError:
            continue
        # Library records contain prompts, provenance and review state. They
        # are never public datasets, even when the current run references them.
        if _is_library_record(relative):
            continue
        if (scoped_paths or has_run_scope) and relative not in scoped_paths:
            continue
        suffix = candidate.suffix.lower()
        if suffix in screenshot_suffixes:
            path_tokens = set(re.findall(r"[a-z0-9]+", relative.lower()))
            is_screen = bool(path_tokens & {"screen", "screenshot", "screenshots", "ui"}) or (
                "product" in path_tokens
                and bool(path_tokens & {"demo", "flow", "workflow", "interface"})
            )
            assets.append({
                "path": relative,
                "kind": "screenshot" if is_screen else "image",
                "role": "product_ui" if is_screen else "source_image",
            })
        elif suffix in data_suffixes:
            assets.append({"path": relative, "kind": "data", "role": "source_data"})
        elif suffix in document_suffixes:
            assets.append({"path": relative, "kind": "document", "role": "source_note"})
    return {"assets": assets}


def _is_library_record(relative: str) -> bool:
    return relative == "materials/library/index.json" or relative.startswith("materials/library/history/")


def _recipe_uses_library_records(recipe: dict[str, Any]) -> bool:
    assets = recipe.get("assets")
    return isinstance(assets, list) and any(
        isinstance(asset, dict) and _is_library_record(str(asset.get("source") or ""))
        for asset in assets
    )


def _recipe_file_for_revision(project: Path, slug: str, revision_id: str) -> Path:
    return project / "pipeline" / "visual" / slug / "recipes" / f"{revision_id}.visual-recipe.json"


def _validate_visual_slug(slug: str) -> str:
    if not isinstance(slug, str) or not _SAFE_SLUG_RE.fullmatch(slug):
        raise VisualOutputError("visual slug contains unsafe path characters")
    return slug


def _project_input_file(project: Path, value: Path | str, label: str) -> Path:
    raw_text = str(value)
    raw = Path(value).expanduser()
    if "\\" in raw_text or "\x00" in raw_text or ".." in raw.parts:
        raise VisualOutputError(f"{label} contains unsafe path traversal")
    candidate = raw if raw.is_absolute() else project / raw
    resolved = candidate.resolve(strict=False)
    project_root = project.resolve(strict=False)
    try:
        resolved.relative_to(project_root)
    except ValueError as exc:
        raise VisualOutputError(f"{label} must be inside the project") from exc
    if not resolved.is_file():
        raise VisualOutputError(f"missing {label}: {value}")
    return resolved


def _visual_root(project: Path, slug: str) -> Path:
    return project.resolve(strict=False) / "pipeline" / "visual" / slug


def _validated_recipes_dir(project: Path, slug: str) -> Path:
    recipes_dir = _visual_root(project, slug) / "recipes"
    if recipes_dir.resolve(strict=False) != recipes_dir:
        raise VisualOutputError(
            f"visual recipes boundary must be inside the project at pipeline/visual/{slug}/recipes"
        )
    return recipes_dir


def _validated_selection_path(project: Path, slug: str) -> Path:
    selection_path = _visual_root(project, slug) / "selected-revision.json"
    if selection_path.resolve(strict=False) != selection_path:
        raise VisualOutputError(
            f"selected revision pointer boundary must be inside the project at "
            f"pipeline/visual/{slug}/selected-revision.json"
        )
    return selection_path


def _validated_recipe_input_path(project: Path, slug: str, value: Path | str) -> Path:
    """Resolve a final or staged recipe only after checking its canonical boundary."""
    raw_text = str(value)
    raw = Path(value).expanduser()
    if "\\" in raw_text or "\x00" in raw_text or ".." in raw.parts:
        raise VisualOutputError("visual recipe contains unsafe path traversal")
    candidate = raw if raw.is_absolute() else project / raw
    resolved = candidate.resolve(strict=False)

    recipes_dir = _validated_recipes_dir(project, slug)
    if resolved.parent == recipes_dir:
        return resolved

    revisions_dir = _visual_root(project, slug) / "revisions"
    if revisions_dir.resolve(strict=False) == revisions_dir and resolved.parent == revisions_dir:
        if _PENDING_RECIPE_RE.fullmatch(resolved.name):
            return resolved
    raise VisualOutputError(
        f"visual recipe path must be inside pipeline/visual/{slug}/recipes or its revisions staging directory"
    )


def _visual_recipe_input_file(project: Path, slug: str, value: Path | str) -> Path:
    resolved = _validated_recipe_input_path(project, slug, value)
    if not resolved.is_file():
        raise VisualOutputError(f"missing visual recipe: {value}")
    return resolved


def _validate_recipe_file_location(
    project: Path,
    slug: str,
    revision_id: str,
    recipe_file: Path,
) -> None:
    resolved = _validated_recipe_input_path(project, slug, recipe_file)
    recipes_dir = _validated_recipes_dir(project, slug)
    if resolved == recipes_dir / f"{revision_id}.visual-recipe.json":
        return

    match = _PENDING_RECIPE_RE.fullmatch(resolved.name)
    if resolved.parent == _visual_root(project, slug) / "revisions" and match and match.group(1) == revision_id:
        return
    raise VisualOutputError(
        f"visual recipe path must be inside pipeline/visual/{slug}/recipes or its revisions staging directory "
        "and match revision_id"
    )


def _load_or_build_default_recipe(
    project: Path,
    slug: str,
    parsed: dict[str, Any],
    package_rel: str,
    selected_template: str | None = None,
    visual_preferences: dict[str, Any] | None = None,
    selected_direction: str = "direction-a",
    force_new_revision: bool = False,
) -> tuple[Path | None, dict[str, Any] | None]:
    """Use the selected/latest recipe, or create r001 from real project materials."""
    native = parsed.get("schema") == "echo-founder.platform-native-package.v2"
    materials = _project_material_assets(project, slug)
    # Content and actual source bytes participate in recipe reuse. Old adopted
    # revisions remain immutable; changed input produces a new candidate.
    source_hashes = {}
    if native:
        for asset in materials.get("assets", []):
            source = _project_source(project, asset["path"], "visual evidence")
            source_hashes[asset["path"]] = hashlib.sha256(source.read_bytes()).hexdigest()
    input_hash = hashlib.sha256(json.dumps(
        {"package": parsed, "path": package_rel, "materials": materials, "sources": source_hashes,
         "template": selected_template, "page_evidence_version": 1},
        ensure_ascii=False, sort_keys=True,
    ).encode()).hexdigest()

    def reusable(recipe: dict[str, Any]) -> bool:
        return not native or recipe.get("source_input_sha256") == input_hash

    recipes_dir = _validated_recipes_dir(project, slug)
    existing = (
        sorted(
            (_validated_recipe_input_path(project, slug, path) for path in recipes_dir.glob("r*.visual-recipe.json")),
            key=lambda path: path.name,
        )
        if recipes_dir.exists()
        else []
    )
    selection_path = _validated_selection_path(project, slug)
    if selection_path.exists() and not force_new_revision:
        try:
            selected_revision = str(json.loads(selection_path.read_text(encoding="utf-8")).get("revision_id") or "")
        except (OSError, json.JSONDecodeError):
            selected_revision = ""
        selected_path = _recipe_file_for_revision(project, slug, selected_revision) if re.fullmatch(r"r\d{3,}", selected_revision) else None
        if selected_path:
            selected_path = _validated_recipe_input_path(project, slug, selected_path)
        if selected_path and selected_path.exists():
            selected_recipe = json.loads(selected_path.read_text(encoding="utf-8"))
            if reusable(selected_recipe) and not _recipe_uses_library_records(selected_recipe) and (visual_preferences is None or (
                selected_recipe.get("visual_preferences") == visual_preferences
                and selected_recipe.get("selected_direction") == selected_direction
            )):
                return selected_path, selected_recipe
    if existing and not force_new_revision:
        recipe_file = existing[-1]
        existing_recipe = json.loads(recipe_file.read_text(encoding="utf-8"))
        if reusable(existing_recipe) and not _recipe_uses_library_records(existing_recipe) and (visual_preferences is None or (
            existing_recipe.get("visual_preferences") == visual_preferences
            and existing_recipe.get("selected_direction") == selected_direction
        )):
            return recipe_file, existing_recipe

    from visual_director import build_visual_recipe

    routing = json.loads(VISUAL_ROUTING_PATH.read_text(encoding="utf-8"))
    brand_profiles = json.loads(VISUAL_BRAND_PROFILES_PATH.read_text(encoding="utf-8"))
    package = {**parsed, "source_package": package_rel}
    existing_revision_numbers = [
        int(match.group(1))
        for path in existing
        if (match := re.fullmatch(r"r([0-9]{3,})\.visual-recipe\.json", path.name))
    ]
    next_revision = f"r{max(existing_revision_numbers or [0]) + 1:03d}"
    recipe = build_visual_recipe(
        package,
        materials,
        slug,
        routing,
        brand_profiles,
        revision_id=next_revision,
        selected_template=selected_template,
        visual_preferences=visual_preferences,
        selected_direction=selected_direction,
    )
    if native:
        recipe["source_input_sha256"] = input_hash

    recipe_file = _validated_recipe_input_path(
        project,
        slug,
        _recipe_file_for_revision(project, slug, str(recipe["revision_id"])),
    )
    recipe_file.parent.mkdir(parents=True, exist_ok=True)
    recipe_file.write_text(json.dumps(recipe, ensure_ascii=False, indent=2), encoding="utf-8")
    return recipe_file, recipe


def _selected_immutable_result(
    project: Path,
    slug: str,
    revision_id: str,
    *,
    allow_revision_candidate: bool,
) -> dict[str, Any] | None:
    selection_path = _validated_selection_path(project, slug)
    if not selection_path.exists():
        return None
    try:
        selection = json.loads(selection_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VisualOutputError("selected revision is immutable but its adoption pointer is invalid") from exc
    selected_revision = selection.get("revision_id") if isinstance(selection, dict) else None
    if not isinstance(selected_revision, str) or not _REVISION_ID_RE.fullmatch(selected_revision):
        raise VisualOutputError("selected revision is immutable but its adoption pointer is invalid")
    if selected_revision != revision_id:
        if allow_revision_candidate:
            return None
        raise VisualOutputError("new visual revisions must be generated by the revision consumer")

    from visual_release import resolve_selected_visual_release

    release = resolve_selected_visual_release(project, slug)
    if release.get("status") != "pass":
        detail = "; ".join(str(item) for item in release.get("errors", []) if str(item).strip())
        raise VisualOutputError(
            "selected revision is immutable and cannot be regenerated"
            + (f": {detail}" if detail else "")
        )
    index = release["index"]
    return {
        "status": "selected",
        "slug": slug,
        "index_path": str(project / release["index_path"]),
        "outputs": list(index.get("outputs") or []),
        "quality_summary": index.get("quality_summary"),
        "visual_record": None,
        "immutable": True,
    }


def _template_style(layout_recipe: str) -> str:
    return "editorial" if str(layout_recipe or "").upper().startswith("M") else "swiss"


def _recipe_asset_output(base: str, asset: dict[str, Any]) -> tuple[str, int | None, int | None, str]:
    asset_id = str(asset.get("id") or "")
    if asset_id == "wechat-html":
        return f"{base}/wechat/wechat-article.html", None, None, "wechat_html"
    if asset_id == "wechat-cover":
        return f"{base}/wechat/wechat-cover-21x9.png", 2100, 900, "wechat_cover"
    if asset_id == "wechat-share":
        return f"{base}/wechat/wechat-share-1x1.png", 1080, 1080, "wechat_cover"
    if asset_id == "wechat-cover-alt-01":
        return f"{base}/wechat/wechat-cover-alt-01-21x9.png", 2100, 900, "wechat_cover"
    if asset_id == "wechat-share-alt-01":
        return f"{base}/wechat/wechat-share-alt-01-1x1.png", 1080, 1080, "wechat_cover"
    if asset_id == "wechat-cover-alt-02":
        return f"{base}/wechat/wechat-cover-alt-02-21x9.png", 2100, 900, "wechat_cover"
    if asset_id == "wechat-share-alt-02":
        return f"{base}/wechat/wechat-share-alt-02-1x1.png", 1080, 1080, "wechat_cover"
    xhs_match = re.fullmatch(r"xhs-(\d+)-p([1-8])", asset_id)
    if xhs_match:
        post_no, page_no = xhs_match.groups()
        page_index = int(page_no)
        suffix = "cover" if page_index == 1 else ("cta" if asset.get("role") == "cta" else "page")
        return f"{base}/xhs/post-{post_no}/{page_index:02d}-{suffix}.png", 1080, 1440, "xhs_card"
    moments_match = re.fullmatch(r"moments-(\d+)-p([135])", asset_id)
    if moments_match:
        post_no, page_no = moments_match.groups()
        page_index = int(page_no)
        upload_order = {1: 1, 3: 2, 5: 3}[page_index]
        return (
            f"{base}/moments/post-{post_no}/{upload_order:02d}-p{page_index}-square.png",
            1080,
            1080,
            "moments_card",
        )
    video_match = re.fullmatch(r"video-(\d+)-cover", asset_id)
    if video_match:
        video_no = int(video_match.group(1))
        return f"{base}/video/video-{video_no:02d}-cover-9x16.png", 1080, 1920, "video_cover"
    safe_id = re.sub(r"[^a-z0-9-]+", "-", asset_id.lower()).strip("-") or "asset"
    return f"{base}/inline/{safe_id}.png", 1600, 900, "inline_image"


def _recipe_asset_visual_system(recipe: dict[str, Any], asset: dict[str, Any], layout_recipe: str) -> str:
    if layout_recipe.startswith(("M", "S")):
        return _template_style(layout_recipe)
    platform = str(asset.get("platform") or "")
    platform_config = recipe.get("platforms", {}).get(platform, {})
    if isinstance(platform_config, dict) and platform_config.get("system"):
        return str(platform_config["system"])
    return "adaptive"


def _recipe_provider_task(kind: str, asset: dict[str, Any]) -> str:
    if kind == "wechat_html":
        return "wechat_html"
    if kind == "wechat_cover":
        return "wechat_cover_pair"
    if kind in {"xhs_card", "moments_card", "video_cover"}:
        return "xhs_cards"
    renderer_tasks = {
        "baoyu-diagram": "diagram",
        "baoyu-comic": "comic",
        "baoyu-infographic": "inline_infographic",
        "ian-xiaohei-illustrations": "illustration",
    }
    renderer = str(asset.get("renderer") or "")
    if renderer not in renderer_tasks:
        raise PackageParseError(f"unsupported inline visual renderer: {renderer or '<missing>'}")
    return renderer_tasks[renderer]


def build_visual_tasks_from_recipe(
    parsed: dict[str, Any],
    recipe: dict[str, Any],
    slug: str,
    package_rel: str,
) -> list[dict[str, Any]]:
    """Translate a validated recipe into renderer tasks without losing page intent."""
    if not _SAFE_SLUG_RE.fullmatch(slug):
        raise PackageParseError("visual slug contains unsafe path characters")
    if recipe.get("slug") != slug:
        raise PackageParseError("visual recipe slug does not match the requested slug")
    revision_id = str(recipe.get("revision_id") or "").strip()
    if not _REVISION_ID_RE.fullmatch(revision_id):
        raise PackageParseError("visual recipe revision_id must match ^r[0-9]{3,}$")
    base = f"pipeline/visual/{slug}/publish/{revision_id}"
    recipe_assets = recipe.get("assets")
    if not isinstance(recipe_assets, list) or not recipe_assets:
        raise PackageParseError("visual recipe 缺少 assets。")
    tasks: list[dict[str, Any]] = []
    for asset in recipe_assets:
        if not isinstance(asset, dict):
            raise PackageParseError("visual recipe 的 asset 必须是对象。")
        asset_id = str(asset.get("id") or "")
        output, width, height, kind = _recipe_asset_output(base, asset)
        layout_recipe = str(asset.get("layout_recipe") or "")
        evidence_sources = [str(asset["source"])] if asset.get("source") else []
        task: dict[str, Any] = {
            "id": asset_id,
            "slug": slug,
            "kind": kind,
            "provider_task": _recipe_provider_task(kind, asset),
            "source": package_rel,
            "output": output,
            "width": width,
            "height": height,
            "layout_recipe": layout_recipe,
            "role": str(asset.get("role") or ""),
            "platform": str(asset.get("platform") or ""),
            "template_style": _template_style(layout_recipe),
            "evidence_sources": evidence_sources,
            "requested_renderer": str(asset.get("renderer") or ""),
            "recipe_path": str(recipe.get("recipe_path") or f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"),
            "revision_id": revision_id,
            "parent_revision_id": recipe.get("parent_revision_id"),
            "visual_system": _recipe_asset_visual_system(recipe, asset, layout_recipe),
            "brand_profile": str(recipe.get("brand_profile") or "adaptive"),
            "brand_system": recipe.get("brand_system") if isinstance(recipe.get("brand_system"), dict) else {},
            "visual_mode": (recipe.get("visual_preferences") or {}).get("mode"),
            "provider_policy": (recipe.get("visual_preferences") or {}).get("provider_policy"),
            "selected_direction": recipe.get("selected_direction"),
        }
        for key in (
            "layout_style",
            "cover_strategy",
            "cover_direction",
            "requires_authorized_source",
            "share_format",
            "series_system",
            "card_structure",
            "narrative_stage",
            "insert_after",
            "caption",
            "semantic_brief",
            "inline_order",
            "inline_structure",
            "video_index",
            "upload_format",
            "upload_order",
            "source_type",
            "consistency_group",
            "art_direction_id",
            "text_overlay",
            "generation",
        ):
            if key in asset:
                task[key] = asset[key]
        copy = asset.get("copy") if isinstance(asset.get("copy"), dict) else {}
        overlay = asset.get("text_overlay") if isinstance(asset.get("text_overlay"), dict) else {}
        task["expected_text"] = str(overlay.get("expected_text") or "").strip() or " ".join(
            part for part in (str(copy.get("headline") or "").strip(), str(copy.get("supporting") or "").strip()) if part
        )
        if kind == "wechat_html":
            wechat_recipe = recipe.get("platforms", {}).get("wechat", {})
            task["payload"] = {**parsed["wechat"], "layout_selection": wechat_recipe.get("layout_selection", {})}
            if "wechat_layout" in wechat_recipe:
                task["payload"]["wechat_layout"] = wechat_recipe["wechat_layout"]
        elif kind == "wechat_cover":
            task["payload"] = {**parsed["wechat"], "layout_recipe": layout_recipe}
        elif kind in {"xhs_card", "moments_card"}:
            match = (
                re.fullmatch(r"xhs-(\d+)-p([1-8])", asset_id)
                if kind == "xhs_card"
                else re.fullmatch(r"moments-(\d+)-p([135])", asset_id)
            )
            if not match:
                raise PackageParseError(f"无法解析图文 asset id：{asset_id}")
            post_index = int(match.group(1)) - 1
            page_index = int(match.group(2)) - 1
            posts = parsed.get("xhs_posts", [])
            if post_index >= len(posts) or page_index >= len(posts[post_index].get("pages", [])):
                raise PackageParseError(f"visual recipe 指向不存在的图文页：{asset_id}")
            post = dict(posts[post_index])
            page = {**post["pages"][page_index]}
            copy = asset.get("copy") if isinstance(asset.get("copy"), dict) else {}
            if copy.get("headline"):
                page["title"] = str(copy["headline"])
            if copy.get("supporting"):
                page["body"] = str(copy["supporting"])
            for key in ("image_prompt", "visual_hierarchy", "layout_note"):
                if asset.get(key):
                    page[key] = str(asset[key])
            task["payload"] = {"post": post, "page": page}
            if kind == "xhs_card" and parsed.get("schema") == "echo-founder.platform-native-package.v2":
                task["native_copy"] = True
                task["expected_copy"] = _native_card_copy(task)
                task["expected_text"] = " ".join(task["expected_copy"])
        elif kind == "video_cover":
            match = re.fullmatch(r"video-(\d+)-cover", asset_id)
            video_index = int(match.group(1)) - 1 if match else -1
            videos = parsed.get("videos") if isinstance(parsed.get("videos"), list) else []
            if video_index < 0 or video_index >= len(videos) or not isinstance(videos[video_index], dict):
                raise PackageParseError(f"visual recipe 指向不存在的短视频：{asset_id}")
            task["payload"] = {"video": dict(videos[video_index])}
        else:
            task["payload"] = {
                "title": parsed["title"],
                "label": str(asset.get("caption") or asset.get("role") or "正文配图"),
                "image_slots": str(asset.get("semantic_brief") or asset.get("image_prompt") or parsed["wechat"].get("配图位建议") or ""),
                "display_copy": str(asset.get("semantic_brief") or parsed["wechat"].get("summary") or parsed["wechat"].get("body") or parsed["title"]),
                "section_heading": str(asset.get("insert_after") or ""),
            }
        tasks.append(task)
    return tasks


def _relative_path_has_unsafe_syntax(relative_path: Any) -> bool:
    if not isinstance(relative_path, str) or not relative_path or relative_path != relative_path.strip():
        return True
    if "\\" in relative_path or "\x00" in relative_path or any(ord(char) < 32 for char in relative_path):
        return True
    candidate = Path(relative_path)
    return candidate.is_absolute() or any(part in {"", ".", ".."} for part in relative_path.split("/"))


def _project_source(project: Path, relative_path: str, label: str) -> Path:
    if _relative_path_has_unsafe_syntax(relative_path):
        raise VisualOutputError(f"{label} must be a safe project-relative path")
    candidate = Path(relative_path)
    project_root = project.resolve(strict=False)
    current = project_root
    for part in candidate.parts:
        current = current / part
        if current.is_symlink():
            raise VisualOutputError(f"{label} must not use a symlink: {relative_path}")
    resolved = (project_root / candidate).resolve(strict=False)
    try:
        resolved.relative_to(project_root)
    except ValueError as exc:
        raise VisualOutputError(f"{label} must be inside the project") from exc
    if not resolved.is_file() or resolved.stat().st_size <= 0:
        raise VisualOutputError(f"missing {label}: {relative_path}")
    return resolved


def _project_output(
    project: Path,
    relative_path: str,
    label: str,
    *,
    within: Path | None = None,
) -> Path:
    if _relative_path_has_unsafe_syntax(relative_path):
        raise VisualOutputError(f"{label} must be inside the project and cannot contain path traversal")
    candidate = Path(relative_path)
    resolved = (project / candidate).resolve(strict=False)
    project_root = project.resolve(strict=False)
    try:
        resolved.relative_to(project_root)
    except ValueError as exc:
        raise VisualOutputError(f"{label} must be inside the project") from exc
    if within is not None:
        allowed_root = within.resolve(strict=False)
        try:
            allowed_relative = allowed_root.relative_to(project_root)
        except ValueError as exc:
            raise VisualOutputError(f"{label} boundary must be inside the project") from exc
        try:
            resolved.relative_to(allowed_root)
        except ValueError as exc:
            raise VisualOutputError(f"{label} must be inside {allowed_relative}") from exc
    return resolved


def _recipe_publish_root(project: Path, slug: str, revision_id: str) -> Path:
    _validate_visual_slug(slug)
    if not _REVISION_ID_RE.fullmatch(revision_id):
        raise VisualOutputError("visual recipe revision_id must match ^r[0-9]{3,}$")
    return project / "pipeline" / "visual" / slug / "publish" / revision_id


def _validate_recipe_tasks(
    project: Path,
    slug: str,
    revision_id: str,
    recipe_rel: str,
    tasks: list[dict[str, Any]],
) -> None:
    publish_root = _recipe_publish_root(project, slug, revision_id)
    for task in tasks:
        if task.get("slug") != slug or task.get("revision_id") != revision_id:
            raise VisualOutputError("visual task identity does not match its recipe")
        if task.get("recipe_path") != recipe_rel:
            raise VisualOutputError("visual task recipe_path does not match the executed recipe")
        output = _project_output(project, task.get("output"), "publish output", within=publish_root)
        task["output"] = _project_rel(project, output)



def _project_rel(project: Path, path: Path) -> str:
    return str(path.resolve(strict=False).relative_to(project.resolve(strict=False)))


def _write_png(path: Path, width: int, height: int, rgb: tuple[int, int, int] = (245, 245, 240)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)

    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    raw_row = b"\x00" + bytes(rgb) * width
    raw = raw_row * height
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, level=1))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)


def _png_size(path: Path) -> tuple[int, int]:
    data = path.read_bytes()
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise VisualOutputError(f"invalid png: {path}")
    return struct.unpack(">II", data[16:24])


def _load_wechat_html_renderer() -> Any:
    spec = importlib.util.spec_from_file_location("aifios_dbs_wechat_html_renderer", WECHAT_HTML_RENDERER_PATH)
    if spec is None or spec.loader is None:
        raise VisualOutputError(f"cannot load dbs-wechat-html renderer: {WECHAT_HTML_RENDERER_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _inline_figure_html(asset: dict[str, Any]) -> str:
    asset_id = _clean_text(asset.get("id") or "inline")
    source = _clean_text(asset.get("src"))
    caption = _clean_text(asset.get("caption") or "正文图解")
    anchor = _clean_text(asset.get("insert_after"))
    if not source:
        return ""
    return (
        f'<figure class="aifios-inline-figure" style="margin:28px 0 32px;padding:0;max-width:100%;" '
        f'data-aifios-asset-id="{html.escape(asset_id, quote=True)}" '
        f'data-aifios-insert-after="{html.escape(anchor, quote=True)}">'
        f'<img style="display:block;width:100%;height:auto;" '
        f'src="{html.escape(source, quote=True)}" alt="{html.escape(caption, quote=True)}">'
        f'<figcaption style="margin-top:8px;color:#777;font-size:12px;line-height:1.55;text-align:center;">'
        f'{html.escape(caption)}</figcaption>'
        "</figure>"
    )


def _inject_inline_assets(body_html: str, inline_assets: list[dict[str, Any]]) -> str:
    """Place each semantic visual after its declared article section heading."""
    rendered = body_html
    deferred: list[str] = []
    for asset in inline_assets:
        figure = _inline_figure_html(asset)
        if not figure:
            continue
        anchor = _clean_text(asset.get("insert_after"))
        if not anchor:
            deferred.append(figure)
            continue
        insertion_at = -1
        for heading in re.finditer(r"<h[2-6]\b[^>]*>.*?</h[2-6]>", rendered, flags=re.IGNORECASE | re.DOTALL):
            heading_text = _clean_text(html.unescape(re.sub(r"<[^>]+>", "", heading.group(0))))
            if heading_text == anchor or anchor in heading_text:
                insertion_at = heading.end()
                break
        if insertion_at >= 0:
            rendered = rendered[:insertion_at] + figure + rendered[insertion_at:]
        else:
            deferred.append(figure)
    if not deferred:
        return rendered
    tail = "\n".join(deferred)
    body_end = re.search(r"</body\s*>", rendered, flags=re.IGNORECASE)
    if body_end:
        return rendered[:body_end.start()] + tail + "\n" + rendered[body_end.start():]
    return rendered + "\n" + tail


def _render_html(
    path: Path,
    title: str,
    body: str,
    visual_system: str = "swiss",
    layout_style: str | None = None,
    inline_assets: list[dict[str, Any]] | None = None,
) -> None:
    if not WECHAT_HTML_RENDERER_PATH.is_file():
        raise VisualOutputError(f"missing dbs-wechat-html renderer: {WECHAT_HTML_RENDERER_PATH}")
    path.parent.mkdir(parents=True, exist_ok=True)
    renderer = _load_wechat_html_renderer()
    styles = renderer.load_styles_from_markdown()
    requested = _clean_text(layout_style)
    style_id = requested if requested in styles else ("editorial" if visual_system == "editorial" and "editorial" in styles else "minimal")
    _style_name, _scenario, css = styles[style_id]
    css += (
        "\n.aifios-inline-figure{margin:28px 0 32px;padding:0;max-width:100%;}"
        ".aifios-inline-figure img{display:block;width:100%;height:auto;}"
        ".aifios-inline-figure figcaption{margin-top:8px;color:#777;font-size:12px;line-height:1.55;text-align:center;}"
    )
    markdown = f"# {title.strip()}\n\n{body.strip()}\n"
    body_html = renderer.md_to_html(markdown)
    if inline_assets:
        body_html = _inject_inline_assets(body_html, inline_assets)
    rendered = renderer.build_html(title, body_html, css)
    path.write_text(rendered, encoding="utf-8")


def _render_md2wechat_html(
    path: Path,
    title: str,
    body: str,
    layout_style: str,
    *,
    project: Path | None = None,
    task: dict[str, Any] | None = None,
    wechat_layout: dict[str, Any] | None = None,
    source_package_sha256: str | None = None,
) -> dict[str, Any]:
    """Render one WeChat-compatible article through the installed CLI.

    md2wechat is a document renderer here. Echo Founder never invokes its
    image commands. A missing/unconfigured CLI is expected and handled by the
    deterministic bundled renderer in ``_render_wechat_layout_package``.
    """
    binary = str(os.environ.get("MD2WECHAT_BINARY") or "").strip() or str(shutil.which("md2wechat") or "")
    if not binary:
        raise VisualOutputError("md2wechat CLI is not installed")
    requested_theme = _clean_text(layout_style).lower()
    theme = LEGACY_MD2WECHAT_THEME_ALIASES.get(requested_theme, requested_theme)
    if not MD2WECHAT_THEME_RE.fullmatch(theme):
        raise VisualOutputError("md2wechat theme id is invalid")
    if wechat_layout is not None:
        from wechat_layout_refinement import prepare_wechat_markdown

        try:
            if wechat_layout.get("theme") != theme:
                raise ValueError("排版参数中的主题与实际请求不一致。")
            markdown = prepare_wechat_markdown(title, body, wechat_layout, source_package_sha256)
        except ValueError as exc:
            raise VisualOutputError(str(exc)) from exc
    else:
        markdown = f"# {title.strip()}\n\n{body.strip()}\n"
    refinement_metadata: dict[str, Any] = {}
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="echo-md2wechat-") as temporary_dir:
        source = Path(temporary_dir) / "article.md"
        source.write_text(markdown, encoding="utf-8")
        context = record_article_layout(
            project,
            slug=(task or {}).get("slug"),
            revision_id=(task or {}).get("revision_id"),
            theme=theme,
            restyle=bool((task or {}).get("parent_revision_id")),
        ) if project is not None else nullcontext()
        with context:
            proc = subprocess.run(
                [
                    binary,
                    "convert",
                    str(source),
                    "--mode",
                    "api",
                    "--theme",
                    theme,
                    "--preview",
                    "--output",
                    str(path),
                    "--json",
                ],
                cwd=path.parent,
                env=os.environ.copy(),
                text=True,
                capture_output=True,
                timeout=120,
                check=False,
            )
            if proc.returncode != 0 or not path.is_file() or path.stat().st_size <= 0:
                path.unlink(missing_ok=True)
                raise VisualOutputError("md2wechat could not render this article")
            if wechat_layout is not None:
                try:
                    response = json.loads(proc.stdout)
                    data = response.get("data") if isinstance(response, dict) else None
                except (TypeError, json.JSONDecodeError) as exc:
                    raise VisualOutputError("md2wechat 未返回可核对的主题结果。") from exc
                if (
                    not isinstance(response, dict)
                    or response.get("success") is not True
                    or not isinstance(data, dict)
                    or data.get("mode") != "api"
                    or data.get("theme") != theme
                    or data.get("preview") is not True
                    or data.get("upload") is not False
                    or data.get("draft") is not False
                ):
                    raise VisualOutputError("md2wechat 返回的实际主题或操作范围与请求不一致。")
            raw_bytes = path.read_bytes()
            try:
                rendered = raw_bytes.decode("utf-8")
            except UnicodeDecodeError as exc:
                raise VisualOutputError("md2wechat 返回的 HTML 编码无效。") from exc
            if "<script" in rendered.lower() or str(REPO_ROOT) in rendered:
                path.unlink(missing_ok=True)
                raise VisualOutputError("md2wechat returned unsafe HTML")
            if wechat_layout is not None and wechat_layout.get("refinement") is not None:
                from wechat_layout_refinement import refine_wechat_html

                try:
                    refined = refine_wechat_html(rendered, title, body, wechat_layout, source_package_sha256)
                except ValueError as exc:
                    raise VisualOutputError(str(exc)) from exc
                raw_path = path.with_name(f"{path.stem}.md2wechat-original.html")
                raw_path.write_bytes(raw_bytes)
                path.write_text(refined, encoding="utf-8")
                refinement_metadata = {
                    "base_renderer": "md2wechat-cli",
                    "base_theme": theme,
                    "local_refinements": wechat_layout["refinement"],
                    "raw_html_sha256": hashlib.sha256(raw_bytes).hexdigest(),
                    "raw_html_path": _project_rel(project, raw_path) if project is not None else raw_path.name,
                    "output_is_raw_api_result": False,
                }
    return {
        "renderer_source": "md2wechat-cli",
        "renderer_theme": theme,
        **refinement_metadata,
    }


def _render_result(
    task: dict[str, Any],
    provider: dict[str, Any],
    renderer: str,
    fmt: str,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result = {
        "id": task["id"],
        "kind": task["kind"],
        "provider": provider["id"],
        "renderer": renderer,
        "source": task["source"],
        "output": task["output"],
        "format": fmt,
        "width": task.get("width"),
        "height": task.get("height"),
        "status": "generated",
    }
    if extra:
        result.update(extra)
    return result


def _task_output_metadata(task: dict[str, Any]) -> dict[str, Any]:
    metadata: dict[str, Any] = {}
    if task.get("role"):
        metadata["role"] = task["role"]
    if task.get("layout_recipe"):
        metadata["layout_recipe"] = task["layout_recipe"]
    if "evidence_sources" in task:
        metadata["evidence_sources"] = list(task.get("evidence_sources") or [])
    if task.get("requested_renderer"):
        metadata["requested_renderer"] = task["requested_renderer"]
    if task.get("evidence_ratio") is not None:
        metadata["evidence_ratio"] = task["evidence_ratio"]
    if task.get("evidence_detail_score") is not None:
        metadata["evidence_detail_score"] = task["evidence_detail_score"]
    if task.get("evidence_kind"):
        metadata["evidence_kind"] = task["evidence_kind"]
    if task.get("expected_text"):
        metadata["expected_text"] = task["expected_text"]
    if task.get("brand_profile"):
        metadata["brand_profile"] = task["brand_profile"]
    if task.get("ai_generated"):
        metadata.update({
            "ai_generated": True,
            "image_backend": task.get("image_backend") or "baoyu-image-gen",
            "ocr_status": task.get("ocr_status") or "review_required",
            "ocr_text": "",
        })
    for key in (
        "layout_style",
        "cover_strategy",
        "cover_direction",
        "requires_authorized_source",
        "share_format",
        "series_system",
        "card_structure",
        "narrative_stage",
        "insert_after",
        "caption",
        "semantic_brief",
        "inline_order",
        "inline_structure",
        "video_index",
        "upload_format",
        "upload_order",
        "source_type",
        "consistency_group",
        "art_direction_id",
        "text_overlay",
        "generation",
        "visual_mode",
        "provider_policy",
        "selected_direction",
    ):
        if key in task:
            metadata[key] = task[key]
    if task.get("recipe_path"):
        metadata["recipe_path"] = task["recipe_path"]
        metadata["revision_id"] = task.get("revision_id")
        metadata["parent_revision_id"] = task.get("parent_revision_id")
        metadata["visual_system"] = task.get("visual_system")
    return metadata


def _render_task(project: Path, task: dict[str, Any], provider: dict[str, Any], renderer: str) -> dict[str, Any]:
    if renderer != "fake":
        raise VisualOutputError(f"unsupported renderer: {renderer}")
    publish_root = _recipe_publish_root(project, str(task.get("slug") or ""), str(task.get("revision_id") or ""))
    output = _project_output(project, task["output"], "publish output", within=publish_root)
    if task["kind"] == "wechat_html":
        payload = task["payload"]
        _render_html(
            output,
            payload.get("title", ""),
            payload.get("body", ""),
            str(task.get("visual_system") or "swiss"),
            str(task.get("layout_style") or "") or None,
        )
        return _render_result(task, provider, "fake", "HTML", _task_output_metadata(task))
    _write_png(output, int(task["width"]), int(task["height"]))
    return _render_result(task, provider, "fake", "PNG", _task_output_metadata(task))


def _bind_output_integrity(project: Path, outputs: list[dict[str, Any]]) -> None:
    """Persist raw-byte integrity for every generated customer output."""
    for position, output in enumerate(outputs):
        relative = output.get("output")
        if not isinstance(relative, str) or not relative:
            raise VisualOutputError(f"generated output {position + 1} is missing its path")
        path = _project_input_file(project, relative, f"generated output {position + 1}")
        digest = hashlib.sha256()
        size = 0
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                size += len(chunk)
                digest.update(chunk)
        if size <= 0:
            raise VisualOutputError(f"generated output {position + 1} is empty")
        output["size"] = size
        output["sha256"] = digest.hexdigest()


def _write_platform_delivery_manifest(
    project: Path,
    slug: str,
    revision_id: str,
    package_rel: str,
    parsed: dict[str, Any],
    outputs: list[dict[str, Any]],
    recipe: dict[str, Any],
) -> str:
    """Write a publish-workbench-friendly map of real platform-ready assets."""
    publish_root = _recipe_publish_root(project, slug, revision_id)
    output_by_id = {
        str(output.get("id")): output
        for output in outputs
        if isinstance(output, dict) and isinstance(output.get("id"), str)
    }
    native_package = parsed.get("schema") == "echo-founder.platform-native-package.v2"
    wechat_article = output_by_id.get("wechat-html", {})
    recipe_platforms = recipe.get("platforms") if isinstance(recipe.get("platforms"), dict) else {}
    recipe_wechat = recipe_platforms.get("wechat") if isinstance(recipe_platforms.get("wechat"), dict) else {}
    cover_options = [
        option for option in (
            {
                "id": "primary",
                "label": "编辑排版首图",
                "direction": "editorial_typography",
                "wide": str(output_by_id.get("wechat-cover", {}).get("output") or ""),
                "square": str(output_by_id.get("wechat-share", {}).get("output") or ""),
                "strategy": str(output_by_id.get("wechat-cover", {}).get("cover_strategy") or ""),
            },
            {
                "id": "authorized-scene",
                "label": "授权实景首图",
                "direction": "authorized_real_scene",
                "wide": str(output_by_id.get("wechat-cover-alt-01", {}).get("output") or ""),
                "square": str(output_by_id.get("wechat-share-alt-01", {}).get("output") or ""),
                "strategy": str(output_by_id.get("wechat-cover-alt-01", {}).get("cover_strategy") or ""),
            },
            {
                "id": "conceptual",
                "label": "概念视觉首图",
                "direction": "conceptual_visual",
                "wide": str(output_by_id.get("wechat-cover-alt-02", {}).get("output") or ""),
                "square": str(output_by_id.get("wechat-share-alt-02", {}).get("output") or ""),
                "strategy": str(output_by_id.get("wechat-cover-alt-02", {}).get("cover_strategy") or ""),
            },
        )
        if option["wide"] or option["square"]
    ]
    wechat = {
        "article_html": str(wechat_article.get("output") or ""),
        "layout_style": str(wechat_article.get("layout_style") or ""),
        "renderer": str(wechat_article.get("renderer_source") or ""),
        "renderer_theme": str(wechat_article.get("renderer_theme") or ""),
        "fallback_reason": str(wechat_article.get("layout_fallback_reason") or ""),
        "layout_options_path": str(wechat_article.get("layout_options_path") or ""),
        "inline_assets": list(wechat_article.get("inline_assets") or []),
        "selection_scorecard": recipe_wechat.get("selection_scorecard") or {},
        "cover_options": cover_options,
    }
    xhs_posts = []
    moments_posts = []
    for post in parsed.get("xhs_posts", []) if isinstance(parsed.get("xhs_posts"), list) else []:
        if not isinstance(post, dict):
            continue
        post_number = int(post.get("index") or len(xhs_posts) + 1)
        page_count = len(post.get("pages") or []) or 5
        assets = [
            output_by_id.get(f"xhs-{post_number:02d}-p{page}", {})
            for page in range(1, page_count + 1)
        ]
        xhs_posts.append({
            "post_index": post_number,
            "title": str(post.get("title") or ""),
            "cover_text": str(post.get("cover_text") or ""),
            "share_copy": str(post.get("body") or ""),
            "pages": [
                {
                    "page_id": f"P{page}",
                    "path": str(asset.get("output") or ""),
                    "layout_recipe": str(asset.get("layout_recipe") or ""),
                    "card_structure": str(asset.get("card_structure") or ""),
                    "narrative_stage": asset.get("narrative_stage") or {},
                }
                for page, asset in enumerate(assets, start=1)
            ],
        })
        # The five portrait cards are the canonical files for both
        # Xiaohongshu and Moments.  Do not render or crop a second Moments
        # copy: the publishing layer binds the same verified files twice.
        moments_pages = [
            (page, output_by_id.get(f"xhs-{post_number:02d}-p{page}", {}))
            for page in range(1, page_count + 1)
        ]
        moments_posts.append({
            "post_index": post_number,
            "title": str(post.get("title") or ""),
            "upload_mode": "shared_carousel",
            "upload_format": "3:4",
            "image_order": [f"P{page}" for page, _asset in moments_pages],
            "pages": [
                {
                    "asset_id": f"xhs-{post_number:02d}-p{page}",
                    "page_id": f"P{page}",
                    "path": str(asset.get("output") or ""),
                    "width": asset.get("width"),
                    "height": asset.get("height"),
                    "layout_recipe": str(asset.get("layout_recipe") or ""),
                    "card_structure": str(asset.get("card_structure") or ""),
                    "narrative_stage": asset.get("narrative_stage") or {},
                }
                for page, asset in moments_pages
            ],
        })
    manifest_path = _project_output(
        project,
        f"pipeline/visual/{slug}/publish/{revision_id}/platform-delivery.json",
        "platform visual delivery manifest",
        within=publish_root,
    )
    delivery: dict[str, Any] = {
        "schema": "echo-founder.platform-visual-delivery.v2" if native_package else "aifios.platform-visual-delivery.v1",
        "slug": slug,
        "revision_id": revision_id,
        "source_package": package_rel,
        "brand_profile": str(recipe.get("brand_profile") or "adaptive"),
        "golden_sample_standard": recipe.get("golden_sample_standard") or {},
    }
    if isinstance(parsed.get("wechat"), dict):
        delivery["wechat"] = wechat
    if xhs_posts:
        delivery["xiaohongshu"] = {"posts": xhs_posts}
    if not native_package:
        delivery["moments"] = {"posts": moments_posts}
        delivery["video"] = {"items": [], "visuals_required": False}
    manifest_path.write_text(
        json.dumps(
            delivery,
            ensure_ascii=False,
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    return _project_rel(project, manifest_path)


def _write_index(
    project: Path,
    slug: str,
    source_package: str,
    outputs: list[dict[str, Any]],
    status: str,
    errors: list[str] | None = None,
    quality: dict[str, Any] | None = None,
    metadata: dict[str, Any] | None = None,
    publish_current_index: bool = True,
) -> Path:
    _validate_visual_slug(slug)
    visual_root = project / "pipeline" / "visual" / slug
    index_rel = f"pipeline/visual/{slug}/publish/index.json"
    index_path = _project_output(project, index_rel, "visual publish index", within=visual_root)
    payload = {
        "schema": "aifios.visual-publish.v1",
        "slug": slug,
        "source_package": source_package,
        "status": status,
        "created_at": datetime.now().isoformat(timespec="seconds"),
        "outputs": outputs,
        "errors": errors or [],
    }
    if quality:
        payload.update(quality)
    if metadata:
        payload.update(metadata)
    revision_id = str(payload.get("revision_id") or "").strip()
    revision_index_path: Path | None = None
    if revision_id:
        if not _REVISION_ID_RE.fullmatch(revision_id):
            raise VisualOutputError("visual index revision_id must match ^r[0-9]{3,}$")
        revision_index_rel = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
        revision_index_path = _project_output(
            project,
            revision_index_rel,
            "visual revision index",
            within=visual_root,
        )
        revision_index_path.parent.mkdir(parents=True, exist_ok=True)
        payload["revision_index_path"] = _project_rel(project, revision_index_path)
    elif not publish_current_index:
        raise VisualOutputError("revision-only publish requires a recipe revision_id")
    serialized = json.dumps(payload, ensure_ascii=False, indent=2)
    if revision_index_path is not None:
        revision_index_path.write_text(serialized, encoding="utf-8")
    if publish_current_index:
        index_path.parent.mkdir(parents=True, exist_ok=True)
        index_path.write_text(serialized, encoding="utf-8")
        return index_path
    if revision_index_path is not None:
        return revision_index_path
    raise VisualOutputError("revision-only publish could not determine a revision index path")


def build_visual_record_body(slug: str, title: str, package_rel: str, index_rel: str, outputs: list[dict[str, Any]]) -> str:
    rows = "\n".join(
        f"| {item['kind']} | {item['output']} | {item['status']} |"
        for item in outputs
    )
    return (
        f"# 视觉发布产物 · {title}\n\n"
        "## 0. 来源\n"
        f"- Package：{package_rel}\n"
        f"- Slug：{slug}\n\n"
        "## 1. 已生成文件\n"
        "| 类型 | 文件 | 状态 |\n"
        "|---|---|---|\n"
        f"{rows}\n\n"
        "## 2. 生成索引\n"
        f"- index.json：{index_rel}\n"
    )


def _ratio_ok(width: int, height: int, target_w: int, target_h: int) -> bool:
    return abs((width / height) - (target_w / target_h)) < 0.02


def check_visual_outputs(project: Path | str, index: dict[str, Any]) -> dict[str, Any]:
    project_path = Path(project).expanduser().resolve(strict=False)
    errors: list[str] = []
    slug = index.get("slug")
    if not isinstance(slug, str) or not _SAFE_SLUG_RE.fullmatch(slug):
        return {"status": "failed", "errors": ["visual index has an unsafe slug"]}
    revision_id = index.get("revision_id")
    if revision_id is not None and (not isinstance(revision_id, str) or not _REVISION_ID_RE.fullmatch(revision_id)):
        return {"status": "failed", "errors": ["visual index has an invalid revision_id"]}
    output_root = project_path / "pipeline" / "visual" / slug / "publish"
    if isinstance(revision_id, str):
        output_root = output_root / revision_id
    for item in index.get("outputs", []):
        if not isinstance(item, dict):
            errors.append("visual index output must be an object")
            continue
        try:
            output = _project_output(project_path, item.get("output"), "visual output", within=output_root)
        except VisualOutputError as exc:
            errors.append(str(exc))
            continue
        if not output.exists():
            errors.append(f"missing output: {item['output']}")
            continue
        if output.stat().st_size <= 0:
            errors.append(f"empty output: {item['output']}")
            continue
        if item.get("format") == "HTML":
            text = output.read_text(encoding="utf-8", errors="ignore")
            if "<script" in text.lower():
                errors.append(f"html contains script: {item['output']}")
            if str(project_path) in text:
                errors.append(f"html leaks local project path: {item['output']}")
            continue
        if item.get("format") == "PNG":
            try:
                width, height = _png_size(output)
            except VisualOutputError as exc:
                errors.append(str(exc))
                continue
            expected_w = int(item.get("width") or 0)
            expected_h = int(item.get("height") or 0)
            if expected_w and expected_h and not _ratio_ok(width, height, expected_w, expected_h):
                errors.append(f"wrong ratio: {item['output']} got {width}x{height}, expected {expected_w}:{expected_h}")
    errors.extend(check_wechat_outputs(project_path, index)["errors"])
    return {"status": "failed" if errors else "pass", "errors": errors}


def check_wechat_outputs(project: Path, index: dict[str, Any]) -> dict[str, Any]:
    """Recheck article files and their proof; do not trust a cached quality pass."""
    errors: list[str] = []
    checked = 0
    for item in index.get("outputs", []):
        if not isinstance(item, dict) or not (item.get("kind") == "wechat_html" or item.get("id") == "wechat-html"):
            continue
        if item.get("renderer") == "fake":
            continue
        checked += 1
        try:
            if item.get("format") != "HTML" or item.get("renderer") != "local":
                raise VisualOutputError("公众号输出必须是本地生成的 HTML。")
            proof = _check_wechat_output(project, index, item)
            errors.extend(proof["errors"])
            if item.get("wechat_fidelity") != proof or item.get("sha256") != proof["output_sha256"]:
                errors.append("公众号排版保真记录缺失或与当前原稿、HTML 不一致，请重新排版。")
        except (OSError, ValueError, VisualPublishError) as exc:
            errors.append(f"公众号排版保真检查失败：{exc}")
    return {"status": "failed" if errors else "pass", "errors": errors, "checked_outputs": checked}


def _check_wechat_output(project: Path, index: dict[str, Any], output: dict[str, Any]) -> dict[str, Any]:
    from wechat_fidelity import check_wechat_html

    package = _project_source(project, index.get("source_package"), "source package")
    source = package.read_bytes()
    body = source.decode("utf-8")
    if body.startswith("---"):
        body = body.split("---", 2)[-1].strip()
    parsed = parse_package_body(body)
    article = parsed.get("wechat")
    if not isinstance(article, dict) or not article.get("body"):
        raise VisualOutputError("原稿没有可核对的公众号正文。")
    rendered = _project_source(project, output.get("output"), "wechat HTML").read_bytes()
    captions = {}
    # Legacy recipes may insert declared figures. Verify their captions separately;
    # never exempt arbitrary HTML text from the article comparison.
    if output.get("inline_assets"):
        recipe_path = _project_source(project, index.get("recipe_path"), "visual recipe")
        recipe = json.loads(recipe_path.read_text(encoding="utf-8"))
        assets = {asset.get("id"): asset for asset in recipe.get("assets", []) if isinstance(asset, dict)}
        for figure in output["inline_assets"]:
            asset = assets.get(figure.get("id"), {})
            caption = asset.get("caption")
            if not caption or figure.get("caption") != caption:
                raise VisualOutputError("正文配图说明未绑定排版配方。")
            captions[str(figure["id"])] = str(caption)
    proof = check_wechat_html(str(article.get("title") or parsed["title"]), str(article["body"]), rendered.decode("utf-8"), figure_captions=captions)
    return {
        **proof,
        "source_package_sha256": hashlib.sha256(source).hexdigest(),
        "output_sha256": hashlib.sha256(rendered).hexdigest(),
    }


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _short_title(title: str, limit: int = 10) -> str:
    text = re.sub(r"[，。！？、：:；;,.!?]", " ", _clean_text(title))
    chunks = [chunk for chunk in text.split() if chunk]
    compact = chunks[0] if chunks else text
    return compact[:limit] or "核心观点"


def _split_fragments(text: str, limit: int = 4) -> list[str]:
    parts = [
        item.strip(" -•\t")
        for item in re.split(r"[。！？；;\n]", _clean_text(text))
        if item.strip(" -•\t")
    ]
    if not parts:
        return ["核心判断", "关键信息", "补充说明"]
    return [part[:28] for part in parts[:limit]]


def _semantic_page_fragments(page: dict[str, Any], body: str, limit: int = 5) -> list[str]:
    """Return only publishable copy for visible card elements.

    Recipe prompts and layout notes guide production, but are internal metadata
    and must never become reader-facing card text.
    """
    return _split_fragments(body, limit=limit)


def _public_page_label(page_id: str) -> str:
    """Format a reader-facing page number without exposing task metadata."""
    match = re.search(r"(\d+)", page_id or "")
    return f"{int(match.group(1)):02d}" if match else "要点"


_TITLE_BREAK_MARKERS = (
    "，",
    "、",
    "：",
    "；",
    "？",
    "！",
    "——",
    "的是",
    "不是",
    "而是",
    "就是",
    "才是",
)
_TITLE_FORBIDDEN_LINE_START = frozenset("，。！？；：、）》】」』”’…")
_TITLE_FORBIDDEN_LINE_END = frozenset("（《【「『“‘")


def _line_break_title(text: str, max_chars: int = 8) -> str:
    """Insert one semantic CJK line break without truncating the headline."""
    clean = _clean_text(text)
    if len(clean) <= max_chars:
        return html.escape(clean)

    ideal = len(clean) / 2
    candidates: set[int] = set()
    for marker in _TITLE_BREAK_MARKERS:
        start = 0
        while True:
            index = clean.find(marker, start)
            if index < 0:
                break
            candidates.add(index + len(marker))
            start = index + 1

    # Spaces are uncommon in Chinese titles, but when present they are the
    # safest semantic boundary and should be considered before a hard split.
    candidates.update(index for index, char in enumerate(clean, start=1) if char.isspace())
    candidates.update(range(2, len(clean) - 1))

    def score(boundary: int) -> tuple[float, float, int]:
        left = clean[:boundary].rstrip()
        right = clean[boundary:].lstrip()
        invalid = (
            not left
            or not right
            or left[-1] in _TITLE_FORBIDDEN_LINE_END
            or right[0] in _TITLE_FORBIDDEN_LINE_START
        )
        overflow = max(0, len(left) - max_chars) + max(0, len(right) - max_chars)
        semantic_bonus = -2.5 if any(left.endswith(marker) for marker in _TITLE_BREAK_MARKERS) else 0
        return (1000 if invalid else 0) + abs(boundary - ideal) + overflow * 1.5 + semantic_bonus, abs(boundary - ideal), boundary

    boundary = min(candidates, key=score)
    first = clean[:boundary].rstrip()
    second = clean[boundary:].lstrip()
    return f"{html.escape(first)}<br>{html.escape(second)}"


def _wide_cover_title_style(title: str, template_style: str) -> str:
    """Keep 21:9 cover headlines single-line without clipping their copy."""
    clean = _clean_text(title)
    if not clean:
        return ""

    # Full-width CJK glyphs consume roughly one em. ASCII words need less
    # room, so treating them separately avoids shrinking mixed-language titles
    # more than the actual 21:9 layout requires.
    units = sum(
        0.32 if char.isspace() else 1.0 if ord(char) >= 0x2E80 else 0.62 if char.isalnum() else 0.5
        for char in clean
    )
    tracking = max(0, len(clean) - 1) * 0.04
    default_size = 124 if template_style == "editorial" else 156
    # The wide cover title row has 1,876px after its fixed padding. Leave a
    # small guard band so font fallback cannot turn a publishable headline into
    # a clipped or wrapped one.
    fitted_size = max(64, int(1840 / max(1.0, units + tracking)))
    return f' style="font-size:{min(default_size, fitted_size)}px"'


def _matrix_cells(items: list[str]) -> str:
    cells = []
    for idx, item in enumerate(items[:6], start=1):
        cls = "matrix-cell is-accent" if idx == 1 else "matrix-cell"
        cells.append(
            f'<div class="{cls}"><p class="cell-nb">{idx:02d}</p>'
            f'<p class="cell-title">{html.escape(item[:14])}</p></div>'
        )
    return "\n".join(cells)


def _evidence_image(task: dict[str, Any], title: str) -> str:
    source = str(task.get("evidence_url") or "")
    if not source:
        return ""
    return (
        '<div class="device-browser recipe-evidence" data-evidence="true">'
        f'<figure class="frame-shot r-16x10 bg-paper inset-sub corners-sq shadow-soft">'
        f'<img src="{html.escape(source, quote=True)}" alt="{html.escape(title)}">'
        "</figure></div>"
    )


def _ai_visual_image(task: dict[str, Any], title: str) -> str:
    source = str(task.get("ai_background_url") or "")
    if not source:
        return ""
    return (
        '<figure class="ai-concept-visual" data-ai-concept="true">'
        f'<img src="{html.escape(source, quote=True)}" alt="{html.escape(title)} 的概念视觉">'
        '<figcaption>概念视觉 · 非事实证据</figcaption></figure>'
    )


def _evidence_data_panel(task: dict[str, Any]) -> str:
    items = task.get("evidence_items") if isinstance(task.get("evidence_items"), list) else []
    if not items:
        return ""
    rows = []
    for index, item in enumerate(items[:5], start=1):
        if not isinstance(item, (list, tuple)) or len(item) < 2:
            continue
        label, value = _clean_text(item[0]), _clean_text(item[1])
        rows.append(
            '<div class="evidence-row">'
            f'<p class="evidence-key">{html.escape(label)}</p>'
            f'<p class="evidence-value">{html.escape(value)}</p>'
            "</div>"
        )
    if not rows:
        return ""
    return '<div class="recipe-evidence evidence-data" data-evidence="true">' + "".join(rows) + "</div>"


def _evidence_document_panel(task: dict[str, Any]) -> str:
    if task.get("evidence_kind") != "document":
        return ""
    items = task.get("evidence_items") if isinstance(task.get("evidence_items"), list) else []
    excerpts = [
        _clean_text(item[1])
        for item in items[:4]
        if isinstance(item, (list, tuple)) and len(item) >= 2 and _clean_text(item[1])
    ]
    if not excerpts:
        return ""
    primary = excerpts[0]
    supporting = "".join(
        f'<p><span>{index:02d}</span>{html.escape(excerpt)}</p>'
        for index, excerpt in enumerate(excerpts[1:], start=1)
    )
    return (
        '<div class="recipe-evidence evidence-document" data-evidence="true">'
        '<div class="document-meta"><span>资料摘录</span><span>已核对资料</span></div>'
        f'<blockquote>{html.escape(primary)}</blockquote>'
        f'<div class="document-lines">{supporting}</div>'
        '</div>'
    )


def _stacked_ledger(items: list[str]) -> str:
    rows = []
    for index, item in enumerate(items[:4], start=1):
        rows.append(
            '<div class="ledger-row">'
            f'<p class="ledger-num">0{index}</p>'
            f'<p class="ledger-lbl">{html.escape(item[:24])}<span class="sub">补充说明</span></p>'
            "</div>"
        )
    return f'<div class="stacked-ledger">{"".join(rows)}</div>'


def _bar_chart(items: list[str]) -> str:
    rows = []
    for index, item in enumerate(items[:3], start=1):
        number_match = re.search(r"-?\d+(?:\.\d+)?%?", item)
        if number_match:
            raw_number = number_match.group(0)
            numeric = abs(float(raw_number.rstrip("%")))
            width = max(18, min(100, numeric if "%" in raw_number or numeric <= 100 else 100))
            value = raw_number
        else:
            width = 100
            value = f"0{index}"
        rows.append(
            '<div class="bar-row">'
            f'<p class="row-lbl">{html.escape(item[:12])}</p>'
            f'<div class="row-track"><span class="row-fill" style="width:{width}%"></span></div>'
            f'<p class="row-val">{html.escape(value)}</p>'
            "</div>"
        )
    return f'<div class="h-bar-chart">{"".join(rows)}</div>'


def _cover_signal_panel(items: list[str]) -> str:
    rows = "".join(
        '<div class="cover-signal-row">'
        f'<span>{index:02d}</span><p>{html.escape(item[:24])}</p>'
        '</div>'
        for index, item in enumerate(items[:4], start=1)
    )
    return f'<div class="cover-signal-panel">{rows}</div>'


def _editorial_callout_panel(items: list[str]) -> str:
    primary = html.escape((items[0] if items else "保留原文判断")[:36])
    notes = "".join(
        f'<div class="editorial-note"><span>{index:02d}</span><p>{html.escape(item[:28])}</p></div>'
        for index, item in enumerate(items[1:4], start=1)
    )
    return (
        '<div class="editorial-callout-panel">'
        f'<div class="callout">{primary}</div>'
        f'<div class="editorial-notes">{notes}</div></div>'
    )


def _comparison_panel(items: list[str]) -> str:
    left = html.escape((items[0] if items else "旧做法")[:34])
    right = html.escape((items[1] if len(items) > 1 else items[0] if items else "新判断")[:34])
    return (
        '<div class="comparison-panel"><div class="comparison-side is-before">'
        '<span>旧做法</span>'
        f'<p>{left}</p></div><div class="comparison-arrow">→</div>'
        '<div class="comparison-side is-after"><span>新的判断</span>'
        f'<p>{right}</p></div></div>'
    )


def _step_path_panel(items: list[str]) -> str:
    steps = []
    for index, item in enumerate((items or ["确认对象", "识别卡点", "给出下一步"])[:3], start=1):
        steps.append(
            '<div class="step-path-item">'
            f'<span>{index:02d}</span><p>{html.escape(item[:34])}</p></div>'
        )
    return '<div class="step-path-panel">' + "".join(steps) + "</div>"


def _story_path_panel(items: list[str]) -> str:
    steps = []
    labels = ("现场", "冲突", "变化")
    for index, label in enumerate(labels):
        item = items[index] if index < len(items) else "保留真实场景中的关键变化"
        steps.append(
            '<div class="story-path-item">'
            f'<span>{label}</span><p>{html.escape(item[:34])}</p></div>'
        )
    return '<div class="story-path-panel">' + "".join(steps) + "</div>"


def _share_structure_block(task: dict[str, Any], fragments: list[str], evidence: str) -> str:
    if evidence:
        return evidence
    ai_visual = _ai_visual_image(task, _clean_text(((task.get("payload") or {}).get("page") or {}).get("title") or "概念视觉"))
    if ai_visual:
        return ai_visual
    structure = str(task.get("card_structure") or "")
    if structure in {"old-new-comparison", "reframe"}:
        return _comparison_panel(fragments)
    if structure in {"step-one", "step-two", "step-three", "self-check-cta"}:
        return _step_path_panel(fragments)
    if structure in {"scene-hook", "conflict", "turning-point", "action-boundary", "reflection-cta"}:
        return _story_path_panel(fragments)
    layout = str(task.get("layout_recipe") or "S12")
    if layout in {"S06", "S09"}:
        return _stacked_ledger(fragments)
    if layout == "S10":
        return _bar_chart(fragments)
    if layout == "S01":
        return _cover_signal_panel(fragments)
    return '<div class="matrix-fill">' + _matrix_cells(fragments) + "</div>"


def _cover_visual_block(task: dict[str, Any], title: str, summary: str) -> str:
    strategy = str(task.get("cover_strategy") or "typographic_judgment")
    evidence = _evidence_image(task, title) or _evidence_document_panel(task) or _evidence_data_panel(task)
    fragments = _split_fragments(summary or title, limit=3)
    if evidence and strategy in {"evidence_led", "data_led"}:
        return evidence
    ai_visual = _ai_visual_image(task, title)
    if ai_visual:
        return ai_visual
    if strategy == "editorial_quote":
        return f'<blockquote class="cover-quote">{html.escape((fragments[0] if fragments else title)[:54])}</blockquote>'
    if strategy == "structured_metaphor":
        return _step_path_panel(fragments)
    return _comparison_panel(fragments)


def _inline_poster(task: dict[str, Any]) -> str:
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    title = _clean_text(payload.get("section_heading") or payload.get("title") or "正文图解")
    fragments = _split_fragments(payload.get("display_copy") or title, limit=4)
    structure = str(task.get("inline_structure") or task.get("layout_recipe") or "inline-insight")
    if structure == "inline-contrast":
        block = _comparison_panel(fragments)
    elif structure == "inline-steps":
        block = _step_path_panel(fragments)
    elif structure == "inline-story":
        block = _story_path_panel(fragments)
    else:
        block = '<div class="matrix-fill">' + _matrix_cells(fragments) + "</div>"
    return f'''
    <section class="poster inline" id="{task["id"]}">
      <div class="content stack gap-7">
        <div class="chrome-min"><span>正文图解</span><span>观点</span></div>
        <p class="t-cat">{html.escape(_clean_text(payload.get("label") or "关键判断")[:26])}</p>
        <h2 class="h-xl">{_line_break_title(title, 14)}</h2>
        <div class="visual-stage inline-stage">{block}</div>
      </div>
    </section>'''


def _video_poster(task: dict[str, Any]) -> str:
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    video = payload.get("video") if isinstance(payload.get("video"), dict) else {}
    title = _clean_text(video.get("cover_text") or video.get("title") or "核心判断")
    hook = _clean_text(video.get("hook") or "先把对象、反差和代价说清楚")
    duration = _clean_text(video.get("duration") or "短视频")
    title_html = _line_break_title(title, 6)
    if task.get("template_style") == "editorial":
        return f'''
    <section class="poster video" id="{task["id"]}">
      <canvas class="mag-bg" data-bg="ink-flow"></canvas><div class="grain"></div>
      <div class="content video-stage editorial-video-stage">
        <div class="issue-row"><span>短视频封面</span><span class="dot"></span><span>{html.escape(duration)}</span></div>
        <div class="video-copy"><p class="kicker">3 秒钩子</p><h1 class="h-display">{title_html}</h1><p class="lead">{html.escape(hook[:66])}</p></div>
        <div class="video-footer"><span>视频号 · 抖音 · 小红书</span><span>01</span></div>
      </div>
    </section>'''
    return f'''
    <section class="poster video" id="{task["id"]}">
      <div class="content video-stage swiss-video-stage">
        <div class="chrome-min"><span>短视频封面</span><span>{html.escape(duration)}</span></div>
        <p class="t-cat">3 秒钩子</p><h1 class="h-statement">{title_html}</h1>
        <div class="video-hook"><p>{html.escape(hook[:66])}</p></div>
        <div class="video-footer"><span>视频号 · 抖音 · 小红书</span><span>观看重点</span></div>
      </div>
    </section>'''


def _editorial_poster(task: dict[str, Any], title: str, body: str, page_id: str) -> str:
    page = (task.get("payload") or {}).get("page") or {}
    fragments = _semantic_page_fragments(page, body, limit=4)
    evidence = _evidence_image(task, title) or _evidence_document_panel(task) or _evidence_data_panel(task)
    layout = str(task.get("layout_recipe") or "M01")
    page_label = _public_page_label(page_id)
    narrative_label = _clean_text((task.get("narrative_stage") or {}).get("label") or "要点")
    if evidence:
        content_block = evidence
    elif str(task.get("card_structure") or "") in {"conflict", "turning-point"}:
        content_block = _comparison_panel(fragments)
    elif str(task.get("card_structure") or "") in {"scene-hook", "action-boundary", "reflection-cta"}:
        content_block = _story_path_panel(fragments)
    elif layout in {"M05", "M08", "M11", "M12"}:
        content_block = (
            '<div class="ledger">'
            + "".join(
                '<div class="ledger-row">'
                f'<span class="ledger-nb">0{index}</span>'
                f'<p class="ledger-title">{html.escape(fragment[:18])}</p>'
                f'<p class="ledger-note">{html.escape(fragment[18:32] or "来源可追溯")}</p>'
                "</div>"
                for index, fragment in enumerate(fragments, start=1)
            )
            + "</div>"
        )
    else:
        content_block = _editorial_callout_panel(fragments)
    return f'''
    <section class="poster xhs" id="{task["id"]}">
      <canvas class="mag-bg" data-bg="ink-flow"></canvas><div class="grain"></div>
      <div class="content recipe-stage editorial-recipe-stage">
        <div class="issue-row"><span>观点记录</span><span class="dot"></span><span>{html.escape(page_label)}</span></div>
        <div class="stack gap-2"><p class="kicker">{html.escape(narrative_label)}</p><h1 class="h-display">{_line_break_title(title, 9)}</h1><p class="h-sub">{html.escape(body[:54])}</p></div>
        <div class="visual-stage editorial-stage layout-{html.escape(layout, quote=True)}">{content_block}</div>
      </div>
    </section>'''


def _moments_poster(task: dict[str, Any]) -> str:
    """Render an upload-ready 1:1 Moments card from one share-page argument."""
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    post = payload.get("post") if isinstance(payload.get("post"), dict) else {}
    page = payload.get("page") if isinstance(payload.get("page"), dict) else {}
    page_id = _clean_text(page.get("page_id") or "")
    page_label = _public_page_label(page_id)
    title = _clean_text(page.get("title") or post.get("cover_text") or post.get("title") or "核心判断")
    body = _clean_text(page.get("body") or post.get("body") or "")
    fragments = _semantic_page_fragments(page, body, limit=3)
    layout = str(task.get("layout_recipe") or "S12")
    narrative_label = _clean_text((task.get("narrative_stage") or {}).get("label") or "一个判断")
    evidence = _evidence_image(task, title) or _evidence_document_panel(task) or _evidence_data_panel(task)
    content_block = _share_structure_block(task, fragments, evidence)
    title_html = _line_break_title(title, 7)
    lead = html.escape((body or "一张图说清一个可以被转发的判断。")[:50])
    if task.get("template_style") == "editorial":
        return f'''
    <section class="poster square moments" id="{task["id"]}">
      <canvas class="mag-bg" data-bg="ink-flow"></canvas><div class="grain"></div>
      <div class="content moments-stage editorial-moments-stage">
        <div class="issue-row"><span>朋友圈观点</span><span class="dot"></span><span>{html.escape(page_label)}</span></div>
        <div class="stack gap-2"><p class="kicker">{html.escape(narrative_label)}</p><h1 class="h-display">{title_html}</h1><p class="lead">{lead}</p></div>
        <div class="visual-stage editorial-stage layout-{html.escape(layout, quote=True)}">{content_block}</div>
        <p class="moments-footer">P{html.escape(page_label)} · 1:1 分享图</p>
      </div>
    </section>'''
    return f'''
    <section class="poster square moments" id="{task["id"]}">
      <div class="content moments-stage swiss-moments-stage">
        <div class="chrome-min"><span>朋友圈观点</span><span>{html.escape(page_label)}</span></div>
        <p class="t-cat">{html.escape(narrative_label)}</p>
        <h2 class="h-statement">{title_html}</h2>
        <p class="lead">{lead}</p>
        <div class="visual-stage layout-{html.escape(layout, quote=True)}">{content_block}</div>
        <div class="moments-footer"><span>可直接上传</span><span>1:1</span></div>
      </div>
    </section>'''


def _native_card_copy(task: dict[str, Any]) -> list[str]:
    """Ordered, complete public fields; never prompts, counts or guessed facts."""
    payload = task.get("payload") or {}
    post, page = payload.get("post") or {}, payload.get("page") or {}
    fields = []
    if page.get("page_id") == "P1":
        fields.extend(post.get("cover_lines") or [])
    fields.extend([page.get("title"), page.get("body")])
    return [_clean_text(value) for value in fields if _clean_text(value)]


def _native_card_poster(task: dict[str, Any]) -> str:
    fields = _native_card_copy(task)
    if not fields:
        raise VisualOutputError("小红书卡片缺少已确认的文字，请返回正文补齐。")
    payload = task["payload"]
    page = payload["page"]
    cover_count = len(payload["post"].get("cover_lines") or []) if page["page_id"] == "P1" else 0
    copy = []
    for index, value in enumerate(fields):
        tag = "h1" if index == 0 else "p"
        role = "title" if index == 0 else "body"
        if cover_count and 0 < index < cover_count:
            role = "subtitle" if index == 1 else "note"
        elif cover_count and index == cover_count:
            role = "subtitle"
        copy.append(f'<{tag} class="native-{role}" data-approved-copy="{index}">{html.escape(value)}</{tag}>')
    evidence = _evidence_image(task, fields[0]) or _evidence_document_panel(task) or _evidence_data_panel(task)
    variant = "cover" if cover_count else ("closing" if page["page_id"] == "P8" else "body")
    character_count = sum(len(value) for value in fields)
    length = "short" if character_count <= 70 else "medium" if character_count <= 200 else "long"
    return f'''
    <section class="poster xhs native-card native-{variant} native-{length} {'native-with-evidence' if evidence else ''} native-{html.escape(str(task.get('template_style') or 'swiss'), quote=True)}" data-native-layout="editorial-v1" id="{task['id']}">
      <div class="content native-stage">
        <div class="native-page-number" data-density="ignore">{html.escape(_public_page_label(page['page_id']))} / 08</div>
        <div class="native-copy">{''.join(copy)}</div>
        {f'<div class="native-evidence">{evidence}</div>' if evidence else ''}
      </div>
    </section>'''


def _poster_for_task(task: dict[str, Any]) -> str:
    if task.get("native_copy"):
        return _native_card_poster(task)
    payload = task.get("payload", {})
    if task["kind"] == "wechat_cover":
        title = _clean_text(payload.get("cover_text") or payload.get("title"))
        summary = _clean_text(payload.get("summary") or payload.get("comment_hook"))
        board = "wide" if int(task["width"]) > int(task["height"]) else "square"
        # A square editorial cover has roughly 880px of live width at the
        # rendered display size. Six CJK glyphs fit on one line; eight can
        # re-wrap into a third line after the explicit break.
        title_html = html.escape(title) if board == "wide" else _line_break_title(title, 6)
        wide_title_style = _wide_cover_title_style(title, str(task.get("template_style") or "")) if board == "wide" else ""
        body = html.escape((summary or "一张图说明这篇内容的判断。")[:80])
        visual_block = _cover_visual_block(task, title, summary)
        if task.get("template_style") == "editorial":
            return f'''
    <section class="poster {board}" id="{task["id"]}">
      <canvas class="mag-bg" data-bg="ink-flow"></canvas><div class="grain"></div>
      <div class="content cover-recipe-stage editorial-cover-stage">
        <div class="stack gap-4"><p class="kicker">公众号文章</p><h1 class="h-display wide-cover-title"{wide_title_style}>{title_html}</h1><p class="lead">{body}</p></div>
        {visual_block}
      </div>
    </section>'''
        return f'''
    <section class="poster {board}" id="{task["id"]}">
      <div class="content cover-recipe-stage swiss-cover-stage">
        <div class="chrome-min"><span>公众号文章</span><span>观点</span></div>
        <div class="stack gap-7">
          <p class="t-cat">封面</p>
          <h1 class="h-statement wide-cover-title"{wide_title_style}>{title_html}</h1>
        </div>
        <p class="lead">{body}</p>
        {visual_block}
      </div>
    </section>'''
    if task["kind"] == "video_cover":
        return _video_poster(task)
    if task["kind"] == "moments_card":
        return _moments_poster(task)
    if task["kind"] == "xhs_card":
        post = payload.get("post", {})
        page = payload.get("page", {})
        page_id = _clean_text(page.get("page_id"))
        page_label = _public_page_label(page_id)
        title = _clean_text(page.get("title") or post.get("cover_text") or post.get("title"))
        body = _clean_text(page.get("body") or post.get("body"))
        fragments = _semantic_page_fragments(page, body, limit=5)
        narrative_label = _clean_text((task.get("narrative_stage") or {}).get("label") or "要点")
        is_cover = page_id == "P1"
        if task.get("template_style") == "editorial":
            return _editorial_poster(task, title, body, page_id)
        heading = "h-statement" if is_cover else "h-xl"
        title_html = _line_break_title(title, 8)
        lead = html.escape((body or "把这个观点拆成一张能被转发的卡。")[:72])
        layout = str(task.get("layout_recipe") or "S12")
        evidence = _evidence_image(task, title) or _evidence_document_panel(task) or _evidence_data_panel(task)
        content_block = _share_structure_block(task, fragments, evidence)
        return f'''
    <section class="poster xhs" id="{task["id"]}">
      <div class="content recipe-stage swiss-recipe-stage">
        <div class="chrome-min"><span>观点卡</span><span>{html.escape(page_label)}</span></div>
        <p class="t-cat">{html.escape(narrative_label)}</p>
        <h2 class="{heading}">{title_html}</h2>
        <p class="lead">{lead}</p>
        <div class="visual-stage layout-{html.escape(layout, quote=True)}">{content_block}</div>
        <div class="hero-stat-bottom">
          <div><p class="t-cat">结论</p><p class="lead">{html.escape(fragments[0][:26])}</p></div>
          <p class="num-mega">{len(fragments)}</p>
        </div>
      </div>
    </section>'''
    return _inline_poster(task)


_BRAND_CSS_COLOR_TOKENS = {
    "paper": "--paper",
    "paper_2": "--paper-2",
    "ink": "--ink",
    "muted": "--muted",
    "line": "--line",
    "grey_1": "--grey-1",
    "grey_2": "--grey-2",
    "grey_3": "--grey-3",
    "accent": "--accent",
    "accent_soft": "--accent-soft",
    "accent_on": "--accent-on",
}
_BRAND_FONT_STACKS = {
    "Noto Sans SC": '"Noto Sans SC", -apple-system, "PingFang SC", "Microsoft YaHei UI", sans-serif',
    "Noto Serif SC": '"Noto Serif SC", "Songti SC", "STSong", serif',
    "IBM Plex Mono": '"IBM Plex Mono", ui-monospace, "SF Mono", Consolas, monospace',
}


def _hex_rgb(value: str) -> str:
    clean = value.lstrip("#")
    return ",".join(str(int(clean[index:index + 2], 16)) for index in (0, 2, 4))


def _brand_render_contract(tasks: list[dict[str, Any]]) -> tuple[str, str]:
    """Return a safe CSS-token override and the applied profile name."""
    brand_system = next(
        (task.get("brand_system") for task in tasks if isinstance(task.get("brand_system"), dict)),
        {},
    )
    profile = _clean_text(brand_system.get("name") or "")
    tokens = brand_system.get("tokens") if isinstance(brand_system.get("tokens"), dict) else {}
    colors = tokens.get("colors") if isinstance(tokens.get("colors"), dict) else {}
    typography = tokens.get("typography") if isinstance(tokens.get("typography"), dict) else {}
    declarations: list[str] = []
    for key, css_variable in _BRAND_CSS_COLOR_TOKENS.items():
        value = str(colors.get(key) or "")
        if re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
            declarations.append(f"{css_variable}:{value};")
    for key, css_variable in (("sans_zh", "--sans-zh"), ("serif_zh", "--serif-zh"), ("mono", "--mono")):
        stack = _BRAND_FONT_STACKS.get(str(typography.get(key) or ""))
        if stack:
            declarations.append(f"{css_variable}:{stack};")
    for key, css_variable in (("ink", "--ink-rgb"), ("paper", "--paper-rgb"), ("accent", "--accent-rgb")):
        value = str(colors.get(key) or "")
        if re.fullmatch(r"#[0-9A-Fa-f]{6}", value):
            declarations.append(f"{css_variable}:{_hex_rgb(value)};")
    if not profile or not declarations:
        return "", ""
    safe_profile = re.sub(r"[^a-z0-9-]+", "-", profile.lower()).strip("-")
    selector = f'html[data-brand-profile="{safe_profile}"]'
    return f"{selector} {{{''.join(declarations)}}}", safe_profile


def _build_local_deck_html(tasks: list[dict[str, Any]], template_path: Path = XHS_TEMPLATE_PATH) -> str:
    template = template_path.read_text(encoding="utf-8")
    brand_css, brand_profile = _brand_render_contract(tasks)
    style_patch = brand_css + """
    .poster.inline { width: 1600px; height: 900px; }
    .poster.inline .content { display: grid; grid-template-rows: auto auto auto minmax(320px, 1fr); gap: 20px; padding: 48px var(--sp-12); }
    .poster.inline .h-xl { font-size: 88px; line-height: 1.04; }
    .poster.inline .matrix-fill { grid-template-columns: repeat(4, 1fr); grid-auto-rows: minmax(150px, auto); }
    .poster.inline .inline-stage { min-height: 0; }
    .cover-recipe-stage { display: grid; min-height: 100%; }
    .poster.wide .swiss-cover-stage { grid-template-columns: minmax(0, 1.08fr) minmax(500px, .92fr); grid-template-rows: auto auto minmax(0,1fr); gap: 20px 48px; padding: 72px 112px; }
    .poster.wide .editorial-cover-stage { grid-template-columns: minmax(0, 1.08fr) minmax(500px, .92fr); grid-template-rows: auto auto minmax(0,1fr); gap: 24px 48px; padding: 78px 112px; }
    .poster.wide .swiss-cover-stage .chrome-min { grid-column: 1 / -1; grid-row: 1; }
    .poster.wide .swiss-cover-stage > .stack, .poster.wide .editorial-cover-stage > .stack { grid-column: 1 / -1; grid-row: 2; align-self: start; }
    .poster.wide .swiss-cover-stage > .lead, .poster.wide .editorial-cover-stage > .lead { grid-column: 1; grid-row: 3; align-self: start; }
    .poster.wide .swiss-cover-stage > .recipe-evidence, .poster.wide .swiss-cover-stage > .ai-concept-visual, .poster.wide .swiss-cover-stage > .comparison-panel, .poster.wide .swiss-cover-stage > .step-path-panel, .poster.wide .swiss-cover-stage > .cover-quote, .poster.wide .editorial-cover-stage > .recipe-evidence, .poster.wide .editorial-cover-stage > .ai-concept-visual, .poster.wide .editorial-cover-stage > .comparison-panel, .poster.wide .editorial-cover-stage > .step-path-panel, .poster.wide .editorial-cover-stage > .cover-quote { grid-column: 2; grid-row: 3; align-self: stretch; }
    .poster.wide .wide-cover-title { max-width: 100%; white-space: nowrap; }
    .poster.square .cover-recipe-stage { gap: 24px; padding: 72px; }
    .poster.square .swiss-cover-stage { grid-template-rows: auto auto auto minmax(260px,1fr); }
    .poster.square .editorial-cover-stage { grid-template-rows: auto minmax(300px,1fr); }
    .poster.square .cover-recipe-stage .chrome-min { align-self: start; }
    .poster.square .cover-recipe-stage .lead { align-self: start; }
    .cover-recipe-stage .recipe-evidence, .cover-recipe-stage .ai-concept-visual, .cover-recipe-stage .comparison-panel, .cover-recipe-stage .step-path-panel, .cover-recipe-stage .cover-quote { min-height: 0; }
    .ai-concept-visual { position: relative; min-height: 100%; margin: 0; overflow: hidden; background: var(--grey-1, rgba(255,255,255,.09)); }
    .ai-concept-visual img { display: block; width: 100%; height: 100%; min-height: 100%; object-fit: cover; }
    .ai-concept-visual::after { content: ""; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(180deg, transparent 58%, rgba(0,0,0,.16)); }
    .ai-concept-visual figcaption { position: absolute; right: 16px; bottom: 12px; z-index: 1; color: #fff; font: 600 14px/1.2 var(--sans-zh, sans-serif); letter-spacing: .04em; text-shadow: 0 1px 6px rgba(0,0,0,.45); }
    .cover-quote { margin: 0; padding: 34px; display: flex; align-items: center; font: 600 42px/1.35 var(--serif-zh, serif); background: var(--grey-1, rgba(255,255,255,.12)); border-left: 4px solid var(--accent, #002fa7); }
    .poster.video { width: 1080px; height: 1920px; }
    .poster.video .content.video-stage { height: 100%; padding: 78px 82px; display: grid; }
    .swiss-video-stage { grid-template-rows: auto auto minmax(0,1fr) auto auto; gap: 26px; }
    .editorial-video-stage { grid-template-rows: auto minmax(0,1fr) auto; gap: 36px; }
    .poster.video .h-statement { font-size: 126px; line-height: .98; }
    .poster.video .h-display { font-size: 114px; line-height: 1; }
    .poster.video .video-copy { display: flex; flex-direction: column; justify-content: center; gap: 32px; }
    .video-hook { display: flex; align-items: center; min-height: 330px; padding: 38px; background: var(--grey-1, rgba(255,255,255,.1)); border-top: 3px solid var(--accent, #002fa7); }
    .video-hook p { margin: 0; font: 600 38px/1.42 var(--sans-zh, sans-serif); }
    .video-footer { display: flex; justify-content: space-between; gap: 18px; padding-top: 24px; border-top: 1px solid var(--grey-2, rgba(255,255,255,.28)); font: 500 18px/1.2 var(--mono, monospace); }
    .poster.xhs .content.recipe-stage { padding: 60px 72px; gap: 16px; height: 100%; }
    .poster.xhs.native-card .content.native-stage { height: 100%; padding: 76px; display: flex; flex-direction: column; gap: 44px; color: var(--ink, #1a1a1a); background: var(--paper, #fdf8f3); }
    .native-page-number { flex: 0 0 auto; font: 500 28px/1.4 var(--mono, monospace); color: var(--muted, #6b6b6b); border-bottom: 2px solid var(--line, #d8cec5); padding-bottom: 22px; }
    .native-copy { display: flex; flex-direction: column; justify-content: center; flex: 1 1 0; min-height: 0; gap: 44px; }
    .native-copy > * { flex-shrink: 0; margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; text-wrap: pretty; }
    .native-title { font: 600 80px/1.25 var(--sans-zh, sans-serif); letter-spacing: -.025em; text-wrap: balance; }
    .native-editorial .native-title { font-family: var(--serif-zh, serif); }
    .native-body { font: 400 64px/1.55 var(--sans-zh, sans-serif); }
    .native-subtitle { font: 500 48px/1.5 var(--sans-zh, sans-serif); }
    .native-note { font: 400 36px/1.55 var(--sans-zh, sans-serif); color: var(--muted, #6b6b6b); }
    .native-short:not(.native-cover) .native-title { font-size: 60px; color: var(--muted, #6b6b6b); }
    .native-short:not(.native-cover) .native-body { max-width: 860px; font-size: 112px; font-weight: 500; line-height: 1.35; text-wrap: balance; }
    .native-long .native-body { font-size: 46px; line-height: 1.6; }
    .native-cover .native-copy { gap: 36px; }
    .native-cover .native-title { font-size: 128px; color: var(--accent, #e85d4c); }
    .native-cover .native-body { font-size: 44px; }
    .native-closing .native-copy { border-left: 5px solid var(--accent, #e85d4c); padding-left: 40px; }
    .native-with-evidence .native-copy { flex: 0 0 auto; }
    .native-with-evidence .native-body { font-size: 44px; line-height: 1.5; }
    .native-evidence { flex: 1 0 560px; min-height: 560px; }
    .native-evidence > * { height: 100%; }
    .poster.xhs .swiss-recipe-stage { display: grid; grid-template-rows: auto auto auto auto minmax(500px, 1fr) 150px; }
    .poster.xhs .content.editorial-recipe-stage { display: grid; grid-template-rows: auto auto minmax(0, 1fr); gap: 20px; padding: 60px 72px 72px; }
    .poster.xhs .recipe-stage .h-statement { font-size: 108px; line-height: 1; }
    .poster.xhs .recipe-stage .h-xl { font-size: 76px; line-height: 1.04; }
    .poster.xhs .editorial-recipe-stage .h-display { font-size: 86px; line-height: 1; }
    .visual-stage { min-height: 500px; display: flex; align-items: stretch; overflow: hidden; background: var(--grey-1, rgba(255,255,255,.09)); }
    .editorial-stage { min-height: 0; background: rgba(255,255,255,.09); padding: 28px; }
    .visual-stage > * { flex: 1 1 auto; min-height: 100%; width: 100%; }
    .visual-stage .card-fill { min-height: 100%; margin: 0; display: flex; align-items: center; padding: 48px; }
    .visual-stage .stacked-ledger,.visual-stage .h-bar-chart { min-height: 100%; margin: 0; padding: 34px; display: flex; flex-direction: column; justify-content: center; gap: 20px; }
    .visual-stage .stacked-ledger .ledger-row { grid-template-columns: 128px 1fr; gap: 24px; padding: 12px 0; }
    .visual-stage .stacked-ledger .ledger-row:first-child { padding-top: 12px; }
    .visual-stage .stacked-ledger .ledger-num { font-size: 68px; }
    .visual-stage .stacked-ledger .ledger-lbl { margin: 0; font-size: 26px; }
    .visual-stage .stacked-ledger .ledger-lbl .sub { font-size: 18px; }
    .visual-stage .matrix-fill { min-height: 100%; margin: 0; grid-auto-rows: minmax(150px, 1fr); align-content: stretch; }
    .cover-signal-panel { width: 100%; min-height: 100%; display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); background: var(--paper, #fafaf8); }
    .cover-signal-row { min-height: 50%; padding: 34px; border: 1px solid var(--grey-2, #d4d4d2); display: flex; flex-direction: column; justify-content: space-between; gap: 22px; }
    .cover-signal-row span { font: 500 20px/1 var(--mono, monospace); color: var(--accent, #002fa7); }
    .cover-signal-row p { margin: 0; font: 500 31px/1.25 var(--sans-zh, sans-serif); }
    .comparison-panel { min-height: 100%; width: 100%; display: grid; grid-template-columns: minmax(0,1fr) 64px minmax(0,1fr); align-items: stretch; background: var(--paper, #fafaf8); }
    .comparison-side { padding: 34px; display: flex; flex-direction: column; justify-content: space-between; gap: 28px; border: 1px solid var(--grey-2, #d4d4d2); }
    .comparison-side span { font: 500 17px/1 var(--mono, monospace); color: var(--grey-4, #737373); }
    .comparison-side.is-after span { color: var(--accent, #002fa7); }
    .comparison-side p { margin: 0; font: 600 31px/1.28 var(--sans-zh, sans-serif); }
    .comparison-arrow { display: flex; align-items: center; justify-content: center; font: 500 38px/1 var(--mono, monospace); color: var(--accent, #002fa7); }
    .step-path-panel { min-height: 100%; width: 100%; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); background: var(--paper, #fafaf8); }
    .step-path-item { padding: 30px 26px; border: 1px solid var(--grey-2, #d4d4d2); display: flex; flex-direction: column; justify-content: space-between; gap: 30px; }
    .step-path-item span { font: 500 21px/1 var(--mono, monospace); color: var(--accent, #002fa7); }
    .step-path-item p { margin: 0; font: 600 25px/1.3 var(--sans-zh, sans-serif); }
    .story-path-panel { min-height: 100%; width: 100%; display: grid; grid-template-columns: 130px minmax(0,1fr); align-content: center; background: rgba(255,255,255,.08); }
    .story-path-item { display: contents; }
    .story-path-item span { padding: 22px 18px; border-top: 1px solid var(--grey-2, rgba(255,255,255,.32)); font: 500 17px/1 var(--mono, monospace); color: var(--accent, #002fa7); }
    .story-path-item p { margin: 0; padding: 18px 20px 22px; border-top: 1px solid var(--grey-2, rgba(255,255,255,.32)); font: 500 26px/1.35 var(--serif-zh, serif); }
    .editorial-callout-panel { min-height: 100%; display: grid; grid-template-rows: minmax(240px,1fr) auto; gap: 24px; }
    .editorial-callout-panel .callout { min-height: 0; display: flex; flex-direction: column; justify-content: center; }
    .editorial-notes { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 16px; }
    .editorial-note { min-height: 130px; padding: 20px; border-top: 2px solid var(--accent); background: rgba(255,255,255,.08); }
    .editorial-note span { font: 600 16px/1 var(--mono,monospace); color: var(--accent); }
    .editorial-note p { margin: 18px 0 0; font: 500 20px/1.35 var(--serif-zh,serif); }
    .editorial-stage .ledger { min-height: 100%; justify-content: center; }
    .editorial-stage .ledger-row { grid-template-columns: 64px 1fr; gap: 18px; padding: 14px 0; }
    .editorial-stage .ledger-row .ledger-nb { font-size: 20px; }
    .editorial-stage .ledger-row .ledger-title { margin: 0; font-size: 28px; line-height: 1.2; }
    .editorial-stage .ledger-row .ledger-note { grid-column: 2; margin: 0; font-size: 17px; line-height: 1.35; }
    .poster.xhs .recipe-stage .hero-stat-bottom { min-height: 150px; margin: 0; padding: 24px 30px; background: var(--grey-1, rgba(255,255,255,.09)); }
    .poster.xhs .recipe-stage .hero-stat-bottom .num-mega { font-size: 104px; }
    .poster.xhs .recipe-evidence { min-height: 100%; width: 100%; }
    .poster.xhs .recipe-evidence figure { width: 100%; height: 100%; }
    .poster.xhs .recipe-evidence img { width: 100%; height: 100%; object-fit: cover; }
    .poster.xhs .editorial-stage .device-browser.recipe-evidence { min-height: 0; height: 100%; display: grid; grid-template-rows: 36px minmax(0, 1fr); }
    .poster.xhs .editorial-stage .device-browser.recipe-evidence::before { height: auto; }
    .poster.xhs .editorial-stage .device-browser.recipe-evidence .frame-shot { min-height: 0; height: 100%; aspect-ratio: auto; }
    .poster.moments .content.moments-stage { height: 100%; padding: 60px 68px; }
    .poster.moments .swiss-moments-stage { display: grid; grid-template-rows: auto auto auto auto minmax(230px, 1fr) auto; gap: 14px; }
    .poster.moments .editorial-moments-stage { display: grid; grid-template-rows: auto auto minmax(220px, 1fr) auto; gap: 16px; }
    .poster.moments .h-statement { font-size: 82px; line-height: 1.02; }
    .poster.moments .h-display { font-size: 76px; line-height: 1.02; }
    .poster.moments .lead { font-size: 26px; line-height: 1.42; }
    .poster.moments .visual-stage { min-height: 0; }
    .poster.moments .visual-stage .comparison-side { padding: 22px; gap: 16px; }
    .poster.moments .visual-stage .comparison-side p { font-size: 24px; }
    .poster.moments .visual-stage .step-path-item { padding: 20px 16px; gap: 16px; }
    .poster.moments .visual-stage .step-path-item p { font-size: 21px; }
    .poster.moments .visual-stage .story-path-item p { padding: 13px 14px 16px; font-size: 21px; }
    .poster.moments .moments-footer { display: flex; justify-content: space-between; gap: 16px; margin: 0; padding-top: 12px; border-top: 1px solid var(--grey-2, rgba(28,28,28,.2)); font: 600 16px/1.2 var(--mono, monospace); color: var(--grey-4, #737373); }
    .editorial-stage .matrix-fill { width: 100%; min-height: 100%; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-auto-rows: minmax(160px, 1fr); gap: 16px; }
    .editorial-stage .matrix-cell { min-height: 0; padding: 24px; display: flex; flex-direction: column; justify-content: center; gap: 20px; background: var(--paper-2, #ebe6da); border: 1px solid var(--line, rgba(28,28,28,.2)); }
    .editorial-stage .matrix-cell:only-child { grid-column: 1 / -1; }
    .editorial-stage .matrix-cell .cell-nb { margin: 0; font: 500 18px/1 var(--mono, monospace); color: var(--muted, #68625a); }
    .editorial-stage .matrix-cell .cell-title { margin: 0; font: 500 22px/1.35 var(--serif-zh, serif); color: var(--ink, #0a0a0b); }
    .editorial-stage .matrix-cell.is-accent { background: var(--accent, #111111); border-color: var(--accent, #111111); }
    .editorial-stage .matrix-cell.is-accent .cell-nb, .editorial-stage .matrix-cell.is-accent .cell-title { color: var(--paper, #f3f0e8); }
    .evidence-data { display: flex; flex-direction: column; justify-content: center; gap: 26px; padding: 38px; background: var(--grey-1, #ececec); }
    .evidence-row { display: grid; grid-template-columns: minmax(150px, 1fr) 2fr; gap: 22px; align-items: center; }
    .evidence-key,.evidence-value { margin: 0; font: 600 24px/1.3 var(--sans-zh, sans-serif); }
    .evidence-value { color: var(--accent, #002fa7); text-align: right; font-size: 30px; }
    .evidence-rule { height: 18px; background: rgba(115,115,115,.18); overflow: hidden; }
    .evidence-rule span { display: block; height: 100%; background: var(--accent, #002fa7); }
    .evidence-document { min-height: 100%; padding: 34px 38px; display: grid; grid-template-rows: auto auto 1fr; gap: 24px; background: var(--paper, #f7f3ea); border: 1px solid rgba(28,28,28,.2); }
    .document-meta { display: flex; justify-content: space-between; gap: 18px; padding-bottom: 14px; border-bottom: 1px solid rgba(28,28,28,.3); font: 500 17px/1.4 var(--mono, monospace); }
    .evidence-document blockquote { margin: 0; max-width: 92%; font: 500 31px/1.5 var(--serif-zh, serif); }
    .document-lines { display: grid; align-content: end; gap: 12px; }
    .document-lines p { margin: 0; display: grid; grid-template-columns: 42px 1fr; gap: 12px; font: 400 22px/1.5 var(--sans-zh, sans-serif); }
    .document-lines span { font-family: var(--mono, monospace); color: var(--accent, #8b1e1e); }
    """
    template = template.replace("</style>", f"{style_patch}\n  </style>", 1)
    if brand_profile:
        template = template.replace("<html ", f'<html data-brand-profile="{html.escape(brand_profile, quote=True)}" ', 1)
    png_tasks = [task for task in tasks if task["kind"] != "wechat_html"]
    posters = "\n".join(_poster_for_task(task) for task in png_tasks)
    marker = "<!-- POSTERS_HERE -->"
    start = template.index(marker, template.index("<main"))
    end = template.index("</main>", start)
    rendered = template[:start] + posters + "\n  " + template[end:]
    # Fit real text within a fixed card without clipping, truncation or scaling
    # below the readable floor. The screenshot check rejects anything that
    # still cannot fit at those floors.
    fit_script = '''<script>
    window.echoNativeLayoutReady = (async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      for (const card of document.querySelectorAll('[data-native-layout="editorial-v1"]')) {
        const box = card.querySelector('.native-copy');
        const fields = [...box.querySelectorAll('[data-approved-copy]')];
        const initial = fields.map(node => parseFloat(getComputedStyle(node).fontSize));
        for (let attempt = 0; attempt < 18; attempt++) {
          const bounds = box.getBoundingClientRect();
          const fits = fields.every(node => { const r = node.getBoundingClientRect(); return r.top >= bounds.top - 1 && r.bottom <= bounds.bottom + 1; });
          if (fits) break;
          fields.forEach((node, i) => {
            const floor = node.classList.contains('native-note') ? 36 : node.classList.contains('native-title') ? 48 : 42;
            node.style.fontSize = Math.max(floor, initial[i] * (1 - (attempt + 1) * .04)) + 'px';
          });
        }
      }
    })();
    </script>'''
    return rendered.replace('</body>', fit_script + '\n</body>')


def _run_local_aesthetic_gate(render_dir: Path, deck_paths: dict[str, Path]) -> dict[str, Any]:
    validator = REPO_ROOT / "skills" / "xhs-card" / "validate-social-deck.mjs"
    if not validator.exists():
        return {
            "aesthetic_status": "review_required",
            "quality_tools": [],
            "platform_gap_checks": ["小红书独立图文 1080x1440（P1-P8）", "公众号 md2wechat 完整 HTML 排版", "视频号不进入静态视觉生产"],
            "aesthetic_notes": ["xhs-card validator not found"],
        }
    notes: list[str] = []
    reports: list[str] = []
    density_warnings: list[str] = []
    for style, deck_path in deck_paths.items():
        proc = _run_visual_node_script(
            validator,
            [str(deck_path), f"--style={style}"],
            cwd=REPO_ROOT / "skills" / "xhs-card",
            purpose="xhs-card 审美校验",
        )
        stable_target = f"render/{deck_path.name}"
        stdout = re.sub(
            r"(?mi)^(?P<indent>\s*)target\s*:\s*.*$",
            rf"\g<indent>target: {stable_target}",
            proc.stdout or "",
        )
        stderr = re.sub(
            r"(?mi)^(?P<indent>\s*)target\s*:\s*.*$",
            rf"\g<indent>target: {stable_target}",
            proc.stderr or "",
        )
        if any(token in f"{stdout}\n{stderr}" for token in ("/private/", "/Users/", "../../")):
            raise VisualOutputError("xhs-card aesthetic validation report contains an unnormalized local path")
        if proc.returncode != 0:
            raise VisualOutputError(f"xhs-card aesthetic validation failed: {stdout.strip() or stderr.strip()}")
        notes.append(f"{style.title()} template rendered by Playwright")
        report = "\n".join(part for part in (stdout.strip(), stderr.strip()) if part).strip()
        if report:
            reports.append(report)
            density_warnings.extend(
                line.strip() for line in report.splitlines()
                if "R5" in line.upper() and "WARN" in line.upper()
            )
    return {
        "aesthetic_status": "pass",
        "quality_tools": ["skills/xhs-card/validate-social-deck.mjs"],
        "platform_gap_checks": ["小红书独立图文 1080x1440（P1-P8）", "公众号 md2wechat 完整 HTML 排版", "视频号不进入静态视觉生产"],
        "aesthetic_notes": notes + ["xhs-card QA returned pass"],
        "render_quality_report": "\n\n".join(reports),
        "density_warnings": density_warnings,
    }


def _template_path_for_task(task: dict[str, Any]) -> Path:
    style = str(task.get("template_style") or _template_style(str(task.get("layout_recipe") or "")))
    return EDITORIAL_TEMPLATE_PATH if style == "editorial" else XHS_TEMPLATE_PATH


def _prepare_render_task(project: Path, task: dict[str, Any]) -> dict[str, Any]:
    prepared = dict(task)
    sources = prepared.get("evidence_sources") or []
    if sources:
        if any(_is_library_record(str(source)) for source in sources):
            raise VisualOutputError("素材库内部记录不能作为公开图表证据，请重新生成平台排版。")
        validated_sources = [
            (_project_source(project, str(source), "visual evidence"), str(source))
            for source in sources
        ]
        candidate, source_label = validated_sources[0]
        if candidate.suffix.lower() in {".png", ".jpg", ".jpeg", ".webp", ".gif"}:
            mime = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp",
                ".gif": "image/gif",
            }[candidate.suffix.lower()]
            encoded = base64.b64encode(candidate.read_bytes()).decode("ascii")
            prepared["evidence_url"] = f"data:{mime};base64,{encoded}"
            prepared["evidence_kind"] = "image"
        else:
            prepared["evidence_items"] = _diagram_evidence_items(candidate)
            prepared["evidence_kind"] = "dataset" if candidate.suffix.lower() in {".csv", ".tsv", ".json"} else "document"
            prepared["evidence_source"] = source_label
    return prepared


def _read_screenshot_evidence_ratios(metrics_path: Path, target_ids: list[str]) -> dict[str, float]:
    try:
        payload = json.loads(metrics_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VisualOutputError(f"missing or invalid screenshot metrics sidecar: {metrics_path}") from exc
    targets = payload.get("targets") if isinstance(payload, dict) else None
    if not isinstance(targets, dict):
        raise VisualOutputError(f"screenshot metrics sidecar has no target measurements: {metrics_path}")

    ratios: dict[str, float] = {}
    for target_id in target_ids:
        measurement = targets.get(target_id)
        value = measurement.get("evidence_ratio") if isinstance(measurement, dict) else None
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise VisualOutputError(f"screenshot metrics are missing evidence_ratio for {target_id}")
        ratio = float(value)
        if not math.isfinite(ratio) or not 0 <= ratio <= 1:
            raise VisualOutputError(f"screenshot metrics have invalid evidence_ratio for {target_id}")
        ratios[target_id] = ratio
    return ratios


def _read_screenshot_evidence_details(metrics_path: Path, target_ids: list[str]) -> dict[str, float | None]:
    try:
        payload = json.loads(metrics_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VisualOutputError(f"missing or invalid screenshot metrics sidecar: {metrics_path}") from exc
    targets = payload.get("targets") if isinstance(payload, dict) else None
    if not isinstance(targets, dict):
        raise VisualOutputError(f"screenshot metrics sidecar has no target measurements: {metrics_path}")
    details: dict[str, float | None] = {}
    for target_id in target_ids:
        measurement = targets.get(target_id)
        value = measurement.get("evidence_detail_score") if isinstance(measurement, dict) else None
        if value is None:
            details[target_id] = None
            continue
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise VisualOutputError(f"screenshot metrics have invalid evidence_detail_score for {target_id}")
        score = float(value)
        if not math.isfinite(score) or not 0 <= score <= 1:
            raise VisualOutputError(f"screenshot metrics have invalid evidence_detail_score for {target_id}")
        details[target_id] = score
    return details


def _tabular_evidence_items(headers: list[Any], rows: list[list[Any]]) -> list[tuple[str, str]]:
    clean_headers = [_clean_text(header) or f"字段 {index + 1}" for index, header in enumerate(headers)]
    items: list[tuple[str, str]] = []
    for row in rows[:4]:
        values = [_clean_text(cell) for cell in row]
        label = values[0] if values else ""
        value = " · ".join(
            f"{clean_headers[index] if index < len(clean_headers) else f'字段 {index + 1}'}: {cell}"
            for index, cell in enumerate(values[1:], start=1)
            if cell
        )
        items.append(((label or "证据项")[:22], (value or "已记录")[:42]))
    return items


def _json_evidence_items(source_path: Path) -> list[tuple[str, str]]:
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise VisualOutputError(f"invalid JSON evidence source: {source_path.name}") from exc
    if isinstance(payload, list) and payload and all(isinstance(item, dict) for item in payload):
        headers: list[str] = []
        for record in payload[:4]:
            for key in record:
                if str(key) not in headers:
                    headers.append(str(key))
        rows = [[record.get(header, "") for header in headers] for record in payload[:4]]
        return _tabular_evidence_items(headers, rows)
    if isinstance(payload, dict):
        items = []
        for key, value in list(payload.items())[:4]:
            rendered = json.dumps(value, ensure_ascii=False, separators=(",", ":")) if isinstance(value, (dict, list)) else str(value)
            items.append((_clean_text(key)[:22] or "证据项", _clean_text(rendered)[:42] or "已记录"))
        return items or [("证据 01", "已记录")]
    if isinstance(payload, list):
        return [
            (f"证据 {index:02d}", _clean_text(value)[:42] or "已记录")
            for index, value in enumerate(payload[:4], start=1)
        ] or [("证据 01", "已记录")]
    raise VisualOutputError("JSON evidence source must contain an object or array")


_PRIVATE_EVIDENCE_FIELD_RE = re.compile(
    r"^(?:source(?:_path|_name|_ext)?|path|file(?:name)?|created_at|updated_at|"
    r"step|slug|run_id|revision_id|project)\s*[:：]",
    re.IGNORECASE,
)
_PRIVATE_EVIDENCE_PATH_RE = re.compile(
    r"(?:^|[\s'\"`])(?:/Users/|[A-Za-z]:\\|(?:materials|pipeline|sessions|skills)/)"
    r"|\.(?:md|json|py|tsx?|jsx?|yaml|yml)\b",
    re.IGNORECASE,
)


def _publishable_document_lines(source_path: Path) -> list[str]:
    """Extract reader-facing evidence while excluding provenance metadata."""
    raw_lines = source_path.read_text(encoding="utf-8", errors="strict").splitlines()
    first_content = next((index for index, line in enumerate(raw_lines) if line.strip()), None)
    if first_content is not None and raw_lines[first_content].strip() == "---":
        closing = next(
            (index for index in range(first_content + 1, len(raw_lines)) if raw_lines[index].strip() == "---"),
            None,
        )
        if closing is not None:
            raw_lines = raw_lines[closing + 1:]

    lines: list[str] = []
    inside_fence = False
    for raw_line in raw_lines:
        stripped = raw_line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            inside_fence = not inside_fence
            continue
        if inside_fence or not stripped or stripped == "---":
            continue
        if _PRIVATE_EVIDENCE_FIELD_RE.search(stripped) or _PRIVATE_EVIDENCE_PATH_RE.search(stripped):
            continue
        visible = re.sub(r"^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)", "", stripped)
        visible = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", visible)
        visible = re.sub(r"[`*_]", "", visible)
        visible = _clean_text(visible)
        if visible and not _PRIVATE_EVIDENCE_FIELD_RE.search(visible) and not _PRIVATE_EVIDENCE_PATH_RE.search(visible):
            lines.append(visible)
    return lines


def _diagram_evidence_items(source_path: Path) -> list[tuple[str, str]]:
    suffix = source_path.suffix.lower()
    if suffix in {".csv", ".tsv"}:
        delimiter = "\t" if suffix == ".tsv" else ","
        with source_path.open("r", encoding="utf-8", errors="strict", newline="") as handle:
            rows = list(csv.reader(handle, delimiter=delimiter))
        if rows:
            items = _tabular_evidence_items(rows[0], rows[1:])
            if items:
                return items
        return [("证据 01", "已记录")]
    if suffix == ".json":
        return _json_evidence_items(source_path)
    if suffix not in {".md", ".txt"}:
        raise VisualOutputError(f"unsupported structured evidence format: {suffix or '<none>'}")
    lines = _publishable_document_lines(source_path)
    return [(f"证据 {index:02d}", line[:42]) for index, line in enumerate(lines[:4], start=1)] or [("证据 01", "已记录")]


def _diagram_value_lines(value: str) -> tuple[str, str]:
    parts = [_clean_text(part) for part in value.split(" · ") if _clean_text(part)]
    if len(parts) >= 2:
        return parts[0][:28], " · ".join(parts[1:])[:32]
    clean = _clean_text(value)
    if len(clean) <= 28:
        return clean, ""
    return clean[:28], clean[28:60]


def _discover_baoyu_image_gen() -> tuple[Path, Path]:
    configured = str(os.environ.get("AIFIOS_BAOYU_IMAGE_GEN_DIR") or "").strip()
    if configured:
        configured_path = Path(configured).expanduser()
        candidates = [configured_path] if configured_path.is_absolute() else []
    else:
        home = Path.home()
        candidates = [
            home / ".codex" / "skills" / "baoyu-image-gen",
            home / ".agents" / "skills" / "baoyu-image-gen",
        ]
    for candidate in candidates:
        skill_file = candidate / "SKILL.md"
        script_file = candidate / "scripts" / "main.ts"
        if (
            candidate.is_dir()
            and not candidate.is_symlink()
            and skill_file.is_file()
            and not skill_file.is_symlink()
            and script_file.is_file()
            and not script_file.is_symlink()
            and skill_file.stat().st_size > 0
            and script_file.stat().st_size > 0
        ):
            return candidate.resolve(), script_file.resolve()
    raise VisualOutputError(
        "Echo Founder baoyu-image-gen backend 未配置。请重新安装应用；开发环境请配置包含 "
        "SKILL.md 和 scripts/main.ts 的 baoyu-image-gen skill。"
    )


def _paid_image_benchmark() -> tuple[Path, dict[str, Any]]:
    configured = str(os.environ.get("AIFIOS_IMAGE_BENCHMARK_MANIFEST") or "").strip()
    if configured:
        path = Path(configured).expanduser()
    else:
        user_data = str(os.environ.get("AIFIOS_DESKTOP_USER_DATA_DIR") or "").strip()
        if not user_data:
            raise VisualOutputError("AI 增强需要先完成并冻结真实付费生图 benchmark")
        path = Path(user_data) / "image-benchmarks" / "current.json"
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise VisualOutputError("真实付费生图 benchmark 路径无效或尚未冻结")
    try:
        manifest = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VisualOutputError("真实付费生图 benchmark 无法读取") from exc
    selection = manifest.get("selection") if isinstance(manifest, dict) else None
    if (
        not isinstance(manifest, dict)
        or manifest.get("schema_version") != "echo-founder.image-provider-benchmark.v1"
        or manifest.get("status") not in {"scored", "accepted"}
        or not isinstance(selection, dict)
        or selection.get("ai_enhanced_default_eligible") is not True
        or not selection.get("primary")
        or not selection.get("backup")
    ):
        raise VisualOutputError("真实付费生图 benchmark 尚未通过 10 进 3 主备门禁")
    return path.resolve(), manifest


def _paid_route(manifest: dict[str, Any], route_id: str) -> dict[str, Any]:
    route = next(
        (
            item for item in manifest.get("routes", [])
            if isinstance(item, dict) and item.get("route_id") == route_id
        ),
        None,
    )
    if not isinstance(route, dict) or not route.get("model_id"):
        raise VisualOutputError(f"冻结 benchmark 中不存在生图路由：{route_id}")
    estimate = route.get("estimated_cost_cny")
    if not isinstance(estimate, (int, float)) or isinstance(estimate, bool) or estimate <= 0:
        raise VisualOutputError(f"生图路由没有冻结单次人民币预算上限：{route_id}")
    return route


def _paid_runtime_context() -> dict[str, Any]:
    try:
        policy = load_image_account_policy()
        limits = budget_limits(policy)
    except ImageAccountPolicyError as exc:
        raise VisualOutputError(str(exc)) from exc
    route_source = "bundled_runtime_catalog"
    try:
        manifest_path, manifest = _paid_image_benchmark()
        routes = accepted_route_candidates(manifest, policy)
        route_source = "internal_benchmark"
    except (VisualOutputError, ImageAccountPolicyError):
        try:
            manifest = load_runtime_route_catalog()
            manifest_path = (
                Path(str(os.environ.get("AIFIOS_IMAGE_RUNTIME_ROUTE_CATALOG") or "")).expanduser()
                if str(os.environ.get("AIFIOS_IMAGE_RUNTIME_ROUTE_CATALOG") or "").strip()
                else RUNTIME_ROOT / "config" / "runtime-image-routes.json"
            ).resolve()
            routes = runtime_route_candidates(manifest, policy)
        except ImageAccountPolicyError as exc:
            raise VisualOutputError(str(exc)) from exc
    return {
        "manifest_path": manifest_path,
        "manifest": manifest,
        "route_source": route_source,
        "policy": policy,
        "routes": routes,
        "budget_limits": limits,
        "reserved_cny": 0.0,
    }


def _reserve_runtime_task_budget(context: dict[str, Any], route: dict[str, Any]) -> None:
    estimate = float(route["estimated_cost_cny"])
    limits = context["budget_limits"]
    if estimate > float(limits["per_call_limit"]) + 1e-9:
        raise VisualOutputError(
            f"当前路由单次预估 ¥{estimate:.2f}，超过单次上限 ¥{float(limits['per_call_limit']):.2f}"
        )
    reserved = float(context.get("reserved_cny") or 0.0)
    if reserved + estimate > float(limits["per_task_limit"]) + 1e-9:
        raise VisualOutputError(
            f"本任务预估费用将超过 ¥{float(limits['per_task_limit']):.2f}，已停止新的付费调用"
        )
    context["reserved_cny"] = round(reserved + estimate, 4)


def _validate_paid_image_file(path: Path) -> str:
    if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
        raise VisualOutputError("付费生图服务没有返回完整图片")
    data = path.read_bytes()
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and len(data) >= 12 and data[8:12] == b"WEBP":
        return "image/webp"
    if data.lstrip().startswith(b"<svg"):
        return "image/svg+xml"
    raise VisualOutputError("付费生图服务返回的文件格式无效")


def _normalize_paid_image_to_png(
    project: Path,
    task: dict[str, Any],
    source_path: Path,
    output_path: Path,
    render_dir: Path,
) -> tuple[int, int]:
    target_width = int(task.get("width") or 0)
    target_height = int(task.get("height") or 0)
    if target_width <= 0 or target_height <= 0:
        raise VisualOutputError("付费生图任务缺少目标尺寸")
    safe_id = re.sub(r"[^A-Za-z0-9._-]+", "-", str(task.get("id") or "paid-image")).strip("-")
    html_path = render_dir / "paid-normalize" / f"{safe_id}.html"
    spec_path = render_dir / "paid-normalize" / f"{safe_id}.json"
    metrics_path = render_dir / "paid-normalize" / f"{safe_id}.metrics.json"
    for candidate in (html_path, spec_path, metrics_path):
        if candidate.is_symlink():
            raise VisualOutputError("付费生图归一化路径不能是符号链接")
    html_path.parent.mkdir(parents=True, exist_ok=True)
    html_path.write_text(
        '<!doctype html><html><head><meta charset="utf-8"><style>'
        'html,body{margin:0;padding:0;background:#fff;overflow:hidden}'
        f'#paid-image{{width:{target_width}px;height:{target_height}px;overflow:hidden;background:#fff}}'
        '#paid-image img{display:block;width:100%;height:100%;object-fit:cover;object-position:center}'
        '</style></head><body>'
        f'<section id="paid-image"><img src="{html.escape(source_path.resolve(strict=True).as_uri(), quote=True)}" alt=""></section>'
        '</body></html>',
        encoding="utf-8",
    )
    spec_path.write_text(
        json.dumps(
            {
                "html": str(html_path),
                "metrics": str(metrics_path),
                "targets": [{"id": "paid-image", "output": str(output_path)}],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    proc = _run_visual_node_script(
        VISUAL_SCREENSHOT_SCRIPT,
        [str(spec_path)],
        cwd=REPO_ROOT,
        purpose="付费生图 PNG 归一化",
    )
    if proc.returncode != 0:
        raise VisualOutputError(f"付费生图 PNG 归一化失败：{proc.stderr.strip() or proc.stdout.strip()}")
    width, height = _png_size(output_path)
    if width != target_width or height != target_height:
        raise VisualOutputError(
            f"付费生图归一化尺寸错误：got {width}x{height}, expected {target_width}x{target_height}"
        )
    return width, height


def _render_paid_image_backend(
    project: Path,
    task: dict[str, Any],
    provider: dict[str, Any],
    render_dir: Path,
    manifest_path: Path,
    manifest: dict[str, Any],
    route_id: str,
    phase: str,
    runtime_context: dict[str, Any],
) -> dict[str, Any]:
    if not PAID_IMAGE_GATEWAY_SCRIPT.is_file() or PAID_IMAGE_GATEWAY_SCRIPT.is_symlink():
        raise VisualOutputError("Echo Founder 付费生图网关缺失")
    route = _paid_route(manifest, route_id)
    _reserve_runtime_task_budget(runtime_context, route)
    publish_root = _recipe_publish_root(project, str(task.get("slug") or ""), str(task.get("revision_id") or ""))
    output_path = _project_output(project, task["output"], "paid AI image output", within=publish_root)
    prompt_name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(task.get("id") or "paid-image")).strip("-")
    prompt_path = render_dir / "prompts" / f"{prompt_name}-{route_id}.prompt.md"
    source_path = render_dir / "paid-sources" / f"{prompt_name}-{route_id}.image"
    if prompt_path.is_symlink():
        raise VisualOutputError("付费生图提示词路径不能是符号链接")
    prompt_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.parent.mkdir(parents=True, exist_ok=True)
    prompt = _ai_inline_prompt(task)
    prompt_path.write_text(prompt, encoding="utf-8")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if source_path.is_symlink():
        raise VisualOutputError("付费生图原始输出路径不能是符号链接")
    if source_path.exists() and not source_path.is_file():
        raise VisualOutputError("付费生图原始输出路径必须是文件")
    if output_path.is_symlink() or output_path.is_file():
        output_path.unlink()
    elif output_path.exists():
        raise VisualOutputError("付费生图输出路径必须是文件")
    command = [
        str(os.environ.get("AIFIOS_DESKTOP_PYTHON_BINARY") or sys.executable),
        str(PAID_IMAGE_GATEWAY_SCRIPT),
        "--manifest", str(manifest_path),
        "--route-id", route_id,
        "--phase", phase,
        "--prompt-file", str(prompt_path),
        "--output", str(source_path),
        "--aspect-ratio", _aspect_ratio_label(task),
        "--estimated-cost-cny", str(route["estimated_cost_cny"]),
        "--operation-key", f"{task.get('revision_id')}:{task.get('id')}",
        "--ledger-scope", "runtime",
        "--runtime-task-key", f"{task.get('slug')}:{task.get('revision_id')}",
        "--per-call-limit", str(runtime_context["budget_limits"]["per_call_limit"]),
        "--per-task-limit", str(runtime_context["budget_limits"]["per_task_limit"]),
    ]
    try:
        proc = subprocess.run(
            command,
            cwd=str(project),
            env=os.environ.copy(),
            text=True,
            capture_output=True,
            timeout=660,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise VisualOutputError("付费生图网关结果不明，已禁止自动重付费，请人工核账") from exc
    try:
        result = json.loads((proc.stdout or "").strip())
    except json.JSONDecodeError as exc:
        raise VisualOutputError("付费生图网关没有返回可核验的操作记录，禁止自动重试") from exc
    operation = result.get("operation") if isinstance(result, dict) else None
    if proc.returncode != 0 or not result.get("ok"):
        status = operation.get("status") if isinstance(operation, dict) else "unknown"
        retry_allowed = operation.get("retry_allowed") is True if isinstance(operation, dict) else False
        detail = str(result.get("error") or "付费生图失败")[:240] if isinstance(result, dict) else "付费生图失败"
        error = VisualOutputError(f"{detail} [status={status}]")
        setattr(error, "retry_allowed", retry_allowed and status == "failed")
        raise error
    if not isinstance(operation, dict) or operation.get("status") != "succeeded":
        raise VisualOutputError("付费生图成功响应缺少已完成操作记录")
    media_type = _validate_paid_image_file(source_path)
    output_sha256 = hashlib.sha256(source_path.read_bytes()).hexdigest()
    if operation.get("output_sha256") != output_sha256:
        source_path.unlink(missing_ok=True)
        raise VisualOutputError("付费生图输出与操作日志摘要不一致")
    actual_width, actual_height = _normalize_paid_image_to_png(
        project, task, source_path, output_path, render_dir
    )
    generation = {
        "provider_policy": "auto",
        "provider_task": str(task.get("provider_task") or "illustration"),
        "prompt_hash": hashlib.sha256(prompt.encode("utf-8")).hexdigest(),
        "reference_asset_ids": list((task.get("generation") or {}).get("reference_asset_ids") or []),
        "benchmark_id": manifest.get("benchmark_id"),
        "route_source": runtime_context.get("route_source"),
        "account_policy_schema": "echo-founder.image-account-policy.v1",
        "account_role": phase == "retry" and "backup" or "primary",
        "route_id": route_id,
        "model_id": route.get("model_id"),
        "model_version": route.get("model_id"),
        "operation_id": operation.get("operation_id"),
        "request_sha256": operation.get("request_sha256"),
        "estimated_cost_cny": operation.get("estimated_cost_cny"),
        "actual_cost_cny": operation.get("actual_cost_cny"),
        "task_reserved_cny": runtime_context.get("reserved_cny"),
        "output_sha256": output_sha256,
        "human_review_status": "pending",
        "generated_at": operation.get("completed_at"),
    }
    task["generation"] = generation
    extra = _task_output_metadata(task)
    extra.update({
        "ai_generated": True,
        "image_backend": "echo-founder-paid-gateway",
        "renderer_source": "skills/content-runtime/scripts/paid_image_gateway.py",
        "prompt_file": _project_rel(project, prompt_path),
        "ocr_status": "review_required",
        "ocr_text": "",
        "media_type": media_type,
        "source_asset": _project_rel(project, source_path),
        "actual_width": actual_width,
        "actual_height": actual_height,
        "generation": generation,
    })
    return _render_result(task, provider, "local", "PNG", extra)


def _render_paid_with_failover(
    project: Path,
    task: dict[str, Any],
    provider: dict[str, Any],
    render_dir: Path,
    runtime_context: dict[str, Any],
) -> dict[str, Any]:
    manifest_path = runtime_context["manifest_path"]
    manifest = runtime_context["manifest"]
    candidates = runtime_context["routes"]
    primary = str(candidates[0]["route_id"])
    backup = str(candidates[1]["route_id"]) if len(candidates) >= 2 else ""
    try:
        return _render_paid_image_backend(
            project, task, provider, render_dir, manifest_path, manifest, primary, "round_3", runtime_context
        )
    except VisualOutputError as exc:
        if getattr(exc, "retry_allowed", False) is not True or not backup:
            raise
        return _render_paid_image_backend(
            project, task, provider, render_dir, manifest_path, manifest, backup, "retry", runtime_context
        )


def _find_baoyu_image_gen_preferences(project: Path) -> Path:
    home = Path.home()
    xdg_text = str(os.environ.get("XDG_CONFIG_HOME") or "").strip()
    xdg_root = Path(xdg_text).expanduser() if xdg_text else home / ".config"
    candidates = [project / ".baoyu-skills" / "baoyu-image-gen" / "EXTEND.md"]
    if xdg_root.is_absolute():
        candidates.append(xdg_root / "baoyu-skills" / "baoyu-image-gen" / "EXTEND.md")
    candidates.append(home / ".baoyu-skills" / "baoyu-image-gen" / "EXTEND.md")
    for candidate in candidates:
        if candidate.is_file() and not candidate.is_symlink() and candidate.stat().st_size > 0:
            return candidate.resolve()
    raise VisualOutputError(
        "baoyu-image-gen EXTEND.md is required before image generation; configure the project, XDG, or home preference file"
    )


def _baoyu_image_gen_runtime() -> list[str]:
    bun = shutil.which("bun")
    if bun:
        return [bun]
    npx = shutil.which("npx")
    if npx:
        return [npx, "-y", "bun"]
    raise VisualOutputError("baoyu-image-gen requires bun or npx")


def _ai_inline_prompt(task: dict[str, Any]) -> str:
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    page = payload.get("page") if isinstance(payload.get("page"), dict) else {}
    post = payload.get("post") if isinstance(payload.get("post"), dict) else {}
    title = _clean_text(page.get("title") or payload.get("title") or post.get("title") or "正文配图")
    concept = _clean_text(page.get("image_prompt") or payload.get("image_slots") or payload.get("label") or title)
    direction_id = _clean_text(task.get("art_direction_id") or task.get("selected_direction") or "direction-a")
    aspect = _aspect_ratio_label(task)
    if task.get("provider_task") == "comic":
        direction = (
            f"创作一张 {aspect} 单页知识漫画，用 3-4 个清晰分镜表现一个完整的认知转折。"
            "采用克制的黑色线稿与单一强调色，人物动作承担叙事，不做海报或信息图。"
        )
    else:
        direction = (
            f"Generate one standalone {aspect} Chinese editorial illustration. "
            "纯白背景、黑色极简手绘线稿、大量留白；小黑必须参与核心动作，"
            "红色只用于问题或提醒，橙色只用于路径，蓝色只用于补充。"
        )
    return (
        "# Echo Founder 正文视觉生成提示词\n\n"
        f"## 内容\n- 文章主题：{title}\n- 核心画面：{concept}\n\n"
        f"## 视觉方向\n- 方向：{direction_id}\n- 要求：{direction}\n\n"
        "## 非证据边界\n"
        "这是一张概念性配图，不是事实证据。不得虚构数据、引语、产品界面、研究结果或来源标记，"
        "也不得让画面看起来像真实截图或记录。\n\n"
        "## 图中文字\n"
        "不要生成可读文字、数字、Logo 或水印。用动作、构图和图形隐喻表达内容；"
        "所有准确文案由发布排版层另行渲染。\n\n"
        f"## 输出\n只生成一张完整 PNG 图像，画幅 {aspect}，不要边框外说明。\n"
    )


def _aspect_ratio_label(task: dict[str, Any]) -> str:
    width = max(1, int(task.get("width") or 16))
    height = max(1, int(task.get("height") or 9))
    divisor = math.gcd(width, height)
    return f"{width // divisor}:{height // divisor}"


def _validate_ai_backend_png(path: Path, target_width: int, target_height: int) -> tuple[int, int]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
        raise VisualOutputError("baoyu-image-gen did not produce a non-empty PNG file")
    data = path.read_bytes()
    if len(data) < 45 or data[:8] != b"\x89PNG\r\n\x1a\n":
        raise VisualOutputError("baoyu-image-gen output is not a valid PNG")
    offset = 8
    chunk_types: list[bytes] = []
    width = height = 0
    idat_size = 0
    ended = False
    while offset + 12 <= len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        end = offset + 12 + length
        if end > len(data):
            raise VisualOutputError("baoyu-image-gen output has a truncated PNG chunk")
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + length]
        expected_crc = struct.unpack(">I", data[offset + 8 + length:end])[0]
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != expected_crc:
            raise VisualOutputError("baoyu-image-gen output has an invalid PNG checksum")
        chunk_types.append(kind)
        if kind == b"IHDR":
            if len(payload) != 13:
                raise VisualOutputError("baoyu-image-gen output has an invalid PNG header")
            width, height = struct.unpack(">II", payload[:8])
        elif kind == b"IDAT":
            idat_size += len(payload)
        elif kind == b"IEND":
            if length != 0 or end != len(data):
                raise VisualOutputError("baoyu-image-gen output has an invalid PNG terminator")
            ended = True
            break
        offset = end
    if not ended or not chunk_types or chunk_types[0] != b"IHDR" or idat_size <= 0 or width <= 0 or height <= 0:
        raise VisualOutputError("baoyu-image-gen output is not a complete PNG")
    if not _ratio_ok(width, height, target_width, target_height):
        raise VisualOutputError(
            f"baoyu-image-gen output has wrong ratio: got {width}x{height}, expected {target_width}:{target_height}"
        )
    return width, height


def _render_baoyu_image_backend(
    project: Path,
    task: dict[str, Any],
    provider: dict[str, Any],
    render_dir: Path,
) -> dict[str, Any]:
    _backend_dir, script_path = _discover_baoyu_image_gen()
    _find_baoyu_image_gen_preferences(project)
    runtime = _baoyu_image_gen_runtime()
    publish_root = _recipe_publish_root(project, str(task.get("slug") or ""), str(task.get("revision_id") or ""))
    output_path = _project_output(project, task["output"], "AI image output", within=publish_root)
    prompt_name = re.sub(r"[^A-Za-z0-9._-]+", "-", str(task.get("id") or "inline-image")).strip("-")
    prompt_path = render_dir / "prompts" / f"{prompt_name}-{task['provider_task']}.prompt.md"
    if prompt_path.is_symlink():
        raise VisualOutputError("AI image prompt path cannot be a symlink")
    prompt_path.parent.mkdir(parents=True, exist_ok=True)
    prompt_path.write_text(_ai_inline_prompt(task), encoding="utf-8")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.is_symlink() or output_path.is_file():
        output_path.unlink()
    elif output_path.exists():
        raise VisualOutputError("AI image output path must be a file")
    command = [
        *runtime,
        str(script_path),
        "--promptfiles",
        str(prompt_path),
        "--image",
        str(output_path),
        "--ar",
        _aspect_ratio_label(task),
        "--json",
    ]
    try:
        proc = subprocess.run(
            command,
            cwd=str(project),
            env=os.environ.copy(),
            text=True,
            capture_output=True,
            timeout=600,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        if output_path.is_symlink() or output_path.is_file():
            output_path.unlink()
        raise VisualOutputError(f"baoyu-image-gen execution failed: {type(exc).__name__}") from exc
    if proc.returncode != 0:
        if output_path.is_symlink() or output_path.is_file():
            output_path.unlink()
        detail = (proc.stderr or proc.stdout or "unknown backend error").strip().splitlines()[-1][:240]
        raise VisualOutputError(f"baoyu-image-gen failed: {detail}")
    try:
        actual_width, actual_height = _validate_ai_backend_png(
            output_path,
            int(task.get("width") or 16),
            int(task.get("height") or 9),
        )
        resolved_output = output_path.resolve(strict=True)
        resolved_output.relative_to(publish_root.resolve(strict=False))
    except (OSError, ValueError, VisualOutputError) as exc:
        if output_path.is_symlink() or output_path.is_file():
            output_path.unlink()
        if isinstance(exc, VisualOutputError):
            raise
        raise VisualOutputError("baoyu-image-gen output escaped the recipe revision directory") from exc
    extra = _task_output_metadata(task)
    extra.update({
        "ai_generated": True,
        "image_backend": "baoyu-image-gen",
        "renderer_source": "baoyu-image-gen/scripts/main.ts",
        "prompt_file": _project_rel(project, prompt_path),
        "ocr_status": "review_required",
        "ocr_text": "",
        "actual_width": actual_width,
        "actual_height": actual_height,
    })
    return _render_result(task, provider, "local", "PNG", extra)


def _render_baoyu_diagram(
    project: Path,
    task: dict[str, Any],
    provider: dict[str, Any],
    render_dir: Path,
) -> dict[str, Any]:
    evidence_sources = list(task.get("evidence_sources") or [])
    if not evidence_sources:
        raise VisualOutputError("baoyu-diagram requires a source-backed evidence asset")
    source_path = _project_source(project, evidence_sources[0], "diagram evidence")
    items = _diagram_evidence_items(source_path)
    publish_root = _recipe_publish_root(project, str(task.get("slug") or ""), str(task.get("revision_id") or ""))
    output_path = _project_output(project, task["output"], "diagram output", within=publish_root)
    svg_path = output_path.with_suffix(".svg")
    svg_path.parent.mkdir(parents=True, exist_ok=True)
    title = _clean_text((task.get("payload") or {}).get("title") or "证据结构图")[:34]
    palette = [
        ("rgba(8,51,68,0.78)", "#22d3ee"),
        ("rgba(6,78,59,0.78)", "#34d399"),
        ("rgba(76,29,149,0.78)", "#a78bfa"),
        ("rgba(120,53,15,0.72)", "#fbbf24"),
    ]
    nodes = []
    connectors = []
    for index, (label, value) in enumerate(items):
        x = 95 + index * 370
        fill, stroke = palette[index % len(palette)]
        primary_value, supporting_value = _diagram_value_lines(value)
        if index:
            connectors.append(
                f'<path d="M {x - 70} 430 L {x - 10} 430" stroke="#64748b" stroke-width="3" marker-end="url(#arrow)"/>'
            )
        nodes.append(
            f'<g><rect x="{x}" y="300" width="300" height="260" rx="10" fill="#0f172a"/>'
            f'<rect x="{x}" y="300" width="300" height="260" rx="10" fill="{fill}" stroke="{stroke}" stroke-width="3"/>'
            f'<text x="{x + 28}" y="354" fill="{stroke}" font-size="21" font-weight="700">{html.escape(label)}</text>'
            f'<text x="{x + 28}" y="410" fill="#f8fafc" font-size="24" font-weight="600">{html.escape(primary_value)}</text>'
            f'<text x="{x + 28}" y="452" fill="#cbd5e1" font-size="18">{html.escape(supporting_value)}</text>'
            f'<text x="{x + 28}" y="520" fill="#94a3b8" font-size="16">要点 {index + 1:02d}</text></g>'
        )
    svg_path.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 900">'
        '<defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">'
        '<path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" stroke-width="1"/></pattern>'
        '<marker id="arrow" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto">'
        '<polygon points="0 0,10 3.5,0 7" fill="#64748b"/></marker></defs>'
        '<rect width="1600" height="900" fill="#0f172a"/><rect width="1600" height="900" fill="url(#grid)"/>'
        '<style>text{font-family:"Noto Sans SC","PingFang SC","JetBrains Mono",sans-serif;letter-spacing:0}</style>'
        f'<text x="95" y="118" fill="#f8fafc" font-size="52" font-weight="700">{html.escape(title)}</text>'
        '<text x="95" y="168" fill="#94a3b8" font-size="18">资料整理</text>'
        + "".join(connectors)
        + "".join(nodes)
        + '<line x1="95" y1="700" x2="1505" y2="700" stroke="#334155" stroke-width="2"/>'
        + '<text x="95" y="758" fill="#cbd5e1" font-size="20">资料摘录</text>'
        + '<text x="1505" y="758" fill="#22d3ee" font-size="18" text-anchor="end">关键数据</text>'
        + '</svg>',
        encoding="utf-8",
    )
    html_path = render_dir / f"diagram-{task['id']}.html"
    html_path.write_text(
        '<!doctype html><html><head><meta charset="utf-8"><style>'
        'html,body{margin:0;background:#0f172a}section{width:1600px;height:900px;overflow:hidden}'
        'img{display:block;width:1600px;height:900px;object-fit:contain}</style></head><body>'
        f'<section id="{html.escape(task["id"], quote=True)}"><img src="{svg_path.resolve().as_uri()}" alt="diagram"></section>'
        '</body></html>',
        encoding="utf-8",
    )
    spec_path = render_dir / f"screenshot-diagram-{task['id']}.json"
    metrics_path = render_dir / f"screenshot-diagram-{task['id']}.metrics.json"
    spec_path.write_text(
        json.dumps(
            {
                "html": str(html_path),
                "metrics": str(metrics_path),
                "targets": [{"id": task["id"], "output": str(output_path)}],
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    proc = _run_visual_node_script(
        VISUAL_SCREENSHOT_SCRIPT,
        [str(spec_path)],
        cwd=REPO_ROOT,
        purpose="baoyu-diagram 截图渲染",
    )
    if proc.returncode != 0:
        raise VisualOutputError(f"baoyu-diagram screenshot failed: {proc.stderr.strip() or proc.stdout.strip()}")
    task["evidence_ratio"] = _read_screenshot_evidence_ratios(metrics_path, [task["id"]])[task["id"]]
    extra = _task_output_metadata(task)
    extra.update({
        "renderer_source": "skills/baoyu-diagram/SKILL.md",
        "source_svg": _project_rel(project, svg_path),
        "render_html": _project_rel(project, html_path),
    })
    return _render_result(task, provider, "local", "PNG", extra)


def _inline_assets_for_article(project: Path, article_output: Path, tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    bindings: list[dict[str, Any]] = []
    for task in tasks:
        if task.get("kind") != "inline_image":
            continue
        candidate = _project_output(project, str(task["output"]), "inline article asset")
        if not candidate.is_file() or candidate.stat().st_size <= 0:
            continue
        relative_src = os.path.relpath(candidate, start=article_output.parent).replace(os.sep, "/")
        bindings.append({
            "id": str(task.get("id") or "inline"),
            "src": relative_src,
            "insert_after": str(task.get("insert_after") or ""),
            "caption": str(task.get("caption") or task.get("payload", {}).get("label") or "正文图解"),
            "order": int(task.get("inline_order") or 999),
        })
    return sorted(bindings, key=lambda item: (item["order"], item["id"]))


def _render_wechat_layout_package(
    project: Path,
    task: dict[str, Any],
    publish_root: Path,
    inline_assets: list[dict[str, Any]],
) -> dict[str, Any]:
    """Render one selected WeChat layout with a bundled offline fallback."""
    payload = task.get("payload") if isinstance(task.get("payload"), dict) else {}
    selection = payload.get("layout_selection") if isinstance(payload.get("layout_selection"), dict) else {}
    selected = _clean_text(task.get("layout_style") or selection.get("selected") or "").lower()
    if not MD2WECHAT_THEME_RE.fullmatch(selected):
        selected = "wechat-native"
    article_output = _project_output(project, str(task["output"]), "publish output", within=publish_root)
    renderer_source = "md2wechat-cli"
    renderer_theme = LEGACY_MD2WECHAT_THEME_ALIASES.get(selected, selected)
    fallback_reason = ""
    refinement_metadata: dict[str, Any] = {}
    layout = payload.get("wechat_layout")
    layout_arguments: dict[str, Any] = {}
    if layout is not None:
        from wechat_layout_refinement import validate_refinement_source

        source_file = _project_source(project, task.get("source"), "source package")
        source_digest = hashlib.sha256(source_file.read_bytes()).hexdigest()
        errors = validate_refinement_source(
            str(payload.get("title") or ""), str(payload.get("body") or ""), layout, source_digest,
        )
        if errors:
            raise VisualOutputError("; ".join(errors))
        if layout.get("theme") != renderer_theme:
            raise VisualOutputError("排版参数中的主题与所选主题不一致。")
        layout_arguments = {"wechat_layout": layout, "source_package_sha256": source_digest}
    try:
        render_info = _render_md2wechat_html(
            article_output,
            str(payload.get("title") or ""),
            str(payload.get("body") or ""),
            selected,
            project=project,
            task=task,
            **layout_arguments,
        )
        renderer_source = render_info["renderer_source"]
        renderer_theme = render_info["renderer_theme"]
        refinement_metadata = {
            key: render_info[key]
            for key in ("base_renderer", "base_theme", "local_refinements", "raw_html_sha256", "raw_html_path", "output_is_raw_api_result")
            if key in render_info
        }
        if inline_assets:
            rendered = article_output.read_text(encoding="utf-8")
            article_output.write_text(
                _inject_inline_assets(rendered, inline_assets),
                encoding="utf-8",
            )
    except (OSError, subprocess.SubprocessError, VisualOutputError) as exc:
        if layout is not None:
            raise VisualOutputError("指定排版未完成，已保留原成品；请检查排版服务或重新核对排版参数。") from exc
        # Layout must remain usable offline and in a packaged App that does
        # not have the optional global CLI. Do not expose CLI diagnostics or
        # credentials in the customer-facing manifest.
        _render_html(
            article_output,
            str(payload.get("title") or ""),
            str(payload.get("body") or ""),
            str(task.get("visual_system") or "swiss"),
            # The fallback intentionally has one basic style. It is not a
            # second product theme catalog and never competes with md2wechat.
            "minimal",
            inline_assets,
        )
        renderer_source = "skills/dbs-wechat-html/generate_preview.py"
        renderer_theme = "echo-basic"
        fallback_reason = "md2wechat 当前不可用，已使用单一基础排版；文章内容与发布流程不受影响。"
    rendered_options: list[dict[str, Any]] = [{
        "style": selected,
        "renderer_theme": renderer_theme,
        "path": _project_rel(project, article_output),
        "selected": True,
    }]
    options_path = _project_output(
        project,
        str(article_output.parent.relative_to(project) / "layout-options.json"),
        "wechat layout options",
        within=publish_root,
    )
    options_path.parent.mkdir(parents=True, exist_ok=True)
    options_path.write_text(
        json.dumps(
            {
                "schema": "aifios.wechat-layout-options.v1",
                "selected": selected,
                "reason": str(selection.get("reason") or "根据文章题材自动选择"),
                "hint": str(selection.get("hint") or ""),
                "renderer": renderer_source,
                "renderer_theme": renderer_theme,
                "fallback_reason": fallback_reason,
                **refinement_metadata,
                "options": rendered_options,
                "inline_assets": [
                    {key: item[key] for key in ("id", "src", "insert_after", "caption")}
                    for item in inline_assets
                ],
            },
            ensure_ascii=False,
            indent=2,
        ) + "\n",
        encoding="utf-8",
    )
    return {
        "selected": selected,
        "renderer_source": renderer_source,
        "renderer_theme": renderer_theme,
        "fallback_reason": fallback_reason,
        "options": rendered_options,
        "options_path": _project_rel(project, options_path),
        "inline_assets": inline_assets,
        **refinement_metadata,
    }


def _apply_ai_visual_layers(
    project: Path,
    tasks: list[dict[str, Any]],
    registry: list[dict[str, Any]],
    render_dir: Path,
) -> tuple[str, list[str], dict[str, Any] | None]:
    """Enforce the stable-only product contract before any backend is resolved."""
    del project, registry, render_dir
    if any(task.get("visual_mode") not in (None, "stable") for task in tasks):
        raise VisualOutputError(AI_IMAGE_DISABLED_MESSAGE)
    return "stable", [], None


def _render_local_outputs(
    project: Path,
    slug: str,
    tasks: list[dict[str, Any]],
    registry: list[dict[str, Any]],
    revision_id: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    if any(
        task.get("requested_renderer") in DISABLED_AI_VISUAL_RENDERERS
        or task.get("provider_task") in {"comic", "illustration"}
        for task in tasks
    ):
        raise VisualOutputError(AI_IMAGE_DISABLED_MESSAGE)
    for template_path in (XHS_TEMPLATE_PATH, EDITORIAL_TEMPLATE_PATH):
        if not template_path.exists():
            raise VisualOutputError(f"missing xhs-card template: {template_path}")
    if not VISUAL_SCREENSHOT_SCRIPT.exists():
        raise VisualOutputError(f"missing screenshot helper: {VISUAL_SCREENSHOT_SCRIPT}")
    if not revision_id:
        raise VisualOutputError("local recipe rendering requires revision_id")
    publish_root = _recipe_publish_root(project, slug, revision_id)
    render_rel = f"pipeline/visual/{slug}/publish/{revision_id}/render"
    render_dir = _project_output(project, render_rel, "render directory", within=publish_root)
    prepared_tasks = [
        _prepare_render_task(project, task) if task.get("evidence_sources") else task
        for task in tasks
    ]
    render_dir.mkdir(parents=True, exist_ok=True)
    effective_visual_mode, fallback_notes, _paid_runtime_context_unused = _apply_ai_visual_layers(
        project, prepared_tasks, registry, render_dir
    )
    outputs: list[dict[str, Any]] = []
    png_task_records: dict[str, list[tuple[dict[str, Any], dict[str, Any]]]] = {}
    wechat_html_records: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for task in prepared_tasks:
        provider = choose_provider(registry, task["provider_task"])
        if task["kind"] == "wechat_html":
            wechat_html_records.append((task, provider))
            continue
        if task["provider_task"] == "diagram":
            outputs.append(_render_baoyu_diagram(project, task, provider, render_dir))
            continue
        style = "editorial" if _template_path_for_task(task) == EDITORIAL_TEMPLATE_PATH else "swiss"
        png_task_records.setdefault(style, []).append((task, provider))

    deck_paths: dict[str, Path] = {}
    for style, records in png_task_records.items():
        template_path = EDITORIAL_TEMPLATE_PATH if style == "editorial" else XHS_TEMPLATE_PATH
        deck_path = render_dir / f"{style}.html"
        deck_path.write_text(_build_local_deck_html([task for task, _provider in records], template_path), encoding="utf-8")
        deck_paths[style] = deck_path
        if not (render_dir / "index.html").exists():
            (render_dir / "index.html").write_text(deck_path.read_text(encoding="utf-8"), encoding="utf-8")
        spec_path = render_dir / f"screenshot-{style}.json"
        metrics_path = render_dir / f"screenshot-{style}.metrics.json"
        spec_path.write_text(
            json.dumps(
                {
                    "html": str(deck_path),
                    "metrics": str(metrics_path),
                    "targets": [
                        {
                            "id": task["id"],
                            **({"expectedCopy": task["expected_copy"]} if task.get("native_copy") else {}),
                            "output": str(
                                _project_output(project, task["output"], "publish output", within=publish_root)
                            ),
                        }
                        for task, _provider in records
                    ],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        proc = _run_visual_node_script(
            VISUAL_SCREENSHOT_SCRIPT,
            [str(spec_path)],
            cwd=REPO_ROOT,
            purpose="xhs-card 截图渲染",
        )
        if proc.returncode != 0:
            raise VisualOutputError(f"xhs-card screenshot failed: {proc.stderr.strip() or proc.stdout.strip()}")
        ratios = _read_screenshot_evidence_ratios(metrics_path, [task["id"] for task, _provider in records])
        details = _read_screenshot_evidence_details(metrics_path, [task["id"] for task, _provider in records])
        measurements = json.loads(metrics_path.read_text(encoding="utf-8"))["targets"]
        renderer_source = f"xhs-card/{template_path.name}"
        for task, provider in records:
            task["evidence_ratio"] = ratios[task["id"]]
            if details[task["id"]] is not None:
                task["evidence_detail_score"] = details[task["id"]]
            extra = _task_output_metadata(task)
            if task.get("native_copy"):
                measurement = measurements.get(task["id"], {})
                layout = measurement.get("native_layout", {})
                if layout.get("status") != "pass" or measurement.get("copy_fidelity", {}).get("status") != "pass":
                    raise VisualOutputError(f"小红书 {task['id']} 缺少完整文字与排版检查，请重新排版。")
                extra["native_layout"] = layout
                extra["copy_fidelity"] = measurement["copy_fidelity"]
            extra.update({"renderer_source": renderer_source, "render_html": _project_rel(project, deck_path)})
            outputs.append(
                _render_result(
                    task,
                    provider,
                    "local",
                    "PNG",
                    extra,
                )
            )
    for task, provider in wechat_html_records:
        article_output = _project_output(project, task["output"], "publish output", within=publish_root)
        inline_assets = _inline_assets_for_article(project, article_output, prepared_tasks)
        layout_package = _render_wechat_layout_package(project, task, publish_root, inline_assets)
        extra = _task_output_metadata(task)
        extra.update({
            "renderer_source": layout_package["renderer_source"],
            "renderer_theme": layout_package["renderer_theme"],
            "layout_fallback_reason": layout_package["fallback_reason"],
            "layout_style": layout_package["selected"],
            "layout_options": layout_package["options"],
            "layout_options_path": layout_package["options_path"],
            "inline_assets": layout_package["inline_assets"],
        })
        extra.update({
            key: layout_package[key]
            for key in ("base_renderer", "base_theme", "local_refinements", "raw_html_sha256", "raw_html_path", "output_is_raw_api_result")
            if key in layout_package
        })
        outputs.append(_render_result(task, provider, "local", "HTML", extra))
    quality = _run_local_aesthetic_gate(render_dir, deck_paths)
    quality["effective_visual_mode"] = effective_visual_mode
    if fallback_notes:
        quality["visual_fallback_notes"] = fallback_notes
    ai_outputs = [output["id"] for output in outputs if output.get("ai_generated")]
    if ai_outputs:
        quality["aesthetic_status"] = "review_required"
        quality.setdefault("aesthetic_notes", []).append(
            "AI raster OCR review required: " + ", ".join(ai_outputs)
        )
    return outputs, quality


def _reject_ai_image_generation(
    *,
    visual_preferences: dict[str, Any] | None = None,
    recipe: dict[str, Any] | None = None,
) -> None:
    """Fail before rendering whenever a request could invoke an image backend."""
    requested_mode = (
        visual_preferences.get("mode")
        if isinstance(visual_preferences, dict)
        else None
    )
    if requested_mode not in (None, "stable"):
        raise VisualOutputError(AI_IMAGE_DISABLED_MESSAGE)
    if not isinstance(recipe, dict):
        return
    recipe_preferences = recipe.get("visual_preferences")
    recipe_mode = (
        recipe_preferences.get("mode")
        if isinstance(recipe_preferences, dict)
        else None
    )
    if recipe_mode not in (None, "stable"):
        raise VisualOutputError(AI_IMAGE_DISABLED_MESSAGE)
    disabled_assets = [
        str(asset.get("id") or "<unknown>")
        for asset in recipe.get("assets", [])
        if isinstance(asset, dict)
        and asset.get("renderer") in DISABLED_AI_VISUAL_RENDERERS
    ]
    if disabled_assets:
        raise VisualOutputError(
            f"{AI_IMAGE_DISABLED_MESSAGE}; disabled recipe assets: {', '.join(disabled_assets)}"
        )


def generate_publish_outputs(
    project: Path | str,
    slug: str,
    package_path: Path | str | None = None,
    recipe_path: Path | str | None = None,
    renderer: str = "local",
    write_runtime_record: bool = True,
    publish_current_index: bool = True,
    selected_template: str | None = None,
    visual_preferences: dict[str, Any] | None = None,
    selected_direction: str = "direction-a",
    preview_only: bool = False,
    force_new_revision: bool = False,
) -> dict[str, Any]:
    project_path = Path(project).expanduser().resolve(strict=False)
    _validate_visual_slug(slug)
    _reject_ai_image_generation(visual_preferences=visual_preferences)
    package_candidate = package_path if package_path is not None else _latest_package_path(project_path, slug)
    package_file = _project_input_file(project_path, package_candidate, "source package")
    body = package_file.read_text(encoding="utf-8")
    if body.startswith("---"):
        body = body.split("---", 2)[-1].strip()
    parsed = parse_package_body(body)
    package_rel = _project_rel(project_path, package_file)
    registry = load_provider_registry()
    from visual_director import VisualDirectorError, validate_visual_recipe

    if recipe_path:
        if force_new_revision:
            raise VisualOutputError("重新排版不能同时指定旧配方。")
        recipe_file = _visual_recipe_input_file(project_path, slug, recipe_path)
        try:
            recipe = json.loads(recipe_file.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise VisualOutputError(f"visual recipe is not valid JSON: {recipe_file}") from exc
    else:
        try:
            recipe_file, recipe = _load_or_build_default_recipe(
                project_path,
                slug,
                parsed,
                package_rel,
                selected_template=selected_template,
                visual_preferences=visual_preferences,
                selected_direction=selected_direction,
                force_new_revision=force_new_revision,
            )
        except VisualDirectorError as exc:
            raise VisualOutputError(f"visual recipe blocked: {exc}") from exc

    recipe_errors = validate_visual_recipe(recipe)
    if recipe_errors:
        raise VisualOutputError("invalid visual recipe: " + "; ".join(recipe_errors))
    _reject_ai_image_generation(recipe=recipe)
    if recipe.get("slug") != slug:
        raise VisualOutputError("visual recipe slug does not match the requested slug")
    revision_id = str(recipe["revision_id"])
    _validate_recipe_file_location(project_path, slug, revision_id, recipe_file)
    is_staged_candidate = (
        not publish_current_index
        and recipe_file.parent == _visual_root(project_path, slug) / "revisions"
        and _PENDING_RECIPE_RE.fullmatch(recipe_file.name) is not None
    )
    selected_result = _selected_immutable_result(
        project_path,
        slug,
        revision_id,
        allow_revision_candidate=is_staged_candidate,
    )
    if selected_result is not None:
        return selected_result
    recipe_rel = _project_rel(project_path, recipe_file)
    recipe["recipe_path"] = recipe_rel
    tasks = build_visual_tasks_from_recipe(parsed, recipe, slug=slug, package_rel=package_rel)
    _validate_recipe_tasks(project_path, slug, revision_id, recipe_rel, tasks)
    if preview_only:
        return {
            "status": "direction_preview",
            "slug": slug,
            "recipe_path": str(recipe_file),
            "revision_id": revision_id,
            "visual_preferences": recipe.get("visual_preferences"),
            "art_directions": recipe.get("art_directions") or [],
            "selected_direction": None,
            "outputs": [],
        }
    recipe_metadata: dict[str, Any] = {
        "recipe_schema": recipe.get("schema"),
        "recipe_path": recipe_rel,
        "revision_id": revision_id,
        "parent_revision_id": recipe.get("parent_revision_id"),
        "visual_system": recipe.get("platforms", {}).get("xhs", {}).get("system"),
        "quality_policy": recipe.get("quality_policy"),
        "recipe_assets": recipe.get("assets"),
        "platforms": recipe.get("platforms"),
        "content_archetype": recipe.get("content_archetype"),
        "evidence_mode": recipe.get("evidence_mode"),
        "source_assets": recipe.get("source_assets"),
        "brand_profile": recipe.get("brand_profile"),
        "brand_system": recipe.get("brand_system"),
        "golden_sample_standard": recipe.get("golden_sample_standard"),
        "visual_preferences": recipe.get("visual_preferences"),
        "art_directions": recipe.get("art_directions"),
        "selected_direction": recipe.get("selected_direction"),
        "generation_policy": recipe.get("generation_policy"),
        "legacy": False,
    }
    outputs: list[dict[str, Any]] = []
    quality: dict[str, Any] = {
        "aesthetic_status": "not_checked",
        "quality_tools": [],
        "platform_gap_checks": ["小红书独立图文 1080x1440（P1-P8）", "公众号 md2wechat 完整 HTML 排版", "视频号不进入静态视觉生产"],
    }
    try:
        if renderer == "local":
            outputs, quality = _render_local_outputs(
                project_path,
                slug,
                tasks,
                registry,
                revision_id=str(recipe_metadata.get("revision_id") or "") or None,
            )
        else:
            for task in tasks:
                provider = choose_provider(registry, task["provider_task"])
                outputs.append(_render_task(project_path, task, provider, renderer))
        _bind_output_integrity(project_path, outputs)
        for output in outputs:
            if (output.get("kind") == "wechat_html" or output.get("id") == "wechat-html") and output.get("renderer") == "local":
                output["wechat_fidelity"] = _check_wechat_output(
                    project_path, {"source_package": package_rel, "recipe_path": recipe_rel}, output,
                )
        recipe_metadata["platform_delivery_manifest"] = _write_platform_delivery_manifest(
            project_path,
            slug,
            revision_id,
            package_rel,
            parsed,
            outputs,
            recipe,
        )
        index_path = _write_index(
            project_path,
            slug,
            package_rel,
            outputs,
            "generated",
            quality=quality,
            metadata=recipe_metadata,
            publish_current_index=publish_current_index,
        )
        index = json.loads(index_path.read_text(encoding="utf-8"))
        if recipe:
            from visual_quality import audit_rendered_visual_index, audit_visual_golden_sample

            quality_summary = audit_rendered_visual_index(index, str(index.get("render_quality_report") or ""))
            golden_sample_readiness = audit_visual_golden_sample({
                **index,
                **recipe_metadata,
                "quality_summary": quality_summary,
            })
            recipe_metadata = {
                **recipe_metadata,
                "quality_summary": quality_summary,
                "golden_sample_readiness": golden_sample_readiness,
            }
            index_path = _write_index(
                project_path,
                slug,
                package_rel,
                outputs,
                "generated",
                quality=quality,
                metadata=recipe_metadata,
                publish_current_index=publish_current_index,
            )
            index = json.loads(index_path.read_text(encoding="utf-8"))
        check = check_visual_outputs(project_path, index)
        if check["status"] != "pass":
            _write_index(
                project_path,
                slug,
                package_rel,
                outputs,
                "failed",
                check["errors"],
                quality=quality,
                metadata=recipe_metadata,
                publish_current_index=publish_current_index,
            )
            raise VisualOutputError("; ".join(check["errors"]))
        visual_record = None
        if write_runtime_record:
            from content_runtime import ContentRuntime

            index_rel = _project_rel(project_path, index_path)
            record_body = build_visual_record_body(slug, parsed["title"], package_rel, index_rel, outputs)
            visual_record = ContentRuntime(project_path).write(
                "visual",
                slug,
                record_body,
                source=f"visual-publish:{package_rel}",
            )
        return {
            "status": "generated",
            "slug": slug,
            "index_path": str(index_path),
            "outputs": outputs,
            "quality_summary": index.get("quality_summary"),
            "visual_record": visual_record,
        }
    except Exception as exc:
        index_path = _write_index(
            project_path,
            slug,
            package_rel,
            outputs,
            "failed",
            [str(exc)],
            quality=quality,
            metadata=recipe_metadata,
            publish_current_index=publish_current_index,
        )
        raise VisualOutputError(f"visual publish failed; index={index_path}: {exc}") from exc


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    if path.is_symlink():
        raise VisualOutputError(f"refusing to replace symlinked JSON record: {path.name}")
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        if temporary.exists() or temporary.is_symlink():
            temporary.unlink()
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        if temporary.exists() or temporary.is_symlink():
            temporary.unlink()


def record_ai_raster_human_review(
    project: Path | str,
    slug: str,
    revision_id: str,
    asset_id: str,
    output_sha256: str,
    *,
    confirm_no_text: bool,
    confirm_concept_boundary: bool,
) -> dict[str, Any]:
    """Reject mutations of historical AI artifacts, which remain read-only."""
    del (
        project,
        slug,
        revision_id,
        asset_id,
        output_sha256,
        confirm_no_text,
        confirm_concept_boundary,
    )
    raise VisualOutputError(
        "AI image review is disabled; historical AI visual artifacts are read-only"
    )


def _latest_package_path(project: Path, slug: str) -> Path:
    state_path = project / "sessions" / "latest.json"
    state = json.loads(state_path.read_text(encoding="utf-8"))
    rel = state.get("latest_by_slug", {}).get(slug, {}).get("package")
    if not rel:
        raise VisualOutputError(f"no latest package for slug: {slug}")
    return project / rel


def main(argv: list[str] | None = None) -> int:
    import argparse
    import sys

    parser = argparse.ArgumentParser(description="Generate and review Echo Founder visual publish outputs")
    parser.add_argument("--project", required=True)
    sub = parser.add_subparsers(dest="command", required=True)
    verify = sub.add_parser("verify", help="Read and recheck an existing revision; does not render or call services")
    verify.add_argument("--slug", required=True)
    verify.add_argument("--revision", required=True)
    gen = sub.add_parser("generate")
    gen.add_argument("--slug", required=True)
    gen.add_argument("--package")
    gen.add_argument("--recipe")
    gen.add_argument("--renderer", default="local", choices=["fake", "local"])
    gen.add_argument("--layout-style", default=None)
    gen.add_argument(
        "--visual-mode",
        default="stable",
        choices=["stable"],
        help="stable local layout only; AI image generation is disabled",
    )
    gen.add_argument("--direction-count", type=int, default=2, choices=[2])
    gen.add_argument("--provider-policy", default="auto", choices=["auto"])
    gen.add_argument("--selected-direction", default="direction-a", choices=["direction-a", "direction-b"])
    gen.add_argument("--preview-only", action="store_true")
    gen.add_argument("--new-revision", action="store_true", help="build a new candidate without replacing existing revisions")
    review = sub.add_parser(
        "review-ai-raster",
        help="disabled compatibility command; historical AI visual artifacts are read-only",
    )
    review.add_argument("--slug", required=True, help="visual slug")
    review.add_argument("--revision", required=True, help="candidate revision id, for example r001")
    review.add_argument("--asset", required=True, help="AI raster asset id")
    review.add_argument("--output-sha256", required=True, help="current output SHA-256 from the revision index")
    review.add_argument(
        "--confirm-no-text",
        action="store_true",
        help="confirm by visual inspection that the image contains no readable text, numbers, logo, or watermark",
    )
    review.add_argument(
        "--confirm-concept-boundary",
        action="store_true",
        help="confirm the image is conceptual and does not impersonate evidence, UI, quotes, data, or research",
    )
    args = parser.parse_args(argv)

    project = Path(args.project).expanduser().resolve(strict=False)
    if args.command == "verify":
        try:
            _validate_visual_slug(args.slug)
            if not _REVISION_ID_RE.fullmatch(args.revision):
                raise VisualOutputError("invalid revision id")
            index_path = _project_source(project, f"pipeline/visual/{args.slug}/revisions/{args.revision}.index.json", "visual revision index")
            index = json.loads(index_path.read_text(encoding="utf-8"))
            if not isinstance(index, dict) or index.get("slug") != args.slug or index.get("revision_id") != args.revision:
                raise VisualOutputError("visual revision identity mismatch")
            if not isinstance(index.get("outputs"), list) or not any(
                isinstance(item, dict) and (item.get("kind") == "wechat_html" or item.get("id") == "wechat-html")
                and item.get("renderer") == "local" for item in index["outputs"]
            ):
                raise VisualOutputError("revision has no local WeChat article to verify")
            result = check_visual_outputs(project, index)
        except (OSError, ValueError, VisualPublishError) as exc:
            result = {"status": "failed", "errors": [str(exc)]}
        print(json.dumps(result, ensure_ascii=False))
        return 0 if result["status"] == "pass" else 1
    if args.command == "generate":
        package = Path(args.package).expanduser().resolve(strict=False) if args.package else _latest_package_path(project, args.slug)
        recipe = Path(args.recipe).expanduser().resolve(strict=False) if args.recipe else None
        try:
            result = generate_publish_outputs(
                project,
                args.slug,
                package,
                recipe_path=recipe,
                renderer=args.renderer,
                write_runtime_record=True,
                selected_template=args.layout_style,
                visual_preferences={
                    "mode": args.visual_mode,
                    "direction_count": args.direction_count,
                    "provider_policy": args.provider_policy,
                },
                selected_direction=args.selected_direction,
                preview_only=args.preview_only,
                force_new_revision=args.new_revision,
            )
        except VisualPublishError as exc:
            print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    if args.command == "review-ai-raster":
        try:
            result = record_ai_raster_human_review(
                project,
                args.slug,
                args.revision,
                args.asset,
                args.output_sha256,
                confirm_no_text=args.confirm_no_text,
                confirm_concept_boundary=args.confirm_concept_boundary,
            )
        except VisualPublishError as exc:
            print(json.dumps({"status": "failed", "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
