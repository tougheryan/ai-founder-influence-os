"""Local, immutable evidence for an explicitly chosen author-material workflow.

This is not market research: it records what the author supplied and cannot
establish popularity, demand or performance. No network or model calls occur.
"""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from material_corrections import base_context, current_correction

SCHEMA = "echo.author-evidence.v1"
MODE = "author_material"


def digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


def local_file(project: Path, relative: str) -> Path:
    if not isinstance(relative, str) or "\\" in relative or any(
        part in ("", ".", "..") for part in relative.split("/")
    ) or Path(relative).is_absolute():
        raise ValueError("作者素材路径不正确")
    path = project / relative
    if path.resolve() != path.absolute():
        raise ValueError("作者素材不能经过符号链接")
    return path


def record_path(project: Path, run_id: str, record_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}", run_id) or not re.fullmatch(r"author_[a-f0-9]{32}", record_id):
        raise ValueError("作者素材记录编号不正确")
    return local_file(project, f"runs/{run_id}/author-evidence/{record_id}.json")


def source_revision(run: dict) -> str:
    return digest({key: run.get(key) for key in (
        "research_mode", "topic", "target_platforms", "topic_selection", "author_evidence",
    )} | {"intake": ((run.get("steps") or {}).get("intake") or {}).get("latest")})


def source_context(project: Path, run: dict) -> dict:
    if run.get("status") == "archived":
        raise ValueError("本期已归档，不能更改写作依据")
    run_id = run["run_id"]
    context, _ = base_context(project, run_id)
    fingerprint = context.get("inputFingerprint", "")
    if (not re.fullmatch(r"[a-f0-9]{64}", fingerprint)
            or context.get("analysisStatus") != "current"
            or context.get("analysisInputFingerprint") != fingerprint):
        raise ValueError("素材已变化或尚未整理，请先核对本期素材")
    correction = current_correction(project, run)
    material = {
        "input_fingerprint": fingerprint,
        "input": context.get("input"),
        "analysis": correction["analysis"] if correction else context.get("analysis"),
        "correction_id": correction["id"] if correction else "",
        "selection": context.get("selection"),
    }
    if not isinstance(material["analysis"], dict) or not material["analysis"].get("summary"):
        raise ValueError("本期缺少可核对的素材整理结果")
    intake = ((run.get("steps") or {}).get("intake") or {}).get("latest", "")
    if not re.fullmatch(r"pipeline/intake/[^/\\]+\.md", intake):
        raise ValueError("请先生成本期素材底稿")
    raw = local_file(project, intake).read_bytes()
    if not raw.strip():
        raise ValueError("本期素材底稿为空")
    platforms = run.get("target_platforms")
    if not isinstance(platforms, list) or not platforms:
        raise ValueError("请先选择本期平台")
    return {
        "run_id": run_id,
        "intake_path": intake,
        "intake_sha256": hashlib.sha256(raw).hexdigest(),
        "material_sha256": digest(material),
        "material": material,
        "target_platforms": platforms,
        "source_revision": source_revision(run),
    }


def verified_record(project: Path, run: dict, body: str | None = None) -> dict:
    if run.get("research_mode") != MODE:
        raise ValueError("本期未选择按作者素材写作")
    pointer = run.get("author_evidence") or {}
    path = record_path(project, run["run_id"], pointer.get("id", ""))
    raw = path.read_bytes()
    record = json.loads(raw)
    actual_sha = hashlib.sha256(raw).hexdigest()
    if (record.get("schema") != SCHEMA or record.get("run_id") != run["run_id"]
            or record.get("id") != pointer.get("id")
            or pointer.get("path") != path.relative_to(project).as_posix()
            or pointer.get("sha256") != actual_sha):
        raise ValueError("作者素材记录无法核对，请重新读取")
    current = source_context(project, run)
    if any(record.get(key) != current[key] for key in (
        "intake_path", "intake_sha256", "material_sha256", "target_platforms",
    )) or record.get("topic") != run.get("topic"):
        raise ValueError("素材、题目或平台已经变化，请重新核对写作依据")
    if digest(record.get("material")) != record.get("material_sha256"):
        raise ValueError("作者素材记录中的内容与摘要不一致")
    if body is not None:
        paths = re.findall(r"(?m)^- 作者素材快照：([^\r\n]+)$", body)
        hashes = re.findall(r"(?m)^- 作者素材 SHA-256：([a-f0-9]{64})$", body)
        modes = re.findall(r"(?m)^- 写作依据：([^\r\n]+)$", body)
        if (paths != [pointer["path"]] or hashes != [actual_sha]
                or modes != ["作者素材（未进行平台研究）"]):
            raise ValueError("写作方案必须准确引用本期作者素材版本，并声明未进行平台研究")
    return {
        "verified": True,
        "research_mode": MODE,
        "run_id": run["run_id"],
        "author_evidence_path": pointer["path"],
        "author_evidence_sha256": actual_sha,
        "source_path": record["intake_path"],
        "source_sha256": record["intake_sha256"],
        "material_sha256": record["material_sha256"],
        "material_correction_id": record["material"]["correction_id"],
        "topic": record["topic"],
        "target_platforms": record["target_platforms"],
    }


def binding_lines(binding: dict) -> str:
    return "\n".join((
        "- 写作依据：作者素材（未进行平台研究）",
        f"- 作者素材快照：{binding['author_evidence_path']}",
        f"- 作者素材 SHA-256：{binding['author_evidence_sha256']}",
    ))
