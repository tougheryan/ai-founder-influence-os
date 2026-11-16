#!/usr/bin/env python3
"""Collect authorized performance data for AIFIOS review inputs."""
from __future__ import annotations

import argparse
import csv
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from wechat_official_api import Transport, WechatOfficialApiError, WechatOfficialClient
from wechat_official_mapper import normalize_wechat_official_payload
from content_runtime import ContentRuntime


def captured_at() -> str:
    return datetime.now().astimezone().isoformat(timespec="microseconds")


def raw_snapshot_name(slug: str) -> str:
    timestamp = datetime.now().astimezone().strftime("%Y%m%d-%H%M%S-%f")
    return f"{slug}-{timestamp}-{uuid.uuid4().hex[:8]}.json"


def safe_slug(value: str) -> str:
    text = str(value or "").strip()
    if not text or text in {".", ".."} or "/" in text or "\\" in text:
        raise ValueError("--slug must resolve to a safe file name")
    slug = re.sub(r"[^\w\u4e00-\u9fff.-]+", "-", text, flags=re.UNICODE)
    slug = slug.strip(".-")
    if not slug or slug in {".", ".."} or ".." in slug:
        raise ValueError("--slug must resolve to a safe file name")
    return slug


METRIC_DEFINITIONS = {
    "exposures": "平台后台展示/曝光口径，按本次授权导出或手工记录保留",
    "reads": "公众号图文阅读次数",
    "readers": "公众号图文阅读人数",
    "likes": "公众号点赞数",
    "wows": "公众号在看数",
    "comments": "公众号留言/评论数",
    "shares": "分享/转发次数",
    "collects": "收藏次数",
    "new_followers": "由本内容带来的新增关注",
    "profile_visits": "主页/账号访问",
    "leads": "咨询、留资、私信或其它线索动作",
}

METRIC_ALIASES = {
    "曝光": "exposures",
    "曝光量": "exposures",
    "展示": "exposures",
    "展示量": "exposures",
    "阅读": "reads",
    "阅读量": "reads",
    "阅读次数": "reads",
    "阅读人数": "readers",
    "点赞": "likes",
    "点赞数": "likes",
    "在看": "wows",
    "在看数": "wows",
    "评论": "comments",
    "留言": "comments",
    "留言数": "comments",
    "分享": "shares",
    "转发": "shares",
    "收藏": "collects",
    "新增关注": "new_followers",
    "关注": "new_followers",
    "主页访问": "profile_visits",
    "线索": "leads",
    "咨询": "leads",
}

SENSITIVE_RE = re.compile(
    r"(?:(?:\+?86[-\s]?)?1[3-9]\d{9}|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|微信(?:号)?[:：]?\s*[A-Za-z0-9_-]{5,}|"
    r"weixin[:：]?\s*[A-Za-z0-9_-]{5,}|wx[:：]?\s*[A-Za-z0-9_-]{5,})",
    re.IGNORECASE,
)
SENSITIVE_FIELD_RE = re.compile(
    r"(?:access_?token|token|secret|cookie|authorization|openid|unionid|nickname|headimgurl|phone|mobile|email|user_?id)$",
    re.IGNORECASE,
)


def redact_for_storage(value: Any, field_name: str = "") -> Any:
    """Keep performance snapshots useful without retaining credentials or user identifiers."""
    if SENSITIVE_FIELD_RE.search(field_name):
        return "[已脱敏]"
    if isinstance(value, dict):
        return {str(key): redact_for_storage(item, str(key)) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_for_storage(item, field_name) for item in value]
    if isinstance(value, str):
        return SENSITIVE_RE.sub("[已脱敏]", value)
    return value


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(redact_for_storage(payload), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def normalize_metric_key(key: str) -> str:
    text = str(key or "").strip()
    return METRIC_ALIASES.get(text, text.strip().lower().replace("-", "_").replace(" ", "_"))


def parse_metric_value(value: Any) -> int | float | str:
    if isinstance(value, (int, float)):
        return value
    text = str(value or "").strip()
    if not text:
        return 0
    compact = text.replace(",", "")
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([wW万kK千]?)", compact)
    if not match:
        return text
    number = float(match.group(1))
    unit = match.group(2).lower()
    if unit in {"w", "万"}:
        number *= 10000
    elif unit in {"k", "千"}:
        number *= 1000
    return int(number) if number.is_integer() else number


def number_value(value: Any) -> float:
    parsed = parse_metric_value(value)
    return float(parsed) if isinstance(parsed, (int, float)) else 0.0


def normalize_metrics(metrics: dict[str, Any]) -> dict[str, Any]:
    normalized: dict[str, Any] = {}
    for key, value in (metrics or {}).items():
        metric_key = normalize_metric_key(key)
        if metric_key:
            normalized[metric_key] = parse_metric_value(value)
    return normalized


def mask_sensitive(value: str) -> str:
    return SENSITIVE_RE.sub("[已脱敏]", str(value or "").strip())


def normalize_comment(item: Any) -> dict[str, Any]:
    if isinstance(item, str):
        return {"content": mask_sensitive(item), "likes": 0, "type": "sample"}
    payload = dict(item or {})
    return {
        "content": mask_sensitive(payload.get("content") or payload.get("text") or payload.get("comment") or ""),
        "likes": parse_metric_value(payload.get("likes", payload.get("like_count", 0))),
        "type": str(payload.get("type") or payload.get("category") or "sample"),
    }


def first_non_empty(*values: Any) -> str:
    for value in values:
        text = str(value or "").strip()
        if text:
            return text
    return ""


def load_input_payload(path: Path) -> dict[str, Any]:
    suffix = path.suffix.lower()
    if suffix == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            if len(data) != 1:
                raise ValueError("JSON list input must contain exactly one article record")
            data = data[0]
        if not isinstance(data, dict):
            raise ValueError("JSON input must be an object")
        return data
    if suffix == ".csv":
        with path.open("r", encoding="utf-8-sig", newline="") as fh:
            rows = list(csv.DictReader(fh))
        if len(rows) != 1:
            raise ValueError("CSV input must contain exactly one article row")
        return rows[0]
    raise ValueError("--file only supports .json or .csv")


def extract_metrics(payload: dict[str, Any], args: argparse.Namespace | None = None) -> dict[str, Any]:
    metric_payload: dict[str, Any] = {}
    nested = payload.get("metrics")
    if isinstance(nested, dict):
        metric_payload.update(nested)
    for key in METRIC_DEFINITIONS:
        if key in payload and not isinstance(payload[key], (list, dict)):
            metric_payload[key] = payload[key]
    for key, value in payload.items():
        if isinstance(value, (list, dict)):
            continue
        normalized_key = normalize_metric_key(key)
        if normalized_key in METRIC_DEFINITIONS and normalized_key not in metric_payload:
            metric_payload[normalized_key] = value
    if args is not None:
        for key in METRIC_DEFINITIONS:
            value = getattr(args, key, None)
            if value not in (None, ""):
                metric_payload[key] = value
    return normalize_metrics(metric_payload)


def extract_comments(payload: dict[str, Any], args: argparse.Namespace | None = None) -> list[dict[str, Any]]:
    raw_comments = payload.get("comment_samples")
    if raw_comments is None:
        raw_comments = payload.get("comments") if isinstance(payload.get("comments"), list) else []
    if isinstance(raw_comments, str):
        raw_comments = [item.strip() for item in re.split(r"[\n|]+", raw_comments) if item.strip()]
    comments = [normalize_comment(item) for item in raw_comments if item]
    if args is not None:
        comments.extend(normalize_comment(item) for item in (args.comment or []))
    return [item for item in comments if item.get("content")]


def normalize_article_content(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("article_content")
    if not isinstance(raw, dict):
        return {}
    content = dict(raw)
    if "content_text" in content:
        content["content_text"] = str(content.get("content_text") or "").strip()
    for key in ["paragraphs", "headings"]:
        if key in content and isinstance(content[key], list):
            content[key] = [str(item).strip() for item in content[key] if str(item).strip()]
    return {key: value for key, value in content.items() if value not in ("", None, [], {})}


def normalize_content_analysis(payload: dict[str, Any]) -> dict[str, Any]:
    raw = payload.get("content_analysis")
    if not isinstance(raw, dict):
        return {}
    analysis = dict(raw)
    for key in ["key_points", "cta_evidence", "content_risks", "optimization_questions"]:
        if key in analysis and isinstance(analysis[key], list):
            analysis[key] = [str(item).strip() for item in analysis[key] if str(item).strip()]
    return {key: value for key, value in analysis.items() if value not in ("", None, [], {})}


def rate(numerator: Any, denominator: Any) -> float | None:
    den = number_value(denominator)
    if den <= 0:
        return None
    return round(number_value(numerator) / den, 4)


def format_metric_value(value: Any) -> str:
    if isinstance(value, float) and not value.is_integer():
        return f"{value:.4g}"
    return str(int(value)) if isinstance(value, float) else str(value)


class PerformanceCollector:
    def __init__(self, project: Path | str):
        self.project = Path(project).expanduser().resolve(strict=False)
        self.root = self.project / "materials" / "performance"
        self.raw_dir = self.root / "raw"
        self.wechat_official_dir = self.root / "wechat-official-account"
        self.wechat_channels_dir = self.root / "wechat-channels"
        self.review_inputs_dir = self.root / "review-inputs"

    def init_dirs(self) -> None:
        for directory in [
            self.raw_dir,
            self.wechat_official_dir,
            self.wechat_channels_dir,
            self.review_inputs_dir,
        ]:
            directory.mkdir(parents=True, exist_ok=True)

    def collect_mock_wechat(self, slug: str, title: str) -> dict[str, Any]:
        self.init_dirs()
        slug = safe_slug(slug)
        title = str(title or "").strip()
        if not title:
            raise ValueError("--title is required")

        now = captured_at()
        raw_path = self.raw_dir / raw_snapshot_name(slug)
        normalized_path = self.wechat_official_dir / f"{slug}.json"
        review_input_path = self.review_inputs_dir / f"{slug}.json"

        raw_payload = {
            "source": "mock-wechat",
            "platform": "wechat-official-account",
            "slug": slug,
            "title": title,
            "captured_at": now,
            "metrics": {
                "reads": 100,
                "likes": 12,
                "wows": 4,
                "comments": 3,
                "shares": 5,
            },
            "comments": [
                {"content": "想看模板", "likes": 2},
                {"content": "怎么开头", "likes": 1},
            ],
        }
        normalized = {
            "platform": "wechat-official-account",
            "slug": slug,
            "title": title,
            "captured_at": now,
            "source": "mock adapter",
            "authorization_mode": "self-account",
            "metrics": raw_payload["metrics"],
            "comment_samples": [item["content"] for item in raw_payload["comments"]],
            "raw_path": str(raw_path),
        }
        review_input = {
            "step": "review",
            "slug": slug,
            "title": title,
            "platform": "wechat-official-account",
            "captured_at": now,
            "performance": normalized,
            "raw_path": str(raw_path),
            "normalized_path": str(normalized_path),
        }

        atomic_write_json(raw_path, raw_payload)
        atomic_write_json(normalized_path, normalized)
        atomic_write_json(review_input_path, review_input)

        return {
            "status": "collected",
            "slug": slug,
            "raw_path": str(raw_path),
            "normalized_path": str(normalized_path),
            "review_input_path": str(review_input_path),
        }

    def relative(self, path: Path) -> str:
        return str(path.resolve(strict=False).relative_to(self.project))

    def relative_if_inside_project(self, value: str) -> str:
        text = str(value or "").strip()
        if not text:
            return ""
        candidate = Path(text).expanduser()
        if not candidate.is_absolute():
            return text
        try:
            return str(candidate.resolve(strict=False).relative_to(self.project))
        except ValueError:
            return text

    def write_runtime_report(self, slug: str, body: str, source: str) -> dict[str, Any]:
        runtime = Path(__file__).resolve().with_name("content_runtime.py")
        managed_run_id = ContentRuntime(self.project).active_managed_run_for_slug(slug)
        command = [
            sys.executable,
            str(runtime),
            "--project",
            str(self.project),
            "write",
            "--step",
            "performance",
            "--slug",
            slug,
            "--content",
            body,
            "--source",
            source,
        ]
        if managed_run_id:
            command.extend(["--run-id", managed_run_id])
        else:
            # Manual/authorized historical metrics stay as non-production
            # evidence rather than mutating whichever run happens to be open.
            command.append("--unbound-report")
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stdout.strip())
        return json.loads(result.stdout)

    def validate_runtime_report(self, rel_path: str) -> dict[str, Any]:
        runtime = Path(__file__).resolve().with_name("content_runtime.py")
        command = [
            sys.executable,
            str(runtime),
            "--project",
            str(self.project),
            "validate",
            "--step",
            "performance",
            "--file",
            rel_path,
        ]
        result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stdout.strip())
        return json.loads(result.stdout)

    def collect_wechat(self, payload: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
        self.init_dirs()
        slug = safe_slug(first_non_empty(args.slug, payload.get("slug"), payload.get("article_id"), "wechat-performance"))
        title = first_non_empty(args.title, payload.get("title"))
        if not title:
            raise ValueError("--title is required when the input file does not include title")

        now = captured_at()
        metrics = extract_metrics(payload, args)
        comments = extract_comments(payload, args)
        source = first_non_empty(args.data_source, payload.get("data_source"), payload.get("source"), "wechat official account manual record")
        authorization_mode = first_non_empty(args.authorization_mode, payload.get("authorization_mode"), "self-account")
        captured_by = first_non_empty(args.captured_by, payload.get("captured_by"), "user-authorized")
        published_at = first_non_empty(args.published_at, payload.get("published_at"), payload.get("publish_time"))
        publish_url = first_non_empty(args.publish_url, payload.get("publish_url"), payload.get("url"))
        article_id = first_non_empty(args.article_id, payload.get("article_id"), payload.get("id"), slug)
        authorization_record = first_non_empty(args.authorization_record, payload.get("authorization_record"), "用户本次会话授权/手工录入")
        publish_asset = first_non_empty(args.publish_asset, payload.get("publish_asset"), payload.get("source_publish_path"))
        screenshot_or_export = first_non_empty(args.evidence, payload.get("evidence"), payload.get("export_file"), payload.get("screenshot"))
        benchmark_reports = list(payload.get("benchmark_reports") or [])
        benchmark_reports.extend(args.benchmark_report or [])
        anomalies = list(payload.get("anomalies") or [])
        evidence = ContentRuntime(self.project).find_publish_evidence(slug)
        publish_evidence_status = evidence["evidence_status"]
        evidence_status = "bound" if publish_evidence_status == "bound" else "blocked"
        review_status = "review-ready" if evidence_status == "bound" else "blocked"
        if evidence_status != "bound":
            anomalies.append(f"publish_evidence_{publish_evidence_status}")
        article_content = normalize_article_content(payload)
        content_analysis = normalize_content_analysis(payload)
        article_capture_path = self.relative_if_inside_project(first_non_empty(
            payload.get("article_capture_path"),
            article_content.get("capture_path") if article_content else "",
        ))
        if article_capture_path and article_content:
            article_content["capture_path"] = article_capture_path

        reads = metrics.get("reads", 0)
        exposures = metrics.get("exposures", 0)
        interactions = sum(number_value(metrics.get(key, 0)) for key in ["likes", "wows", "comments", "shares", "collects"])
        derived = {
            "read_rate": rate(reads, exposures),
            "interaction_rate": rate(interactions, reads),
            "share_rate": rate(metrics.get("shares", 0), reads),
            "lead_rate": rate(metrics.get("leads", 0), reads),
        }
        derived = {key: value for key, value in derived.items() if value is not None}

        raw_path = self.raw_dir / raw_snapshot_name(slug)
        normalized_path = self.wechat_official_dir / f"{slug}.json"
        review_input_path = self.review_inputs_dir / f"{slug}.json"

        raw_payload = {
            "source": source,
            "platform": "wechat-official-account",
            "authorization_mode": authorization_mode,
            "authorization_record": authorization_record,
            "slug": slug,
            "article_id": article_id,
            "title": title,
            "publish_url": publish_url,
            "published_at": published_at,
            "captured_at": now,
            "captured_by": captured_by,
            "metrics": metrics,
            "comments": comments,
            "article_capture_path": article_capture_path,
            "article_content": article_content,
            "content_analysis": content_analysis,
            "evidence": screenshot_or_export,
            "input_payload": payload,
        }
        normalized = {
            "platform": "wechat-official-account",
            "slug": slug,
            "article_id": article_id,
            "title": title,
            "publish_url": publish_url,
            "published_at": published_at,
            "captured_at": now,
            "source": source,
            "authorization_mode": authorization_mode,
            "metrics": metrics,
            "derived_metrics": derived,
            "metric_definitions": {key: METRIC_DEFINITIONS.get(key, "用户提供指标") for key in metrics},
            "comment_samples": comments,
            "raw_path": self.relative(raw_path),
            "evidence_status": evidence_status,
            "publish_evidence_status": publish_evidence_status,
            "publish_record_path": evidence.get("path", ""),
            "review_status": review_status,
        }
        if article_capture_path:
            normalized["article_capture_path"] = article_capture_path
        if article_content:
            normalized["article_content"] = article_content
        if content_analysis:
            normalized["content_analysis"] = content_analysis
        review_questions = [
            "曝光到阅读的损耗主要发生在标题、封面摘要还是首屏开头？",
            "互动率高/低背后，是观点共鸣、收藏价值还是评论区问题没有被激活？",
            "评论中的高意向问题能否直接变成下一篇选题或服务入口？",
            "与爆款对标相比，本篇在标题冲突、开头现场和评论需求上差在哪里？",
        ]
        if content_analysis:
            review_questions.insert(0, "正文结构、开头承诺和结尾 CTA 是否解释了本次阅读/互动表现？")
        review_input = {
            "step": "review",
            "slug": slug,
            "title": title,
            "platform": "wechat-official-account",
            "content_source": publish_asset,
            "publish_asset": publish_asset,
            "publish_url": publish_url,
            "published_at": published_at,
            "captured_at": now,
            "performance": normalized,
            "benchmark_reports": benchmark_reports,
            "raw_path": self.relative(raw_path),
            "normalized_path": self.relative(normalized_path),
            "comment_samples": comments,
            "article_capture_path": article_capture_path,
            "article_content": article_content,
            "content_analysis": content_analysis,
            "anomalies": anomalies,
            "evidence_status": evidence_status,
            "publish_evidence_status": publish_evidence_status,
            "publish_record_path": evidence.get("path", ""),
            "review_status": review_status,
            "suggested_review_questions": review_questions,
        }

        atomic_write_json(raw_path, raw_payload)
        atomic_write_json(normalized_path, normalized)
        atomic_write_json(review_input_path, review_input)

        body = self.render_wechat_report(
            slug=slug,
            title=title,
            article_id=article_id,
            publish_url=publish_url,
            published_at=published_at,
            authorization_mode=authorization_mode,
            source=source,
            captured_at=now,
            captured_by=captured_by,
            authorization_record=authorization_record,
            raw_path=self.relative(raw_path),
            normalized_path=self.relative(normalized_path),
            review_input_path=self.relative(review_input_path),
            metrics=metrics,
            comments=comments,
            screenshot_or_export=screenshot_or_export,
            benchmark_reports=benchmark_reports,
            review_questions=review_questions,
            article_capture_path=article_capture_path,
            content_analysis=content_analysis,
            evidence_status=evidence_status,
            publish_record_path=evidence.get("path", ""),
        )
        write_result = self.write_runtime_report(slug, body, f"publish:{publish_asset or publish_url or article_id}")
        report_rel = self.relative(Path(write_result["path"]))
        validation = self.validate_runtime_report(report_rel)

        return {
            "status": "collected" if evidence_status == "bound" else "blocked",
            "evidence_status": evidence_status,
            "slug": slug,
            "raw_path": str(raw_path),
            "normalized_path": str(normalized_path),
            "review_input_path": str(review_input_path),
            "performance_report_path": write_result["path"],
            "quality_status": validation.get("quality_status"),
            "quality_errors": validation.get("quality_errors", []),
            "quality_reviews": validation.get("quality_reviews", []),
        }

    def collect_wechat_api(self, args: argparse.Namespace, transport: Transport | None = None) -> dict[str, Any]:
        self.init_dirs()
        slug = safe_slug(args.slug)
        article_id = first_non_empty(args.article_id)
        if not article_id:
            raise ValueError("--article-id is required for official WeChat API collection")
        published_at = first_non_empty(args.published_at)
        if not published_at:
            raise ValueError("--published-at YYYY-MM-DD is required for official WeChat API collection")
        date = published_at[:10]
        msg_data_id = first_non_empty(getattr(args, "msg_data_id", ""))
        comment_limit = int(first_non_empty(getattr(args, "comment_limit", ""), "50"))
        now = captured_at()
        evidence = ContentRuntime(self.project).find_publish_evidence(slug)
        publish_evidence_status = evidence["evidence_status"]
        evidence_status = "bound" if publish_evidence_status == "bound" else "blocked"
        client = (
            WechatOfficialClient.from_env(self.project, transport=transport)
            if transport
            else WechatOfficialClient.from_env(self.project)
        )

        article_response = client.get_article(article_id)
        summary_response = client.get_article_summary(date)
        total_response = client.get_article_total(date)
        comments_response: dict[str, Any] = {}
        anomalies: list[str] = []
        if msg_data_id:
            try:
                comments_response = client.list_comments(msg_data_id, count=min(max(comment_limit, 1), 50))
            except WechatOfficialApiError as exc:
                anomalies.append(f"comments_api_error:{exc.errcode}:{str(exc)}")
        else:
            anomalies.append("msg_data_id_missing_comments_skipped")
        if evidence_status != "bound":
            anomalies.append(f"publish_evidence_{publish_evidence_status}")

        raw_path = self.raw_dir / raw_snapshot_name(slug)
        normalized_path = self.wechat_official_dir / f"{slug}.json"
        review_input_path = self.review_inputs_dir / f"{slug}.json"
        raw_payload = {
            "source": "wechat-official-api",
            "platform": "wechat-official-account",
            "authorization_mode": "self-account",
            "slug": slug,
            "article_id": article_id,
            "msg_data_id": msg_data_id,
            "published_at": published_at,
            "captured_at": now,
            "captured_by": "wechat-official-api",
            "responses": {
                "article": article_response,
                "summary": summary_response,
                "total": total_response,
                "comments": comments_response,
            },
            "anomalies": anomalies,
        }
        atomic_write_json(raw_path, raw_payload)
        normalized = normalize_wechat_official_payload(
            slug=slug,
            article_id=article_id,
            msg_data_id=msg_data_id,
            published_at=published_at,
            captured_at=now,
            article_response=article_response,
            total_response=total_response,
            summary_response=summary_response,
            comments_response=comments_response,
            raw_path=self.relative(raw_path),
        )
        normalized["anomalies"] = list(dict.fromkeys([*normalized.get("anomalies", []), *anomalies]))
        normalized["evidence_status"] = evidence_status
        normalized["publish_evidence_status"] = publish_evidence_status
        normalized["publish_record_path"] = evidence.get("path", "")
        normalized["review_status"] = "review-ready" if evidence_status == "bound" else "blocked"
        atomic_write_json(normalized_path, normalized)
        review_questions = [
            "官方阅读到分享/收藏的比例说明这篇内容是被消费、被转发还是被保存？",
            "评论样本里是否出现了可以直接转成下一篇选题的高意向问题？",
            "官方接口未返回的曝光、点赞和在看是否需要后台截图或手工补充？",
        ]
        review_input = {
            "step": "review",
            "slug": slug,
            "title": normalized.get("title", ""),
            "platform": "wechat-official-account",
            "content_source": normalized.get("publish_url", ""),
            "publish_asset": "",
            "publish_url": normalized.get("publish_url", ""),
            "published_at": published_at,
            "captured_at": now,
            "performance": normalized,
            "benchmark_reports": list(getattr(args, "benchmark_report", []) or []),
            "raw_path": self.relative(raw_path),
            "normalized_path": self.relative(normalized_path),
            "comment_samples": normalized.get("comment_samples", []),
            "anomalies": normalized.get("anomalies", []),
            "evidence_status": evidence_status,
            "publish_evidence_status": publish_evidence_status,
            "publish_record_path": evidence.get("path", ""),
            "review_status": "review-ready" if evidence_status == "bound" else "blocked",
            "suggested_review_questions": review_questions,
        }
        atomic_write_json(review_input_path, review_input)
        body = self.render_wechat_report(
            slug=slug,
            title=normalized.get("title") or slug,
            article_id=article_id,
            publish_url=normalized.get("publish_url", ""),
            published_at=published_at,
            authorization_mode="self-account",
            source="wechat-official-api",
            captured_at=now,
            captured_by="wechat-official-api",
            authorization_record="AIFIOS_WECHAT_OFFICIAL_APP_ID + 微信公众平台 IP 白名单授权；secret/token 未写入快照",
            raw_path=self.relative(raw_path),
            normalized_path=self.relative(normalized_path),
            review_input_path=self.relative(review_input_path),
            metrics=normalized.get("metrics", {}),
            comments=normalized.get("comment_samples", []),
            screenshot_or_export="官方 API 自动获取；未返回字段记录在 unsupported_metrics/anomalies",
            benchmark_reports=list(getattr(args, "benchmark_report", []) or []),
            review_questions=review_questions,
            evidence_status=evidence_status,
            publish_record_path=evidence.get("path", ""),
        )
        write_result = self.write_runtime_report(slug, body, f"publish:{normalized.get('publish_url') or article_id}")
        report_rel = self.relative(Path(write_result["path"]))
        validation = self.validate_runtime_report(report_rel)
        return {
            "status": "collected" if evidence_status == "bound" else "blocked",
            "evidence_status": evidence_status,
            "slug": slug,
            "raw_path": str(raw_path),
            "normalized_path": str(normalized_path),
            "review_input_path": str(review_input_path),
            "performance_report_path": write_result["path"],
            "quality_status": validation.get("quality_status"),
            "quality_errors": validation.get("quality_errors", []),
            "quality_reviews": validation.get("quality_reviews", []),
        }

    def render_wechat_report(
        self,
        *,
        slug: str,
        title: str,
        article_id: str,
        publish_url: str,
        published_at: str,
        authorization_mode: str,
        source: str,
        captured_at: str,
        captured_by: str,
        authorization_record: str,
        raw_path: str,
        normalized_path: str,
        review_input_path: str,
        metrics: dict[str, Any],
        comments: list[dict[str, Any]],
        screenshot_or_export: str,
        benchmark_reports: list[str],
        review_questions: list[str],
        article_capture_path: str = "",
        content_analysis: dict[str, Any] | None = None,
        evidence_status: str = "legacy",
        publish_record_path: str = "",
    ) -> str:
        metric_rows = [
            f"| {key} | {format_metric_value(value)} | {METRIC_DEFINITIONS.get(key, '用户提供指标')} | {captured_at} |"
            for key, value in metrics.items()
        ]
        if not metric_rows:
            metric_rows = [f"| reads | 0 | 未提供阅读数据，需回填平台后台口径 | {captured_at} |"]
        comment_lines = [
            f"- 评论 {index}：{item.get('content')}（类型：{item.get('type', 'sample')}；热度：{format_metric_value(item.get('likes', 0))}）"
            for index, item in enumerate(comments, start=1)
        ]
        if not comment_lines:
            comment_lines = ["- 评论样本说明：本次未提供真实评论样本，进入 review 前建议补充高赞、质疑和高意向评论。"]
        benchmark_text = "；".join(benchmark_reports) if benchmark_reports else "未绑定；可用 `make hit-report PLATFORM=wechat KEYWORD='关键词'` 生成对标报告后回填。"
        question_lines = "\n".join(f"- {item}" for item in review_questions)
        analysis = content_analysis or {}
        content_capture_line = article_capture_path or "未启用正文采集；如需正文分析，可用浏览器模式追加 CAPTURE_CONTENT=1。"
        primary_suggestion = (analysis.get("optimization_suggestions") or [{}])[0] if analysis else {}
        primary_fix = (analysis.get("revision_brief") or {}).get("primary_fix", "") if analysis else ""
        content_analysis_line = (
            f"结构：{analysis.get('structure_type', '未分析')}；"
            f"CTA：{'已识别' if analysis.get('cta_detected') else '未识别'}；"
            f"开头摘要：{analysis.get('opening_summary', '未分析')}"
            if analysis else "未分析"
        )
        deep_analysis_lines = (
            "\n".join([
                f"- 综合诊断：{analysis.get('diagnosis_summary', '未生成')}",
                f"- 优先优化：{primary_suggestion.get('problem') or primary_fix or '未生成'}",
                f"- 建议动作：{primary_suggestion.get('recommendation') or primary_fix or '未生成'}",
                f"- 改写方向：{primary_suggestion.get('rewrite_direction') or '未生成'}",
            ])
            if analysis else "- 综合诊断：未启用正文采集，暂无内容深度分析。"
        )
        return f"""# 数据回流报告 · {title}

## 0. 采集对象
- slug：{slug}
- 平台：wechat-official-account / 公众号
- 作品 ID：{article_id}
- 发布时间：{published_at or "未提供"}
- 发布链接：{publish_url or "未提供"}
- 内容类型：公众号图文

## 1. 授权与数据源
- 授权模式：{authorization_mode}
- 数据源：{source}
- 采集时间：{captured_at}
- 采集人：{captured_by}
- 授权证明或授权记录路径：{authorization_record}
- 合规声明：只处理用户授权可访问的数据，不绕过平台授权，不抓取无权限数据。

## 2. 原始快照
- raw_path：{raw_path}
- 原始字段摘要：title、publish_url、published_at、metrics、comments、authorization_mode、captured_at。
- 截图或导出文件索引：{screenshot_or_export or "未提供；本次按用户授权手工录入/导出数据记录。"}
- 正文采集快照：{content_capture_line}
- 保留口径：原始快照不清洗、不覆盖，保留本次数据来源的原始口径。

## 3. 归一化指标
- normalized_path：{normalized_path}
| 指标 | 数值 | 口径 | 采集时间 |
|---|---:|---|---|
{chr(10).join(metric_rows)}

## 4. 评论样本
{chr(10).join(comment_lines)}
- 脱敏规则：已去除或遮盖手机号、微信号、订单号和客户隐私。

## 5. Review 输入包
- path：{review_input_path}
- 包含：内容来源、发布资产、归一化指标、评论样本、异常说明、爆款对标报告路径和建议复盘问题。
- 内容分析：{content_analysis_line}
{deep_analysis_lines}
- 爆款对标报告：{benchmark_text}
- 建议复盘问题：
{question_lines}

## 6. 写回与下一步
- 已写回：pipeline/performance/{slug}-performance.md
- 同 slug 发布证据状态：{evidence_status}
- 发布记录路径：{publish_record_path or "未找到同 slug 发布记录"}
- 下一步：/content-review 读取 `{review_input_path}`，并结合爆款对标报告分析标题、开头、评论需求和下一条选题。
- 阻断规则：若授权缺失、核心指标缺失或评论样本不足，标记为 review_required / blocked，不进入结论型复盘。
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="AIFIOS performance collector")
    parser.add_argument("--project", required=True, help="AIFIOS project directory")
    sub = parser.add_subparsers(dest="command", required=True)

    p_mock = sub.add_parser("mock-wechat", help="write mock WeChat performance data")
    p_mock.add_argument("--slug", required=True)
    p_mock.add_argument("--title", required=True)

    p_wechat = sub.add_parser("wechat", help="collect authorized WeChat OA performance data from file or manual fields")
    p_wechat.add_argument("--file", help="JSON/CSV exported or manually prepared authorized data")
    p_wechat.add_argument("--slug", default="")
    p_wechat.add_argument("--title", default="")
    p_wechat.add_argument("--article-id", default="")
    p_wechat.add_argument("--publish-url", default="")
    p_wechat.add_argument("--published-at", default="")
    p_wechat.add_argument("--publish-asset", default="")
    p_wechat.add_argument("--authorization-mode", default="self-account")
    p_wechat.add_argument("--authorization-record", default="")
    p_wechat.add_argument("--data-source", default="")
    p_wechat.add_argument("--captured-by", default="")
    p_wechat.add_argument("--evidence", default="")
    p_wechat.add_argument("--benchmark-report", action="append", default=[])
    p_wechat.add_argument("--comment", action="append", default=[])
    for metric in METRIC_DEFINITIONS:
        p_wechat.add_argument(f"--{metric.replace('_', '-')}", default="")

    p_wechat_api = sub.add_parser("wechat-api", help="collect authorized WeChat OA performance data through official APIs")
    p_wechat_api.add_argument("--slug", required=True)
    p_wechat_api.add_argument("--article-id", required=True)
    p_wechat_api.add_argument("--msg-data-id", default="")
    p_wechat_api.add_argument("--published-at", required=True)
    p_wechat_api.add_argument("--begin-date", default="")
    p_wechat_api.add_argument("--end-date", default="")
    p_wechat_api.add_argument("--comment-limit", default="50")
    p_wechat_api.add_argument("--benchmark-report", action="append", default=[])
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        collector = PerformanceCollector(args.project)
        if args.command == "mock-wechat":
            result = collector.collect_mock_wechat(args.slug, args.title)
        elif args.command == "wechat":
            payload = load_input_payload(Path(args.file).expanduser().resolve(strict=False)) if args.file else {}
            result = collector.collect_wechat(payload, args)
        elif args.command == "wechat-api":
            result = collector.collect_wechat_api(args)
        else:
            raise ValueError(f"unknown command: {args.command}")
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
