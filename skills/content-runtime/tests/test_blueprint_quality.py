from __future__ import annotations

import sys
from pathlib import Path


RUNTIME_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(RUNTIME_SCRIPTS))

from blueprint_quality import audit_blueprint


BLUEPRINT = """# 思想母版蓝图

## 0. 上游约束
- 只使用已授权访谈素材，不能补造客户数据。

## 1. 爆款拆解吸收
- 只吸收公开样本的场景入口和评论需求，不复制标题或故事。

## 1.1 标题假设
- 工作标题：创始人做内容，先接住真实判断
- 候选方向：从一次访谈如何变成内容资产切入
- 测试理由：回应创始人每次都从空白开始的具体痛点
- 不采用标题：AI 会让你一键爆火的万能标题

## 2. 核心判断
创始人的内容难题不是不会写，而是真实判断没有被接住和复用。

## 3. 目标读者与情绪入口
面向被频率焦虑困住的创始人，从会议结束后好判断迅速流失的现场开始。

## 4. 公众号思想母版骨架
开头写一次访谈现场；第一节解释判断为何流失；第二节给出内容资产结构；结尾收回行动边界。

## 5. 证据链与素材分配
访谈原话作为证据放在开头，会议复盘素材支撑第二节，所有数据都标注来源或不使用。

## 6. 叙事推进与章节任务
从现场冲突推进到反直觉判断，再把方法收束成读者可执行的下一步。

## 7. 金句与可拆资产
先接住真实判断，再谈内容效率。

## 8. 评论区互动预埋
首评提问：你最近一次被自己忘掉的好判断是什么？

## 9. 风险边界
不披露客户身份，不把个人经验夸大成行业规律，也不承诺内容效果。

## 10. 人工确认清单
确认状态：待确认

## 11. 下一步执行指令
负责人确认后进入 wechat-writer。
"""


def test_pending_blueprint_is_reviewable_but_not_confirmed() -> None:
    result = audit_blueprint(BLUEPRINT)

    assert result["status"] == "review_required"
    assert result["blocking_issues"] == []
    assert result["checks"]["confirmed"] is False
    assert any("待确认" in item for item in result["review_issues"])


def test_confirmed_blueprint_passes_quality_gate() -> None:
    result = audit_blueprint(BLUEPRINT.replace("确认状态：待确认", "确认状态：已确认"))

    assert result["status"] == "pass"
    assert result["blocking_issues"] == []
    assert result["checks"]["confirmed"] is True


def test_editorial_blueprint_gaps_are_advisory_instead_of_blocking() -> None:
    body = BLUEPRINT.replace(
        "- 工作标题：创始人做内容，先接住真实判断\n"
        "- 候选方向：从一次访谈如何变成内容资产切入\n"
        "- 测试理由：回应创始人每次都从空白开始的具体痛点\n"
        "- 不采用标题：AI 会让你一键爆火的万能标题",
        "- 工作标题：先接住真实判断",
    )

    result = audit_blueprint(body)

    assert result["status"] == "review_required"
    assert result["blocking_issues"] == []
    assert result["checks"]["has_title_hypothesis"] is False
    assert any("标题假设不足" in item for item in result["review_issues"])
