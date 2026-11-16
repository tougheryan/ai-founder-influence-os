"""Dispatch records only; never a service receipt, cost estimate or model cap."""
from __future__ import annotations

import json
import os
import re
import stat
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


class LayoutCallRecordError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _write(project: Path, record: dict) -> None:
    directory = project
    for part in ("sessions", "layout-service-calls"):
        directory /= part
        directory.mkdir(mode=0o700, exist_ok=True)
        if not stat.S_ISDIR(directory.lstat().st_mode):
            raise OSError("Invalid layout record directory")
    temporary = directory / f".{uuid.uuid4().hex}.tmp"
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(record, stream, ensure_ascii=False)
        temporary.replace(directory / f"{record['id']}.json")
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def record_article_layout(project: Path, *, slug: str, revision_id: str | None, theme: str, restyle: bool):
    if (not isinstance(slug, str) or not re.fullmatch(r"[A-Za-z0-9\u4e00-\u9fff-]{1,80}", slug)
            or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", theme)
            or (revision_id is not None and (not isinstance(revision_id, str) or not re.fullmatch(r"r[0-9]{3,12}", revision_id)))):
        raise LayoutCallRecordError("无法核对排版请求所属内容，本次未请求排版服务。")
    record = {
        "schema": "echo.layout-call.v1", "id": f"layout_{uuid.uuid4().hex}",
        "operation": "article-restyle" if restyle else "article-layout",
        "runSlug": slug, "revisionId": revision_id, "theme": theme,
        "startedAt": _now(), "completedAt": None, "status": "started", "ownerPid": os.getpid(),
    }
    try:
        _write(project, record)
    except OSError:
        raise LayoutCallRecordError("无法保存排版请求记录，本次未请求排版服务。请检查项目存储后重试。") from None
    try:
        yield
    except Exception:
        record.update(status="failed", completedAt=_now())
        try:
            _write(project, record)
        except OSError:
            raise LayoutCallRecordError("排版请求已尝试，但结束记录未能保存；费用未知。请先核对已有结果，再决定是否重试。") from None
        raise
    else:
        record.update(status="completed", completedAt=_now())
        try:
            _write(project, record)
        except OSError:
            raise LayoutCallRecordError("排版请求已尝试，但结束记录未能保存；费用未知。请先核对已有结果，再决定是否重试。") from None
