#!/usr/bin/env python3
"""content-runtime · AI Founder Influence OS 轻量状态与文件管理器

用法:
    python content_runtime.py --project ~/ai-content-system init
    python content_runtime.py --project ~/ai-content-system write --step intake --slug demo --content "..." --source "用户输入"
    python content_runtime.py --project ~/ai-content-system read --step intake --latest
    python content_runtime.py --project ~/ai-content-system list --days 7
    python content_runtime.py --project ~/ai-content-system state
    python content_runtime.py --project ~/ai-content-system validate --step intake --file pipeline/intake/2026-06-23-demo-intake.md
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any


STEPS = [
    "intake", "validate", "angle", "breakdown",
    "write", "douyin", "xhs", "platform-adapt", "visual", "prelaunch",
    "compliance", "audit", "publish", "review", "archive", "twin",
]

REQUIRED_SECTIONS = {
    "intake": ["0. 素材场景", "1. 人物", "3. 观点", "6. 商业意图"],
    "validate": ["1. 立项决策", "3. 商业成立性判断", "4. 平台首发策略"],
    "angle": ["推荐角度", "角度对比表", "建议"],
    "breakdown": ["关键词矩阵", "标题方案", "开场钩子库"],
    "write": [],  # 长文太灵活
    "douyin": [],
    "xhs": [],
    "visual": [],
    "prelaunch": ["1. 事实层检查", "2. 风格层检查", "3. 平台规则层检查", "4. 商业闭环检查"],
    "compliance": ["1. 违禁词扫描", "2. 广告法敏感词", "3. 平台规则风险", "4. 版权风险"],
    "audit": ["1. 来源追溯", "2. 事实校验", "5. 修改建议"],
    "review": ["1. 表现记录", "3. 评论洞察", "7. 下一条建议"],
    "archive": [],
    "twin": ["2. 内容 DNA 提取", "3. 结构模式识别", "4. 表达特征提取"],
}


@dataclass
class SessionState:
    project: str
    current_step: str | None = None
    latest_files: dict[str, str | None] = None
    updated_at: str | None = None

    def __post_init__(self):
        if self.latest_files is None:
            self.latest_files = {s: None for s in STEPS}


class ContentRuntime:
    def __init__(self, project: Path | str):
        self.project = Path(project).expanduser()
        self.pipeline = self.project / "pipeline"
        self.brain_dir = self.project / "brain"
        self.sessions = self.project / "sessions"
        self.assets = self.project / "assets"
        self.materials = self.project / "materials"
        self.state_file = self.sessions / "latest.json"

    def init(self) -> dict[str, Any]:
        """初始化项目目录结构。"""
        dirs = [
            self.pipeline / "intake",
            self.pipeline / "validate",
            self.pipeline / "angles",
            self.pipeline / "breakdown",
            self.pipeline / "final",
            self.pipeline / "platform-adapt",
            self.pipeline / "platform-adapt" / "wechat",
            self.pipeline / "platform-adapt" / "xhs",
            self.pipeline / "platform-adapt" / "douyin",
            self.pipeline / "audit",
            self.pipeline / "visual",
           self.pipeline / "review",
           self.pipeline / "archive",
           self.pipeline / "twin",
            self.brain_dir,
            self.brain_dir / "twin",
            self.sessions,
            self.assets,
            self.materials,
        ]
        for d in dirs:
            d.mkdir(parents=True, exist_ok=True)

        # 初始化 brain 文件
        for name in ["insights.md", "style-evolution.md", "case-library.md", "no-fly-zone.md"]:
            p = self.brain_dir / name
            if not p.exists():
                p.write_text(f"# {name[:-3].replace('-', ' ').title()}\n\n", encoding="utf-8")

        for name in ["content-dna.md", "pattern-library.md", "voice-signature.md", "evolution-log.md", "reader-profile.md"]:
            p = self.brain_dir / "twin" / name
            if not p.exists():
                p.write_text(f"# {name[:-3].replace('-', ' ').title()}\n\n", encoding="utf-8")

        if not self.state_file.exists():
            self._save_state(SessionState(project=str(self.project)))

        return {"status": "initialized", "project": str(self.project)}

    def _load_state(self) -> SessionState:
        if not self.state_file.exists():
            return SessionState(project=str(self.project))
        data = json.loads(self.state_file.read_text(encoding="utf-8"))
        return SessionState(**data)

    def _save_state(self, state: SessionState) -> None:
        self.sessions.mkdir(parents=True, exist_ok=True)
        state.updated_at = datetime.now().isoformat()
        self.state_file.write_text(json.dumps(asdict(state), ensure_ascii=False, indent=2), encoding="utf-8")

    def write(self, step: str, slug: str, content: str, source: str | None = None) -> dict[str, Any]:
        """写入步骤输出，并更新 session state。"""
        if step not in STEPS:
            raise ValueError(f"未知步骤: {step}，可用: {STEPS}")

        step_dir = self.pipeline / step
        step_dir.mkdir(parents=True, exist_ok=True)

        date_str = datetime.now().strftime("%Y-%m-%d")
        filename = f"{date_str}-{slug}-{step}.md"
        file_path = step_dir / filename

        frontmatter = {
            "step": step,
            "slug": slug,
            "date": date_str,
            "source": source or "manual",
            "created_at": datetime.now().isoformat(),
        }
        fm_yaml = "\n".join(f"{k}: {v}" for k, v in frontmatter.items())
        full_content = f"---\n{fm_yaml}\n---\n\n{content}\n"
        file_path.write_text(full_content, encoding="utf-8")

        state = self._load_state()
        state.current_step = step
        state.latest_files[step] = str(file_path.relative_to(self.project))
        self._save_state(state)

        return {"status": "written", "path": str(file_path), "step": step, "slug": slug}

    def read(self, step: str, latest: bool = False, file: str | None = None) -> dict[str, Any]:
        """读取某步骤输出。"""
        target: Path | None = None
        if file:
            target = self.project / file
        elif latest:
            state = self._load_state()
            rel = state.latest_files.get(step)
            if not rel:
                raise FileNotFoundError(f"没有找到步骤 {step} 的最新文件")
            target = self.project / rel
        else:
            raise ValueError("必须指定 --file 或 --latest")

        if not target.exists():
            raise FileNotFoundError(f"文件不存在: {target}")

        text = target.read_text(encoding="utf-8")
        frontmatter, body = self._split_frontmatter(text)
        return {"path": str(target), "frontmatter": frontmatter, "body": body}

    def _split_frontmatter(self, text: str) -> tuple[dict[str, str], str]:
        m = re.match(r"^---\n(.*?)\n---\n\n?(.*)$", text, re.DOTALL)
        if not m:
            return {}, text
        fm = {}
        for line in m.group(1).strip().splitlines():
            if ":" in line:
                k, v = line.split(":", 1)
                fm[k.strip()] = v.strip()
        return fm, m.group(2)

    def list_recent(self, days: int = 7) -> list[dict[str, Any]]:
        """列出最近 N 天的 pipeline 文件。"""
        cutoff = datetime.now() - timedelta(days=days)
        results = []
        if not self.pipeline.exists():
            return results
        for p in sorted(self.pipeline.rglob("*.md"), key=lambda x: x.stat().st_mtime, reverse=True):
            mtime = datetime.fromtimestamp(p.stat().st_mtime)
            if mtime < cutoff:
                continue
            frontmatter, _ = self._split_frontmatter(p.read_text(encoding="utf-8"))
            results.append({
                "path": str(p.relative_to(self.project)),
                "step": frontmatter.get("step", p.parent.name),
                "slug": frontmatter.get("slug", p.stem),
                "mtime": mtime.isoformat(),
            })
        return results

    def state(self) -> dict[str, Any]:
        """读取当前 session state。"""
        state = self._load_state()
        return asdict(state)

    def validate(self, step: str, file: str) -> dict[str, Any]:
        """简单校验文件结构。"""
        target = self.project / file
        if not target.exists():
            raise FileNotFoundError(f"文件不存在: {target}")

        text = target.read_text(encoding="utf-8")
        _, body = self._split_frontmatter(text)
        required = REQUIRED_SECTIONS.get(step, [])
        missing = [s for s in required if s not in body]
        return {
            "path": str(target),
            "step": step,
            "valid": len(missing) == 0,
            "missing_sections": missing,
            "required_sections": required,
        }
    def _schema_file(self, step: str) -> Path | None:
        p = Path(__file__).parent.parent / "schemas" / f"{step}.schema.json"
        return p if p.exists() else None

    def validate(self, step: str, file: str) -> dict[str, Any]:
        """基于 JSON Schema 校验文件结构，无 schema 时回退到 REQUIRED_SECTIONS。"""
        target = self.project / file
        if not target.exists():
            raise FileNotFoundError(f"文件不存在: {target}")

        text = target.read_text(encoding="utf-8")
        frontmatter, body = self._split_frontmatter(text)
        schema_path = self._schema_file(step)

        if schema_path:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            common = json.loads((schema_path.parent / "common.json").read_text(encoding="utf-8"))
            fm_schema = common.get("properties", {}).get("frontmatter", {})
            fm_required = fm_schema.get("required", [])
            missing_fm = [k for k in fm_required if not frontmatter.get(k)]
            step_enum = fm_schema.get("properties", {}).get("step", {}).get("enum", [])
            step_invalid = step_enum and frontmatter.get("step") not in step_enum
            body_patterns = []
            for prop in schema.get("properties", {}).values():
                if isinstance(prop, dict):
                    body_patterns.extend(prop.get("allOf", []))
            pattern_errors = []
            for item in body_patterns:
                pat = item.get("pattern")
                if pat and not re.search(pat, body):
                    pattern_errors.append(pat)
            return {
                "path": str(target),
                "step": step,
                "valid": not missing_fm and not step_invalid and not pattern_errors,
                "schema": str(schema_path),
                "missing_frontmatter": missing_fm,
                "step_invalid": step_invalid,
                "missing_patterns": pattern_errors,
            }

        required = REQUIRED_SECTIONS.get(step, [])
        missing = [s for s in required if s not in body]
        return {
            "path": str(target),
            "step": step,
            "valid": len(missing) == 0,
            "missing_sections": missing,
            "required_sections": required,
        }

    def brain(self, file: str, content: str | None = None, read: bool = False) -> dict[str, Any]:
        """追加或读取 brain 文件。"""
        target = self.brain_dir / file
        if read:
            if not target.exists():
                return {"path": str(target), "exists": False, "content": ""}
            return {"path": str(target), "exists": True, "content": target.read_text(encoding="utf-8")}
        if content is None:
            raise ValueError("必须指定 --content 或 --read")
        target.parent.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M")
        append_text = f"\n\n## {timestamp}\n\n{content}\n"
        with target.open("a", encoding="utf-8") as f:
            f.write(append_text)
        return {"status": "appended", "path": str(target), "file": file}


def main() -> int:
    parser = argparse.ArgumentParser(description="content-runtime")
    parser.add_argument("--project", required=True, help="AI content system 项目根目录")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("init", help="初始化项目目录")

    p_write = sub.add_parser("write", help="写入步骤输出")
    p_write.add_argument("--step", required=True, choices=STEPS)
    p_write.add_argument("--slug", required=True)
    p_write.add_argument("--content", required=True, help="内容字符串或 @file_path")
    p_write.add_argument("--source", default=None)

    p_read = sub.add_parser("read", help="读取步骤输出")
    p_read.add_argument("--step", required=True, choices=STEPS)
    p_read.add_argument("--latest", action="store_true")
    p_read.add_argument("--file", default=None)

    p_list = sub.add_parser("list", help="列出最近文件")
    p_list.add_argument("--days", type=int, default=7)

    sub.add_parser("state", help="读取 session state")

    p_val = sub.add_parser("validate", help="校验文件结构")
    p_val.add_argument("--step", required=True, choices=STEPS)
    p_val.add_argument("--file", required=True)

    p_brain = sub.add_parser("brain", help="追加/读取 brain 文件")
    p_brain.add_argument("--file", required=True, help="brain 文件相对路径，如 insights.md")
    p_brain.add_argument("--content", default=None, help="追加内容字符串或 @file_path；与 --read 互斥")
    p_brain.add_argument("--read", action="store_true", help="读取 brain 文件")

    args = parser.parse_args()
    rt = ContentRuntime(args.project)

    try:
        if args.command == "init":
            print(json.dumps(rt.init(), ensure_ascii=False, indent=2))
        elif args.command == "write":
            content = args.content
            if content.startswith("@"):
                content = Path(content[1:]).read_text(encoding="utf-8")
            print(json.dumps(rt.write(args.step, args.slug, content, args.source), ensure_ascii=False, indent=2))
        elif args.command == "read":
            print(json.dumps(rt.read(args.step, args.latest, args.file), ensure_ascii=False, indent=2))
        elif args.command == "list":
            print(json.dumps(rt.list_recent(args.days), ensure_ascii=False, indent=2))
        elif args.command == "state":
            print(json.dumps(rt.state(), ensure_ascii=False, indent=2))
        elif args.command == "validate":
            print(json.dumps(rt.validate(args.step, args.file), ensure_ascii=False, indent=2))
        elif args.command == "brain":
            content = args.content
            if content and content.startswith("@"):
                content = Path(content[1:]).read_text(encoding="utf-8")
            print(json.dumps(rt.brain(args.file, content, args.read), ensure_ascii=False, indent=2))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
