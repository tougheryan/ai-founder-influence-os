#!/usr/bin/env python3
"""Keep the documented content-production loop aligned with runtime and UI controls."""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_SCRIPTS = REPO_ROOT / "skills" / "content-runtime" / "scripts"
LOOP_CONFIG = REPO_ROOT / "skills" / "content-runtime" / "config" / "production-loop.json"
LOOP_DOC = REPO_ROOT / "docs" / "content-production-loop.md"
REGISTRY = REPO_ROOT / "ui" / "lib" / "pipeline-registry.ts"
STEP_DETAIL = REPO_ROOT / "ui" / "components" / "StepDetail.tsx"

sys.path.insert(0, str(RUNTIME_SCRIPTS))

from content_pipeline import (  # noqa: E402
    DRAFT_INFORMATION_APPROVAL,
    DRAFT_PREPARATION_STEPS,
    DEFAULT_EDITORIAL_CORE_STEPS,
    DEFAULT_SCHEDULED_STEPS,
    OPTIONAL_EXPLORATION_STEPS,
    OPTIONAL_PLATFORM_OVERRIDE_STEPS,
    PIPELINE,
    PUBLICATION_RESULT_STEPS,
    WEEKLY_LEARNING_STEPS,
    UPSTREAM,
)
from content_runtime import ContentRuntime, STEP_DIRS, STEPS  # noqa: E402


MANUAL_ARTIFACT_STEPS = frozenset({"douyin"})
SUPPORTED_RELEASE_PLATFORMS = ["wechat", "xhs", "shipinhao"]
LEGACY_RELEASE_PLATFORMS = ["wechat", "xhs", "shipinhao", "douyin", "moments"]


class LoopContractError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise LoopContractError(message)


def pipeline_steps() -> list[str]:
    result: list[str] = []
    for item in PIPELINE:
        if isinstance(item, str):
            result.append(item)
        else:
            result.extend(item.get("branches", []))
    return result


def production_loop_steps() -> list[str]:
    return [step for step in STEPS if step not in MANUAL_ARTIFACT_STEPS]


def schedule_steps(config: dict[str, object], schedule_id: str) -> list[str]:
    schedules = config.get("schedules")
    require(isinstance(schedules, dict), "production loop must define schedules")
    schedule = schedules.get(schedule_id)
    require(isinstance(schedule, dict), f"schedules.{schedule_id} must be an object")
    require(bool(str(schedule.get("label", "")).strip()), f"schedules.{schedule_id} is missing label")
    require(bool(str(schedule.get("description", "")).strip()), f"schedules.{schedule_id} is missing description")
    steps = schedule.get("runtime_steps")
    require(isinstance(steps, list), f"schedules.{schedule_id}.runtime_steps must be a list")
    require(
        all(isinstance(step, str) and step for step in steps),
        f"schedules.{schedule_id}.runtime_steps contains an invalid step",
    )
    return list(steps)


def check_config(config: dict[str, object]) -> None:
    require(config.get("schema") == "aifios.production-loop.v1", "production loop schema is missing or unsupported")
    scope = config.get("scope")
    require(isinstance(scope, dict), "production loop scope must be an object")
    require(
        scope.get("supported_platforms") == SUPPORTED_RELEASE_PLATFORMS,
        "loop scope must list every supported release platform in canonical order",
    )

    topic_gate = config.get("pre_validate_quality_gate")
    require(isinstance(topic_gate, dict), "production loop must define an intake-to-validate quality gate")
    require(topic_gate.get("id") == "market-signal", "topic quality gate must be market-signal")
    require(topic_gate.get("between") == ["intake", "validate"], "market-signal must run between intake and validate")
    require(topic_gate.get("required") is True, "market-signal cannot be optional")
    require(topic_gate.get("applies_to") == ["platform"], "market-signal applies only to the explicit platform-research path")
    require(topic_gate.get("source_policy") == "public_samples_only", "market-signal must only use public samples")
    insufficient_behavior = str(topic_gate.get("sample_insufficient_behavior", "")).strip()
    require(insufficient_behavior, "market-signal must define sample-insufficient behavior")
    require("Block only when every selected platform lane lacks usable evidence" in insufficient_behavior, "market-signal must preserve successful selected-platform lanes")
    require("unknown metrics as unknown" in insufficient_behavior, "market-signal must preserve unknown metrics")

    expected_editorial_core = ["intake", "validate", "blueprint", "package"]
    expected_draft_preparation = ["visual", "prelaunch", "compliance", "audit"]
    expected_publication_result = ["publish"]
    expected_weekly_learning = ["performance", "review", "archive", "twin"]
    expected_exploration = ["angle", "breakdown", "dbs-fusion"]
    expected_platform_overrides: list[str] = []
    expected_legacy_compat = ["write", "xhs", "platform-adapt"]
    editorial_core = schedule_steps(config, "editorial_core")
    draft_preparation = schedule_steps(config, "draft_preparation")
    publication_result = schedule_steps(config, "publication_result")
    weekly_learning = schedule_steps(config, "weekly_learning")
    require(editorial_core == expected_editorial_core, "editorial_core no longer represents the supported content-production path")
    require(draft_preparation == expected_draft_preparation, "draft_preparation must end at audited platform draft information")
    require(publication_result == expected_publication_result, "publication_result must remain event-driven")
    require(weekly_learning == expected_weekly_learning, "weekly_learning no longer represents the optional learning loop")
    require(config.get("default_schedule") == ["editorial_core", "draft_preparation"], "default_schedule must stop before publication and weekly learning")
    require(DRAFT_INFORMATION_APPROVAL == "draft_information", "draft_preparation must terminate at draft_information approval")

    schedules = config["schedules"]  # type: ignore[index]
    editorial_group = schedules["editorial_core"]  # type: ignore[index]
    require(
        editorial_group.get("required_quality_gates") == ["market-signal", "platform-native-package"],  # type: ignore[union-attr]
        "editorial_core must declare market-signal and platform-native package quality gates",
    )

    expected_path = [*editorial_core, *draft_preparation]
    modes = config.get("writing_modes", {})
    require(set(modes) == {"platform", "author_material"}, "writing modes must be explicit")
    require(modes["platform"].get("runtime_steps") == expected_path, "platform research retains the standard schedule")
    require(modes["author_material"].get("runtime_steps") == [step for step in expected_path if step != "validate"], "author material must reach the same delivery checks without market validation")
    require(modes["author_material"].get("required_quality_gates") == ["author-source", "platform-native-package"], "author material requires verified author evidence and native package checks")
    require(modes["author_material"].get("source_policy") == "author_material_only_no_market_claims", "author material cannot claim market evidence")
    require(config.get("standard_path") == expected_path, "standard_path must be derived from the default schedules")
    require(list(DEFAULT_EDITORIAL_CORE_STEPS) == editorial_core, "content_pipeline did not load editorial_core from config")
    require(list(DRAFT_PREPARATION_STEPS) == draft_preparation, "content_pipeline did not load draft_preparation from config")
    require(list(PUBLICATION_RESULT_STEPS) == publication_result, "content_pipeline did not load publication_result from config")
    require(list(WEEKLY_LEARNING_STEPS) == weekly_learning, "content_pipeline did not load weekly_learning from config")
    require(list(DEFAULT_SCHEDULED_STEPS) == expected_path, "content_pipeline default schedule drifted from configured schedules")
    require(pipeline_steps() == expected_path, "content_pipeline PIPELINE must stop before publication and weekly learning")
    require(not set(pipeline_steps()) & {"angle", "breakdown", "xhs", "platform-adapt"}, "legacy regeneration branches cannot enter the default schedule")
    require(not set(pipeline_steps()) & set(weekly_learning), "weekly learning cannot enter the default schedule")
    grouped_steps = [*editorial_core, *draft_preparation, *publication_result, *weekly_learning, *expected_exploration, *expected_platform_overrides, *expected_legacy_compat]
    require(len(grouped_steps) == len(set(grouped_steps)), "schedules and advanced branches must not duplicate runtime steps")

    stages = config.get("stages")
    require(isinstance(stages, list), "loop stages must be a list")
    stage_by_step = {item.get("step"): item for item in stages if isinstance(item, dict)}
    expected_loop_steps = production_loop_steps()
    require(
        set(grouped_steps) == set(expected_loop_steps),
        "schedules and advanced branches must classify every scheduled runtime step exactly once",
    )
    require(set(stage_by_step) == set(expected_loop_steps), "loop stages must cover every scheduled production step exactly once")
    require(len(stage_by_step) == len(expected_loop_steps), "loop stages contain duplicate or invalid scheduled production steps")
    require(MANUAL_ARTIFACT_STEPS <= set(STEPS), "manual artifact steps must exist in the runtime")
    require(not (MANUAL_ARTIFACT_STEPS & set(pipeline_steps())), "manual artifact steps must not be auto-scheduled")
    valid_modes = {"semi_automatic", "manual_required"}
    for step in expected_loop_steps:
        item = stage_by_step[step]
        require(item.get("automation") in valid_modes, f"{step}: invalid automation mode")
        for field in ("system_action", "human_action", "exit_criteria", "on_blocked"):
            require(bool(str(item.get(field, "")).strip()), f"{step}: missing {field}")
        if step != "intake" and item.get("lane") == "core":
            require(step in UPSTREAM, f"{step}: missing runtime upstream declaration")

    require(stage_by_step["publish"].get("automation") == "manual_required", "publish must remain manual_required")
    require(stage_by_step["publish"].get("lane") == "event_driven", "publish must not be a serial production stage")
    for step in weekly_learning:
        require(stage_by_step[step].get("lane") == "weekly", f"{step} must remain in the weekly learning lane")
    for step in expected_legacy_compat:
        require(stage_by_step[step].get("lane") == "legacy_compat", f"{step} must remain read-compatible and outside the new production path")
    controls = config.get("human_control_points")
    require(isinstance(controls, list), "human control points must be a list")
    expected_controls = {
        "H1": "intake",
        "H2": "blueprint",
        "H3": "package",
        "H4": "visual",
        "H5": "audit",
        "H6": "publish",
        "H7": "review",
    }
    actual_controls = {
        item.get("id"): item.get("after")
        for item in controls
        if isinstance(item, dict) and item.get("required") in {True, "conditional"}
    }
    require(actual_controls == expected_controls, "human control points must cover the seven production phases at the canonical gates")

    optional = config.get("optional_branches")
    require(isinstance(optional, list), "optional branches must be a list")
    branch_ids = {item.get("id") for item in optional if isinstance(item, dict)}
    require(
        branch_ids == {"market-signal", "angle-breakdown", "business-diagnosis"},
        "optional branch inventory is incomplete",
    )
    market_branch = next((item for item in optional if isinstance(item, dict) and item.get("id") == "market-signal"), None)
    require(isinstance(market_branch, dict), "market-signal branch definition is missing")
    require(market_branch.get("required") is True, "market-signal branch must be marked as required")
    require(market_branch.get("source_policy") == "public_samples_only", "market-signal branch must only use public samples")
    branch_insufficient_behavior = str(market_branch.get("on_sample_insufficient", "")).strip()
    require(branch_insufficient_behavior, "market-signal branch must define sample-insufficient behavior")
    require("所有已选平台都无可用证据时阻断" in branch_insufficient_behavior, "market-signal branch must only block the whole run when every selected lane fails")
    require("单个平台失败只阻断该平台分线" in branch_insufficient_behavior, "market-signal branch must isolate platform failures")
    config_text = json.dumps(config, ensure_ascii=False)
    require("按一手素材保守判断" not in config_text, "production loop cannot retain a first-party conservative-validate fallback")
    optional_runtime_steps = [
        step
        for item in optional
        if isinstance(item, dict) and item.get("id") != "market-signal"
        for step in item.get("runtime_steps", [])
    ]
    require(
        optional_runtime_steps == [*expected_exploration, *expected_platform_overrides],
        "advanced regeneration steps must match optional_branches runtime steps in canonical order",
    )


def check_runtime_init() -> None:
    with tempfile.TemporaryDirectory(prefix="aifios-loop-contract-") as directory:
        runtime = ContentRuntime(directory)
        runtime.init()
        for step in STEPS:
            directory_name = STEP_DIRS.get(step, step)
            require((runtime.pipeline / directory_name).is_dir(), f"runtime init does not create pipeline/{directory_name}")
        for platform in LEGACY_RELEASE_PLATFORMS:
            require(
                (runtime.pipeline / "platform-adapt" / platform).is_dir(),
                f"runtime init does not create platform-adapt directory for {platform}",
            )
        require((runtime.materials / "research").is_dir(), "runtime init does not create materials/research")
        for platform in LEGACY_RELEASE_PLATFORMS:
            require(
                (runtime.materials / "hit-library" / platform).is_dir(),
                f"runtime init does not create hit-library directory for {platform}",
            )
        require((runtime.materials / "publish-proof").is_dir(), "runtime init does not create materials/publish-proof")
        require((runtime.brain_dir / "twin").is_dir(), "runtime init does not create brain/twin")


def check_docs_and_ui() -> None:
    doc = LOOP_DOC.read_text(encoding="utf-8")
    required_headings = [
        "## 1. 这套系统解决什么",
        "## 2. 三种执行方式",
        "## 3. 全链路图",
        "## 5. 核心生产步骤",
        "## 6. 可选支线：什么时候才需要",
        "## 7. 必须遵守的人工控制点",
        "## 8. 异常处理与回流规则",
        "## 10. 运行健康检查",
    ]
    for heading in required_headings:
        require(heading in doc, f"production-loop guide is missing {heading}")
    for needle in (
        "market-signal",
        "样本不足",
        "任意非空子集",
        "P1-P8",
        "指标缺失",
        "视频号",
        "平台失败互不连坐",
    ):
        require(needle in doc, f"production-loop guide is missing multi-platform contract: {needle}")

    registry = REGISTRY.read_text(encoding="utf-8")
    for field in ("automationMode:", "humanGate:", "blockedReturn:"):
        require(registry.count(field) == 11, f"pipeline registry must define {field} for all ten workspace stages")
    detail = STEP_DETAIL.read_text(encoding="utf-8")
    for needle in ("getAutomationMeta", "detail.automationMode", "detail.humanGate", "detail.blockedReturn"):
        require(needle in detail, f"StepDetail must render loop governance field: {needle}")


def main() -> int:
    try:
        config = json.loads(LOOP_CONFIG.read_text(encoding="utf-8"))
        require(isinstance(config, dict), "production loop config must be a JSON object")
        check_config(config)
        check_runtime_init()
        check_docs_and_ui()
    except (OSError, ValueError, LoopContractError) as error:
        print(f"FAIL content production loop: {error}", file=sys.stderr)
        return 1

    print("PASS content production loop")
    print(f"runtime_steps={len(STEPS)}")
    print("human_controls=H1,H2,H3,H4,H5,H6,H7")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
