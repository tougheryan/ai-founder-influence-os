#!/usr/bin/env python3
"""Recommend a wechat-writer longform style from a breakdown/brief."""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


STYLE_LABELS = {
    "deep-narrative": "深度叙事型",
    "founder-rise-fall": "企业家兴衰叙事型",
    "business-insight": "商业洞察型",
    "method-playbook": "复盘方法论型",
    "product-experience": "产品体验型",
    "interview-speech": "访谈演讲转写型",
    "hotspot-analysis": "热点解读型",
    "case-breakdown": "案例拆解型",
    "personal-reflection": "个人成长反思型",
}

DIMENSIONS = ["素材场景", "证据类型", "商业目标", "读者处境", "风险边界"]

SIGNALS: dict[str, dict[str, list[str]]] = {
    "deep-narrative": {
        "素材场景": ["趋势", "时代", "行业变化", "观察", "故事", "长期", "周期", "变化"],
        "证据类型": ["真实场景", "人物", "细节", "公开背景", "历史", "文化", "哲学"],
        "商业目标": ["长期信任", "人格信任", "品牌", "关系", "评论", "私信"],
        "读者处境": ["看不懂", "焦虑", "误判", "困惑", "共鸣", "好奇"],
        "风险边界": ["证据不足", "不可公开", "保守表达", "不确定"],
    },
    "founder-rise-fall": {
        "素材场景": ["企业家", "创始人", "公司", "兴衰", "失败", "转折", "关键决策", "周期"],
        "证据类型": ["时间线", "财报", "公告", "公开报道", "融资", "上市", "营收", "利润"],
        "商业目标": ["战略", "复盘", "商业判断", "案例研究", "决策"],
        "读者处境": ["看懂公司", "判断机会", "避免误判", "学习决策"],
        "风险边界": ["公开事实", "多方", "客观", "平衡", "单因归因"],
    },
    "business-insight": {
        "素材场景": ["商业模式", "增长", "获客", "产品", "行业", "客户", "成交", "转化", "业务"],
        "证据类型": ["客户处境", "数据口径", "对标", "样本", "业务场景", "案例"],
        "商业目标": ["建立专业", "咨询", "陪跑", "产品教育", "服务说明", "诊断"],
        "读者处境": ["客户卡点", "误区", "痛点", "不知道怎么", "选择困境"],
        "风险边界": ["不夸大", "保守", "事实边界", "未核实"],
    },
    "method-playbook": {
        "素材场景": ["方法", "复盘", "经验", "步骤", "流程", "怎么做", "指南", "清单"],
        "证据类型": ["一手过程", "做对", "做错", "失败", "结果", "踩坑", "行动"],
        "商业目标": ["提交问题", "检查", "执行", "咨询", "陪跑"],
        "读者处境": ["不会做", "卡住", "想上手", "需要方法", "避坑"],
        "风险边界": ["学习成本", "失败点", "不能保证", "不承诺"],
    },
    "product-experience": {
        "素材场景": ["产品", "工具", "体验", "实测", "测试", "使用", "工作流", "AI 编程", "Codex", "DeepSeek"],
        "证据类型": ["截图", "页面", "操作", "失败片段", "对比", "亲自", "跑通", "输出"],
        "商业目标": ["工具清单", "工作流", "社群", "咨询", "课程"],
        "读者处境": ["要不要用", "值不值得", "怎么用", "怕被替代", "效率"],
        "风险边界": ["不夸大效率", "限制", "人工把关", "不可公开项目"],
    },
    "interview-speech": {
        "素材场景": ["访谈", "采访", "演讲", "圆桌", "直播", "播客", "嘉宾", "分享"],
        "证据类型": ["原话", "转录", "现场", "提问", "问答", "金句", "主讲人"],
        "商业目标": ["人物背书", "活动传播", "合作", "二次传播"],
        "读者处境": ["听不完整", "想抓重点", "需要提炼", "现场感"],
        "风险边界": ["不能伪造", "不要改写过度", "授权", "原意"],
    },
    "hotspot-analysis": {
        "素材场景": ["热点", "最近", "今天", "发布", "新闻", "政策", "模型发布", "突发", "行业动态"],
        "证据类型": ["公开来源", "多方口径", "公告", "报告", "截至", "最新"],
        "商业目标": ["关注后续", "资料包", "咨询判断", "预判"],
        "读者处境": ["不知道怎么看", "担心错过", "想判断影响", "短期", "长期"],
        "风险边界": ["最新信息", "单一来源", "不确定性", "不能断言"],
    },
    "case-breakdown": {
        "素材场景": ["客户案例", "项目案例", "交付", "业务转化", "转化", "成交", "失败复盘"],
        "证据类型": ["授权", "结果", "行动链路", "客户原话", "反馈", "前后对比", "复盘"],
        "商业目标": ["同类业务诊断", "服务说明", "咨询", "成交", "转化"],
        "读者处境": ["我的业务", "能不能解决", "同类问题", "信任"],
        "风险边界": ["匿名", "不公开客户名", "未授权", "结果口径", "不夸大"],
    },
    "personal-reflection": {
        "素材场景": ["个人成长", "人生心得", "选择", "压力", "焦虑", "长期主义", "心态"],
        "证据类型": ["真实经历", "情绪节点", "反思", "转折", "内心"],
        "商业目标": ["人格信任", "留言", "关系沉淀", "长期关系"],
        "读者处境": ["共鸣", "迷茫", "压力", "不确定", "坚持"],
        "风险边界": ["不装深沉", "不鸡汤", "不编经历", "边界"],
    },
}

BLOCK_RULES = {
    "product-experience": {
        "needs": ["实测", "体验", "使用", "测试", "亲自", "操作", "跑通", "截图", "页面"],
        "message": "缺少亲自体验或实测过程，不适合写成产品体验型。",
    },
    "interview-speech": {
        "needs": ["访谈", "采访", "演讲", "圆桌", "直播", "播客", "转录", "原话", "现场"],
        "message": "缺少访谈、演讲或原话素材，不适合写成访谈演讲转写型。",
    },
    "case-breakdown": {
        "needs": ["客户案例", "项目案例", "授权", "结果", "客户原话", "反馈", "行动链路"],
        "message": "缺少客户授权、行动链路或结果口径，不适合写成案例拆解型。",
    },
    "founder-rise-fall": {
        "needs": ["企业家", "公司", "时间线", "财报", "公告", "公开报道", "关键决策", "兴衰"],
        "message": "缺少企业家/公司时间线或公开事实，不适合写成兴衰叙事。",
    },
}


@dataclass
class StyleScore:
    style_id: str
    label: str
    score: int = 0
    dimensions: dict[str, int] = field(default_factory=lambda: {dim: 0 for dim in DIMENSIONS})
    reasons: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _count_hits(text: str, keywords: list[str]) -> list[str]:
    return [keyword for keyword in keywords if keyword.lower() in text.lower()]


def _score_dimension(text: str, keywords: list[str]) -> tuple[int, list[str]]:
    hits = _count_hits(text, keywords)
    if len(hits) >= 3:
        return 2, hits[:4]
    if hits:
        return 1, hits[:4]
    return 0, []


def _risk_warnings(text: str, style_id: str) -> list[str]:
    warnings: list[str] = []
    if style_id in BLOCK_RULES and not _count_hits(text, BLOCK_RULES[style_id]["needs"]):
        warnings.append(BLOCK_RULES[style_id]["message"])
    if style_id == "case-breakdown" and re.search(r"未授权|不可公开|不公开客户|客户名不可公开", text):
        if "授权" not in text or "未授权" in text:
            warnings.append("素材存在未授权或不可公开客户信息，案例细节必须匿名化，建议人工复核。")
    if style_id == "hotspot-analysis" and re.search(r"最近|今天|最新|发布|政策|模型", text):
        if not re.search(r"来源|公告|报告|截至|公开|链接", text):
            warnings.append("热点内容缺少来源、公告、报告或截至时间，必须补事实核验。")
    if style_id == "founder-rise-fall" and not re.search(r"时间线|财报|公告|公开报道|来源|截至", text):
        warnings.append("企业家兴衰叙事缺少公开时间线或事实来源，容易单因归因。")
    return warnings


def recommend_style(text: str, user_style: str | None = None) -> dict[str, Any]:
    if not text.strip():
        raise ValueError("empty brief text")

    scores: list[StyleScore] = []
    for style_id, label in STYLE_LABELS.items():
        score = StyleScore(style_id=style_id, label=label)
        for dimension, keywords in SIGNALS[style_id].items():
            value, hits = _score_dimension(text, keywords)
            score.dimensions[dimension] = value
            score.score += value
            if hits:
                score.reasons.append(f"{dimension}命中：{'、'.join(hits)}")
        score.warnings.extend(_risk_warnings(text, style_id))
        scores.append(score)

    scores.sort(key=lambda item: (item.score, -len(item.warnings), item.style_id), reverse=True)
    recommended = scores[0]
    alternatives = [item for item in scores[1:] if recommended.score - item.score <= 2][:2]
    confidence = "高" if recommended.score >= 7 and not recommended.warnings else "中" if recommended.score >= 5 else "低"

    final_style = recommended
    unsafe_user_selection = False
    user_style_valid = user_style in STYLE_LABELS if user_style else False
    user_style_warning = ""
    if user_style:
        if not user_style_valid:
            user_style_warning = f"用户指定风格无效：{user_style}"
        else:
            requested = next(item for item in scores if item.style_id == user_style)
            blocking = _risk_warnings(text, user_style)
            if requested.score >= 4 and not blocking:
                final_style = requested
                if final_style.style_id != recommended.style_id:
                    user_style_warning = f"用户指定风格优先，系统推荐为 {recommended.style_id}。"
            else:
                unsafe_user_selection = True
                user_style_warning = "用户指定风格与素材证据不匹配，建议采用系统推荐并标记 review。"

    if unsafe_user_selection and final_style.style_id == user_style:
        safe_candidates = [item for item in scores if item.style_id != user_style and not item.warnings]
        if not safe_candidates:
            safe_candidates = [item for item in scores if item.style_id != user_style]
        if safe_candidates:
            final_style = safe_candidates[0]

    selected_alternatives = [item.style_id for item in alternatives if item.style_id != final_style.style_id]
    if recommended.style_id != final_style.style_id and recommended.style_id not in selected_alternatives:
        selected_alternatives.insert(0, recommended.style_id)

    return {
        "user_style": user_style or "无",
        "user_style_valid": user_style_valid if user_style else None,
        "system_recommendation": recommended.style_id,
        "final_style": final_style.style_id,
        "confidence": confidence,
        "alternatives": selected_alternatives[:2],
        "review_required": bool(final_style.warnings or user_style_warning),
        "reasons": final_style.reasons[:6],
        "warnings": [warning for warning in [user_style_warning, *final_style.warnings] if warning],
        "scores": [
            {
                "style_id": item.style_id,
                "label": item.label,
                "score": item.score,
                "dimensions": item.dimensions,
                "warnings": item.warnings,
            }
            for item in scores
        ],
    }


def _format_markdown(result: dict[str, Any]) -> str:
    final_style = result["final_style"]
    rec = result["system_recommendation"]
    alternatives = " / ".join(result["alternatives"]) if result["alternatives"] else "无"
    reasons = "；".join(result["reasons"]) if result["reasons"] else "素材信号不足，建议人工确认"
    warnings = "\n".join(f"- {item}" for item in result["warnings"]) if result["warnings"] else "- 无"
    return (
        "## 推荐风格\n\n"
        f"- 用户指定：{result['user_style']}\n"
        f"- 系统推荐：{rec}（置信度：{result['confidence']}）\n"
        f"- 最终采用：{final_style}\n"
        f"- 备选风格：{alternatives}\n"
        f"- 选择依据：{reasons}\n"
        f"- 需要复核：{'是' if result['review_required'] else '否'}\n\n"
        "## 风险提醒\n\n"
        f"{warnings}\n"
    )


def _read_input(args: argparse.Namespace) -> str:
    if args.file:
        return Path(args.file).expanduser().read_text(encoding="utf-8")
    if args.text:
        return args.text
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise ValueError("provide --file, --text, or stdin")


def main() -> int:
    parser = argparse.ArgumentParser(description="Recommend a wechat-writer style from a brief.")
    parser.add_argument("--file", help="Path to a content-breakdown or writing brief markdown file.")
    parser.add_argument("--text", help="Brief text to score.")
    parser.add_argument("--user-style", choices=sorted(STYLE_LABELS), help="Optional user-selected style id.")
    parser.add_argument("--format", choices=["markdown", "json"], default="markdown")
    args = parser.parse_args()

    try:
        text = _read_input(args)
        result = recommend_style(text, user_style=args.user_style)
    except Exception as exc:
        print(f"FAIL {exc}", file=sys.stderr)
        return 1

    if args.format == "json":
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(_format_markdown(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
