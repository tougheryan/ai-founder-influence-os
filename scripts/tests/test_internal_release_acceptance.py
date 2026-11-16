from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def gate():
    spec = importlib.util.spec_from_file_location('stable_internal_gate', ROOT / 'scripts/internal_release_acceptance.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')


def ref(path, root):
    return {'path': path.relative_to(root).as_posix(), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}


@pytest.fixture
def accepted(gate, tmp_path):
    record_path = gate.initialize(tmp_path / 'workspace')
    root = record_path.parent
    record = json.loads(record_path.read_text())
    record.update(status='pass', accepted_at='2026-10-09T12:00:00+08:00',
                  reviewer={'name': 'Synthetic unit-test reviewer', 'review_id': 'unit-test-review'})
    dmg = root / 'candidate/Echo-Founder.dmg'; dmg.write_bytes(b'UNIT TEST BYTES, NOT A REAL INSTALLER')
    package = root / 'candidate/package-manifest.json'
    write(package, {'product': 'Echo Founder', 'version': gate.VERSION, 'status': 'packed',
                    'source_control': {'current_sha': 'a' * 40, 'dirty': True}})
    manifest = root / 'candidate/dmg-manifest.json'
    write(manifest, {'product': 'Echo Founder', 'version': gate.VERSION, 'status': 'packed',
                     'artifact': 'dmg', 'architecture': 'arm64', 'sha256': ref(dmg, root)['sha256'],
                     'package_manifest': {'sha256': ref(package, root)['sha256']}})
    record['candidate'] = {'dmg': ref(dmg, root), 'package_manifest': ref(package, root), 'dmg_manifest': ref(manifest, root)}
    for row in record['evidence']:
        path = root / row['path']; artifact = json.loads(path.read_text())
        artifact.update(result='pass', observed_at='2026-10-09T11:00:00+08:00',
                        candidate_dmg_sha256=record['candidate']['dmg']['sha256'], observer_id='unit-test-review',
                        observations='Synthetic unit-test evidence only, not an observation of a real customer.',
                        facts=copy.deepcopy(gate.FACTS[row['kind']]))
        write(path, artifact); row.update(result='pass', **ref(path, root))
    write(record_path, record)
    return record_path, record


def change_artifact(accepted, kind, mutate):
    path, record = accepted; row = next(r for r in record['evidence'] if r['kind'] == kind)
    artifact_path = path.parent / row['path']; artifact = json.loads(artifact_path.read_text())
    mutate(artifact); write(artifact_path, artifact); row.update(ref(artifact_path, path.parent)); write(path, record)


def test_initializer_matches_versioned_template_and_never_prechecks_facts(gate, tmp_path):
    record_path = gate.initialize(tmp_path / 'new')
    record = json.loads(record_path.read_text())
    assert record == json.loads((ROOT / 'quality/acceptance/internal-release-acceptance.template.json').read_text())
    assert record['product_version'] == (ROOT / 'VERSION').read_text().strip()
    assert len(record['evidence']) == 9
    assert all(row['result'] == 'pending' and not row['sha256'] for row in record['evidence'])
    for row in record['evidence']:
        artifact = json.loads((record_path.parent / row['path']).read_text())
        assert artifact['result'] == 'pending'
        assert all(v is None for v in artifact['facts'].values())
    result = gate.validate(record_path)
    assert result['status'] == 'pending' and result['commercial_ready'] is False
    assert set(result['missing_evidence']) == gate.REQUIRED_EVIDENCE
    before = record_path.read_bytes()
    with pytest.raises(FileExistsError): gate.initialize(record_path.parent)
    assert record_path.read_bytes() == before


def test_complete_self_review_is_only_internal_and_allows_honest_dirty_candidate(gate, accepted):
    result = gate.validate(accepted[0])
    assert result['status'] == 'pass', result
    assert result['source_dirty'] is True and result['commercial_ready'] is False
    assert '固定排版' in result['candidate_label'] and 'AI 增强' not in result['candidate_label']


def test_old_image_record_is_read_only(gate, tmp_path):
    path = tmp_path / 'old.json'; write(path, {'schema': 'echo-founder.internal-release-acceptance.v1', 'status': 'pass'})
    result = gate.validate(path)
    assert result['status'] == 'legacy_read_only' and result['commercial_ready'] is False


@pytest.mark.parametrize('key,value', [('non_commercial', 1), ('apple_notarized', 0), ('layout_mode', 'ai_enhanced'), ('product_version', '0.0.0')])
def test_wrong_scope_and_boolean_lookalikes_fail(gate, accepted, key, value):
    path, record = accepted; record[key] = value; write(path, record)
    assert gate.validate(path)['status'] == 'invalid'


@pytest.mark.parametrize('fact,value', [('paid_image_requests', False), ('paid_image_requests', 1),
    ('image_accounts_read', True), ('xiaohongshu_cards_per_post', 7), ('shipinhao_static_visual_jobs', 1),
    ('md2wechat_failure_uses_bundled_renderer', False)])
def test_retired_image_routes_and_incomplete_platform_deliverables_fail(gate, accepted, fact, value):
    change_artifact(accepted, 'stable_layout', lambda a: a['facts'].update({fact: value}))
    result = gate.validate(accepted[0]); assert result['status'] == 'invalid'
    assert any(fact in error for error in result['errors'])


def test_real_generation_and_actual_cost_are_not_substituted_by_other_green_evidence(gate, accepted):
    change_artifact(accepted, 'model_and_cost', lambda a: a['facts'].update(provider_usage_and_cost_reconciled=False))
    assert gate.validate(accepted[0])['status'] == 'invalid'


@pytest.mark.parametrize('key,value', [('candidate_dmg_sha256', 'b' * 64), ('kind', 'stable_layout'),
    ('observer_id', 'another-reviewer'), ('observed_at', '2999-01-01T00:00:00Z'),
    ('observed_at', '2026-10-09T13:00:00+08:00'), ('observations', 'pass')])
def test_rehashed_but_wrong_observation_cannot_pass(gate, accepted, key, value):
    change_artifact(accepted, 'clean_install', lambda a: a.update({key: value}))
    assert gate.validate(accepted[0])['status'] == 'invalid'


def test_duplicate_or_missing_evidence_cannot_cover_another_kind(gate, accepted):
    path, record = accepted; record['evidence'][0] = copy.deepcopy(record['evidence'][1]); write(path, record)
    result = gate.validate(path)
    assert result['status'] == 'invalid' and 'clean_install' in result['missing_evidence']


@pytest.mark.parametrize('which', ['dmg', 'package_manifest', 'dmg_manifest'])
def test_frozen_candidate_mutation_fails(gate, accepted, which):
    path, record = accepted; file = path.parent / record['candidate'][which]['path']
    file.write_bytes(file.read_bytes() + b'\n')
    assert gate.validate(path)['status'] == 'invalid'


def test_updated_dmg_hash_still_requires_matching_manifest_and_observations(gate, accepted):
    path, record = accepted; file = path.parent / record['candidate']['dmg']['path']; file.write_bytes(b'REBUILT SYNTHETIC DMG')
    record['candidate']['dmg'] = ref(file, path.parent); write(path, record)
    result = gate.validate(path)
    assert result['status'] == 'invalid'
    assert any('does not bind' in error for error in result['errors'])


@pytest.mark.parametrize('value', ['/tmp/outside', '../outside', 'evidence/../outside', './evidence/x', 'evidence//x', 'C:\\outside'])
def test_evidence_paths_cannot_escape_or_alias(gate, accepted, value):
    path, record = accepted; record['evidence'][0]['path'] = value; write(path, record)
    assert gate.validate(path)['status'] == 'invalid'


@pytest.mark.parametrize('link_type', ['symlink', 'hardlink', 'parent_symlink'])
def test_evidence_links_are_rejected(gate, accepted, link_type):
    path, record = accepted; row = record['evidence'][0]; file = path.parent / row['path']
    target = path.parent / 'original.json'; file.rename(target)
    if link_type == 'symlink': file.symlink_to(target)
    elif link_type == 'hardlink': os.link(target, file)
    else:
        (path.parent / 'alias').symlink_to(path.parent / 'evidence', target_is_directory=True)
        file.write_bytes(target.read_bytes()); row['path'] = 'alias/' + file.name; write(path, record)
    result = gate.validate(path)
    assert result['status'] == 'invalid'


@pytest.mark.parametrize('raw', [b'[]', b'null', b'"text"', b'\xff', b'{"status":"pass","status":"pending"}'])
def test_malformed_record_returns_structured_failure(gate, tmp_path, raw):
    path = tmp_path / 'invalid.json'; path.write_bytes(raw)
    result = gate.validate(path)
    assert result['status'] == 'invalid' and result['commercial_ready'] is False


def test_missing_files_do_not_leak_local_paths(gate, accepted):
    path, record = accepted; (path.parent / record['evidence'][0]['path']).unlink()
    result = gate.validate(path)
    assert result['status'] == 'invalid'
    assert str(path.parent) not in json.dumps(result)


def test_pending_progress_lists_each_remaining_observation_once(gate, accepted):
    path, record = accepted; record['status'] = 'pending'; record['evidence'][0]['result'] = 'pending'; write(path, record)
    result = gate.validate(path)
    assert result['status'] == 'pending'
    assert result['missing_evidence'] == ['clean_install'] and result['commercial_ready'] is False


def test_change_during_file_read_is_rejected(gate, tmp_path, monkeypatch):
    file = tmp_path / 'race.json'; file.write_bytes(b'original bytes')
    original_read = os.read; mutated = False
    def read(fd, count):
        nonlocal mutated
        data = original_read(fd, count)
        if data and not mutated:
            mutated = True; file.write_bytes(b'a changed and longer value')
        return data
    monkeypatch.setattr(os, 'read', read)
    with pytest.raises(gate.EvidenceError, match='changed while'):
        gate._read(file, gate.MAX_JSON_BYTES)
