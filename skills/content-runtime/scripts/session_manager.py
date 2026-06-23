#!/usr/bin/env python3
"""content-runtime/session_manager.py · 通用会话状态管理器

提供 content 全家桶通用的 Context Boot、状态恢复与模块路由。
状态文件默认保存在项目 sessions/session-state.json。

用法:
    python session_manager.py --project ~/ai-content-system boot [--force]
    python session_manager.py --project ~/ai-content-system route "帮我写获客稿"
    python session_manager.py --project ~/ai-content-system update --section knowledge_log --content "..."
    python session_manager.py --project ~/ai-content-system state
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from content_runtime import ContentRuntime


DEFAULT_SECTIONS = {
    "positioning": {
        "offer": "",
        "target": "",
        "core_reason": "",
        "enemy": "",
        "gap": "",
    },
    "topic_tracking": [],
    "script_tracking": [],
    "pending": [],
    "knowledge_log": [],
    "calibration_log": [],
    "observations": {"common_issues": [], "high_signals": [], "breakpoints": []},
    "summary": "",
}

ROUTE_RULES = [
    # (keywords, recommended_skill, note)
    (["素材", "intake", "输入", "给我看看", "理解了"], "content-intake", "素材理解"),
    (["立项", "validate", "值不值得做", "能不能做"], "content-validate", "立项决策"),
    (["角度", "angle", "选题", "切入点"], "content-angle", "角度清单"),
    (["拆解", "breakdown", "关键词", "标题", "钩子"], "content-breakdown", "内容拆解"),
    (["公众号", "长文", "wechat", "写文章", "写稿子"], "wechat-writer", "公众号长文"),
    (["抖音", "口播", "获客", "douyin", "私信", "咨询"], "douyin-script", "抖音获客口播"),
    (["小红书", "xhs", "种草", "图文", "封面"], "xhs-card", "小红书图文"),
    (["配图", "视觉", "visual", "封面图", "头图"], "content-visual", "文章配图"),
    (["改编", " repurpos", "一鱼多吃", "跨平台"], "content-repurpose", "跨平台改编"),
    (["发布前", "prelaunch", "检查清单"], "content-prelaunch", "发布前检查"),
    (["合规", "compliance", "违禁词", "广告法", "平台规则"], "content-compliance", "平台合规"),
    (["审核", "audit", "可信", "事实校验", "来源"], "content-audit", "可信审核"),
    (["复盘", "review", "数据", "发布后", "评论洞察"], "content-review", "数据复盘"),
    (["归档", "archive", "沉淀", "知识库回流"], "self-archive", "自我沉淀"),
    (["孪生", "twin", "数字孪生", "风格镜像"], "content-twin", "数字孪生"),
]


@dataclass
class SessionState:
    positioning: dict[str, str] = field(default_factory=lambda: DEFAULT_SECTIONS["positioning"].copy())
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
        self._state: SessionState | None = None

    def load(self) -> SessionState:
        if self._state is not None:
            return self._state
        if self.state_file.exists():
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            self._state = SessionState(**data)
        else:
            self._state = SessionState()
        return self._state

    def save(self) -> None:
        state = self.load()
        state.touch()
        self.state_file.write_text(json.dumps(asdict(state), ensure_ascii=False, indent=2), encoding="utf-8")

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
python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/session_manager.py --project {self.rt.project} state
"""

    def _compressed_status(self, state: SessionState) -> str:
        return f"""[Context Boot 已展示：本窗口]

当前缺口：{state.positioning.get('gap') or '（待补充）'} | 最近稿子：{self._recent_names(state.script_tracking)} | 待处理：{state.pending or '无'}
建议下一步：{self._recommend_next(state)}
"""

    def _recent_names(self, items: list[dict[str, Any]], n: int = 3) -> str:
        names = [i.get("name", i.get("title", str(i))) for i in items[-n:]]
        return ", ".join(names) if names else "无"

    def _recommend_next(self, state: SessionState) -> str:
        if state.positioning.get("offer") in (None, ""):
            return "先补充定位（调用 content-intake 或 douyin-script 模块 F）"
        if not state.topic_tracking:
            return "生成选题（content-angle / douyin-script 模块 B）"
        if not state.script_tracking:
            return "把选题写成稿（wechat-writer / douyin-script / xhs-card）"
        if state.pending:
            return f"处理待办：{state.pending[0]}"
        return "审核/发布/复盘（content-audit / content-review）"

    def route(self, user_input: str) -> dict[str, Any]:
        text = user_input.lower()
        for keywords, skill, note in ROUTE_RULES:
            if any(kw.lower() in text for kw in keywords):
                return {"skill": skill, "note": note, "user_input": user_input}
        # fallback: 基于 state 推荐
        state = self.load()
        return {"skill": self._recommend_next(state).split("（")[-1].replace(")", ""), "note": "基于当前状态兜底推荐", "user_input": user_input}

    def state_dict(self) -> dict[str, Any]:
        return asdict(self.load())


def main() -> int:
    parser = argparse.ArgumentParser(description="content-runtime/session_manager")
    parser.add_argument("--project", required=True, help="项目根目录")
    sub = parser.add_subparsers(dest="command", required=True)

    p_boot = sub.add_parser("boot", help="Context Boot")
    p_boot.add_argument("--force", action="store_true", help="强制展示完整作战台")

    p_route = sub.add_parser("route", help="根据用户输入推荐 skill")
    p_route.add_argument("input", help="用户输入文本")

    p_update = sub.add_parser("update", help="更新 session state 某个 section")
    p_update.add_argument("--section", required=True)
    p_update.add_argument("--content", required=True)
    p_update.add_argument("--replace", action="store_true", help="覆盖而非追加（仅对 list 有效）")

    sub.add_parser("state", help="读取完整状态")

    args = parser.parse_args()
    sm = SessionManager(args.project)

    if args.command == "boot":
        data = sm.boot(args.force)
        print(data["dashboard"])
        print(json.dumps({k: v for k, v in data.items() if k != "dashboard"}, ensure_ascii=False, indent=2))
    elif args.command == "route":
        print(json.dumps(sm.route(args.input), ensure_ascii=False, indent=2))
    elif args.command == "update":
        print(json.dumps(sm.update(args.section, args.content, append=not args.replace), ensure_ascii=False, indent=2))
    elif args.command == "state":
        print(json.dumps(sm.state_dict(), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
