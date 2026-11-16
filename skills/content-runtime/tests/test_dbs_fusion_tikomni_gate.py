from __future__ import annotations

import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPTS_DIR = REPO_ROOT / "skills" / "content-runtime" / "scripts"
if str(SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPTS_DIR))

from content_runtime import ContentRuntime
from dbs_fusion_apply import apply_dbs_fusion


def valid_fusion_body() -> str:
    return """# DBS 融合写回

## 0. 融合任务
- 模式：选题诊断
- 触发问题：怎样让一篇内容的开场先说中客户的真实问题？
- 上游输入：pipeline/intake/customer-problem.md 的已授权客户访谈素材。
- 目标写回：pipeline/breakdown/customer-problem.md 的开场钩子库。

## 1. 调用链
| skill | 输入证据 | 输出摘要 | 状态 |
|---|---|---|---|
| dbs-content | 客户访谈中的高频卡点 | 先表达问题再给方法 | review |

## 2. 关键结论
- 结论：开场先命名客户正在承受的成本，再说明可验证的方法，能减少自我介绍式表达。
- 置信度：高
- 证据：来源于已授权访谈中的重复提问和停留反馈。

## 3. 证据与风险
| 来源 | 风险 | 处理 |
|---|---|---|
| 已授权客户访谈 | 不可夸大转化效果 | 只写可核验的原话与场景 |

## 4. 写回计划
| 写回位置 | 写回内容 | 下游调用 | 状态 |
|---|---|---|---|
| pipeline/breakdown/customer-problem.md | 开场先说客户正在付出的成本，再给一个具体判断。 | /content-breakdown | 待写回 |

## 5. 下一步动作
- 调用 /content-breakdown 生成完整开场钩子库。

## 6. 人工复核
- 复核客户原话是否已获公开授权，并确认不能把个案写成普遍结果。
"""


def test_dbs_fusion_writeback_cannot_bypass_frozen_tikomni_gate(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    created = runtime.create_run(topic="客户问题优先", run_id="dbs-gate-run")
    fusion = runtime.write("dbs-fusion", created["slug"], valid_fusion_body(), source="test")

    assert runtime.validate("dbs-fusion", fusion["path"])["valid"] is True

    result = apply_dbs_fusion(tmp_path, fusion["path"], slug=created["slug"])

    assert result["status"] == "blocked"
    assert result["run_id"] == created["run_id"]
    assert result["rows"][0]["action"] == "tikomni-gate-blocked"
    assert "TikOmni" in result["rows"][0]["message"] or "蓝图" in result["rows"][0]["message"]
    assert not list((tmp_path / "pipeline" / "breakdown").glob("*.md"))


def test_explicit_runtime_write_stays_bound_to_its_resolved_run(tmp_path: Path) -> None:
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    target = runtime.create_run(topic="目标任务", run_id="target-run")
    other = runtime.create_run(topic="另一个任务", run_id="other-run")

    written = runtime.write(
        "intake",
        target["slug"],
        "这是目标任务的已授权素材。",
        source="test",
        run_id=target["run_id"],
    )

    relative_path = Path(written["path"]).relative_to(tmp_path).as_posix()
    target_state = runtime.run_state(run_id=target["run_id"])
    other_state = runtime.run_state(run_id=other["run_id"])
    session_state = runtime.state()

    assert written["run_id"] == target["run_id"]
    assert target_state["steps"]["intake"]["latest"] == relative_path
    assert target_state["history"][-1]["path"] == relative_path
    assert "这是目标任务的已授权素材" in Path(written["path"]).read_text(encoding="utf-8")
    assert "intake" not in other_state["steps"]
    assert not any(item.get("path") == relative_path for item in other_state["history"])
    assert session_state["latest_by_slug"][target["slug"]]["intake"] == relative_path
    # An explicit run ID addresses the write target; it must not undo the
    # operator's currently active run selection.
    assert session_state["active_run_id"] == other["run_id"]
    assert session_state["current_slug"] == other["slug"]
