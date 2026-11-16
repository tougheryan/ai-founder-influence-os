"""Real runtime checks for author-material evidence, without model/network stubs."""
from __future__ import annotations

import json
import hashlib
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from content_runtime import ContentRuntime
import author_evidence
from content_pipeline import PipelineDirector
from demo_data import DEMO_SAMPLES


@pytest.fixture
def prepared(tmp_path):
    runtime = ContentRuntime(tmp_path)
    runtime.init()
    run = runtime.create_run(topic="客户临时改需求", platforms="公众号", run_id="author-a")
    runtime.write("intake", run["slug"], "作者提供的方法：先写清具体改动，再确认费用与时间。", run_id=run["run_id"])
    context = {
        "schema": "aifios.material-analysis.v1", "runId": run["run_id"],
        "inputFingerprint": "a" * 64, "analysisInputFingerprint": "a" * 64,
        "analysisStatus": "current", "input": {"rawMaterial": "先记录变更，不编客户故事。", "files": [], "links": []},
        "analysis": {"summary": "作者自带方法，没有业绩数据。", "opinions": ["先记录变更"],
                     "facts": [], "cases": [], "authorRequirements": ["不加销售引导"], "risks": []},
        "selection": {"materialTypeId": "method", "structureId": "problem-method"},
    }
    path = tmp_path / "sessions/material-analysis/author-a.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(context, ensure_ascii=False))
    return runtime, run, path


def request(runtime, run, topic="客户临时改需求，先把改动写清楚"):
    context = runtime.author_source_context(run["run_id"])
    return {"run_id": run["run_id"], "id": "author_" + uuid.uuid4().hex, "topic": topic,
            **{key: context[key] for key in ("intake_path", "intake_sha256", "material_sha256", "source_revision")}}


def plan(runtime, run, binding):
    return runtime.write("blueprint", run["slug"], "# 我的写作方案\n\n## 1. 共享事实底稿\n仅验证来源边界。\n\n## 2. 公众号独立蓝图\n先确认改动，再写费用与时间。\n\n" + author_evidence.binding_lines(binding), run_id=run["run_id"])


def test_explicit_author_source_requires_human_approval_and_no_market_evidence(prepared):
    runtime, run, _ = prepared
    binding = runtime.select_author_source(request(runtime, run))
    blueprint = plan(runtime, run, binding)
    before = runtime.run_state(run_id=run["run_id"])
    assert before["research_mode"] == "author_material"
    assert "topic_selection" not in before
    assert not list((runtime.project / "runs").rglob("market-research/*.json"))
    with pytest.raises(ValueError, match="确认"):
        runtime.write("package", run["slug"], "正文不能提前写入", run_id=run["run_id"])
    assert not list((runtime.project / "pipeline/package").glob("*.md"))
    approval = runtime.approve_artifact("topic_template", blueprint["path"], run["run_id"])
    assert approval["author_evidence_sha256"] == binding["author_evidence_sha256"]
    assert "market_snapshot_path" not in approval
    assert approval["author_evidence_frozen_at"]
    verified = runtime.assert_frozen_tikomni_market_snapshot("package", run["run_id"])
    assert verified["verified"] and verified["research_mode"] == "author_material"
    result = runtime.write("package", run["slug"], "仅用于验证运行时写入，不是模型文章。", run_id=run["run_id"])
    assert Path(result["path"]).is_file()


def test_same_operation_replays_but_different_or_superseded_selection_does_not(prepared):
    runtime, run, _ = prepared
    first = request(runtime, run)
    binding = runtime.select_author_source(first)
    assert runtime.select_author_source(first) == {**binding, "changed": False}
    with pytest.raises(ValueError, match="另一份"):
        runtime.select_author_source({**first, "topic": "另一个题目"})
    second = runtime.select_author_source(request(runtime, run, "改动确认以后再开工"))
    assert second["author_evidence_path"] != binding["author_evidence_path"]
    with pytest.raises(ValueError, match="替代"):
        runtime.select_author_source(first)
    assert len(list((runtime.project / "runs/author-a/author-evidence").glob("*.json"))) == 2


@pytest.mark.parametrize("change", ["analysis", "raw", "stale", "intake", "topic", "platform"])
def test_changed_source_revokes_approval_without_destroying_old_work(prepared, change):
    runtime, run, context_path = prepared
    binding = runtime.select_author_source(request(runtime, run))
    blueprint = plan(runtime, run, binding)
    runtime.approve_artifact("topic_template", blueprint["path"], run["run_id"])
    old_body = Path(blueprint["path"]).read_bytes()
    if change in ("analysis", "raw", "stale"):
        context = json.loads(context_path.read_text())
        if change == "analysis":
            context["analysis"]["authorRequirements"] = ["只写方法，结尾不提问"]
        elif change == "raw":
            # Detect actual input mutation even when a broken caller forgot
            # to update its inputFingerprint.
            context["input"]["rawMaterial"] += "新增真实材料"
        else:
            context["analysisStatus"] = "stale"
        context_path.write_text(json.dumps(context, ensure_ascii=False))
    elif change == "intake":
        path = runtime.project / binding["source_path"]
        path.write_text(path.read_text() + "\n底稿被修改")
    else:
        with runtime._state_lock():
            state = runtime._load_run_unlocked(run["run_id"], run["slug"])
            if change == "topic":
                state["topic"] = "另一个题目"
            else:
                state["target_platforms"] = ["小红书"]
            runtime._save_run_unlocked(state)
    assert not runtime.approval_status("topic_template", blueprint["path"], run["run_id"])["approved"]
    with pytest.raises(ValueError, match="确认"):
        runtime.write("package", run["slug"], "禁止写入", run_id=run["run_id"])
    assert Path(blueprint["path"]).read_bytes() == old_body
    assert (runtime.project / binding["author_evidence_path"]).exists()


def test_stale_selection_cannot_activate_author_mode(prepared):
    runtime, run, context_path = prepared
    choice = request(runtime, run)
    value = json.loads(context_path.read_text())
    value["analysis"]["opinions"] = ["采用另一个观点"]
    context_path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="已经变化"):
        runtime.select_author_source(choice)
    assert runtime.run_state(run_id=run["run_id"]).get("research_mode") != "author_material"
    assert not list((runtime.project / "runs").rglob("author_*.json"))


def test_two_tabs_can_only_commit_one_source_revision(prepared):
    runtime, run, _ = prepared
    choices = [request(runtime, run, title) for title in ("先明确范围", "先确认验收")]
    def choose(choice):
        try:
            return runtime.select_author_source(choice)["changed"]
        except ValueError:
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(choose, choices)) == [False, True]
    assert len(list((runtime.project / "runs/author-a/author-evidence").glob("*.json"))) == 1


def test_tampered_or_cross_run_record_is_rejected(prepared):
    runtime, run, _ = prepared
    binding = runtime.select_author_source(request(runtime, run))
    blueprint = plan(runtime, run, binding)
    runtime.approve_artifact("topic_template", blueprint["path"], run["run_id"])
    path = runtime.project / binding["author_evidence_path"]
    value = json.loads(path.read_text())
    value["run_id"] = "another-run"
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="无法核对"):
        runtime.verify_author_source(run["run_id"])
    assert not runtime.approval_status("topic_template", blueprint["path"], run["run_id"])["approved"]


def test_symlink_source_and_snapshot_paths_are_rejected(prepared, tmp_path):
    runtime, run, context_path = prepared
    original = context_path.read_bytes()
    external = tmp_path / "other.json"
    external.write_bytes(original)
    context_path.unlink()
    context_path.symlink_to(external)
    with pytest.raises(ValueError, match="符号链接"):
        runtime.author_source_context(run["run_id"])
    context_path.unlink()
    context_path.write_bytes(original)
    parent = tmp_path / "runs/author-a/author-evidence"
    parent.parent.mkdir(parents=True, exist_ok=True)
    external_dir = tmp_path / "other"
    external_dir.mkdir()
    parent.symlink_to(external_dir, target_is_directory=True)
    with pytest.raises(ValueError, match="符号链接"):
        runtime.select_author_source(request(runtime, run))
    assert not list(external_dir.iterdir())


def test_plan_cannot_fake_or_duplicate_an_author_binding(prepared):
    runtime, run, _ = prepared
    binding = runtime.select_author_source(request(runtime, run))
    for body in ("没有绑定的方案", author_evidence.binding_lines(binding) * 2,
                 author_evidence.binding_lines({**binding, "author_evidence_sha256": "0" * 64})):
        with pytest.raises(ValueError, match="准确引用"):
            runtime.write("blueprint", run["slug"], body, run_id=run["run_id"])
    assert not list((runtime.project / "pipeline/blueprint").glob("*.md"))


def test_legacy_run_cannot_use_author_marker_to_skip_market_gate(prepared):
    runtime, run, _ = prepared
    fake = {"author_evidence_path": "runs/author-a/author-evidence/author_" + "0" * 32 + ".json",
            "author_evidence_sha256": "0" * 64}
    blueprint = plan(runtime, run, fake)
    with pytest.raises(ValueError, match="TikOmni"):
        runtime.approve_artifact("topic_template", blueprint["path"], run["run_id"])


def test_cli_reads_selects_and_verifies_the_same_source(prepared):
    runtime, run, _ = prepared
    def cli(*args):
        completed = subprocess.run([sys.executable, str(SCRIPTS / "content_runtime.py"), "--project",
                                    str(runtime.project), *args], text=True, capture_output=True, check=True)
        return json.loads(completed.stdout)
    context = cli("author-source-context", "--run-id", run["run_id"])
    choice = {**request(runtime, run), **{key: context[key] for key in (
        "intake_path", "intake_sha256", "material_sha256", "source_revision",
    )}}
    request_path = runtime.project / "author-request.json"
    request_path.write_text(json.dumps(choice))
    binding = cli("author-source-select", "--content", "@" + str(request_path))
    blueprint = plan(runtime, run, binding)
    runtime.approve_artifact("topic_template", blueprint["path"], run["run_id"])
    verified = cli("writing-source-verify", "--run-id", run["run_id"], "--step", "package")
    assert verified["author_evidence_sha256"] == binding["author_evidence_sha256"]
    assert verified["research_mode"] == "author_material"


def test_non_semantic_context_save_keeps_source_valid(prepared):
    runtime, run, context_path = prepared
    binding = runtime.select_author_source(request(runtime, run))
    value = json.loads(context_path.read_text())
    value["updatedAt"] = "2026-09-18T23:00:00Z"
    context_path.write_text(json.dumps(value, indent=4))
    assert runtime.verify_author_source(run["run_id"])["author_evidence_sha256"] == binding["author_evidence_sha256"]


def test_implicit_blueprint_write_cannot_skip_author_binding(prepared):
    runtime, run, _ = prepared
    runtime.select_author_source(request(runtime, run))
    with pytest.raises(ValueError, match="准确引用"):
        runtime.write("blueprint", run["slug"], "旧脚本没有提供作者素材版本")
    assert not list((runtime.project / "pipeline/blueprint").glob("*.md"))


def test_archived_run_cannot_select_or_verify_author_source(prepared):
    runtime, run, _ = prepared
    choice = request(runtime, run)
    runtime.select_author_source(choice)
    runtime.archive_run(run["run_id"])
    with pytest.raises(ValueError, match="归档"):
        runtime.select_author_source(choice)
    with pytest.raises(ValueError, match="归档"):
        runtime.verify_author_source(run["run_id"])


def test_author_source_and_platform_research_remain_distinct(prepared):
    from test_runtime import approve_frozen_topic_template
    runtime, run, _ = prepared
    old = approve_frozen_topic_template(runtime, run["run_id"], run["slug"])
    snapshot = old["snapshot"]
    before = {path: path.read_bytes() for path in (runtime.project / "runs").rglob("market-research/**/*.json")}
    old_blueprint = Path(old["blueprint"]["path"]).read_bytes()
    author = runtime.select_author_source(request(runtime, run))
    assert not runtime.approval_status("topic_template", old["blueprint"]["path"], run["run_id"])["approved"]

    assert Path(old["blueprint"]["path"]).read_bytes() == old_blueprint
    for path, raw in before.items():
        assert path.read_bytes() == raw
    runtime.set_topic(run["run_id"], author["topic"], snapshot["manifest_path"], snapshot["snapshot_sha256"])
    state = runtime.run_state(run_id=run["run_id"])
    assert state["research_mode"] == "platform" and "author_evidence" not in state
    assert (runtime.project / author["author_evidence_path"]).is_file()
    with pytest.raises(ValueError, match="未选择"):
        runtime.verify_author_source(run["run_id"])
    assert not runtime.approval_status("topic_template", old["blueprint"]["path"], run["run_id"])["approved"]


def test_material_correction_requires_a_new_bound_plan_and_explicit_review(prepared):
    runtime, run, context_path = prepared
    first = runtime.select_author_source(request(runtime, run))
    old_plan = plan(runtime, run, first)
    runtime.approve_artifact("topic_template", old_plan["path"], run["run_id"])
    raw = context_path.read_bytes()
    context = json.loads(raw)
    correction_id = "correction_" + uuid.uuid4().hex
    runtime.apply_material_correction({
        "schema": "echo.material-correction.v1", "run_id": run["run_id"], "id": correction_id,
        "previous_id": "", "base_file_sha256": hashlib.sha256(raw).hexdigest(),
        "input_fingerprint": context["inputFingerprint"], "expected_fingerprint": "b" * 64,
        "created_at": "2026-09-18T17:00:00", "analysis": {
            **context["analysis"], "authorRequirements": ["只写实际做法，不加结尾提问"],
        },
    })
    assert not runtime.approval_status("topic_template", old_plan["path"], run["run_id"])["approved"]
    second = runtime.select_author_source(request(runtime, run))
    assert second["material_correction_id"] == correction_id
    with pytest.raises(ValueError, match="准确引用"):
        runtime.approve_artifact("topic_template", old_plan["path"], run["run_id"], reviewed_material_correction_id=correction_id)
    new_plan = plan(runtime, run, second)
    with pytest.raises(ValueError, match="重新读取"):
        runtime.approve_artifact("topic_template", new_plan["path"], run["run_id"])
    runtime.approve_artifact("topic_template", new_plan["path"], run["run_id"], reviewed_material_correction_id=correction_id)
    assert runtime.approval_status("topic_template", new_plan["path"], run["run_id"])["approved"]
    assert context_path.read_bytes() == raw


def test_interrupted_source_commit_is_recoverable_without_duplicate_records(prepared, monkeypatch):
    runtime, run, _ = prepared
    choice = request(runtime, run)
    save = runtime._save_run_unlocked
    def interrupted(_run):
        raise OSError("simulated interruption before run-file commit")
    monkeypatch.setattr(runtime, "_save_run_unlocked", interrupted)
    with pytest.raises(OSError, match="interruption"):
        runtime.select_author_source(choice)
    assert runtime.run_state(run_id=run["run_id"]).get("research_mode") != "author_material"
    monkeypatch.setattr(runtime, "_save_run_unlocked", save)
    assert runtime.select_author_source(choice)["verified"]
    assert len(list((runtime.project / "runs/author-a/author-evidence").glob("*.json"))) == 1


@pytest.mark.parametrize('command', ['next', 'flow'])
def test_author_director_prepares_plan_without_research_and_preserves_input(prepared, monkeypatch, command):
    runtime, run, _ = prepared
    binding = runtime.select_author_source(request(runtime, run))
    intake = (runtime.project / binding['source_path']).read_bytes()
    # A historical validation result must not impose platform research on an
    # explicitly selected author path.
    runtime.write('validate', run['slug'], '历史记录，尚未作出研究结论', run_id=run['run_id'])
    monkeypatch.setattr(PipelineDirector, '_market_signal_gate', lambda *_: pytest.fail('author path requested market research'))
    director = PipelineDirector(runtime.project, slug=run['slug'])
    result = getattr(director, command)()
    assert result['status'] in ('ready', 'flow_ready'), result
    assert result.get('recommended_step', result.get('current_step')) == 'blueprint'
    assert result['upstream'] == 'intake'
    assert result['author_source']['author_evidence_sha256'] == binding['author_evidence_sha256']
    assert result['market_signal'] is None and result['validate_audit'] is None
    task = Path(result['task_card']).read_text()
    assert author_evidence.binding_lines(binding) in task
    assert '已确认题目 + 本期作者素材快照' in task
    assert 'INTAKE=' not in task
    assert (runtime.project / binding['source_path']).read_bytes() == intake
    status = director.status()
    assert status['research_mode'] == 'author_material'
    assert 'validate' not in status['scheduled_steps']
    assert next(row for row in status['rows'] if row.get('step') == 'validate')['skipped']
    assert not list((runtime.project / 'runs').rglob('market-research/*.json'))


@pytest.mark.parametrize('change', ['material', 'evidence', 'mode_only', 'platform'])
@pytest.mark.parametrize('command', ['next', 'flow'])
def test_author_director_stops_invalid_source_without_research(prepared, monkeypatch, change, command):
    runtime, run, context_path = prepared
    binding = runtime.select_author_source(request(runtime, run))
    if change == 'material':
        context = json.loads(context_path.read_text())
        context['analysis']['opinions'] = ['换一个观点']
        context_path.write_text(json.dumps(context, ensure_ascii=False))
    elif change == 'evidence':
        (runtime.project / binding['author_evidence_path']).unlink()
    else:
        with runtime._state_lock():
            state = runtime._load_run_unlocked(run['run_id'], run['slug'])
            if change == 'mode_only':
                state.pop('author_evidence')
            else:
                state['target_platforms'] = ['xhs']
            runtime._save_run_unlocked(state)
    monkeypatch.setattr(PipelineDirector, '_market_signal_gate', lambda *_: pytest.fail('invalid source fell back to research'))
    director = PipelineDirector(runtime.project, slug=run['slug'])
    result = getattr(director, command)()
    assert result['status'] == 'blocked', result
    assert result['recommended_step'] == 'author-source'
    assert director.status()['author_source']['status'] == 'blocked'
    assert not list((runtime.project / 'pipeline/blueprint').glob('*.md'))


def test_author_director_uses_requested_run_platforms_not_other_active_run(prepared, monkeypatch):
    runtime, run, _ = prepared
    runtime.select_author_source(request(runtime, run))
    other = runtime.create_run(topic='另一份小红书稿', platforms='小红书', run_id='other-xhs')
    assert runtime.state()['active_run_id'] == other['run_id']
    monkeypatch.setattr(PipelineDirector, '_market_signal_gate', lambda *_: pytest.fail('unexpected research'))
    director = PipelineDirector(runtime.project, slug=run['slug'])
    assert director.status()['target_platforms'] == ['wechat']
    assert director.status()['current_step'] == runtime.run_state(run_id=run['run_id'])['current_step']
    assert director.next()['target_platforms'] == ['wechat']
    # Supplying the slug at invocation must also refresh the platform scope.
    assert PipelineDirector(runtime.project).flow(slug=run['slug'])['target_platforms'] == ['wechat']
    assert PipelineDirector(runtime.project, slug='missing').status()['target_platforms'] == []


@pytest.mark.parametrize('command', ['next', 'flow'])
def test_author_director_still_requires_plan_confirmation_and_stops_before_publication(prepared, command):
    runtime, run, _ = prepared
    binding = runtime.select_author_source(request(runtime, run))
    blueprint = runtime.write('blueprint', run['slug'], '# 测试方案\n\n## 1. 共享事实底稿\n仅为契约测试。\n\n## 2. 公众号独立蓝图\n先确认改动。\n\n' + author_evidence.binding_lines(binding), run_id=run['run_id'])
    result = getattr(PipelineDirector(runtime.project, slug=run['slug']), command)()
    assert result['status'] in ('blocked', 'flow_blocked'), result
    runtime.approve_artifact('topic_template', blueprint['path'], run['run_id'])
    result = getattr(PipelineDirector(runtime.project, slug=run['slug']), command)()
    assert result['status'] in ('ready', 'flow_ready'), result
    assert result.get('recommended_step', result.get('current_step')) == 'package'
    # Stored fixtures exercise scheduling only; they are not generated deliverables.
    content_binding = {'path': Path(blueprint['path']).relative_to(runtime.project).as_posix(),
                       'sha256': hashlib.sha256(Path(blueprint['path']).read_bytes()).hexdigest(),
                       'material_correction_id': ''}
    marker = '<!-- echo-content-plan:' + json.dumps(content_binding, ensure_ascii=False) + ' -->'
    assert marker in Path(result['task_card']).read_text()
    for step in ['package', 'visual', 'prelaunch', 'compliance', 'audit']:
        body = (marker + '\n' if step == 'package' else '') + DEMO_SAMPLES[step]
        runtime.write(step, run['slug'], body, run_id=run['run_id'])
    result = getattr(PipelineDirector(runtime.project, slug=run['slug']), command)()
    assert result['status'] == 'awaiting_approval'
    assert result['required_approval'] == 'draft_information'
    assert not set(result['scheduled_steps']) & {'validate', 'publish', 'performance', 'review'}


@pytest.mark.parametrize('command', ['next', 'flow'])
def test_author_director_replaces_stale_plan_without_discarding_old_draft(prepared, command):
    runtime, run, _ = prepared
    first = runtime.select_author_source(request(runtime, run))
    blueprint = runtime.write('blueprint', run['slug'], '# 测试方案\n\n## 1. 共享事实底稿\n仅为契约测试。\n\n## 2. 公众号独立蓝图\n先确认改动。\n\n' + author_evidence.binding_lines(first), run_id=run['run_id'])
    runtime.approve_artifact('topic_template', blueprint['path'], run['run_id'])
    package = runtime.write('package', run['slug'], DEMO_SAMPLES['package'], run_id=run['run_id'])
    old_plan = Path(blueprint['path']).read_bytes()
    old_draft = Path(package['path']).read_bytes()
    second = runtime.select_author_source(request(runtime, run, '重新确定的题目'))
    result = getattr(PipelineDirector(runtime.project, slug=run['slug']), command)()
    assert result['status'] in ('ready', 'flow_ready'), result
    assert result.get('recommended_step', result.get('current_step')) == 'blueprint'
    new_plan = runtime.write('blueprint', run['slug'], '# 测试方案\n\n## 1. 共享事实底稿\n仅为契约测试。\n\n## 2. 公众号独立蓝图\n先确认改动。\n\n' + author_evidence.binding_lines(second), run_id=run['run_id'])
    runtime.approve_artifact('topic_template', new_plan['path'], run['run_id'])
    result = getattr(PipelineDirector(runtime.project, slug=run['slug']), command)()
    assert result.get('recommended_step', result.get('current_step')) == 'package', result
    assert Path(blueprint['path']).read_bytes() == old_plan
    assert Path(package['path']).read_bytes() == old_draft


def test_make_flow_continues_author_run_without_reimporting_intake(prepared):
    runtime, run, _ = prepared
    binding = runtime.select_author_source(request(runtime, run))
    before = runtime.run_state(run_id=run['run_id'])
    repo = SCRIPTS.parents[2]
    for working_dir, target in [(repo, 'flow'), (SCRIPTS.parent, 'content-flow')]:
        result = subprocess.run(['make', '-C', str(working_dir), target,
                                 f'PROJECT={runtime.project}', f'SLUG={run["slug"]}'],
                                text=True, capture_output=True, timeout=30)
        assert result.returncode == 0, result.stderr
        assert '"status": "flow_ready"' in result.stdout, result.stdout
        assert '"current_step": "blueprint"' in result.stdout
    after = runtime.run_state(run_id=run['run_id'])
    assert before == after
    assert runtime.verify_author_source(run['run_id'])['author_evidence_sha256'] == binding['author_evidence_sha256']
