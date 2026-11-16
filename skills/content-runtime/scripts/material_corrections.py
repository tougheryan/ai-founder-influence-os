"""Immutable author corrections; the run pointer is committed with approvals."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path


def correction_path(project: Path, run_id: str, correction_id: str) -> Path:
    if not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}", run_id) or not re.fullmatch(r"correction_[a-f0-9]{32}", correction_id):
        raise ValueError("素材修正编号不正确")
    path = project / "runs" / run_id / "material-corrections" / f"{correction_id}.json"
    if path.resolve() != path.absolute():
        raise ValueError("素材修正不能经过符号链接")
    return path


def base_context(project: Path, run_id: str) -> tuple[dict, str]:
    path = project / "sessions" / "material-analysis" / f"{run_id}.json"
    if path.resolve() != path.absolute():
        raise ValueError("素材记录不能经过符号链接")
    raw = path.read_bytes()
    value = json.loads(raw)
    if value.get("runId") != run_id or value.get("schema") != "aifios.material-analysis.v1":
        raise ValueError("素材记录不属于本期")
    return value, hashlib.sha256(raw).hexdigest()


def current_correction(project: Path, run: dict) -> dict | None:
    pointer = run.get("material_correction")
    if not pointer:
        return None
    path = correction_path(project, run["run_id"], pointer.get("id", ""))
    raw = path.read_bytes()
    record = json.loads(raw)
    if (pointer.get("path") != path.relative_to(project).as_posix()
            or pointer.get("sha256") != hashlib.sha256(raw).hexdigest()
            or record.get("run_id") != run["run_id"] or record.get("id") != pointer["id"]
            or record.get("schema") != "echo.material-correction.v1"):
        raise ValueError("素材修正记录无法核对，请重新读取")
    context, _ = base_context(project, run["run_id"])
    # A genuinely new input starts a new extraction; never overlay corrections
    # belonging to the old material. Prior approval bindings still mismatch.
    if context.get("inputFingerprint") != record.get("input_fingerprint"):
        return None
    if context.get("analysisStatus") == "stale" or context.get("analysisInputFingerprint") != record.get("input_fingerprint"):
        raise ValueError("原始素材已经变化，请先重新整理")
    return record


def validate_correction(record: dict) -> None:
    if record.get("schema") != "echo.material-correction.v1":
        raise ValueError("素材修正格式不正确")
    for key in ("base_file_sha256", "input_fingerprint", "expected_fingerprint"):
        if not re.fullmatch(r"[a-f0-9]{64}", str(record.get(key, ""))):
            raise ValueError("素材修正缺少原版本")
    analysis = record.get("analysis")
    if not isinstance(analysis, dict) or not isinstance(analysis.get("summary"), str) or not analysis["summary"].strip() or len(analysis["summary"].encode()) > 12288:
        raise ValueError("请填写素材概述")
    groups = ["facts", "opinions", "cases", "authorRequirements", "risks"]
    if "illustrations" in analysis:
        groups.append("illustrations")
    for key in groups:
        values = analysis.get(key)
        if not isinstance(values, list) or len(values) > 12 or any(not isinstance(v, str) or not v.strip() or len(v.encode()) > 2048 for v in values):
            raise ValueError("每组最多 12 条，每条不超过 2048 字节")
    if len(json.dumps(record, ensure_ascii=False).encode()) > 256 * 1024:
        raise ValueError("素材修正内容过长")
