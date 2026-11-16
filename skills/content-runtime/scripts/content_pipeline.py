#!/usr/bin/env python3
"""content-pipeline · AI Founder Influence OS 流水线导演

用法：
    python3 content_pipeline.py --project ~/ai-content-system status
    python3 content_pipeline.py --project ~/ai-content-system next
    python3 content_pipeline.py --project ~/ai-content-system next --slug demo
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

# 让脚本可以导入同目录的 content_runtime
sys.path.insert(0, str(Path(__file__).parent))
from content_runtime import ContentRuntime, STEP_DIRS, STEPS, SUPPORTED_PLATFORMS
from angle_quality import audit_angle
from breakdown_quality import audit_breakdown
from dbs_fusion_apply import extract_target_path, parse_writeback_rows, pipeline_step_for_path
from intake_quality import audit_intake
from market_signal import fetch_market_signals, persist_market_snapshot, verify_market_snapshot
from market_signal_report import build_market_signal_report
from validate_quality import audit_validate
import author_evidence


PRODUCTION_LOOP_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "production-loop.json"


def _load_production_loop_config() -> dict[str, Any]:
    """Load the workflow contract once instead of duplicating its default path."""
    try:
        config = json.loads(PRODUCTION_LOOP_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"无法读取内容生产流程配置：{PRODUCTION_LOOP_CONFIG_PATH}") from exc
    if not isinstance(config, dict):
        raise RuntimeError("内容生产流程配置必须是 JSON object。")
    return config


def _schedule_steps(config: dict[str, Any], schedule_id: str) -> tuple[str, ...]:
    schedules = config.get("schedules")
    if not isinstance(schedules, dict):
        raise RuntimeError("内容生产流程配置缺少 schedules。")
    schedule = schedules.get(schedule_id)
    if not isinstance(schedule, dict):
        raise RuntimeError(f"内容生产流程配置缺少 schedules.{schedule_id}。")
    steps = schedule.get("runtime_steps")
    if not isinstance(steps, list) or not all(isinstance(step, str) and step for step in steps):
        raise RuntimeError(f"schedules.{schedule_id}.runtime_steps 必须是非空步骤列表。")
    return tuple(steps)


def _default_schedule_steps(config: dict[str, Any]) -> tuple[str, ...]:
    schedule_ids = config.get("default_schedule")
    if not isinstance(schedule_ids, list) or not all(isinstance(item, str) and item for item in schedule_ids):
        raise RuntimeError("内容生产流程配置缺少 default_schedule。")
    return tuple(step for schedule_id in schedule_ids for step in _schedule_steps(config, schedule_id))


def _optional_branch_steps(config: dict[str, Any], branch_ids: set[str]) -> tuple[str, ...]:
    branches = config.get("optional_branches")
    if not isinstance(branches, list):
        raise RuntimeError("内容生产流程配置缺少 optional_branches。")
    steps: list[str] = []
    for branch in branches:
        if not isinstance(branch, dict) or branch.get("id") not in branch_ids:
            continue
        runtime_steps = branch.get("runtime_steps")
        if not isinstance(runtime_steps, list) or not all(isinstance(step, str) and step for step in runtime_steps):
            raise RuntimeError(f"optional_branches.{branch.get('id')}.runtime_steps 必须是步骤列表。")
        steps.extend(runtime_steps)
    return tuple(steps)


def _schedule_terminal_approval(config: dict[str, Any], schedule_id: str) -> str:
    schedules = config.get("schedules")
    schedule = schedules.get(schedule_id) if isinstance(schedules, dict) else None
    approval = schedule.get("terminal_approval") if isinstance(schedule, dict) else None
    if not isinstance(approval, str) or not approval:
        raise RuntimeError(f"schedules.{schedule_id}.terminal_approval 必须是非空字符串。")
    return approval


def _build_default_pipeline(config: dict[str, Any]) -> list[str | dict[str, Any]]:
    """Materialize the default production schedule for legacy CLI status output.

    ``prelaunch`` and ``compliance`` stay a single UI/status group for backward
    compatibility, while their ordered runtime steps continue to come from the
    config. All other steps remain one-to-one with the configured default path.
    """
    editorial = _schedule_steps(config, "editorial_core")
    draft_preparation = _schedule_steps(config, "draft_preparation")
    configured_path = config.get("standard_path")
    default_path = list(_default_schedule_steps(config))
    if default_path != [*editorial, *draft_preparation]:
        raise RuntimeError("default_schedule 必须等于 editorial_core + draft_preparation。")
    if configured_path != default_path:
        raise RuntimeError("standard_path 必须等于 editorial_core + draft_preparation。")

    pipeline: list[str | dict[str, Any]] = []
    index = 0
    while index < len(default_path):
        step = default_path[index]
        if step == "prelaunch" and default_path[index + 1:index + 2] == ["compliance"]:
            pipeline.append({"step": "check", "branches": ["prelaunch", "compliance"], "label": "发布前检查"})
            index += 2
            continue
        pipeline.append(step)
        index += 1
    return pipeline


PRODUCTION_LOOP_CONFIG = _load_production_loop_config()
EDITORIAL_CORE_STEPS = _schedule_steps(PRODUCTION_LOOP_CONFIG, "editorial_core")
DRAFT_PREPARATION_STEPS = _schedule_steps(PRODUCTION_LOOP_CONFIG, "draft_preparation")
PUBLICATION_RESULT_STEPS = _schedule_steps(PRODUCTION_LOOP_CONFIG, "publication_result")
WEEKLY_LEARNING_STEPS = _schedule_steps(PRODUCTION_LOOP_CONFIG, "weekly_learning")
DRAFT_INFORMATION_APPROVAL = _schedule_terminal_approval(PRODUCTION_LOOP_CONFIG, "draft_preparation")
DEFAULT_EDITORIAL_CORE_STEPS = EDITORIAL_CORE_STEPS
OPTIONAL_EXPLORATION_STEPS = _optional_branch_steps(PRODUCTION_LOOP_CONFIG, {"angle-breakdown", "business-diagnosis"})
OPTIONAL_PLATFORM_OVERRIDE_STEPS = _optional_branch_steps(PRODUCTION_LOOP_CONFIG, {"direct-xhs", "platform-adaptation"})
POST_PUBLISH_STEPS = (*PUBLICATION_RESULT_STEPS, *WEEKLY_LEARNING_STEPS)
DEFAULT_SCHEDULED_STEPS = _default_schedule_steps(PRODUCTION_LOOP_CONFIG)
PIPELINE = _build_default_pipeline(PRODUCTION_LOOP_CONFIG)

STEP_SKILLS: dict[str, dict[str, str]] = {
    "intake": {"skill": "content-intake", "input": "用户素材", "output": "素材理解报告"},
    "validate": {"skill": "content-validate", "input": "intake 报告", "output": "立项决策"},
    "blueprint": {"skill": "content-blueprint", "input": "validate 报告 + intake 报告 + 各平台公开样本", "output": "共享事实底座与平台内容蓝图"},
    "angle": {"skill": "content-angle", "input": "intake/validate 报告", "output": "角度清单"},
    "breakdown": {"skill": "content-breakdown", "input": "angle 报告", "output": "关键词矩阵/标题/钩子"},
    "write": {"skill": "wechat-writer", "input": "旧任务的已确认蓝图", "output": "旧任务公众号母稿"},
    "package": {
        "skill": "content-package",
        "input": "共享事实底座 + 已选平台蓝图 + 各平台公开样本",
        "output": "已选平台原生内容包",
    },
    "xhs": {"skill": "xhs-card", "input": "breakdown 报告", "output": "小红书图文卡片"},
    "platform-adapt": {"skill": "content-repurpose", "input": "主阵地成稿", "output": "阵地适配方案"},
    "visual": {"skill": "content-visual", "input": "成稿", "output": "视觉发布产物"},
    "prelaunch": {"skill": "content-prelaunch", "input": "成稿", "output": "发布前检查清单"},
    "compliance": {"skill": "content-compliance", "input": "成稿", "output": "合规风险报告"},
    "audit": {"skill": "content-audit", "input": "成稿", "output": "可信审核报告"},
    "publish": {"skill": "manual", "input": "过审内容", "output": "发布到平台"},
    "performance": {"skill": "content-performance-collector", "input": "发布记录 + 授权数据源", "output": "数据回流报告"},
    "review": {"skill": "content-review", "input": "发布数据", "output": "收获总结"},
    "archive": {"skill": "self-archive", "input": "全部产物", "output": "归档沉淀"},
    "twin": {"skill": "content-twin", "input": "最终成品", "output": "数字孪生观察"},
}

PLATFORM_LABELS = {
    "wechat": "公众号",
    "xhs": "小红书",
    "shipinhao": "视频号",
    "douyin": "抖音",
    "moments": "朋友圈",
}

# 所有发布目标都以 package 为最终内容绑定。这里保存的是“拿到包后，
# 人在对应后台可直接填写/拍摄/发布什么”，不是视频生成或自动发布指令。
PLATFORM_BINDINGS: dict[str, dict[str, str]] = {
    "wechat": {
        "delivery_step": "package",
        "content_type": "公众号长文发布字段",
        "publish_form": "标题、摘要、正文、首图策略与排版选择",
    },
    "xhs": {
        "delivery_step": "package",
        "content_type": "小红书图文发布字段",
        "publish_form": "标题、封面、正文、标签、页卡与评论承接",
    },
    "shipinhao": {
        "delivery_step": "package",
        "content_type": "视频号口播发布字段",
        "publish_form": "标题、发布文案、封面、口播、镜头、字幕与 B-roll",
    },
    "douyin": {
        "delivery_step": "package",
        "content_type": "抖音口播发布字段",
        "publish_form": "标题、发布文案、话题、封面、口播、镜头、字幕与 B-roll",
    },
    "moments": {
        "delivery_step": "package",
        "content_type": "朋友圈观点图文发布字段",
        "publish_form": "短文案、选图顺序、图文页结构与互动句",
    },
}

# Legacy branches are optional source drafts only. New runs use package as the
# final binding for every target; no target creates a media-rendering branch.
PLATFORM_BRANCHES = {
    "wechat": "write",
    "xhs": "xhs",
    "shipinhao": "package",
    "douyin": "package",
    "moments": "package",
}

DRAFT_STEPS = ["write", "xhs"]
DRAFT_BINDING_LABELS = {
    "package": {"platform": "selected", "label": "已选平台", "content_type": "平台原生内容包"},
    "write": {"platform": "wechat", "label": "公众号", "content_type": "长文"},
    "xhs": {"platform": "xhs", "label": "小红书", "content_type": "图文"},
}

UPSTREAM: dict[str, list[str]] = {
    "intake": [],
    "validate": ["intake"],
    "blueprint": ["validate"],
    "angle": ["validate"],
    "breakdown": ["angle"],
    "write": ["blueprint"],
    "package": ["blueprint"],
    "xhs": ["breakdown"],
    "platform-adapt": ["write", "xhs"],
    "visual": ["package"],
    "prelaunch": ["visual"],
    "compliance": ["package"],
    "audit": ["prelaunch", "compliance"],
    "publish": ["audit"],
    "performance": ["publish"],
    "review": ["performance"],
    "archive": ["review"],
    "twin": ["archive"],
}

BLUEPRINT_GATED_STEPS = {
    "write",
    "package",
    "visual",
    "prelaunch",
    "compliance",
    "audit",
    "publish",
    "performance",
    "review",
    "archive",
    "twin",
}

PACKAGE_GATED_STEPS = {
    "visual",
    "prelaunch",
    "compliance",
    "audit",
    "publish",
    "performance",
    "review",
    "archive",
    "twin",
}

SKILL_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = SKILL_DIR.parent.parent
RUNTIME_CLI = f"python3 {SKILL_DIR / 'scripts' / 'content_runtime.py'}"
DBS_FUSION_APPLY_CLI = f"python3 {SKILL_DIR / 'scripts' / 'dbs_fusion_apply.py'}"
STYLE_RECOMMENDER = REPO_ROOT / "skills" / "wechat-writer" / "scripts" / "style_recommender.py"

DBS_FUSION_PROMPT_STEPS = {
    "blueprint",
    "write",
    "package",
    "xhs",
    "visual",
    "prelaunch",
    "compliance",
    "audit",
    "publish",
    "performance",
}

WECHAT_PREFLIGHT_REQUIRED_SECTIONS = {
    "upstream_constraints": (r"(?m)^##\s*0\.\s+上游约束", "缺少 `## 0. 上游约束`"),
    "title_options": (r"(?m)^##\s*标题方案", "缺少 `## 标题方案`"),
    "opening_hooks": (r"(?m)^##\s*开场钩子库", "缺少 `## 开场钩子库`"),
    "platform_fit": (r"(?m)^##\s*阵地适配建议", "缺少 `## 阵地适配建议`"),
    "supplement_list": (r"(?m)^##\s*素材补充清单", "缺少 `## 素材补充清单`"),
    "next_instruction": (r"(?m)^##\s*下一步执行指令", "缺少 `## 下一步执行指令`"),
}


class PipelineDirector:
    def __init__(self, project: Path | str, slug: str | None = None):
        self.rt = ContentRuntime(project)
        self.rt.init()
        self.state = self.rt.state()
        self.slug = self.rt.normalize_slug(slug) if slug else None
        self.target_platforms = self._load_target_platforms()

    def _load_target_platforms(self) -> list[str]:
        state_platforms = []
        if self.slug:
            try:
                run = self.rt.run_state(slug=self.slug)
            except FileNotFoundError:
                return []
            return [platform for platform in run.get("target_platforms", []) if platform in PLATFORM_BINDINGS]
        active_run_id = self.state.get("active_run_id")
        if active_run_id:
            try:
                run = self.rt.run_state(run_id=active_run_id)
                state_platforms = run.get("target_platforms") or []
            except Exception:
                state_platforms = []
        if state_platforms:
            return [platform for platform in state_platforms if platform in PLATFORM_BINDINGS]

        state_file = self.rt.sessions / "session-state.json"
        if not state_file.exists():
            return []
        try:
            data = json.loads(state_file.read_text(encoding="utf-8"))
        except Exception:
            return []
        platforms = data.get("target_platforms") or []
        return [platform for platform in platforms if platform in PLATFORM_BINDINGS]

    def _scoped_run(self) -> dict[str, Any]:
        slug = self._scope_slug()
        if not slug:
            return {}
        try:
            return self.rt.run_state(slug=slug)
        except FileNotFoundError:
            return {}

    def _author_mode(self) -> bool:
        # A declared mode selects the route, but cannot authorize production.
        # next/flow must verify the immutable evidence before issuing any task.
        return self._scoped_run().get("research_mode") == author_evidence.MODE

    def _scheduled_steps(self) -> list[str]:
        if self._author_mode():
            return list(PRODUCTION_LOOP_CONFIG["writing_modes"][author_evidence.MODE]["runtime_steps"])
        return list(DEFAULT_SCHEDULED_STEPS)

    def _author_source_status(self) -> dict[str, Any] | None:
        run = self._scoped_run()
        if run.get("research_mode") != author_evidence.MODE:
            return None
        try:
            return {"status": "pass", **self.rt.verify_author_source(run["run_id"])}
        except (ValueError, OSError, KeyError) as exc:
            return {"status": "blocked", "reason": str(exc), "research_mode": author_evidence.MODE}

    def _blocked_author_source(self, source: dict[str, Any], *, flow: bool = False) -> dict[str, Any]:
        message = "题目或素材依据需要重新核对：" + str(source.get("reason") or "无法验证当前记录")
        path = self.rt.sessions / ("flow-task.md" if flow else "next-task.md")
        path.write_text(
            "# 写作准备暂停\n\n" + message + "\n\n回到本期素材，核对题目、平台与整理结果后重新确认作者素材依据。"
            "旧方案和稿件保留；不会自动切换为平台研究。\n", encoding="utf-8",
        )
        return {"status": "blocked", "message": message, "project": str(self.rt.project),
                "slug": self._active_slug(), "active_slug": self._active_slug(),
                "current_step": "author-source", "recommended_step": "author-source",
                "author_source": source, "task_card": str(path)}

    def _author_source_guidance(self, source: dict[str, Any] | None, step: str) -> str:
        if not source:
            return ""
        plan_binding = ""
        if step == "package":
            plan_path = self._latest_file("blueprint")
            binding = {"path": plan_path,
                       "sha256": hashlib.sha256((self.rt.project / plan_path).read_bytes()).hexdigest(),
                       "material_correction_id": source["material_correction_id"]}
            plan_binding = "\n正文交付文件中保留下列内部版本标记（不是读者正文），用于核对所用方案：\n<!-- echo-content-plan:" + json.dumps(binding, ensure_ascii=False) + " -->\n"
        return "\n".join((
            "\n## 本期作者素材依据", author_evidence.binding_lines(source),
            f"- 作者题目：{source['topic']}",
            f"- 素材底稿：{source['source_path']}",
            f"- 本期平台：{', '.join(source['target_platforms'])}",
            "- 读取上述作者素材快照的 material.analysis，保留作者已核对的事实、观点、写作要求和边界；摘要不替代完整材料。",
            "- 未进行平台研究，不生成热度、样本量或市场验证结论。方案必须原样保留以上三行依据绑定。",
            "- 方案由作者确认后才可写正文；本期要求优先，不默认添加销售引导。\n",
            plan_binding,
        ))

    def _target_branches(self, branches: list[str]) -> list[str]:
        if not self.target_platforms:
            return branches
        allowed = {PLATFORM_BRANCHES[platform] for platform in self.target_platforms if platform in PLATFORM_BRANCHES}
        filtered = [branch for branch in branches if branch in allowed]
        return filtered or branches

    def _effective_upstreams(self, step: str) -> list[str]:
        if step == "blueprint" and self._author_mode():
            return ["intake"]
        upstreams = UPSTREAM.get(step, [])
        if step == "platform-adapt" and self.target_platforms:
            # 新的跨平台改编以 package 为唯一、已核验的内容来源；不要求
            # 为视频号重新引入独立视频生产步骤。
            return ["package"]
        return upstreams

    def _should_skip_step(self, step: str) -> bool:
        if step == "validate" and self._author_mode():
            return True
        # 单阵地生产不需要“一鱼多吃/平台改编”，直接进入视觉和检查。
        if step == "platform-adapt" and self.target_platforms and len(set(self.target_platforms)) <= 1:
            return True
        return False

    def _step_label(self, step: str) -> str:
        return STEP_SKILLS.get(step, {}).get("output", step)

    def _target_platform_labels(self) -> list[str]:
        labels = []
        for platform in self.target_platforms:
            label = PLATFORM_LABELS.get(platform, platform)
            if label not in labels:
                labels.append(label)
        return labels

    def _target_platform_bindings(self) -> list[dict[str, str]]:
        """Expose the release-form contract without turning it into a publish API."""
        bindings = []
        for platform in self.target_platforms:
            meta = PLATFORM_BINDINGS.get(platform)
            if not meta:
                continue
            bindings.append({
                "platform": platform,
                "label": PLATFORM_LABELS.get(platform, platform),
                **meta,
            })
        return bindings

    def _package_delivery_contract_markdown(self, step: str) -> str:
        if step != "package":
            return ""
        targets = self.target_platforms or list(SUPPORTED_PLATFORMS)
        rows = []
        for platform in targets:
            meta = PLATFORM_BINDINGS.get(platform)
            if not meta:
                continue
            rows.append(
                f"- {PLATFORM_LABELS[platform]}：{meta['content_type']}；{meta['publish_form']}。"
            )
        return "\n".join([
            "",
            "## 已选平台原生交付契约",
            "- 只交付本期已选平台，不补齐未选平台，也不从公众号母稿派生其他平台内容。",
            "- 视频号只交付一条独立口播、镜头、字幕和 B-roll 执行稿；不进入静态视觉生产。",
            "- 小红书必须给出封面三句话、P1-P8 逐页卡片、发布正文和结尾标签。",
            "- 微信公众号必须给出可直接排版的完整长文、头图语义和正文插图位置。",
            *rows,
            "",
        ])

    def _latest_file(self, step: str) -> str | None:
        scope_slug = self._scope_slug()
        if not scope_slug:
            return None
        return self.state.get("latest_by_slug", {}).get(scope_slug, {}).get(step)

    def _scope_slug(self) -> str | None:
        """Return the only slug allowed for this status/next calculation."""
        if self.slug:
            return self.rt.normalize_slug(self.slug)
        active_run_id = self.state.get("active_run_id")
        if active_run_id:
            try:
                run = self.rt.run_state(run_id=active_run_id)
            except FileNotFoundError:
                return None
            return self.rt.normalize_slug(run.get("slug") or self.state.get("current_slug") or "")
        return None

    def _legacy_file(self, step: str) -> str | None:
        """Find a same-slug pipeline file that was not registered in session state."""
        scope_slug = self._scope_slug()
        if not scope_slug:
            return None
        directory = self.rt.pipeline / STEP_DIRS.get(step, step)
        if not directory.exists():
            return None
        matches = []
        for path in directory.glob("*.md"):
            try:
                frontmatter, _ = self.rt._split_frontmatter(path.read_text(encoding="utf-8"))
            except (OSError, UnicodeError):
                continue
            if self.rt.normalize_slug(frontmatter.get("slug", "")) == scope_slug:
                matches.append(path)
        if not matches:
            return None
        newest = max(matches, key=lambda path: path.stat().st_mtime)
        return str(newest.relative_to(self.rt.project))

    def _evidence_status(self, step: str) -> str:
        bound = self._latest_file(step)
        if bound:
            target = self.rt.project / bound
            if target.exists():
                return "bound"
        if self._legacy_file(step):
            return "unbound"
        return "missing"

    def _is_done(self, step: str) -> bool:
        if self._evidence_status(step) != "bound":
            return False
        if self._author_mode():
            run = self._scoped_run()
            if step == "blueprint":
                try:
                    self.rt.verify_author_source(run["run_id"], self._latest_file(step))
                except (ValueError, OSError, KeyError):
                    return False
            elif step == "package":
                if self.rt.content_plan_status(run["run_id"]).get("status") not in {"current", "retained"}:
                    return False
        return True

    def _missing_upstreams(self, step: str) -> list[str]:
        return [upstream for upstream in self._effective_upstreams(step) if not self._is_done(upstream)]

    def _step_warning(self, step: str, done: bool) -> str | None:
        evidence_status = self._evidence_status(step)
        if evidence_status == "unbound":
            return "产物存在但未绑定到当前 run，不能计入完成链路。"
        if not done:
            return None
        missing = self._missing_upstreams(step)
        if not missing:
            return None
        return f"上游未完成: {', '.join(missing)}"

    def _active_slug(self) -> str:
        """从最近写入的 pipeline 文件中提取当前 slug。"""
        scope_slug = self._scope_slug()
        if scope_slug:
            return scope_slug
        return "current"

    def _read_step_body(self, step: str, max_chars: int = 1500) -> str:
        rel = self._latest_file(step)
        if not rel:
            return ""
        try:
            if step == "intake":
                data = self.rt.read(step, file=rel, summary=True)
                item = data.get("summary") or {}
                lines = [
                    "## 素材索引摘要（默认轻量上下文）",
                    f"- 完整报告：`{data.get('full_report_path') or rel}`",
                    f"- 摘要：{item.get('summary') or '（暂无摘要）'}",
                ]
                if item.get("key_gaps"):
                    lines.append(f"- 关键缺口：{item.get('key_gaps')}")
                if item.get("downstream_usability"):
                    lines.append(f"- 下游可用性：{item.get('downstream_usability')}")
                if item.get("body_chars"):
                    lines.append(f"- 完整报告字数：{item.get('body_chars')} 字符，未自动载入上下文。")
                return "\n".join(lines)
            data = self.rt.read(step, file=rel)
            body = data.get("body", "")
            return body[:max_chars] + ("\n\n...（已截断）" if len(body) > max_chars else "")
        except Exception as e:
            return f"读取失败: {e}"

    def _rel_to_project(self, path: str | Path) -> str:
        target = Path(path)
        if target.is_absolute():
            try:
                return str(target.relative_to(self.rt.project))
            except ValueError:
                return str(target)
        return str(target)

    def _current_draft_binding(self) -> dict[str, str] | None:
        package_rel = self._latest_file("package")
        if package_rel:
            meta = DRAFT_BINDING_LABELS["package"]
            return {
                "step": "package",
                "path": package_rel,
                "platform": meta["platform"],
                "platform_label": meta["label"],
                "content_type": meta["content_type"],
            }
        target_branches = self._target_branches(DRAFT_STEPS) if self.target_platforms else DRAFT_STEPS
        for branch in target_branches + [step for step in DRAFT_STEPS if step not in target_branches]:
            rel = self._latest_file(branch)
            if not rel:
                continue
            meta = DRAFT_BINDING_LABELS.get(branch, {})
            return {
                "step": branch,
                "path": rel,
                "platform": meta.get("platform", branch),
                "platform_label": meta.get("label", branch),
                "content_type": meta.get("content_type", "成稿"),
            }
        return None

    def _source_for_step(self, step: str, skill_name: str) -> str:
        if step in {"prelaunch", "compliance", "audit"}:
            draft = self._current_draft_binding()
            if draft and draft.get("path"):
                return f"{draft['step']}:{draft['path']}"
        return skill_name

    def _handoff_binding_markdown(self, step: str) -> str:
        if step not in {"prelaunch", "compliance", "audit"}:
            return ""
        draft = self._current_draft_binding()
        if not draft:
            return (
                "\n## 当前 run 成稿绑定\n"
                "- 状态：未找到当前 run 的公众号或小红书成稿。\n"
                "- 处理：先完成对应目标阵地的成稿，再生成发布前检查或可信审核。\n"
            )
        lines = [
            "",
            "## 当前 run 成稿绑定",
            f"- 成稿步骤：`{draft['step']}`",
            f"- 成稿路径：`{draft['path']}`",
            f"- 目标平台：{draft['platform_label']}（`{draft['platform']}`）",
            f"- 内容类型：{draft['content_type']}",
            f"- 前端参数：`draftPath={draft['path']}`，`targetPlatform={draft['platform']}`",
            "- 硬约束：输出报告必须在检查对象、资产准备度或下一步命令中原样写入上述成稿路径；不得改写成绝对路径、旧路径或其它 run 的路径。",
        ]
        if step == "audit":
            prelaunch = self._latest_file("prelaunch")
            compliance = self._latest_file("compliance")
            if prelaunch:
                lines.append(f"- 发布前检查路径：`{prelaunch}`")
            if compliance:
                lines.append(f"- 合规报告路径：`{compliance}`")
        return "\n".join(lines)

    def _latest_dbs_fusion_file(self, active_slug: str) -> str | None:
        safe_slug = self.rt.normalize_slug(active_slug or "current")
        rel = self.state.get("latest_by_slug", {}).get(safe_slug, {}).get("dbs-fusion")
        if rel:
            return rel
        root = self.rt.pipeline / "dbs-fusion"
        if not root.exists():
            return None
        for path in sorted(root.glob("*.md"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                data = self.rt.read("dbs-fusion", file=str(path))
            except Exception:
                continue
            if data.get("frontmatter", {}).get("slug") == safe_slug:
                return self._rel_to_project(data["path"])
        return None

    def _latest_apply_report(self, fusion_path: str) -> dict[str, Any] | None:
        root = self.rt.project / "quality" / "dbs-fusion-applies"
        if not root.exists():
            return None
        fusion_abs = str((self.rt.project / fusion_path).resolve(strict=False))
        fusion_rel = self._rel_to_project(fusion_path)
        for path in sorted(root.glob("*.json"), key=lambda item: item.stat().st_mtime, reverse=True):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if data.get("dry_run"):
                continue
            report_file = str(data.get("fusion_file") or "")
            report_abs = str(Path(report_file).resolve(strict=False)) if report_file else ""
            if report_file in {fusion_path, fusion_rel} or report_abs == fusion_abs:
                return data
        return None

    @staticmethod
    def _apply_report_finished(report: dict[str, Any] | None) -> bool:
        if not report:
            return False
        rows = report.get("rows") or []
        if not rows:
            return False
        return report.get("status") == "pass" and all(row.get("status") == "applied" for row in rows)

    def _pipeline_target_has_apply_marker(self, target_path: str, fusion_rel: str, active_slug: str) -> bool:
        step = pipeline_step_for_path(target_path)
        if not step:
            return False
        latest_rel = self.state.get("latest_by_slug", {}).get(active_slug, {}).get(step)
        if not latest_rel:
            return False
        try:
            data = self.rt.read(step, file=latest_rel)
        except Exception:
            return False
        source = data.get("frontmatter", {}).get("source") or ""
        body = data.get("body", "")
        return source == f"dbs-fusion-apply:{fusion_rel}" or (
            "dbs-fusion apply" in body and fusion_rel in body
        )

    def _dbs_fusion_pending_apply(self, active_slug: str, next_step: str) -> dict[str, Any] | None:
        """Find a validated dbs-fusion report that still needs explicit writeback."""
        if next_step not in DBS_FUSION_PROMPT_STEPS:
            return None
        fusion_rel = self._latest_dbs_fusion_file(active_slug)
        if not fusion_rel:
            return None
        try:
            fusion = self.rt.read("dbs-fusion", file=fusion_rel)
            validation = self.rt.validate("dbs-fusion", fusion["path"])
        except Exception as exc:
            return {
                "status": "review_required",
                "fusion_file": fusion_rel,
                "pending_count": 0,
                "message": f"DBS 融合报告读取或校验失败：{exc}",
            }
        if not validation.get("valid"):
            return {
                "status": "blocked",
                "fusion_file": self._rel_to_project(fusion["path"]),
                "slug": self.rt.normalize_slug(active_slug or fusion.get("frontmatter", {}).get("slug") or "current"),
                "pending_count": 0,
                "row_count": len(parse_writeback_rows(fusion.get("body", ""))),
                "message": "DBS 融合报告未通过校验，请先修复融合报告，不要绕过外部诊断进入下游生产。",
                "validation": {
                    "valid": validation.get("valid"),
                    "quality_status": validation.get("quality_status"),
                    "quality_errors": validation.get("quality_errors"),
                    "quality_reviews": validation.get("quality_reviews"),
                },
            }

        report = self._latest_apply_report(fusion["path"])
        if self._apply_report_finished(report):
            return None

        safe_slug = self.rt.normalize_slug(active_slug or fusion.get("frontmatter", {}).get("slug") or "current")
        pending_rows = []
        for row in parse_writeback_rows(fusion.get("body", "")):
            target_path = extract_target_path(row.get("target", ""))
            if target_path.startswith("pipeline/") and self._pipeline_target_has_apply_marker(target_path, self._rel_to_project(fusion["path"]), safe_slug):
                continue
            target_step = pipeline_step_for_path(target_path) if target_path.startswith("pipeline/") else ""
            target_exists = bool(target_path and (self.rt.project / target_path).exists())
            if target_step and not target_exists and not self.state.get("latest_by_slug", {}).get(safe_slug, {}).get(target_step):
                continue
            pending_rows.append({
                "target": row.get("target", ""),
                "target_path": target_path,
                "step": target_step,
                "target_type": target_path.split("/", 1)[0] if "/" in target_path else "",
                "downstream": row.get("downstream", ""),
                "state": row.get("state", ""),
            })
        if not pending_rows:
            return None

        target_steps = sorted({row["step"] for row in pending_rows if row.get("step")})
        command = f"{DBS_FUSION_APPLY_CLI} --project {self.rt.project} --file {self._rel_to_project(fusion['path'])}"
        return {
            "status": "pending",
            "fusion_file": self._rel_to_project(fusion["path"]),
            "slug": safe_slug,
            "next_step": next_step,
            "pending_count": len(pending_rows),
            "row_count": len(parse_writeback_rows(fusion.get("body", ""))),
            "target_steps": target_steps,
            "rows": pending_rows,
            "command": command,
            "make_command": f"make -C {SKILL_DIR} dbs-fusion-apply PROJECT={self.rt.project} FILE={self._rel_to_project(fusion['path'])}",
            "aifios_command": f"python3 {REPO_ROOT / 'scripts' / 'aifios.py'} --project {self.rt.project} dbs-fusion-apply --file {self._rel_to_project(fusion['path'])}",
            "validation": {
                "valid": validation.get("valid"),
                "quality_status": validation.get("quality_status"),
                "quality_reviews": validation.get("quality_reviews"),
            },
        }

    @staticmethod
    def _dbs_fusion_apply_markdown(pending: dict[str, Any] | None) -> str:
        if not pending:
            return ""
        if pending.get("status") == "blocked":
            errors = pending.get("validation", {}).get("quality_errors") or []
            error_lines = "\n".join(f"- {item}" for item in errors[:5])
            return f"""
## DBS 融合报告阻断
- 状态：融合报告未通过校验，不能进入 `{pending.get('next_step') or '下游步骤'}`。
- 融合报告：`{pending.get('fusion_file')}`
- 处理原则：先修复 `dbs-fusion` 报告，再执行 `dbs-fusion-apply`；不能用报告里的“已写回”状态自证完成。

### 阻断原因
{error_lines or '- 请查看 runtime validate 返回的 quality_errors。'}
"""
        if pending.get("status") != "pending":
            return ""
        rows = pending.get("rows") or []
        row_lines = "\n".join(
            f"- `{row.get('target_path') or row.get('target')}` -> {row.get('downstream') or '下游未标注'}"
            for row in rows[:5]
        )
        if len(rows) > 5:
            row_lines += f"\n- 另有 {len(rows) - 5} 项待写回。"
        return f"""
## DBS 融合写回提醒
- 状态：待写回，先把外部 dbskill 诊断落到 OS 资产，再进入 `{pending.get('next_step')}`。
- 融合报告：`{pending.get('fusion_file')}`
- 待写回：{pending.get('pending_count')} 项{f"（目标步骤：{', '.join(pending.get('target_steps') or [])}）" if pending.get('target_steps') else ""}

### 写回目标
{row_lines or '- 待人工确认写回目标。'}

### 建议先执行
```bash
{pending.get('make_command') or pending.get('command')}
```
"""

    def _dbs_fusion_apply_task_card(
        self,
        active_slug: str,
        step: str,
        skill: dict[str, str],
        upstream: str,
        upstream_summary: str,
        pending: dict[str, Any],
        flow: bool = False,
    ) -> str:
        blocked = pending.get("status") == "blocked"
        title_suffix = "DBS 融合报告需修复" if blocked else "DBS 融合结果待写回"
        title = f"content-flow · {title_suffix}" if flow else f"AI Founder Influence OS · {title_suffix}"
        first_action = "修复 dbs-fusion 报告" if blocked else "dbs-fusion-apply"
        guidance = self._dbs_fusion_apply_markdown(pending)
        next_action = (
            "1. 先修复 `dbs-fusion` 融合报告，使它通过 runtime validate。\n"
            "2. 再执行 `dbs-fusion-apply`，把外部诊断写回 pipeline/brain/session。\n"
            "3. 写回后重新运行："
            if blocked else
            "1. 先执行上面的 `dbs-fusion-apply`，把外部诊断写回 pipeline/brain/session。\n"
            "2. 写回后重新运行:"
        )
        final_note = (
            f"4. 如果 apply 报告为 `blocked`，先修复 `dbs-fusion` 写回计划，不要绕过诊断进入 `{step}`。"
            if blocked else
            f"3. 如果 apply 报告为 `blocked`，先修复 `dbs-fusion` 写回计划，不要绕过诊断进入 `{step}`。"
        )
        return f"""# {title}

## 当前状态
- 当前 slug：`{active_slug}`
- 原推荐步骤：`{step}`
- 原对应 Skill：`{skill.get('skill')}`
- 先执行动作：`{first_action}`

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}
{guidance}
## 你需要做的事
{next_action}
   ```bash
   make -C {SKILL_DIR} next PROJECT={self.rt.project} SLUG={active_slug}
   ```
{final_note}
"""

    def _validate_decision(self) -> str | None:
        """读取立项结论。任何明确结论都可进入创作蓝图。"""
        rel = self._latest_file("validate")
        if not rel:
            return None
        try:
            data = self.rt.read("validate", file=rel)
        except Exception:
            return None
        body = data.get("body", "")
        match = re.search(r"(?m)^\s*(?:[-*]\s*)?(?:\*\*)?决策(?:\*\*)?\s*[：:]\s*([^。\n\r]*)", body)
        return match.group(1).strip() if match else None

    def _validate_decision_passed(self) -> bool:
        return self._validate_decision() in {"通过", "有条件通过", "不通过"}

    def _is_blocked_by_validate(self, step: str) -> bool:
        if self._author_mode():
            return False
        if step in {"intake", "validate"}:
            return False
        if not self._is_done("validate"):
            return False
        return not self._validate_decision_passed()

    def _collect_upstream(self, step: str) -> tuple[str, str]:
        """返回（上游步骤名，上游摘要）。"""
        upstreams = self._effective_upstreams(step)
        for upstream in upstreams:
            if self._is_done(upstream):
                return upstream, self._read_step_body(upstream)
        # 如果没有直接上游，尝试找最近完成的步骤
        recent = self.rt.list_recent(days=30)
        if recent:
            u = recent[0]
            return u["step"], self._read_step_body(u["step"])
        return "", ""

    def _blueprint_audit(self) -> dict[str, Any] | None:
        rel = self._latest_file("blueprint")
        if not rel:
            return {
                "status": "blocked",
                "source_file": "",
                "blocking_issues": ["缺少 blueprint 文件，无法进入已选平台原生内容生产。"],
                "review_issues": [],
                "checks": {},
            }
        try:
            validation = self.rt.validate("blueprint", rel)
        except Exception as exc:
            return {
                "status": "blocked",
                "source_file": rel,
                "blocking_issues": [f"读取或校验 blueprint 失败：{exc}"],
                "review_issues": [],
                "checks": {},
            }
        checks = dict(validation.get("quality_checks") or {})
        try:
            scope_slug = self._scope_slug()
            run = self.rt.run_state(slug=scope_slug) if scope_slug else self.rt.run_state()
        except Exception:
            run = {}
        approval = self.rt.blueprint_approval_status(rel, run_id=run.get("run_id"))
        confirmed = approval.get("approved") is True
        checks["human_approved"] = confirmed
        checks["approval_reason"] = approval.get("reason", "")
        blocking_issues = list(validation.get("quality_errors") or validation.get("missing_patterns") or [])
        if not confirmed:
            blocking_issues.append(f"负责人尚未确认当前蓝图：{approval.get('reason') or '必须在界面确认后才能进入 wechat-writer。'}")
        return {
            "status": "pass" if validation.get("valid") and confirmed else "blocked",
            "source_file": rel,
            "blocking_issues": blocking_issues,
            "review_issues": validation.get("quality_reviews") or [],
            "checks": checks,
        }

    def _blocked_blueprint_task_card(
        self,
        active_slug: str,
        upstream: str,
        upstream_summary: str,
        audit: dict[str, Any],
        original_step: str = "write",
        flow: bool = False,
    ) -> str:
        issues = audit.get("blocking_issues") or []
        issue_lines = "\n".join(f"- {item}" for item in issues) or "- blueprint 需要人工确认后才能进入 wechat-writer。"
        title = "content-flow · 母版蓝图需要确认" if flow else "AI Founder Influence OS · 母版蓝图需要确认"
        return f"""# {title}

## 当前状态
- 当前 slug：`{active_slug}`
- 原推荐步骤：`{original_step}`
- 改为确认步骤：`blueprint`
- 检查对象：`{audit.get('source_file') or '无'}`

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}

## 阻断原因
{issue_lines}

## 你需要做的事
1. 打开最新 `pipeline/blueprint/` 文件。
2. 在 `## 10. 人工确认清单` 中确认核心判断、证据、风险边界和是否进入写作。
3. 在内容生产界面点击“确认蓝图并继续”，让系统把确认绑定到当前文件版本。
4. 重新运行：
   ```bash
   make -C {SKILL_DIR} next PROJECT={self.rt.project} SLUG={active_slug}
   ```
"""

    def _blocked_blueprint_next_result(
        self,
        active_slug: str,
        step: str,
        upstream: str,
        upstream_summary: str,
        audit: dict[str, Any],
    ) -> dict[str, Any]:
        blueprint_skill = STEP_SKILLS["blueprint"]
        task_card = self._blocked_blueprint_task_card(active_slug, upstream, upstream_summary, audit, original_step=step)
        task_path = self.rt.sessions / "next-task.md"
        task_path.write_text(task_card, encoding="utf-8")
        return {
            "status": "blocked",
            "reason": "blueprint 未通过人工确认或质量门",
            "project": str(self.rt.project),
            "active_slug": active_slug,
            "target_platforms": self.target_platforms,
            "target_platform_labels": self._target_platform_labels(),
            "next_steps": [{"step": "blueprint", "label": blueprint_skill["output"]}],
            "recommended_step": "blueprint",
            "skill": blueprint_skill["skill"],
            "upstream": upstream,
            "blueprint_audit": audit,
            "task_card": str(task_path),
        }

    def _blocked_blueprint_flow_result(
        self,
        active_slug: str,
        step: str,
        upstream: str,
        upstream_summary: str,
        audit: dict[str, Any],
    ) -> dict[str, Any]:
        blueprint_skill = STEP_SKILLS["blueprint"]
        task_card = self._blocked_blueprint_task_card(active_slug, upstream, upstream_summary, audit, original_step=step, flow=True)
        task_path = self.rt.sessions / "flow-task.md"
        task_path.write_text(task_card, encoding="utf-8")
        return {
            "status": "flow_blocked",
            "reason": "blueprint 未通过人工确认或质量门",
            "project": str(self.rt.project),
            "slug": active_slug,
            "current_step": "blueprint",
            "done_steps": ["intake", "validate"],
            "remaining_steps": ["blueprint", step],
            "skill": blueprint_skill["skill"],
            "upstream": upstream,
            "blueprint_audit": audit,
            "task_card": str(task_path),
        }

    def _blueprint_gate_audit(self, step: str) -> dict[str, Any] | None:
        if step not in BLUEPRINT_GATED_STEPS:
            return None
        audit = self._blueprint_audit()
        if audit and audit.get("status") != "pass":
            return audit
        return None

    def _package_audit(self) -> dict[str, Any] | None:
        rel = self._latest_file("package")
        if not rel:
            return {
                "status": "blocked",
                "source_file": "",
                "blocking_issues": ["缺少 package 文件，无法进入视觉与发布检查。"],
                "review_issues": [],
                "checks": {},
            }
        try:
            validation = self.rt.validate("package", rel)
        except Exception as exc:
            return {
                "status": "blocked",
                "source_file": rel,
                "blocking_issues": [f"读取或校验 package 失败：{exc}"],
                "review_issues": [],
                "checks": {},
            }
        return {
            "status": "pass" if validation.get("valid") else "blocked",
            "source_file": rel,
            "blocking_issues": validation.get("quality_errors") or validation.get("missing_patterns") or [],
            "review_issues": validation.get("quality_reviews") or [],
            "checks": validation.get("quality_checks") or {},
        }

    def _blocked_package_task_card(
        self,
        active_slug: str,
        upstream: str,
        upstream_summary: str,
        audit: dict[str, Any],
        original_step: str = "visual",
    ) -> str:
        issues = audit.get("blocking_issues") or []
        issue_lines = "\n".join(f"- {item}" for item in issues) or "- package 需要补齐本期已选平台各自的原生成稿后才能进入下一步。"
        return f"""# AI Founder Influence OS · 最终内容需要修复

## 当前状态
- 当前 slug：`{active_slug}`
- 原推荐步骤：`{original_step}`
- 改为修复步骤：`package`
- 检查对象：`{audit.get('source_file') or '无'}`

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}

## 阻断原因
{issue_lines}

## 你需要做的事
1. 回到 `content-package`，只补齐当前已选平台：公众号完整长文、小红书 P1-P8 图文或视频号口播执行稿。
2. 确认每个平台都使用本期已核对的写作依据与独立结构，并检查标题、表达、结尾和风险边界；作者素材模式不要求平台研究。
3. 重新运行：
   ```bash
   make -C {SKILL_DIR} next PROJECT={self.rt.project} SLUG={active_slug}
   ```
"""

    def _blocked_package_next_result(
        self,
        active_slug: str,
        step: str,
        upstream: str,
        upstream_summary: str,
        audit: dict[str, Any],
    ) -> dict[str, Any]:
        package_skill = STEP_SKILLS["package"]
        task_card = self._blocked_package_task_card(active_slug, upstream, upstream_summary, audit, original_step=step)
        task_path = self.rt.sessions / "next-task.md"
        task_path.write_text(task_card, encoding="utf-8")
        return {
            "status": "blocked",
            "reason": "package 未通过质量门",
            "project": str(self.rt.project),
            "active_slug": active_slug,
            "target_platforms": self.target_platforms,
            "target_platform_labels": self._target_platform_labels(),
            "next_steps": [{"step": "package", "label": package_skill["output"]}],
            "recommended_step": "package",
            "skill": package_skill["skill"],
            "upstream": upstream,
            "package_audit": audit,
            "task_card": str(task_path),
        }

    def _blocked_package_flow_result(
        self,
        active_slug: str,
        step: str,
        upstream: str,
        upstream_summary: str,
        audit: dict[str, Any],
    ) -> dict[str, Any]:
        package_skill = STEP_SKILLS["package"]
        task_card = self._blocked_package_task_card(active_slug, upstream, upstream_summary, audit, original_step=step)
        task_path = self.rt.sessions / "flow-task.md"
        task_path.write_text(task_card, encoding="utf-8")
        return {
            "status": "flow_blocked",
            "reason": "package 未通过质量门",
            "project": str(self.rt.project),
            "slug": active_slug,
            "current_step": "package",
            "skill": package_skill["skill"],
            "upstream": upstream,
            "package_audit": audit,
            "task_card": str(task_path),
        }

    def _package_gate_audit(self, step: str) -> dict[str, Any] | None:
        if step not in PACKAGE_GATED_STEPS:
            return None
        audit = self._package_audit()
        if audit and audit.get("status") != "pass":
            return audit
        return None

    def _style_recommendation_path(self, slug: str) -> Path:
        safe_slug = self.rt.normalize_slug(slug or "current")
        return self.rt.sessions / "style-recommendations" / f"{safe_slug}.json"

    def _write_style_recommendation(
        self,
        slug: str,
        source_file: str,
        style_result: dict[str, Any],
    ) -> str:
        path = self._style_recommendation_path(slug)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "slug": self.rt.normalize_slug(slug or "current"),
            "source_step": "blueprint" if "blueprint" in source_file else "breakdown",
            "source_file": source_file,
            "generated_at": datetime.now().isoformat(),
            "recommendation": style_result,
        }
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
        return str(path)

    def _recommend_wechat_style(self, active_slug: str) -> dict[str, Any] | None:
        """为公众号写作任务卡生成风格推荐。失败时不阻断流水线。"""
        rel = self._latest_file("blueprint") or self._latest_file("breakdown")
        if not rel or not STYLE_RECOMMENDER.exists():
            return None
        try:
            spec = importlib.util.spec_from_file_location("aifios_wechat_style_recommender", STYLE_RECOMMENDER)
            if not spec or not spec.loader:
                return {"error": "无法加载 style_recommender.py"}
            module = importlib.util.module_from_spec(spec)
            sys.modules[spec.name] = module
            spec.loader.exec_module(module)
            source_step = "blueprint" if "/blueprint/" in rel or rel.startswith("pipeline/blueprint/") else "breakdown"
            data = self.rt.read(source_step, file=rel)
            result = module.recommend_style(data.get("body", ""))
        except Exception as exc:
            result = {"error": str(exc)}
        result["recommendation_file"] = self._write_style_recommendation(active_slug, rel, result)
        return result

    @staticmethod
    def _section_text(body: str, heading_pattern: str) -> str:
        match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
        return match.group(1).strip() if match else ""

    @staticmethod
    def _line_value(section: str, label_pattern: str) -> str:
        match = re.search(rf"(?m)^\s*[-*]\s*(?:{label_pattern})\s*[：:]\s*(.+?)\s*$", section or "")
        return match.group(1).strip() if match else ""

    @staticmethod
    def _meaningful_value(value: str) -> bool:
        if not value:
            return False
        if re.search(r"无|待补|缺失|暂无|未提供|不详|TODO|xxx|\.\.\.", value, re.IGNORECASE):
            return False
        return len(re.sub(r"\s+", "", value)) >= 4

    @staticmethod
    def _count_markdown_items(section: str) -> int:
        return len(re.findall(r"(?m)^\s*(?:[-*]|\d+[.)]|[一二三四五六七八九十]+[、.])\s+", section or ""))

    def _intake_audit(self) -> dict[str, Any] | None:
        rel = self._latest_file("intake")
        if not rel:
            return {
                "status": "blocked",
                "source_file": "",
                "blocking_issues": ["缺少 intake 文件，无法进入立项。"],
                "review_issues": [],
                "checks": {},
            }
        try:
            data = self.rt.read("intake", file=rel)
            body = data.get("body", "")
        except Exception as exc:
            return {
                "status": "blocked",
                "source_file": rel,
                "blocking_issues": [f"读取 intake 失败：{exc}"],
                "review_issues": [],
                "checks": {},
            }
        result = audit_intake(body)
        result["source_file"] = rel
        return result

    @staticmethod
    def _intake_audit_markdown(audit: dict[str, Any] | None) -> str:
        if not audit:
            return ""
        blocking = audit.get("blocking_issues") or []
        review = audit.get("review_issues") or []
        if not blocking and not review:
            return ""
        status_label = {
            "pass": "通过",
            "review_required": "可进入立项，但需复核",
            "blocked": "阻断",
        }.get(audit.get("status"), audit.get("status"))
        lines = [
            "",
            "## 素材理解质量审计",
            f"- 状态：{status_label}",
            f"- 检查对象：`{audit.get('source_file') or '无'}`",
        ]
        if blocking:
            lines.append("\n### 阻断问题")
            lines.extend(f"- {issue}" for issue in blocking)
        if review:
            lines.append("\n### 复核提醒")
            lines.extend(f"- {issue}" for issue in review)
        return "\n".join(lines) + "\n"

    def _market_signal_report_path(self, active_slug: str) -> Path:
        safe_slug = self.rt.normalize_slug(active_slug or "market-signal")
        return self.rt.materials / "research" / f"{safe_slug}-market-signal.md"

    @staticmethod
    def _market_signal_gate_from_markdown(
        path: Path,
        body: str,
        *,
        project: Path,
        expected_run_id: str,
    ) -> dict[str, Any]:
        sample_match = re.search(r"(?m)^-\s*样本数量\s*[：:]\s*(\d+)", body or "")
        signal_match = re.search(r"(?m)^-\s*实时信号状态\s*[：:]\s*(.+?)\s*$", body or "")
        gate_match = re.search(r"(?m)^-\s*TikOmni\s*门禁\s*[：:]\s*(.+?)\s*$", body or "")
        run_match = re.search(r"(?m)^-\s*runtime\s+run\s*[：:]\s*(.+?)\s*$", body or "")
        snapshot_match = re.search(r"(?m)^-\s*研究快照\s*[：:]\s*(.+?)\s*$", body or "")
        snapshot_sha_match = re.search(r"(?m)^-\s*快照\s*SHA-?256\s*[：:]\s*([a-f0-9]{64})\s*$", body or "", re.IGNORECASE)
        sample_count = int(sample_match.group(1)) if sample_match else 0
        signal_status = signal_match.group(1).strip() if signal_match else "unknown"
        gate_status = gate_match.group(1).strip() if gate_match else "未知"
        creator_mode_match = re.search(r"(?m)^-\s*创作模式\s*[：:]\s*(是|true|yes)\s*$", body or "", re.IGNORECASE)
        creator_mode = bool(creator_mode_match) or "创作模式" in gate_status or signal_status == "creator_mode"
        report_run_id = run_match.group(1).strip() if run_match else ""
        snapshot_path = snapshot_match.group(1).strip().strip("`") if snapshot_match else ""
        snapshot_sha256 = snapshot_sha_match.group(1).lower() if snapshot_sha_match else ""
        base = {
            "path": str(path),
            "sample_count": sample_count,
            "signal_status": signal_status,
            "gate_status": gate_status,
            "report_run_id": report_run_id,
            "snapshot_path": snapshot_path,
            "snapshot_sha256": snapshot_sha256,
            "creator_mode": creator_mode,
        }
        if report_run_id != expected_run_id:
            return {
                **base,
                "status": "blocked",
                "message": "TikOmni 报告不属于当前 runtime run，必须重新执行本期已选平台研究。",
            }
        if creator_mode:
            return {
                **base,
                "status": "blocked",
                "message": "TikOmni 已选平台样本不足；工作流不允许用创作模式绕过研究门禁。",
            }
        gate_is_usable = gate_status == "通过"
        signal_is_usable = signal_status == "ready"
        if not gate_is_usable or not signal_is_usable:
            return {
                **base,
                "status": "blocked",
                "message": "TikOmni 研究状态无法确认，不能绑定本期研究快照。",
            }
        if not snapshot_path or snapshot_path in {"未生成", "不可用"} or not snapshot_sha256:
            return {
                **base,
                "status": "blocked",
                "message": "TikOmni 报告缺少可验证的本期研究快照，不能进入选题与模板确认。",
            }
        verification = verify_market_snapshot(project, expected_run_id, snapshot_path)
        if not verification.get("verified"):
            return {
                **base,
                "status": "blocked",
                "message": f"TikOmni 研究快照未通过校验：{verification.get('reason') or '完整性校验失败'}。",
            }
        if verification.get("snapshot_sha256") != snapshot_sha256:
            return {
                **base,
                "status": "blocked",
                "message": "TikOmni 研究快照摘要不一致，不能进入选题与模板确认。",
            }
        return {
            **base,
            "status": "ready",
            "warning": False,
            "message": "TikOmni 已选平台研究与快照已通过校验。",
        }

    def _market_signal_gate(self, active_slug: str) -> dict[str, Any]:
        """Create a fail-closed, run-bound TikOmni gate before validation."""
        intake_rel = self._latest_file("intake")
        if not intake_rel:
            return {
                "status": "blocked",
                "path": "",
                "sample_count": 0,
                "signal_status": "missing_intake",
                "message": "缺少 intake，无法执行公开样本与对标质量门。",
            }

        try:
            run = self.rt.run_state(slug=active_slug)
            run_id = str(run.get("run_id") or "").strip()
        except (FileNotFoundError, ValueError):
            run_id = ""
        if not run_id:
            return {
                "status": "blocked",
                "path": "",
                "sample_count": 0,
                "signal_status": "missing_run",
                "message": "缺少当前 runtime run，不能执行 TikOmni 已选平台研究。",
            }

        path = self._market_signal_report_path(active_slug)
        try:
            if path.is_file():
                existing = path.read_text(encoding="utf-8")
                source_match = re.search(r"(?m)^-\s*上游素材\s*[：:]\s*(.+?)\s*$", existing)
                if source_match and source_match.group(1).strip() == intake_rel:
                    result = self._market_signal_gate_from_markdown(
                        path,
                        existing,
                        project=self.rt.project,
                        expected_run_id=run_id,
                    )
                    result["path"] = self._rel_to_project(path)
                    if result.get("status") == "ready":
                        return result
        except OSError:
            # Rebuild a corrupted or unreadable report from the current intake.
            pass

        intake: dict[str, Any] = {}
        try:
            intake = self.rt.read("intake", file=intake_rel)
            topic = str(run.get("topic") or active_slug)
            report = build_market_signal_report(
                topic=topic,
                source_path=intake_rel,
                material_text=str(intake.get("body") or ""),
                platforms=self.target_platforms or list(SUPPORTED_PLATFORMS),
                project=self.rt.project,
                run_id=run_id,
            )
            markdown = str(report.get("markdown") or "").strip()
            if not markdown:
                raise RuntimeError("公开样本报告为空")
        except Exception as exc:
            return {
                "status": "blocked",
                "path": "",
                "sample_count": 0,
                "signal_status": "research_error",
                "message": f"TikOmni 已选平台研究失败：{exc}",
            }
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(".md.tmp")
        temporary.write_text(markdown + "\n", encoding="utf-8")
        temporary.replace(path)
        result = self._market_signal_gate_from_markdown(
            path,
            markdown,
            project=self.rt.project,
            expected_run_id=run_id,
        )
        result["path"] = self._rel_to_project(path)
        return result

    @staticmethod
    def _market_signal_gate_markdown(gate: dict[str, Any] | None) -> str:
        if not gate:
            return ""
        status = gate.get("status")
        if status == "ready":
            return "\n".join([
                "",
                "## 爆款抓取与公开对标质量门",
                "- 状态：已选平台公开样本查询已完成。",
                f"- 报告：`{gate.get('path')}`",
                f"- 可验证公开样本：{gate.get('sample_count', 0)} 条。",
                "- 公开样本状态：已完成。",
                "- 立项写回契约：在 `## 0. 素材来源` 原样写入 `公开样本对标报告`、`公开样本状态`、`可验证样本数`。",
                "- 立项用法：只吸收标题入口、结构、互动机制和公开可验证事实；不得复制第三方表达或把其指标当作自身结果。",
                "",
            ])
        if status != "ready":
            return "\n".join([
                "",
                "## 爆款抓取与公开对标质量门",
                f"- 状态：阻断。{gate.get('message') or '研究快照尚未生成。'}",
                "- 任一必需平台不可用时暂停，修复后重新执行研究。",
                "",
            ])

    def _blocked_market_signal_task_card(
        self,
        active_slug: str,
        upstream: str,
        upstream_summary: str,
        gate: dict[str, Any],
        flow: bool = False,
    ) -> str:
        title = "content-flow · 研究快照需要修复" if flow else "AI Founder Influence OS · 研究快照需要修复"
        return f"""# {title}

## 当前状态
- 当前 slug：`{active_slug}`
- 原推荐步骤：`validate`
- 当前质量门：`market-signal`
- 状态：阻断（已选平台研究或快照完整性未通过）
- 原因：{gate.get('message') or '当前研究快照无法绑定。'}

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}

## 你需要做的事
1. 确认当前 run 与最新 intake 路径一致，并重新生成研究快照。
2. 确认本期仍选择的平台均有可核验样本；失败平台可重试或取消，不能用其他平台样本替代。
3. 修复后重新运行：
   ```bash
   make -C {SKILL_DIR} next PROJECT={self.rt.project} SLUG={active_slug}
   ```
"""

    def _blocked_intake_task_card(
        self,
        active_slug: str,
        upstream: str,
        upstream_summary: str,
        audit: dict[str, Any],
        flow: bool = False,
    ) -> str:
        guidance = self._intake_audit_markdown(audit)
        source_file = audit.get("source_file") or self._latest_file("intake") or "无"
        title = "content-flow · 素材理解质量审计未通过" if flow else "AI Founder Influence OS · 素材理解质量审计未通过"
        return f"""# {title}

## 当前状态
- 当前 slug：`{active_slug}`
- 原推荐步骤：`validate`
- 改为修复步骤：`intake`
- 检查对象：`{source_file}`

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}
{guidance}
## 你需要做的事
1. 回到 `content-intake`，把原始素材整理成可追溯事实资产包。
2. 至少补齐：主场景、素材来源、事实边界、观点证据位置、不可公开信息和下游可用性。
3. 如果缺少核心案例或可信等级，不要退回原始素材；在 `案例` 与 `素材质量判断` 中标为“缺口/待核验/需要补素材”。
4. 不确定的信息标记为“推断/待核验”，不要写成事实。
5. 补齐后重新运行：
   ```bash
   make -C {SKILL_DIR} next PROJECT={self.rt.project}
   ```

## 写回命令
```bash
{RUNTIME_CLI} --project {self.rt.project} write \\
  --step intake --slug {active_slug} \\
  --content @intake-fixed.md --source "intake-quality-gate"
```
"""

    def _validate_audit(self) -> dict[str, Any] | None:
        rel = self._latest_file("validate")
        if not rel:
            return {
                "status": "blocked",
                "source_file": "",
                "blocking_issues": ["缺少 validate 文件，无法进入母版蓝图。"],
                "review_issues": [],
                "checks": {},
            }
        try:
            data = self.rt.read("validate", file=rel)
            body = data.get("body", "")
        except Exception as exc:
            return {
                "status": "blocked",
                "source_file": rel,
                "blocking_issues": [f"读取 validate 失败：{exc}"],
                "review_issues": [],
                "checks": {},
            }
        result = audit_validate(body)
        result["source_file"] = rel
        return result

    @staticmethod
    def _validate_audit_markdown(audit: dict[str, Any] | None) -> str:
        if not audit:
            return ""
        blocking = audit.get("blocking_issues") or []
        review = audit.get("review_issues") or []
        if not blocking and not review:
            return ""
        status_label = {
            "pass": "通过",
            "review_required": "可进入母版蓝图，但需复核",
            "blocked": "阻断",
        }.get(audit.get("status"), audit.get("status"))
        lines = [
            "",
            "## 立项质量审计",
            f"- 状态：{status_label}",
            f"- 检查对象：`{audit.get('source_file') or '无'}`",
        ]
        if blocking:
            lines.append("\n### 阻断问题")
            lines.extend(f"- {issue}" for issue in blocking)
        if review:
            lines.append("\n### 复核提醒")
            lines.extend(f"- {issue}" for issue in review)
        return "\n".join(lines) + "\n"

    def _blocked_validate_task_card(
        self,
        active_slug: str,
        upstream: str,
        upstream_summary: str,
        audit: dict[str, Any],
        flow: bool = False,
    ) -> str:
        guidance = self._validate_audit_markdown(audit)
        source_file = audit.get("source_file") or self._latest_file("validate") or "无"
        title = "content-flow · 立项质量审计未通过" if flow else "AI Founder Influence OS · 立项质量审计未通过"
        return f"""# {title}

## 当前状态
- 当前 slug：`{active_slug}`
- 原推荐步骤：`blueprint`
- 改为修复步骤：`validate`
- 检查对象：`{source_file}`

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}
{guidance}
## 你需要做的事
1. 回到 `content-validate`，修正立项报告的结构和事实边界。
2. 至少补齐：明确决策、HKR 评分、商业成立性、平台首发理由、公开样本对标报告路径/状态/样本数、风险提示和下一步动作。
3. “有条件通过”或“不通过”仍可进入低证据创作蓝图；缺少的素材必须保留为边界，不能改写成事实或效果承诺。
4. 补齐后重新运行：
   ```bash
   make -C {SKILL_DIR} next PROJECT={self.rt.project}
   ```

## 写回命令
```bash
{RUNTIME_CLI} --project {self.rt.project} write \\
  --step validate --slug {active_slug} \\
  --content @validate-fixed.md --source "validate-quality-gate"
```
"""

    def _angle_audit(self) -> dict[str, Any] | None:
        rel = self._latest_file("angle")
        if not rel:
            return {
                "status": "blocked",
                "source_file": "",
                "blocking_issues": ["缺少 angle 文件，无法进入内容拆解。"],
                "review_issues": [],
                "checks": {},
            }
        try:
            data = self.rt.read("angle", file=rel)
            body = data.get("body", "")
        except Exception as exc:
            return {
                "status": "blocked",
                "source_file": rel,
                "blocking_issues": [f"读取 angle 失败：{exc}"],
                "review_issues": [],
                "checks": {},
            }
        result = audit_angle(body)
        result["source_file"] = rel
        return result

    @staticmethod
    def _angle_audit_markdown(audit: dict[str, Any] | None) -> str:
        if not audit:
            return ""
        blocking = audit.get("blocking_issues") or []
        review = audit.get("review_issues") or []
        if not blocking and not review:
            return ""
        status_label = {
            "pass": "通过",
            "review_required": "可进入拆解，但需复核",
            "blocked": "阻断",
        }.get(audit.get("status"), audit.get("status"))
        lines = [
            "",
            "## 角度质量审计",
            f"- 状态：{status_label}",
            f"- 检查对象：`{audit.get('source_file') or '无'}`",
        ]
        if blocking:
            lines.append("\n### 阻断问题")
            lines.extend(f"- {issue}" for issue in blocking)
        if review:
            lines.append("\n### 复核提醒")
            lines.extend(f"- {issue}" for issue in review)
        return "\n".join(lines) + "\n"

    def _blocked_angle_task_card(
        self,
        active_slug: str,
        upstream: str,
        upstream_summary: str,
        audit: dict[str, Any],
        flow: bool = False,
    ) -> str:
        guidance = self._angle_audit_markdown(audit)
        source_file = audit.get("source_file") or self._latest_file("angle") or "无"
        title = "content-flow · 角度质量审计未通过" if flow else "AI Founder Influence OS · 角度质量审计未通过"
        return f"""# {title}

## 当前状态
- 当前 slug：`{active_slug}`
- 原推荐步骤：`breakdown`
- 改为修复步骤：`angle`
- 检查对象：`{source_file}`

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}
{guidance}
## 你需要做的事
1. 回到 `content-angle`，把角度补成可进入拆解的方案。
2. 每个角度至少补齐：一句话定位、目标用户、素材证据、商业承接、适合平台、风险点。
3. `建议` 必须明确首选角度和进入 `content-breakdown` 的约束。
4. 补齐后重新运行：
   ```bash
   make -C {SKILL_DIR} next PROJECT={self.rt.project}
   ```

## 写回命令
```bash
{RUNTIME_CLI} --project {self.rt.project} write \\
  --step angle --slug {active_slug} \\
  --content @angle-fixed.md --source "angle-quality-gate"
```
"""

    def _breakdown_audit(self) -> dict[str, Any] | None:
        rel = self._latest_file("breakdown")
        if not rel:
            return {
                "status": "blocked",
                "source_file": "",
                "blocking_issues": ["缺少 breakdown 文件，无法进入下游内容生产。"],
                "review_issues": [],
                "checks": {},
            }
        try:
            data = self.rt.read("breakdown", file=rel)
            body = data.get("body", "")
        except Exception as exc:
            return {
                "status": "blocked",
                "source_file": rel,
                "blocking_issues": [f"读取 breakdown 失败：{exc}"],
                "review_issues": [],
                "checks": {},
            }
        result = audit_breakdown(body, self.target_platforms)
        result["source_file"] = rel
        return result

    @staticmethod
    def _breakdown_audit_markdown(audit: dict[str, Any] | None) -> str:
        if not audit:
            return ""
        blocking = audit.get("blocking_issues") or []
        review = audit.get("review_issues") or []
        if not blocking and not review:
            return ""
        status_label = {
            "pass": "通过",
            "review_required": "可进入下游，但需复核",
            "blocked": "阻断",
        }.get(audit.get("status"), audit.get("status"))
        lines = [
            "",
            "## 内容拆解生产单审计",
            f"- 状态：{status_label}",
            f"- 检查对象：`{audit.get('source_file') or '无'}`",
        ]
        if blocking:
            lines.append("\n### 阻断问题")
            lines.extend(f"- {issue}" for issue in blocking)
        if review:
            lines.append("\n### 复核提醒")
            lines.extend(f"- {issue}" for issue in review)
        return "\n".join(lines) + "\n"

    def _blocked_breakdown_task_card(
        self,
        active_slug: str,
        original_step: str,
        upstream: str,
        upstream_summary: str,
        audit: dict[str, Any],
        flow: bool = False,
    ) -> str:
        guidance = self._breakdown_audit_markdown(audit)
        source_file = audit.get("source_file") or self._latest_file("breakdown") or "无"
        title = "content-flow · 内容拆解生产单未通过" if flow else "AI Founder Influence OS · 内容拆解生产单未通过"
        return f"""# {title}

## 当前状态
- 当前 slug：`{active_slug}`
- 原推荐步骤：`{original_step}`
- 改为修复步骤：`breakdown`
- 检查对象：`{source_file}`

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}
{guidance}
## 你需要做的事
1. 回到 `content-breakdown`，把拆解方案补成可执行生产单。
2. 至少补齐：选定角度、首发平台、具体素材证据、风险边界、目标阵地标题/钩子/适配建议和下一步命令。
3. 如果对标样本或素材补充项暂时缺失，可以继续保留，但必须在下游成稿自检中标记 `review`。
4. 补齐后重新运行：
   ```bash
   make -C {SKILL_DIR} next PROJECT={self.rt.project}
   ```

## 写回命令
```bash
{RUNTIME_CLI} --project {self.rt.project} write \\
  --step breakdown --slug {active_slug} \\
  --content @breakdown-fixed.md --source "breakdown-quality-gate"
```
"""

    def _wechat_preflight(self) -> dict[str, Any] | None:
        """Gate WeChat writing before handing the brief to wechat-writer."""
        rel = self._latest_file("breakdown")
        if not rel:
            return {
                "status": "blocked",
                "source_file": "",
                "blocking_issues": ["缺少 breakdown 文件，无法进入公众号长文写作。"],
                "review_issues": [],
            }
        try:
            data = self.rt.read("breakdown", file=rel)
            body = data.get("body", "")
        except Exception as exc:
            return {
                "status": "blocked",
                "source_file": rel,
                "blocking_issues": [f"读取 breakdown 失败：{exc}"],
                "review_issues": [],
            }

        blocking: list[str] = []
        review: list[str] = []
        breakdown_audit = audit_breakdown(body, ["wechat"])
        blocking.extend(breakdown_audit.get("blocking_issues", []))
        review.extend(breakdown_audit.get("review_issues", []))
        for pattern, message in WECHAT_PREFLIGHT_REQUIRED_SECTIONS.values():
            if not re.search(pattern, body or ""):
                blocking.append(message)

        upstream = self._section_text(body, r"^##\s*0\.\s+上游约束")
        required_evidence = self._line_value(upstream, r"(?:必须使用的)?素材证据|必用素材证据|必须使用的素材证据")
        risk_boundary = self._line_value(upstream, r"不可触碰的风险边界|风险边界")
        selected_angle = self._line_value(upstream, r"选定角度")
        first_platform = self._line_value(upstream, r"首发平台")
        if not self._meaningful_value(selected_angle):
            blocking.append("上游约束缺少明确 `选定角度`。")
        if first_platform and not re.search(r"公众号|wechat|微信", first_platform, re.IGNORECASE):
            blocking.append(f"首发平台为 `{first_platform}`，不应直接进入公众号长文写作。")
        if not self._meaningful_value(required_evidence):
            blocking.append("上游约束缺少可写入正文的必用素材证据。")
        if not self._meaningful_value(risk_boundary):
            blocking.append("上游约束缺少风险边界，不能判断哪些信息不可公开。")

        title_section = self._section_text(body, r"^##\s*标题方案")
        if self._count_markdown_items(title_section) < 1:
            blocking.append("标题方案没有可用公众号标题。")

        hook_section = self._section_text(body, r"^##\s*开场钩子库")
        if self._count_markdown_items(hook_section) < 2:
            review.append("开场钩子少于 2 个，写作前建议补足场景型/反常识型开头。")

        platform_section = self._section_text(body, r"^##\s*阵地适配建议")
        if not re.search(r"公众号|wechat|微信", platform_section, re.IGNORECASE):
            blocking.append("阵地适配建议没有说明公众号为什么适合承载这篇长文。")

        next_section = self._section_text(body, r"^##\s*下一步执行指令")
        if not re.search(r"/content-write|写公众号|wechat-writer|公众号", next_section, re.IGNORECASE):
            blocking.append("下一步执行指令没有确认进入 `/content-write`。")

        benchmark_section = self._section_text(body, r"^##\s*爆款档案参考")
        if not re.search(r"对标|爆款|样本|评论区|标题|封面|benchmark|hit-library", benchmark_section, re.IGNORECASE):
            review.append("爆款档案参考缺少可复用样本或机制，长文可写但应标记 review。")

        supplement_section = self._section_text(body, r"^##\s*素材补充清单")
        open_supplements = [
            line.strip()
            for line in supplement_section.splitlines()
            if re.match(r"\s*[-*]\s*\[\s*\]\s+", line)
        ]
        if open_supplements:
            review.append(f"素材补充清单仍有 {len(open_supplements)} 项未完成，成稿隐藏自检块应标记 review。")

        status = "blocked" if blocking else ("review_required" if review else "pass")
        return {
            "status": status,
            "source_file": rel,
            "blocking_issues": blocking,
            "review_issues": review,
            "checks": {
                "breakdown_quality": breakdown_audit.get("status"),
                "selected_angle": selected_angle,
                "first_platform": first_platform,
                "required_evidence": required_evidence,
                "risk_boundary": risk_boundary,
                "open_supplements": len(open_supplements),
            },
        }

    @staticmethod
    def _wechat_preflight_markdown(preflight: dict[str, Any] | None) -> str:
        if not preflight:
            return ""
        blocking = preflight.get("blocking_issues") or []
        review = preflight.get("review_issues") or []
        status_label = {
            "pass": "通过",
            "review_required": "可进入写作，但需复核",
            "blocked": "阻断",
        }.get(preflight.get("status"), preflight.get("status"))
        lines = [
            "",
            "## 公众号写前闸门",
            f"- 状态：{status_label}",
            f"- 检查对象：`{preflight.get('source_file') or '无'}`",
        ]
        if blocking:
            lines.append("\n### 阻断问题")
            lines.extend(f"- {issue}" for issue in blocking)
        if review:
            lines.append("\n### 复核提醒")
            lines.extend(f"- {issue}" for issue in review)
        return "\n".join(lines) + "\n"

    def _blocked_wechat_task_card(
        self,
        active_slug: str,
        upstream: str,
        upstream_summary: str,
        preflight: dict[str, Any],
        flow: bool = False,
    ) -> str:
        guidance = self._wechat_preflight_markdown(preflight)
        source_file = preflight.get("source_file") or self._latest_file("breakdown") or "无"
        title = "content-flow · 公众号写前闸门未通过" if flow else "AI Founder Influence OS · 公众号写前闸门未通过"
        return f"""# {title}

## 当前状态
- 当前 slug：`{active_slug}`
- 原推荐步骤：`write`
- 改为修复步骤：`breakdown`
- 检查对象：`{source_file}`

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}
{guidance}
## 你需要做的事
1. 先回到 `content-breakdown`，补齐阻断问题。
2. 至少补齐：必用素材证据、风险边界、公众号适配理由和 `/content-write` 执行指令。
3. 如果素材补充项仍未完成，允许继续写作，但成稿 `AIFIOS-WRITE-CHECK` 的 `质检结论` 必须写 `review`。
4. 补齐后重新运行：
   ```bash
   make -C {SKILL_DIR} next PROJECT={self.rt.project}
   ```

## 写回命令
```bash
{RUNTIME_CLI} --project {self.rt.project} write \\
  --step breakdown --slug {active_slug} \\
  --content @breakdown-fixed.md --source "wechat-preflight"
```
"""

    @staticmethod
    def _style_guidance_markdown(style_result: dict[str, Any] | None) -> str:
        if not style_result:
            return ""
        if style_result.get("error"):
            return (
                "\n## 公众号风格推荐\n"
                f"- 状态：生成失败，原因：{style_result['error']}\n"
                "- 处理：按 `wechat-writer/references/style-matrix.md` 手动完成风格决策。\n"
            )
        reasons = style_result.get("reasons") or []
        warnings = style_result.get("warnings") or []
        alternatives = style_result.get("alternatives") or []
        reason_lines = "\n".join(f"- {reason}" for reason in reasons) if reasons else "- 素材信号不足，写作前需要人工确认。"
        warning_lines = "\n".join(f"- {warning}" for warning in warnings) if warnings else "- 暂无阻断风险。"
        return f"""
## 公众号风格推荐
- 系统推荐：`{style_result.get('system_recommendation')}`（置信度：{style_result.get('confidence')}）
- 最终建议：`{style_result.get('final_style')}`
- 备选风格：{', '.join(f"`{item}`" for item in alternatives) if alternatives else '无'}
- 需要复核：{'是' if style_result.get('review_required') else '否'}

### 推荐依据
{reason_lines}

### 风险提醒
{warning_lines}

### 写作约束
- 写作任务卡必须记录 `推荐风格：{style_result.get('final_style')}`。
- 成稿末尾 `AIFIOS-WRITE-CHECK` 必须包含 `推荐风格 - 用户指定：无；系统推荐：{style_result.get('system_recommendation')}（置信度：{style_result.get('confidence')}）；最终采用：{style_result.get('final_style')}；理由：...`。
- 成稿末尾 `AIFIOS-WRITE-CHECK` 必须包含 `传播心理兑现 - 沉默解除：...；满足动机：...；有效立场：...；传播入口：...；信念结构：...；受众情绪底层：...；受众还想听什么：...`，并让这些心理机制进入可见正文。
"""

    def status(self) -> dict[str, Any]:
        """生成流水线状态报告。"""
        self.state = self.rt.state()
        self.target_platforms = self._load_target_platforms()
        author_source = self._author_source_status()
        rows = []
        for item in PIPELINE:
            if isinstance(item, str):
                skipped = self._should_skip_step(item)
                label = self._step_label(item)
                done = self._is_done(item)
                warning = None if skipped else self._step_warning(item, done)
                if self._is_blocked_by_validate(item):
                    decision = self._validate_decision()
                    decision_label = decision or "未识别/未明确通过"
                    warning = (
                        f"立项结论为{decision_label}，但该下游步骤已存在，请检查是否绕过立项闸门"
                        if done
                        else f"立项结论为{decision_label}，请先补充素材或重新立项"
                    )
                evidence_status = self._evidence_status(item)
                if evidence_status == "unbound":
                    warning = "产物存在但未绑定到当前 run，不能计入完成链路。"
                rows.append({
                    "step": item,
                    "label": label,
                    "done": True if skipped else done,
                    "skipped": skipped,
                    "warning": warning,
                    "evidence_status": "skipped" if skipped else evidence_status,
                    "file": self._latest_file(item) or self._legacy_file(item),
                })
            else:
                branch_rows = []
                all_done = True
                any_done = False
                target_branches = set(self._target_branches(item["branches"]))
                for branch in item["branches"]:
                    done = self._is_done(branch)
                    skipped = branch not in target_branches
                    evidence_status = self._evidence_status(branch)
                    if not skipped:
                        all_done = all_done and done
                        any_done = any_done or done
                    branch_warning = self._step_warning(branch, done)
                    if evidence_status == "unbound":
                        branch_warning = "产物存在但未绑定到当前 run，不能计入完成链路。"
                    branch_rows.append({
                        "step": branch,
                        "label": self._step_label(branch),
                        "done": done,
                        "skipped": skipped,
                        "warning": branch_warning,
                        "evidence_status": "skipped" if skipped else evidence_status,
                        "file": self._latest_file(branch) or self._legacy_file(branch),
                    })
                rows.append({
                    "group": item["label"],
                    "step": item["step"],
                    "done": all_done,
                    "partial": any_done and not all_done,
                    "branches": branch_rows,
                })
        warnings = []
        if author_source and author_source["status"] == "blocked":
            warnings.append({"step": "author-source", "warning": author_source["reason"]})
        for row in rows:
            if "group" in row:
                for branch in row["branches"]:
                    if branch.get("warning"):
                        warnings.append({"step": branch["step"], "warning": branch["warning"]})
            elif row.get("warning"):
                warnings.append({"step": row["step"], "warning": row["warning"]})
        return {
            "project": str(self.rt.project),
            "current_step": self._scoped_run().get("current_step"),
            "active_slug": self._scope_slug(),
            "scope_status": "scoped" if self._scope_slug() else "unscoped",
            "author_source": author_source,
            "research_mode": "author_material" if author_source else "platform",
            "success_criteria": self._success_criteria(),
            "target_platforms": self.target_platforms,
            "target_platform_labels": self._target_platform_labels(),
            "target_platform_bindings": self._target_platform_bindings(),
            "scheduled_steps": self._scheduled_steps(),
            "terminal_approval": DRAFT_INFORMATION_APPROVAL,
            "weekly_learning_steps": list(WEEKLY_LEARNING_STEPS),
            "rows": rows,
            "warnings": warnings,
        }

    def _success_criteria(self) -> dict[str, Any]:
        scope_slug = self._scope_slug()
        if not scope_slug:
            return {}
        try:
            run = self.rt.run_state(slug=scope_slug)
        except FileNotFoundError:
            return {}
        return dict(run.get("success_criteria") or {})

    def _draft_information_terminal_result(self, active_slug: str, *, flow: bool = False) -> dict[str, Any]:
        """Stop ordinary production before phase-5 platform draft approval.

        Draft filling, human publication evidence, and weekly learning are
        event-driven domains. They must never be inferred as the next serial
        task merely because the editorial schedule reached audit.
        """
        result: dict[str, Any] = {
            "status": "awaiting_approval",
            "message": "默认生产已完成，正在等待平台草稿信息的人审确认。",
            "project": str(self.rt.project),
            "slug": active_slug,
            "active_slug": active_slug,
            "required_approval": DRAFT_INFORMATION_APPROVAL,
            "scheduled_steps": self._scheduled_steps(),
            "next_steps": [],
            "target_platforms": self.target_platforms,
            "target_platform_labels": self._target_platform_labels(),
            "target_platform_bindings": self._target_platform_bindings(),
        }
        if flow:
            result.update({
                "current_step": DRAFT_INFORMATION_APPROVAL,
                "done_steps": self._scheduled_steps(),
                "remaining_steps": [],
                "skill": "",
            })
        return result

    def _find_next_steps(self) -> list[dict[str, Any]]:
        """按 PIPELINE 顺序找到下一步应执行的步骤。"""
        next_steps = []
        for item in PIPELINE:
            if isinstance(item, str):
                if self._should_skip_step(item):
                    continue
                if self._is_blocked_by_validate(item):
                    return []
                if not self._is_done(item):
                    next_steps.append({"step": item, "label": self._step_label(item)})
                    return next_steps
            else:
                if any(self._is_blocked_by_validate(branch) for branch in item["branches"]):
                    return []
                target_branches = self._target_branches(item["branches"])
                pending = [b for b in target_branches if not self._is_done(b)]
                if pending:
                    return [
                        {"step": b, "label": self._step_label(b), "group": item["label"]}
                        for b in pending
                    ]
        return []

    def next(self, slug: str | None = None) -> dict[str, Any]:
        """生成下一步任务卡并写入 sessions/next-task.md。"""
        if slug:
            self.slug = self.rt.normalize_slug(slug)
        self.state = self.rt.state()
        active_slug = self._active_slug()
        self.target_platforms = self._load_target_platforms()
        author_source = self._author_source_status()
        if author_source and author_source["status"] == "blocked":
            return self._blocked_author_source(author_source, flow=False)
        next_steps = self._find_next_steps()
        if not next_steps:
            decision = self._validate_decision()
            if not author_source and self._is_done("validate") and not self._validate_decision_passed():
                decision_label = decision or "未识别/未明确通过"
                return {
                    "status": "blocked",
                    "message": f"立项结论为{decision_label}，请先补充素材或重新执行 content-validate。",
                    "project": str(self.rt.project),
                    "active_slug": active_slug,
                    "validate_decision": decision,
                }
            return self._draft_information_terminal_result(active_slug)

        # 取第一个推荐步骤生成任务卡
        target = next_steps[0]
        step = target["step"]
        skill = STEP_SKILLS.get(step, {"skill": "unknown", "input": "", "output": ""})
        if author_source and step == "blueprint":
            skill = {**skill, "input": "已确认题目 + 本期作者素材快照 + intake 报告"}
        upstream, upstream_summary = self._collect_upstream(step)
        intake_audit = self._intake_audit() if step == "validate" else None
        if intake_audit and intake_audit.get("status") == "blocked":
            task_card = self._blocked_intake_task_card(active_slug, upstream, upstream_summary, intake_audit)
            task_path = self.rt.sessions / "next-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "素材理解质量审计未通过，请先补齐 content-intake。",
                "project": str(self.rt.project),
                "active_slug": active_slug,
                "recommended_step": "intake",
                "skill": "content-intake",
                "upstream": upstream,
                "intake_audit": intake_audit,
                "task_card": str(task_path),
            }
        market_signal = self._market_signal_gate(active_slug) if not author_source and step in {"validate", "blueprint"} else None
        if market_signal and market_signal.get("status") == "blocked":
            task_card = self._blocked_market_signal_task_card(
                active_slug,
                upstream,
                upstream_summary,
                market_signal,
            )
            task_path = self.rt.sessions / "next-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "研究快照无法绑定本期 run，不能进入选题与模板确认。",
                "project": str(self.rt.project),
                "active_slug": active_slug,
                "recommended_step": "market-signal",
                "skill": "tikomni",
                "upstream": upstream,
                "intake_audit": intake_audit,
                "market_signal": market_signal,
                "task_card": str(task_path),
            }
        validate_audit = self._validate_audit() if not author_source and step == "blueprint" else None
        if validate_audit and validate_audit.get("status") == "blocked" and not self._validate_decision_passed():
            task_card = self._blocked_validate_task_card(active_slug, upstream, upstream_summary, validate_audit)
            task_path = self.rt.sessions / "next-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "立项质量审计未通过，请先补齐 content-validate。",
                "project": str(self.rt.project),
                "active_slug": active_slug,
                "recommended_step": "validate",
                "skill": "content-validate",
                "upstream": upstream,
                "validate_audit": validate_audit,
                "task_card": str(task_path),
            }
        angle_audit = self._angle_audit() if step == "breakdown" else None
        if angle_audit and angle_audit.get("status") == "blocked":
            task_card = self._blocked_angle_task_card(active_slug, upstream, upstream_summary, angle_audit)
            task_path = self.rt.sessions / "next-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "角度质量审计未通过，请先补齐 content-angle。",
                "project": str(self.rt.project),
                "active_slug": active_slug,
                "recommended_step": "angle",
                "skill": "content-angle",
                "upstream": upstream,
                "angle_audit": angle_audit,
                "task_card": str(task_path),
            }
        breakdown_audit = self._breakdown_audit() if step == "xhs" else None
        if breakdown_audit and breakdown_audit.get("status") == "blocked":
            task_card = self._blocked_breakdown_task_card(active_slug, step, upstream, upstream_summary, breakdown_audit)
            task_path = self.rt.sessions / "next-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "内容拆解生产单未通过，请先补齐 content-breakdown。",
                "project": str(self.rt.project),
                "active_slug": active_slug,
                "recommended_step": "breakdown",
                "skill": "content-breakdown",
                "upstream": upstream,
                "breakdown_audit": breakdown_audit,
                "task_card": str(task_path),
            }
        wechat_preflight = self._wechat_preflight() if step == "write" and self._latest_file("breakdown") and not self._latest_file("blueprint") else None
        if wechat_preflight and wechat_preflight.get("status") == "blocked":
            task_card = self._blocked_wechat_task_card(active_slug, upstream, upstream_summary, wechat_preflight)
            task_path = self.rt.sessions / "next-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "公众号写前闸门未通过，请先补齐 content-breakdown。",
                "project": str(self.rt.project),
                "active_slug": active_slug,
                "recommended_step": "breakdown",
                "skill": "content-breakdown",
                "upstream": upstream,
                "wechat_preflight": wechat_preflight,
                "task_card": str(task_path),
            }
        blueprint_gate = self._blueprint_gate_audit(step)
        if blueprint_gate:
            return self._blocked_blueprint_next_result(active_slug, step, upstream, upstream_summary, blueprint_gate)
        package_gate = self._package_gate_audit(step)
        if package_gate:
            return self._blocked_package_next_result(active_slug, step, upstream, upstream_summary, package_gate)

        dbs_fusion_apply = self._dbs_fusion_pending_apply(active_slug, step)
        if dbs_fusion_apply:
            task_card = self._dbs_fusion_apply_task_card(active_slug, step, skill, upstream, upstream_summary, dbs_fusion_apply)
            task_path = self.rt.sessions / "next-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            dbs_blocked = dbs_fusion_apply.get("status") == "blocked"
            return {
                "status": "blocked" if dbs_blocked else "review_required",
                "message": dbs_fusion_apply.get("message") or "DBS 融合报告存在待写回项，请先执行 dbs-fusion-apply。",
                "project": str(self.rt.project),
                "active_slug": active_slug,
                "target_platforms": self.target_platforms,
                "target_platform_labels": self._target_platform_labels(),
                "next_steps": [{"step": s["step"], "label": s["label"]} for s in next_steps],
                "recommended_step": "dbs-fusion" if dbs_blocked else "dbs-fusion-apply",
                "original_recommended_step": step,
                "skill": "content-dbs-fusion",
                "upstream": upstream,
                "intake_audit": intake_audit,
                "validate_audit": validate_audit,
                "angle_audit": angle_audit,
                "breakdown_audit": breakdown_audit,
                "wechat_preflight": wechat_preflight,
                "dbs_fusion_apply": dbs_fusion_apply,
                "task_card": str(task_path),
            }
        style_recommendation = self._recommend_wechat_style(active_slug) if step == "write" else None
        intake_audit_guidance = self._intake_audit_markdown(intake_audit)
        market_signal_guidance = self._market_signal_gate_markdown(market_signal)
        validate_audit_guidance = self._validate_audit_markdown(validate_audit)
        angle_audit_guidance = self._angle_audit_markdown(angle_audit)
        breakdown_audit_guidance = self._breakdown_audit_markdown(breakdown_audit)
        preflight_guidance = self._wechat_preflight_markdown(wechat_preflight)
        dbs_fusion_guidance = self._dbs_fusion_apply_markdown(None)
        style_guidance = self._style_guidance_markdown(style_recommendation)
        handoff_binding_guidance = self._handoff_binding_markdown(step)
        package_delivery_guidance = self._package_delivery_contract_markdown(step)
        author_source_guidance = self._author_source_guidance(author_source, step)
        runtime_source = self._source_for_step(step, skill["skill"])
        if step == "validate" and market_signal and market_signal.get("path"):
            runtime_source = f"intake:{self._latest_file('intake')};market-signal:{self._rel_to_project(market_signal['path'])}"

        task_card = f"""# AI Founder Influence OS · 下一步任务卡

## 推荐步骤
- 步骤：`{step}`
- 产物：{skill['output']}
- 当前 slug：`{active_slug}`
{f"- 所属分组：{target.get('group')}" if target.get('group') else ""}

## 对应 Skill
- Skill：`{skill['skill']}`
- 输入：{skill['input']}
- 输出：{skill['output']}
{handoff_binding_guidance}
{package_delivery_guidance}
{author_source_guidance}

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}
{intake_audit_guidance}
{market_signal_guidance}
{validate_audit_guidance}
{angle_audit_guidance}
{breakdown_audit_guidance}
{preflight_guidance}
{dbs_fusion_guidance}
{style_guidance}

## 你需要做的事
1. 打开并阅读对应 Skill 的 `SKILL.md`：
   `{REPO_ROOT / 'skills' / skill['skill'] / 'SKILL.md'}`
2. 根据上游摘要，调用该 Skill 生成 `{skill['output']}`。
3. 将结果写回 runtime：
   ```bash
   {RUNTIME_CLI} --project {self.rt.project} write \\
     --step {step} --slug {active_slug} \\
     --content @output.md --source "{runtime_source}"
   ```
4. 完成后可继续运行：
   ```bash
   make -C {SKILL_DIR} next PROJECT={self.rt.project}
   ```

## 快捷命令
```bash
make -C {SKILL_DIR} status PROJECT={self.rt.project}
make -C {SKILL_DIR} next PROJECT={self.rt.project}
```
"""
        task_path = self.rt.sessions / "next-task.md"
        task_path.write_text(task_card, encoding="utf-8")

        return {
            "status": "ready",
            "project": str(self.rt.project),
            "active_slug": active_slug,
            "target_platforms": self.target_platforms,
            "target_platform_labels": self._target_platform_labels(),
            "target_platform_bindings": self._target_platform_bindings(),
            "next_steps": [{"step": s["step"], "label": s["label"]} for s in next_steps],
            "recommended_step": step,
            "skill": skill["skill"],
            "upstream": upstream,
            "intake_audit": intake_audit,
            "market_signal": market_signal,
            "author_source": author_source,
            "validate_audit": validate_audit,
            "angle_audit": angle_audit,
            "breakdown_audit": breakdown_audit,
            "wechat_preflight": wechat_preflight,
            "dbs_fusion_apply": None,
            "style_recommendation": style_recommendation,
            "style_recommendation_file": style_recommendation.get("recommendation_file") if style_recommendation else None,
            "draft_binding": self._current_draft_binding() if step in {"prelaunch", "compliance", "audit"} else None,
            "task_card": str(task_path),
        }


    def flow(self, intake_file: str | None = None, slug: str | None = None) -> dict[str, Any]:
        """content-flow：接受 intake 文件，写入 intake，然后推进到当前未完成步骤。"""
        self.state = self.rt.state()
        if slug:
            self.slug = self.rt.normalize_slug(slug)
        active_slug = self._active_slug() or "current"
        self.slug = active_slug

        if intake_file:
            p = Path(intake_file)
            if not p.exists():
                raise FileNotFoundError(f"intake 文件不存在: {intake_file}")
            content = p.read_text(encoding="utf-8")
            self.rt.write("intake", active_slug, content, source=f"content-flow:{intake_file}")
            self.state = self.rt.state()

        self.state = self.rt.state()
        self.target_platforms = self._load_target_platforms()
        author_source = self._author_source_status()
        if author_source and author_source["status"] == "blocked":
            return self._blocked_author_source(author_source, flow=True)
        next_steps = self._find_next_steps()
        if not next_steps:
            decision = self._validate_decision()
            if not author_source and self._is_done("validate") and not self._validate_decision_passed():
                decision_label = decision or "未识别/未明确通过"
                return {
                    "status": "blocked",
                    "message": f"立项结论为{decision_label}，请先补充素材或重新执行 content-validate。",
                    "project": str(self.rt.project),
                    "slug": active_slug,
                    "validate_decision": decision,
                }
            return self._draft_information_terminal_result(active_slug, flow=True)

        target = next_steps[0]
        step = target["step"]
        skill = STEP_SKILLS.get(step, {"skill": "unknown", "input": "", "output": ""})
        if author_source and step == "blueprint":
            skill = {**skill, "input": "已确认题目 + 本期作者素材快照 + intake 报告"}
        upstream, upstream_summary = self._collect_upstream(step)
        intake_audit = self._intake_audit() if step == "validate" else None
        if intake_audit and intake_audit.get("status") == "blocked":
            task_card = self._blocked_intake_task_card(active_slug, upstream, upstream_summary, intake_audit, flow=True)
            task_path = self.rt.sessions / "flow-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "素材理解质量审计未通过，请先补齐 content-intake。",
                "project": str(self.rt.project),
                "slug": active_slug,
                "current_step": "intake",
                "skill": "content-intake",
                "upstream": upstream,
                "intake_audit": intake_audit,
                "task_card": str(task_path),
            }
        market_signal = self._market_signal_gate(active_slug) if not author_source and step in {"validate", "blueprint"} else None
        if market_signal and market_signal.get("status") == "blocked":
            task_card = self._blocked_market_signal_task_card(
                active_slug,
                upstream,
                upstream_summary,
                market_signal,
                flow=True,
            )
            task_path = self.rt.sessions / "flow-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "研究快照无法绑定本期 run，不能进入选题与模板确认。",
                "project": str(self.rt.project),
                "slug": active_slug,
                "current_step": "market-signal",
                "skill": "tikomni",
                "upstream": upstream,
                "intake_audit": intake_audit,
                "market_signal": market_signal,
                "task_card": str(task_path),
            }
        validate_audit = self._validate_audit() if not author_source and step == "blueprint" else None
        if validate_audit and validate_audit.get("status") == "blocked" and not self._validate_decision_passed():
            task_card = self._blocked_validate_task_card(active_slug, upstream, upstream_summary, validate_audit, flow=True)
            task_path = self.rt.sessions / "flow-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "立项质量审计未通过，请先补齐 content-validate。",
                "project": str(self.rt.project),
                "slug": active_slug,
                "current_step": "validate",
                "skill": "content-validate",
                "upstream": upstream,
                "validate_audit": validate_audit,
                "task_card": str(task_path),
            }
        angle_audit = self._angle_audit() if step == "breakdown" else None
        if angle_audit and angle_audit.get("status") == "blocked":
            task_card = self._blocked_angle_task_card(active_slug, upstream, upstream_summary, angle_audit, flow=True)
            task_path = self.rt.sessions / "flow-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "角度质量审计未通过，请先补齐 content-angle。",
                "project": str(self.rt.project),
                "slug": active_slug,
                "current_step": "angle",
                "skill": "content-angle",
                "upstream": upstream,
                "angle_audit": angle_audit,
                "task_card": str(task_path),
            }
        breakdown_audit = self._breakdown_audit() if step == "xhs" else None
        if breakdown_audit and breakdown_audit.get("status") == "blocked":
            task_card = self._blocked_breakdown_task_card(active_slug, step, upstream, upstream_summary, breakdown_audit, flow=True)
            task_path = self.rt.sessions / "flow-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "内容拆解生产单未通过，请先补齐 content-breakdown。",
                "project": str(self.rt.project),
                "slug": active_slug,
                "current_step": "breakdown",
                "skill": "content-breakdown",
                "upstream": upstream,
                "breakdown_audit": breakdown_audit,
                "task_card": str(task_path),
            }
        wechat_preflight = self._wechat_preflight() if step == "write" and self._latest_file("breakdown") and not self._latest_file("blueprint") else None
        if wechat_preflight and wechat_preflight.get("status") == "blocked":
            task_card = self._blocked_wechat_task_card(active_slug, upstream, upstream_summary, wechat_preflight, flow=True)
            task_path = self.rt.sessions / "flow-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            return {
                "status": "blocked",
                "message": "公众号写前闸门未通过，请先补齐 content-breakdown。",
                "project": str(self.rt.project),
                "slug": active_slug,
                "current_step": "breakdown",
                "skill": "content-breakdown",
                "upstream": upstream,
                "wechat_preflight": wechat_preflight,
                "task_card": str(task_path),
            }
        blueprint_gate = self._blueprint_gate_audit(step)
        if blueprint_gate:
            return self._blocked_blueprint_flow_result(active_slug, step, upstream, upstream_summary, blueprint_gate)
        package_gate = self._package_gate_audit(step)
        if package_gate:
            return self._blocked_package_flow_result(active_slug, step, upstream, upstream_summary, package_gate)

        dbs_fusion_apply = self._dbs_fusion_pending_apply(active_slug, step)
        if dbs_fusion_apply:
            task_card = self._dbs_fusion_apply_task_card(active_slug, step, skill, upstream, upstream_summary, dbs_fusion_apply, flow=True)
            task_path = self.rt.sessions / "flow-task.md"
            task_path.write_text(task_card, encoding="utf-8")
            dbs_blocked = dbs_fusion_apply.get("status") == "blocked"
            return {
                "status": "blocked" if dbs_blocked else "review_required",
                "message": dbs_fusion_apply.get("message") or "DBS 融合报告存在待写回项，请先执行 dbs-fusion-apply。",
                "project": str(self.rt.project),
                "slug": active_slug,
                "current_step": "dbs-fusion" if dbs_blocked else "dbs-fusion-apply",
                "original_current_step": step,
                "done_steps": [],
                "remaining_steps": [s["step"] for s in next_steps],
                "skill": "content-dbs-fusion",
                "upstream": upstream,
                "intake_audit": intake_audit,
                "validate_audit": validate_audit,
                "angle_audit": angle_audit,
                "breakdown_audit": breakdown_audit,
                "wechat_preflight": wechat_preflight,
                "dbs_fusion_apply": dbs_fusion_apply,
                "task_card": str(task_path),
            }
        style_recommendation = self._recommend_wechat_style(active_slug) if step == "write" else None
        intake_audit_guidance = self._intake_audit_markdown(intake_audit)
        market_signal_guidance = self._market_signal_gate_markdown(market_signal)
        validate_audit_guidance = self._validate_audit_markdown(validate_audit)
        angle_audit_guidance = self._angle_audit_markdown(angle_audit)
        breakdown_audit_guidance = self._breakdown_audit_markdown(breakdown_audit)
        preflight_guidance = self._wechat_preflight_markdown(wechat_preflight)
        dbs_fusion_guidance = self._dbs_fusion_apply_markdown(None)
        style_guidance = self._style_guidance_markdown(style_recommendation)
        handoff_binding_guidance = self._handoff_binding_markdown(step)
        package_delivery_guidance = self._package_delivery_contract_markdown(step)
        author_source_guidance = self._author_source_guidance(author_source, step)
        runtime_source = self._source_for_step(step, skill["skill"])
        if step == "validate" and market_signal and market_signal.get("path"):
            runtime_source = f"intake:{self._latest_file('intake')};market-signal:{self._rel_to_project(market_signal['path'])}"

        done_steps = []
        remaining = [s["step"] for s in next_steps]
        for item in PIPELINE:
            if isinstance(item, str):
                if not self._should_skip_step(item) and self._is_done(item) and item not in remaining:
                    done_steps.append(item)
            else:
                for b in self._target_branches(item["branches"]):
                    if self._is_done(b) and b not in remaining:
                        done_steps.append(b)

        task_card = f"""# content-flow 任务卡 · {step}

> 本任务卡由 `content-flow` 自动生成。完成本步骤后，再次运行同一命令即可推进到下一步。

## 当前步骤
- 步骤：`{step}`
- 产物：{skill['output']}
- 当前 slug：`{active_slug}`
{f"- 所属分组：{target.get('group')}" if target.get('group') else ""}

## 对应 Skill
- Skill：`{skill['skill']}`
- 输入：{skill['input']}
- 输出：{skill['output']}
{handoff_binding_guidance}
{package_delivery_guidance}
{author_source_guidance}

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}
{intake_audit_guidance}
{market_signal_guidance}
{validate_audit_guidance}
{angle_audit_guidance}
{breakdown_audit_guidance}
{preflight_guidance}
{dbs_fusion_guidance}
{style_guidance}

## 你需要做的事
1. 打开并阅读对应 Skill 的 `SKILL.md`：
   `{REPO_ROOT / 'skills' / skill['skill'] / 'SKILL.md'}`
2. 根据上游摘要，调用该 Skill 生成 `{skill['output']}`。
3. 将结果写回 runtime：
   ```bash
   {RUNTIME_CLI} --project {self.rt.project} write \
     --step {step} --slug {active_slug} \
     --content @output.md --source "{runtime_source}"
   ```
4. 完成后再次运行：
   ```bash
   make -C {SKILL_DIR} content-flow PROJECT={self.rt.project} SLUG={active_slug}
   ```

## 流水线进度
- 已完成：{', '.join(done_steps) or '无'}
- 当前：{step}
- 剩余：{', '.join(remaining)}
"""
        task_path = self.rt.sessions / "flow-task.md"
        task_path.write_text(task_card, encoding="utf-8")

        return {
            "status": "flow_ready",
            "project": str(self.rt.project),
            "slug": active_slug,
            "target_platforms": self.target_platforms,
            "target_platform_labels": self._target_platform_labels(),
            "target_platform_bindings": self._target_platform_bindings(),
            "current_step": step,
            "done_steps": done_steps,
            "remaining_steps": remaining,
            "skill": skill["skill"],
            "upstream": upstream,
            "intake_audit": intake_audit,
            "market_signal": market_signal,
            "author_source": author_source,
            "validate_audit": validate_audit,
            "angle_audit": angle_audit,
            "breakdown_audit": breakdown_audit,
            "wechat_preflight": wechat_preflight,
            "dbs_fusion_apply": None,
            "style_recommendation": style_recommendation,
            "style_recommendation_file": style_recommendation.get("recommendation_file") if style_recommendation else None,
            "draft_binding": self._current_draft_binding() if step in {"prelaunch", "compliance", "audit"} else None,
            "task_card": str(task_path),
        }

def print_status(data: dict[str, Any]) -> None:
    print(f"# AI Founder Influence OS · 流水线状态")
    print(f"\n项目：{data['project']}")
    print(f"当前 slug：{data['active_slug']}")
    if data.get("target_platforms"):
        print(f"目标阵地：{'、'.join(data.get('target_platform_labels') or data['target_platforms'])}")
    print(f"最近操作：{data['current_step'] or '无'}\n")
    if data.get("warnings"):
        print("⚠️  状态警告：")
        for warning in data["warnings"]:
            print(f"  - {warning['step']}: {warning['warning']}")
        print()
    for row in data["rows"]:
        if "group" in row:
            status = "✅ 已完成" if row["done"] else ("🟡 部分完成" if row["partial"] else "⏳ 待完成")
            print(f"{status} 【{row['group']}】")
            for b in row["branches"]:
                bstatus = "⏭️" if b.get("skipped") else ("✅" if b["done"] else "⏳")
                skipped = "（非目标阵地，跳过）" if b.get("skipped") else ""
                note = f" ⚠️ {b['warning']}" if b.get("warning") else ""
                print(f"  {bstatus} {b['step']:10} {b['label']:20} {b['file'] or ''}{skipped}{note}")
        else:
            status = "⏭️ 跳过" if row.get("skipped") else ("✅ 已完成" if row["done"] else "⏳ 待完成")
            note = f" ⚠️ {row['warning']}" if row.get("warning") else ""
            skipped = "（本期无需此步骤）" if row.get("skipped") else ""
            print(f"{status} {row['step']:12} {row['label']:20} {row['file'] or ''}{skipped}{note}")
    print()


def print_flow(data: dict[str, Any]) -> None:
    if data["status"] == "blocked":
        print("# content-flow · 立项暂停")
        print(f"\n项目：{data['project']}")
        print(f"slug：{data['slug']}")
        print(f"\n{data['message']}")
        return
    if data["status"] == "awaiting_approval":
        print("# content-flow · 等待平台草稿信息确认")
        print(f"\n项目：{data['project']}")
        print(f"slug：{data['slug']}")
        print(f"\n{data['message']}")
        return
    print(f"# content-flow · 当前步骤：{data['current_step']} -> {data['skill']}")
    print(f"\n项目：{data['project']}")
    print(f"slug：{data['slug']}")
    print(f"已完成：{', '.join(data['done_steps']) or '无'}")
    print(f"剩余：{', '.join(data['remaining_steps'])}")
    print(f"\n任务卡：{data['task_card']}")

def main() -> int:
    parser = argparse.ArgumentParser(description="content-pipeline · AI Founder Influence OS 导演")
    parser.add_argument("--project", required=True, help="项目根目录")
    parser.add_argument("--slug", default=None, help="手动指定当前 slug（默认自动检测）")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="查看流水线状态")
    sub.add_parser("next", help="生成下一步任务卡")

    p_flow = sub.add_parser("flow", help="content-flow：从 intake 文件推进流水线")
    p_flow.add_argument("--intake", default=None, help="intake 素材文件路径")
    p_flow.add_argument("--slug", default=None, help="当前 slug")
    args = parser.parse_args()

    director = PipelineDirector(args.project, args.slug)
    if args.command == "status":
        data = director.status()
        print_status(data)
        print(json.dumps(data, ensure_ascii=False, indent=2))
    elif args.command == "next":
        data = director.next(args.slug)
        if data["status"] in {"awaiting_approval", "completed", "blocked"}:
            print(json.dumps(data, ensure_ascii=False, indent=2))
        else:
            print(f"# 下一步：{data['recommended_step']} -> {data['skill']}")
            print(f"任务卡已生成：{data['task_card']}\n")
            print(json.dumps(data, ensure_ascii=False, indent=2))
    elif args.command == "flow":
        data = director.flow(args.intake, args.slug)
        print_flow(data)
        print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
