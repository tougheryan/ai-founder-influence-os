#!/usr/bin/env python3
"""Smoke tests for wechat-writer style recommendation."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from style_recommender import recommend_style


def _assert(condition: bool, message: str) -> int:
    if condition:
        print(f"PASS {message}")
        return 0
    print(f"FAIL {message}")
    return 1


def main() -> int:
    fails = 0

    interview = (
        "这是一场创始人访谈和演讲分享的转录，有现场提问、嘉宾原话、圆桌讨论，"
        "商业目标是沉淀人物背书并用于二次传播。"
    )
    interview_result = recommend_style(interview)
    fails += _assert(interview_result["final_style"] == "interview-speech", "recommends interview-speech for interview brief")

    product = (
        "用户亲自实测 Codex 和 AI 编程工具，记录了页面操作、输出函数、失败片段、人工把关和工作流改造，"
        "目标是引导到 AI 编程工作流咨询。"
    )
    product_result = recommend_style(product)
    fails += _assert(product_result["final_style"] == "product-experience", "recommends product-experience for product test")

    case_without_auth = (
        "这是客户案例和项目案例，包含成交转化和服务说明，但客户名不可公开，素材未授权，结果口径也不完整。"
        "读者想判断同类业务能不能解决。"
    )
    case_result = recommend_style(case_without_auth, user_style="case-breakdown")
    fails += _assert(case_result["review_required"], "flags unauthorized case breakdown for review")
    fails += _assert(case_result["final_style"] != "case-breakdown", "does not force unsafe user-selected case-breakdown")

    founder = (
        "文章要写一个企业家的公司兴衰，包含公开报道、公告、财报、时间线和关键决策，"
        "目标是做战略复盘和商业判断。"
    )
    founder_result = recommend_style(founder)
    fails += _assert(founder_result["final_style"] == "founder-rise-fall", "recommends founder-rise-fall for sourced founder story")

    return fails


if __name__ == "__main__":
    raise SystemExit(main())
