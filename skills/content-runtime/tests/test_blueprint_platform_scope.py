"""Platform checks include runtime approval/writes, not just a heading parser."""
import itertools
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from blueprint_platform_scope import check_platform_scope, LABELS
from test_author_evidence import prepared, request, plan
import author_evidence


@pytest.mark.parametrize("platforms", [list(c) for n in range(1, 4) for c in itertools.combinations(LABELS, n)])
def test_all_selected_combinations(platforms):
    text = "\n".join(f"## {i + 2}. {LABELS[p]}独立蓝图\n正文提到公众号、小红书和视频号。" for i, p in enumerate(platforms))
    check = check_platform_scope(text, platforms)
    assert check["scope_matches"]
    assert check["quality_verified"] is False


@pytest.mark.parametrize("addition", ["## 小红书独立蓝图", "## 公众号独立蓝图", "## 未知独立蓝图"])
def test_extra_duplicate_unknown(addition):
    assert not check_platform_scope("## 公众号独立蓝图\n正文\n" + addition, ["wechat"])["scope_matches"]


@pytest.mark.parametrize("wrapper", ["```md\n{}\n```", "~~~\n{}\n~~~", "<!-- {} -->", "> {}", "    {}"])
def test_quoted_or_hidden_headings_do_not_complete_a_plan(wrapper):
    assert not check_platform_scope(wrapper.format("## 公众号独立蓝图"), ["wechat"])["scope_matches"]


def test_saved_wrong_scope_cannot_be_approved_or_written_and_original_survives(prepared):
    runtime, run, _ = prepared
    binding = runtime.select_author_source(request(runtime, run))
    body = "# 模拟原始失败\n\n## 1. 共享事实底稿\n本期平台：wechat\n\n## 公众号独立蓝图\n方案\n\n## 小红书独立蓝图\n多出八页卡片\n\n" + author_evidence.binding_lines(binding)
    wrong = runtime.write("blueprint", run["slug"], body, run_id=run["run_id"])
    original = Path(wrong["path"]).read_bytes()
    validation = runtime.validate("blueprint", wrong["path"], run["run_id"])
    assert not validation["valid"]
    assert validation["platform_scope"]["extra"] == ["xhs"]
    assert validation["quality_status"] != "pass"
    with pytest.raises(ValueError, match="未选平台"):
        runtime.approve_artifact("topic_template", wrong["path"], run["run_id"])
    with pytest.raises(ValueError, match="确认"):
        runtime.write("package", run["slug"], "不能绕过", run_id=run["run_id"])
    corrected = plan(runtime, run, binding)
    runtime.approve_artifact("topic_template", corrected["path"], run["run_id"])
    assert runtime.approval_status("topic_template", corrected["path"], run["run_id"])["approved"]
    # Changing bytes behind an existing approval cannot restore the old loophole.
    with Path(corrected["path"]).open("a") as handle:
        handle.write("\n## 小红书独立蓝图\n又多出了一个平台\n")
    assert not runtime.approval_status("topic_template", corrected["path"], run["run_id"])["approved"]
    with pytest.raises(ValueError, match="确认"):
        runtime.assert_frozen_tikomni_market_snapshot("package", run["run_id"])
    assert Path(wrong["path"]).read_bytes() == original


def test_shared_facts_only_and_spoofed_scope_do_not_pass(prepared):
    runtime, run, _ = prepared
    binding = runtime.select_author_source(request(runtime, run))
    for body in ["## 1. 共享事实底稿\n无方案", "本期平台：shipinhao\n## 视频号独立蓝图\n假装只选视频"]:
        saved = runtime.write("blueprint", run["slug"], body + "\n" + author_evidence.binding_lines(binding), run_id=run["run_id"])
        check = runtime.validate("blueprint", saved["path"], run["run_id"])
        assert not check["valid"]
        assert check["platform_scope"]["expected"] == ["wechat"]


def test_native_body_cannot_change_the_run_platforms_when_written_or_approved(prepared):
    runtime, run, _ = prepared
    binding = runtime.select_author_source(request(runtime, run))
    blueprint = plan(runtime, run, binding)
    runtime.approve_artifact("topic_template", blueprint["path"], run["run_id"])
    correct = "## 0. 共享事实底稿\n- 本期平台：wechat\n## 1. 公众号原生长文\n- 发布标题：标题\n### 正文\n正文。\n### 评论区承接\n问题？"
    saved = runtime.write("package", run["slug"], correct, run_id=run["run_id"])
    wrong = correct.replace("wechat", "shipinhao").replace("1. 公众号原生长文", "3. 视频号原生口播")
    with pytest.raises(ValueError, match="已选平台"):
        runtime.write("package", run["slug"], wrong, run_id=run["run_id"])
    assert runtime.run_state(run_id=run["run_id"])["steps"]["package"]["latest"] == Path(saved["path"]).relative_to(runtime.project).as_posix()
    Path(saved["path"]).write_text(wrong)
    with pytest.raises(ValueError, match="已选平台"):
        runtime.approve_artifact("content_package", saved["path"], run["run_id"])


def test_legacy_format_requires_its_full_contract_and_never_claims_native_scope(prepared):
    runtime, run, _ = prepared
    binding = runtime.select_author_source(request(runtime, run))
    run_file = runtime.project / "runs" / (run["run_id"] + ".json")
    state = json.loads(run_file.read_text())
    state["schema"] = "aifios.production-run.v1"
    run_file.write_text(json.dumps(state))
    fake = runtime.write("blueprint", run["slug"], "## 1. 共享事实底稿\n仅有标题\n" + author_evidence.binding_lines(binding), run_id=run["run_id"])
    assert not runtime.validate("blueprint", fake["path"], run["run_id"])["valid"]
    with pytest.raises(ValueError, match="历史格式"):
        runtime.approve_artifact("topic_template", fake["path"], run["run_id"])
    headings = ["上游约束", "爆款拆解吸收", "核心判断", "目标读者与情绪入口", "公众号思想母版骨架", "证据链与素材分配", "叙事推进与章节任务", "金句与可拆资产", "评论区互动预埋", "风险边界", "人工确认清单", "下一步执行指令"]
    body = "\n\n".join(f"## {i}. {heading}\n旧版契约测试说明。" for i, heading in enumerate(headings))
    saved = runtime.write("blueprint", run["slug"], body + "\n" + author_evidence.binding_lines(binding), run_id=run["run_id"])
    validation = runtime.validate("blueprint", saved["path"], run["run_id"])
    assert validation["valid"]
    assert validation["contract"] == "aifios.legacy-blueprint.v1"
    assert validation["platform_scope"]["legacy_contract_validated"]
    assert not validation["platform_scope"]["scope_matches"]
