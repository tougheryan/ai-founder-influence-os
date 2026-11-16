#!/usr/bin/env python3
"""Migrate only verified final-publication history into local records.

This is intentionally a one-way, local-only compatibility importer.  It reads
legacy run files, publication evidence, adopted visual selections and normalized
performance inputs, then writes self-contained history records under
``materials/publication/history``.  It never copies drafts, planning reports,
chat state, raw performance snapshots or obsolete internal reports.

Run a dry run first:

    python3 scripts/migrate_final_publication_history.py --project ~/ai-content-system --dry-run

Apply only after reviewing the emitted manifest:

    python3 scripts/migrate_final_publication_history.py --project ~/ai-content-system --apply
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable
from urllib.parse import urlparse


SCHEMA = "aifios.final-publication-history-migration.v1"
HISTORY_SCHEMA = "aifios.final-publication-history.v1"
HISTORY_ROOT = PurePosixPath("materials/publication/history")
DEFAULT_MANIFEST = PurePosixPath("materials/publication/migrations/final-publication-history-manifest.json")

FINAL_CONTENT_ROOTS = (
    "pipeline/final/",
    "pipeline/package/",
    "pipeline/xhs/",
    "pipeline/platform-adapt/",
)
EXCLUDED_PREFIXES = (
    "pipeline/drafts/",
    "pipeline/angles/",
    "pipeline/breakdown/",
    "pipeline/intake/",
    "pipeline/validate/",
    "pipeline/prelaunch/",
    "pipeline/compliance/",
    "pipeline/audit/",
    "pipeline/review/",
    "pipeline/archive/",
    "pipeline/twin/",
    "sessions/",
    "materials/performance/raw/",
    "materials/performance/review-inputs/",
)
PERFORMANCE_ROOTS = ("pipeline/performance/", "materials/performance/")
VISUAL_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".html"}
CONTENT_EXTENSIONS = {".md", ".markdown", ".html", ".txt", ".json"}
PLACEHOLDER_HOSTS = {"example.com", "www.example.com", "localhost", "127.0.0.1", "0.0.0.0"}
SENSITIVE_KEY_RE = re.compile(r"(?:secret|token|cookie|password|api[_-]?key|credential|user[_-]?id|phone|mobile|email)", re.IGNORECASE)
URL_RE = re.compile(r'''https?://[^\s<>\]\[\)\}"']+''', re.IGNORECASE)
LOCAL_PATH_RE = re.compile(
    r'''pipeline/(?:final|package|xhs|platform-adapt)/[^\s`<>\]\[\)\}"']+?\.(?:md|markdown|html|txt|json)''',
    re.IGNORECASE,
)
METRIC_LINE_RE = re.compile(r"^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|", re.MULTILINE)


class MigrationError(RuntimeError):
    """Raised when a requested migration is unsafe or ambiguous."""


@dataclass(frozen=True)
class SourceArtifact:
    relative_path: str
    path: Path
    sha256: str


@dataclass
class PublicationEntry:
    url: str
    platform: str = ""
    published_at: str = ""
    final_content_hash: str = ""
    external_item_id: str = ""

    def as_dict(self) -> dict[str, str]:
        return {
            key: value
            for key, value in {
                "url": self.url,
                "platform": self.platform,
                "published_at": self.published_at,
                "final_content_hash": self.final_content_hash,
                "external_item_id": self.external_item_id,
            }.items()
            if value
        }


@dataclass
class HistoryCandidate:
    record_id: str
    run_id: str
    slug: str
    topic: str = ""
    run_source: SourceArtifact | None = None
    publication_sources: list[SourceArtifact] = field(default_factory=list)
    publication_entries: list[PublicationEntry] = field(default_factory=list)
    content_paths: set[str] = field(default_factory=set)
    fallback_content_paths: set[str] = field(default_factory=set)
    visual_manifest_paths: set[str] = field(default_factory=set)
    ledger_asset_paths: dict[str, dict[str, str]] = field(default_factory=dict)
    performance_sources: list[SourceArtifact] = field(default_factory=list)


@dataclass
class MigrationOperation:
    source: str
    source_paths: list[str]
    source_sha256: str
    destination: str
    record_type: str
    payload: bytes
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def destination_sha256(self) -> str:
        return sha256_bytes(self.payload)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical_json_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def safe_identifier(value: Any, fallback: str) -> str:
    text = str(value or "").strip().lower()
    text = re.sub(r"[^a-z0-9_\-\u4e00-\u9fff]+", "-", text)
    text = re.sub(r"-{2,}", "-", text).strip("-_")[:80]
    return text or fallback


def is_safe_relative_path(value: Any) -> bool:
    if not isinstance(value, str) or not value or value.startswith(("/", "\\")) or "\\" in value or "\x00" in value:
        return False
    try:
        path = PurePosixPath(value)
    except TypeError:
        return False
    return not any(part in {"", ".", ".."} for part in path.parts)


def project_relative(project: Path, target: Path) -> str:
    try:
        relative = target.relative_to(project)
    except ValueError as exc:
        raise MigrationError("source is outside the project") from exc
    return relative.as_posix()


def source_from_relative(project: Path, relative_path: str) -> SourceArtifact | None:
    if not is_safe_relative_path(relative_path):
        return None
    target = project.joinpath(*PurePosixPath(relative_path).parts)
    try:
        resolved_project = project.resolve(strict=True)
        resolved_target = target.resolve(strict=True)
    except OSError:
        return None
    try:
        resolved_target.relative_to(resolved_project)
    except ValueError:
        return None
    if target.is_symlink() or not target.is_file():
        return None
    try:
        data = target.read_bytes()
    except OSError:
        return None
    return SourceArtifact(relative_path, target, sha256_bytes(data))


def source_from_path(project: Path, path: Path) -> SourceArtifact | None:
    if path.is_symlink() or not path.is_file():
        return None
    try:
        return source_from_relative(project, project_relative(project, path))
    except MigrationError:
        return None


def text_from_source(source: SourceArtifact) -> str:
    try:
        return source.path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return ""


def load_json_source(source: SourceArtifact) -> dict[str, Any] | list[Any] | None:
    try:
        value = json.loads(source.path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, (dict, list)) else None


def frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end < 0:
        return {}
    result: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        result[key.strip().lower()] = value.strip()
    return result


def valid_publication_url(value: Any) -> str:
    if not isinstance(value, str):
        return ""
    url = value.strip().rstrip(".,;:。；，")
    if not url:
        return ""
    try:
        parsed = urlparse(url)
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.hostname in PLACEHOLDER_HOSTS:
        return ""
    return url


def path_values(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from path_values(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from path_values(item)


def extract_final_paths(value: Any) -> set[str]:
    result: set[str] = set()
    for text in path_values(value):
        for match in LOCAL_PATH_RE.findall(text):
            candidate = match.rstrip(".,;:。；，`)]}")
            if is_safe_relative_path(candidate) and candidate.startswith(FINAL_CONTENT_ROOTS):
                result.add(candidate)
    return result


def line_value(text: str, labels: Iterable[str]) -> str:
    label_pattern = "|".join(re.escape(label) for label in labels)
    match = re.search(rf"^\s*[-*]?\s*(?:{label_pattern})\s*[：:]\s*(.+?)\s*$", text, re.MULTILINE | re.IGNORECASE)
    return match.group(1).strip() if match else ""


def publication_entries_from_markdown(text: str) -> list[PublicationEntry]:
    lowered = text.lower()
    if any(marker in lowered for marker in ("demo not published", "mock not published", "demo 未真实发布", "未真实发布", "示例项目未真实发布")):
        return []
    urls: list[str] = []
    for line in text.splitlines():
        if not re.search(r"发布链接|published[_ ]?url|publish[_ ]?url|publication[_ ]?url", line, re.IGNORECASE):
            continue
        for raw_url in URL_RE.findall(line):
            url = valid_publication_url(raw_url)
            if url and url not in urls:
                urls.append(url)
    platform = line_value(text, ("发布平台", "published platform", "platform"))
    published_at = line_value(text, ("发布时间", "published_at", "published at"))
    return [PublicationEntry(url=url, platform=platform, published_at=published_at) for url in urls]


def publication_entries_from_json(value: Any) -> list[PublicationEntry]:
    if not isinstance(value, dict):
        return []
    records = value.get("records")
    if isinstance(records, list):
        result: list[PublicationEntry] = []
        for record in records:
            if not isinstance(record, dict) or record.get("human_confirmed") is not True:
                continue
            url = valid_publication_url(record.get("published_url"))
            if not url:
                continue
            result.append(PublicationEntry(
                url=url,
                platform=str(record.get("platform") or ""),
                published_at=str(record.get("published_at") or ""),
                final_content_hash=str(record.get("final_content_hash") or ""),
                external_item_id=str(record.get("external_item_id") or ""),
            ))
        return result

    # Older publication JSON used one object.  It is accepted only when it
    # has explicit human/publication evidence, never merely a draft URL.
    is_confirmed = value.get("human_confirmed") is True or str(value.get("status") or "").lower() in {"published", "published_confirmed"}
    if not is_confirmed:
        return []
    raw_url = value.get("published_url") or value.get("publication_url") or value.get("publish_url")
    url = valid_publication_url(raw_url)
    if not url:
        return []
    return [PublicationEntry(
        url=url,
        platform=str(value.get("platform") or ""),
        published_at=str(value.get("published_at") or ""),
        final_content_hash=str(value.get("final_content_hash") or ""),
        external_item_id=str(value.get("external_item_id") or ""),
    )]


def metadata_from_source(source: SourceArtifact) -> tuple[str, str, str]:
    """Return run_id, slug and topic from a legacy source when available."""
    value = load_json_source(source)
    if isinstance(value, dict):
        run_id = str(value.get("run_id") or "")
        slug = str(value.get("run_slug") or value.get("slug") or "")
        topic = str(value.get("topic") or value.get("title") or "")
        if run_id or slug:
            return run_id, slug, topic
    text = text_from_source(source)
    meta = frontmatter(text)
    slug = meta.get("slug", "")
    topic = line_value(text, ("标题", "title"))
    stem = source.path.stem
    if not slug:
        stem = re.sub(r"(?:[-_]publish|[-_]publication|[-_]ledger)$", "", stem, flags=re.IGNORECASE)
        slug = stem
    return "", slug, topic


def markdown_or_json_paths(source: SourceArtifact) -> set[str]:
    value = load_json_source(source)
    if value is not None:
        return extract_final_paths(value)
    return extract_final_paths(text_from_source(source))


def add_unique_source(items: list[SourceArtifact], source: SourceArtifact | None) -> None:
    if source and all(item.relative_path != source.relative_path for item in items):
        items.append(source)


def candidate_key(run_id: str, slug: str) -> str:
    return safe_identifier(run_id or slug, "legacy-publication")


def find_or_create_candidate(
    candidates: dict[str, HistoryCandidate],
    by_slug: dict[str, str],
    *,
    run_id: str,
    slug: str,
    topic: str = "",
) -> HistoryCandidate:
    safe_run_id = safe_identifier(run_id, "") if run_id else ""
    safe_slug = safe_identifier(slug, safe_run_id or "legacy-publication")
    key = safe_run_id or by_slug.get(safe_slug) or candidate_key("", safe_slug)
    candidate = candidates.get(key)
    if candidate is None:
        record_id = f"legacy-{safe_identifier(key, 'publication')}"
        candidate = HistoryCandidate(record_id=record_id, run_id=safe_run_id, slug=safe_slug, topic=topic.strip())
        candidates[key] = candidate
    elif topic.strip() and not candidate.topic:
        candidate.topic = topic.strip()
    if safe_slug:
        by_slug.setdefault(safe_slug, key)
    return candidate


def sources_under(project: Path, relative_root: str, suffixes: set[str] | None = None) -> list[SourceArtifact]:
    root = project / relative_root
    if not root.is_dir() or root.is_symlink():
        return []
    result: list[SourceArtifact] = []
    for path in sorted(root.rglob("*")):
        if suffixes is not None and path.suffix.lower() not in suffixes:
            continue
        source = source_from_path(project, path)
        if source:
            result.append(source)
    return result


def discover_candidates(project: Path) -> tuple[dict[str, HistoryCandidate], list[dict[str, Any]]]:
    candidates: dict[str, HistoryCandidate] = {}
    by_slug: dict[str, str] = {}
    excluded = excluded_entries(project)

    for source in sources_under(project, "runs", {".json"}):
        data = load_json_source(source)
        if not isinstance(data, dict):
            continue
        run_id = str(data.get("run_id") or source.path.stem)
        slug = str(data.get("slug") or run_id)
        candidate = find_or_create_candidate(candidates, by_slug, run_id=run_id, slug=slug, topic=str(data.get("topic") or ""))
        candidate.run_source = source
        steps = data.get("steps") if isinstance(data.get("steps"), dict) else {}
        phase_artifacts = data.get("phase_artifacts") if isinstance(data.get("phase_artifacts"), dict) else {}
        publish = steps.get("publish") if isinstance(steps, dict) and isinstance(steps.get("publish"), dict) else {}
        for raw_path in (publish.get("latest"), publish.get("source")):
            if isinstance(raw_path, str):
                candidate.content_paths.update(extract_final_paths(raw_path))
                add_unique_source(candidate.publication_sources, source_from_relative(project, raw_path))
        for step in ("write", "package", "xhs", "platform-adapt"):
            value = steps.get(step) if isinstance(steps, dict) else None
            raw_path = value.get("latest") if isinstance(value, dict) else None
            if isinstance(raw_path, str) and raw_path.startswith(FINAL_CONTENT_ROOTS):
                # Only used as a fallback when a publish record omitted the
                # final path.  Explicit paths from publication evidence win.
                candidate.fallback_content_paths.add(raw_path)
        visual_phase = phase_artifacts.get("visual_assets") if isinstance(phase_artifacts, dict) else None
        visual_path = visual_phase.get("path") if isinstance(visual_phase, dict) else None
        if isinstance(visual_path, str):
            candidate.visual_manifest_paths.add(visual_path)
        performance = steps.get("performance") if isinstance(steps, dict) and isinstance(steps.get("performance"), dict) else {}
        add_unique_source(candidate.performance_sources, source_from_relative(project, performance.get("latest", "")))

    publication_files = [
        *sources_under(project, "pipeline/publish", {".md", ".markdown", ".json"}),
        *sources_under(project, "materials/publication/ledger", {".json"}),
    ]
    for source in publication_files:
        run_id, slug, topic = metadata_from_source(source)
        candidate = find_or_create_candidate(candidates, by_slug, run_id=run_id, slug=slug, topic=topic)
        add_unique_source(candidate.publication_sources, source)
        value = load_json_source(source)
        entries = publication_entries_from_json(value) if value is not None else publication_entries_from_markdown(text_from_source(source))
        for entry in entries:
            if entry.url not in {item.url for item in candidate.publication_entries}:
                candidate.publication_entries.append(entry)
        candidate.content_paths.update(markdown_or_json_paths(source))
        if isinstance(value, dict) and isinstance(value.get("records"), list):
            for record in value["records"]:
                if not isinstance(record, dict) or record.get("human_confirmed") is not True:
                    continue
                for item in record.get("selected_asset_hashes") or []:
                    if not isinstance(item, dict):
                        continue
                    raw_path = item.get("path")
                    digest = item.get("sha256")
                    if isinstance(raw_path, str) and raw_path.startswith("pipeline/visual/"):
                        candidate.ledger_asset_paths[raw_path] = {
                            "sha256": str(digest or ""),
                            "role": str(item.get("role") or ""),
                            "asset_id": str(item.get("id") or ""),
                        }

    for candidate in candidates.values():
        if candidate.slug:
            candidate.visual_manifest_paths.add(f"pipeline/visual/{candidate.slug}/selected-assets.json")
            candidate.visual_manifest_paths.add(f"pipeline/visual/{candidate.slug}/selected-revision.json")

    for source in [
        *sources_under(project, "pipeline/performance", {".md", ".markdown", ".json"}),
        *sources_under(project, "materials/performance", {".json"}),
    ]:
        if source.relative_path.startswith(("materials/performance/raw/", "materials/performance/review-inputs/")):
            continue
        run_id, slug, _topic = metadata_from_source(source)
        safe_run_id = safe_identifier(run_id, "") if run_id else ""
        safe_slug = safe_identifier(slug, "") if slug else ""
        key = safe_run_id or by_slug.get(safe_slug)
        if not key or key not in candidates:
            continue
        add_unique_source(candidates[key].performance_sources, source)

    return candidates, excluded


def excluded_entries(project: Path) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    for prefix in EXCLUDED_PREFIXES:
        root = project / prefix
        if not root.is_dir() or root.is_symlink():
            continue
        for path in sorted(root.rglob("*")):
            source = source_from_path(project, path)
            if not source:
                continue
            entries.append({
                "source": source.relative_path,
                "destination": None,
                "sha256": source.sha256,
                "record_type": "excluded_legacy_artifact",
                "import_status": "skipped_excluded",
                "reason": "outside final-publication migration allowlist",
            })
    return entries


def selected_visual_assets(project: Path, candidate: HistoryCandidate) -> list[tuple[SourceArtifact, dict[str, str]]]:
    selected: dict[str, tuple[SourceArtifact, dict[str, str]]] = {}
    for raw_path, evidence in candidate.ledger_asset_paths.items():
        source = source_from_relative(project, raw_path)
        if not source or source.path.suffix.lower() not in VISUAL_EXTENSIONS:
            continue
        if evidence.get("sha256") and evidence["sha256"] != source.sha256:
            continue
        selected[source.relative_path] = (source, evidence)

    for manifest_path in sorted(candidate.visual_manifest_paths):
        source = source_from_relative(project, manifest_path)
        if not source:
            continue
        value = load_json_source(source)
        if not isinstance(value, dict):
            continue
        if value.get("schema") == "aifios.visual-asset-manifest.v1" and isinstance(value.get("selections"), dict):
            for selection in value["selections"].values():
                if not isinstance(selection, dict):
                    continue
                asset_path = selection.get("path")
                if not isinstance(asset_path, str):
                    continue
                asset = source_from_relative(project, asset_path)
                if not asset or asset.path.suffix.lower() not in VISUAL_EXTENSIONS:
                    continue
                expected = str(selection.get("sha256") or "")
                if expected and expected != asset.sha256:
                    continue
                selected[asset.relative_path] = (asset, {
                    "sha256": asset.sha256,
                    "role": str(selection.get("semanticRole") or ""),
                    "asset_id": str(selection.get("assetId") or ""),
                })
        elif value.get("schema") == "aifios.visual-selection.v1":
            integrity = value.get("integrity") if isinstance(value.get("integrity"), dict) else {}
            for item in integrity.get("files") or []:
                if not isinstance(item, dict) or item.get("role") != "output":
                    continue
                asset_path = item.get("path")
                if not isinstance(asset_path, str):
                    continue
                asset = source_from_relative(project, asset_path)
                if not asset or asset.path.suffix.lower() not in VISUAL_EXTENSIONS:
                    continue
                expected = str(item.get("sha256") or "")
                if expected and expected != asset.sha256:
                    continue
                selected[asset.relative_path] = (asset, {
                    "sha256": asset.sha256,
                    "role": "legacy_selected_revision",
                    "asset_id": str(item.get("id") or ""),
                })
    return [selected[key] for key in sorted(selected)]


def scalar_metric(value: Any) -> int | float | str | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        cleaned = value.strip()
        if not cleaned or len(cleaned) > 120:
            return None
        if re.fullmatch(r"-?\d+", cleaned):
            return int(cleaned)
        if re.fullmatch(r"-?\d+\.\d+", cleaned):
            return float(cleaned)
        return cleaned
    return None


def safe_metrics(value: Any) -> dict[str, int | float | str]:
    if not isinstance(value, dict):
        return {}
    result: dict[str, int | float | str] = {}
    for key, item in value.items():
        name = str(key).strip()
        if not name or len(name) > 80 or SENSITIVE_KEY_RE.search(name):
            continue
        metric = scalar_metric(item)
        if metric is not None:
            result[name] = metric
    return result


def metrics_from_json(value: Any) -> tuple[dict[str, int | float | str], dict[str, str]]:
    if not isinstance(value, dict):
        return {}, {}
    candidates: list[Any] = []
    for key in ("metrics", "performance", "normalized_metrics", "normalized"):
        candidates.append(value.get(key))
    performance = value.get("performance")
    if isinstance(performance, dict):
        candidates.extend(performance.get(key) for key in ("metrics", "normalized_metrics", "normalized"))
    normalized = value.get("normalized")
    if isinstance(normalized, dict):
        candidates.append(normalized.get("metrics"))
    metrics: dict[str, int | float | str] = {}
    for item in candidates:
        metrics.update(safe_metrics(item))
    metadata = {
        "platform": str(value.get("platform") or value.get("platform_name") or ""),
        "captured_at": str(value.get("captured_at") or value.get("collected_at") or value.get("updated_at") or ""),
    }
    return metrics, {key: item for key, item in metadata.items() if item}


def metrics_from_markdown(text: str) -> tuple[dict[str, int | float | str], dict[str, str]]:
    metrics: dict[str, int | float | str] = {}
    for name, raw_value in METRIC_LINE_RE.findall(text):
        key = name.strip().strip("`")
        if key.lower() in {"metric", "metrics", "指标", "---"} or SENSITIVE_KEY_RE.search(key):
            continue
        value = scalar_metric(raw_value.strip())
        if value is not None:
            metrics[key] = value
    metadata = {
        "platform": line_value(text, ("平台", "platform")),
        "captured_at": line_value(text, ("采集时间", "captured_at", "collected_at")),
    }
    return metrics, {key: item for key, item in metadata.items() if item}


def normalized_performance(source: SourceArtifact, slug: str) -> bytes | None:
    json_value = load_json_source(source)
    if json_value is not None:
        metrics, metadata = metrics_from_json(json_value)
    else:
        metrics, metadata = metrics_from_markdown(text_from_source(source))
    if not metrics:
        return None
    return canonical_json_bytes({
        "schema": "aifios.migrated-performance.v1",
        "slug": slug,
        **metadata,
        "metrics": metrics,
    })


def combined_hash(sources: Iterable[SourceArtifact]) -> str:
    canonical = [{"path": item.relative_path, "sha256": item.sha256} for item in sorted(sources, key=lambda item: item.relative_path)]
    return sha256_bytes(canonical_json_bytes(canonical))


def destination_for(record_id: str, category: str, source: SourceArtifact) -> str:
    stem = safe_identifier(source.path.stem, "asset")
    suffix = source.path.suffix.lower() or ".bin"
    return (HISTORY_ROOT / record_id / category / f"{stem}-{source.sha256[:12]}{suffix}").as_posix()


def make_history_record(
    candidate: HistoryCandidate,
    content: list[dict[str, str]],
    visuals: list[dict[str, str]],
    links_path: str,
    performance: list[dict[str, str]],
) -> bytes:
    return canonical_json_bytes({
        "schema": HISTORY_SCHEMA,
        "record_id": candidate.record_id,
        "legacy_run_id": candidate.run_id,
        "slug": candidate.slug,
        **({"topic": candidate.topic} if candidate.topic else {}),
        "content": content,
        "visual_assets": visuals,
        "publication_links_path": links_path,
        "performance_paths": [item["path"] for item in performance],
    })


def plan_candidate(project: Path, candidate: HistoryCandidate) -> list[MigrationOperation]:
    if not candidate.publication_entries:
        return []
    operations: list[MigrationOperation] = []
    # A path named by the publication evidence is authoritative.  The current
    # run's final/package path is only a compatibility fallback for old records
    # that omitted it, because it may have changed after the actual send.
    content_paths = sorted(candidate.content_paths or candidate.fallback_content_paths)
    content_sources = [source_from_relative(project, value) for value in content_paths]
    content_sources = [source for source in content_sources if source and source.path.suffix.lower() in CONTENT_EXTENSIONS]
    content_rows: list[dict[str, str]] = []
    for source in content_sources:
        destination = destination_for(candidate.record_id, "content", source)
        operations.append(MigrationOperation(
            source=source.relative_path,
            source_paths=[source.relative_path],
            source_sha256=source.sha256,
            destination=destination,
            record_type="final_content",
            payload=source.path.read_bytes(),
        ))
        content_rows.append({"path": destination, "sha256": source.sha256})

    visual_rows: list[dict[str, str]] = []
    for source, evidence in selected_visual_assets(project, candidate):
        destination = destination_for(candidate.record_id, "visual", source)
        operations.append(MigrationOperation(
            source=source.relative_path,
            source_paths=[source.relative_path],
            source_sha256=source.sha256,
            destination=destination,
            record_type="adopted_visual_asset",
            payload=source.path.read_bytes(),
            metadata={key: value for key, value in evidence.items() if value},
        ))
        visual_rows.append({
            "path": destination,
            "sha256": source.sha256,
            **({"role": evidence["role"]} if evidence.get("role") else {}),
            **({"asset_id": evidence["asset_id"]} if evidence.get("asset_id") else {}),
        })

    publication_sources = sorted(candidate.publication_sources, key=lambda item: item.relative_path)
    if not publication_sources:
        raise MigrationError(f"{candidate.record_id}: verified publication links lack a local evidence source")
    links_destination = (HISTORY_ROOT / candidate.record_id / "publication-links.json").as_posix()
    links_payload = canonical_json_bytes({
        "schema": "aifios.migrated-publication-links.v1",
        "record_id": candidate.record_id,
        "records": [entry.as_dict() for entry in candidate.publication_entries],
    })
    operations.append(MigrationOperation(
        source=publication_sources[0].relative_path,
        source_paths=[source.relative_path for source in publication_sources],
        source_sha256=combined_hash(publication_sources),
        destination=links_destination,
        record_type="publication_links",
        payload=links_payload,
    ))

    performance_rows: list[dict[str, str]] = []
    for source in sorted(candidate.performance_sources, key=lambda item: item.relative_path):
        payload = normalized_performance(source, candidate.slug)
        if payload is None:
            continue
        destination = destination_for(candidate.record_id, "performance", source).removesuffix(source.path.suffix.lower()) + ".json"
        operations.append(MigrationOperation(
            source=source.relative_path,
            source_paths=[source.relative_path],
            source_sha256=source.sha256,
            destination=destination,
            record_type="performance_metrics",
            payload=payload,
        ))
        performance_rows.append({"path": destination, "sha256": sha256_bytes(payload)})

    record_destination = (HISTORY_ROOT / candidate.record_id / "record.json").as_posix()
    record_sources = [*publication_sources, *content_sources]
    if candidate.run_source:
        record_sources.append(candidate.run_source)
    operations.append(MigrationOperation(
        source=(candidate.run_source or publication_sources[0]).relative_path,
        source_paths=[source.relative_path for source in record_sources],
        source_sha256=combined_hash(record_sources),
        destination=record_destination,
        record_type="history_record",
        payload=make_history_record(candidate, content_rows, visual_rows, links_destination, performance_rows),
    ))
    return operations


def destination_path(project: Path, relative_path: str) -> Path:
    if not is_safe_relative_path(relative_path):
        raise MigrationError("destination path is unsafe")
    target = project.joinpath(*PurePosixPath(relative_path).parts)
    try:
        target.resolve(strict=False).relative_to(project.resolve(strict=True))
    except ValueError as exc:
        raise MigrationError("destination is outside project") from exc
    return target


def ensure_safe_parent(project: Path, target: Path) -> None:
    project_resolved = project.resolve(strict=True)
    parent = target.parent
    pending: list[Path] = []
    while parent != project_resolved and not parent.exists():
        pending.append(parent)
        parent = parent.parent
    if parent.is_symlink():
        raise MigrationError("destination parent may not be a symbolic link")
    for directory in reversed(pending):
        directory.mkdir()
        if directory.is_symlink():
            raise MigrationError("destination parent may not be a symbolic link")


def write_if_unchanged(project: Path, relative_path: str, payload: bytes) -> str:
    target = destination_path(project, relative_path)
    ensure_safe_parent(project, target)
    if target.exists():
        if target.is_symlink() or not target.is_file():
            raise MigrationError(f"destination is not a regular file: {relative_path}")
        existing = target.read_bytes()
        if existing == payload:
            return "already_imported"
        raise MigrationError(f"destination already has different bytes: {relative_path}")
    fd, temporary = tempfile.mkstemp(prefix=".aifios-history-", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return "imported"


def operation_entry(operation: MigrationOperation, status: str) -> dict[str, Any]:
    return {
        "source": operation.source,
        "sources": operation.source_paths,
        "destination": operation.destination,
        "sha256": operation.source_sha256,
        "destination_sha256": operation.destination_sha256,
        "record_type": operation.record_type,
        "import_status": status,
        **({"metadata": operation.metadata} if operation.metadata else {}),
    }


def ensure_no_duplicate_destinations(operations: Iterable[MigrationOperation]) -> None:
    seen: dict[str, str] = {}
    for operation in operations:
        previous = seen.get(operation.destination)
        if previous and previous != operation.destination_sha256:
            raise MigrationError(f"migration plan has conflicting destination: {operation.destination}")
        seen[operation.destination] = operation.destination_sha256


def build_manifest(project: Path, mode: str, operations: list[MigrationOperation], excluded: list[dict[str, Any]], statuses: dict[str, str] | None = None) -> dict[str, Any]:
    statuses = statuses or {}
    entries = [operation_entry(operation, statuses.get(operation.destination, "planned")) for operation in operations]
    entries.extend(excluded)
    counts: dict[str, int] = {}
    for entry in entries:
        status = str(entry["import_status"])
        counts[status] = counts.get(status, 0) + 1
    return {
        "schema": SCHEMA,
        "mode": mode,
        "created_at": now_iso(),
        "project": project.name,
        "history_root": HISTORY_ROOT.as_posix(),
        "excluded_source_prefixes": list(EXCLUDED_PREFIXES),
        "entries": entries,
        "summary": {
            "history_records": sum(operation.record_type == "history_record" for operation in operations),
            "operations": len(operations),
            "by_status": counts,
        },
    }


def manifest_path_for(project: Path, value: str | None, apply: bool) -> str | None:
    if value:
        if not is_safe_relative_path(value):
            raise MigrationError("manifest path must be project-relative and safe")
        return PurePosixPath(value).as_posix()
    return DEFAULT_MANIFEST.as_posix() if apply else None


def migrate_project(project: str | Path, *, apply: bool = False, manifest_path: str | None = None) -> dict[str, Any]:
    root = Path(project).expanduser().resolve()
    if not root.is_dir():
        raise MigrationError("project directory does not exist")
    candidates, excluded = discover_candidates(root)
    operations: list[MigrationOperation] = []
    for candidate in sorted(candidates.values(), key=lambda item: item.record_id):
        if candidate.publication_entries:
            operations.extend(plan_candidate(root, candidate))
            continue
        source = (candidate.publication_sources or ([candidate.run_source] if candidate.run_source else []))
        if source:
            excluded.append({
                "source": source[0].relative_path,
                "sources": [item.relative_path for item in source],
                "destination": None,
                "sha256": combined_hash(source),
                "record_type": "unverified_publication",
                "import_status": "skipped_unverified",
                "reason": "no human-confirmed non-placeholder publication URL",
            })
    ensure_no_duplicate_destinations(operations)
    target_manifest = manifest_path_for(root, manifest_path, apply)

    if not apply:
        manifest = build_manifest(root, "dry_run", operations, excluded)
        if target_manifest:
            write_if_unchanged(root, target_manifest, canonical_json_bytes(manifest))
            manifest["manifest_path"] = target_manifest
        return manifest

    statuses: dict[str, str] = {}
    for operation in operations:
        statuses[operation.destination] = write_if_unchanged(root, operation.destination, operation.payload)
    manifest = build_manifest(root, "apply", operations, excluded, statuses)
    if target_manifest:
        target = destination_path(root, target_manifest)
        ensure_safe_parent(root, target)
        # The manifest is a current audit log, so replace it atomically rather
        # than treating its changing timestamp as a migration collision.
        temporary_payload = canonical_json_bytes(manifest)
        fd, temporary = tempfile.mkstemp(prefix=".aifios-migration-manifest-", dir=str(target.parent))
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(temporary_payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        manifest["manifest_path"] = target_manifest
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Migrate verified AIFIOS final-publication history")
    parser.add_argument("--project", required=True, help="local AIFIOS project directory")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="plan only (default)")
    mode.add_argument("--apply", action="store_true", help="write self-contained local history records")
    parser.add_argument(
        "--manifest",
        default="",
        help="optional project-relative JSON manifest path; apply defaults to materials/publication/migrations/final-publication-history-manifest.json",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        result = migrate_project(args.project, apply=bool(args.apply), manifest_path=args.manifest or None)
    except MigrationError as exc:
        print(json.dumps({"schema": SCHEMA, "error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
