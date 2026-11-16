#!/usr/bin/env python3
"""Local, evidence-bound weekly learning loop for AIFIOS.

The production flow deliberately stops after a human has confirmed public
publication. This script owns the optional weekly follow-up instead of making
``performance -> review -> archive -> twin`` a hidden serial pipeline. It
only reads immutable publication records and authorized performance evidence;
long-term memory writes are possible only through the explicit
``apply-memory`` command after a complete review exists.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import stat
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from review_quality import audit_review
from tikomni_adapter import TikomniApiBridge, infer_metrics, infer_url, normalize_tikomni_platform, normalized_items
from generated_language_quality import inspect_generated_language


SCHEDULE_SCHEMA = "aifios.weekly-review-schedule.v1"
RECORD_SCHEMA = "aifios.weekly-learning-record.v1"
REPORT_SCHEMA = "aifios.weekly-learning-report.v1"
MEMORY_WRITE_SCHEMA = "aifios.weekly-learning-memory.v1"
TIMEZONE_NAME = "Asia/Shanghai"
SCHEDULE_RELATIVE_PATH = "sessions/weekly-review-schedule.json"
WEEKLY_ROOT = "materials/weekly-review"
LEDGER_ROOT = "materials/publication/ledger"
PERFORMANCE_INPUT_ROOT = "materials/performance/review-inputs"
DRAFT_QUEUE_SCHEMA = "aifios.publication-draft-queue.v1"
PUBLICATION_LEDGER_SCHEMA = "aifios.publication-ledger.v1"
MAX_PROVENANCE_JSON_BYTES = 16 * 1024 * 1024
MAX_PROVENANCE_ASSET_BYTES = 512 * 1024 * 1024

# Keep this byte-for-byte compatible with
# ui/lib/publish/draft-queue.ts::draftQueueContractSha256. Operational adapter
# progress may change after approval, while every other queue field is part of
# the immutable publication contract.
DRAFT_QUEUE_TRANSIENT_KEYS = frozenset({
    "adapter",
    "authorization_state",
    "attempt_count",
    "retry_count",
    "last_attempt_at",
    "last_error",
    "result_reference",
    "external_reference",
    "events",
    "status",
    "updated_at",
})

# Weekly review is optional, but every confirmed public URL gets one
# resolver-gated TikOmni collection attempt before the operator is asked for
# missing metrics.  The product intentionally supports only sources for which
# the API catalog can accept a public URL (or an ID deterministically parsed
# from that URL); it never guesses private dashboard routes or work IDs.
PUBLIC_PERFORMANCE_SOURCES = {
    "wechat": ("wechat_mp", "article_detail"),
    "xiaohongshu": ("xiaohongshu", "note_detail"),
    "shipinhao": ("wechat_channels", "video_detail"),
}
PUBLIC_URL_PARAM_NAMES = ("url", "share_url", "share_link", "share_text")
XHS_NOTE_ID_RE = re.compile(r"/(?:explore|discovery/item)/([A-Za-z0-9_-]{6,128})(?:[/?#]|$)", re.IGNORECASE)
# Public performance import is an optional convenience. Keep it bounded so an
# unavailable third-party endpoint can never make the weekly-review screen
# appear frozen. The manual "collect" action is the only place it runs.
PUBLIC_PERFORMANCE_TIMEOUT_MS = 3_000
PUBLIC_PERFORMANCE_MAX_WORKERS = 3

PLATFORM_LABELS = {
    "wechat": "公众号",
    "xiaohongshu": "小红书",
    "moments": "朋友圈",
    "shipinhao": "视频号",
    "douyin": "抖音",
}

# The fields are intentionally small and observable. Extra dashboard numbers
# may still be retained as supporting evidence, but cannot substitute for a
# required field when an operator completes a weekly review.
REQUIRED_METRICS: dict[str, tuple[str, ...]] = {
    "wechat": ("reads", "likes", "wows", "shares", "comments", "leads"),
    "xiaohongshu": ("exposures", "likes", "collects", "comments", "shares", "leads"),
    "moments": ("exposures", "comments", "shares", "leads"),
    "shipinhao": ("plays", "likes", "comments", "shares", "leads"),
    "douyin": ("plays", "likes", "comments", "shares", "leads"),
}

METRIC_LABELS = {
    "exposures": "曝光",
    "reads": "阅读",
    "readers": "阅读人数",
    "plays": "播放",
    "likes": "点赞",
    "wows": "在看",
    "shares": "分享",
    "collects": "收藏",
    "comments": "评论",
    "new_followers": "新增关注",
    "profile_visits": "主页访问",
    "leads": "线索",
}

METRIC_ALIASES = {
    "曝光": "exposures",
    "曝光量": "exposures",
    "展示": "exposures",
    "展示量": "exposures",
    "阅读": "reads",
    "阅读量": "reads",
    "阅读次数": "reads",
    "播放": "plays",
    "播放量": "plays",
    "点赞": "likes",
    "在看": "wows",
    "分享": "shares",
    "转发": "shares",
    "收藏": "collects",
    "评论": "comments",
    "留言": "comments",
    "新增关注": "new_followers",
    "主页访问": "profile_visits",
    "线索": "leads",
    "咨询": "leads",
}

ALLOWED_METRICS = frozenset(METRIC_LABELS)
SAFE_WEEK_RE = re.compile(r"^\d{4}-W\d{2}$")
SAFE_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fff]{1,120}$")
SAFE_RECORD_PATH_RE = re.compile(r"^materials/weekly-review/\d{4}-W\d{2}/learning-record\.json$")
SAFE_LEDGER_PATH_RE = re.compile(
    r"^materials/publication/ledger/[A-Za-z0-9_\-\u4e00-\u9fff]{1,120}/publication-ledger\.json$"
)
PUBLISH_PROOF_PATH_RE = re.compile(
    r"^materials/(?:publish-proof|publish-evidence)/[A-Za-z0-9._\-\u4e00-\u9fff]+\.(?:png|jpe?g|webp|pdf)$",
    re.IGNORECASE,
)
SENSITIVE_RE = re.compile(
    r"(?:(?:\+?86[-\s]?)?1[3-9]\d{9}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|"
    r"微信(?:号)?[:：]?\s*[A-Za-z0-9_-]{5,}|weixin[:：]?\s*[A-Za-z0-9_-]{5,}|"
    r"wx[:：]?\s*[A-Za-z0-9_-]{5,}|"
    r"(?:api[_ -]?key|access[_ -]?token|authorization|cookie|password|app[_ -]?secret|client[_ -]?secret|token|密钥|令牌|密码)\s*[:=：]\s*[^\s,，;；]+|"
    r"\bsk-[A-Za-z0-9_-]{8,}\b|"
    r"file:///\S+|/(?:Users|home|root|private|var|tmp|Volumes|workspace|app|mnt)/\S+|[A-Za-z]:\\\S+)",
    re.IGNORECASE,
)


class WeeklyLearningError(ValueError):
    """Expected operator-facing weekly-learning error."""


def local_now(value: str | None = None) -> datetime:
    tz = ZoneInfo(TIMEZONE_NAME)
    if not value:
        return datetime.now(tz)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise WeeklyLearningError("时间必须为可解析的 ISO 8601 格式") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=tz)
    return parsed.astimezone(tz)


def timestamp(value: datetime | None = None) -> str:
    return (value or local_now()).isoformat(timespec="seconds")


def iso_week(value: datetime) -> str:
    iso = value.isocalendar()
    return f"{iso.year}-W{iso.week:02d}"


def safe_relative_path(value: str, pattern: re.Pattern[str] | None = None) -> str:
    path = str(value or "").strip().replace("\\", "/")
    if not path or path.startswith("/") or "\x00" in path:
        raise WeeklyLearningError("路径必须是项目内相对路径")
    parts = path.split("/")
    if any(not item or item in {".", ".."} for item in parts):
        raise WeeklyLearningError("路径必须是项目内安全路径")
    if pattern and not pattern.fullmatch(path):
        raise WeeklyLearningError("路径不属于每周复盘的本地目录")
    return path


def project_file(project: Path, relative_path: str, *, must_exist: bool = False) -> Path:
    relative = safe_relative_path(relative_path)
    candidate = (project / relative).resolve(strict=False)
    try:
        candidate.relative_to(project)
    except ValueError as exc:
        raise WeeklyLearningError("路径不在当前项目内") from exc
    if must_exist:
        if not candidate.exists() or candidate.is_symlink() or not candidate.is_file():
            raise WeeklyLearningError("本地文件不存在或不可读取")
    return candidate


def read_regular_project_bytes(
    project: Path,
    relative_path: str,
    *,
    label: str,
    maximum_bytes: int,
) -> bytes:
    """Read an in-project regular file without following any symlink.

    Resolving a path and then opening it leaves a symlink/rename race. The
    publication provenance gate walks from an already opened project directory
    and opens every component with ``O_NOFOLLOW`` instead. A before/after
    descriptor stat also rejects a file that changed while it was hashed.
    """
    relative = safe_relative_path(relative_path)
    segments = relative.split("/")
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    opened: list[int] = []
    try:
        current_fd = os.open(project, directory_flags | no_follow)
        opened.append(current_fd)
        if not stat.S_ISDIR(os.fstat(current_fd).st_mode):
            raise WeeklyLearningError("项目目录不可读取")
        for segment in segments[:-1]:
            next_fd = os.open(segment, directory_flags | no_follow, dir_fd=current_fd)
            opened.append(next_fd)
            if not stat.S_ISDIR(os.fstat(next_fd).st_mode):
                raise WeeklyLearningError(f"{label}路径包含非目录组件")
            current_fd = next_fd
        file_fd = os.open(
            segments[-1],
            os.O_RDONLY | no_follow | getattr(os, "O_CLOEXEC", 0),
            dir_fd=current_fd,
        )
        opened.append(file_fd)
        before = os.fstat(file_fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size < 0 or before.st_size > maximum_bytes:
            raise WeeklyLearningError(f"{label}不是大小合理的项目内普通文件")
        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = os.read(file_fd, min(1024 * 1024, maximum_bytes + 1 - total))
            if not chunk:
                break
            total += len(chunk)
            if total > maximum_bytes:
                raise WeeklyLearningError(f"{label}超过允许大小")
            chunks.append(chunk)
        after = os.fstat(file_fd)
        identity_before = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        identity_after = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        if identity_before != identity_after or total != after.st_size:
            raise WeeklyLearningError(f"{label}读取期间发生变化，请重新检查")
        return b"".join(chunks)
    except WeeklyLearningError:
        raise
    except (OSError, ValueError) as exc:
        raise WeeklyLearningError(f"{label}不是可读取的项目内普通文件") from exc
    finally:
        for descriptor in reversed(opened):
            try:
                os.close(descriptor)
            except OSError:
                pass


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def read_project_json(project: Path, relative_path: str, *, label: str) -> dict[str, Any]:
    raw = read_regular_project_bytes(
        project,
        relative_path,
        label=label,
        maximum_bytes=MAX_PROVENANCE_JSON_BYTES,
    )
    try:
        value = json.loads(
            raw.decode("utf-8"),
            object_pairs_hook=_strict_object,
            parse_constant=lambda token: (_ for _ in ()).throw(ValueError(f"invalid JSON number: {token}")),
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise WeeklyLearningError(f"{label}不是有效 JSON") from exc
    if not isinstance(value, dict):
        raise WeeklyLearningError(f"{label}必须是 JSON 对象")
    return value


def _draft_contract_stringify(value: Any) -> str:
    if isinstance(value, list):
        return "[" + ",".join(_draft_contract_stringify(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = (
            (key, item)
            for key, item in value.items()
            if key not in DRAFT_QUEUE_TRANSIENT_KEYS
        )
        return "{" + ",".join(
            f"{json.dumps(key, ensure_ascii=False, separators=(',', ':'))}:{_draft_contract_stringify(item)}"
            for key, item in sorted(entries, key=lambda entry: entry[0])
        ) + "}"
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def draft_queue_contract_sha256(queue: dict[str, Any]) -> str:
    """Return the canonical contract digest used by the TypeScript runtime."""
    return hashlib.sha256(_draft_contract_stringify(queue).encode("utf-8")).hexdigest()


def relative_to_project(project: Path, path: Path) -> str:
    return path.resolve(strict=False).relative_to(project).as_posix()


def read_json_file(path: Path) -> dict[str, Any] | None:
    try:
        if path.is_symlink() or not path.is_file():
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def atomic_write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def atomic_append(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    previous = path.read_text(encoding="utf-8") if path.exists() and not path.is_symlink() else ""
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(previous.rstrip() + "\n\n" + text.rstrip() + "\n", encoding="utf-8")
    os.replace(temporary, path)


def digest_json(value: Any) -> str:
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def normalize_metric_key(key: Any) -> str:
    raw = str(key or "").strip()
    return METRIC_ALIASES.get(raw, raw.lower().replace("-", "_").replace(" ", "_"))


def parse_metric_value(value: Any) -> int | float:
    if isinstance(value, bool):
        raise WeeklyLearningError("指标必须是非负数字")
    if isinstance(value, (int, float)):
        number = float(value)
    else:
        text = str(value or "").strip().replace(",", "")
        match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([wW万kK千]?)", text)
        if not match:
            raise WeeklyLearningError("指标必须是非负数字")
        number = float(match.group(1))
        unit = match.group(2).lower()
        if unit in {"w", "万"}:
            number *= 10000
        elif unit in {"k", "千"}:
            number *= 1000
    if number < 0 or number > 10**12:
        raise WeeklyLearningError("指标必须是合理的非负数字")
    return int(number) if number.is_integer() else round(number, 4)


def format_metric(value: Any) -> str:
    if isinstance(value, float) and not value.is_integer():
        return f"{value:.4g}"
    return str(int(value)) if isinstance(value, float) else str(value)


def redact_comment(value: Any) -> str:
    compact = re.sub(r"\s+", " ", str(value or "")).strip()
    compact = SENSITIVE_RE.sub("[已脱敏]", compact)
    return compact[:500]


def default_schedule(now: datetime | None = None) -> dict[str, Any]:
    return {
        "schema": SCHEDULE_SCHEMA,
        "timezone": TIMEZONE_NAME,
        "weekday": 0,
        "hour": 9,
        "minute": 0,
        "last_checked_at": timestamp(now),
        "last_notified_week": "",
    }


def schedule_path(project: Path) -> Path:
    return project_file(project, SCHEDULE_RELATIVE_PATH)


def load_schedule(project: Path, now: datetime | None = None) -> dict[str, Any]:
    path = schedule_path(project)
    loaded = read_json_file(path)
    if not loaded or loaded.get("schema") != SCHEDULE_SCHEMA:
        return default_schedule(now)
    schedule = default_schedule(now)
    schedule.update({
        key: loaded.get(key, schedule[key])
        for key in schedule
        if key in loaded
    })
    if schedule.get("timezone") != TIMEZONE_NAME:
        schedule["timezone"] = TIMEZONE_NAME
    for key, fallback, minimum, maximum in [("weekday", 0, 0, 6), ("hour", 9, 0, 23), ("minute", 0, 0, 59)]:
        try:
            value = int(schedule.get(key, fallback))
        except (TypeError, ValueError):
            value = fallback
        schedule[key] = value if minimum <= value <= maximum else fallback
    schedule["last_notified_week"] = str(schedule.get("last_notified_week") or "")
    return schedule


def scheduled_at(schedule: dict[str, Any], now: datetime) -> datetime:
    week_start = (now - timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    return week_start + timedelta(days=int(schedule["weekday"])) + timedelta(
        hours=int(schedule["hour"]), minutes=int(schedule["minute"])
    )


def record_relative_path(week: str) -> str:
    if not SAFE_WEEK_RE.fullmatch(week):
        raise WeeklyLearningError("复盘周标识无效")
    return f"{WEEKLY_ROOT}/{week}/learning-record.json"


def report_relative_path(week: str) -> str:
    if not SAFE_WEEK_RE.fullmatch(week):
        raise WeeklyLearningError("复盘周标识无效")
    return f"{WEEKLY_ROOT}/{week}/weekly-review.md"


def load_record(project: Path, relative_path: str) -> tuple[Path, dict[str, Any]]:
    relative = safe_relative_path(relative_path, SAFE_RECORD_PATH_RE)
    path = project_file(project, relative, must_exist=True)
    record = read_json_file(path)
    if not record or record.get("schema") != RECORD_SCHEMA:
        raise WeeklyLearningError("每周复盘记录格式无效")
    if relative != record_relative_path(str(record.get("week") or "")):
        raise WeeklyLearningError("每周复盘记录路径与周标识不一致")
    if not isinstance(record.get("items"), list):
        raise WeeklyLearningError("每周复盘记录缺少发布项")
    return path, record


def weekly_record_paths(project: Path) -> list[Path]:
    root = project / WEEKLY_ROOT
    if not root.exists() or root.is_symlink():
        return []
    paths: list[Path] = []
    for candidate in root.glob("*/learning-record.json"):
        try:
            relative = relative_to_project(project, candidate)
        except ValueError:
            continue
        if SAFE_RECORD_PATH_RE.fullmatch(relative) and not candidate.is_symlink() and candidate.is_file():
            paths.append(candidate)
    return sorted(paths)


def completed_record_ids(project: Path, except_week: str = "") -> set[str]:
    seen: set[str] = set()
    for path in weekly_record_paths(project):
        record = read_json_file(path)
        if not record or record.get("schema") != RECORD_SCHEMA or record.get("week") == except_week:
            continue
        if record.get("status") not in {"completed", "memory_applied"}:
            continue
        for item in record.get("items") or []:
            if isinstance(item, dict) and isinstance(item.get("source_record_id"), str):
                seen.add(item["source_record_id"])
    return seen


def _current_project_sha256(
    project: Path,
    relative_path: str,
    *,
    label: str,
    cache: dict[str, str],
) -> str:
    if relative_path not in cache:
        cache[relative_path] = hashlib.sha256(read_regular_project_bytes(
            project,
            relative_path,
            label=label,
            maximum_bytes=MAX_PROVENANCE_ASSET_BYTES,
        )).hexdigest()
    return cache[relative_path]


def verified_visual_assets(
    project: Path,
    value: Any,
    *,
    label: str,
    hash_cache: dict[str, str],
) -> list[dict[str, str]]:
    if not isinstance(value, list):
        raise WeeklyLearningError(f"{label}缺少采用视觉清单")
    result: list[dict[str, str]] = []
    seen_paths: set[str] = set()
    for index, asset in enumerate(value):
        if not isinstance(asset, dict) or set(asset) - {"id", "path", "sha256", "role"}:
            raise WeeklyLearningError(f"{label}包含无效视觉资产")
        raw_path = asset.get("path")
        expected_sha256 = asset.get("sha256")
        if not isinstance(raw_path, str) or not isinstance(expected_sha256, str):
            raise WeeklyLearningError(f"{label}包含无效视觉资产路径或哈希")
        path = safe_relative_path(raw_path.replace("\\", "/"))
        expected_sha256 = expected_sha256.strip().lower()
        if (
            not path.startswith("pipeline/visual/")
            or path in seen_paths
            or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256)
        ):
            raise WeeklyLearningError(f"{label}包含不受支持或重复的视觉资产")
        entry: dict[str, str] = {"path": path, "sha256": expected_sha256}
        for optional in ("id", "role"):
            if optional not in asset:
                continue
            optional_value = asset.get(optional)
            if not isinstance(optional_value, str) or not optional_value.strip() or len(optional_value) > 160:
                raise WeeklyLearningError(f"{label}第 {index + 1} 项的 {optional} 无效")
            entry[optional] = optional_value
        actual_sha256 = _current_project_sha256(
            project,
            path,
            label="发布采用视觉",
            cache=hash_cache,
        )
        if not hmac.compare_digest(actual_sha256, expected_sha256):
            raise WeeklyLearningError("发布采用视觉文件已变化，必须回到发布台重新确认")
        seen_paths.add(path)
        result.append(entry)
    return result


def parse_published_at(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(ZoneInfo(TIMEZONE_NAME))


def verified_publication_proof(
    project: Path,
    source: dict[str, Any],
    *,
    hash_cache: dict[str, str],
) -> tuple[str, str] | None:
    """Return a current proof, rejecting a partial or stale proof binding."""
    raw_path = source.get("proof_path")
    raw_sha256 = source.get("proof_sha256")
    if (raw_path is None or raw_path == "") and (raw_sha256 is None or raw_sha256 == ""):
        return None
    if not isinstance(raw_path, str) or not isinstance(raw_sha256, str):
        raise WeeklyLearningError("发布凭证路径与哈希必须同时存在")
    path = safe_relative_path(raw_path.strip().replace("\\", "/"))
    expected_sha256 = raw_sha256.strip().lower()
    if not PUBLISH_PROOF_PATH_RE.fullmatch(path) or not re.fullmatch(r"[a-f0-9]{64}", expected_sha256):
        raise WeeklyLearningError("发布凭证路径或哈希无效")
    actual_sha256 = _current_project_sha256(
        project,
        path,
        label="发布凭证",
        cache=hash_cache,
    )
    if not hmac.compare_digest(actual_sha256, expected_sha256):
        raise WeeklyLearningError("发布凭证文件已变化，必须重新人工确认")
    return path, actual_sha256


def _valid_public_url(value: Any) -> str:
    if value is None or value == "":
        return ""
    if not isinstance(value, str) or value != value.strip() or any(char.isspace() for char in value):
        raise WeeklyLearningError("发布链接格式无效")
    try:
        parsed = urlsplit(value)
    except ValueError as exc:
        raise WeeklyLearningError("发布链接格式无效") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise WeeklyLearningError("发布链接必须是有效的 http/https 地址")
    return value


def load_valid_publication_binding(
    project: Path,
    ledger_relative_path: str,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, dict[str, Any]]]:
    """Load and verify one ledger -> queue -> jobs -> evidence provenance chain."""
    ledger_relative = safe_relative_path(ledger_relative_path, SAFE_LEDGER_PATH_RE)
    ledger = read_project_json(project, ledger_relative, label="发布台账")
    if ledger.get("schema") != PUBLICATION_LEDGER_SCHEMA:
        raise WeeklyLearningError("发布台账 schema 无效")
    run_id = ledger.get("run_id")
    run_slug = ledger.get("run_slug")
    queue_id = ledger.get("queue_id")
    if (
        not isinstance(run_id, str)
        or not isinstance(run_slug, str)
        or not isinstance(queue_id, str)
        or not SAFE_RUN_ID_RE.fullmatch(run_id)
        or not SAFE_RUN_ID_RE.fullmatch(run_slug)
        or not SAFE_RUN_ID_RE.fullmatch(queue_id)
        or ledger_relative != f"{LEDGER_ROOT}/{run_slug}/publication-ledger.json"
    ):
        raise WeeklyLearningError("发布台账的 run 或 queue 归属无效")
    queue_sha256 = ledger.get("queue_sha256")
    queue_contract_sha256 = ledger.get("queue_contract_sha256")
    if (
        not isinstance(queue_sha256, str)
        or not re.fullmatch(r"[a-f0-9]{64}", queue_sha256)
        or not isinstance(queue_contract_sha256, str)
        or not re.fullmatch(r"[a-f0-9]{64}", queue_contract_sha256)
    ):
        raise WeeklyLearningError("发布台账缺少有效的草稿队列契约哈希")
    raw_queue_path = ledger.get("queue_path")
    if not isinstance(raw_queue_path, str):
        raise WeeklyLearningError("发布台账缺少草稿队列路径")
    queue_relative = safe_relative_path(raw_queue_path.replace("\\", "/"))
    if queue_relative != f"materials/publication/drafts/{run_slug}/draft-queue.json":
        raise WeeklyLearningError("发布台账引用的不是当前 run 规范草稿队列")
    queue = read_project_json(project, queue_relative, label="发布草稿队列")
    if (
        queue.get("schema") != DRAFT_QUEUE_SCHEMA
        or queue.get("queue_id") != queue_id
        or queue.get("run_id") != run_id
        or queue.get("run_slug") != run_slug
    ):
        raise WeeklyLearningError("发布草稿队列的 schema、run 或 queue 归属与台账不一致")
    actual_contract_sha256 = draft_queue_contract_sha256(queue)
    if not hmac.compare_digest(actual_contract_sha256, queue_contract_sha256):
        raise WeeklyLearningError("发布草稿队列契约已变化，旧台账不能进入长期学习")

    jobs = queue.get("jobs")
    if not isinstance(jobs, list):
        raise WeeklyLearningError("发布草稿队列缺少 jobs")
    jobs_by_id: dict[str, dict[str, Any]] = {}
    for job in jobs:
        if not isinstance(job, dict):
            raise WeeklyLearningError("发布草稿队列包含无效任务")
        job_id = job.get("job_id")
        platform = job.get("platform")
        item_id = job.get("item_id")
        content_hash = job.get("content_hash")
        payload_hash = job.get("payload_hash")
        if (
            not isinstance(job_id, str)
            or not SAFE_RUN_ID_RE.fullmatch(job_id)
            or job_id in jobs_by_id
            or not isinstance(platform, str)
            or platform not in REQUIRED_METRICS
            or not isinstance(item_id, str)
            or not item_id
            or not isinstance(content_hash, str)
            or not re.fullmatch(r"[a-f0-9]{64}", content_hash)
            or not isinstance(payload_hash, str)
            or not re.fullmatch(r"[a-f0-9]{64}", payload_hash)
        ):
            raise WeeklyLearningError("发布草稿队列包含无效或重复的任务身份")
        jobs_by_id[job_id] = job

    records = ledger.get("records")
    if not isinstance(records, list):
        raise WeeklyLearningError("发布台账缺少 records")
    hash_cache: dict[str, str] = {}
    records_by_id: dict[str, dict[str, Any]] = {}
    seen_job_ids: set[str] = set()
    for source in records:
        if not isinstance(source, dict):
            raise WeeklyLearningError("发布台账包含无效记录")
        record_id = source.get("record_id")
        job_id = source.get("job_id")
        if (
            not isinstance(record_id, str)
            or not SAFE_RUN_ID_RE.fullmatch(record_id)
            or record_id in records_by_id
            or not isinstance(job_id, str)
            or job_id in seen_job_ids
            or source.get("human_confirmed") is not True
            or source.get("queue_id") != queue_id
        ):
            raise WeeklyLearningError("发布台账包含无效、重复或未经人工确认的记录")
        job = jobs_by_id.get(job_id)
        if not job:
            raise WeeklyLearningError("发布台账引用了当前草稿队列中不存在的任务")
        if (
            source.get("platform") != job.get("platform")
            or source.get("item_id") != job.get("item_id")
            or source.get("final_content_hash") != job.get("content_hash")
            or source.get("payload_hash") != job.get("payload_hash")
        ):
            raise WeeklyLearningError("发布台账记录与当前草稿任务的内容或 payload 哈希不一致")
        queue_assets = verified_visual_assets(
            project,
            job.get("selected_asset_hashes"),
            label="草稿任务",
            hash_cache=hash_cache,
        )
        record_assets = verified_visual_assets(
            project,
            source.get("selected_asset_hashes"),
            label="发布台账记录",
            hash_cache=hash_cache,
        )
        if queue_assets != record_assets:
            raise WeeklyLearningError("发布台账记录与草稿任务采用的视觉资产不一致")
        published_url = _valid_public_url(source.get("published_url"))
        proof = verified_publication_proof(project, source, hash_cache=hash_cache)
        if not published_url and not proof:
            raise WeeklyLearningError("发布台账记录缺少可验证链接或本地凭证")
        published_at = parse_published_at(source.get("published_at"))
        if not published_at:
            raise WeeklyLearningError("发布台账记录的发布时间无效")
        records_by_id[record_id] = {
            "source": source,
            "job": job,
            "assets": record_assets,
            "published_url": published_url,
            "proof": proof,
            "published_at": published_at,
        }
        seen_job_ids.add(job_id)
    return ledger, queue, records_by_id


def publication_items(project: Path, now: datetime, excluded_ids: set[str]) -> list[dict[str, Any]]:
    root = project / LEDGER_ROOT
    if not root.exists():
        return []
    if root.is_symlink() or not root.is_dir():
        raise WeeklyLearningError("发布台账目录必须是项目内普通目录")
    items: list[dict[str, Any]] = []
    for ledger_path in sorted(root.glob("*/publication-ledger.json")):
        try:
            ledger_relative_path = ledger_path.relative_to(project).as_posix()
        except ValueError as exc:
            raise WeeklyLearningError("发布台账路径不在当前项目内") from exc
        ledger, _queue, bound_records = load_valid_publication_binding(project, ledger_relative_path)
        run_id = str(ledger.get("run_id") or "").strip()
        run_slug = str(ledger.get("run_slug") or "").strip()
        queue_id = str(ledger.get("queue_id") or "").strip()
        for record_id, binding in bound_records.items():
            source = binding["source"]
            platform = str(source.get("platform") or "")
            published_url = binding["published_url"]
            proof = binding["proof"]
            published_at = binding["published_at"]
            if record_id in excluded_ids or published_at > now:
                continue
            items.append({
                "source_record_id": record_id,
                "source_ledger_path": ledger_relative_path,
                "run_id": run_id,
                "run_slug": run_slug,
                "queue_id": queue_id,
                "platform": platform,
                "item_id": str(source.get("item_id") or "")[:120],
                "published_url": published_url,
                **({"proof_path": proof[0], "proof_sha256": proof[1]} if proof else {}),
                "published_at": timestamp(published_at),
                "final_content_hash": str(source.get("final_content_hash") or ""),
                "adopted_visual_assets": binding["assets"],
                "required_metrics": list(REQUIRED_METRICS[platform]),
                "metrics": {},
                "comment_samples": [],
            })
    return sorted(items, key=lambda item: (item["published_at"], item["source_record_id"]))


def validate_weekly_record_provenance(project: Path, record: dict[str, Any]) -> None:
    """Revalidate every weekly item against live ledger, queue and evidence.

    A weekly JSON file is mutable while the operator enters metrics. It is not
    itself an immutable evidence source, so no record/complete/apply operation
    may trust the provenance fields copied into it during collection.
    """
    items = record.get("items")
    if not isinstance(items, list):
        raise WeeklyLearningError("每周复盘记录缺少发布项")
    if not items:
        return
    loaded: dict[str, tuple[dict[str, Any], dict[str, Any], dict[str, dict[str, Any]]]] = {}
    expected_run_bindings: set[tuple[str, str, str, str]] = set()
    seen_record_ids: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            raise WeeklyLearningError("每周复盘记录包含无效发布项")
        ledger_relative = item.get("source_ledger_path")
        source_record_id = item.get("source_record_id")
        if not isinstance(ledger_relative, str) or not isinstance(source_record_id, str):
            raise WeeklyLearningError("每周复盘发布项缺少来源台账或记录 ID")
        ledger_relative = safe_relative_path(ledger_relative, SAFE_LEDGER_PATH_RE)
        if source_record_id in seen_record_ids:
            raise WeeklyLearningError("每周复盘包含重复发布记录")
        seen_record_ids.add(source_record_id)
        if ledger_relative not in loaded:
            loaded[ledger_relative] = load_valid_publication_binding(project, ledger_relative)
        ledger, _queue, source_records = loaded[ledger_relative]
        binding = source_records.get(source_record_id)
        if not binding:
            raise WeeklyLearningError("每周复盘引用的发布记录已不存在或不属于当前队列")
        source = binding["source"]
        expected = {
            "run_id": ledger["run_id"],
            "run_slug": ledger["run_slug"],
            "queue_id": ledger["queue_id"],
            "platform": source["platform"],
            "item_id": source["item_id"],
            "published_url": binding["published_url"],
            "published_at": timestamp(binding["published_at"]),
            "final_content_hash": source["final_content_hash"],
            "adopted_visual_assets": binding["assets"],
        }
        for field, expected_value in expected.items():
            if item.get(field) != expected_value:
                raise WeeklyLearningError(f"每周复盘发布项的 {field} 与当前发布证据不一致")
        proof = binding["proof"]
        expected_proof_path = proof[0] if proof else ""
        expected_proof_sha256 = proof[1] if proof else ""
        if (
            str(item.get("proof_path") or "") != expected_proof_path
            or str(item.get("proof_sha256") or "") != expected_proof_sha256
        ):
            raise WeeklyLearningError("每周复盘引用的发布凭证与当前台账不一致")
        expected_run_bindings.add((
            str(ledger["run_id"]),
            str(ledger["run_slug"]),
            str(ledger["queue_id"]),
            ledger_relative,
        ))

    actual_run_bindings = record.get("run_bindings")
    expected_binding_items = [
        {
            "run_id": run_id,
            "run_slug": run_slug,
            "queue_id": queue_id,
            "source_ledger_path": ledger_relative,
        }
        for run_id, run_slug, queue_id, ledger_relative in sorted(expected_run_bindings)
    ]
    if actual_run_bindings != expected_binding_items:
        raise WeeklyLearningError("每周复盘的 run 绑定与当前发布证据不一致")


def performance_evidence(project: Path) -> dict[str, dict[str, Any]]:
    root = project / PERFORMANCE_INPUT_ROOT
    if not root.exists() or root.is_symlink():
        return {}
    evidence: dict[str, dict[str, Any]] = {}
    for path in root.glob("*.json"):
        value = read_json_file(path)
        if not value:
            continue
        if value.get("review_status") not in {"review-ready", "completed"}:
            continue
        if value.get("evidence_status") not in {"bound", "legacy"}:
            continue
        publish_url = str(value.get("publish_url") or "").strip()
        performance = value.get("performance") if isinstance(value.get("performance"), dict) else {}
        if not publish_url or not isinstance(performance, dict):
            continue
        metrics = performance.get("metrics") if isinstance(performance.get("metrics"), dict) else {}
        normalized: dict[str, int | float] = {}
        for key, metric_value in metrics.items():
            metric = normalize_metric_key(key)
            if metric not in ALLOWED_METRICS:
                continue
            try:
                normalized[metric] = parse_metric_value(metric_value)
            except WeeklyLearningError:
                continue
        comments = value.get("comment_samples")
        if not isinstance(comments, list):
            comments = performance.get("comment_samples") if isinstance(performance.get("comment_samples"), list) else []
        evidence[publish_url] = {
            "metrics": normalized,
            "comments": [redact_comment(item.get("content") if isinstance(item, dict) else item) for item in comments][:10],
            "source_path": relative_to_project(project, path),
            "captured_at": str(value.get("captured_at") or ""),
        }
    return evidence


def _canonical_url(value: str) -> str:
    # Query strings can rotate on public share links.  They are preserved in
    # raw TikOmni input, but not required for an evidence identity match.
    return str(value or "").strip().split("#", 1)[0].rstrip("/")


def _urls_match(left: str, right: str) -> bool:
    first = _canonical_url(left)
    second = _canonical_url(right)
    return bool(first and second and (first == second or first.startswith(second) or second.startswith(first)))


def _url_values(platform: str, url: str) -> dict[str, Any]:
    values: dict[str, Any] = {name: url for name in PUBLIC_URL_PARAM_NAMES}
    if platform == "xiaohongshu":
        match = XHS_NOTE_ID_RE.search(url)
        if match:
            values["note_id"] = match.group(1)
    values["raw"] = False
    return values


def _params_for_public_url(schema: dict[str, Any], platform: str, url: str) -> dict[str, Any] | None:
    properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
    required = set(schema.get("required") or []) if isinstance(schema.get("required"), list) else set()
    values = _url_values(platform, url)
    params = {name: values[name] for name in properties if name in values and values[name] not in (None, "")}
    if not required.issubset(params):
        return None
    identity_fields = set(PUBLIC_URL_PARAM_NAMES) | {"note_id"}
    return params if identity_fields.intersection(params) else None


def _endpoint_candidates(bridge: TikomniApiBridge, platform: str, capability: str) -> list[dict[str, Any]]:
    resolved = bridge.resolve_endpoint_options(platform, capability)
    recommended = resolved.get("recommended") if isinstance(resolved.get("recommended"), dict) else {}
    alternatives = resolved.get("alternatives") if isinstance(resolved.get("alternatives"), list) else []
    candidates = [candidate for candidate in [recommended, *alternatives] if isinstance(candidate, dict) and candidate.get("endpoint_id")]
    # Stay inside the resolver's returned catalog, but prefer a public metric
    # variant before a metadata-only detail variant when both are available.
    return sorted(
        candidates,
        key=lambda candidate: (
            0 if re.search(r"(?:stat|read_count|note_info)", str(candidate.get("endpoint_id") or ""), re.IGNORECASE) else 1,
        ),
    )


def _unavailable_public_evidence(reason: str, *, captured: str = "") -> dict[str, Any]:
    return {
        "status": "unavailable",
        "source": "tikomni_live",
        "metrics": {},
        "comments": [],
        "source_path": "",
        "captured_at": captured,
        "endpoint_id": "",
        "reason": reason,
    }


def collect_tikomni_public_performance(
    project: Path | str,
    items: Iterable[dict[str, Any]],
    *,
    bridge: TikomniApiBridge | None = None,
) -> dict[str, dict[str, Any]]:
    """Collect visible performance evidence from each publication-ledger URL.

    Failures are deliberately returned as a per-item unavailable state rather
    than an exception: review remains optional and the missing-metrics form is
    the honest fallback.  In contrast, topic-time research keeps its separate
    strict hard gate.
    """
    root = Path(project).expanduser().resolve(strict=False)
    candidates = [item for item in items if isinstance(item, dict) and str(item.get("published_url") or "").startswith(("http://", "https://"))]
    if not candidates:
        return {}
    client = bridge or TikomniApiBridge(root)
    captured = timestamp()
    try:
        health = client.credential_status()
    except Exception as exc:
        health = {"available": False, "reason": str(exc)}
    if not health.get("available"):
        reason = "TikOmni Token 未配置、无效或当前不可用；请手工补录缺失指标。"
        return {str(item["published_url"]): _unavailable_public_evidence(reason, captured=captured) for item in candidates}

    def collect_item(item: dict[str, Any]) -> tuple[str, dict[str, Any]]:
        url = str(item["published_url"])
        platform = str(item.get("platform") or "")
        source = PUBLIC_PERFORMANCE_SOURCES.get(platform)
        if not source:
            return url, _unavailable_public_evidence("当前平台没有可验证的 TikOmni 公开 URL 指标接口；请手工补录。", captured=captured)
        canonical_platform, capability = source
        failures: list[str] = []
        evidence: dict[str, Any] | None = None
        metadata_only_evidence: dict[str, Any] | None = None
        try:
            endpoint_candidates = _endpoint_candidates(client, canonical_platform, capability)
        except Exception as exc:
            endpoint_candidates = []
            failures.append(str(exc))
        # One resolver-approved endpoint is one evidence attempt. Trying every
        # fallback turns an optional review into a serial retry loop, while a
        # later operator-triggered collection remains available for retrying.
        for candidate in endpoint_candidates[:1]:
            endpoint_id = str(candidate.get("endpoint_id") or "")
            try:
                schema = client.endpoint_input_schema(endpoint_id)
                params = _params_for_public_url(schema, platform, url)
                if params is None:
                    continue
                fetched = client.fetch(
                    endpoint_id,
                    params,
                    canonical_platform,
                    kind="weekly-performance",
                    timeout_ms=PUBLIC_PERFORMANCE_TIMEOUT_MS,
                )
                raw_relative = str(fetched.get("raw_path") or "")
                raw_path = project_file(root, raw_relative, must_exist=True)
                raw_payload = client.payload_for_import(raw_path)
                rows = normalized_items(raw_payload)
                if not rows:
                    raise WeeklyLearningError("TikOmni 返回的公开 URL 数据没有可归一化作品项")
                selected = rows[0]
                returned_url = infer_url(normalize_tikomni_platform(canonical_platform), selected)
                if returned_url and not _urls_match(url, returned_url):
                    raise WeeklyLearningError("TikOmni 返回的作品链接与发布台账 URL 不匹配")
                metrics = infer_metrics(normalize_tikomni_platform(canonical_platform), selected)
                candidate_evidence = {
                    "status": "available",
                    "source": "tikomni_live",
                    "metrics": metrics,
                    "comments": [],
                    "source_path": raw_relative,
                    "captured_at": captured,
                    "endpoint_id": endpoint_id,
                    "reason": "已按发布台账 URL 取得 TikOmni 公开可见字段；未返回的关键指标仍需手工补录。",
                }
                # A resolver can legitimately recommend a detail endpoint
                # before a stats-capable variant. Keep its URL-bound evidence
                # as a last resort, but continue through resolver-approved
                # alternatives until visible metrics are actually available.
                if metrics:
                    evidence = candidate_evidence
                    break
                metadata_only_evidence = candidate_evidence
            except Exception as exc:
                failures.append(f"{endpoint_id}: {exc}")
        return url, evidence or metadata_only_evidence or _unavailable_public_evidence(
            "TikOmni 未找到可安全执行的公开 URL 查询：" + ("；".join(failures[:2]) or "当前 catalog 不支持该链接。"),
            captured=captured,
        )

    result: dict[str, dict[str, Any]] = {}
    worker_count = min(PUBLIC_PERFORMANCE_MAX_WORKERS, len(candidates))
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        futures = {
            executor.submit(collect_item, item): str(item["published_url"])
            for item in candidates
        }
        for future in as_completed(futures):
            try:
                url, evidence = future.result()
            except Exception as exc:
                # `collect_item` handles per-platform failures itself. This is
                # only a last-resort guard for unexpected worker failures.
                url = futures[future]
                result[url] = _unavailable_public_evidence(
                    f"TikOmni 公开数据采集异常：{exc}",
                    captured=captured,
                )
                continue
            result[url] = evidence
    return result


def deferred_public_performance(
    _project: Path,
    _items: Iterable[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Build a weekly record without contacting TikOmni during page load."""
    return {}


def merge_existing_item(item: dict[str, Any], previous: dict[str, Any], evidence_sources: Iterable[dict[str, Any]], now: datetime) -> dict[str, Any]:
    result = {**item}
    sources = [source for source in evidence_sources if isinstance(source, dict)]
    previous_collection = previous.get("public_collection") if isinstance(previous.get("public_collection"), dict) else None
    if previous_collection:
        result["public_collection"] = previous_collection
    previous_metrics = previous.get("metrics") if isinstance(previous.get("metrics"), dict) else {}
    copied_metrics: dict[str, dict[str, Any]] = {}
    for key, metric in previous_metrics.items():
        if key not in ALLOWED_METRICS or not isinstance(metric, dict):
            continue
        try:
            value = parse_metric_value(metric.get("value"))
        except WeeklyLearningError:
            continue
        source = str(metric.get("source") or "")
        if source not in {"manual_operator", "performance_evidence", "tikomni_live"}:
            continue
        copied_metrics[key] = {
            "value": value,
            "source": source,
            "recorded_at": str(metric.get("recorded_at") or timestamp(now)),
            **({"evidence_path": str(metric["evidence_path"])} if metric.get("evidence_path") else {}),
        }
    for evidence in sources:
        for metric, value in evidence.get("metrics", {}).items():
            # Direct operator entries always win over a later imported value.
            if copied_metrics.get(metric, {}).get("source") == "manual_operator":
                continue
            copied_metrics[metric] = {
                "value": value,
                "source": str(evidence.get("source") or "performance_evidence"),
                "recorded_at": timestamp(now),
                "evidence_path": evidence.get("source_path", ""),
            }
        if evidence.get("source") == "tikomni_live":
            result["public_collection"] = {
                "status": "available" if evidence.get("status") == "available" else "unavailable",
                "captured_at": str(evidence.get("captured_at") or timestamp(now)),
                "endpoint_id": str(evidence.get("endpoint_id") or ""),
                "raw_path": str(evidence.get("source_path") or ""),
                "reason": str(evidence.get("reason") or ""),
            }
    result["metrics"] = copied_metrics
    previous_comments = previous.get("comment_samples") if isinstance(previous.get("comment_samples"), list) else []
    comments = [redact_comment(item.get("content") if isinstance(item, dict) else item) for item in previous_comments]
    if not comments:
        for evidence in sources:
            comments = [redact_comment(item) for item in evidence.get("comments", [])]
            if comments:
                break
    result["comment_samples"] = [item for item in comments if item][:10]
    return result


def missing_metrics(record: dict[str, Any]) -> list[dict[str, str]]:
    missing: list[dict[str, str]] = []
    for item in record.get("items") or []:
        if not isinstance(item, dict):
            continue
        metric_values = item.get("metrics") if isinstance(item.get("metrics"), dict) else {}
        for metric in item.get("required_metrics") or []:
            if not isinstance(metric, str):
                continue
            metric_value = metric_values.get(metric)
            if not isinstance(metric_value, dict) or "value" not in metric_value:
                missing.append({
                    "source_record_id": str(item.get("source_record_id") or ""),
                    "platform": str(item.get("platform") or ""),
                    "metric": metric,
                    "label": METRIC_LABELS.get(metric, metric),
                })
    return missing


def normalize_record_status(record: dict[str, Any]) -> str:
    if not record.get("items"):
        return "no_publications"
    if missing_metrics(record):
        return "waiting_metrics"
    if record.get("report_path"):
        return "memory_applied" if record.get("memory_applied_at") else "completed"
    return "ready"


def record_summary(project: Path, record: dict[str, Any], schedule: dict[str, Any], now: datetime) -> dict[str, Any]:
    week = str(record.get("week") or "")
    relative = record_relative_path(week)
    missing = missing_metrics(record)
    reminder_due = (
        record.get("status") in {"waiting_metrics", "ready"}
        and schedule.get("last_notified_week") != week
        and bool(record.get("items"))
    )
    if not record.get("items"):
        reminder_message = "本周没有已确认发布结果。"
    elif missing:
        reminder_message = f"本周还有 {len(missing)} 项发布数据没填。"
    else:
        reminder_message = "数据已填完，可以生成本周复盘。"
    return {
        "record_path": relative,
        "record": record,
        "run_bindings": list(record.get("run_bindings") or []),
        "missing_metrics": missing,
        "reminder": {
            "should_notify": reminder_due,
            "week": week,
            "record_path": relative,
            "message": reminder_message,
        },
        "schedule": schedule,
        "checked_at": timestamp(now),
    }


def collect_weekly_review(
    project: Path | str,
    *,
    now: str | None = None,
    force: bool = False,
    public_performance_collector: Callable[[Path, Iterable[dict[str, Any]]], dict[str, dict[str, Any]]] | None = None,
) -> dict[str, Any]:
    root = Path(project).expanduser().resolve(strict=False)
    current = local_now(now)
    schedule = load_schedule(root, current)
    schedule["last_checked_at"] = timestamp(current)
    due = force or current >= scheduled_at(schedule, current)
    week = iso_week(current)
    path = project_file(root, record_relative_path(week))
    existing = read_json_file(path) or {}
    if existing:
        if existing.get("schema") != RECORD_SCHEMA or existing.get("week") != week:
            raise WeeklyLearningError("现有每周复盘记录格式或周标识无效")
        validate_weekly_record_provenance(root, existing)

    if not due and not existing:
        atomic_write_json(schedule_path(root), schedule)
        return {
            "status": "not_due",
            "week": week,
            "schedule": schedule,
            "next_scheduled_at": timestamp(scheduled_at(schedule, current)),
            "checked_at": timestamp(current),
        }

    previous_items = {
        str(item.get("source_record_id")): item
        for item in existing.get("items", [])
        if isinstance(item, dict) and item.get("source_record_id")
    }
    excluded = completed_record_ids(root, except_week=week)
    evidence_by_url = performance_evidence(root)
    published = publication_items(root, current, excluded)
    try:
        live_evidence_by_url = (public_performance_collector or collect_tikomni_public_performance)(root, published)
    except Exception as exc:
        # A scheduled optional review must never stop the production system.
        # Preserve a visible per-item failure instead of silently treating it
        # as a successful zero-metric collection.
        live_evidence_by_url = {
            str(item["published_url"]): _unavailable_public_evidence(f"TikOmni 周度公开数据采集失败：{exc}", captured=timestamp(current))
            for item in published
            if str(item.get("published_url") or "").startswith(("http://", "https://"))
        }
    items: list[dict[str, Any]] = []
    for item in published:
        previous = previous_items.get(item["source_record_id"], {})
        published_url = str(item.get("published_url") or "")
        evidence_sources = [
            source for source in [
                evidence_by_url.get(published_url) if published_url else None,
                live_evidence_by_url.get(published_url) if published_url else None,
            ] if isinstance(source, dict)
        ]
        items.append(merge_existing_item(item, previous, evidence_sources, current))

    items.sort(key=lambda item: (str(item.get("published_at") or ""), str(item.get("source_record_id") or "")))

    run_bindings = sorted(
        {
            (
                str(item.get("run_id") or ""),
                str(item.get("run_slug") or ""),
                str(item.get("queue_id") or ""),
                str(item.get("source_ledger_path") or ""),
            )
            for item in items
            if (
                isinstance(item, dict)
                and item.get("run_id")
                and item.get("run_slug")
                and item.get("queue_id")
                and item.get("source_ledger_path")
            )
        }
    )

    record = {
        "schema": RECORD_SCHEMA,
        "record_id": str(existing.get("record_id") or f"weekly_{digest_json({'project': str(root), 'week': week})[:20]}"),
        "week": week,
        "timezone": TIMEZONE_NAME,
        "created_at": str(existing.get("created_at") or timestamp(current)),
        "updated_at": timestamp(current),
        "run_bindings": [
            {
                "run_id": run_id,
                "run_slug": run_slug,
                "queue_id": queue_id,
                "source_ledger_path": source_ledger_path,
            }
            for run_id, run_slug, queue_id, source_ledger_path in run_bindings
        ],
        "items": items,
        "report_path": str(existing.get("report_path") or ""),
        "report_sha256": str(existing.get("report_sha256") or ""),
        "completed_at": str(existing.get("completed_at") or ""),
        "memory_applied_at": str(existing.get("memory_applied_at") or ""),
        "memory_paths": list(existing.get("memory_paths") or []),
    }
    record["status"] = normalize_record_status(record)
    if record["status"] != "completed" and record["status"] != "memory_applied":
        record["report_path"] = ""
        record["report_sha256"] = ""
        record["completed_at"] = ""
        record["memory_applied_at"] = ""
        record["memory_paths"] = []
    validate_weekly_record_provenance(root, record)
    atomic_write_json(path, record)
    atomic_write_json(schedule_path(root), schedule)
    return {"status": record["status"], **record_summary(root, record, schedule, current)}


def record_manual_metrics(
    project: Path | str,
    *,
    record_path: str,
    updates: dict[str, Any],
    now: str | None = None,
) -> dict[str, Any]:
    root = Path(project).expanduser().resolve(strict=False)
    current = local_now(now)
    path, record = load_record(root, record_path)
    validate_weekly_record_provenance(root, record)
    if record.get("status") in {"completed", "memory_applied"}:
        raise WeeklyLearningError("已完成的复盘不可直接改写；请在下一周重新采集")
    if not isinstance(updates, dict):
        raise WeeklyLearningError("手工指标输入格式无效")
    item_by_id = {
        str(item.get("source_record_id")): item
        for item in record.get("items") or []
        if isinstance(item, dict)
    }
    for record_id, update in updates.items():
        item = item_by_id.get(str(record_id))
        if not item or not isinstance(update, dict):
            raise WeeklyLearningError("指标输入包含非本周发布项")
        metric_updates = update.get("metrics") if isinstance(update.get("metrics"), dict) else {}
        metric_values = item.setdefault("metrics", {})
        allowed = set(item.get("required_metrics") or []) | ALLOWED_METRICS
        for raw_key, raw_value in metric_updates.items():
            metric = normalize_metric_key(raw_key)
            if metric not in allowed:
                raise WeeklyLearningError(f"不支持的指标：{metric}")
            metric_values[metric] = {
                "value": parse_metric_value(raw_value),
                "source": "manual_operator",
                "recorded_at": timestamp(current),
            }
        if "comments" in update:
            raw_comments = update.get("comments")
            if not isinstance(raw_comments, list) or len(raw_comments) > 10:
                raise WeeklyLearningError("评论样本必须为不超过 10 条的列表")
            item["comment_samples"] = [
                comment for comment in (redact_comment(value) for value in raw_comments) if comment
            ][:10]
    record["updated_at"] = timestamp(current)
    record["status"] = normalize_record_status(record)
    atomic_write_json(path, record)
    schedule = load_schedule(root, current)
    schedule["last_checked_at"] = timestamp(current)
    atomic_write_json(schedule_path(root), schedule)
    return {"status": record["status"], **record_summary(root, record, schedule, current)}


def all_metrics(item: dict[str, Any]) -> dict[str, int | float]:
    metrics = item.get("metrics") if isinstance(item.get("metrics"), dict) else {}
    result: dict[str, int | float] = {}
    for key, value in metrics.items():
        if key not in ALLOWED_METRICS or not isinstance(value, dict):
            continue
        try:
            result[key] = parse_metric_value(value.get("value"))
        except WeeklyLearningError:
            continue
    return result


def aggregate_by_platform(items: Iterable[dict[str, Any]]) -> dict[str, dict[str, int | float]]:
    totals: dict[str, dict[str, int | float]] = {}
    for item in items:
        platform = str(item.get("platform") or "")
        target = totals.setdefault(platform, {})
        for metric, value in all_metrics(item).items():
            target[metric] = target.get(metric, 0) + value
    return totals


def estimated_interactions(metrics: dict[str, int | float]) -> int | float:
    return sum(metrics.get(key, 0) for key in ("likes", "wows", "shares", "collects", "comments"))


def observation_lines(totals: dict[str, dict[str, int | float]]) -> list[str]:
    lines: list[str] = []
    for platform, metrics in totals.items():
        exposure = metrics.get("reads", metrics.get("plays", metrics.get("exposures", 0)))
        interaction = estimated_interactions(metrics)
        leads = metrics.get("leads", 0)
        lines.append(
            f"- {PLATFORM_LABELS.get(platform, platform)}：可观察量 {format_metric(exposure)}，互动 {format_metric(interaction)}，线索 {format_metric(leads)}；仅记录相关性，不将其视为因果归因。"
        )
    return lines or ["- 本周没有可用发布结果，不形成跨平台归因。"]


def compact_comment_samples(items: Iterable[dict[str, Any]]) -> list[str]:
    result: list[str] = []
    for item in items:
        platform = PLATFORM_LABELS.get(str(item.get("platform") or ""), str(item.get("platform") or ""))
        for comment in item.get("comment_samples") or []:
            cleaned = redact_comment(comment)
            if cleaned:
                result.append(f"- {platform}评论样本：{cleaned}")
    return result[:10]


def proposed_memory_write_set(record: dict[str, Any]) -> dict[str, list[str]]:
    totals = aggregate_by_platform(item for item in record.get("items", []) if isinstance(item, dict))
    observed_platforms = "、".join(PLATFORM_LABELS.get(platform, platform) for platform in totals) or "无"
    return {
        "insights": [
            f"{record.get('week')} 已完成真实发布证据汇总，覆盖：{observed_platforms}。",
            "仅将已确认指标作为下期选题假设的输入，不把单周表现解释为因果规律。",
        ],
        "style_evolution": ["本期不从单周指标自动推断文风结论；需结合后续样本复验。"],
        "case_library": ["保留本周已发布链接或本机凭证、采用视觉引用和指标证据，供后续人工检索。"],
        "no_fly_zone": [],
    }


def render_report(record: dict[str, Any], generated_at: datetime) -> str:
    items = [item for item in record.get("items", []) if isinstance(item, dict)]
    totals = aggregate_by_platform(items)
    all_platforms = "、".join(PLATFORM_LABELS.get(platform, platform) for platform in totals) or "无"
    all_dates = [str(item.get("published_at") or "")[:10] for item in items if item.get("published_at")]
    publication_date = "至".join(filter(None, [min(all_dates) if all_dates else "", max(all_dates) if all_dates else ""])) or generated_at.date().isoformat()
    run_bindings = "、".join(
        f"{item.get('run_id')} / {item.get('run_slug')} / {item.get('queue_id')}"
        for item in record.get("run_bindings") or []
        if (
            isinstance(item, dict)
            and item.get("run_id")
            and item.get("run_slug")
            and item.get("queue_id")
        )
    ) or "无"
    metric_rows = []
    for platform, metrics in totals.items():
        metric_rows.append(
            "| {platform} | {reach} | {interaction} | {shares} | {comments} | {leads} |".format(
                platform=PLATFORM_LABELS.get(platform, platform),
                reach=format_metric(metrics.get("reads", metrics.get("plays", metrics.get("exposures", 0)))),
                interaction=format_metric(estimated_interactions(metrics)),
                shares=format_metric(metrics.get("shares", 0)),
                comments=format_metric(metrics.get("comments", 0)),
                leads=format_metric(metrics.get("leads", 0)),
            )
        )
    item_rows = [
        f"| {PLATFORM_LABELS.get(str(item.get('platform')), str(item.get('platform')))} | {item.get('item_id') or '-'} | {item.get('published_url') or item.get('proof_path') or '-'} | {item.get('final_content_hash')} |"
        for item in items
    ]
    comments = compact_comment_samples(items)
    if not comments:
        comments = [
            "- 高频词：本周未录入评论样本，不把空白当作用户观点。",
            "- 提问方式：本周未录入评论样本，下一周优先补充真实问题。",
            "- 情绪/问题：本周无可核验评论证据，不形成情绪判断。",
            "- 争议点：本周无可核验评论证据，不把推测写入长期记忆。",
        ]
    proposal = proposed_memory_write_set(record)
    return f"""# 本周发布复盘 · {record.get('week')}

<!-- {REPORT_SCHEMA} -->

## 0. 内容元信息
- 原文路径：已发布内容证据见本报告中的发布结果台账。
- 发布平台：{all_platforms}
- 发布日期：{publication_date}
- 选题角度：本周已发布内容的真实表现复盘。
- 复盘记录：{record_relative_path(str(record.get('week')))}
- 绑定 Run：{run_bindings}

## 1. 表现记录

| 平台 | 阅读/播放/曝光 | 互动量 | 分享 | 评论 | 线索 |
|---|---:|---:|---:|---:|---:|
{chr(10).join(metric_rows) or '| 无 | 0 | 0 | 0 | 0 | 0 |'}

### 1.1 关键指标解读
{chr(10).join(observation_lines(totals))}

### 1.2 发布结果与采用视觉
| 平台 | 发布项 | 发布链接 | 最终内容哈希 |
|---|---|---|---|
{chr(10).join(item_rows) or '| 无 | - | - | - |'}

### 1.3 数据来源与口径
| 项目 | 说明 |
|---|---|
| 数据源 | 已确认发布台账、授权性能快照与操作者手工记录 |
| 采集时间 | {timestamp(generated_at)} |
| 样本范围 | 本周 {len(items)} 条已确认发布记录；只保留发布链接、采用视觉引用和表现数据 |
| 指标口径 | 阅读/播放/曝光、互动、分享、评论和线索均按对应平台后台或操作者记录口径汇总 |

## 2. 跨平台归因
{chr(10).join(observation_lines(totals))}
- 下次怎么用：只把有数据支持的观察用于查找选题，尚未验证的判断先保留，不复制第三方内容。

## 3. 评论洞察
{chr(10).join(comments)}

## 4. 用户问题归类
| 问题类型 | 数量 | 典型问题 | 是否值得单独成题 |
|---|---:|---|---|
| 待补评论问题 | {sum(len(item.get('comment_samples') or []) for item in items)} | 从已脱敏评论样本中人工确认具体问题 | 评论样本充分后值得单独成题 |
| 互动与转化问题 | {len(items)} | 哪种表达能带来收藏、转发或咨询 | 值得作为下一篇的验证方向 |

## 5. 选题命中率
| 维度 | 本次表现 | 历史基准 | 判断 |
|---|---|---|---|
| 覆盖平台 | {all_platforms} | 历史基准待累计 | 临时观察 |
| 互动信号 | 已按平台汇总 | 历史基准待累计 | 临时观察 |
| 转化线索 | 已按平台汇总 | 历史基准待累计 | 临时观察 |

## 6. 选题优化
- 本次命中点：只使用已确认的发布链接、图片和真实数据，草稿与推测没有算进去。
- 本次失误点：评论太少时，暂时不能判断读者的语言和情绪。下周需要补充真实反馈。
- 可复用：下次优先查看表现较好的平台内容，以及已经在评论或咨询中出现的问题。
- 需要避开：不要只看一周的数据，也不要根据草稿或没有依据的推测决定内容方向。

## 7. 下一条建议
- 推荐选题 1：先看本周互动最高的内容，再补一个真实用户问题，写一篇后续内容。
- 推荐选题 2：如果本周出现了咨询线索，可以写清处理过程和方法，但不要承诺结果。
- 优先级：先写有真实评论或咨询问题支持的选题。没有评论时先收集反馈，不强行下结论。

## 8. 洞察沉淀
待负责人确认后，仅由 `weekly_learning.py` 写入：
- `brain/insights.md`：{proposal['insights'][0]}
- `brain/style-evolution.md`：{proposal['style_evolution'][0]}
- `brain/case-library.md`：{proposal['case_library'][0]}
- `brain/no-fly-zone.md`：本期无未经人工确认的新禁区结论。
"""


def weekly_generated_language_text(report: str) -> str:
    """Select system-authored conclusions, excluding evidence tables and comments."""
    patterns = (
        r"^###\s*1\.1\s+关键指标解读",
        r"^##\s*2\.\s+跨平台归因",
        r"^##\s*6\.\s+选题优化",
        r"^##\s*7\.\s+下一条建议",
        r"^##\s*8\.\s+洞察沉淀",
    )
    sections: list[str] = []
    for pattern in patterns:
        match = re.search(rf"(?ms){pattern}.*?(?=^##\s+|^###\s+|\Z)", report)
        if match:
            sections.append(match.group(0).strip())
    return "\n".join(sections)


def combined_review_quality(report: str) -> dict[str, Any]:
    structure = audit_review(report)
    language = inspect_generated_language(weekly_generated_language_text(report))
    blocking = [
        *list(structure.get("blocking_issues") or []),
        *(item["message"] for item in language["blocking"]),
    ]
    review = [
        *list(structure.get("review_issues") or []),
        *(item["message"] for item in language["warnings"]),
    ]
    return {
        **structure,
        "status": "blocked" if blocking else "review_required" if review else "pass",
        "blocking_issues": blocking,
        "review_issues": review,
        "language": {
            "status": language["status"],
            "blocking_codes": [item["code"] for item in language["blocking"]],
            "warning_codes": [item["code"] for item in language["warnings"]],
        },
    }


def complete_weekly_review(project: Path | str, *, record_path: str, now: str | None = None) -> dict[str, Any]:
    root = Path(project).expanduser().resolve(strict=False)
    current = local_now(now)
    path, record = load_record(root, record_path)
    validate_weekly_record_provenance(root, record)
    missing = missing_metrics(record)
    if missing:
        labels = "、".join(f"{PLATFORM_LABELS.get(item['platform'], item['platform'])}{item['label']}" for item in missing[:8])
        raise WeeklyLearningError(f"还有发布数据没填：{labels}")
    if not record.get("items"):
        raise WeeklyLearningError("本周没有已确认发布结果，不能生成结论型复盘")
    report = render_report(record, current)
    quality = combined_review_quality(report)
    # Missing evidence makes the review provisional and prevents it from
    # entering long-term writing references, but it should not discard an
    # otherwise useful weekly report. Language-safety blockers are different:
    # those must stop before anything is written.
    if (quality.get("language") or {}).get("blocking_codes"):
        raise WeeklyLearningError("本周复盘里还有不安全的内容，报告没有保存。请检查发布数据后重试")
    report_path = project_file(root, report_relative_path(str(record.get("week"))))
    report_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = report_path.with_name(f".{report_path.name}.{os.getpid()}.tmp")
    temporary.write_text(report, encoding="utf-8")
    os.replace(temporary, report_path)
    record["status"] = "completed"
    record["updated_at"] = timestamp(current)
    record["completed_at"] = timestamp(current)
    record["report_path"] = relative_to_project(root, report_path)
    record["report_sha256"] = hashlib.sha256(report.encode("utf-8")).hexdigest()
    record["quality_status"] = quality.get("status")
    record["quality_issues"] = {
        "blocking": quality.get("blocking_issues", []),
        "review": quality.get("review_issues", []),
    }
    record["proposed_memory"] = proposed_memory_write_set(record)
    atomic_write_json(path, record)
    schedule = load_schedule(root, current)
    schedule["last_checked_at"] = timestamp(current)
    atomic_write_json(schedule_path(root), schedule)
    return {
        "status": "completed",
        **record_summary(root, record, schedule, current),
        "report_path": record["report_path"],
        "quality": quality,
    }


def apply_memory(
    project: Path | str,
    *,
    record_path: str,
    human_confirmed: bool,
    now: str | None = None,
) -> dict[str, Any]:
    root = Path(project).expanduser().resolve(strict=False)
    current = local_now(now)
    if human_confirmed is not True:
        raise WeeklyLearningError("保存为写作参考前，需要你先勾选确认。")
    path, record = load_record(root, record_path)
    validate_weekly_record_provenance(root, record)
    if record.get("status") not in {"completed", "memory_applied"}:
        raise WeeklyLearningError("请先补齐数据并生成本周复盘，再保存为写作参考")
    report_relative = str(record.get("report_path") or "")
    if not report_relative:
        raise WeeklyLearningError("没有找到本周复盘，请重新生成后再保存")
    report_path = project_file(root, report_relative, must_exist=True)
    body = report_path.read_text(encoding="utf-8")
    current_digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    if current_digest != record.get("report_sha256"):
        raise WeeklyLearningError("复盘报告内容已变化，需要重新完成复盘")
    quality = audit_review(body)
    if quality.get("status") != "pass":
        raise WeeklyLearningError("复盘里还缺少有依据的评论结论，暂时不能保存为写作参考")
    if record.get("memory_applied_at"):
        schedule = load_schedule(root, current)
        return {
            "status": "memory_applied", **record_summary(root, record, schedule, current),
            "memory_paths": record.get("memory_paths") or [],
            "idempotent": True,
        }
    proposal = record.get("proposed_memory") if isinstance(record.get("proposed_memory"), dict) else proposed_memory_write_set(record)
    memory_language = inspect_generated_language("\n".join(
        str(line)
        for values in proposal.values()
        if isinstance(values, list)
        for line in values
    ))
    if memory_language["blocking"]:
        raise WeeklyLearningError("本周写作参考中还有不安全的内容，已停止保存。请重新生成复盘")
    targets = {
        "brain/insights.md": proposal.get("insights") or [],
        "brain/style-evolution.md": proposal.get("style_evolution") or [],
        "brain/case-library.md": proposal.get("case_library") or [],
        "brain/no-fly-zone.md": proposal.get("no_fly_zone") or [],
    }
    memory_paths: list[str] = []
    for relative, lines in targets.items():
        if not lines:
            continue
        safe_lines = [str(line).strip() for line in lines if str(line).strip()]
        if not safe_lines:
            continue
        target = project_file(root, relative)
        atomic_append(
            target,
            "\n".join([
                f"## {record.get('week')} · 已确认每周学习",
                f"<!-- {MEMORY_WRITE_SCHEMA} · {record.get('record_id')} -->",
                *(f"- {line}" for line in safe_lines),
            ]),
        )
        memory_paths.append(relative)
    record["status"] = "memory_applied"
    record["memory_applied_at"] = timestamp(current)
    record["memory_paths"] = memory_paths
    record["updated_at"] = timestamp(current)
    atomic_write_json(path, record)
    schedule = load_schedule(root, current)
    schedule["last_checked_at"] = timestamp(current)
    atomic_write_json(schedule_path(root), schedule)
    return {
        "status": "memory_applied", **record_summary(root, record, schedule, current),
        "memory_paths": memory_paths,
        "idempotent": False,
    }


def acknowledge_reminder(project: Path | str, *, record_path: str, now: str | None = None) -> dict[str, Any]:
    root = Path(project).expanduser().resolve(strict=False)
    current = local_now(now)
    _, record = load_record(root, record_path)
    schedule = load_schedule(root, current)
    schedule["last_checked_at"] = timestamp(current)
    schedule["last_notified_week"] = str(record.get("week") or "")
    atomic_write_json(schedule_path(root), schedule)
    return {
        **record_summary(root, record, schedule, current),
        "status": "acknowledged",
        "week": record.get("week"),
        "acknowledged_at": timestamp(current),
    }


def weekly_status(project: Path | str, *, now: str | None = None, ensure: bool = False) -> dict[str, Any]:
    root = Path(project).expanduser().resolve(strict=False)
    current = local_now(now)
    if ensure:
        # Status powers the initial page render. It may create this week's
        # local record after its schedule, but live URL lookups wait for the
        # explicit operator action instead of blocking the workbench.
        result = collect_weekly_review(
            root,
            now=timestamp(current),
            force=False,
            public_performance_collector=deferred_public_performance,
        )
        if result.get("status") != "not_due":
            return result
    schedule = load_schedule(root, current)
    week = iso_week(current)
    relative_path = record_relative_path(week)
    path = project_file(root, relative_path)
    if path.exists():
        _, record = load_record(root, relative_path)
        validate_weekly_record_provenance(root, record)
        return {"status": record.get("status"), **record_summary(root, record, schedule, current)}
    return {
        "status": "not_due",
        "week": week,
        "schedule": schedule,
        "next_scheduled_at": timestamp(scheduled_at(schedule, current)),
        "checked_at": timestamp(current),
    }


def load_updates(value: str) -> dict[str, Any]:
    raw = str(value or "")
    if raw.startswith("@"):
        path = Path(raw[1:]).expanduser()
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise WeeklyLearningError("无法读取手工指标输入文件") from exc
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise WeeklyLearningError("手工指标输入必须是 JSON 对象") from exc
    if not isinstance(parsed, dict):
        raise WeeklyLearningError("手工指标输入必须是 JSON 对象")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AIFIOS local weekly learning loop")
    parser.add_argument("--project", required=True, help="AIFIOS project directory")
    parser.add_argument("--now", default="", help="optional ISO timestamp for deterministic local runs")
    sub = parser.add_subparsers(dest="command", required=True)

    p_status = sub.add_parser("status", help="read current weekly review state")
    p_status.add_argument("--ensure", action="store_true", help="create this week's waiting review after its scheduled time")

    p_collect = sub.add_parser("collect", help="collect local published evidence into this week's review")
    p_collect.add_argument("--force", action="store_true", help="collect now even before the weekly schedule is due")

    p_metrics = sub.add_parser("record-metrics", help="save operator-entered key metrics")
    p_metrics.add_argument("--record", required=True)
    p_metrics.add_argument("--updates", required=True, help="JSON object or @path to JSON")

    p_complete = sub.add_parser("complete", help="generate a complete review after all key metrics exist")
    p_complete.add_argument("--record", required=True)

    p_memory = sub.add_parser("apply-memory", help="write confirmed weekly learning to long-term local memory")
    p_memory.add_argument("--record", required=True)
    p_memory.add_argument("--human-confirmed", action="store_true", help="operator explicitly confirmed the reviewed conclusions")

    p_ack = sub.add_parser("acknowledge-reminder", help="mark one local desktop reminder as delivered")
    p_ack.add_argument("--record", required=True)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "status":
            result = weekly_status(args.project, now=args.now or None, ensure=args.ensure)
        elif args.command == "collect":
            result = collect_weekly_review(args.project, now=args.now or None, force=args.force)
        elif args.command == "record-metrics":
            result = record_manual_metrics(
                args.project,
                record_path=args.record,
                updates=load_updates(args.updates),
                now=args.now or None,
            )
        elif args.command == "complete":
            result = complete_weekly_review(args.project, record_path=args.record, now=args.now or None)
        elif args.command == "apply-memory":
            result = apply_memory(
                args.project,
                record_path=args.record,
                human_confirmed=args.human_confirmed,
                now=args.now or None,
            )
        elif args.command == "acknowledge-reminder":
            result = acknowledge_reminder(args.project, record_path=args.record, now=args.now or None)
        else:
            raise WeeklyLearningError("未知每周复盘命令")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
