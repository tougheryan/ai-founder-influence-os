#!/usr/bin/env python3
"""content-runtime/session_manager.py · 通用会话状态管理器

提供 content 全家桶通用的 Context Boot、状态恢复与模块路由。
状态文件默认保存在项目 sessions/session-state.json。

用法:
    python session_manager.py --project ~/ai-content-system start ["我想写公众号"]
    python session_manager.py --project ~/ai-content-system boot [--force]
    python session_manager.py --project ~/ai-content-system guide "我想写公众号"
    python session_manager.py --project ~/ai-content-system route "帮我写获客稿"
    python session_manager.py --project ~/ai-content-system update --section knowledge_log --content "..."
    python session_manager.py --project ~/ai-content-system state
"""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from content_runtime import ContentRuntime
from content_pipeline import PipelineDirector
from market_signal import build_theme_gate_response


DEFAULT_SECTIONS = {
    "positioning": {
        "offer": "",
        "target": "",
        "core_reason": "",
        "enemy": "",
        "gap": "",
    },
    "target_platforms": [],
    "topic_tracking": [],
    "script_tracking": [],
    "pending": [],
    "knowledge_log": [],
    "calibration_log": [],
    "observations": {"common_issues": [], "high_signals": [], "breakpoints": []},
    "summary": "",
}

ROUTE_RULES = [
    # 高优先级：先判断任务类型，再判断平台，避免“公众号爆款对标”误进写稿。
    (["爆款", "对标", "采集", "样本", "标杆", "竞品", "benchmark", "hit"], "content-hit-collector", "爆款收集与对标"),
    (["思想母版", "母版蓝图", "创作蓝图", "blueprint"], "content-blueprint", "思想母版蓝图"),
    (["最终内容", "package", "2条口播", "两条口播", "短视频口播", "视频号", "抖音", "朋友圈文案", "3条图文", "三条图文"], "content-package", "一稿五发最终内容"),
    (["数据回流", "公众号数据", "作品数据", "performance", "自动抓取数据"], "content-performance-collector", "发布数据回流"),
    (["/dbs-wechat-html", "公众号html", "公众号 html", "公众号排版", "微信排版", "生成公众号 html"], "dbs-wechat-html", "公众号基础 HTML 回退"),
    (["公众号封面", "公众号头图", "公众号分享卡"], "xhs-card", "公众号封面/分享卡"),
    (["小红书卡片", "社交卡片", "卡片图", "封面卡片"], "xhs-card", "小红书卡片"),
    (["传播心理解码", "为什么这个能火", "受众想听什么", "打中了什么情绪", "dbs-spread"], "dbs-spread", "传播心理解码"),
    (["有没有戳中人", "共鸣诊断", "能不能发", "文稿发出去", "dbs-resonate"], "dbs-resonate", "文稿共鸣诊断"),
    (["商业诊断", "商业模式", "商业表达", "变现", "转化诊断"], "content-dbs-fusion", "商业诊断"),
    (["配图", "视觉", "visual", "封面图", "头图", "插图", "手绘", "小黑"], "content-visual", "文章配图"),
    (["发布前", "prelaunch", "检查清单"], "content-prelaunch", "发布前检查"),
    (["合规", "compliance", "违禁词", "广告法", "平台规则"], "content-compliance", "平台合规"),
    (["审核", "audit", "可信", "事实校验", "来源"], "content-audit", "可信审核"),
    (["复盘", "review", "数据", "发布后", "评论洞察"], "content-review", "数据复盘"),
    (["归档", "archive", "沉淀", "知识库回流"], "self-archive", "自我沉淀"),
    (["孪生", "twin", "数字孪生", "风格镜像"], "content-twin", "数字孪生"),
    (["立项", "validate", "值不值得做", "能不能做"], "content-validate", "立项决策"),
    (["拆解", "breakdown", "关键词", "标题", "钩子"], "content-breakdown", "内容拆解"),
    (["公众号", "长文", "wechat", "写文章", "写稿子"], "wechat-writer", "公众号长文"),
    (["小红书", "xhs", "种草", "图文", "封面"], "xhs-card", "小红书图文"),
    (["改编", " repurpos", "一鱼多吃", "跨平台"], "content-repurpose", "跨平台改编"),
    (["角度", "angle", "选题", "切入点"], "content-angle", "角度清单"),
    (["素材", "intake", "输入", "给我看看", "理解了"], "content-intake", "素材理解"),
]

MATERIAL_TO_CONTENT_SIGNALS = [
    "根据这段素材",
    "从这个素材",
    "这段素材",
    "这段话",
    "这篇素材",
    "输入素材",
    "原始素材",
    "聊天记录",
    "访谈稿",
    "录音稿",
    "文字稿",
]

CONTENT_GENERATION_SIGNALS = [
    "生成内容",
    "出成稿",
    "出内容",
    "做成公众号",
    "做成短视频",
    "做成图文",
    "公众号和短视频",
    "短视频和图文",
    "最终内容",
    "直接出",
]

ANALYSIS_ONLY_SIGNALS = [
    "分析这个素材",
    "分析素材",
    "理解素材",
    "素材理解",
    "先不要出成稿",
    "不要直接生成内容",
    "只分析",
]

ANGLE_DETAIL_SIGNALS = [
    "角度详细比较",
    "详细比较",
    "角度对比",
    "几个角度",
    "不要直接生成内容",
]

THEME_OPTION_CHOICES = "ABCDEF"
THEME_OPTION_COUNT = len(THEME_OPTION_CHOICES)

CONFIRMED_PACKAGE_SIGNALS = [
    "主题已经确认",
    "主题已确认",
    "已确认主题",
    "按这个主题",
]

NEGATED_CONFIRM_PREFIX_RE = re.compile(
    r"(?:(?:不要|不是|并不是|别|并非|无|未|不)[^，。；、,.!?！？]{0,8}|"
    r"(?:没有|没)(?:选|选择|用|按|要|让|想)?\s*)$"
)
EXPLICIT_CHOICE_CONFIRM_RE = re.compile(
    rf"(?:我选|选择|选|就用|用|按)\s*[{THEME_OPTION_CHOICES.lower()}]\s*(?:(?:直接)?(?:生成|继续)|$|[，。；、,.!?！？])"
)
INVALID_EXPLICIT_CHOICE_CONFIRM_RE = re.compile(
    r"(?:我选|选择|选|就用|用|按)\s*[g-j]\s*(?:(?:直接)?(?:生成|继续)|$|[，。；、,.!?！？])"
)

THEME_GATE_ACTION = """先确认一个最值得写的主题。

爆款参考不足：按素材支撑和平台适配优先评分。

| 选项 | 主题 | 推荐受众 | 总分 | 爆款机制参考 | 适合原因 | 风险边界 | 推荐平台 | 素材命中依据 |
|---|---|---|---:|---|---|---|---|---|
| A | 把一个具体问题写成可传播的判断 | 需要把素材转成可发布内容的创始人或内容负责人 | 70 | 问题聚焦 + 清单表达 | 方向较宽时，先把一个具体问题讲透，比堆信息更稳。 | 不补写素材里没有的人物、数据和结果。 | 公众号 / 小红书 | 素材命中：具体问题 |
| B | 从真实场景切入，写出可执行经验 | 需要把素材转成可发布内容的创始人或内容负责人 | 68 | 场景开头 + 经验提炼 | 用具体场景开头，能降低泛泛而谈的风险。 | 避免把个人体验包装成普遍结论。 | 公众号 / 小红书 | 素材命中：真实场景 |
| C | 把一次经历提炼成普通人能照做的方法 | 需要把素材转成可发布内容的创始人或内容负责人 | 66 | 方法论清单 + 轻案例 | 适合把零散素材整理成有结构的内容。 | 方法只写可验证步骤，不做过度承诺。 | 公众号 / 小红书 | 素材命中：经历、方法 |
| D | 用误区对比讲清一个选择 | 需要把素材转成可发布内容的创始人或内容负责人 | 64 | 误区对比 + 选择建议 | 对比结构能让主题更容易被理解和转发。 | 对比不要制造对立，保留适用条件。 | 公众号 / 小红书 | 素材命中：误区、选择 |
| E | 把读者最关心的问题做成一张清单 | 需要把素材转成可发布内容的创始人或内容负责人 | 62 | 问题清单 + 行动建议 | 清单式表达适合低风险、强可读的泛素材。 | 不虚构读者反馈，只从素材可见问题出发。 | 小红书 / 公众号 | 素材命中：读者问题 |
| F | 从风险边界出发，写一篇稳妥分析 | 需要把素材转成可发布内容的创始人或内容负责人 | 60 | 边界声明 + 稳健判断 | 当素材缺少强商业线索时，稳妥分析更合适。 | 不使用具体硬数字，不放大个别经验。 | 公众号 | 素材命中：风险边界 |

我推荐主题 A，默认受众是：需要把素材转成可发布内容的创始人或内容负责人。

回复 A-F 中任一主题；如果要换受众，可以写“主题 A + 受众：你想服务的人群”。"""

THEME_GATE_FORBIDDEN_TERMS = [
    "内部分析",
    "角度报告",
    "蓝图过程",
    "素材理解报告",
    "角度生成报告",
    "思想母版蓝图",
    "资产包说明",
    "Traceback",
    "traceback",
    "RuntimeError",
    "Exception",
]

SKILL_USER_ACTIONS = {
    "content-intake": "把素材贴过来：想法、聊天记录、文章链接、访谈稿、PDF 摘要都可以。我会先做素材理解。",
    "content-validate": "把确认主题和素材发来，我会先核对公开样本对标，再判断它值不值得做、适合先发哪个阵地。",
    "content-blueprint": "给我通过立项的 validate 报告和爆款对标输入，我会生成公众号思想母版蓝图。",
    "content-angle": "告诉我你想服务的人群和核心观点，我会生成可选角度。",
    "content-breakdown": "给我选定角度或已有素材，我会拆标题、关键词、钩子和封面文案。",
    "wechat-writer": "给我主题、目标读者和你想表达的判断，我会写公众号长文。",
    "content-package": "给我公众号思想母版或成稿，我会生成 1 篇公众号长文、2 条短视频口播执行稿和 2-3 条观点图文发布稿（至少 1 条）。",
    "content-performance-collector": "给我发布链接、作品 ID 或授权数据源，我会生成数据回流报告供复盘使用。",
    "xhs-card": "给我主题、标题方向或已有文章，我会做小红书图文/卡片方案。",
    "dbs-wechat-html": "md2wechat 不可用时的公众号基础 HTML 回退；不再向用户提供独立主题目录。",
    "dbs-spread": "给我对标内容、爆款样本或话题片段，我会解码受众情绪底层、有效立场和还想听什么。",
    "dbs-resonate": "给我成稿或半成稿，我会诊断核心机制、共鸣结构和具体删改方向。",
    "content-hit-collector": "告诉我阵地、关键词、对标账号或链接；也可以先运行浏览器登录态采集。",
    "content-visual": "给我最终内容，我会生成公众号 HTML、封面分享卡、小红书图卡和正文配图。",
    "content-repurpose": "给我一个阵地的成稿，我会改成公众号、小红书、视频号、抖音或朋友圈的发布版本。",
    "content-prelaunch": "给我准备发布的成稿，我会做发布前检查清单。",
    "content-compliance": "给我成稿，我会扫描平台规则、广告法和版权风险。",
    "content-audit": "给我成稿和关键事实来源，我会做可信审核。",
    "content-review": "给我发布后的数据和评论，我会做复盘和下一条建议。",
    "self-archive": "给我本次内容产物和结果，我会归档成可复用资产。",
    "content-twin": "给我最终发布内容，我会提取你的风格和内容 DNA。",
    "content-dbs-fusion": "把业务、产品、转化或表达问题讲清楚，我会做商业诊断。",
}

PLATFORM_LABELS = {
    "wechat": "公众号",
    "xhs": "小红书",
    "shipinhao": "视频号",
    "douyin": "抖音",
    "moments": "朋友圈",
}

PLATFORM_KEYWORDS = {
    "wechat": ["公众号", "微信公号", "微信文章", "长文", "wechat"],
    "xhs": ["小红书", "xhs", "rednote", "图文"],
    "shipinhao": ["视频号", "微信视频号", "shipinhao", "channels"],
    "douyin": ["抖音", "抖音号", "douyin", "短视频"],
    "moments": ["朋友圈", "微信朋友圈", "moments"],
}


@dataclass
class SessionState:
    positioning: dict[str, str] = field(default_factory=lambda: DEFAULT_SECTIONS["positioning"].copy())
    target_platforms: list[str] = field(default_factory=list)
    topic_tracking: list[dict[str, Any]] = field(default_factory=list)
    script_tracking: list[dict[str, Any]] = field(default_factory=list)
    pending: list[str] = field(default_factory=list)
    knowledge_log: list[str] = field(default_factory=list)
    calibration_log: list[str] = field(default_factory=list)
    observations: dict[str, list[str]] = field(default_factory=lambda: {"common_issues": [], "high_signals": [], "breakpoints": []})
    summary: str = ""
    updated_at: str = ""
    boot_count: int = 0

    def touch(self):
        self.updated_at = datetime.now().isoformat()


class SessionManager:
    def __init__(self, project: Path | str):
        self.rt = ContentRuntime(project)
        self.rt.init()
        self.state_file = self.rt.sessions / "session-state.json"
        self.state_lock_file = self.rt.sessions / ".session-state.lock"
        self._state: SessionState | None = None

    @contextlib.contextmanager
    def _state_lock(self):
        self.rt.sessions.mkdir(parents=True, exist_ok=True)
        with self.state_lock_file.open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)

    def load(self) -> SessionState:
        if self._state is not None:
            return self._state
        with self._state_lock():
            if self.state_file.exists():
                data = json.loads(self.state_file.read_text(encoding="utf-8"))
                self._state = SessionState(**data)
            else:
                self._state = SessionState()
        return self._state

    def save(self) -> None:
        state = self.load()
        state.touch()
        with self._state_lock():
            tmp = self.state_file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(asdict(state), ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self.state_file)

    def set_target_platforms(self, platforms: list[str]) -> list[str]:
        normalized = []
        for platform in platforms:
            if platform in PLATFORM_LABELS and platform not in normalized:
                normalized.append(platform)
        if normalized:
            state = self.load()
            state.target_platforms = normalized
            self.save()
        return normalized

    def onboard(self, goal: str = "", platforms: str = "", offer: str = "", target: str = "", product: str = "") -> dict[str, Any]:
        """首次使用配置：记录目标阵地、业务、用户、产品。"""
        state = self.load()
        detected = detect_target_platforms(platforms or goal)
        if detected:
            state.target_platforms = []
            self._state = state
            self.set_target_platforms(detected)
            state = self.load()
        if offer:
            state.positioning["offer"] = offer.strip()
        if target:
            state.positioning["target"] = target.strip()
        if product:
            state.positioning["core_reason"] = product.strip()
        if goal:
            state.summary = goal.strip()
        if not state.positioning.get("gap"):
            state.positioning["gap"] = "等待第一批素材或爆款对标样本"
        self.save()
        guide = self.guide(goal or "打开内容作战台")
        return {
            "status": "onboarded",
            "project": str(self.rt.project),
            "target_platforms": state.target_platforms,
            "target_platform_labels": display_platform_labels(state.target_platforms),
            "state_file": str(self.state_file),
            "guide": guide["guide"],
        }

    def work(self, user_input: str = "") -> dict[str, Any]:
        """统一工作台：聚合总控、流水线状态和最近 runs。"""
        guide = self.guide(user_input)
        status = self.pipeline_status()
        runs = self.rt.list_runs(limit=5)
        actions = self._next_actions(guide, runs)
        cockpit = self._cockpit_text(guide, status, runs, actions)
        health = self._cockpit_health(status, runs)
        return {
            "status": "ready",
            "project": str(self.rt.project),
            "guide": guide["guide"],
            "cockpit": cockpit,
            "health": health,
            "pipeline": status,
            "style_recommendation": guide.get("pipeline", {}).get("style_recommendation"),
            "dbs_fusion_apply": guide.get("pipeline", {}).get("dbs_fusion_apply"),
            "runs": runs,
            "actions": actions,
        }

    def pipeline_next(self) -> dict[str, Any]:
        director = PipelineDirector(self.rt.project)
        return director.next()

    def pipeline_status(self) -> dict[str, Any]:
        director = PipelineDirector(self.rt.project)
        return director.status()

    def update(self, section: str, content: str, append: bool = True) -> dict[str, Any]:
        state = self.load()
        if section not in asdict(state):
            raise ValueError(f"未知 section: {section}，可用: {list(asdict(state).keys())}")
        old = getattr(state, section)
        if isinstance(old, list):
            if append:
                old.append(content)
            else:
                old[:] = [content]
        elif isinstance(old, dict):
            # 简单 key=value 解析
            if "=" in content:
                k, v = content.split("=", 1)
                old[k.strip()] = v.strip()
            else:
                old["note"] = content
        else:
            setattr(state, section, content)
        self.save()
        return {"status": "updated", "section": section, "state_file": str(self.state_file)}

    def boot(self, force: bool = False) -> dict[str, Any]:
        state = self.load()
        state.boot_count += 1
        self.save()
        if force or state.boot_count <= 1:
            mode = "full"
            text = self._full_dashboard(state)
        else:
            mode = "compressed"
            text = self._compressed_status(state)
        return {
            "mode": mode,
            "boot_count": state.boot_count,
            "state_file": str(self.state_file),
            "dashboard": text,
        }

    def guide(self, user_input: str = "") -> dict[str, Any]:
        """生成面向用户的下一步引导，不暴露 Agent 执行细节。"""
        state = self.load()
        route = self.route(user_input) if user_input else None
        detected_platforms = detect_target_platforms(user_input) if user_input else []
        if detected_platforms:
            self.set_target_platforms(detected_platforms)
            state = self.load()
        pipeline = self.pipeline_next()
        style_recommendation = self._style_recommendation_summary(pipeline)
        guide_text = self._guide_text(state, pipeline, route, user_input)
        return {
            "status": "guided",
            "project": str(self.rt.project),
            "user_input": user_input,
            "route": route,
            "target_platforms": state.target_platforms,
            "pipeline": {
                "status": pipeline.get("status"),
                "active_slug": pipeline.get("active_slug"),
                "target_platforms": pipeline.get("target_platforms") or [],
                "target_platform_labels": pipeline.get("target_platform_labels") or [],
                "recommended_step": pipeline.get("recommended_step"),
                "skill": pipeline.get("skill"),
                "style_recommendation": style_recommendation,
                "style_recommendation_file": style_recommendation.get("recommendation_file") if style_recommendation else None,
                "dbs_fusion_apply": pipeline.get("dbs_fusion_apply"),
                "task_card": pipeline.get("task_card"),
            },
            "guide": guide_text,
        }

    def _full_dashboard(self, state: SessionState) -> str:
        obs = state.observations
        return f"""[Context Boot 已展示：本窗口]

## 内容作战台

### 1. 当前定位
- 你卖什么：{state.positioning.get('offer') or '（待补充）'}
- 目标客户：{state.positioning.get('target') or '（待补充）'}
- 核心购买理由：{state.positioning.get('core_reason') or '（待补充）'}
- 行业公敌：{state.positioning.get('enemy') or '（待补充）'}
- 当前缺口：{state.positioning.get('gap') or '（待补充）'}

### 2. 上次进度
- 最近生成的选题：{self._recent_names(state.topic_tracking)}
- 最近生成的稿子：{self._recent_names(state.script_tracking)}
- 待处理事项：{state.pending or '无'}

### 3. 临时观察
- 共性问题：{obs.get('common_issues') or '无'}
- 高表现信号：{obs.get('high_signals') or '无'}
- 获客断点：{obs.get('breakpoints') or '无'}

### 4. 建议
建议下一步：{self._recommend_next(state)}

可用命令查看详细状态：
python3 $AIFIOS_HOME/skills/content-runtime/scripts/session_manager.py --project {self.rt.project} state
"""

    def _compressed_status(self, state: SessionState) -> str:
        return f"""[Context Boot 已展示：本窗口]

当前缺口：{state.positioning.get('gap') or '（待补充）'} | 最近稿子：{self._recent_names(state.script_tracking)} | 待处理：{state.pending or '无'}
建议下一步：{self._recommend_next(state)}
"""

    def _guide_text(
        self,
        state: SessionState,
        pipeline: dict[str, Any],
        route: dict[str, Any] | None,
        user_input: str,
    ) -> str:
        active_slug = pipeline.get("active_slug") or "current"
        skill = route["skill"] if route else pipeline.get("skill") or "content-intake"
        note = route["note"] if route else "按当前流水线推进"
        action = route.get("next_action") if route and route.get("next_action") else SKILL_USER_ACTIONS.get(skill, "把你现在手里的素材或目标发来，我会判断下一步。")
        recommended_step = pipeline.get("recommended_step") or "完成"
        current_position = self._position_line(state)
        pipeline_platforms = pipeline.get("target_platforms") or []
        target_line = self._target_platform_line(state.target_platforms or pipeline_platforms)
        style_summary = self._style_recommendation_summary(pipeline) if skill == "wechat-writer" else None
        style_line = self._style_recommendation_line(style_summary)
        dbs_apply = pipeline.get("dbs_fusion_apply")

        if pipeline.get("status") == "completed":
            action = "这条内容流水线已经完成。你可以发发布数据来复盘，或给我新素材开启下一条。"
            recommended_step = "review / new-intake"
        elif dbs_apply:
            skill = "content-dbs-fusion"
            note = "DBS 融合结果待写回"
            action = f"先执行写回命令：`{dbs_apply.get('aifios_command') or dbs_apply.get('command')}`。写回后再继续进入 `{dbs_apply.get('next_step')}`。"
            recommended_step = "dbs-fusion-apply"

        input_line = f"\n你刚才说：{user_input}\n" if user_input else ""
        return f"""# AIFIOS 总控台
{input_line}
当前内容：`{active_slug}`
当前位置：{current_position}
目标阵地：{target_line}
建议动作：{note} -> `{skill}`
{style_line}

## 下一步
{action}

## 你可以直接说
- “我要写公众号，主题是……”
- “帮我收集公众号/小红书爆款对标，关键词是……”
- “这是我的素材，先判断值不值得做：……”
"""

    def _style_recommendation_summary(self, pipeline: dict[str, Any]) -> dict[str, Any] | None:
        """Expose the style fields needed by workbench UIs and downstream agents."""
        if pipeline.get("recommended_step") != "write" or pipeline.get("skill") != "wechat-writer":
            return None
        recommendation = pipeline.get("style_recommendation")
        file_path = pipeline.get("style_recommendation_file")
        active_slug = pipeline.get("active_slug") or "current"
        if not recommendation:
            persisted = self._load_persisted_style_recommendation(active_slug)
            if not persisted:
                return None
            recommendation = persisted.get("recommendation") or {}
            file_path = file_path or persisted.get("recommendation_file")
        file_path = file_path or recommendation.get("recommendation_file")
        if recommendation.get("error"):
            return {
                "status": "error",
                "error": recommendation.get("error"),
                "review_required": True,
                "recommendation_file": file_path,
            }
        return {
            "status": "review_required" if recommendation.get("review_required") else "ready",
            "final_style": recommendation.get("final_style"),
            "system_recommendation": recommendation.get("system_recommendation"),
            "confidence": recommendation.get("confidence"),
            "alternatives": (recommendation.get("alternatives") or [])[:2],
            "review_required": bool(recommendation.get("review_required")),
            "reasons": (recommendation.get("reasons") or [])[:3],
            "warnings": (recommendation.get("warnings") or [])[:3],
            "recommendation_file": file_path,
        }

    def _load_persisted_style_recommendation(self, slug: str) -> dict[str, Any] | None:
        safe_slug = self.rt.normalize_slug(slug or "current")
        path = self.rt.sessions / "style-recommendations" / f"{safe_slug}.json"
        if not path.exists():
            return None
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return None
        payload["recommendation_file"] = str(path)
        return payload

    @staticmethod
    def _style_recommendation_line(style: dict[str, Any] | None) -> str:
        if not style:
            return ""
        if style.get("status") == "error":
            return f"公众号风格：推荐生成失败，需人工复核（{style.get('error') or 'unknown'}）"
        final_style = style.get("final_style") or "待确认"
        confidence = style.get("confidence") or "-"
        review = "需复核" if style.get("review_required") else "可执行"
        return f"公众号风格：`{final_style}`（置信度：{confidence}，{review}）"

    def _next_actions(self, guide: dict[str, Any], runs: list[dict[str, Any]]) -> list[dict[str, str]]:
        """给 work/cockpit 输出 1-3 个用户可直接执行的下一步动作。"""
        pipeline = guide.get("pipeline", {})
        run_state = self.rt.state()
        active_run_id = run_state.get("active_run_id") or ""
        recommended_step = pipeline.get("recommended_step") or ""
        skill = pipeline.get("skill") or "content-intake"
        cli = f"python3 {Path(__file__).resolve().parents[3] / 'scripts' / 'aifios.py'} --project {self.rt.project}"
        actions: list[dict[str, str]] = []

        if not runs:
            actions.append({
                "label": "创建第一条内容",
                "command": f"{cli} run create --topic '你的主题' --platforms '公众号,小红书'",
            })
        elif active_run_id:
            actions.append({
                "label": "继续当前内容",
                "command": f"{cli} run resume {active_run_id}",
            })
        else:
            actions.append({
                "label": "恢复最近内容",
                "command": f"{cli} run resume",
            })

        if recommended_step and recommended_step != "完成":
            dbs_apply = pipeline.get("dbs_fusion_apply")
            if dbs_apply:
                actions.append({
                    "label": "写回 DBS 诊断",
                    "command": dbs_apply.get("aifios_command") or dbs_apply.get("command") or f"{cli} dbs-fusion-apply",
                })
            else:
                actions.append({
                    "label": f"进入下一步：{recommended_step}",
                    "command": f"{cli} next",
                })
        else:
            actions.append({
                "label": "开启新内容",
                "command": f"{cli} run create --topic '新的主题'",
            })

        if skill == "content-hit-collector":
            actions.append({
                "label": "采集爆款对标",
                "command": f"{cli} browser queue --platform xhs --keyword '关键词'",
            })
        else:
            actions.append({
                "label": "查看爆款报告",
                "command": f"{cli} hit report --platform xhs --keyword '关键词'",
            })
        return actions[:3]

    def _cockpit_health(self, pipeline: dict[str, Any], runs: list[dict[str, Any]]) -> dict[str, Any]:
        warnings = pipeline.get("warnings") or []
        active_run = next((item for item in runs if item.get("status") == "active"), runs[0] if runs else None)
        missing_run = active_run is None
        status = "ready"
        if warnings:
            status = "review_required"
        if missing_run:
            status = "needs_run"
        return {
            "status": status,
            "active_run_id": active_run.get("run_id") if active_run else "",
            "warning_count": len(warnings),
            "has_runs": bool(runs),
        }

    def _latest_report_status(self, root: Path) -> str:
        if not root.exists():
            return "暂无"
        files = sorted(root.glob("*.md"), key=lambda path: path.stat().st_mtime, reverse=True)
        if not files:
            return "暂无"
        latest = files[0]
        age = datetime.fromtimestamp(latest.stat().st_mtime).strftime("%m-%d %H:%M")
        return f"{latest.name}（{age}）"

    def _pending_queue_status(self) -> str:
        queue_root = self.rt.materials / "hit-library" / "pending"
        if not queue_root.exists():
            return "0 个待确认"
        pending = [p for p in queue_root.glob("*.json") if p.parent.name == "pending"]
        return f"{len(pending)} 个待确认"

    def _step_done_map(self, pipeline: dict[str, Any]) -> dict[str, bool]:
        done: dict[str, bool] = {}
        for row in pipeline.get("rows", []):
            if "group" in row:
                for branch in row.get("branches", []):
                    if not branch.get("skipped"):
                        done[branch["step"]] = bool(branch.get("done"))
            elif not row.get("skipped"):
                done[row["step"]] = bool(row.get("done"))
        return done

    def _missing_materials(self, guide: dict[str, Any], pipeline: dict[str, Any], runs: list[dict[str, Any]]) -> list[str]:
        """Summarize what the user should provide or produce next."""
        if not runs:
            return ["内容主题", "目标阵地", "业务/用户/产品信息"]

        step = guide.get("pipeline", {}).get("recommended_step") or ""
        target_platforms = pipeline.get("target_platform_labels") or display_platform_labels(guide.get("target_platforms") or [])
        missing: list[str] = []
        if not target_platforms:
            missing.append("目标阵地：公众号或小红书至少选一个")

        done = self._step_done_map(pipeline)
        required_by_step = {
            "validate": ["intake"],
            "blueprint": ["validate"],
            "angle": ["validate"],
            "breakdown": ["angle"],
            "write": ["blueprint"],
            "package": ["write"],
            "xhs": ["breakdown"],
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
        step_labels = {
            "intake": "素材理解报告",
            "validate": "选题立项报告",
            "blueprint": "思想母版蓝图",
            "angle": "角度报告",
            "breakdown": "内容拆解方案",
            "write": "公众号思想母版",
            "package": "最终内容",
            "xhs": "小红书图文方案",
            "visual": "视觉发布产物",
            "prelaunch": "发布前检查",
            "compliance": "合规检查",
            "audit": "可信审核",
            "publish": "发布记录",
            "performance": "数据回流报告",
            "review": "发布数据复盘",
            "archive": "归档沉淀",
        }
        for upstream in required_by_step.get(step, []):
            if upstream in done and not done[upstream]:
                missing.append(f"{step_labels.get(upstream, upstream)}：先完成 `{upstream}`")

        if not missing:
            hints = {
                "intake": "原始素材：文字、链接、访谈、聊天记录或口述目标",
                "validate": "立项判断所需信息：目标用户、业务、产品、想解决的问题",
                "blueprint": "母版蓝图材料：通过立项的 validate 报告、核心观点、爆款对标报告和风险边界",
                "angle": "角度选择信息：目标读者、核心观点、业务目的",
                "breakdown": "爆款对标样本：关键词、对标账号、链接或浏览器采集队列",
                "write": "公众号写作材料：已确认的思想母版蓝图、证据链、标题方向和商业收口",
                "package": "最终内容材料：公众号母稿、图文评论维护话术和平台风险边界",
                "xhs": "小红书材料：封面方向、卡片结构、评论区需求",
                "visual": "视觉材料：最终内容、封面/配图偏好、公众号排版要求和品牌禁区",
                "prelaunch": "待发布成稿：用于发布前检查",
                "compliance": "待发布成稿：用于平台合规检查",
                "audit": "事实来源和授权信息：硬数字、案例、客户名称",
                "publish": "发布账号和最终确认：标题、封面、发布时间",
                "performance": "发布后数据源：公众号或小红书后台数据、作品 ID、链接、评论样本和授权方式",
                "review": "数据回流报告：阅读、点赞、收藏、评论、转发、线索和异常说明",
                "archive": "复盘结论和最终链接",
                "twin": "最终发布内容和复盘结果",
            }
            missing.append(hints.get(step, "暂无缺失材料，等待下一条内容或发布数据"))
        return missing[:5]

    def _latest_quality_status(self, active_run_id: str) -> str:
        root = self.rt.project / "quality" / "reports"
        if not root.exists():
            return "暂无质量报告"
        reports = sorted(root.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
        for path in reports:
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                continue
            if active_run_id and data.get("run_id") and data.get("run_id") != active_run_id:
                continue
            status = data.get("status", "unknown")
            gate = data.get("gate_status", "unknown")
            score = data.get("score", "-")
            return f"{status} / gate={gate} / score={score}（{path.name}）"
        return "暂无当前 run 的质量报告"

    def _delivery_status(self, active_run_id: str) -> str:
        root = self.rt.project / "deliveries"
        if not root.exists():
            return "未打包"
        safe_run = self.rt.normalize_slug(active_run_id) if active_run_id else ""
        dirs = sorted(
            [path for path in root.iterdir() if path.is_dir() and (not safe_run or safe_run in path.name)],
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        if not dirs:
            return "未打包"
        latest = dirs[0]
        zip_path = latest.with_suffix(".zip")
        zip_text = "zip 已生成" if zip_path.exists() else "zip 缺失"
        return f"已打包：{latest.name}（{zip_text}）"

    def _completed_steps_count(self, pipeline: dict[str, Any]) -> tuple[int, int]:
        done = 0
        total = 0
        for row in pipeline.get("rows", []):
            if "group" in row:
                for branch in row.get("branches", []):
                    if branch.get("skipped"):
                        continue
                    total += 1
                    done += 1 if branch.get("done") else 0
            else:
                if row.get("skipped"):
                    continue
                total += 1
                done += 1 if row.get("done") else 0
        return done, total

    def _cockpit_text(
        self,
        guide: dict[str, Any],
        pipeline: dict[str, Any],
        runs: list[dict[str, Any]],
        actions: list[dict[str, str]],
    ) -> str:
        health = self._cockpit_health(pipeline, runs)
        done, total = self._completed_steps_count(pipeline)
        active_slug = pipeline.get("active_slug") or "current"
        target_platforms = pipeline.get("target_platform_labels") or display_platform_labels(guide.get("target_platforms") or [])
        active_run = health.get("active_run_id") or "未创建"
        next_step = guide.get("pipeline", {}).get("recommended_step") or "完成/等待新内容"
        skill = guide.get("pipeline", {}).get("skill") or "无"
        style_line = self._style_recommendation_line(guide.get("pipeline", {}).get("style_recommendation"))
        warnings = pipeline.get("warnings") or []
        if guide.get("pipeline", {}).get("dbs_fusion_apply"):
            warnings = [
                {
                    "step": "dbs-fusion-apply",
                    "warning": "存在已通过校验但尚未写回的 DBS 融合结果，先写回再进入下游生产。",
                },
                *warnings,
            ]
        latest_benchmark = self._latest_report_status(self.rt.materials / "hit-library" / "benchmark")
        pending_queue = self._pending_queue_status()
        missing_materials = self._missing_materials(guide, pipeline, runs)
        quality_status = self._latest_quality_status(active_run)
        delivery_status = self._delivery_status(active_run)

        lines = [
            "# AIFIOS Cockpit",
            "",
            f"- 项目：`{self.rt.project}`",
            f"- 当前内容：`{active_slug}`",
            f"- 当前 run：`{active_run}`",
            f"- 目标阵地：{'、'.join(target_platforms) if target_platforms else '未指定，按一稿五发交付准备'}",
            f"- 流水线进度：{done}/{total}",
            f"- 健康状态：{health['status']}",
            "",
            "## 下一步",
            "",
            f"- 推荐步骤：`{next_step}`",
            f"- 对应能力：`{skill}`",
        ]
        if style_line:
            lines.append(f"- {style_line}")
        lines.extend([
            "",
            "## 缺失材料",
            "",
        ])
        for material in missing_materials:
            lines.append(f"- {material}")
        lines.extend([
            "",
            "## 交付状态",
            "",
            f"- 爆款样本队列：{pending_queue}",
            f"- 质量状态：{quality_status}",
            f"- 交付包：{delivery_status}",
            f"- 最近对标报告：{latest_benchmark}",
            "",
            "## 风险提示",
            "",
        ])
        if warnings:
            for warning in warnings[:5]:
                lines.append(f"- {warning['step']}：{warning['warning']}")
        else:
            lines.append("- 暂无顺序警告。")
        lines.extend(["", "## 可直接执行", ""])
        for item in actions:
            lines.append(f"- {item['label']}：`{item['command']}`")
        lines.append("")
        return "\n".join(lines)

    def _recent_names(self, items: list[dict[str, Any]], n: int = 3) -> str:
        names = [i.get("name", i.get("title", str(i))) for i in items[-n:]]
        return ", ".join(names) if names else "无"

    def _recommend_next(self, state: SessionState) -> str:
        if state.positioning.get("offer") in (None, ""):
            return "先补充定位（调用 content-intake）"
        if not state.topic_tracking:
            return "生成选题（content-angle）"
        if not state.script_tracking:
            return "把选题写成一稿五发交付（wechat-writer / content-package）"
        if state.pending:
            return f"处理待办：{state.pending[0]}"
        return "审核/发布/复盘（content-audit / content-review）"

    def _position_line(self, state: SessionState) -> str:
        if state.positioning.get("offer"):
            target = state.positioning.get("target") or "目标客户待补充"
            return f"已记录定位，目标客户：{target}"
        if state.topic_tracking or state.script_tracking:
            return "已有内容记录，可以继续写作、审核或复盘"
        return "新项目或定位待补充"

    def _target_platform_line(self, platforms: list[str]) -> str:
        if not platforms:
            return "未指定，默认按一稿五发交付准备"
        return "、".join(display_platform_labels(platforms))

    @staticmethod
    def _blocked_market_gate_route(
        user_input: str,
        target_platforms: list[str],
        gate: dict[str, Any] | None = None,
        error: Exception | None = None,
    ) -> dict[str, Any]:
        """Keep an unavailable TikOmni gate from degrading to legacy choices."""
        gate = gate if isinstance(gate, dict) else {}
        body = str(gate.get("body") or "").strip()
        note = str(gate.get("market_signal_note") or "").strip()
        blockers = gate.get("blockers") if isinstance(gate.get("blockers"), list) else []
        if not body:
            detail = str(error or "TikOmni 实时研究结果无效").strip()
            body = f"TikOmni 三平台实时研究未通过，当前不能进入选题确认。{detail}"
        if not note:
            note = "TikOmni 实时研究门禁未通过；不允许以历史样本、本地样本或模型推断替代。"
        return {
            "skill": "content-intake",
            "note": "TikOmni 实时研究门禁阻断",
            "user_input": user_input,
            "target_platforms": target_platforms,
            "next_action": body,
            "theme_gate": True,
            "topic_selection_blocked": True,
            "choice_count": 0,
            "theme_options": [],
            "recommended_theme": None,
            "market_signal_status": "blocked",
            "market_signal_note": note,
            "market_queries": gate.get("queries") if isinstance(gate.get("queries"), list) else [],
            "market_blockers": blockers,
        }

    def route(self, user_input: str) -> dict[str, Any]:
        text = user_input.lower()
        target_platforms = detect_target_platforms(user_input)
        if has_confirmed_package_signal(package_confirmation_scope(user_input).lower()):
            return {
                "skill": "content-validate",
                "note": "主题已确认，进入公开对标与立项",
                "user_input": user_input,
                "target_platforms": target_platforms,
                "next_action": "先读取当前 intake，生成或读取 `materials/research/{slug}-market-signal.md`，再立项；公开样本不足时必须保留“样本不足”，不能直接进入 content-package。",
            }
        if is_material_to_content_intent(user_input):
            try:
                gate = build_theme_gate_response(user_input, target_platforms=target_platforms, project=self.rt.project)
                if gate.get("blocked") or gate.get("market_signal_status") == "blocked":
                    return self._blocked_market_gate_route(user_input, target_platforms, gate)
                if not is_safe_theme_gate_response(gate):
                    return self._blocked_market_gate_route(
                        user_input,
                        target_platforms,
                        gate,
                        ValueError("TikOmni 实时研究返回的选题数据无效"),
                    )
                return {
                    "skill": "content-intake",
                    "note": "轻量主题选择门",
                    "user_input": user_input,
                    "target_platforms": target_platforms,
                    "next_action": gate["body"],
                    "theme_gate": True,
                    "choice_count": gate["choice_count"],
                    "theme_options": gate["options"],
                    "recommended_theme": gate["recommended"],
                    "market_signal_status": gate["market_signal_status"],
                    "market_signal_note": gate["market_signal_note"],
                    "market_queries": gate["queries"],
                }
            except Exception as exc:
                return self._blocked_market_gate_route(user_input, target_platforms, error=exc)
        for keywords, skill, note in ROUTE_RULES:
            if any(kw.lower() in text for kw in keywords):
                return {
                    "skill": skill,
                    "note": note,
                    "user_input": user_input,
                    "target_platforms": target_platforms,
                    "next_action": SKILL_USER_ACTIONS.get(skill, ""),
                }
        # fallback: 基于 state 推荐
        state = self.load()
        fallback = self._recommend_skill_from_state(state)
        return {
            "skill": fallback,
            "note": "基于当前状态兜底推荐",
            "user_input": user_input,
            "target_platforms": target_platforms,
            "next_action": SKILL_USER_ACTIONS.get(fallback, ""),
        }

    def _recommend_skill_from_state(self, state: SessionState) -> str:
        if state.positioning.get("offer") in (None, ""):
            return "content-intake"
        if not state.topic_tracking:
            return "content-angle"
        if not state.script_tracking:
            return "wechat-writer"
        if state.pending:
            return "content-prelaunch"
        return "content-review"

    def state_dict(self) -> dict[str, Any]:
        return asdict(self.load())


def detect_target_platforms(user_input: str) -> list[str]:
    text = str(user_input or "").lower()
    targets = []
    for platform, keywords in PLATFORM_KEYWORDS.items():
        if any(keyword.lower() in text for keyword in keywords):
            targets.append(platform)
    return targets


def display_platform_labels(platforms: list[str]) -> list[str]:
    labels = []
    for platform in platforms:
        label = PLATFORM_LABELS.get(platform, platform)
        if label not in labels:
            labels.append(label)
    return labels


def is_safe_theme_gate_response(gate: Any) -> bool:
    if not isinstance(gate, dict):
        return False
    body = gate.get("body")
    if not isinstance(body, str):
        return False
    required_keys = {
        "body",
        "choice_count",
        "options",
        "recommended",
        "market_signal_status",
        "market_signal_note",
        "queries",
    }
    if not required_keys.issubset(gate):
        return False
    choice_count = gate.get("choice_count")
    if type(choice_count) is not int or choice_count != THEME_OPTION_COUNT:
        return False
    options = gate.get("options")
    if not isinstance(options, list) or len(options) != choice_count:
        return False
    choices = []
    scores = []
    option_by_choice = {}
    for option in options:
        if not isinstance(option, dict):
            return False
        choice = option.get("choice")
        if not isinstance(choice, str) or len(choice) != 1:
            return False
        title = option.get("title")
        score = option.get("score")
        material_evidence = option.get("material_evidence")
        if not isinstance(title, str) or not title.strip():
            return False
        if type(score) is not int or not 0 <= score <= 100:
            return False
        if not isinstance(material_evidence, str) or not material_evidence.startswith("素材命中："):
            return False
        choices.append(choice)
        scores.append(score)
        option_by_choice[choice] = option
    expected_choices = list(THEME_OPTION_CHOICES)
    if choices != expected_choices:
        return False
    if scores != sorted(scores, reverse=True):
        return False
    if gate.get("recommended") != choices[0]:
        return False
    if not all(f"| {choice} |" in body for choice in choices):
        return False
    if "回复 A-F" not in body:
        return False
    if f"我推荐主题 {gate.get('recommended')}" not in body:
        return False
    rows = theme_gate_table_rows(body)
    if len(rows) != choice_count:
        return False
    for row, expected_choice in zip(rows, choices):
        if len(row) != 9:
            return False
        choice, title, audience, score_text, material_evidence = row[0], row[1], row[2], row[3], row[8]
        option = option_by_choice.get(expected_choice)
        if choice != expected_choice or option is None:
            return False
        if title != option["title"]:
            return False
        if audience != option.get("audience"):
            return False
        if material_evidence != option["material_evidence"]:
            return False
        if not re.fullmatch(r"\d{1,3}", score_text):
            return False
        if int(score_text) != option["score"]:
            return False
    return (
        "| 选项 | 主题 | 推荐受众 | 总分 | 爆款机制参考 |" in body
        and not any(term in body for term in THEME_GATE_FORBIDDEN_TERMS)
    )


def theme_gate_table_rows(body: str) -> list[list[str]]:
    rows: list[list[str]] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or not stripped.endswith("|"):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if not cells or cells[0] in {"选项", "---"}:
            continue
        if cells[0] in THEME_OPTION_CHOICES:
            rows.append(cells)
    return rows


def is_material_to_content_intent(user_input: str) -> bool:
    text = str(user_input or "").lower()
    if not text:
        return False
    if has_confirmed_package_signal(package_confirmation_scope(user_input).lower()):
        return False
    if any(signal.lower() in text for signal in ANALYSIS_ONLY_SIGNALS):
        return False
    if any(signal.lower() in text for signal in ANGLE_DETAIL_SIGNALS):
        return False
    has_material = any(signal.lower() in text for signal in MATERIAL_TO_CONTENT_SIGNALS)
    has_generation = any(signal.lower() in text for signal in CONTENT_GENERATION_SIGNALS)
    return has_material and has_generation


def package_confirmation_scope(user_input: str) -> str:
    text = str(user_input or "")
    lower_text = text.lower()
    boundary = len(text)
    for signal in MATERIAL_TO_CONTENT_SIGNALS:
        start = lower_text.find(signal.lower())
        if start == -1:
            continue
        delimiter_match = re.search(r"[：:\n]", text[start:start + 160])
        if delimiter_match:
            boundary = min(boundary, start + delimiter_match.start())
        else:
            boundary = min(boundary, start)
    return text[:boundary]


def has_confirmed_package_signal(text: str) -> bool:
    for match in INVALID_EXPLICIT_CHOICE_CONFIRM_RE.finditer(text):
        prefix = text[max(0, match.start() - 16):match.start()]
        if not NEGATED_CONFIRM_PREFIX_RE.search(prefix):
            return False
    for match in EXPLICIT_CHOICE_CONFIRM_RE.finditer(text):
        prefix = text[max(0, match.start() - 16):match.start()]
        if not NEGATED_CONFIRM_PREFIX_RE.search(prefix):
            return True
    for signal in CONFIRMED_PACKAGE_SIGNALS:
        needle = signal.lower()
        start = text.find(needle)
        while start != -1:
            prefix = text[max(0, start - 16):start]
            if not NEGATED_CONFIRM_PREFIX_RE.search(prefix):
                return True
            start = text.find(needle, start + len(needle))
    return False


def main() -> int:
    parser = argparse.ArgumentParser(description="content-runtime/session_manager")
    parser.add_argument("--project", required=True, help="项目根目录")
    sub = parser.add_subparsers(dest="command", required=True)

    p_start = sub.add_parser("start", help="用户版总控入口")
    p_start.add_argument("input", nargs="?", default="", help="用户目标或当前想法")
    p_start.add_argument("--json", action="store_true", help="同时输出机器可读状态")

    p_boot = sub.add_parser("boot", help="Context Boot")
    p_boot.add_argument("--force", action="store_true", help="强制展示完整作战台")

    p_guide = sub.add_parser("guide", help="生成用户版下一步引导")
    p_guide.add_argument("input", nargs="?", default="", help="用户目标或当前想法")
    p_guide.add_argument("--json", action="store_true", help="同时输出机器可读状态")

    p_onboard = sub.add_parser("onboard", help="首次使用配置")
    p_onboard.add_argument("--goal", default="", help="本次内容目标")
    p_onboard.add_argument("--platforms", default="", help="目标阵地，如 公众号,小红书,视频号,抖音,朋友圈")
    p_onboard.add_argument("--offer", default="", help="你卖什么/业务是什么")
    p_onboard.add_argument("--target", default="", help="目标用户是谁")
    p_onboard.add_argument("--product", default="", help="产品/服务或核心购买理由")
    p_onboard.add_argument("--json", action="store_true")

    p_work = sub.add_parser("work", help="统一工作台")
    p_work.add_argument("input", nargs="?", default="", help="用户目标或当前想法")
    p_work.add_argument("--json", action="store_true")

    p_cockpit = sub.add_parser("cockpit", help="统一工作台（work 别名）")
    p_cockpit.add_argument("input", nargs="?", default="", help="用户目标或当前想法")
    p_cockpit.add_argument("--json", action="store_true")

    p_route = sub.add_parser("route", help="根据用户输入推荐 skill")
    p_route.add_argument("input", help="用户输入文本")

    p_update = sub.add_parser("update", help="更新 session state 某个 section")
    p_update.add_argument("--section", required=True)
    p_update.add_argument("--content", required=True)
    p_update.add_argument("--replace", action="store_true", help="覆盖而非追加（仅对 list 有效）")

    sub.add_parser("state", help="读取完整状态")

    args = parser.parse_args()
    sm = SessionManager(args.project)

    if args.command == "start":
        data = sm.guide(args.input)
        print(data["guide"])
        if args.json:
            print(json.dumps({k: v for k, v in data.items() if k != "guide"}, ensure_ascii=False, indent=2))
    elif args.command == "boot":
        data = sm.boot(args.force)
        print(data["dashboard"])
        print(json.dumps({k: v for k, v in data.items() if k != "dashboard"}, ensure_ascii=False, indent=2))
    elif args.command == "guide":
        data = sm.guide(args.input)
        print(data["guide"])
        if args.json:
            print(json.dumps({k: v for k, v in data.items() if k != "guide"}, ensure_ascii=False, indent=2))
    elif args.command == "onboard":
        data = sm.onboard(args.goal, args.platforms, args.offer, args.target, args.product)
        print(data["guide"])
        if args.json:
            print(json.dumps({k: v for k, v in data.items() if k != "guide"}, ensure_ascii=False, indent=2))
    elif args.command in {"work", "cockpit"}:
        data = sm.work(args.input)
        print(data["cockpit"])
        print("## 最近 Runs")
        for item in data["runs"]:
            status = item.get("status") or "active"
            topic = item.get("topic") or item.get("slug") or ""
            print(f"- `{item['run_id']}`：{status} · {item.get('current_step') or '未开始'} · {topic} · {item.get('updated_at') or ''}")
        if args.json:
            print(json.dumps({k: v for k, v in data.items() if k not in {"guide", "cockpit"}}, ensure_ascii=False, indent=2))
    elif args.command == "route":
        print(json.dumps(sm.route(args.input), ensure_ascii=False, indent=2))
    elif args.command == "update":
        print(json.dumps(sm.update(args.section, args.content, append=not args.replace), ensure_ascii=False, indent=2))
    elif args.command == "state":
        print(json.dumps(sm.state_dict(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
