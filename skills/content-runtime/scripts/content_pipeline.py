#!/usr/bin/env python3
"""content-pipeline · AI Founder Influence OS 流水线导演

用法：
    python content_pipeline.py --project ~/ai-content-system status
    python content_pipeline.py --project ~/ai-content-system next
    python content_pipeline.py --project ~/ai-content-system next --slug demo
    python content_pipeline.py --project ~/ai-content-system flow --intake file.md
    python content_pipeline.py --project ~/ai-content-system guide
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from content_runtime import ContentRuntime, STEPS


PIPELINE = [
    "intake",
    "validate",
    "angle",
    "breakdown",
    {"step": "draft", "branches": ["write", "douyin", "xhs"], "label": "多平台内容生产"},
    "platform-adapt",
    "visual",
    {"step": "check", "branches": ["prelaunch", "compliance"], "label": "发布前检查"},
    "audit",
    "publish",
    "review",
    "archive",
    "twin",
]

STEP_SKILLS: dict[str, dict[str, str]] = {
    "intake": {"skill": "content-intake", "input": "用户素材", "output": "素材理解报告"},
    "validate": {"skill": "content-validate", "input": "intake 报告", "output": "立项决策"},
    "angle": {"skill": "content-angle", "input": "intake/validate 报告", "output": "角度清单"},
    "breakdown": {"skill": "content-breakdown", "input": "angle 报告", "output": "关键词矩阵/标题/钩子"},
    "write": {"skill": "wechat-writer", "input": "breakdown 报告", "output": "公众号长文"},
    "douyin": {"skill": "douyin-script", "input": "breakdown 报告", "output": "抖音获客口播稿"},
    "xhs": {"skill": "xhs-card", "input": "breakdown 报告", "output": "小红书图文卡片"},
    "platform-adapt": {"skill": "content-repurpose", "input": "主平台成稿", "output": "平台适配方案"},
    "visual": {"skill": "content-visual", "input": "成稿", "output": "配图/封面计划"},
    "prelaunch": {"skill": "content-prepurpose", "input": "成稿", "output": "发布前检查清单"},
    "compliance": {"skill": "content-compliance", "input": "成稿", "output": "合规风险报告"},
    "audit": {"skill": "content-audit", "input": "成稿", "output": "可信审核报告"},
    "publish": {"skill": "manual", "input": "过审内容", "output": "发布到平台"},
    "review": {"skill": "content-review", "input": "发布数据", "output": "复盘报告"},
    "archive": {"skill": "self-archive", "input": "全部产物", "output": "归档沉淀"},
    "twin": {"skill": "content-twin", "input": "最终成品", "output": "数字孪生观察"},
}

STEP_GUIDE: dict[str, dict[str, str]] = {
    "intake": {
        "purpose": "把任意素材（语音、文字、PDF、链接）结构化，判断场景、人物、观点、商业意图。",
        "input": "用户原始素材",
        "output": "素材理解报告（必须含 0-6 七大章节）",
        "tips": "不要编造，没有素材就停下来问用户；先判断素材属于哪一类场景。",
    },
    "validate": {
        "purpose": "判断这个选题值不值得做，避免在错误选题上浪费创作时间。",
        "input": "intake 报告",
        "output": "立项决策（通过/不通过/待定 + 商业成立性 + 平台首发策略）",
        "tips": "HKR 质检：有趣(H)、有料(K)、有共鸣(R) 至少占两项。",
    },
    "angle": {
        "purpose": "从素材中提炼 3-5 个可选角度，选出最有传播力和获客力的一个。",
        "input": "intake/validate 报告",
        "output": "角度清单（含对比表和首推建议）",
        "tips": "好角度 = 真实体感 + 可迁移判断 + 情绪/冲突。",
    },
    "breakdown": {
        "purpose": "把选定角度拆成可执行的内容零件：关键词、标题、钩子、结构。",
        "input": "angle 报告",
        "output": "关键词矩阵 + 标题方案 + 开场钩子库 + 平台适配要点",
        "tips": "钩子要具体到画面/数字/冲突，不要抽象。",
    },
    "write": {
        "purpose": "基于 breakdown 输出公众号长文（常欢风格）。",
        "input": "breakdown 报告",
        "output": "4000-8000 字公众号长文 markdown",
        "tips": "先读 style-changhuan.md 和 core-rules.md；写完跑四层自检。",
    },
    "douyin": {
        "purpose": "基于 breakdown 输出抖音获客口播稿 + 拍摄方案。",
        "input": "breakdown 报告",
        "output": "1000-1400 字口播稿 + 场景/镜头/字幕/BGM 建议",
        "tips": "开头 3 秒必须有钩子，每 4-5 秒换一个信息点。",
    },
    "xhs": {
        "purpose": "基于 breakdown 输出小红书图文卡片。",
        "input": "breakdown 报告",
        "output": "封面三行文案 + 6 页正文 + 评论区钩子",
        "tips": "封面决定点击率，三行文案要形成情绪递进。",
    },
    "platform-adapt": {
        "purpose": "把主平台成稿改编成其他平台的版本。",
        "input": "write/douyin/xhs 成稿",
        "output": "跨平台改编方案",
        "tips": "不是简单复制，要重新切钩子、调长度、换 CTA。",
    },
    "visual": {
        "purpose": "为成稿统一生成配图/封面计划。",
        "input": "成稿",
        "output": "配图计划（小黑手绘 / 公众号封面 / 小红书封面）",
        "tips": "同一篇内容视觉风格要统一，不要混用。",
    },
    "prelaunch": {
        "purpose": "发布前做事实、风格、平台规则、商业闭环四层检查。",
        "input": "成稿",
        "output": "发布前检查清单",
        "tips": "硬数字必须准确，宁可模糊也不编造。",
    },
    "compliance": {
        "purpose": "扫描平台规则、广告法、版权风险。",
        "input": "成稿",
        "output": "合规风险报告",
        "tips": "重点关注违禁词、极限词、诱导分享、版权素材。",
    },
    "audit": {
        "purpose": "对成稿做可信审核：来源追溯、事实校验、隐私与平台风险。",
        "input": "成稿",
        "output": "可信审核报告 + 修改建议",
        "tips": "所有引用和案例都要能追溯到来源。",
    },
    "publish": {
        "purpose": "人工把过审内容发布到对应平台。",
        "input": "过审内容",
        "output": "已发布链接/截图",
        "tips": "发布时检查标题、封面、话题标签是否和 plan 一致。",
    },
    "review": {
        "purpose": "基于发布后的数据做复盘，指导下一条内容。",
        "input": "平台数据/截图",
        "output": "数据复盘报告",
        "tips": "关注分享率、评论高频词、私信/咨询转化。",
    },
    "archive": {
        "purpose": "把整条产线沉淀为可复用的资产：选题、模式、禁区。",
        "input": "全部产物",
        "output": "归档沉淀文件",
        "tips": "把可复用模式写进 brain/，把禁区写进 no-fly-zone.md。",
    },
    "twin": {
        "purpose": "从已发布成品中提取内容 DNA、结构模式、表达特征，形成数字孪生。",
        "input": "最终成品 + 数据",
        "output": "数字孪生观察报告",
        "tips": "关注只有你才能写出的独特表达，而不是通用套路。",
    },
}

UPSTREAM: dict[str, list[str]] = {
    "intake": [],
    "validate": ["intake"],
    "angle": ["validate"],
    "breakdown": ["angle"],
    "write": ["breakdown"],
    "douyin": ["breakdown"],
    "xhs": ["breakdown"],
    "platform-adapt": ["write", "douyin", "xhs"],
    "visual": ["platform-adapt"],
    "prelaunch": ["write", "douyin", "xhs"],
    "compliance": ["write", "douyin", "xhs"],
    "audit": ["prelaunch", "compliance"],
    "publish": ["audit"],
    "review": ["publish"],
    "archive": ["review"],
    "twin": ["archive"],
}

RUNTIME_CLI = "python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_runtime.py"
PIPELINE_CLI = "python $HOME/plugins/ai-founder-influence-os/skills/content-runtime/scripts/content_pipeline.py"
TEMPLATE_DIR = "$HOME/plugins/ai-founder-influence-os/skills/content-runtime/templates"


def _escape_md(text: str) -> str:
    return text.replace("`", "\\`")


class PipelineDirector:
    def __init__(self, project: Path | str):
        self.rt = ContentRuntime(project)
        self.rt.init()
        self.state = self.rt.state()

    def _latest_file(self, step: str) -> str | None:
        return self.state.get("latest_files", {}).get(step)

    def _is_done(self, step: str) -> bool:
        return self._latest_file(step) is not None

    def _active_slug(self) -> str:
        recent = self.rt.list_recent(days=30)
        if recent:
            return recent[0].get("slug", "current")
        return "current"

    def _read_step_body(self, step: str, max_chars: int = 1500) -> str:
        rel = self._latest_file(step)
        if not rel:
            return ""
        try:
            data = self.rt.read(step, file=rel)
            body = data.get("body", "")
            return body[:max_chars] + ("\n\n...（已截断）" if len(body) > max_chars else "")
        except Exception as e:
            return f"读取失败: {e}"

    def _collect_upstream(self, step: str) -> tuple[str, str]:
        upstreams = UPSTREAM.get(step, [])
        for upstream in upstreams:
            if self._is_done(upstream):
                return upstream, self._read_step_body(upstream)
        recent = self.rt.list_recent(days=30)
        if recent:
            u = recent[0]
            return u["step"], self._read_step_body(u["step"])
        return "", ""

    def status(self) -> dict[str, Any]:
        rows = []
        for item in PIPELINE:
            if isinstance(item, str):
                label = STEP_SKILLS.get(item, {}).get("output", item)
                done = self._is_done(item)
                rows.append({
                    "step": item,
                    "label": label,
                    "done": done,
                    "file": self._latest_file(item),
                })
            else:
                branch_rows = []
                all_done = True
                any_done = False
                for branch in item["branches"]:
                    done = self._is_done(branch)
                    all_done = all_done and done
                    any_done = any_done or done
                    branch_rows.append({
                        "step": branch,
                        "label": STEP_SKILLS.get(branch, {}).get("output", branch),
                        "done": done,
                        "file": self._latest_file(branch),
                    })
                rows.append({
                    "group": item["label"],
                    "step": item["step"],
                    "done": all_done,
                    "partial": any_done and not all_done,
                    "branches": branch_rows,
                })
        return {
            "project": str(self.rt.project),
            "current_step": self.state.get("current_step"),
            "active_slug": self._active_slug(),
            "rows": rows,
        }

    def _find_next_steps(self) -> list[dict[str, Any]]:
        next_steps = []
        for item in PIPELINE:
            if isinstance(item, str):
                if not self._is_done(item):
                    next_steps.append({"step": item, "label": STEP_SKILLS.get(item, {}).get("output", item)})
                    return next_steps
            else:
                pending = [b for b in item["branches"] if not self._is_done(b)]
                if pending:
                    return [
                        {"step": b, "label": STEP_SKILLS.get(b, {}).get("output", b), "group": item["label"]}
                        for b in pending
                    ]
        return []

    def _render_card(self, step: str, active_slug: str, upstream: str, upstream_summary: str, intake_file: str | None = None) -> str:
        skill = STEP_SKILLS.get(step, {"skill": "unknown", "input": "", "output": ""})
        guide = STEP_GUIDE.get(step, {"purpose": "", "input": "", "output": "", "tips": ""})
        template = f"{TEMPLATE_DIR}/{step}.md"

        return f"""# content-flow 任务卡 · {step}

> 本任务卡由 `content-flow` 自动生成。完成本步骤后，再次运行同一命令即可推进到下一步。

## 这一步是做什么？
{guide.get('purpose', '')}

## 当前步骤
- 步骤：`{step}`
- 产物：{skill['output']}
- 当前 slug：`{active_slug}`

## 对应 Skill
- Skill：`{skill['skill']}`
- 输入：{skill['input']}
- 输出：{skill['output']}

## 你需要做的事
1. 阅读对应 Skill 的 `SKILL.md`：
   `$HOME/plugins/ai-founder-influence-os/skills/{skill['skill']}/SKILL.md`
2. 参考填写模板：
   `{template}`
3. 根据上游摘要，调用该 Skill 生成 `{skill['output']}`。
4. 将结果写回 runtime：
   ```bash
   {RUNTIME_CLI} --project {self.rt.project} write \\
     --step {step} --slug {active_slug} \\
     --content @output.md --source "{skill['skill']}"
   ```
5. 完成后再次运行：
   ```bash
   make -C $HOME/plugins/ai-founder-influence-os/skills/content-runtime content-flow PROJECT={self.rt.project} INTAKE={intake_file or '你的intake文件.md'} SLUG={active_slug}
   ```

## 上游依赖
- 上游步骤：`{upstream or '无'}`

### 上游摘要
{upstream_summary or '（暂无上游内容）'}

## 输出标准
{guide.get('output', '')}

## 常见坑
{guide.get('tips', '')}
"""

    def next(self, slug: str | None = None) -> dict[str, Any]:
        active_slug = slug or self._active_slug()
        next_steps = self._find_next_steps()
        if not next_steps:
            result = {
                "status": "completed",
                "message": "流水线已全部完成，没有下一步。",
                "project": str(self.rt.project),
            }
            return result

        target = next_steps[0]
        step = target["step"]
        upstream, upstream_summary = self._collect_upstream(step)

        task_card = self._render_card(step, active_slug, upstream, upstream_summary)
        task_path = self.rt.sessions / "next-task.md"
        task_path.write_text(task_card, encoding="utf-8")

        return {
            "status": "ready",
            "project": str(self.rt.project),
            "active_slug": active_slug,
            "next_steps": [{"step": s["step"], "label": s["label"]} for s in next_steps],
            "recommended_step": step,
            "skill": STEP_SKILLS.get(step, {}).get("skill", "unknown"),
            "upstream": upstream,
            "task_card": str(task_path),
        }

    def guide(self, slug: str | None = None) -> dict[str, Any]:
        active_slug = slug or self._active_slug()
        next_steps = self._find_next_steps()
        if not next_steps:
            return {
                "status": "completed",
                "message": "流水线已全部完成。",
                "project": str(self.rt.project),
                "slug": active_slug,
            }
        target = next_steps[0]
        step = target["step"]
        upstream, upstream_summary = self._collect_upstream(step)
        card = self._render_card(step, active_slug, upstream, upstream_summary)
        guide_path = self.rt.sessions / "guide-task.md"
        guide_path.write_text(card, encoding="utf-8")
        return {
            "status": "guide_ready",
            "project": str(self.rt.project),
            "slug": active_slug,
            "current_step": step,
            "skill": STEP_SKILLS.get(step, {}).get("skill", "unknown"),
            "guide_file": str(guide_path),
            "guide": card,
        }

    def flow(self, intake_file: str | None = None, slug: str | None = None) -> dict[str, Any]:
        active_slug = slug or self._active_slug() or "current"

        if intake_file:
            p = Path(intake_file)
            if not p.exists():
                raise FileNotFoundError(f"intake 文件不存在: {intake_file}")
            content = p.read_text(encoding="utf-8")
            self.rt.write("intake", active_slug, content, source=f"content-flow:{intake_file}")
            self.state = self.rt.state()

        next_steps = self._find_next_steps()
        if not next_steps:
            return {
                "status": "completed",
                "message": "流水线已全部完成。",
                "project": str(self.rt.project),
                "slug": active_slug,
            }

        target = next_steps[0]
        step = target["step"]
        upstream, upstream_summary = self._collect_upstream(step)

        done_steps = []
        remaining = [s["step"] for s in next_steps]
        for item in PIPELINE:
            if isinstance(item, str):
                if self._is_done(item) and item not in remaining:
                    done_steps.append(item)
            else:
                for b in item["branches"]:
                    if self._is_done(b) and b not in remaining:
                        done_steps.append(b)

        task_card = self._render_card(step, active_slug, upstream, upstream_summary, intake_file)
        task_card += f"""
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
            "current_step": step,
            "done_steps": done_steps,
            "remaining_steps": remaining,
            "skill": STEP_SKILLS.get(step, {}).get("skill", "unknown"),
            "upstream": upstream,
            "task_card": str(task_path),
        }


def print_status(data: dict[str, Any]) -> None:
    print(f"# AI Founder Influence OS · 流水线状态")
    print(f"\n项目：{data['project']}")
    print(f"当前 slug：{data['active_slug']}")
    print(f"最近操作：{data['current_step'] or '无'}\n")
    for row in data["rows"]:
        if "group" in row:
            status = "✅ 已完成" if row["done"] else ("🟡 部分完成" if row["partial"] else "⏳ 待完成")
            print(f"{status} 【{row['group']}】")
            for b in row["branches"]:
                bstatus = "✅" if b["done"] else "⏳"
                print(f"  {bstatus} {b['step']:10} {b['label']:20} {b['file'] or ''}")
        else:
            status = "✅ 已完成" if row["done"] else "⏳ 待完成"
            print(f"{status} {row['step']:12} {row['label']:20} {row['file'] or ''}")
    print()


def print_flow(data: dict[str, Any]) -> None:
    if data["status"] == "completed":
        print("# content-flow · 流水线已完成")
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


def print_guide(data: dict[str, Any]) -> None:
    if data["status"] == "completed":
        print("# guide · 流水线已完成")
        print(f"\n项目：{data['project']}")
        print(f"slug：{data['slug']}")
        print(f"\n{data['message']}")
        return
    print(f"# guide · 当前步骤：{data['current_step']} -> {data['skill']}")
    print(f"\n项目：{data['project']}")
    print(f"slug：{data['slug']}")
    print(f"\n{data['guide']}")


def main() -> int:
    parser = argparse.ArgumentParser(description="content-pipeline · AI Founder Influence OS 导演")
    parser.add_argument("--project", required=True, help="项目根目录")
    parser.add_argument("--slug", default=None, help="手动指定当前 slug（默认自动检测）")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="查看流水线状态")
    sub.add_parser("next", help="生成下一步任务卡")
    sub.add_parser("guide", help="打印当前步骤详细引导")

    p_flow = sub.add_parser("flow", help="content-flow：从 intake 文件推进流水线")
    p_flow.add_argument("--intake", default=None, help="intake 素材文件路径")
    p_flow.add_argument("--slug", default=None, help="当前 slug")
    args = parser.parse_args()

    director = PipelineDirector(args.project)
    if args.command == "status":
        data = director.status()
        print_status(data)
        print(json.dumps(data, ensure_ascii=False, indent=2))
    elif args.command == "next":
        data = director.next(args.slug)
        if data["status"] == "completed":
            print(json.dumps(data, ensure_ascii=False, indent=2))
        else:
            print(f"# 下一步：{data['recommended_step']} -> {data['skill']}")
            print(f"任务卡已生成：{data['task_card']}\n")
            print(json.dumps(data, ensure_ascii=False, indent=2))
    elif args.command == "guide":
        data = director.guide(args.slug)
        print_guide(data)
    elif args.command == "flow":
        data = director.flow(args.intake, args.slug)
        print_flow(data)
        print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
