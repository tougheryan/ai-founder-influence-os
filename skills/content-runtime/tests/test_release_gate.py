from __future__ import annotations

import sys
from pathlib import Path
import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from release_gate import build_package_manifest, run_release_gate  # noqa: E402
from visual_test_fixtures import VALID_PACKAGE_BODY  # noqa: E402


NATIVE_VIDEO_ONLY = """# 平台原生内容 · 客户为什么划走

## 0. 共享事实底稿
- 本期平台：视频号
- 事实与案例：客户需要先看见自己的问题。

## 3. 视频号原生口播
- 发布标题：客户为什么划走
- 3秒钩子：客户划走，不一定是你不专业。
- 建议时长：60秒

### 逐句口播稿
| 时间段 | 口播文案 | 屏幕字幕 | 对应画面 |
|---|---|---|---|
| 0-60秒 | 先说客户的问题，再介绍你的方法。 | 客户问题优先 | 正面口播 |

### 镜头清单
| 时间段 | 镜头/动作 | 画面目的 |
|---|---|---|
| 0-60秒 | 正面口播 | 表达判断 |

### 字幕重点
- 核心判断：客户问题优先

### B-roll 建议
- 白板上的客户问题清单

### 发布文案
- 简介：先说客户问题，再介绍方法。
- 话题：#视频号
- 置顶评论：你的客户最常卡在哪里？
"""


@pytest.mark.parametrize("platform", ["视频号", "shipinhao"])
@pytest.mark.parametrize("title", ["- 发布标题：客户为什么划走", "### 发布标题：\n客户为什么划走"])
def test_native_field_syntax_aliases_and_explicit_conflicts(platform, title):
    source = NATIVE_VIDEO_ONLY.replace("本期平台：视频号", "本期平台：" + platform).replace("- 发布标题：客户为什么划走", title)
    assert build_package_manifest(source)["valid"]
    for broken in [
        source.replace(title, title + "\n- 发布标题：另一个"),
        source.replace(title, "### 发布标题：\n<!-- 只是注释 -->"),
        source.replace("本期平台：" + platform, "本期平台：shipinhao、视频号"),
        source.replace("本期平台：" + platform, "本期平台：shipinhao、未知"),
        source + "\n## 3. 视频号原生口播\n重复章节",
    ]:
        assert not build_package_manifest(broken)["valid"]


def test_native_copy_body_does_not_drop_list_paragraphs():
    from release_gate import _native_field
    assert _native_field("- 正文：第一段。\n\n- 第一点：保留。\n- 结尾问题：你怎么看？", "正文") == "第一段。\n\n- 第一点：保留。"


def test_visual_preparation_uses_the_same_alias_and_title_contract():
    from visual_publish import _parse_native_package_body, PackageParseError
    source = NATIVE_VIDEO_ONLY.replace("本期平台：视频号", "本期平台：shipinhao")
    assert _parse_native_package_body(source, "测试")["selected_platforms"] == ["shipinhao"]
    with pytest.raises(PackageParseError):
        _parse_native_package_body(source.replace("shipinhao", "shipinhao、未知"), "测试")


def test_manifest_requires_the_fixed_one_two_three_package_with_platform_bindings() -> None:
    manifest = build_package_manifest(VALID_PACKAGE_BODY)

    assert manifest["valid"] is True, manifest
    assert manifest["target_platforms"] == ["wechat", "xiaohongshu", "shipinhao", "douyin", "moments"]
    assert [unit["kind"] for unit in manifest["units"]] == [
        "article", "video_script", "video_script", "opinion_post", "opinion_post", "opinion_post",
    ]
    assert manifest["units"][0]["platform_bindings"] == ["wechat"]
    assert manifest["units"][1]["platform_bindings"] == ["shipinhao", "douyin", "xiaohongshu"]
    assert manifest["units"][3]["platform_bindings"] == ["wechat", "moments", "xiaohongshu"]


def test_native_manifest_contains_only_the_selected_video_lane() -> None:
    manifest = build_package_manifest(NATIVE_VIDEO_ONLY)

    assert manifest["schema"] == "echo-founder.platform-native-package.v2"
    assert manifest["valid"] is True, manifest
    assert manifest["target_platforms"] == ["shipinhao"]
    assert [unit["kind"] for unit in manifest["units"]] == ["video_script"]
    assert manifest["units"][0]["platform_bindings"] == ["shipinhao"]


def test_native_manifest_rejects_an_unselected_platform_section() -> None:
    source = NATIVE_VIDEO_ONLY.replace(
        "## 3. 视频号原生口播",
        "## 1. 公众号原生长文\n- 发布标题：不该出现\n\n### 正文\n未选择的平台内容。\n\n## 3. 视频号原生口播",
    )

    manifest = build_package_manifest(source)

    assert manifest["valid"] is False
    assert any("未选择公众号" in error for error in manifest["errors"])


def test_native_release_gate_rejects_a_collapsed_article_like_video_script() -> None:
    result = run_release_gate(NATIVE_VIDEO_ONLY)

    assert result["status"] == "blocked", result
    assert any("至少需要 3 个可剪辑时间段" in issue for issue in result["blocking_issues"])
    assert any("至少需要 2 个可执行镜头" in issue for issue in result["blocking_issues"])
    assert result["quality_checks"]["shipinhao_editable_script"] is False


def test_native_release_gate_rejects_cross_platform_mother_draft_derivation() -> None:
    source = NATIVE_VIDEO_ONLY.replace(
        "先说客户的问题，再介绍你的方法。",
        "这条口播由公众号母稿改写，先说客户的问题，再介绍你的方法。",
    )

    result = run_release_gate(source)

    assert result["status"] == "blocked", result
    assert any("跨平台派生" in issue for issue in result["blocking_issues"])
    assert result["quality_checks"]["platform_lanes_independent"] is False


def test_release_gate_rejects_a_package_missing_required_execution_fields() -> None:
    missing_broll = VALID_PACKAGE_BODY.replace("#### B-roll 素材建议", "#### 素材建议", 1)
    missing_card_page = VALID_PACKAGE_BODY.replace("| P5 |", "| P6 |", 1)
    missing_platform_binding = VALID_PACKAGE_BODY.replace("适用平台：视频号、抖音、小红书", "适用平台：视频号、小红书", 1)
    only_article = VALID_PACKAGE_BODY.split("## 2. 短视频内容", 1)[0]

    broll_result = run_release_gate(missing_broll)
    card_result = run_release_gate(missing_card_page)
    platform_result = run_release_gate(missing_platform_binding)
    article_only_result = run_release_gate(only_article)

    assert broll_result["status"] == "blocked", broll_result
    assert any("B-roll" in issue for issue in broll_result["blocking_issues"])
    assert card_result["status"] == "blocked", card_result
    assert any("P5" in issue for issue in card_result["blocking_issues"])
    assert platform_result["status"] == "blocked", platform_result
    assert any("抖音" in issue for issue in platform_result["blocking_issues"])
    assert article_only_result["status"] == "blocked", article_only_result
    assert any("短视频" in issue or "图文" in issue for issue in article_only_result["blocking_issues"])


def test_release_gate_repairs_safe_ai_filler_without_retaining_a_rewrite_diff() -> None:
    source = VALID_PACKAGE_BODY.replace(
        "很多创始人第一次写内容，会本能地把第一篇写成一份温柔版简历。",
        "值得注意的是，很多创始人第一次写内容，会本能地把第一篇写成一份温柔版简历。",
        1,
    )

    result = run_release_gate(source)

    assert result["status"] == "pass", result
    assert result["repaired"] is True
    assert "值得注意的是，" not in result["repaired_body"]
    assert "rewrite_diff" not in result
    assert any(unit["status"] == "repaired" for unit in result["units"])


def test_release_gate_rechecks_and_repairs_obvious_ai_tone_in_bounded_local_passes() -> None:
    source = VALID_PACKAGE_BODY.replace(
        "很多创始人第一次写内容，会本能地把第一篇写成一份温柔版简历。",
        "首先，内容不仅仅是展示履历，更是给客户赋能，形成全链路闭环的抓手。",
        1,
    )

    result = run_release_gate(source)

    assert result["status"] == "pass", result
    assert result["repaired"] is True
    assert "首先，" not in result["repaired_body"]
    assert "不仅仅是" not in result["repaired_body"]
    assert "赋能" not in result["repaired_body"]
    assert "全链路" not in result["repaired_body"]
    assert any(unit["repair_passes"] >= 1 for unit in result["units"])


def test_release_gate_blocks_unverified_numeric_claim_and_personal_data() -> None:
    source = VALID_PACKAGE_BODY.replace(
        "客户如果看不到真实问题，就会划走，你也失去一次建立信任的机会。",
        "据统计，95%的客户都会划走；客户经理电话是 13800138000。",
        1,
    )

    result = run_release_gate(source)

    assert result["status"] == "blocked", result
    assert any("来源" in issue for issue in result["blocking_issues"])
    assert any("隐私" in issue for issue in result["blocking_issues"])


def test_release_gate_blocks_assistant_meta_language_local_paths_and_secret_like_values() -> None:
    source = VALID_PACKAGE_BODY.replace(
        "客户如果看不到真实问题，就会划走，你也失去一次建立信任的机会。",
        (
            "作为一个 AI，希望以上内容对你有所帮助。"
            "草稿位于 /Users/example/private/draft.md，临时值为 "
            "sk-1234567890abcdefghijkl。"
        ),
        1,
    )

    result = run_release_gate(source)

    assert result["status"] == "blocked", result
    assert any("聊天助手式说明" in issue for issue in result["blocking_issues"])
    assert any("本机路径" in issue for issue in result["blocking_issues"])
    assert any("疑似密钥" in issue for issue in result["blocking_issues"])


def test_release_gate_keeps_propagation_feedback_and_policy_examples_in_human_review() -> None:
    source = VALID_PACKAGE_BODY.replace(
        "- 发布标题：第一篇别急着介绍自己",
        "- 发布标题：内容复盘的五个动作",
        1,
    ).replace(
        "- 承诺：不承诺成交、流量或固定内容效果。",
        "- 承诺：不把清单包装成增长公式或成交保证。",
        1,
    )

    result = run_release_gate(source)

    assert result["status"] == "review_required", result
    assert not any("评论维护话术存在高风险" in issue for issue in result["blocking_issues"])
    assert any("标题点击力不足" in issue for issue in result["review_issues"])


def test_release_gate_still_blocks_a_risky_comment_script() -> None:
    source = VALID_PACKAGE_BODY.replace(
        "- 置顶：留下业务类型和目标客户，我帮你判断第一句话从哪里开始。",
        "- 置顶：私信领取完整诊断清单。",
        1,
    )

    result = run_release_gate(source)

    assert result["status"] == "blocked", result
    assert any("评论维护话术存在高风险" in issue for issue in result["blocking_issues"])


def test_six_hundred_character_article_is_not_forced_into_default_long_form() -> None:
    body = """# 平台原生内容 · 交期沟通

## 0. 共享事实底稿
- 本期平台：公众号
- 事实与案例：这是虚构练习。
- 共同观点：提前沟通。
- 不可公开边界：只作示例。

## 1. 公众号原生长文
- 发布标题：交期沟通
- 标题备选：怎样提前说明交期
- 摘要：本篇使用虚构情境说明如何把缺少的资料、提交时间和交期影响写清楚，给出可以调整后使用的沟通示例，不虚构客户反馈，也不承诺沟通效果。
- 头图文案：提前说明交期
- 排版提示：段落分明
- 正文插图位置：无需插图

### 正文
""" + ("练习文字。" * 120) + "\n\n### 评论区承接\n你的资料准备齐了吗？\n"
    result = run_release_gate(body)
    assert result["status"] != "blocked", result
    messages = "\n".join(result["review_issues"])
    assert "600 字" in messages
    assert "本篇已确认的篇幅要求" in messages
    assert "1,600-2,200" not in messages
    assert "至少需要两个" not in messages
    assert result["quality_checks"]["wechat_article_nonempty"] is True
