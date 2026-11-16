#!/usr/bin/env python3
"""content-runtime · AI Founder Influence OS 轻量状态与文件管理器

用法:
    python3 content_runtime.py --project ~/ai-content-system init
    python3 content_runtime.py --project ~/ai-content-system write --step intake --slug demo --content "..." --source "用户输入"
    python3 content_runtime.py --project ~/ai-content-system read --step intake --latest
    python3 content_runtime.py --project ~/ai-content-system list --days 7
    python3 content_runtime.py --project ~/ai-content-system state
    python3 content_runtime.py --project ~/ai-content-system validate --step intake --file pipeline/intake/2026-06-23-171601-123456-demo-intake.md
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
import json
import os
import re
import sys
import uuid
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from archive_quality import audit_archive
from audit_quality import audit_audit
from blueprint_quality import audit_blueprint
from compliance_quality import audit_compliance
from dbs_fusion_quality import audit_dbs_fusion
from demo_data import DEMO_SAMPLES
from angle_quality import audit_angle
from breakdown_quality import audit_breakdown
from intake_quality import audit_intake
from platform_adapt_quality import audit_platform_adapt
from prelaunch_quality import audit_prelaunch
from package_quality import audit_package
from performance_quality import audit_performance
from publish_quality import audit_publish
from release_gate import run_release_gate, build_package_manifest
from review_quality import audit_review
from twin_quality import audit_twin
from validate_quality import audit_validate
from visual_quality import audit_visual
from write_quality import audit_write
from xhs_quality import audit_xhs
from material_corrections import base_context, correction_path, current_correction, validate_correction
from blueprint_platform_scope import check_platform_scope
import author_evidence


STEPS = [
    "intake", "validate", "blueprint", "angle", "breakdown",
    "dbs-fusion",
    "write", "package", "xhs", "douyin", "platform-adapt", "visual", "prelaunch",
    "compliance", "audit", "publish", "performance", "review", "archive", "twin",
]

# 新生产任务只把三个拥有独立研究与原生内容契约的平台作为生产单元。
# 旧五平台任务仍可读取和完成，避免升级后破坏已经存在的本机记录。
SUPPORTED_PLATFORMS = ("wechat", "xhs", "shipinhao")
LEGACY_PRODUCTION_PLATFORMS = ("wechat", "xhs", "shipinhao", "douyin", "moments")
PRODUCTION_RUN_SCHEMA = "echo-founder.production-run.v2"
LEGACY_PRODUCTION_RUN_SCHEMA = "aifios.production-run.v1"
VISUAL_MODES = ("stable",)
VISUAL_PROVIDER_POLICIES = ("auto",)
DEFAULT_VISUAL_PREFERENCES = {
    "mode": "stable",
    "direction_count": 2,
    "provider_policy": "auto",
}
DEFAULT_VISUAL_LAYOUT_THEME = "default"
VISUAL_LAYOUT_THEME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
# These steps may alter the operator-facing production trail only after the
# topic/template decision has bound and frozen the live TikOmni evidence.
# Keep this policy in the Python runtime as well as the UI so local consumers
# use one equivalent gate rather than trusting a browser-only check.
FROZEN_TIKOMNI_REQUIRED_STEPS = frozenset({
    "angle",
    "breakdown",
    "write",
    "package",
    "xhs",
    "douyin",
    "platform-adapt",
    "visual",
    "prelaunch",
    "compliance",
    "audit",
    "publish",
    "performance",
    "review",
    "archive",
    "twin",
})
# Explicitly imported historical/third-party performance evidence must not
# attach itself to the active production run. Keep its trace in a separate,
# non-five-platform run so it can never become a releasable production path.
UNBOUND_PERFORMANCE_RUN_PREFIX = "unbound-performance-"
PLATFORM_ALIASES = {
    "wechat": "wechat",
    "weixin": "wechat",
    "微信公众号": "wechat",
    "公众号": "wechat",
    "微信公号": "wechat",
    "微信文章": "wechat",
    "xhs": "xhs",
    "xiaohongshu": "xhs",
    "rednote": "xhs",
    "小红书": "xhs",
    "shipinhao": "shipinhao",
    "channels": "shipinhao",
    "wechat-channels": "shipinhao",
    "视频号": "shipinhao",
    "微信视频号": "shipinhao",
    "douyin": "douyin",
    "dy": "douyin",
    "抖音": "douyin",
    "抖音号": "douyin",
    "moments": "moments",
    "wechat-moments": "moments",
    "朋友圈": "moments",
    "微信朋友圈": "moments",
}

# The operator-facing production workbench uses these scopes rather than
# individual Skill names. Every approval is tied to the exact local bytes of
# one current artifact in the active run.
APPROVAL_SCOPES = (
    "topic_template",
    "content_package",
    "visual_assets",
    "draft_information",
    "publication_result",
)

# Approval of publication information means approval of exactly the selected
# platform jobs. Legacy queues without target_platforms retain their historical
# 11-item contract so existing work remains readable and verifiable.
DRAFT_QUEUE_SCHEMA = "aifios.publication-draft-queue.v1"


def _publication_contract_jobs(opinion_count: int) -> frozenset[tuple[str, str, str]]:
    count = max(1, int(opinion_count or 0))
    jobs: list[tuple[str, str, str]] = [("wechat", "wechat-article", "draft_fill")]
    for index in range(1, count + 1):
        jobs.append(("xiaohongshu", f"xiaohongshu-opinion-{index}", "draft_fill"))
        jobs.append(("moments", f"moments-opinion-{index}", "draft_fill"))
    for platform in ("shipinhao", "douyin"):
        for index in (1, 2):
            jobs.append((platform, f"{platform}-video-execution-{index}", "execution_package"))
    return frozenset(jobs)


def _opinion_count_from_jobs(jobs: list[dict[str, Any]]) -> int:
    indices: set[int] = set()
    for job in jobs or []:
        if not isinstance(job, dict):
            continue
        item_id = str(job.get("item_id") or "")
        match = re.fullmatch(r"xiaohongshu-opinion-(\d+)", item_id)
        if match:
            indices.add(int(match.group(1)))
    return len(indices)


REQUIRED_DRAFT_QUEUE_JOBS = _publication_contract_jobs(3)


def _new_platform_lane(platform: str) -> dict[str, Any]:
    """Return the platform-native state owned by one production lane."""
    requires_visual = platform in {"wechat", "xhs"}
    return {
        "platform": platform,
        "status": "pending",
        "research": {"status": "pending", "snapshot_path": "", "snapshot_sha256": ""},
        "topic": {"status": "pending", "artifact_path": ""},
        "content": {"status": "pending", "artifact_path": "", "sha256": ""},
        "visual": {
            "required": requires_visual,
            "status": "pending" if requires_visual else "not_required",
            "artifact_path": "",
            "sha256": "",
        },
        "publication": {"status": "pending", "evidence_path": ""},
        "performance": {"status": "pending", "review_path": ""},
    }


def _new_platform_lanes(platforms: list[str] | tuple[str, ...]) -> dict[str, dict[str, Any]]:
    return {platform: _new_platform_lane(platform) for platform in platforms}

APPROVAL_SCOPE_CONFIG: dict[str, dict[str, Any]] = {
    "topic_template": {
        "step": "blueprint",
        "roots": ("pipeline/blueprint/",),
    },
    "content_package": {
        "step": "package",
        "roots": ("pipeline/package/",),
    },
    "visual_assets": {
        "step": None,
        "roots": ("pipeline/visual/",),
    },
    "draft_information": {
        "step": None,
        "roots": ("materials/publication/drafts/", "pipeline/drafts/"),
    },
    "publication_result": {
        "step": "publish",
        "roots": ("pipeline/publish/", "materials/publication/ledger/"),
        # A legacy publish Markdown record still binds to the publish step.
        # The local publication desk writes an evidence ledger instead, which
        # must be registered as a phase artifact without pretending to be a
        # runtime Markdown step.
        "phase_artifact_roots": ("materials/publication/ledger/",),
    },
}

DOWNSTREAM_APPROVAL_SCOPES: dict[str, tuple[str, ...]] = {
    "topic_template": ("content_package", "visual_assets", "draft_information", "publication_result"),
    "content_package": ("visual_assets", "draft_information", "publication_result"),
    "visual_assets": ("draft_information", "publication_result"),
    "draft_information": ("publication_result",),
    "publication_result": (),
}

STEP_APPROVAL_SCOPES = {
    "blueprint": "topic_template",
    "package": "content_package",
    "publish": "publication_result",
}

# 步骤名到存储目录的映射。默认目录名与步骤名相同；特殊步骤可映射到别的目录。
STEP_DIRS = {
    "angle": "angles",
    "write": "final",
}

REQUIRED_SECTIONS = {
    "intake": ["0. 素材场景", "1. 人物", "2. 场景", "3. 观点", "4. 情绪", "5. 案例", "6. 商业意图", "7. 不可公开信息", "9. 素材质量判断"],
    "validate": ["0. 素材来源", "1. 立项决策", "2. HKR 质检", "3. 商业成立性判断", "4. 平台首发策略", "5. 素材补充清单", "6. 风险提示", "7. 下一步"],
    "blueprint": ["0. 上游约束", "1. 爆款拆解吸收", "2. 核心判断", "3. 目标读者与情绪入口", "4. 公众号思想母版骨架", "5. 证据链与素材分配", "6. 叙事推进与章节任务", "7. 金句与可拆资产", "8. 评论区互动预埋", "9. 风险边界", "10. 人工确认清单", "11. 下一步执行指令"],
    "angle": ["0. 立项约束", "推荐角度", "角度对比表", "建议"],
    "breakdown": ["0. 上游约束", "关键词矩阵", "爆款档案参考", "传播心理假设", "标题方案", "开场钩子库", "阵地适配建议", "素材补充清单", "下一步执行指令"],
    "dbs-fusion": ["0. 融合任务", "1. 调用链", "2. 关键结论", "3. 证据与风险", "4. 写回计划", "5. 下一步动作", "6. 人工复核"],
    "write": ["AIFIOS-WRITE-CHECK", "上游 brief", "推荐风格", "写作任务卡", "证据台账", "文章骨架", "必用证据", "传播心理兑现", "风险边界", "商业收口", "质检结论"],
    "package": ["1. 公众号母稿", "2. 短视频内容", "3. 图文内容"],
    "xhs": ["封面三行文案", "图文卡片结构", "正文笔记", "评论区承接", "风险边界"],
    "douyin": ["0. 上游约束", "1. 发布与定位", "2. 30-45 秒候选脚本", "3. 推荐口播稿", "4. 拍摄与字幕", "5. 评论承接与风险边界"],
    "platform-adapt": ["0. 原文信息", "发布稿", "6. 平台差异对照", "7. 下一步执行指令"],
    "visual": ["0. 原文与视觉目标", "1. 视觉系统", "2. 视觉资产清单", "3. 资产生产说明", "4. 验收清单", "5. 下一步执行指令"],
    "prelaunch": ["1. 事实层检查", "2. 风格层检查", "3. 平台规则层检查", "4. 商业闭环检查", "5. 共鸣诊断"],
    "compliance": ["0. 检查对象", "1. 违禁词扫描", "2. 广告法敏感词", "3. 平台规则风险", "4. 版权风险", "4.1 授权与引流证据台账", "5. 修改清单", "6. 综合判断"],
    "audit": ["1. 来源追溯", "2. 事实校验", "2.1 事实声明台账", "3. 隐私提醒", "4. 平台风险", "5. 修改建议", "7. 总体结论"],
    "publish": ["0. 最终版", "1. 表现数据", "2. 发布备注", "3. 最终版正文快照"],
    "performance": ["0. 采集对象", "1. 授权与数据源", "2. 原始快照", "3. 归一化指标", "4. 评论样本", "5. Review 输入包", "6. 写回与下一步"],
    "review": ["1. 表现记录", "3. 评论洞察", "7. 下一条建议"],
    "archive": [],
    "twin": ["1. 内容元信息", "2. 内容 DNA 提取", "3. 结构模式识别", "4. 表达特征提取", "5. 读者画像观察", "6. 风格一致性评分", "7. 可复用模式归档", "8. 禁区/禁忌更新建议", "9. 观察结论"],
}

MATERIAL_INDEX_SCHEMA = "aifios.material-index.v1"
MATERIAL_SUMMARY_MAX_CHARS = 300
TOPIC_SNAPSHOT_PATH_RE = re.compile(
    r"(?m)^\s*-\s*(?:TikOmni\s*)?研究快照\s*[：:]\s*`?([^`\s]+/snapshot\.json)`?\s*$"
)
TOPIC_SNAPSHOT_SHA_RE = re.compile(
    r"(?mi)^\s*-\s*(?:TikOmni\s*)?快照\s*(?:SHA-?256|sha-?256)\s*[：:]\s*`?([a-f0-9]{64})`?\s*$"
)
PROJECT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


def normalize_success_criterion(value: Any) -> int | float | str | None:
    """Keep run targets readable while normalizing simple numeric values."""
    text = str(value or "").strip()
    if not text:
        return None
    match = re.fullmatch(r"(\d+(?:\.\d+)?)\s*([wW万kK千])?", text)
    if not match:
        return text
    number = float(match.group(1))
    unit = (match.group(2) or "").lower()
    if unit in {"w", "万"}:
        number *= 10000
    elif unit in {"k", "千"}:
        number *= 1000
    return int(number) if number.is_integer() else number


def normalize_visual_template(value: Any) -> str:
    """Persist one safe md2wechat theme identifier without a product-side catalog."""
    template = str(value or DEFAULT_VISUAL_LAYOUT_THEME).strip().lower()
    if not VISUAL_LAYOUT_THEME_RE.fullmatch(template):
        raise ValueError("md2wechat 主题标识格式不正确：" + template)
    return template


def normalize_project_id(value: Any) -> str:
    """Keep a run bound to one customer/project namespace.

    The local workspace can hold several customer projects.  The runtime does
    not infer that boundary from a free-form topic: it persists a small stable
    identifier on every new run so optional advisor conclusions cannot bleed
    into a different customer's content.
    """
    project_id = str(value or "default").strip().lower()
    if not PROJECT_ID_RE.fullmatch(project_id):
        raise ValueError("项目 ID 必须是 1-64 位小写字母、数字、连字符或下划线")
    return project_id


@dataclass
class SessionState:
    project: str
    current_step: str | None = None
    current_slug: str | None = None
    active_run_id: str | None = None
    latest_files: dict[str, str | None] = None
    latest_by_slug: dict[str, dict[str, str | None]] = None
    updated_at: str | None = None

    def __post_init__(self):
        if self.latest_files is None:
            self.latest_files = {s: None for s in STEPS}
        else:
            self.latest_files = {s: self.latest_files.get(s) for s in STEPS}
        if self.latest_by_slug is None:
            self.latest_by_slug = {}
        else:
            normalized = {}
            for slug, files in self.latest_by_slug.items():
                normalized[slug] = {s: files.get(s) for s in STEPS}
            self.latest_by_slug = normalized


class RuntimeOutputValidationError(ValueError):
    def __init__(self, validation: dict[str, Any]) -> None:
        super().__init__("生成内容未通过检查，当前版本未更新")
        self.validation = validation


class ContentRuntime:
    def __init__(self, project: Path | str):
        self.project = Path(project).expanduser().resolve(strict=False)
        self.pipeline = self.project / "pipeline"
        self.brain_dir = self.project / "brain"
        self.sessions = self.project / "sessions"
        self.runs = self.project / "runs"
        self.assets = self.project / "assets"
        self.materials = self.project / "materials"
        self.state_file = self.sessions / "latest.json"
        self.state_lock_file = self.sessions / ".latest.lock"

    def init(self, demo: bool = False) -> dict[str, Any]:
        """初始化项目目录结构。"""
        dirs = [
            self.pipeline / "intake",
            self.pipeline / "validate",
            self.pipeline / "blueprint",
            self.pipeline / "angles",
            self.pipeline / "breakdown",
            self.pipeline / "dbs-fusion",
            self.pipeline / "final",
            self.pipeline / "package",
            self.pipeline / "xhs",
            self.pipeline / "douyin",
            self.pipeline / "platform-adapt",
            self.pipeline / "platform-adapt" / "wechat",
            self.pipeline / "platform-adapt" / "xhs",
            self.pipeline / "platform-adapt" / "shipinhao",
            self.pipeline / "platform-adapt" / "douyin",
            self.pipeline / "platform-adapt" / "moments",
            self.pipeline / "prelaunch",
            self.pipeline / "compliance",
            self.pipeline / "audit",
            self.pipeline / "visual",
            self.pipeline / "publish",
            self.pipeline / "performance",
            self.pipeline / "review",
            self.pipeline / "archive",
            self.pipeline / "twin",
            self.brain_dir,
            self.brain_dir / "twin",
            self.sessions,
            self.runs,
            self.assets,
            self.materials,
            self.materials / "research",
            self.materials / "publish-proof",
            self.materials / "publication" / "drafts",
            self.materials / "publication" / "ledger",
            self.materials / "hit-library",
            self.materials / "hit-library" / "wechat",
            self.materials / "hit-library" / "xhs",
            self.materials / "hit-library" / "shipinhao",
            self.materials / "hit-library" / "douyin",
            self.materials / "hit-library" / "moments",
            self.materials / "hit-library" / "benchmark",
            self.materials / "performance",
            self.materials / "performance" / "raw",
            self.materials / "performance" / "wechat-official-account",
            self.materials / "performance" / "wechat-channels",
            self.materials / "performance" / "xhs",
            self.materials / "performance" / "douyin",
            self.materials / "performance" / "moments",
            self.materials / "performance" / "review-inputs",
        ]
        for d in dirs:
            d.mkdir(parents=True, exist_ok=True)

        # 初始化 brain 文件
        for name in ["insights.md", "style-evolution.md", "case-library.md", "no-fly-zone.md"]:
            p = self.brain_dir / name
            if not p.exists():
                p.write_text(f"# {name[:-3].replace('-', ' ').title()}\n\n", encoding="utf-8")

        material_index = self._material_index_path()
        if not material_index.exists():
            self._save_material_index(self._empty_material_index())

        for name in ["content-dna.md", "pattern-library.md", "voice-signature.md", "evolution-log.md", "reader-profile.md"]:
            p = self.brain_dir / "twin" / name
            if not p.exists():
                p.write_text(f"# {name[:-3].replace('-', ' ').title()}\n\n", encoding="utf-8")

        if not self.state_file.exists():
            self._save_state(SessionState(project=str(self.project)))

        result = {"status": "initialized", "project": str(self.project)}
        if demo:
            demo_files = self._init_demo()
            result["demo_files"] = demo_files
        return result

    def _init_demo(self) -> list[str]:
        """生成示例项目，覆盖一条顺序完整的内容流水线。"""
        slug = "codex-demo"
        written: list[str] = []
        for step, content in DEMO_SAMPLES.items():
            res = self.write(step, slug, content, source="demo")
            written.append(res["path"])
        self._init_demo_visual_assets(slug)
        return written

    def _init_demo_visual_assets(self, slug: str) -> None:
        """Create lightweight files referenced by the demo visual manifest."""
        visual_dir = self.pipeline / "visual" / slug
        html_dir = visual_dir / "公众号HTML输出"
        html_dir.mkdir(parents=True, exist_ok=True)
        (visual_dir / "wechat-cover-21x9.png").write_bytes(b"demo-wechat-cover")
        (visual_dir / "wechat-share-1x1.png").write_bytes(b"demo-wechat-share")
        (visual_dir / "xhs-cover.png").write_bytes(b"demo-xhs-cover")
        (visual_dir / "inline-xiaohei.png").write_bytes(b"demo-inline-xiaohei")
        (html_dir / "index.html").write_text("<html><body>demo wechat html</body></html>", encoding="utf-8")

    @contextlib.contextmanager
    def _state_lock(self):
        self.sessions.mkdir(parents=True, exist_ok=True)
        with self.state_lock_file.open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _load_state_unlocked(self) -> SessionState:
        if not self.state_file.exists():
            return SessionState(project=str(self.project))
        data = json.loads(self.state_file.read_text(encoding="utf-8"))
        return SessionState(
            project=data.get("project", str(self.project)),
            current_step=data.get("current_step"),
            current_slug=data.get("current_slug"),
            active_run_id=data.get("active_run_id"),
            latest_files=data.get("latest_files"),
            latest_by_slug=data.get("latest_by_slug"),
            updated_at=data.get("updated_at"),
        )

    def _load_state(self) -> SessionState:
        with self._state_lock():
            return self._load_state_unlocked()

    def _save_state_unlocked(self, state: SessionState) -> None:
        self.sessions.mkdir(parents=True, exist_ok=True)
        state.updated_at = datetime.now().isoformat()
        tmp = self.state_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(asdict(state), ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.state_file)

    def _save_state(self, state: SessionState) -> None:
        with self._state_lock():
            self._save_state_unlocked(state)

    def _update_state(self, updater) -> SessionState:
        with self._state_lock():
            state = self._load_state_unlocked()
            updater(state)
            self._save_state_unlocked(state)
            return state

    def _run_file(self, run_id: str) -> Path:
        safe_run_id = self.normalize_slug(run_id)
        return self.runs / f"{safe_run_id}.json"

    @staticmethod
    def normalize_platforms(platforms: str | list[str] | None) -> list[str]:
        """把中文/英文阵地输入规范成内部平台标识。"""
        if not platforms:
            return []
        if isinstance(platforms, str):
            raw_items = re.split(r"[,，/、\s]+", platforms)
        else:
            raw_items = platforms
        normalized: list[str] = []
        for item in raw_items:
            key = str(item).strip().lower()
            platform = PLATFORM_ALIASES.get(key)
            if platform and platform not in normalized:
                normalized.append(platform)
        return normalized

    @staticmethod
    def _is_managed_production_run(run: dict[str, Any]) -> bool:
        """Whether a run carries a current or readable legacy contract."""
        platforms = run.get("selected_platforms") or run.get("target_platforms")
        if not isinstance(platforms, list):
            return False
        normalized = [str(item) for item in platforms if str(item) in LEGACY_PRODUCTION_PLATFORMS]
        if len(normalized) != len(set(normalized)) or not normalized:
            return False
        selected = set(normalized)
        return selected.issubset(set(SUPPORTED_PLATFORMS)) or selected == set(LEGACY_PRODUCTION_PLATFORMS)

    def active_managed_run_for_slug(self, slug: str) -> str | None:
        """Return the active managed production run only when it owns ``slug``.

        Importers use this to distinguish an active production report, which
        must retain its frozen TikOmni gate, from an unrelated historical
        performance record that can only be stored as blocked evidence.
        """
        safe_slug = self.normalize_slug(slug)
        with self._state_lock():
            state = self._load_state_unlocked()
            active_run_id = state.active_run_id
            if not active_run_id:
                return None
            path = self._run_file(active_run_id)
            if not path.exists():
                return None
            run = self._load_run_unlocked(active_run_id, active_run_id)

        run_slug = self.normalize_slug(str(run.get("slug") or active_run_id))
        if not self._is_managed_production_run(run) or run_slug != safe_slug:
            return None
        return self.normalize_slug(active_run_id)

    def _assert_unbound_performance_report(self, step: str, slug: str, run_id: str | None) -> None:
        """Allow only clearly non-production performance import evidence."""
        if step != "performance":
            raise ValueError("--unbound-report 仅可用于 performance 步骤")
        if run_id:
            raise ValueError("--unbound-report 不能与 --run-id 同时使用")
        if self.active_managed_run_for_slug(slug):
            raise ValueError(
                "当前 production run 与该 slug 一致，performance 必须提供 --run-id 并通过 TikOmni 冻结研究校验"
            )

    def _production_run_for_downstream_write(self, slug: str, run_id: str | None) -> str | None:
        """Resolve a managed run before a gated write can alter it.

        Historical scratch artifacts stay readable, but cannot become an
        approval/release path. A real production run is created through
        ``create_run`` and carries a confirmed primary-platform contract.
        """
        requested_run_id = self.normalize_slug(run_id) if run_id else None
        with self._state_lock():
            state = self._load_state_unlocked()
            selected_run_id = requested_run_id or state.active_run_id
            if not selected_run_id:
                return None
            path = self._run_file(selected_run_id)
            if not path.exists():
                if requested_run_id:
                    raise FileNotFoundError(f"run 不存在: {selected_run_id}")
                return None
            run = self._load_run_unlocked(selected_run_id, selected_run_id)

        if not self._is_managed_production_run(run):
            if requested_run_id:
                raise ValueError("下游生产写入必须绑定具有已选平台契约的 runtime run")
            return None
        run_slug = self.normalize_slug(str(run.get("slug") or selected_run_id))
        if run_slug != slug:
            raise ValueError("下游生产写入的 slug 必须与当前 runtime run 一致")
        return selected_run_id

    def _load_run_unlocked(self, run_id: str, slug: str) -> dict[str, Any]:
        path = self._run_file(run_id)
        if not path.exists():
            now = datetime.now().isoformat()
            return {
                "run_id": self.normalize_slug(run_id),
                "slug": self.normalize_slug(slug),
                "project": str(self.project),
                "project_id": "default",
                "status": "active",
                "topic": "",
                "created_at": now,
                "updated_at": now,
                "schema": PRODUCTION_RUN_SCHEMA,
                "target_platforms": [],
                "selected_platforms": [],
                "platform_selection": {"status": "provisional", "locked_at": None},
                "shared_brief": {
                    "status": "pending",
                    "artifact_path": "",
                    "sha256": "",
                    "approved_at": None,
                },
                "platform_lanes": {},
                "visual_preferences": dict(DEFAULT_VISUAL_PREFERENCES),
                "current_step": None,
                "steps": {},
                "approvals": {},
                "phase_artifacts": {},
                "history": [],
            }
        data = json.loads(path.read_text(encoding="utf-8"))
        data.setdefault("run_id", self.normalize_slug(run_id))
        data.setdefault("slug", self.normalize_slug(slug))
        data.setdefault("project", str(self.project))
        # Old local runs predate project-scoped advisor adoption.  They remain
        # readable, but are explicitly tagged as the default local project
        # rather than silently borrowing another project's advisor archive.
        data.setdefault("project_id", "default")
        data["project_id"] = normalize_project_id(data.get("project_id"))
        data.setdefault("status", "active")
        data.setdefault("topic", "")
        data.setdefault("schema", LEGACY_PRODUCTION_RUN_SCHEMA)
        data.setdefault("target_platforms", [])
        data.setdefault("selected_platforms", list(data.get("target_platforms") or []))
        selected_platforms = [
            str(item) for item in data.get("selected_platforms", [])
            if str(item) in LEGACY_PRODUCTION_PLATFORMS
        ]
        data["selected_platforms"] = selected_platforms
        data.setdefault("platform_selection", {
            "status": "legacy_locked" if data.get("schema") == LEGACY_PRODUCTION_RUN_SCHEMA else "provisional",
            "locked_at": data.get("created_at") if data.get("schema") == LEGACY_PRODUCTION_RUN_SCHEMA else None,
        })
        data.setdefault("shared_brief", {
            "status": "legacy" if data.get("schema") == LEGACY_PRODUCTION_RUN_SCHEMA else "pending",
            "artifact_path": self._current_intake_path(data),
            "sha256": "",
            "approved_at": None,
        })
        existing_lanes = data.get("platform_lanes") if isinstance(data.get("platform_lanes"), dict) else {}
        data["platform_lanes"] = {
            platform: existing_lanes.get(platform) if isinstance(existing_lanes.get(platform), dict) else _new_platform_lane(platform)
            for platform in selected_platforms
        }
        visual_preferences = data.get("visual_preferences") if isinstance(data.get("visual_preferences"), dict) else {}
        data["visual_preferences"] = {
            "mode": visual_preferences.get("mode") if visual_preferences.get("mode") in VISUAL_MODES else DEFAULT_VISUAL_PREFERENCES["mode"],
            "direction_count": 2,
            "provider_policy": "auto",
        }
        try:
            data["visual_template"] = normalize_visual_template(data.get("visual_template"))
        except ValueError:
            data["visual_template"] = DEFAULT_VISUAL_LAYOUT_THEME
        data.setdefault("success_criteria", {
            "business_goal": "",
            "success_metric": "",
            "baseline": None,
            "target": None,
        })
        data.setdefault("steps", {})
        data.setdefault("approvals", {})
        data.setdefault("phase_artifacts", {})
        data.setdefault("history", [])
        return data

    def _save_run_unlocked(self, run: dict[str, Any]) -> None:
        self.runs.mkdir(parents=True, exist_ok=True)
        run["updated_at"] = datetime.now().isoformat()
        path = self._run_file(run["run_id"])
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(run, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    def _frozen_market_snapshot_path(self, run_id: str) -> Path:
        """Return the one mutable pointer to otherwise immutable research evidence."""
        return self.runs / self.normalize_slug(run_id) / "market-research" / "frozen-snapshot.json"

    @staticmethod
    def _current_intake_path(run: dict[str, Any]) -> str:
        steps = run.get("steps") if isinstance(run.get("steps"), dict) else {}
        intake = steps.get("intake") if isinstance(steps.get("intake"), dict) else {}
        return str(intake.get("latest") or "").replace("\\", "/").strip()

    def _assert_snapshot_matches_current_intake(
        self,
        run: dict[str, Any],
        verification: dict[str, Any],
    ) -> None:
        """Reject a valid historical snapshot when its intake is no longer current."""
        current_intake = self._current_intake_path(run)
        source_path = str(verification.get("source_path") or "").replace("\\", "/").strip()
        if not current_intake:
            raise ValueError("当前 run 缺少最新 intake 素材，不能使用 TikOmni 研究快照")
        if source_path != current_intake:
            raise ValueError("TikOmni 研究快照未绑定当前 run 的最新 intake 素材，请重新执行实时研究")

    def _invalidate_replaced_intake(
        self,
        run: dict[str, Any],
        previous_intake: str,
        current_intake: str,
        created_at: datetime,
    ) -> None:
        """Clear current production state when a run receives a new material analysis.

        Historical files and snapshot directories remain available for audit, but
        no longer have a current pointer that can drive this run.
        """
        steps = run.setdefault("steps", {})
        removed_steps = [name for name in steps if name != "intake"]
        for name in removed_steps:
            steps.pop(name, None)

        phase_artifacts = run.setdefault("phase_artifacts", {})
        removed_phase_artifacts = sorted(phase_artifacts)
        phase_artifacts.clear()

        had_topic_selection = isinstance(run.get("topic_selection"), dict)
        run.pop("topic_selection", None)
        run["topic"] = ""

        timestamp = created_at.isoformat()
        self._invalidate_scope_approvals(run, "topic_template", "intake_changed", timestamp)
        # Legacy local runs can still expose the historical blueprint alias.
        # Keep that record auditable but make it unusable with the canonical
        # topic approval after a new material revision.
        legacy_blueprint = (run.get("approvals") or {}).get("blueprint")
        if isinstance(legacy_blueprint, dict) and not legacy_blueprint.get("invalidated_at"):
            legacy_blueprint["invalidated_at"] = timestamp
            legacy_blueprint["invalidation_reason"] = "intake_changed"

        frozen_snapshot = self._frozen_market_snapshot_path(str(run.get("run_id") or ""))
        frozen_snapshot_cleared = False
        try:
            frozen_snapshot.unlink()
            frozen_snapshot_cleared = True
        except FileNotFoundError:
            pass
        except OSError as exc:
            raise ValueError("无法撤销旧 TikOmni 冻结快照，当前 intake 不能安全替换") from exc

        run.setdefault("history", []).append({
            "event": "intake_replaced",
            "previous_intake": previous_intake,
            "current_intake": current_intake,
            "topic_selection_cleared": had_topic_selection,
            "invalidated_steps": removed_steps,
            "cleared_phase_artifacts": removed_phase_artifacts,
            "frozen_market_snapshot_cleared": frozen_snapshot_cleared,
            "created_at": timestamp,
            "source": "runtime",
        })

    def _update_run(
        self,
        run_id: str,
        slug: str,
        step: str,
        rel_path: str,
        source: str | None,
        created_at: datetime,
    ) -> dict[str, Any]:
        """更新 runs/{run_id}.json，把一条内容的全流程串起来。"""
        safe_run_id = self.normalize_slug(run_id)
        safe_slug = self.normalize_slug(slug)
        with self._state_lock():
            run = self._load_run_unlocked(safe_run_id, safe_slug)
            previous_intake = self._current_intake_path(run) if step == "intake" else ""
            intake_replaced = bool(previous_intake and previous_intake != rel_path)
            if run.get("status") == "archived":
                run["status"] = "active"
                run["reopened_at"] = created_at.isoformat()
            run["current_step"] = step
            run["steps"][step] = {
                "latest": rel_path,
                "updated_at": created_at.isoformat(),
                "source": source or "manual",
            }
            if intake_replaced:
                self._invalidate_replaced_intake(run, previous_intake, rel_path, created_at)
            scope = STEP_APPROVAL_SCOPES.get(step)
            if scope:
                reason = "template_changed" if scope == "topic_template" else "content_changed"
                self._invalidate_scope_approvals(run, scope, reason, created_at.isoformat())
                # A new runtime-owned Markdown record supersedes any older
                # local phase manifest for the same scope.
                run.setdefault("phase_artifacts", {}).pop(scope, None)
                # Keep legacy blueprint metadata from older local projects
                # visibly invalidated while the canonical approval lives under
                # topic_template.
                if step == "blueprint":
                    approval = (run.get("approvals") or {}).get("blueprint")
                    if isinstance(approval, dict) and not approval.get("invalidated_at"):
                        approval["invalidated_at"] = created_at.isoformat()
                        approval["invalidation_reason"] = reason
            run["history"].append({
                "step": step,
                "path": rel_path,
                "created_at": created_at.isoformat(),
                "source": source or "manual",
            })
            self._save_run_unlocked(run)
            return run

    def _unique_run_id_unlocked(self, base: str) -> str:
        safe_base = self.normalize_slug(base)
        candidate = safe_base
        counter = 2
        while self._run_file(candidate).exists():
            candidate = f"{safe_base}-{counter:02d}"
            counter += 1
        return candidate

    def _unique_run_slug_unlocked(self, base: str) -> str:
        """Return a project-unique slug so slug-keyed artifacts cannot collide.

        ``run_id`` has always been unique, but publication, visual, and package
        paths intentionally use the human-readable slug.  Allowing two runs to
        share it would let the newer run overwrite the older run's artifacts
        even though the JSON run records remained separate.
        """
        safe_base = self.normalize_slug(base)
        occupied: set[str] = set()
        if self.runs.exists():
            for run_file in self.runs.glob("*.json"):
                try:
                    value = json.loads(run_file.read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ValueError(f"run 状态文件不可读取，无法安全分配 slug: {run_file.name}") from exc
                if not isinstance(value, dict):
                    raise ValueError(f"run 状态文件格式无效，无法安全分配 slug: {run_file.name}")
                occupied.add(self.normalize_slug(str(value.get("slug") or run_file.stem)))
        candidate = safe_base
        counter = 2
        while candidate in occupied:
            candidate = f"{safe_base}-{counter:02d}"
            counter += 1
        return candidate

    def create_run(
        self,
        topic: str = "",
        platforms: str | list[str] | None = None,
        slug: str | None = None,
        run_id: str | None = None,
        source: str = "manual",
        business_goal: str = "",
        success_metric: str = "",
        baseline: Any = None,
        target: Any = None,
        visual_template: str = DEFAULT_VISUAL_LAYOUT_THEME,
        project_id: str = "default",
    ) -> dict[str, Any]:
        """显式创建一条内容 run，并设为当前激活 run。"""
        now = datetime.now()
        requested_slug = self.normalize_slug(slug or topic or f"run-{now.strftime('%Y%m%d-%H%M%S')}")
        requested_platforms = self.normalize_platforms(platforms)
        target_platforms = requested_platforms or list(SUPPORTED_PLATFORMS)
        unsupported_platforms = [platform for platform in target_platforms if platform not in SUPPORTED_PLATFORMS]
        if unsupported_platforms:
            raise ValueError("新任务仅支持公众号、小红书和视频号；请移除抖音或朋友圈")
        selected_visual_template = normalize_visual_template(visual_template)
        selected_project_id = normalize_project_id(project_id)
        with self._state_lock():
            selected_run_id = self._unique_run_id_unlocked(run_id or requested_slug)
            selected_slug = self._unique_run_slug_unlocked(requested_slug)
            run = {
                "schema": PRODUCTION_RUN_SCHEMA,
                "run_id": selected_run_id,
                "slug": selected_slug,
                "project": str(self.project),
                "project_id": selected_project_id,
                "status": "active",
                "topic": topic.strip(),
                "target_platforms": target_platforms,
                "selected_platforms": target_platforms,
                "platform_selection": {
                    "status": "provisional",
                    "locked_at": None,
                },
                "shared_brief": {
                    "status": "pending",
                    "artifact_path": "",
                    "sha256": "",
                    "approved_at": None,
                },
                "platform_lanes": _new_platform_lanes(target_platforms),
                "visual_preferences": dict(DEFAULT_VISUAL_PREFERENCES),
                "visual_template": selected_visual_template,
                "success_criteria": {
                    "business_goal": str(business_goal or "").strip(),
                    "success_metric": str(success_metric or "").strip(),
                    "baseline": normalize_success_criterion(baseline),
                    "target": normalize_success_criterion(target),
                },
                "current_step": None,
                "created_at": now.isoformat(),
                "updated_at": now.isoformat(),
                "steps": {},
                "approvals": {},
                "phase_artifacts": {},
                "history": [{
                    "event": "created",
                    "created_at": now.isoformat(),
                    "source": source,
                }],
            }
            self._save_run_unlocked(run)
            state = self._load_state_unlocked()
            state.active_run_id = selected_run_id
            state.current_slug = selected_slug
            state.current_step = None
            self._save_state_unlocked(state)
        return {
            "status": "created",
            "run_id": selected_run_id,
            "slug": selected_slug,
            "topic": topic.strip(),
            "project_id": selected_project_id,
            "target_platforms": target_platforms,
            "selected_platforms": target_platforms,
            "platform_selection": run["platform_selection"],
            "shared_brief": run["shared_brief"],
            "platform_lanes": run["platform_lanes"],
            "visual_preferences": run["visual_preferences"],
            "visual_template": selected_visual_template,
            "success_criteria": run["success_criteria"],
            "run_file": str(self._run_file(selected_run_id)),
        }

    def set_platforms(
        self,
        run_id: str,
        platforms: str | list[str],
        *,
        confirm: bool = False,
    ) -> dict[str, Any]:
        """Choose platform-native lanes before topic research is frozen."""
        selected_run_id = self.normalize_slug(run_id)
        selected_platforms = self.normalize_platforms(platforms)
        if not selected_platforms:
            raise ValueError("请至少选择公众号、小红书或视频号中的一个平台")
        unsupported = [platform for platform in selected_platforms if platform not in SUPPORTED_PLATFORMS]
        if unsupported:
            raise ValueError("新任务仅支持公众号、小红书和视频号")

        with self._state_lock():
            if not self._run_file(selected_run_id).exists():
                raise FileNotFoundError(f"run 不存在: {selected_run_id}")
            run = self._load_run_unlocked(selected_run_id, selected_run_id)
            if run.get("schema") != PRODUCTION_RUN_SCHEMA:
                raise ValueError("旧版任务的平台合同保持只读，请新建任务后选择平台")
            selection = run.get("platform_selection") if isinstance(run.get("platform_selection"), dict) else {}
            if selection.get("status") == "locked" or (run.get("approvals") or {}).get("topic_template"):
                raise ValueError("平台已随本期研究结果锁定；如需更换平台，请新建任务")

            previous = list(run.get("selected_platforms") or run.get("target_platforms") or [])
            existing_lanes = run.get("platform_lanes") if isinstance(run.get("platform_lanes"), dict) else {}
            changed = previous != selected_platforms
            run["selected_platforms"] = selected_platforms
            run["target_platforms"] = selected_platforms
            run["platform_lanes"] = {
                platform: existing_lanes.get(platform) if isinstance(existing_lanes.get(platform), dict) else _new_platform_lane(platform)
                for platform in selected_platforms
            }
            run["platform_selection"] = {
                "status": "confirmed" if confirm else "provisional",
                "locked_at": None,
            }
            if changed:
                now = datetime.now().isoformat()
                self._invalidate_scope_approvals(run, "topic_template", "platform_selection_changed", now)
                run.setdefault("history", []).append({
                    "event": "platforms_selected",
                    "platforms": selected_platforms,
                    "confirmed": bool(confirm),
                    "created_at": now,
                })
            self._save_run_unlocked(run)
        return {
            "changed": changed,
            "run_id": selected_run_id,
            "selected_platforms": selected_platforms,
            "target_platforms": selected_platforms,
            "platform_selection": run["platform_selection"],
            "platform_lanes": run["platform_lanes"],
        }

    def set_visual_template(self, run_id: str, visual_template: str) -> dict[str, Any]:
        """Persist one immutable-at-approval brand/layout choice for a run."""
        selected_run_id = self.normalize_slug(run_id)
        selected_template = normalize_visual_template(visual_template)
        with self._state_lock():
            if not self._run_file(selected_run_id).exists():
                raise FileNotFoundError(f"run 不存在: {selected_run_id}")
            run = self._load_run_unlocked(selected_run_id, selected_run_id)
            previous = str(run.get("visual_template") or DEFAULT_VISUAL_LAYOUT_THEME)
            if previous != selected_template:
                now = datetime.now().isoformat()
                run["visual_template"] = selected_template
                self._invalidate_scope_approvals(run, "topic_template", "template_changed", now)
                run.setdefault("history", []).append({
                    "event": "visual_template_selected",
                    "visual_template": selected_template,
                    "created_at": now,
                    "source": "human_review",
                })
                self._save_run_unlocked(run)
            return {
                "status": "selected",
                "run_id": selected_run_id,
                "slug": run.get("slug") or "",
                "visual_template": selected_template,
                "changed": previous != selected_template,
            }

    def set_topic(
        self,
        run_id: str,
        topic: str,
        snapshot_path: str,
        snapshot_sha256: str,
        suggestion_id: str = "",
    ) -> dict[str, Any]:
        """Persist a human-selected topic without creating or renaming a run.

        The selected topic is deliberately bound to the exact verified TikOmni
        snapshot that produced the topic suggestions. A later topic edit may
        invalidate an earlier topic/template approval, but it never changes the
        run ID or slug and never replaces the immutable market snapshot.
        """
        selected_run_id = self.normalize_slug(run_id)
        selected_topic = re.sub(r"\s+", " ", str(topic or "")).strip()
        if not selected_topic or len(selected_topic) > 240:
            raise ValueError("主题不能为空且不能超过 240 个字符")
        supplied_snapshot = str(snapshot_path or "").replace("\\", "/").strip()
        supplied_digest = str(snapshot_sha256 or "").lower().strip()
        if not supplied_snapshot.startswith(f"runs/{selected_run_id}/market-research/") or not supplied_snapshot.endswith("/snapshot.json"):
            raise ValueError("主题必须绑定当前 run 的 TikOmni 研究快照")
        if not re.fullmatch(r"[a-f0-9]{64}", supplied_digest):
            raise ValueError("主题绑定的 TikOmni 快照 SHA-256 不合法")
        normalized_suggestion = str(suggestion_id or "").strip()
        if normalized_suggestion and not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", normalized_suggestion):
            raise ValueError("主题建议标识不合法")

        from market_signal import verify_frozen_market_snapshot, verify_market_snapshot

        verification = verify_market_snapshot(self.project, selected_run_id, supplied_snapshot)
        if not verification.get("verified"):
            raise ValueError(f"TikOmni 研究快照未通过完整性校验：{verification.get('reason') or '未知错误'}")
        verified_path = str(verification.get("manifest_path") or "")
        verified_digest = str(verification.get("snapshot_sha256") or "").lower()
        if verified_path != supplied_snapshot or verified_digest != supplied_digest:
            raise ValueError("主题绑定的 TikOmni 快照或 SHA-256 与当前存档不一致")

        with self._state_lock():
            if not self._run_file(selected_run_id).exists():
                raise FileNotFoundError(f"run 不存在: {selected_run_id}")
            run = self._load_run_unlocked(selected_run_id, selected_run_id)
            if run.get("status") == "archived":
                raise ValueError("当前 run 已归档，不能修改主题")
            self._assert_snapshot_matches_current_intake(run, verification)

            # An already frozen run may only keep selecting topics against its
            # own frozen evidence. This avoids silently switching an approved
            # production path to a later TikOmni fetch.
            frozen = verify_frozen_market_snapshot(self.project, selected_run_id)
            if frozen.get("verified") and (
                frozen.get("manifest_path") != verified_path
                or str(frozen.get("snapshot_sha256") or "").lower() != verified_digest
            ):
                raise ValueError("当前 run 已冻结其他 TikOmni 研究快照，不能跨快照修改主题")

            previous_topic = str(run.get("topic") or "")
            previous_selection = run.get("topic_selection") if isinstance(run.get("topic_selection"), dict) else {}
            unchanged = (
                run.get("research_mode") != author_evidence.MODE
                and previous_topic == selected_topic
                and previous_selection.get("market_snapshot_path") == verified_path
                and str(previous_selection.get("market_snapshot_sha256") or "").lower() == verified_digest
                and str(previous_selection.get("suggestion_id") or "") == normalized_suggestion
            )
            now = datetime.now().isoformat()
            if not unchanged:
                run["research_mode"] = "platform"
                run.pop("author_evidence", None)
                run["topic"] = selected_topic
                run["topic_selection"] = {
                    "topic": selected_topic,
                    "market_snapshot_path": verified_path,
                    "market_snapshot_sha256": verified_digest,
                    "selected_at": now,
                    "method": "human_topic_selection",
                    **({"suggestion_id": normalized_suggestion} if normalized_suggestion else {}),
                }
                # A prior blueprint was written for a different topic decision.
                # Keep it readable, but force a fresh review before any
                # downstream production can continue.
                self._invalidate_scope_approvals(run, "topic_template", "content_changed", now)
                run.setdefault("history", []).append({
                    "event": "topic_selected",
                    "topic": selected_topic,
                    "market_snapshot_path": verified_path,
                    "market_snapshot_sha256": verified_digest,
                    **({"suggestion_id": normalized_suggestion} if normalized_suggestion else {}),
                    "created_at": now,
                    "source": "human_review",
                })
                self._save_run_unlocked(run)
            return {
                "status": "selected",
                "run_id": selected_run_id,
                "slug": run.get("slug") or "",
                "topic": selected_topic,
                "changed": not unchanged,
                "market_snapshot_path": verified_path,
                "market_snapshot_sha256": verified_digest,
                **({"suggestion_id": normalized_suggestion} if normalized_suggestion else {}),
            }

    def author_source_context(self, run_id: str) -> dict[str, Any]:
        """Read the revisions required for an explicit author-source choice."""
        selected = self.normalize_slug(run_id)
        with self._state_lock():
            if not self._run_file(selected).exists():
                raise FileNotFoundError("本期内容不存在")
            return author_evidence.source_context(self.project, self._load_run_unlocked(selected, selected))

    def select_author_source(self, request: dict[str, Any]) -> dict[str, Any]:
        """Commit a local source choice, never a fabricated research success."""
        selected = self.normalize_slug(str(request.get("run_id") or ""))
        target = author_evidence.record_path(self.project, selected, request.get("id", ""))
        topic = re.sub(r"\s+", " ", str(request.get("topic") or "")).strip()
        if not topic or len(topic) > 240:
            raise ValueError("请填写不超过 240 字的题目")
        expected = {key: request.get(key) for key in (
            "intake_path", "intake_sha256", "material_sha256", "source_revision",
        )}
        if any(not isinstance(value, str) or not value for value in expected.values()):
            raise ValueError("请先读取并核对本期素材版本")
        with self._state_lock():
            if not self._run_file(selected).exists():
                raise FileNotFoundError("本期内容不存在")
            run = self._load_run_unlocked(selected, selected)
            # Recover response loss without creating another source record or
            # invalidating a newer choice. Reused IDs cannot carry new content.
            if target.exists():
                previous = json.loads(target.read_bytes())
                if previous.get("request") != {**expected, "topic": topic}:
                    raise ValueError("该操作编号已用于另一份素材选择")
                if (run.get("author_evidence") or {}).get("id") == request["id"]:
                    return {**author_evidence.verified_record(self.project, run), "changed": False,
                            "slug": run["slug"]}
                if any(event.get("author_evidence_id") == request["id"] for event in run.get("history", [])):
                    raise ValueError("这次选择已被后续修改替代，请重新读取")
            current = author_evidence.source_context(self.project, run)
            if any(current[key] != value for key, value in expected.items()):
                raise ValueError("素材或写作选择已经变化，请重新读取后确认")
            record = {
                "schema": author_evidence.SCHEMA,
                "id": request["id"],
                **current,
                "topic": topic,
                "request": {**expected, "topic": topic},
                "created_at": datetime.now().isoformat(),
            }
            # An orphan from an interrupted commit is recoverable only if its
            # immutable source still matches the author's displayed revision.
            if target.exists():
                record = previous
                if any(record.get(key) != current[key] for key in (
                    "intake_path", "intake_sha256", "material_sha256", "target_platforms",
                )):
                    raise ValueError("上次未完成的素材选择已经过期")
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                temporary = target.with_name(f".{uuid.uuid4().hex}.tmp")
                try:
                    temporary.write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
                    temporary.chmod(0o600)
                    temporary.replace(target)
                finally:
                    temporary.unlink(missing_ok=True)
            now = datetime.now().isoformat()
            run["research_mode"] = author_evidence.MODE
            run["topic"] = topic
            run["author_evidence"] = {
                "id": request["id"], "path": target.relative_to(self.project).as_posix(),
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            }
            run.pop("topic_selection", None)
            self._invalidate_scope_approvals(run, "topic_template", "writing_source_changed", now)
            legacy = (run.get("approvals") or {}).get("blueprint")
            if isinstance(legacy, dict):
                legacy.update(invalidated_at=now, invalidation_reason="writing_source_changed")
            verified = author_evidence.verified_record(self.project, run)
            run.setdefault("history", []).append({
                "event": "author_source_selected", "author_evidence_id": request["id"],
                "topic": topic, "created_at": now, "source": "human_review",
            })
            self._save_run_unlocked(run)
            return {**verified, "changed": True, "slug": run["slug"]}

    def verify_author_source(self, run_id: str, file: str | None = None) -> dict[str, Any]:
        selected = self.normalize_slug(run_id)
        with self._state_lock():
            if not self._run_file(selected).exists():
                raise FileNotFoundError("本期内容不存在")
            run = self._load_run_unlocked(selected, selected)
            body = None
            if file:
                if file != ((run.get("steps") or {}).get("blueprint") or {}).get("latest"):
                    raise ValueError("只能核对本期最新写作方案")
                body = author_evidence.local_file(self.project, file).read_text(encoding="utf-8")
            return author_evidence.verified_record(self.project, run, body)

    def switch_run(self, run_id: str) -> dict[str, Any]:
        """切换当前激活 run。"""
        safe_run_id = self.normalize_slug(run_id)
        with self._state_lock():
            path = self._run_file(safe_run_id)
            if not path.exists():
                raise FileNotFoundError(f"run 不存在: {safe_run_id}")
            run = json.loads(path.read_text(encoding="utf-8"))
            state = self._load_state_unlocked()
            state.active_run_id = safe_run_id
            state.current_slug = run.get("slug")
            state.current_step = run.get("current_step")
            self._save_state_unlocked(state)
        return {
            "status": "switched",
            "run_id": safe_run_id,
            "slug": run.get("slug"),
            "current_step": run.get("current_step"),
            "run_file": str(path),
        }

    def set_visual_preferences(
        self,
        run_id: str,
        mode: str = "stable",
        direction_count: int = 2,
        provider_policy: str = "auto",
    ) -> dict[str, Any]:
        """Persist the run-level visual generation contract.

        Direction count and provider policy are intentionally fixed in v2 so
        the desktop UI cannot create an unsupported or unexpectedly expensive
        rendering path.
        """
        selected_run_id = self.normalize_slug(run_id)
        if mode not in VISUAL_MODES:
            raise ValueError("当前只支持平台排版")
        if direction_count != 2:
            raise ValueError("当前视觉流程固定生成两套方向预览")
        if provider_policy not in VISUAL_PROVIDER_POLICIES:
            raise ValueError("当前视觉服务仅支持 auto 自动路由")
        with self._state_lock():
            if not self._run_file(selected_run_id).exists():
                raise FileNotFoundError(f"run 不存在: {selected_run_id}")
            run = self._load_run_unlocked(selected_run_id, selected_run_id)
            if run.get("schema") != PRODUCTION_RUN_SCHEMA:
                raise ValueError("旧版任务的视觉设置保持只读，请新建任务后再选择")
            previous = dict(run.get("visual_preferences") or DEFAULT_VISUAL_PREFERENCES)
            preferences = {
                "mode": mode,
                "direction_count": 2,
                "provider_policy": "auto",
            }
            changed = previous != preferences
            run["visual_preferences"] = preferences
            if changed:
                now = datetime.now().isoformat()
                self._invalidate_scope_approvals(run, "visual_assets", "visual_preferences_changed", now)
                run.setdefault("history", []).append({
                    "event": "visual_preferences_selected",
                    "visual_preferences": preferences,
                    "created_at": now,
                })
            self._save_run_unlocked(run)
        return {
            "changed": changed,
            "run_id": selected_run_id,
            "visual_preferences": preferences,
        }

    def resume_run(self, run_id: str | None = None) -> dict[str, Any]:
        """恢复指定 run；未指定时恢复当前激活 run 或最近的未归档 run。"""
        with self._state_lock():
            state = self._load_state_unlocked()
            selected = self.normalize_slug(run_id) if run_id else state.active_run_id
            if not selected:
                candidates = []
                for path in sorted(self.runs.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True):
                    try:
                        data = json.loads(path.read_text(encoding="utf-8"))
                    except Exception:
                        continue
                    if data.get("status") != "archived":
                        candidates.append(data.get("run_id", path.stem))
                selected = candidates[0] if candidates else None
            if not selected:
                raise FileNotFoundError("没有可恢复的 run，请先创建 run。")
            path = self._run_file(selected)
            if not path.exists():
                raise FileNotFoundError(f"run 不存在: {selected}")
            run = json.loads(path.read_text(encoding="utf-8"))
            now = datetime.now().isoformat()
            if run.get("status") == "archived":
                run["status"] = "active"
                run["resumed_at"] = now
            run.setdefault("history", []).append({
                "event": "resumed",
                "created_at": now,
                "source": "runtime",
            })
            self._save_run_unlocked(run)
            state.active_run_id = selected
            state.current_slug = run.get("slug")
            state.current_step = run.get("current_step")
            self._save_state_unlocked(state)
        return {
            "status": "resumed",
            "run_id": selected,
            "slug": run.get("slug"),
            "current_step": run.get("current_step"),
            "run_file": str(path),
        }

    def archive_run(self, run_id: str | None = None) -> dict[str, Any]:
        """归档 run；未指定时归档当前激活 run。"""
        with self._state_lock():
            state = self._load_state_unlocked()
            selected = self.normalize_slug(run_id) if run_id else state.active_run_id
            if not selected:
                raise FileNotFoundError("没有当前 run 可归档。")
            path = self._run_file(selected)
            if not path.exists():
                raise FileNotFoundError(f"run 不存在: {selected}")
            run = json.loads(path.read_text(encoding="utf-8"))
            now = datetime.now().isoformat()
            run["status"] = "archived"
            run["archived_at"] = now
            run.setdefault("history", []).append({
                "event": "archived",
                "created_at": now,
                "source": "runtime",
            })
            self._save_run_unlocked(run)
            if state.active_run_id == selected:
                state.active_run_id = None
            self._save_state_unlocked(state)
        return {
            "status": "archived",
            "run_id": selected,
            "slug": run.get("slug"),
            "project_id": normalize_project_id(run.get("project_id")),
            "run_file": str(path),
        }

    @staticmethod
    def normalize_slug(slug: str) -> str:
        """将 slug 规范成安全文件名片段，避免路径分隔符写入文件名。"""
        safe = re.sub(r"[^0-9A-Za-z._\-\u4e00-\u9fff]+", "-", slug.strip())
        safe = safe.strip(".-")
        return safe or "untitled"

    @staticmethod
    def _is_relative_to(path: Path, base: Path) -> bool:
        try:
            path.relative_to(base)
            return True
        except ValueError:
            return False

    def _project_path(self, value: str | Path, *, must_exist: bool = False) -> Path:
        """解析 project 内路径，并拒绝绝对路径/.. 逃逸。"""
        raw = Path(value).expanduser()
        candidate = raw if raw.is_absolute() else self.project / raw
        resolved = candidate.resolve(strict=False)
        root = self.project.resolve(strict=False)
        if not self._is_relative_to(resolved, root):
            raise ValueError(f"路径越界: {value} 不在项目目录 {root} 内")
        if must_exist and not resolved.exists():
            raise FileNotFoundError(f"文件不存在: {resolved}")
        return resolved

    def _brain_path(self, value: str | Path, *, must_exist: bool = False) -> Path:
        """解析 brain 内路径，并拒绝绝对路径/.. 逃逸。"""
        raw = Path(value).expanduser()
        candidate = raw if raw.is_absolute() else self.brain_dir / raw
        resolved = candidate.resolve(strict=False)
        root = self.brain_dir.resolve(strict=False)
        if not self._is_relative_to(resolved, root):
            raise ValueError(f"路径越界: {value} 不在 brain 目录 {root} 内")
        if must_exist and not resolved.exists():
            raise FileNotFoundError(f"文件不存在: {resolved}")
        return resolved

    @staticmethod
    def _frontmatter_value(value: str | None) -> str:
        return str(value or "").replace("\n", " ").strip()

    def _material_index_path(self) -> Path:
        return self.brain_dir / "material-index.json"

    @staticmethod
    def _empty_material_index() -> dict[str, Any]:
        return {
            "schema": MATERIAL_INDEX_SCHEMA,
            "updated_at": datetime.now().isoformat(),
            "items": {},
        }

    def _load_material_index(self) -> dict[str, Any]:
        path = self._material_index_path()
        if not path.exists():
            return self._empty_material_index()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return self._empty_material_index()
        if data.get("schema") != MATERIAL_INDEX_SCHEMA:
            data["schema"] = MATERIAL_INDEX_SCHEMA
        if not isinstance(data.get("items"), dict):
            data["items"] = {}
        return data

    def _save_material_index(self, index: dict[str, Any]) -> str:
        self.brain_dir.mkdir(parents=True, exist_ok=True)
        index["schema"] = MATERIAL_INDEX_SCHEMA
        index["updated_at"] = datetime.now().isoformat()
        path = self._material_index_path()
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)
        return str(path)

    @staticmethod
    def _markdown_section(body: str, heading_pattern: str) -> str:
        match = re.search(rf"(?ms){heading_pattern}(.*?)(?=^##\s+|\Z)", body or "")
        return match.group(1).strip() if match else ""

    @staticmethod
    def _markdown_line_value(section: str, label_pattern: str) -> str:
        match = re.search(rf"(?m)^\s*[-*]\s*(?:\*\*)?(?:{label_pattern})(?:\*\*)?\s*[：:]\s*(.+?)\s*$", section or "")
        return match.group(1).strip() if match else ""

    @staticmethod
    def _compact_markdown(text: str, max_chars: int = MATERIAL_SUMMARY_MAX_CHARS) -> str:
        compact = re.sub(r"(?m)^#{1,6}\s*", "", text or "")
        compact = re.sub(r"(?m)^\s*[-*]\s*", "", compact)
        compact = re.sub(r"`([^`]+)`", r"\1", compact)
        compact = re.sub(r"\*\*(.*?)\*\*", r"\1", compact)
        compact = re.sub(r"\s+", " ", compact).strip()
        return compact[:max_chars].rstrip()

    def _build_material_index_item(
        self,
        slug: str,
        rel_path: str,
        body: str,
        frontmatter: dict[str, str],
        created_at: datetime | None = None,
    ) -> dict[str, Any]:
        scenario = self._markdown_section(body, r"^##\s*0\.\s+素材场景")
        viewpoint = self._markdown_section(body, r"^##\s*3\.\s+观点")
        quality = self._markdown_section(body, r"^##\s*9\.\s+素材质量判断")
        title_match = re.search(r"(?m)^#\s+(.+?)\s*$", body or "")
        title = title_match.group(1).strip() if title_match else ""
        main_scenario = self._markdown_line_value(scenario, r"主场景")
        source = self._markdown_line_value(scenario, r"素材来源")
        fact_boundary = self._markdown_line_value(scenario, r"事实边界")
        key_gaps = self._markdown_line_value(quality, r"当前缺口|缺口")
        downstream_usability = self._markdown_line_value(quality, r"下游可用性")
        viewpoint_lines = [
            re.sub(r"^\s*[-*]\s*", "", line).strip()
            for line in viewpoint.splitlines()
            if re.match(r"^\s*[-*]\s+", line) and "证据位置" not in line
        ]
        summary_source = "；".join(
            item for item in [
                main_scenario,
                viewpoint_lines[0] if viewpoint_lines else "",
                f"缺口：{key_gaps}" if key_gaps else "",
                f"下游：{downstream_usability}" if downstream_usability else "",
            ]
            if item
        )
        if not summary_source:
            summary_source = body
        return {
            "slug": slug,
            "step": "intake",
            "title": title,
            "latest_intake": rel_path,
            "summary": self._compact_markdown(summary_source),
            "summary_max_chars": MATERIAL_SUMMARY_MAX_CHARS,
            "main_scenario": main_scenario,
            "source": source,
            "fact_boundary": fact_boundary,
            "key_gaps": key_gaps,
            "downstream_usability": downstream_usability,
            "body_chars": len(body),
            "created_at": frontmatter.get("created_at") or (created_at.isoformat() if created_at else ""),
            "updated_at": (created_at or datetime.now()).isoformat(),
        }

    def _update_material_index(
        self,
        slug: str,
        rel_path: str,
        body: str,
        frontmatter: dict[str, str],
        created_at: datetime,
    ) -> str:
        with self._state_lock():
            index = self._load_material_index()
            item = self._build_material_index_item(slug, rel_path, body, frontmatter, created_at)
            index.setdefault("items", {})[slug] = item
            return self._save_material_index(index)

    def _material_index_item_for_path(self, rel_path: str) -> dict[str, Any] | None:
        index = self._load_material_index()
        for item in (index.get("items") or {}).values():
            if item.get("latest_intake") == rel_path:
                return item
        return None

    def _summary_payload(self, step: str, target: Path, frontmatter: dict[str, str], body: str) -> dict[str, Any]:
        try:
            rel_path = str(target.relative_to(self.project))
        except ValueError:
            rel_path = str(target)
        if step == "intake":
            summary = self._material_index_item_for_path(rel_path)
            if not summary:
                summary = self._build_material_index_item(frontmatter.get("slug") or target.stem, rel_path, body, frontmatter)
        else:
            title_match = re.search(r"(?m)^#\s+(.+?)\s*$", body or "")
            summary = {
                "step": step,
                "title": title_match.group(1).strip() if title_match else "",
                "latest_file": rel_path,
                "summary": self._compact_markdown(body),
                "summary_max_chars": MATERIAL_SUMMARY_MAX_CHARS,
                "body_chars": len(body),
            }
        return {
            "path": str(target),
            "frontmatter": frontmatter,
            "summary": summary,
            "body_omitted": True,
            "full_report_path": rel_path,
        }

    def write(
        self,
        step: str,
        slug: str,
        content: str,
        source: str | None = None,
        run_id: str | None = None,
        unbound_report: bool = False,
        expected_path: str | None = None,
        expected_sha256: str | None = None,
        require_valid: bool = False,
        expected_blueprint_path: str | None = None,
        expected_blueprint_sha256: str | None = None,
    ) -> dict[str, Any]:
        """Serialize a run's writes, including legacy implicit-run callers."""
        # Slugs are unique within the project. Use the same lock whether the
        # caller supplies a run ID or lets _write resolve the legacy binding.
        key = hashlib.sha256(self.normalize_slug(slug).encode("utf-8")).hexdigest()
        directory = self.sessions / "runtime-write-locks"
        directory.mkdir(parents=True, exist_ok=True)
        with (directory / f"{key}.lock").open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                if expected_blueprint_path is not None or expected_blueprint_sha256 is not None:
                    if (step != "package" or not run_id or expected_path is None or expected_sha256 is None
                            or not isinstance(expected_blueprint_path, str)
                            or not re.fullmatch(r"pipeline/blueprint/[^/\\\s]+\.md", expected_blueprint_path)
                            or not isinstance(expected_blueprint_sha256, str)
                            or not re.fullmatch(r"[a-f0-9]{64}", expected_blueprint_sha256)):
                        raise ValueError("方案局部修改必须同时绑定正文与写作方案的路径和校验值")
                if expected_path is not None or expected_sha256 is not None:
                    if not run_id or expected_path is None or expected_sha256 is None or bool(expected_path) != bool(expected_sha256):
                        raise ValueError("版本修改必须同时提供 run、原稿路径与原稿校验值")
                    with self._state_lock():
                        run = self._load_run_unlocked(self.normalize_slug(run_id), self.normalize_slug(slug))
                        latest = run.get("steps", {}).get(step, {}).get("latest")
                        if (latest or "") != expected_path:
                            raise ValueError("原稿已经变化，请重新读取当前版本后再采用修改")
                        if expected_path:
                            original = self._project_path(expected_path, must_exist=True)
                            if hashlib.sha256(original.read_bytes()).hexdigest() != expected_sha256:
                                raise ValueError("原稿内容已经变化，请重新读取当前版本后再采用修改")
                        if expected_blueprint_path is not None:
                            # The same per-run write lock also serializes blueprint replacements.
                            # A selected edit cannot be adopted after its plan changed while saving.
                            current_blueprint = run.get("steps", {}).get("blueprint", {}).get("latest")
                            if current_blueprint != expected_blueprint_path:
                                raise ValueError("带入的写作方案已经更新，请重新读取并带入要求后再采用修改")
                            plan_file = self._project_path(expected_blueprint_path, must_exist=True)
                            if hashlib.sha256(plan_file.read_bytes()).hexdigest() != expected_blueprint_sha256:
                                raise ValueError("带入的写作方案内容已经更新，请重新读取并带入要求后再采用修改")
                return self._write(step, slug, content, source, run_id, unbound_report, require_valid)
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def _write(
        self,
        step: str,
        slug: str,
        content: str,
        source: str | None = None,
        run_id: str | None = None,
        unbound_report: bool = False,
        require_valid: bool = False,
    ) -> dict[str, Any]:
        """写入步骤输出，并更新 session state。"""
        if step not in STEPS:
            raise ValueError(f"未知步骤: {step}，可用: {STEPS}")

        safe_slug = self.normalize_slug(slug)
        selected_run_id = self.normalize_slug(run_id) if run_id else None
        if unbound_report:
            self._assert_unbound_performance_report(step, safe_slug, selected_run_id)
        elif selected_run_id:
            # Resolve and validate the explicit target before creating an
            # artifact. A bad run ID/slug must not leave an orphan file behind.
            with self._state_lock():
                if not self._run_file(selected_run_id).exists():
                    raise FileNotFoundError(f"run 不存在: {selected_run_id}")
                selected_run = self._load_run_unlocked(selected_run_id, selected_run_id)
                selected_slug = self.normalize_slug(str(selected_run.get("slug") or selected_run_id))
                if selected_slug != safe_slug:
                    raise ValueError("显式 run 写入的 slug 必须与目标 runtime run 一致")
                if step == "blueprint" and selected_run.get("research_mode") == author_evidence.MODE:
                    author_evidence.verified_record(self.project, selected_run, content)
        if not unbound_report and step == "blueprint" and not selected_run_id:
            managed_run_id = self._production_run_for_downstream_write(safe_slug, None)
            if managed_run_id:
                run = self.run_state(run_id=managed_run_id)
                if run.get("research_mode") == author_evidence.MODE:
                    author_evidence.verified_record(self.project, run, content)
                    selected_run_id = managed_run_id
        if not unbound_report and step in FROZEN_TIKOMNI_REQUIRED_STEPS:
            managed_run_id = self._production_run_for_downstream_write(safe_slug, selected_run_id)
            if managed_run_id:
                # Keep H2 inside the runtime authority. UI callers, local
                # Python consumers and the CLI therefore share one gate.
                self.assert_frozen_tikomni_market_snapshot(step, managed_run_id)
                selected_run_id = managed_run_id
        if step == "package" and selected_run_id:
            self._assert_native_package_platforms(content, self.run_state(run_id=selected_run_id))
        step_dir = self.pipeline / STEP_DIRS.get(step, step)
        step_dir.mkdir(parents=True, exist_ok=True)

        created_at = datetime.now()
        date_str = created_at.strftime("%Y-%m-%d")
        timestamp = created_at.strftime("%Y-%m-%d-%H%M%S-%f")
        file_stem = f"{timestamp}-{safe_slug}-{step}"
        file_path = step_dir / f"{file_stem}.md"
        counter = 1
        while file_path.exists():
            file_path = step_dir / f"{file_stem}-{counter:02d}.md"
            counter += 1

        frontmatter = {
            "step": step,
            "slug": safe_slug,
            "date": date_str,
            "source": source or "manual",
            "created_at": created_at.isoformat(),
        }
        fm_yaml = "\n".join(f"{k}: {self._frontmatter_value(v)}" for k, v in frontmatter.items())
        full_content = f"---\n{fm_yaml}\n---\n\n{content}\n"
        file_path.write_text(full_content, encoding="utf-8")

        # Validate the exact candidate before changing any run, material index
        # or downstream approvals. A rejected replacement must not invalidate
        # the author's previous usable work.
        validation = None
        if require_valid:
            try:
                validation = self.validate(step, str(file_path))
                if not validation.get("valid"):
                    raise RuntimeOutputValidationError(validation)
            except Exception:
                file_path.unlink(missing_ok=True)
                raise

        rel_path = str(file_path.relative_to(self.project))
        material_index_path = ""
        if step == "intake":
            material_index_path = self._update_material_index(safe_slug, rel_path, content, frontmatter, created_at)

        if unbound_report:
            def update_unbound_latest(state: SessionState) -> None:
                # Do not switch the operator away from the current production
                # run merely because external/historical metrics were imported.
                state.latest_files[step] = rel_path
                state.latest_by_slug.setdefault(safe_slug, {s: None for s in STEPS})
                state.latest_by_slug[safe_slug][step] = rel_path

            self._update_state(update_unbound_latest)
            bound_run_id = f"{UNBOUND_PERFORMANCE_RUN_PREFIX}{safe_slug}"
        elif selected_run_id:
            # An explicit run binding is an addressing decision, not an
            # operator-navigation decision. Keep the per-slug read index
            # current, but never overwrite active_run_id/current_slug/current_step
            # (or the active run's unscoped latest-files view). This makes a
            # write safe when other runs are being produced concurrently or
            # the operator deliberately changes the active run mid-write.
            with self._state_lock():
                state = self._load_state_unlocked()
                state.latest_by_slug.setdefault(safe_slug, {s: None for s in STEPS})
                state.latest_by_slug[safe_slug][step] = rel_path
                self._save_state_unlocked(state)
            bound_run_id = selected_run_id
        else:
            def update_latest(state: SessionState) -> None:
                previous_slug = state.current_slug
                state.current_step = step
                state.current_slug = safe_slug
                if not state.active_run_id or previous_slug != safe_slug:
                    state.active_run_id = safe_slug
                state.latest_files[step] = rel_path
                state.latest_by_slug.setdefault(safe_slug, {s: None for s in STEPS})
                state.latest_by_slug[safe_slug][step] = rel_path

            state = self._update_state(update_latest)
            bound_run_id = state.active_run_id or safe_slug
        run = self._update_run(bound_run_id, safe_slug, step, rel_path, source, created_at)

        result = {
            "status": "written",
            "path": str(file_path),
            "step": step,
            "slug": safe_slug,
            "run_id": run["run_id"],
            "run_file": str(self._run_file(run["run_id"])),
            "unbound_report": unbound_report,
        }
        if material_index_path:
            result["material_index"] = material_index_path
        if validation is not None:
            result["validation"] = validation
        return result

    def read(self, step: str, latest: bool = False, file: str | None = None, slug: str | None = None, summary: bool = False) -> dict[str, Any]:
        """读取某步骤输出。"""
        target: Path | None = None
        if file:
            target = self._project_path(file, must_exist=True)
        elif latest:
            state = self._load_state()
            rel = None
            if slug:
                safe_slug = self.normalize_slug(slug)
                rel = state.latest_by_slug.get(safe_slug, {}).get(step)
            else:
                rel = state.latest_files.get(step)
            if not rel:
                scoped = f" slug={self.normalize_slug(slug)}" if slug else ""
                hint = f"建议先执行 `/content-{step}` 或调用 write 写入该步骤输出。"
                if step == "write":
                    hint = "建议先执行 `/content-write` 或调用 write 写入公众号成稿。"
                elif step == "xhs":
                    hint = "建议先执行 `/content-xhs` 或调用 write 写入小红书图文。"
                elif step == "douyin":
                    hint = "建议先执行 `/content-douyin` 或调用 write 写入口播脚本。"
                raise FileNotFoundError(f"步骤 {step}{scoped} 还没有最新文件。{hint}")
            target = self._project_path(rel, must_exist=True)
        else:
            raise ValueError("必须指定 --file 或 --latest")

        if not target.exists():
            raise FileNotFoundError(f"文件不存在: {target}")

        text = target.read_text(encoding="utf-8")
        frontmatter, body = self._split_frontmatter(text)
        if summary:
            return self._summary_payload(step, target, frontmatter, body)
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

    def run_state(self, run_id: str | None = None, slug: str | None = None) -> dict[str, Any]:
        """读取单条内容 run 状态。默认按 slug/run_id 读取。"""
        state = self._load_state()
        selected = self.normalize_slug(run_id or slug or state.active_run_id or state.current_slug or "current")
        path = self._run_file(selected)
        if not path.exists() and slug and not run_id and self.runs.exists():
            wanted_slug = self.normalize_slug(slug)
            for candidate in self.runs.glob("*.json"):
                try:
                    data = json.loads(candidate.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    continue
                if self.normalize_slug(data.get("slug", "")) == wanted_slug:
                    path = candidate
                    break
        if not path.exists():
            raise FileNotFoundError(f"run 不存在: {selected}")
        # Normalize the in-memory view so older runs stay readable under the
        # current contract without rewriting their historical source file.
        return self._load_run_unlocked(path.stem, slug or path.stem)

    def _approval_scope_config(self, scope: str) -> dict[str, Any]:
        if scope not in APPROVAL_SCOPES:
            raise ValueError(f"未知审批阶段: {scope}")
        return APPROVAL_SCOPE_CONFIG[scope]

    def _approval_artifact_path(self, scope: str, file: str | Path) -> tuple[Path, str]:
        """Resolve a current approval artifact and enforce its domain boundary."""
        config = self._approval_scope_config(scope)
        target = self._project_path(file, must_exist=True)
        if not target.is_file():
            raise ValueError("审批产物必须是项目内的普通文件")
        rel_path = target.relative_to(self.project).as_posix()
        roots = tuple(config.get("roots") or ())
        if not any(rel_path.startswith(root) for root in roots):
            raise ValueError(f"{scope} 审批产物不在允许的本地目录中")
        return target, rel_path

    def _validate_approval_artifact(self, scope: str, target: Path) -> None:
        """Apply small, domain-owned completeness gates before human approval."""
        if scope == "draft_information":
            self._load_valid_draft_queue(target)
            return
        if scope != "visual_assets":
            return
        try:
            manifest = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("视觉采用清单不是可读取的 JSON 文件") from exc
        if not isinstance(manifest, dict) or manifest.get("schema") != "aifios.visual-asset-manifest.v1":
            raise ValueError("视觉阶段只能确认完整的逐项采用清单")
        roles = manifest.get("requiredRoles")
        selections = manifest.get("selections")
        if not isinstance(roles, list) or not roles or not all(isinstance(role, str) and role for role in roles):
            raise ValueError("视觉采用清单缺少 requiredRoles")
        if not isinstance(selections, dict):
            raise ValueError("视觉采用清单缺少 selections")
        missing = [role for role in roles if not isinstance(selections.get(role), dict)]
        if missing:
            raise ValueError("视觉资产尚未逐项采用：" + "、".join(missing))

    def _load_valid_draft_queue(self, target: Path) -> dict[str, Any]:
        """Read and enforce the immutable publication-job contract.

        Operational fields such as status and retry history may legitimately
        change after approval. The identities and delivery kinds may not: they
        are what the operator actually approved for this production run.
        """
        try:
            queue = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("发布草稿队列不是可读取的 JSON 文件") from exc
        if not isinstance(queue, dict) or queue.get("schema") != DRAFT_QUEUE_SCHEMA:
            raise ValueError("发布草稿队列格式无效")
        for field in ("run_id", "run_slug", "package_path"):
            if not isinstance(queue.get(field), str) or not str(queue.get(field)).strip():
                raise ValueError(f"发布草稿队列缺少 {field}")
        jobs = queue.get("jobs")
        if not isinstance(jobs, list):
            raise ValueError("发布草稿队列缺少 jobs")
        target_platforms = queue.get("target_platforms")
        if target_platforms is not None:
            if (
                not isinstance(target_platforms, list)
                or not target_platforms
                or len(set(target_platforms)) != len(target_platforms)
                or any(platform not in {"wechat", "xiaohongshu", "shipinhao"} for platform in target_platforms)
            ):
                raise ValueError("发布草稿队列的本期平台无效")
            dynamic_jobs: set[tuple[str, str, str]] = set()
            if "wechat" in target_platforms:
                dynamic_jobs.add(("wechat", "wechat-article", "draft_fill"))
            if "xiaohongshu" in target_platforms:
                dynamic_jobs.add(("xiaohongshu", "xiaohongshu-opinion-1", "draft_fill"))
            if "shipinhao" in target_platforms:
                dynamic_jobs.add(("shipinhao", "shipinhao-video-execution-1", "execution_package"))
            expected_jobs = frozenset(dynamic_jobs)
        else:
            expected_jobs = REQUIRED_DRAFT_QUEUE_JOBS
        if len(jobs) != len(expected_jobs):
            raise ValueError("发布草稿队列必须精确覆盖本期已选平台（旧版队列固定 11 项）")

        job_ids: set[str] = set()
        actual_jobs: set[tuple[str, str, str]] = set()
        for job in jobs:
            if not isinstance(job, dict):
                raise ValueError("发布草稿队列包含无效任务")
            job_id = job.get("job_id")
            platform = job.get("platform")
            item_id = job.get("item_id")
            delivery_kind = job.get("delivery_kind")
            if (
                not isinstance(job_id, str)
                or not re.fullmatch(r"draft_[a-f0-9]{20}", job_id)
                or not isinstance(platform, str)
                or not isinstance(item_id, str)
                or not isinstance(delivery_kind, str)
                or job_id in job_ids
            ):
                raise ValueError("发布草稿队列包含无效任务标识")
            contract = (platform, item_id, delivery_kind)
            if contract not in expected_jobs or contract in actual_jobs:
                raise ValueError("发布草稿队列的任务标识或交付类型不符合当前契约")
            job_ids.add(job_id)
            actual_jobs.add(contract)
        if actual_jobs != expected_jobs:
            raise ValueError("发布草稿队列没有完整覆盖当前交付项")
        return queue

    def _validate_draft_queue_binding(self, target: Path, run: dict[str, Any]) -> None:
        """Bind a fixed queue to the current approved package and visual bytes."""
        queue = self._load_valid_draft_queue(target)
        if queue.get("run_id") != run.get("run_id"):
            raise ValueError("发布草稿队列不属于当前 run")
        run_slug = self.normalize_slug(str(run.get("slug") or ""))
        if self.normalize_slug(str(queue.get("run_slug") or "")) != run_slug:
            raise ValueError("发布草稿队列的 run slug 不属于当前 run")
        queue_targets = queue.get("target_platforms")
        if queue_targets is not None:
            run_targets = ["xiaohongshu" if item == "xhs" else item for item in run.get("selected_platforms", [])]
            if set(queue_targets) != set(run_targets):
                raise ValueError("发布草稿队列的平台范围与当前 run 不一致")
        relative_target = target.relative_to(self.project).as_posix()
        expected_queue_path = f"materials/publication/drafts/{run_slug}/draft-queue.json"
        if relative_target != expected_queue_path:
            raise ValueError("发布草稿队列不是当前 run 的规范保存路径")

        package_path = str(queue.get("package_path") or "").strip()
        latest_package_path = str((((run.get("steps") or {}).get("package") or {}).get("latest")) or "").strip()
        registered_package_path = str((((run.get("phase_artifacts") or {}).get("content_package") or {}).get("path")) or "").strip()
        if (
            not latest_package_path
            or package_path != latest_package_path
            or (registered_package_path and registered_package_path != latest_package_path)
        ):
            raise ValueError("发布草稿队列引用的内容包不是当前 run 最新版本")
        package_target = self._project_path(package_path, must_exist=True)
        package_hash = str(queue.get("package_sha256") or "").lower()
        if not re.fullmatch(r"[a-f0-9]{64}", package_hash) or package_hash != self._sha256_file(package_target):
            raise ValueError("发布草稿队列的内容包 SHA-256 与当前文件不一致")

        visual_required = queue_targets is None or any(platform in {"wechat", "xiaohongshu"} for platform in queue_targets)
        visual_path = str(queue.get("visual_manifest_path") or "").strip()
        visual_target: Path | None = None
        if visual_required:
            expected_visual_path = f"pipeline/visual/{run_slug}/selected-assets.json"
            current_visual_path = str((((run.get("phase_artifacts") or {}).get("visual_assets") or {}).get("path")) or "").strip()
            if not current_visual_path or visual_path != current_visual_path or visual_path != expected_visual_path:
                raise ValueError("发布草稿队列引用的视觉清单不是当前 run 最新版本")
            visual_target = self._project_path(visual_path, must_exist=True)
            visual_hash = str(queue.get("visual_manifest_sha256") or "").lower()
            if not re.fullmatch(r"[a-f0-9]{64}", visual_hash) or visual_hash != self._sha256_file(visual_target):
                raise ValueError("发布草稿队列的视觉清单 SHA-256 与当前文件不一致")
            self._validate_visual_manifest_binding(visual_target, visual_path, run)
        elif visual_path:
            raise ValueError("仅视频号运行不应绑定视觉清单")

        approvals = run.get("approvals") or {}
        upstream = [("content_package", package_path, package_target)]
        if visual_required and visual_target is not None:
            upstream.append(("visual_assets", visual_path, visual_target))
        for scope, path, artifact in upstream:
            approval = approvals.get(scope)
            if (
                not isinstance(approval, dict)
                or approval.get("scope") != scope
                or approval.get("run_id") != run.get("run_id")
                or approval.get("run_slug") != run.get("slug")
                or approval.get("path") != path
                or approval.get("method") != "human_review"
                or approval.get("invalidated_at")
                or approval.get("sha256") != self._artifact_sha256(scope, artifact)
                or approval.get("version") != self._scope_artifact_version(run, scope, path)
            ):
                raise ValueError(f"发布草稿队列的上游 {scope} 确认已失效")

    def _content_package_release_gate(self, target: Path) -> dict[str, Any]:
        """Run the content and expression gate used by the UI approval."""
        try:
            body = self._split_frontmatter(target.read_text(encoding="utf-8"))[1]
        except (OSError, UnicodeDecodeError) as exc:
            raise ValueError("最终内容包无法读取，不能确认") from exc
        result = run_release_gate(body)
        if result.get("status") == "blocked":
            issues = list(result.get("blocking_issues") or [])
            detail = "；".join(str(item) for item in issues[:4]) or "请处理内容、事实、隐私或平台风险"
            raise ValueError("最终内容存在不可自动修复的发布质量阻断，不能确认：" + detail)
        return result

    @staticmethod
    def _visual_semantic_role(asset_id: str) -> str:
        if re.fullmatch(r"wechat-cover(?:-alt-\d+)?", asset_id, re.IGNORECASE):
            return "wechat_cover"
        if re.fullmatch(r"wechat-share(?:-alt-\d+)?", asset_id, re.IGNORECASE):
            return "wechat_share"
        return asset_id

    @staticmethod
    def _safe_visual_relative_path(value: Any, prefix: str) -> str:
        if not isinstance(value, str) or not value.startswith(prefix) or value.startswith("/") or "\\" in value:
            raise ValueError("视觉采用清单包含不属于当前版本的资产路径")
        parts = value.split("/")
        if any(not part or part in {".", ".."} for part in parts):
            raise ValueError("视觉采用清单包含不安全的资产路径")
        return value

    def _validate_visual_manifest_binding(
        self,
        target: Path,
        rel_path: str,
        run: dict[str, Any],
    ) -> None:
        """Verify each adopted asset against its recipe, index and current package.

        The adoption API already creates this manifest, but approval is the last
        server-side boundary. A hand-edited JSON file must never turn arbitrary
        project files into a release-ready visual selection.
        """
        try:
            manifest = json.loads(target.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("视觉采用清单不是可读取的 JSON 文件") from exc
        if not isinstance(manifest, dict):
            raise ValueError("视觉采用清单不是有效的 JSON 对象")

        slug = self.normalize_slug(str(run.get("slug") or ""))
        expected_manifest_path = f"pipeline/visual/{slug}/selected-assets.json"
        if manifest.get("slug") != slug or rel_path != expected_manifest_path:
            raise ValueError("视觉采用清单不属于当前 run")

        source_hash = manifest.get("sourceContentHash")
        if not isinstance(source_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", source_hash):
            raise ValueError("视觉采用清单缺少内容包摘要")
        package_path = ((run.get("steps") or {}).get("package") or {}).get("latest")
        if not isinstance(package_path, str) or not package_path:
            raise ValueError("视觉资产必须绑定当前内容包")
        package_target = self._project_path(package_path, must_exist=True)
        if self._sha256_file(package_target) != source_hash:
            raise ValueError("视觉采用清单已不匹配当前内容包，需要重新生成")
        package_approval = (run.get("approvals") or {}).get("content_package")
        if not isinstance(package_approval, dict):
            raise ValueError("最终内容尚未完成负责人确认，不能确认视觉资产")
        if (
            package_approval.get("invalidated_at")
            or package_approval.get("path") != package_path
            or package_approval.get("sha256") != self._artifact_sha256("content_package", package_target)
            or package_approval.get("version") != self._scope_artifact_version(run, "content_package", package_path)
        ):
            raise ValueError("最终内容确认已失效，不能确认视觉资产")

        roles = manifest.get("requiredRoles")
        selections = manifest.get("selections")
        if not isinstance(roles, list) or not isinstance(selections, dict):
            raise ValueError("视觉采用清单格式不完整")
        if len(set(roles)) != len(roles):
            raise ValueError("视觉采用清单包含重复角色")
        if set(selections) != set(roles):
            raise ValueError("视觉采用清单包含未声明或缺失的资产角色")

        recipes: dict[str, dict[str, Any]] = {}
        indexes: dict[str, dict[str, Any]] = {}
        for role in roles:
            selection = selections.get(role)
            if not isinstance(role, str) or not role or not isinstance(selection, dict):
                raise ValueError("视觉采用清单包含无效资产角色")
            asset_id = selection.get("assetId")
            revision_id = selection.get("revisionId")
            asset_path = selection.get("path")
            asset_hash = selection.get("sha256")
            if (
                not isinstance(asset_id, str)
                or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,100}", asset_id)
                or not isinstance(revision_id, str)
                or not re.fullmatch(r"r\d{3,}", revision_id)
                or not isinstance(asset_hash, str)
                or not re.fullmatch(r"[a-f0-9]{64}", asset_hash)
            ):
                raise ValueError("视觉采用清单包含无效资产标识或摘要")
            if selection.get("semanticRole") != role or self._visual_semantic_role(asset_id) != role:
                raise ValueError("视觉采用清单中的资产角色与资产 ID 不一致")
            if not isinstance(selection.get("platformBindings"), list):
                raise ValueError("视觉采用清单缺少平台绑定")
            prefix = f"pipeline/visual/{slug}/publish/{revision_id}/"
            asset_path = self._safe_visual_relative_path(asset_path, prefix)
            raw_asset_path = self.project / asset_path
            if raw_asset_path.is_symlink() or not raw_asset_path.is_file():
                raise ValueError("已采用视觉资产必须是项目内普通文件")
            resolved_asset_path = self._project_path(asset_path, must_exist=True)
            if self._sha256_file(resolved_asset_path) != asset_hash:
                raise ValueError("已采用视觉资产摘要已变化，需要重新采用")

            if revision_id not in recipes:
                recipe_path = f"pipeline/visual/{slug}/recipes/{revision_id}.visual-recipe.json"
                index_path = f"pipeline/visual/{slug}/revisions/{revision_id}.index.json"
                try:
                    recipes[revision_id] = json.loads(self._project_path(recipe_path, must_exist=True).read_text(encoding="utf-8"))
                    indexes[revision_id] = json.loads(self._project_path(index_path, must_exist=True).read_text(encoding="utf-8"))
                except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
                    raise ValueError("已采用视觉资产缺少可验证的配方或发布索引") from exc
            recipe = recipes[revision_id]
            index = indexes[revision_id]
            if (
                not isinstance(recipe, dict)
                or recipe.get("slug") != slug
                or recipe.get("revision_id") != revision_id
                or recipe.get("source_package") != package_path
                or not isinstance(index, dict)
                or index.get("schema") != "aifios.visual-publish.v1"
                or index.get("slug") != slug
                or index.get("revision_id") != revision_id
            ):
                raise ValueError("已采用视觉资产的配方或发布索引不属于当前内容包")
            recipe_ids = {
                item.get("id")
                for item in recipe.get("assets", [])
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            }
            if asset_id not in recipe_ids:
                raise ValueError("已采用视觉资产未在配方中声明")
            indexed = next((
                item for item in index.get("outputs", [])
                if isinstance(item, dict) and item.get("id") == asset_id
            ), None)
            if not isinstance(indexed, dict) or (
                indexed.get("output") != asset_path
                or indexed.get("sha256") != asset_hash
                or indexed.get("revision_id") != revision_id
                or indexed.get("status") != "generated"
            ):
                raise ValueError("已采用视觉资产未通过发布索引完整性校验")

    def _blueprint_path(self, file: str | Path) -> tuple[Path, str]:
        target, rel_path = self._approval_artifact_path("topic_template", file)
        if not rel_path.startswith("pipeline/blueprint/"):
            raise ValueError("思想母版蓝图必须位于 pipeline/blueprint/")
        return target, rel_path

    @staticmethod
    def _sha256_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _artifact_sha256(self, scope: str, path: Path) -> str:
        """Hash the approval-relevant bytes for one local phase artifact.

        A draft queue is intentionally mutable while local adapters move jobs
        from pending to filled/retry/manual states. Those operational fields
        must not silently invalidate the operator's approval of titles, copy,
        image order, content hashes, and selected visual evidence. Every other
        phase remains bound to the exact file bytes.
        """
        if scope != "draft_information":
            return self._sha256_file(path)
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return self._sha256_file(path)
        if not isinstance(payload, dict) or payload.get("schema") != "aifios.publication-draft-queue.v1":
            return self._sha256_file(path)

        transient_keys = {
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
        }

        def stable(value: Any) -> Any:
            if isinstance(value, list):
                return [stable(item) for item in value]
            if isinstance(value, dict):
                return {
                    str(key): stable(item)
                    for key, item in sorted(value.items())
                    if key not in transient_keys
                }
            return value

        canonical = json.dumps(stable(payload), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    def _approval_run_id(self, run_id: str | None) -> str:
        if run_id:
            return self.normalize_slug(run_id)
        state = self._load_state()
        selected = state.active_run_id or state.current_slug
        if not selected:
            raise FileNotFoundError("没有活动内容 run，不能确认思想母版蓝图")
        return self.normalize_slug(selected)

    @staticmethod
    def _approval_invalidation_reason(scope: str) -> str:
        if scope == "topic_template":
            return "template_changed"
        if scope == "visual_assets":
            return "visual_changed"
        if scope == "draft_information":
            return "platform_fields_changed"
        return "content_changed"

    def _topic_snapshot_binding(self, target: Path, run_id: str) -> dict[str, str]:
        """Verify the explicitly chosen source; legacy runs require TikOmni."""
        current_run = self.run_state(run_id=run_id)
        if current_run.get("research_mode") == author_evidence.MODE:
            verified = author_evidence.verified_record(self.project, current_run, target.read_text(encoding="utf-8"))
            return {key: verified[key] for key in (
                "research_mode", "author_evidence_path", "author_evidence_sha256",
            )}
        try:
            body = target.read_text(encoding="utf-8")
        except OSError as exc:
            raise ValueError("思想母版蓝图不可读取，不能绑定 TikOmni 研究快照") from exc
        path_match = TOPIC_SNAPSHOT_PATH_RE.search(body)
        digest_match = TOPIC_SNAPSHOT_SHA_RE.search(body)
        if not path_match or not digest_match:
            raise ValueError("思想母版蓝图必须声明 TikOmni 研究快照路径和 SHA-256，才能确认选题与模板")
        snapshot_path = path_match.group(1).strip()
        declared_digest = digest_match.group(1).lower()
        expected_prefix = f"runs/{self.normalize_slug(run_id)}/market-research/"
        if not snapshot_path.startswith(expected_prefix):
            raise ValueError("思想母版蓝图引用的 TikOmni 研究快照不属于当前 run")
        from market_signal import verify_market_snapshot

        verification = verify_market_snapshot(self.project, run_id, snapshot_path)
        if not verification.get("verified"):
            raise ValueError(f"TikOmni 研究快照未通过完整性校验：{verification.get('reason') or '未知错误'}")
        actual_digest = str(verification.get("snapshot_sha256") or "").lower()
        if declared_digest != actual_digest:
            raise ValueError("思想母版蓝图中的 TikOmni 快照 SHA-256 与当前快照不一致")
        current_run = self.run_state(run_id=run_id)
        self._assert_snapshot_matches_current_intake(current_run, verification)
        return {
            "market_snapshot_path": str(verification["manifest_path"]),
            "market_snapshot_sha256": actual_digest,
        }

    def _freeze_topic_snapshot_after_approval(
        self,
        run_id: str,
        approval: dict[str, Any],
    ) -> dict[str, Any]:
        """Freeze a verified snapshot and bind its result to the approval record."""
        if approval.get("research_mode") == author_evidence.MODE:
            # The author source is immutable at selection time; approval binds
            # that exact record in the same run-file commit below.
            return approval
        from market_signal import freeze_market_snapshot

        try:
            frozen = freeze_market_snapshot(
                self.project,
                run_id,
                str(approval["market_snapshot_path"]),
            )
        except Exception as exc:
            # The human confirmation must never remain usable if its evidence
            # could not be frozen. Keep the failed attempt auditable, but force
            # a fresh review once the live evidence is repaired.
            with self._state_lock():
                run = self._load_run_unlocked(run_id, run_id)
                current = (run.get("approvals") or {}).get("topic_template")
                if (
                    isinstance(current, dict)
                    and current.get("path") == approval.get("path")
                    and current.get("sha256") == approval.get("sha256")
                    and not current.get("invalidated_at")
                ):
                    current["invalidated_at"] = datetime.now().isoformat()
                    current["invalidation_reason"] = "tikomni_snapshot_freeze_failed"
                    run.setdefault("history", []).append({
                        "event": "topic_snapshot_freeze_failed",
                        "scope": "topic_template",
                        "path": approval.get("path"),
                        "created_at": datetime.now().isoformat(),
                        "source": "tikomni",
                    })
                    self._save_run_unlocked(run)
            raise ValueError(f"TikOmni 研究快照冻结失败，不能确认选题与模板：{exc}") from exc

        with self._state_lock():
            run = self._load_run_unlocked(run_id, run_id)
            current = (run.get("approvals") or {}).get("topic_template")
            if not isinstance(current, dict) or current.get("invalidated_at"):
                raise ValueError("选题与模板确认在 TikOmni 快照冻结期间已失效，需要重新确认")
            if current.get("market_snapshot_path") != frozen.get("manifest_path"):
                raise ValueError("TikOmni 冻结快照与当前选题确认不一致，需要重新确认")
            if current.get("market_snapshot_sha256") != frozen.get("snapshot_sha256"):
                raise ValueError("TikOmni 冻结快照摘要与当前选题确认不一致，需要重新确认")
            current["market_snapshot_frozen_at"] = frozen.get("frozen_at")
            current["market_snapshot_freeze_sha256"] = frozen.get("sha256")
            if run.get("schema") == PRODUCTION_RUN_SCHEMA:
                run["platform_selection"] = {
                    "status": "locked",
                    "locked_at": frozen.get("frozen_at") or datetime.now().isoformat(),
                }
            run.setdefault("history", []).append({
                "event": "topic_snapshot_frozen",
                "scope": "topic_template",
                "path": current.get("path"),
                "market_snapshot_path": frozen.get("manifest_path"),
                "market_snapshot_sha256": frozen.get("snapshot_sha256"),
                "created_at": datetime.now().isoformat(),
                "source": "tikomni",
            })
            self._save_run_unlocked(run)
            return {**current, "market_snapshot_frozen_at": frozen.get("frozen_at")}

    def apply_material_correction(self, record: dict[str, Any]) -> dict[str, Any]:
        """Publish the correction and invalidate decisions in one run-file commit."""
        validate_correction(record)
        run_id = str(record.get("run_id") or "")
        target = correction_path(self.project, run_id, str(record.get("id") or ""))
        with self._state_lock():
            if not self._run_file(run_id).exists():
                raise ValueError("这期内容不存在")
            run = self._load_run_unlocked(run_id, run_id)
            if run.get("status") == "archived":
                raise ValueError("这期内容已归档")
            if target.exists():
                previous = json.loads(target.read_text(encoding="utf-8"))
                # created_at is server time and may differ on a retry.
                keys = ("run_id", "id", "expected_fingerprint", "analysis")
                if any(previous.get(k) != record.get(k) for k in keys):
                    raise ValueError("这次保存编号已用于另一组修改，请重新核对")
                record = previous
                if (run.get("material_correction") or {}).get("id") == record["id"]:
                    current_correction(self.project, run)
                    return {"saved": True, "id": record["id"], "replayed": True}
                if any(h.get("event") == "material_corrected" and h.get("id") == record["id"] for h in run.get("history", [])):
                    raise ValueError("这次修改已被更新的修正替代，请重新读取")
            context, base_sha = base_context(self.project, run_id)
            if (base_sha != record["base_file_sha256"]
                    or context.get("inputFingerprint") != record["input_fingerprint"]
                    or context.get("analysisInputFingerprint") != record["input_fingerprint"]
                    or context.get("analysisStatus") == "stale"
                    or ((run.get("material_correction") or {}).get("id") or "") != record.get("previous_id", "")):
                raise ValueError("素材或整理结果已经更新，请重新读取后核对修改")
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not target.exists():
                temporary = target.with_suffix(f".{uuid.uuid4().hex}.tmp")
                with temporary.open("x", encoding="utf-8") as stream:
                    stream.write(json.dumps(record, ensure_ascii=False, indent=2))
                os.chmod(temporary, 0o600)
                os.replace(temporary, target)
            now = datetime.now().isoformat()
            run["material_correction"] = {
                "id": record["id"], "path": target.relative_to(self.project).as_posix(),
                "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            }
            self._invalidate_scope_approvals(run, "topic_template", "material_corrected", now)
            legacy = (run.get("approvals") or {}).get("blueprint")
            if isinstance(legacy, dict):
                legacy.update(invalidated_at=now, invalidation_reason="material_corrected")
            run.setdefault("history", []).append({"event": "material_corrected", "id": record["id"], "created_at": now, "source": "author"})
            self._save_run_unlocked(run)
            return {"saved": True, "id": record["id"], "replayed": False}

    def _invalidate_scope_approvals(
        self,
        run: dict[str, Any],
        changed_scope: str,
        reason: str | None = None,
        at: str | None = None,
    ) -> None:
        """Invalidate the changed object plus every human decision downstream."""
        if changed_scope not in APPROVAL_SCOPES:
            return
        timestamp = at or datetime.now().isoformat()
        invalidation_reason = reason or self._approval_invalidation_reason(changed_scope)
        approvals = run.setdefault("approvals", {})
        scopes = (changed_scope, *DOWNSTREAM_APPROVAL_SCOPES[changed_scope])
        for scope in scopes:
            approval = approvals.get(scope)
            if isinstance(approval, dict) and not approval.get("invalidated_at"):
                approval["invalidated_at"] = timestamp
                approval["invalidation_reason"] = invalidation_reason
        # Local manifests are mutable pointers, not the immutable evidence
        # files themselves. Once an upstream artifact changes, remove every
        # downstream pointer so an old visual/queue/ledger cannot become
        # "current" again through a direct approval call. The files remain on
        # disk for audit and controlled archival.
        phase_artifacts = run.setdefault("phase_artifacts", {})
        for scope in DOWNSTREAM_APPROVAL_SCOPES[changed_scope]:
            if scope in {"visual_assets", "draft_information", "publication_result"}:
                phase_artifacts.pop(scope, None)

    def _scope_current_artifact_path(self, run: dict[str, Any], scope: str) -> str:
        config = self._approval_scope_config(scope)
        phase = ((run.get("phase_artifacts") or {}).get(scope) or {})
        path = phase.get("path") if isinstance(phase, dict) else None
        if isinstance(path, str) and path:
            return path
        step = config.get("step")
        if isinstance(step, str):
            latest = ((run.get("steps") or {}).get(step) or {}).get("latest")
            if isinstance(latest, str) and latest:
                return latest
        return ""

    def _scope_uses_step_binding(self, scope: str, rel_path: str) -> bool:
        """Whether this artifact belongs to a runtime Markdown step."""
        config = self._approval_scope_config(scope)
        step = config.get("step")
        if not isinstance(step, str):
            return False
        phase_roots = tuple(config.get("phase_artifact_roots") or ())
        return not any(rel_path.startswith(root) for root in phase_roots)

    def _scope_artifact_version(self, run: dict[str, Any], scope: str, rel_path: str) -> int:
        phase = ((run.get("phase_artifacts") or {}).get(scope) or {})
        if isinstance(phase, dict) and phase.get("path") == rel_path:
            value = phase.get("version")
            if isinstance(value, int) and value > 0:
                return value
        step = self._approval_scope_config(scope).get("step")
        if isinstance(step, str):
            versions = [
                item for item in run.get("history", []) or []
                if item.get("step") == step and item.get("path") == rel_path
            ]
            return max(1, len(versions))
        return 1

    def register_phase_artifact(self, scope: str, file: str | Path, run_id: str | None = None) -> dict[str, Any]:
        """Bind a non-Markdown phase manifest to one run before human approval.

        Visual manifests, draft queues and publication ledgers are produced by
        local adapters rather than ``runtime write``. Registering them gives
        them the same current-path/hash/version contract as Markdown steps.
        """
        target, rel_path = self._approval_artifact_path(scope, file)
        selected_run_id = self._approval_run_id(run_id)
        digest = self._artifact_sha256(scope, target)
        with self._state_lock():
            if not self._run_file(selected_run_id).exists():
                raise FileNotFoundError(f"run 不存在: {selected_run_id}")
            run = self._load_run_unlocked(selected_run_id, selected_run_id)
            if scope == "draft_information":
                self._validate_draft_queue_binding(target, run)
            config = self._approval_scope_config(scope)
            step = config.get("step")
            if isinstance(step, str) and self._scope_uses_step_binding(scope, rel_path):
                latest = ((run.get("steps") or {}).get(step) or {}).get("latest")
                if latest != rel_path:
                    raise ValueError(f"{scope} 只能绑定当前 run 的最新 {step} 产物")
                version = self._scope_artifact_version(run, scope, rel_path)
            else:
                previous = ((run.get("phase_artifacts") or {}).get(scope) or {})
                previous_version = previous.get("version") if isinstance(previous, dict) else None
                changed = not isinstance(previous, dict) or previous.get("path") != rel_path or previous.get("sha256") != digest
                version = (previous_version if isinstance(previous_version, int) and previous_version > 0 else 0) + (1 if changed else 0)
                run.setdefault("phase_artifacts", {})[scope] = {
                    "path": rel_path,
                    "sha256": digest,
                    "version": version or 1,
                    "registered_at": datetime.now().isoformat(),
                }
                if changed:
                    self._invalidate_scope_approvals(run, scope)
                    run.setdefault("history", []).append({
                        "event": "phase_artifact_registered",
                        "scope": scope,
                        "path": rel_path,
                        "created_at": datetime.now().isoformat(),
                        "source": "runtime",
                    })
            self._save_run_unlocked(run)
        return {
            "registered": True,
            "scope": scope,
            "run_id": selected_run_id,
            "run_slug": run.get("slug") or "",
            "path": rel_path,
            "sha256": digest,
            "version": version,
        }

    def _content_plan_status_unlocked(self, run: dict[str, Any]) -> dict[str, Any]:
        package_path = self._scope_current_artifact_path(run, "content_package")
        blueprint_path = self._scope_current_artifact_path(run, "topic_template")
        result: dict[str, Any] = {
            "status": "unavailable", "package_path": package_path,
            "blueprint_path": blueprint_path, "blueprint_sha256": "",
            "reason": "正文或写作方案尚不可读取，请先恢复当前内容。",
        }
        if not package_path or not blueprint_path:
            return result
        try:
            plan_file = self._project_path(blueprint_path, must_exist=True)
            package_file = self._project_path(package_path, must_exist=True)
            plan_sha = hashlib.sha256(plan_file.read_bytes()).hexdigest()
            correction = current_correction(self.project, run)
            correction_id = correction["id"] if correction else ""
            result["material_correction_id"] = correction_id
            package_sha = hashlib.sha256(package_file.read_bytes()).hexdigest()
            result["blueprint_sha256"] = plan_sha
            origin_path = package_path
            seen = set()
            binding: dict[str, Any] = {}
            # Revisions to legacy packages must follow the original draft,
            # rather than assigning whichever blueprint happens to be current.
            owned = {entry.get("path") for entry in run.get("history", []) if entry.get("step") == "package"}
            owned.add(package_path)
            for _ in range(100):
                if origin_path in seen or origin_path not in owned:
                    break
                seen.add(origin_path)
                raw = self._project_path(origin_path, must_exist=True).read_text(encoding="utf-8")
                marker = re.search(r"<!--\s*echo-content-plan:(.*?)-->", raw, re.DOTALL)
                if marker:
                    value = json.loads(marker.group(1))
                    if isinstance(value, dict) and re.fullmatch(r"pipeline/blueprint/[^/\\\s]+\.md", str(value.get("path", ""))) and re.fullmatch(r"[a-f0-9]{64}", str(value.get("sha256", ""))):
                        binding = value
                    break
                frontmatter, _ = self._split_frontmatter(raw)
                revision = re.fullmatch(r"content-revision(?:-undo)?:(rev_[a-f0-9]{32})", frontmatter.get("source", ""))
                if not revision:
                    break
                record_path = f"runs/{self.normalize_slug(run['run_id'])}/content-revisions/{revision.group(1)}.json"
                record = json.loads(self._project_path(record_path, must_exist=True).read_text(encoding="utf-8"))
                if record.get("runId") != run["run_id"] or record.get("id") != revision.group(1):
                    break
                origin_path = str(record.get("basePath") or "")
            if binding:
                result.update(source_blueprint_path=binding["path"], source_blueprint_sha256=binding["sha256"])
                matches = binding["path"] == blueprint_path and binding["sha256"] == plan_sha
                result.update(status="current" if matches else "outdated", reason="这稿依据当前写作方案生成。" if matches else "写作方案已经更新，这稿仍依据之前的方案。")
            else:
                # History can prove a plan was replaced, but cannot prove the
                # input bytes of an older generator. Never call that 'current'.
                previous_plan = ""
                for entry in run.get("history", []):
                    if entry.get("path") == origin_path and entry.get("step") == "package":
                        break
                    if entry.get("step") == "blueprint":
                        previous_plan = str(entry.get("path") or "")
                outdated = bool(previous_plan and previous_plan != blueprint_path)
                result.update(status="outdated" if outdated else "unknown", source_blueprint_path=previous_plan,
                              reason="旧稿生成后，写作方案已经更新。正文还没有按新方案更新。" if outdated else "这份旧稿没有记录所用方案的版本，请对照当前方案核对后再继续。")
            if (binding.get("material_correction_id") or "") != correction_id:
                result.update(status="outdated", reason="素材整理结果已经修正。这稿尚未按修正后的事实、观点和写作要求核对。")
            approval = (run.get("approvals") or {}).get("content_package") or {}
            if (not approval.get("invalidated_at") and approval.get("method") == "human_review"
                    and approval.get("run_id") == run.get("run_id") and approval.get("path") == package_path
                    and approval.get("sha256") == package_sha
                    and approval.get("blueprint_path") == blueprint_path and approval.get("blueprint_sha256") == plan_sha
                    and (approval.get("material_correction_id") or "") == correction_id
                    and approval.get("content_plan_decision") == "keep_existing"):
                result.update(status="retained", reason="你已对照当前方案检查，并选择保留这稿；没有重新生成正文。")
        except (OSError, ValueError, TypeError, KeyError):
            result.update(status="unavailable", reason="无法核对正文与方案的版本，请重新读取。")
        return result

    def content_plan_status(self, run_id: str) -> dict[str, Any]:
        selected = self.normalize_slug(run_id)
        with self._state_lock():
            if not self._run_file(selected).exists():
                raise FileNotFoundError("这期内容不存在")
            return self._content_plan_status_unlocked(self._load_run_unlocked(selected, selected))

    @staticmethod
    def _assert_native_package_platforms(body: str, run: dict[str, Any]) -> None:
        manifest = build_package_manifest(body)
        if manifest.get("schema") != "echo-founder.platform-native-package.v2":
            return  # Legacy packages keep their existing contract.
        selected = run.get("selected_platforms") or run.get("target_platforms") or []
        if manifest.get("platform_scope_errors") or set(manifest["target_platforms"]) != set(selected):
            raise ValueError("正文的平台范围与本期已选平台不一致，请核对后重新保存；不能由生成内容更改已选平台")

    def approve_artifact(self, scope: str, file: str | Path, run_id: str | None = None, reviewed_plan_sha256: str | None = None, reviewed_material_correction_id: str | None = None) -> dict[str, Any]:
        """Persist a human approval bound to the current local artifact bytes."""
        target, rel_path = self._approval_artifact_path(scope, file)
        self._validate_approval_artifact(scope, target)
        selected_run_id = self._approval_run_id(run_id)
        if scope == "content_package":
            # Verify ownership, then trust the explicit per-platform operator
            # review. Do not run a second AI expression/release gate or
            # rewrite the generated package during human confirmation.
            with self._state_lock():
                if not self._run_file(selected_run_id).exists():
                    raise FileNotFoundError(f"run 不存在: {selected_run_id}")
                current_run = self._load_run_unlocked(selected_run_id, selected_run_id)
                if not self._is_managed_production_run(current_run):
                    raise ValueError("最终内容确认必须绑定具有已选平台契约的 runtime run")
                if self._scope_current_artifact_path(current_run, scope) != rel_path:
                    raise ValueError(f"只能确认当前 run 的最新 {scope} 产物")
        if scope == "topic_template":
            self._assert_blueprint_platform_scope(target, selected_run_id)
        topic_snapshot = self._topic_snapshot_binding(target, selected_run_id) if scope == "topic_template" else {}
        with self._state_lock():
            if not self._run_file(selected_run_id).exists():
                raise FileNotFoundError(f"run 不存在: {selected_run_id}")
            run = self._load_run_unlocked(selected_run_id, selected_run_id)
            correction = current_correction(self.project, run)
            correction_id = correction["id"] if correction else ""
            if scope in ("topic_template", "content_package") and (reviewed_material_correction_id or "") != correction_id:
                raise ValueError("素材整理结果已修正，请重新读取并核对后确认")
            if scope == "content_package" and not self._is_managed_production_run(run):
                raise ValueError("最终内容确认必须绑定具有已选平台契约的 runtime run")
            if scope == "content_package":
                self._assert_native_package_platforms(target.read_text(encoding="utf-8"), run)
            if scope == "visual_assets":
                self._validate_visual_manifest_binding(target, rel_path, run)
            if scope == "draft_information":
                self._validate_draft_queue_binding(target, run)
            current_path = self._scope_current_artifact_path(run, scope)
            if current_path != rel_path:
                raise ValueError(f"只能确认当前 run 的最新 {scope} 产物")
            if scope == "topic_template" and run.get("research_mode") == author_evidence.MODE:
                verified_author = author_evidence.verified_record(self.project, run, target.read_text(encoding="utf-8"))
                if any(topic_snapshot.get(key) != verified_author[key] for key in (
                    "research_mode", "author_evidence_path", "author_evidence_sha256",
                )):
                    raise ValueError("确认期间写作依据已变化，请重新核对")
                topic_snapshot["author_evidence_frozen_at"] = datetime.now().isoformat()
                run["platform_selection"] = {"status": "locked", "locked_at": topic_snapshot["author_evidence_frozen_at"]}
            elif scope == "topic_template" and topic_snapshot.get("research_mode") == author_evidence.MODE:
                raise ValueError("确认期间写作依据已变化，请重新核对")
            content_plan = self._content_plan_status_unlocked(run) if scope == "content_package" else None
            if content_plan:
                if content_plan["status"] == "unavailable":
                    raise ValueError(content_plan["reason"])
                if reviewed_plan_sha256 and reviewed_plan_sha256 != content_plan["blueprint_sha256"]:
                    raise ValueError("写作方案已再次变化，请重新核对后确认")
                if content_plan["status"] not in ("current", "retained") and reviewed_plan_sha256 != content_plan["blueprint_sha256"]:
                    raise ValueError("正文尚未与当前方案核对。请重新生成，或明确核对并选择保留这稿")
            visual_template = normalize_visual_template(run.get("visual_template")) if scope == "topic_template" else None
            now = datetime.now().isoformat()
            approval = {
                "scope": scope,
                "run_id": selected_run_id,
                "run_slug": run.get("slug") or "",
                "path": rel_path,
                "sha256": self._artifact_sha256(scope, target),
                "version": self._scope_artifact_version(run, scope, rel_path),
                "approved_at": now,
                "method": "human_review",
                "material_correction_id": correction_id,
                **({
                    "blueprint_path": content_plan["blueprint_path"],
                    "blueprint_sha256": content_plan["blueprint_sha256"],
                    "content_plan_decision": "generated_current" if content_plan["status"] == "current" else "keep_existing",
                } if content_plan else {}),
                **topic_snapshot,
                **({"visual_template": visual_template} if visual_template else {}),
            }
            run.setdefault("approvals", {})[scope] = approval
            run.setdefault("history", []).append({
                "event": "approved",
                "scope": scope,
                "path": rel_path,
                "created_at": now,
                "source": "human_review",
            })
            self._save_run_unlocked(run)
        if scope == "topic_template":
            approval = self._freeze_topic_snapshot_after_approval(selected_run_id, approval)
        return {"approved": True, **approval}

    def approval_status(self, scope: str, file: str | Path, run_id: str | None = None) -> dict[str, Any]:
        """Return whether an approval remains bound to the current artifact."""
        try:
            target, rel_path = self._approval_artifact_path(scope, file)
            selected_run_id = self._approval_run_id(run_id)
        except (FileNotFoundError, ValueError) as exc:
            return {"approved": False, "scope": scope, "reason": str(exc)}

        try:
            self._validate_approval_artifact(scope, target)
            if scope == "topic_template":
                self._assert_blueprint_platform_scope(target, selected_run_id)
        except ValueError as exc:
            return {"approved": False, "scope": scope, "reason": str(exc)}

        with self._state_lock():
            if not self._run_file(selected_run_id).exists():
                return {"approved": False, "scope": scope, "reason": "run 不存在", "run_id": selected_run_id}
            run = self._load_run_unlocked(selected_run_id, selected_run_id)
            if scope == "visual_assets":
                try:
                    self._validate_visual_manifest_binding(target, rel_path, run)
                except ValueError as exc:
                    return {"approved": False, "scope": scope, "reason": str(exc), "run_id": selected_run_id}
            if scope == "draft_information":
                try:
                    self._validate_draft_queue_binding(target, run)
                except ValueError as exc:
                    return {"approved": False, "scope": scope, "reason": str(exc), "run_id": selected_run_id}
            current_path = self._scope_current_artifact_path(run, scope)
            approval = (run.get("approvals") or {}).get(scope)
            # Existing digest-bound blueprint approvals remain valid through the
            # migration, but are normalized to the canonical topic scope.
            if scope == "topic_template" and not isinstance(approval, dict):
                legacy = (run.get("approvals") or {}).get("blueprint")
                if isinstance(legacy, dict):
                    approval = {
                        **legacy,
                        "scope": "topic_template",
                        "method": "human_review",
                    }
            if not isinstance(approval, dict):
                return {"approved": False, "scope": scope, "reason": "尚未进行负责人确认", "run_id": selected_run_id}
            try:
                correction = current_correction(self.project, run)
                correction_id = correction["id"] if correction else ""
                if (approval.get("material_correction_id") or "") != correction_id:
                    raise ValueError("素材整理结果已变化，需要重新确认")
            except (OSError, ValueError, TypeError, KeyError):
                return {"approved": False, "scope": scope, "reason": "素材整理结果已变化或无法核对，需要重新确认", "run_id": selected_run_id}
            if current_path != rel_path or approval.get("path") != rel_path:
                return {"approved": False, "scope": scope, "reason": "产物版本已变化，需要重新确认", "run_id": selected_run_id}
            if approval.get("run_id") != selected_run_id or approval.get("run_slug") != run.get("slug"):
                return {"approved": False, "scope": scope, "reason": "确认不属于当前 run", "run_id": selected_run_id}
            if approval.get("scope") != scope or approval.get("invalidated_at"):
                return {"approved": False, "scope": scope, "reason": "确认已失效，需要重新确认", "run_id": selected_run_id}
            if approval.get("method") != "human_review":
                return {"approved": False, "scope": scope, "reason": "确认来源无效", "run_id": selected_run_id}
            digest = self._artifact_sha256(scope, target)
            version = self._scope_artifact_version(run, scope, rel_path)
            if approval.get("sha256") != digest or approval.get("version") != version:
                return {"approved": False, "scope": scope, "reason": "产物内容已变化，需要重新确认", "run_id": selected_run_id}
            if scope == "content_package":
                plan = self._content_plan_status_unlocked(run)
                if (plan["status"] not in ("current", "retained")
                        or approval.get("blueprint_path") != plan["blueprint_path"]
                        or approval.get("blueprint_sha256") != plan["blueprint_sha256"]):
                    return {"approved": False, "scope": scope, "reason": "写作方案或正文已变化，需要重新核对", "run_id": selected_run_id}
            if scope == "topic_template":
                if approval.get("visual_template") != normalize_visual_template(run.get("visual_template")):
                    return {"approved": False, "scope": scope, "reason": "本期品牌排版模板已变化，需要重新确认", "run_id": selected_run_id}
                if run.get("research_mode") == author_evidence.MODE:
                    try:
                        verified = author_evidence.verified_record(self.project, run, target.read_text(encoding="utf-8"))
                        if (not approval.get("author_evidence_frozen_at") or any(
                            approval.get(key) != verified[key] for key in (
                                "research_mode", "author_evidence_path", "author_evidence_sha256",
                            )
                        )):
                            raise ValueError("本次确认未绑定当前作者素材版本")
                    except (OSError, ValueError, TypeError, KeyError) as exc:
                        return {"approved": False, "scope": scope, "reason": str(exc), "run_id": selected_run_id}
                    return {
                        **approval, "approved": True, "path": rel_path, "sha256": digest,
                        "version": version,
                    }
                snapshot_path = str(approval.get("market_snapshot_path") or "")
                snapshot_sha256 = str(approval.get("market_snapshot_sha256") or "")
                if not snapshot_path or not snapshot_sha256:
                    return {"approved": False, "scope": scope, "reason": "确认未绑定 TikOmni 研究快照，需要重新确认", "run_id": selected_run_id}
                from market_signal import verify_frozen_market_snapshot

                frozen = verify_frozen_market_snapshot(self.project, selected_run_id)
                if not frozen.get("verified"):
                    return {
                        "approved": False,
                        "scope": scope,
                        "reason": f"TikOmni 冻结研究快照不可用：{frozen.get('reason') or '未知错误'}",
                        "run_id": selected_run_id,
                    }
                if frozen.get("manifest_path") != snapshot_path or frozen.get("snapshot_sha256") != snapshot_sha256:
                    return {"approved": False, "scope": scope, "reason": "TikOmni 冻结研究快照与本次确认不一致，需要重新确认", "run_id": selected_run_id}
            return {
                "approved": True,
                "scope": scope,
                "run_id": selected_run_id,
                "run_slug": run.get("slug") or "",
                "path": rel_path,
                "sha256": digest,
                "version": version,
                "approved_at": approval.get("approved_at"),
                "method": "human_review",
                **({
                    "market_snapshot_path": approval.get("market_snapshot_path"),
                    "market_snapshot_sha256": approval.get("market_snapshot_sha256"),
                    "market_snapshot_frozen_at": approval.get("market_snapshot_frozen_at"),
                    "visual_template": approval.get("visual_template"),
                } if scope == "topic_template" else {}),
            }

    def approve_blueprint(self, file: str | Path, run_id: str | None = None) -> dict[str, Any]:
        """Backward-compatible wrapper for the canonical topic approval."""
        target, rel_path = self._blueprint_path(file)
        approved = self.approve_artifact("topic_template", rel_path, run_id)
        selected_run_id = approved["run_id"]
        with self._state_lock():
            run = self._load_run_unlocked(selected_run_id, selected_run_id)
            approval = {
                "scope": "blueprint",
                "run_id": selected_run_id,
                "run_slug": run.get("slug") or "",
                "path": rel_path,
                "sha256": approved["sha256"],
                "version": approved["version"],
                "approved_at": approved["approved_at"],
                "method": "human_blueprint_review",
                "market_snapshot_path": approved.get("market_snapshot_path"),
                "market_snapshot_sha256": approved.get("market_snapshot_sha256"),
                "market_snapshot_frozen_at": approved.get("market_snapshot_frozen_at"),
                "visual_template": approved.get("visual_template"),
            }
            run.setdefault("approvals", {})["blueprint"] = approval
            self._save_run_unlocked(run)
        return {"approved": True, "run_id": selected_run_id, **approval}

    def blueprint_approval_status(self, file: str | Path, run_id: str | None = None) -> dict[str, Any]:
        """Return legacy-shaped status without trusting Markdown confirmation text."""
        status = self.approval_status("topic_template", file, run_id)
        if not status.get("approved"):
            return status
        return {
            **status,
            "scope": "blueprint",
            "method": "human_blueprint_review",
        }

    def assert_frozen_tikomni_market_snapshot(self, step: str, run_id: str | None = None) -> dict[str, Any]:
        """Enforce topic approval and its immutable writing source for a write.

        The historical method name remains for Python and TypeScript callers.
        Legacy/platform runs require frozen TikOmni evidence. Only an explicit,
        verified author-material choice uses the independent local source path.
        Missing or failed market research never changes this choice.
        """
        if step not in FROZEN_TIKOMNI_REQUIRED_STEPS:
            return {"required": False, "step": step}

        selected_run_id = self._approval_run_id(run_id)
        run = self.run_state(run_id=selected_run_id)
        blueprint_path = str(((run.get("steps") or {}).get("blueprint") or {}).get("latest") or "")
        if not blueprint_path:
            raise ValueError("当前 runtime run 缺少思想母版蓝图，不能继续下游内容生产")

        approval = self.approval_status("topic_template", blueprint_path, run_id=selected_run_id)
        if not approval.get("approved"):
            raise ValueError(
                "选题与模板确认已失效，不能继续下游内容生产："
                + str(approval.get("reason") or "请重新确认蓝图")
            )

        if run.get("research_mode") == author_evidence.MODE:
            verification = self.verify_author_source(selected_run_id, blueprint_path)
            if any(verification.get(key) != approval.get(key) for key in (
                "research_mode", "author_evidence_path", "author_evidence_sha256",
            )):
                raise ValueError("作者素材确认在核验期间已变化，请重新核对")
            return {"required": True, "step": step, **verification}

        from market_signal import verify_frozen_market_snapshot

        verification = verify_frozen_market_snapshot(self.project, selected_run_id)
        if not verification.get("verified"):
            raise ValueError(
                f"TikOmni 冻结研究快照未通过校验，不能继续 {step}："
                f"{verification.get('reason') or '未知错误'}"
            )
        return {
            "required": True,
            "step": step,
            "run_id": selected_run_id,
            **verification,
        }

    def find_publish_evidence(self, slug: str) -> dict[str, Any]:
        """Find and validate a publish record bound to exactly one slug."""
        safe_slug = self.normalize_slug(slug)
        publish_dir = self.pipeline / STEP_DIRS.get("publish", "publish")
        candidates: list[Path] = []
        if publish_dir.exists():
            for path in publish_dir.glob("*.md"):
                try:
                    frontmatter, _ = self._split_frontmatter(path.read_text(encoding="utf-8"))
                except (OSError, UnicodeError):
                    continue
                if self.normalize_slug(frontmatter.get("slug", "")) == safe_slug:
                    candidates.append(path)
        if not candidates:
            return {"evidence_status": "missing", "path": "", "audit": None}

        target = max(candidates, key=lambda path: path.stat().st_mtime)
        body = self._split_frontmatter(target.read_text(encoding="utf-8"))[1]
        audit = audit_publish(body)
        return {
            "evidence_status": audit.get("evidence_status", "blocked"),
            "path": str(target.relative_to(self.project)),
            "audit": audit,
        }

    def list_runs(self, limit: int = 20) -> list[dict[str, Any]]:
        """列出最近的内容 run。"""
        if not self.runs.exists():
            return []
        items = []
        for path in sorted(self.runs.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            items.append({
                "run_id": data.get("run_id", path.stem),
                "slug": data.get("slug", path.stem),
                "status": data.get("status", "active"),
                "topic": data.get("topic", ""),
                "target_platforms": data.get("target_platforms", []),
                "current_step": data.get("current_step"),
                "updated_at": data.get("updated_at"),
                "path": str(path.relative_to(self.project)),
            })
        return items

    def _schema_file(self, step: str) -> Path | None:
        p = Path(__file__).parent.parent / "schemas" / f"{step}.schema.json"
        return p if p.exists() else None

    def blueprint_platform_scope(self, file: str | Path, run_id: str | None = None) -> dict[str, Any]:
        """Resolve the format from the owning run, never from generated headings."""
        target = self._project_path(str(file), must_exist=True)
        relative = target.relative_to(self.project).as_posix()
        if not run_id:
            owners = [item["run_id"] for item in self.list_runs(limit=len(list(self.runs.glob("*.json"))))
                      if ((self.run_state(run_id=item["run_id"]).get("steps") or {}).get("blueprint") or {}).get("latest") == relative]
            if len(owners) != 1:
                return check_platform_scope("", None)
            run_id = owners[0]
        run = self.run_state(run_id=run_id)
        if run.get("schema") == LEGACY_PRODUCTION_RUN_SCHEMA:
            return {"scope_status": "legacy", "scope_matches": False, "quality_verified": False,
                    "issues": ["旧版方案按历史格式读取，不代表已完成本期平台范围检查。"]}
        try:
            if run.get("schema") != PRODUCTION_RUN_SCHEMA:
                raise ValueError("无法识别本期平台契约")
            if ((run.get("steps") or {}).get("blueprint") or {}).get("latest") != relative:
                raise ValueError("只能检查本期最新方案，请重新读取")
            body = target.read_text(encoding="utf-8")
            if run.get("research_mode") == author_evidence.MODE:
                expected = author_evidence.verified_record(self.project, run, body)["target_platforms"]
            else:
                binding = self._topic_snapshot_binding(target, run_id)
                from market_signal import verify_market_snapshot
                verified = verify_market_snapshot(self.project, run_id, binding["market_snapshot_path"])
                if not verified.get("verified"):
                    raise ValueError("本期研究记录无法核对")
                market_ids = {"wechat_mp": "wechat", "xiaohongshu": "xhs", "wechat_channels": "shipinhao"}
                expected = [market_ids.get(platform, platform) for platform in verified.get("required_platforms", [])]
            if sorted(expected) != sorted(run.get("target_platforms") or []) or sorted(expected) != sorted(run.get("selected_platforms") or []):
                raise ValueError("方案依据的平台与本期选择不一致，请重新核对")
            return {**check_platform_scope(body, expected), "run_id": run_id,
                    "path": relative, "sha256": self._sha256_file(target)}
        except (OSError, ValueError, KeyError, TypeError) as exc:
            return {**check_platform_scope("", None), "issues": [str(exc)]}

    def _assert_blueprint_platform_scope(self, target: Path, run_id: str) -> None:
        scope = self.blueprint_platform_scope(target, run_id)
        if scope["scope_status"] == "legacy":
            if not self.validate("blueprint", str(target), run_id).get("valid"):
                raise ValueError("旧版方案未满足历史格式要求，请核对完整方案")
            return
        if not scope["scope_matches"]:
            raise ValueError("方案已保存，平台范围需要修改：" + "；".join(scope["issues"]))

    def validate(self, step: str, file: str, run_id: str | None = None) -> dict[str, Any]:
        """基于 JSON Schema 校验文件结构，无 schema 时回退到 REQUIRED_SECTIONS。"""
        target = self._project_path(file, must_exist=True)
        if not target.exists():
            raise FileNotFoundError(f"文件不存在: {target}")

        text = target.read_text(encoding="utf-8")
        frontmatter, body = self._split_frontmatter(text)
        schema_path = self._schema_file(step)
        if step == "blueprint":
            scope = self.blueprint_platform_scope(target, run_id)
            if scope["scope_status"] != "legacy":
                missing_fm = [key for key in ("step", "slug", "date", "source") if not frontmatter.get(key)]
                return {
                    "path": str(target), "step": step,
                    "valid": scope["scope_matches"] and not missing_fm and frontmatter.get("step") == step,
                    "contract": "echo-founder.platform-blueprint.v1", "platform_scope": scope,
                    "missing_frontmatter": missing_fm, "step_invalid": frontmatter.get("step") != step,
                    "quality_status": "review_required", "quality_verified": False,
                    "quality_errors": scope["issues"],
                    "quality_reviews": ["事实、表达和公开边界仍需作者核对。"],
                }

        if schema_path:
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            common = json.loads((schema_path.parent / "common.json").read_text(encoding="utf-8"))
            fm_schema = common.get("properties", {}).get("frontmatter", {})
            fm_required = fm_schema.get("required", [])
            missing_fm = [k for k in fm_required if not frontmatter.get(k)]
            step_enum = fm_schema.get("properties", {}).get("step", {}).get("enum", [])
            step_invalid = step_enum and frontmatter.get("step") not in step_enum
            def collect_patterns(prop: dict[str, Any]) -> list[list[str]]:
                if "anyOf" in prop:
                    variants = []
                    for variant in prop.get("anyOf", []):
                        variant_patterns = [
                            item.get("pattern")
                            for item in variant.get("allOf", [])
                            if item.get("pattern")
                        ]
                        variants.append(variant_patterns)
                    return variants
                return [[item.get("pattern") for item in prop.get("allOf", []) if item.get("pattern")]]

            pattern_variants: list[list[str]] = []
            for prop in schema.get("properties", {}).values():
                if isinstance(prop, dict):
                    pattern_variants.extend(collect_patterns(prop))
            pattern_errors = []
            if pattern_variants:
                matching_variant = next(
                    (variant for variant in pattern_variants if all(re.search(pat, body) for pat in variant)),
                    None,
                )
                if matching_variant is None:
                    shortest = min(pattern_variants, key=len)
                    pattern_errors = [pat for pat in shortest if not re.search(pat, body)]
            advisory_pattern_errors = []
            if step in {"write", "package"} and pattern_errors:
                advisory_pattern_errors = list(pattern_errors)
                pattern_errors = []
            quality_audit = None
            quality_errors = []
            quality_reviews = [
                f"格式字段缺失但已直接生效：{pattern}"
                for pattern in advisory_pattern_errors
            ]
            if step == "intake" and not pattern_errors:
                quality_audit = audit_intake(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "validate" and not pattern_errors:
                quality_audit = audit_validate(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "blueprint" and not pattern_errors:
                quality_audit = audit_blueprint(body)
                quality_errors = quality_audit.get("blocking_issues", quality_audit.get("errors", []))
                quality_reviews = quality_audit.get("review_issues", quality_audit.get("reviews", []))
            elif step == "angle" and not pattern_errors:
                quality_audit = audit_angle(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "breakdown" and not pattern_errors:
                quality_audit = audit_breakdown(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "dbs-fusion" and not pattern_errors:
                quality_audit = audit_dbs_fusion(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "write" and not pattern_errors:
                quality_audit = audit_write(body)
                editorial_issues = list(quality_audit.get("blocking_issues", []))
                quality_errors = []
                quality_reviews += editorial_issues + list(quality_audit.get("review_issues", []))
                if editorial_issues:
                    quality_audit = {**quality_audit, "status": "review_required"}
            elif step == "package" and not pattern_errors:
                quality_audit = (
                    run_release_gate(body)
                    if "0. 共享事实底稿" in body
                    else audit_package(body)
                )
                editorial_issues = list(quality_audit.get("blocking_issues", quality_audit.get("errors", [])))
                quality_errors = []
                quality_reviews += editorial_issues + list(
                    quality_audit.get("review_issues", quality_audit.get("reviews", []))
                )
                if editorial_issues:
                    quality_audit = {**quality_audit, "status": "review_required"}
            elif step == "xhs" and not pattern_errors:
                quality_audit = audit_xhs(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "platform-adapt" and not pattern_errors:
                quality_audit = audit_platform_adapt(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "visual" and not pattern_errors:
                quality_audit = audit_visual(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "prelaunch" and not pattern_errors:
                quality_audit = audit_prelaunch(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "compliance" and not pattern_errors:
                quality_audit = audit_compliance(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "audit" and not pattern_errors:
                quality_audit = audit_audit(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "publish" and not pattern_errors:
                quality_audit = audit_publish(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "performance" and not pattern_errors:
                quality_audit = audit_performance(body)
                quality_errors = quality_audit.get("blocking_issues", quality_audit.get("errors", []))
                quality_reviews = quality_audit.get("review_issues", quality_audit.get("reviews", []))
            elif step == "review" and not pattern_errors:
                quality_audit = audit_review(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "archive" and not pattern_errors:
                quality_audit = audit_archive(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            elif step == "twin" and not pattern_errors:
                quality_audit = audit_twin(body)
                quality_errors = quality_audit.get("blocking_issues", [])
                quality_reviews = quality_audit.get("review_issues", [])
            return {
                "path": str(target),
                "step": step,
                "valid": not missing_fm and not step_invalid and not pattern_errors and not quality_errors,
                "schema": str(schema_path),
                "missing_frontmatter": missing_fm,
                "step_invalid": step_invalid,
                "missing_patterns": pattern_errors,
                "quality_status": quality_audit.get("status") if quality_audit else None,
                "quality_errors": quality_errors,
                "quality_reviews": quality_reviews,
                "quality_checks": quality_audit.get("checks") if quality_audit else None,
                **({"contract": "aifios.legacy-blueprint.v1", "platform_scope": {
                    **scope, "legacy_contract_validated": not missing_fm and not step_invalid and not pattern_errors and not quality_errors,
                }} if step == "blueprint" else {}),
            }

        if step == "package" and "0. 共享事实底稿" in body:
            required = ["0. 共享事实底稿"]
            if not any(section in body for section in ("1. 公众号原生长文", "2. 小红书原生图文", "3. 视频号原生口播")):
                required = [*required, "至少一个平台原生内容"]
        else:
            required = REQUIRED_SECTIONS.get(step, [])
        missing = [s for s in required if s not in body]
        return {
            "path": str(target),
            "step": step,
            "valid": len(missing) == 0,
            "missing_sections": missing,
            "required_sections": required,
            **({"contract": "aifios.legacy-blueprint.v1", "platform_scope": {
                **scope, "legacy_contract_validated": not missing,
            }} if step == "blueprint" else {}),
        }

    def brain(self, file: str, content: str | None = None, read: bool = False) -> dict[str, Any]:
        """追加或读取 brain 文件。"""
        target = self._brain_path(file, must_exist=read)
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="content-runtime")
    parser.add_argument("--project", required=True, help="AI content system 项目根目录")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="初始化项目目录")
    p_init.add_argument("--demo", action="store_true", help="同时生成示例项目")

    p_write = sub.add_parser("write", help="写入步骤输出")
    p_write.add_argument("--step", required=True, choices=STEPS)
    p_write.add_argument("--slug", required=True)
    p_write.add_argument("--content", required=True, help="内容字符串或 @file_path")
    p_write.add_argument("--source", default=None)
    p_write.add_argument("--run-id", default=None, help="下游生产步骤必须绑定的 runtime run")
    p_write.add_argument("--expected-path", default=None, help="修改所依据的当前版本路径")
    p_write.add_argument("--expected-blueprint-path", default=None, help="局部修改主动带入的方案路径")
    p_write.add_argument("--expected-blueprint-sha256", default=None, help="局部修改主动带入的方案校验值")
    p_write.add_argument("--expected-sha256", default=None, help="修改所依据的当前版本 SHA-256")
    p_write.add_argument("--require-valid", action="store_true", help="通过质量检查后才更新当前版本")
    p_write.add_argument(
        "--unbound-report",
        action="store_true",
        help="仅导入未绑定生产 run 的 performance 证据；不能用于发布或复盘放行",
    )

    p_read = sub.add_parser("read", help="读取步骤输出")
    p_read.add_argument("--step", required=True, choices=STEPS)
    p_read.add_argument("--latest", action="store_true")
    p_read.add_argument("--file", default=None)
    p_read.add_argument("--slug", default=None, help="读取指定 slug 的最新文件")
    p_read.add_argument("--summary", action="store_true", help="只读取轻量摘要，不返回完整正文")

    p_list = sub.add_parser("list", help="列出最近文件")
    p_list.add_argument("--days", type=int, default=7)

    sub.add_parser("state", help="读取 session state")

    p_runs = sub.add_parser("runs", help="列出最近内容 run")
    p_runs.add_argument("--limit", type=int, default=20)

    p_run = sub.add_parser("run", help="读取单条内容 run 状态")
    p_run.add_argument("--run-id", default=None)
    p_run.add_argument("--slug", default=None)

    p_run_create = sub.add_parser("run-create", help="创建并激活一条内容 run")
    p_run_create.add_argument("--topic", default="", help="本条内容主题")
    p_run_create.add_argument(
        "--platforms",
        default="",
        help="目标平台，可选公众号、小红书、视频号；默认三平台协同",
    )
    p_run_create.add_argument("--slug", default=None, help="可选 slug；默认从 topic 生成")
    p_run_create.add_argument("--run-id", default=None, help="可选 run_id；默认从 slug 生成")
    p_run_create.add_argument("--goal", default="", help="本条内容的业务目标")
    p_run_create.add_argument("--success-metric", default="", help="本条内容的成功指标")
    p_run_create.add_argument("--baseline", default=None, help="成功指标基线")
    p_run_create.add_argument("--target", default=None, help="成功指标目标")
    p_run_create.add_argument("--visual-template", default=DEFAULT_VISUAL_LAYOUT_THEME, help="本期 md2wechat 排版主题")
    p_run_create.add_argument("--project-id", default="default", help="客户/项目隔离标识")

    p_run_template = sub.add_parser("run-template-set", help="更新当前内容 run 的整体品牌排版模板")
    p_run_template.add_argument("--run-id", required=True)
    p_run_template.add_argument("--visual-template", required=True)

    p_run_visual = sub.add_parser("run-visual-preferences-set", help="更新当前内容 run 的视觉生成方式")
    p_run_visual.add_argument("--run-id", required=True)
    p_run_visual.add_argument("--mode", required=True, choices=VISUAL_MODES)
    p_run_visual.add_argument("--direction-count", type=int, default=2, choices=(2,))
    p_run_visual.add_argument("--provider-policy", default="auto", choices=VISUAL_PROVIDER_POLICIES)

    p_run_platforms = sub.add_parser("run-platforms-set", help="在公开研究冻结前选择本期平台")
    p_run_platforms.add_argument("--run-id", required=True)
    p_run_platforms.add_argument("--platforms", required=True, help="公众号、小红书、视频号中的一个或多个")
    p_run_platforms.add_argument("--confirm", action="store_true", help="确认本期平台选择")

    p_run_topic = sub.add_parser("run-topic-set", help="在当前内容 run 中保存已选或已改写主题")
    p_run_topic.add_argument("--run-id", required=True)
    p_run_topic.add_argument("--topic", required=True)
    p_run_topic.add_argument("--snapshot", required=True, help="本期已验证的 TikOmni 研究快照")
    p_run_topic.add_argument("--snapshot-sha256", required=True)
    p_run_topic.add_argument("--suggestion-id", default="")

    p_author_context = sub.add_parser("author-source-context", help="读取按作者素材写作所需的版本")
    p_author_context.add_argument("--run-id", required=True)
    p_author_select = sub.add_parser("author-source-select", help="明确选择作者素材作为写作依据，不进行平台研究")
    p_author_select.add_argument("--content", required=True, help="带操作编号和所见版本的 JSON 或 @file")
    p_author_verify = sub.add_parser("author-source-verify", help="核对当前作者素材及可选写作方案")
    p_author_verify.add_argument("--run-id", required=True)
    p_author_verify.add_argument("--file", default=None)
    p_source_verify = sub.add_parser("writing-source-verify", help="核对经作者确认的当前写作依据")
    p_source_verify.add_argument("--run-id", required=True)
    p_source_verify.add_argument("--step", required=True, choices=sorted(FROZEN_TIKOMNI_REQUIRED_STEPS))

    p_run_switch = sub.add_parser("run-switch", help="切换当前激活 run")
    p_run_switch.add_argument("--run-id", required=True)

    p_run_resume = sub.add_parser("run-resume", help="恢复当前或指定 run")
    p_run_resume.add_argument("--run-id", default=None)

    p_run_archive = sub.add_parser("run-archive", help="归档当前或指定 run")
    p_run_archive.add_argument("--run-id", default=None)

    p_blueprint_approve = sub.add_parser("blueprint-approve", help="确认当前思想母版蓝图")
    p_blueprint_approve.add_argument("--file", required=True)
    p_blueprint_approve.add_argument("--run-id", default=None)

    p_blueprint_approval = sub.add_parser("blueprint-approval", help="读取思想母版蓝图确认状态")
    p_blueprint_approval.add_argument("--file", required=True)
    p_blueprint_approval.add_argument("--run-id", default=None)

    p_phase_register = sub.add_parser("phase-artifact-register", help="绑定视觉、草稿或发布台账等阶段产物")
    p_phase_register.add_argument("--scope", required=True, choices=APPROVAL_SCOPES)
    p_phase_register.add_argument("--file", required=True)
    p_phase_register.add_argument("--run-id", default=None)

    p_approval_approve = sub.add_parser("approval-approve", help="确认当前阶段产物")
    p_approval_approve.add_argument("--scope", required=True, choices=APPROVAL_SCOPES)
    p_approval_approve.add_argument("--file", required=True)
    p_approval_approve.add_argument("--run-id", default=None)
    p_approval_approve.add_argument("--reviewed-plan-sha256", default=None)
    p_approval_approve.add_argument("--reviewed-material-correction-id", default=None)

    p_correction = sub.add_parser("material-correction-apply", help="保存作者修正并使相关确认失效")
    p_correction.add_argument("--content", required=True, help="修正 JSON 或 @file_path")

    p_content_plan = sub.add_parser("content-plan-status", help="核对正文与写作方案的版本")
    p_content_plan.add_argument("--run-id", required=True)

    p_approval_status = sub.add_parser("approval-status", help="读取当前阶段产物确认状态")
    p_approval_status.add_argument("--scope", required=True, choices=APPROVAL_SCOPES)
    p_approval_status.add_argument("--file", required=True)
    p_approval_status.add_argument("--run-id", default=None)

    p_val = sub.add_parser("validate", help="校验文件结构")
    p_val.add_argument("--step", required=True, choices=STEPS)
    p_val.add_argument("--file", required=True)
    p_val.add_argument("--run-id", default=None)

    p_brain = sub.add_parser("brain", help="追加/读取 brain 文件")
    p_brain.add_argument("--file", required=True, help="brain 文件相对路径，如 insights.md")
    p_brain.add_argument("--content", default=None, help="追加内容字符串或 @file_path；与 --read 互斥")
    p_brain.add_argument("--read", action="store_true", help="读取 brain 文件")

    args = parser.parse_args(argv)
    rt = ContentRuntime(args.project)

    try:
        if args.command == "init":
            print(json.dumps(rt.init(demo=args.demo), ensure_ascii=False, indent=2))
        elif args.command == "write":
            content = args.content
            if content.startswith("@"):
                content = Path(content[1:]).read_text(encoding="utf-8")
            if args.step in FROZEN_TIKOMNI_REQUIRED_STEPS and not args.run_id and not args.unbound_report:
                raise ValueError(f"步骤 {args.step} 必须提供 --run-id，才能验证已冻结的 TikOmni 研究快照")
            print(json.dumps(
                rt.write(
                    args.step,
                    args.slug,
                    content,
                    args.source,
                    args.run_id,
                    unbound_report=args.unbound_report,
                    expected_path=args.expected_path,
                    expected_sha256=args.expected_sha256,
                    expected_blueprint_path=args.expected_blueprint_path,
                    expected_blueprint_sha256=args.expected_blueprint_sha256,
                    require_valid=args.require_valid,
                ),
                ensure_ascii=False,
                indent=2,
            ))
        elif args.command == "material-correction-apply":
            raw = Path(args.content[1:]).read_text(encoding="utf-8") if args.content.startswith("@") else args.content
            print(json.dumps(rt.apply_material_correction(json.loads(raw)), ensure_ascii=False))
        elif args.command == "read":
            print(json.dumps(rt.read(args.step, args.latest, args.file, args.slug, args.summary), ensure_ascii=False, indent=2))
        elif args.command == "list":
            print(json.dumps(rt.list_recent(args.days), ensure_ascii=False, indent=2))
        elif args.command == "state":
            print(json.dumps(rt.state(), ensure_ascii=False, indent=2))
        elif args.command == "runs":
            print(json.dumps(rt.list_runs(args.limit), ensure_ascii=False, indent=2))
        elif args.command == "run":
            print(json.dumps(rt.run_state(args.run_id, args.slug), ensure_ascii=False, indent=2))
        elif args.command == "author-source-context":
            print(json.dumps(rt.author_source_context(args.run_id), ensure_ascii=False))
        elif args.command == "author-source-select":
            raw = Path(args.content[1:]).read_text(encoding="utf-8") if args.content.startswith("@") else args.content
            print(json.dumps(rt.select_author_source(json.loads(raw)), ensure_ascii=False))
        elif args.command == "author-source-verify":
            print(json.dumps(rt.verify_author_source(args.run_id, args.file), ensure_ascii=False))
        elif args.command == "writing-source-verify":
            print(json.dumps(rt.assert_frozen_tikomni_market_snapshot(args.step, args.run_id), ensure_ascii=False))
        elif args.command == "run-create":
            print(json.dumps(rt.create_run(
                args.topic,
                args.platforms,
                args.slug,
                args.run_id,
                business_goal=args.goal,
                success_metric=args.success_metric,
                baseline=args.baseline,
                target=args.target,
                visual_template=args.visual_template,
                project_id=args.project_id,
            ), ensure_ascii=False, indent=2))
        elif args.command == "run-template-set":
            print(json.dumps(rt.set_visual_template(args.run_id, args.visual_template), ensure_ascii=False, indent=2))
        elif args.command == "run-visual-preferences-set":
            print(json.dumps(rt.set_visual_preferences(
                args.run_id,
                args.mode,
                args.direction_count,
                args.provider_policy,
            ), ensure_ascii=False, indent=2))
        elif args.command == "run-platforms-set":
            print(json.dumps(rt.set_platforms(
                args.run_id,
                args.platforms,
                confirm=args.confirm,
            ), ensure_ascii=False, indent=2))
        elif args.command == "run-topic-set":
            print(json.dumps(rt.set_topic(
                args.run_id,
                args.topic,
                args.snapshot,
                args.snapshot_sha256,
                args.suggestion_id,
            ), ensure_ascii=False, indent=2))
        elif args.command == "run-switch":
            print(json.dumps(rt.switch_run(args.run_id), ensure_ascii=False, indent=2))
        elif args.command == "run-resume":
            print(json.dumps(rt.resume_run(args.run_id), ensure_ascii=False, indent=2))
        elif args.command == "run-archive":
            print(json.dumps(rt.archive_run(args.run_id), ensure_ascii=False, indent=2))
        elif args.command == "blueprint-approve":
            print(json.dumps(rt.approve_blueprint(args.file, args.run_id), ensure_ascii=False, indent=2))
        elif args.command == "blueprint-approval":
            print(json.dumps(rt.blueprint_approval_status(args.file, args.run_id), ensure_ascii=False, indent=2))
        elif args.command == "phase-artifact-register":
            print(json.dumps(rt.register_phase_artifact(args.scope, args.file, args.run_id), ensure_ascii=False, indent=2))
        elif args.command == "approval-approve":
            print(json.dumps(rt.approve_artifact(args.scope, args.file, args.run_id, args.reviewed_plan_sha256, args.reviewed_material_correction_id), ensure_ascii=False, indent=2))
        elif args.command == "content-plan-status":
            print(json.dumps(rt.content_plan_status(args.run_id), ensure_ascii=False, indent=2))
        elif args.command == "approval-status":
            print(json.dumps(rt.approval_status(args.scope, args.file, args.run_id), ensure_ascii=False, indent=2))
        elif args.command == "validate":
            print(json.dumps(rt.validate(args.step, args.file, args.run_id), ensure_ascii=False, indent=2))
        elif args.command == "brain":
            content = args.content
            if content and content.startswith("@"):
                content = Path(content[1:]).read_text(encoding="utf-8")
            print(json.dumps(rt.brain(args.file, content, args.read), ensure_ascii=False, indent=2))
    except RuntimeOutputValidationError as e:
        print(json.dumps({"error": str(e), "code": "runtime_output_invalid", "validation": e.validation}, ensure_ascii=False), file=sys.stderr)
        return 1
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
