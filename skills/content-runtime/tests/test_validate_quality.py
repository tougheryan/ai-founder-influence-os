"""Focused contract checks for the validate market-signal handoff."""
from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from validate_quality import audit_validate  # noqa: E402


def report(
    *,
    market_status: str = "已完成",
    sample_count: int = 3,
    first_platform: str = "wechat",
    decision_reason: str = "一手访谈提供了明确场景，也有公开样本可用于机制比较。",
    supplement: str = "- [x] 已补齐访谈中的关键场景。",
    risk: str = "- 不把第三方指标写成自己的业务结果。",
) -> str:
    return f"""# 选题立项报告 · 市场验证测试

## 0. 素材来源
- intake 报告路径：pipeline/intake/market-check-intake.md
- 主场景：服务型创始人的内容获客访谈
- 核心人物/观点/案例：服务型创始人先说清客户问题，再介绍自己的解决方法。
- 公开样本对标报告：materials/research/market-check-market-signal.md
- 公开样本状态：{market_status}
- 可验证样本数：{sample_count}

## 1. 立项决策
- 决策：通过
- 决策理由：{decision_reason}
- 置信度：中
- 是否允许进入下一步：是

## 2. HKR 质检
| 维度 | 评分 | 说明 |
|---|---|---|
| H | ⭐⭐⭐⭐ | 有反常识张力 |
| K | ⭐⭐⭐⭐ | 有可执行方法 |
| R | ⭐⭐⭐⭐ | 有真实共鸣 |

## 3. 商业成立性判断
- 目标是否空转：否，目标是用内容建立咨询前的理解和信任。
- 商业模式是否成立：是，以内容诊断和咨询服务承接。
- 是否有产品/服务承接：是，承接内容诊断与咨询服务。
- 转化路径是否清晰：是，内容互动后进入问题诊断与咨询沟通。

## 4. 平台首发策略
- 推荐首发平台：{first_platform}
- 理由：公众号适合完整解释从客户问题到方法判断的逻辑链。

## 5. 素材补充清单
{supplement}

## 6. 风险提示
{risk}

## 7. 下一步
- 进入 /content-angle，沿用事实和公开样本边界生成候选角度。
"""


def test_validate_accepts_declared_market_signal_with_samples() -> None:
    result = audit_validate(report())

    assert result["blocking_issues"] == []
    assert result["checks"]["market_signal"] == {
        "report_path": "materials/research/market-check-market-signal.md",
        "status": "ready",
        "sample_count": 3,
    }


def test_validate_accepts_all_direct_publish_platforms_as_first_platform() -> None:
    for platform in ("wechat", "xiaohongshu", "shipinhao", "douyin", "moments"):
        result = audit_validate(report(first_platform=platform))

        assert "平台首发策略缺少明确平台。" not in result["blocking_issues"], platform


def test_validate_keeps_commercial_uncertainty_advisory_instead_of_blocking_content() -> None:
    result = audit_validate(report().replace(
        "- 商业模式是否成立：是，以内容诊断和咨询服务承接。",
        "- 商业模式是否成立：待验证，先用内容收集真实问题。",
    ))

    assert result["blocking_issues"] == []
    assert result["status"] == "review_required"
    assert any("商业成立性仍需确认" in issue for issue in result["review_issues"])


def test_validate_keeps_freeform_business_notes_and_missing_platform_reason_advisory() -> None:
    body = report().replace(
        "- 目标是否空转：否，目标是用内容建立咨询前的理解和信任。\n"
        "- 商业模式是否成立：是，以内容诊断和咨询服务承接。\n"
        "- 是否有产品/服务承接：是，承接内容诊断与咨询服务。\n"
        "- 转化路径是否清晰：是，内容互动后进入问题诊断与咨询沟通。",
        "- 目标不空转，商业承接存在；商业模式仍待验证。",
    ).replace(
        "- 推荐首发平台：wechat\n- 理由：公众号适合完整解释从客户问题到方法判断的逻辑链。",
        "- 推荐首发平台：公众号。理由：适合完整说明方法。",
    )

    result = audit_validate(body)

    assert result["blocking_issues"] == []
    assert result["status"] == "review_required"
    assert any("后续内容按未验证处理" in issue for issue in result["review_issues"])
    assert any("不阻断内容生成" in issue for issue in result["review_issues"])


def test_validate_rejects_missing_market_signal_declaration() -> None:
    body = report().replace(
        "- 公开样本对标报告：materials/research/market-check-market-signal.md\n- 公开样本状态：已完成\n- 可验证样本数：3\n",
        "",
    )

    result = audit_validate(body)

    assert result["status"] == "blocked"
    assert "素材来源缺少公开样本对标报告路径。" in result["blocking_issues"]
    assert "素材来源必须声明 TikOmni 公开样本状态为已完成。" in result["blocking_issues"]
    assert "素材来源必须声明可验证样本数。" in result["blocking_issues"]


def test_validate_blocks_sample_insufficient_with_a_transparent_boundary() -> None:
    result = audit_validate(report(
        market_status="样本不足",
        sample_count=0,
        decision_reason="公开样本不足，尚未完成公开对标验证；本轮只依据一手访谈做保守立项。",
        supplement="- [ ] 补采集同人群、同场景的公开样本并重新检索对标报告。",
        risk="- 公开样本不足，不能把检索词、模型推测或第三方指标称为爆款或对标依据。",
    ))

    assert result["status"] == "blocked"
    assert "TikOmni 三平台样本不足；不得用创作模式或透明声明绕过研究门禁。" in result["blocking_issues"]
    assert result["checks"]["market_sample_status"] == "sample_insufficient"


def test_validate_blocks_sample_insufficient_without_a_fallback_checklist() -> None:
    result = audit_validate(report(
        market_status="样本不足",
        sample_count=0,
        decision_reason="题目仍然可以先写成一篇方法文章。",
        supplement="- [ ] 补一段访谈里的客户原话。",
        risk="- 不要暴露客户隐私。",
    ))

    assert result["status"] == "blocked"
    assert result["blocking_issues"]


def test_validate_blocks_creator_mode_with_zero_samples() -> None:
    result = audit_validate(report(
        market_status="创作模式（公开样本暂不可用）",
        sample_count=0,
        decision_reason="公开样本暂不可用，本期只依据已确认的一手素材生成方法内容。",
        supplement="- [ ] 服务恢复后补采集公开样本。",
        risk="- 不输出外部样本、播放量或结果承诺。",
    ))

    assert result["status"] == "blocked"
    assert result["checks"]["market_sample_status"] == "creator_mode"
    assert "TikOmni 三平台样本不足；不得用创作模式或透明声明绕过研究门禁。" in result["blocking_issues"]


def test_validate_blocks_completed_market_status_without_samples() -> None:
    result = audit_validate(report(market_status="已完成", sample_count=0))

    assert result["status"] == "blocked"
    assert "可验证样本数至少为 3" in " ".join(result["blocking_issues"])
