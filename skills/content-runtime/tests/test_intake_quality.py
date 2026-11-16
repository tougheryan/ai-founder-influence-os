"""Regression coverage for human-readable content-intake report fields."""
from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from intake_quality import audit_intake  # noqa: E402


def fixture_with_value(value: str) -> str:
    import re
    body = (Path(__file__).parent / "fixtures" / "intake_valid.md").read_text(encoding="utf-8")
    return re.sub(r"(?m)^- 素材为什么值得被看见：.*$", f"- 素材为什么值得被看见：{value}", body)


def test_opinion_value_does_not_require_promotional_keyword_categories() -> None:
    body = fixture_with_value("客户临时增加需求时，先说明会影响哪项交付和原定时间，再请对方确认下一步，帮助小团队负责人处理这类问题。")
    result = audit_intake(body)
    assert result["status"] != "blocked", result["blocking_issues"]


def test_value_still_needs_an_explanation_not_empty_text_or_keyword_padding() -> None:
    for value in ["", "待补", "真实价值，稀缺价值，认知价值，情绪价值，方法价值，背书价值，商业价值，时代价值"]:
        result = audit_intake(fixture_with_value(value))
        assert any("素材用途说明" in issue for issue in result["blocking_issues"])


def test_opinion_only_usability_does_not_need_a_case_to_be_approved() -> None:
    import re
    body = fixture_with_value("围绕作者对需求变更的判断，解释为什么应先确认影响及边界，再决定是否接受改动，避免把观点写成客户成果。")
    body = re.sub(r"(?m)^- 核心案例：.*$", "- 核心案例：当前无可追溯核心案例，不能将观察写成已验证结果。", body)
    body = re.sub(r"(?m)^- 可信等级：.*$", "- 可信等级：未提供案例，若补充案例仍需待核验。", body)
    body = re.sub(r"(?m)^- 下游可用性：.*$", "- 下游可用性：可继续写观点或方法。", body)
    result = audit_intake(body)
    assert result["status"] != "blocked", result["blocking_issues"]


def test_intake_accepts_user_text_and_nested_strategy_values() -> None:
    body = """# 素材理解报告 · 职业恢复

## 0. 素材场景
- 主场景：个人成长 / 人生心得
- 素材来源：用户提供的文字自述素材
- 事实边界：只使用叙述者本人提供的恢复感受；不评价具体机构、人员或未经核验的事实。

## 0.1 内容策略画像
- 素材为什么值得被看见：
  - 真实价值：来自一手职业恢复经历。
  - 情绪价值：回应专业人士在低谷后重新建立节奏的共鸣。
- 值得被看见指数：8/10
- 主受众：经历职业停顿、希望重建长期工作节奏的专业服务从业者。
- 副受众：关注长期主义与协作关系的知识型创业者。
- 用户可选主题候选：本阶段只保留职业恢复与长期主义边界；TikOmni 研究完成后再由系统生成 6 条可选主题。
- 核心判断句：低谷后重要的不是马上证明自己，而是重新建立可持续的生活与工作节奏。
- 内容结构：具体困境 -> 停下来恢复 -> 重建判断 -> 形成新的行动节奏。
- 爆款参考范围：同场景的职业恢复表达，只研究公开内容的开头机制与叙事节奏。
- 禁止写法：
  - 不写具体机构、人员或争议。
  - 不将个人感受包装成服务成果。

## 1. 人物
- 核心人物：经历职业停顿后重新表达的专业人士。

## 2. 场景
- 背景：一次健康挑战后，叙述者暂停并重新安排生活与工作。
- 关键事件链：暂停 -> 恢复 -> 重建工作节奏 -> 重新表达。
- 缺失信息：不公开健康细节与具体关系。

## 3. 观点
- 明确观点：重建节奏比立即自证更重要。
- 证据位置：用户提供的文字自述。

## 4. 情绪
- 主情绪：克制而稳定的恢复感。
- 情绪曲线：冲击 -> 沉默 -> 修复 -> 重启。

## 5. 案例
- 核心案例：叙述者在职业停顿后重新建立生活与工作节奏。
- 可信等级：一手自述。

## 6. 商业意图
- 品牌信息：以公开表达建立专业信任，并邀请同行围绕职业恢复交流。

## 7. 不可公开信息
- 健康细节、具体机构和人员信息不可公开。
- 处理建议：统一匿名和脱敏处理。

## 9. 素材质量判断
- 信息完整度：中等。
- 可信度：一手自述，边界明确。
- 当前缺口：缺少可公开的恢复细节。
- 下游可用性：可进入立项。
"""

    result = audit_intake(body)

    assert result["status"] != "blocked", result["blocking_issues"]
    assert "素材场景缺少可追溯的素材来源。" not in result["blocking_issues"]
    assert not any("素材为什么值得被看见" in issue for issue in result["blocking_issues"])
    assert not any("主题候选" in issue for issue in result["blocking_issues"])
    assert not any("禁止写法" in issue for issue in result["blocking_issues"])
