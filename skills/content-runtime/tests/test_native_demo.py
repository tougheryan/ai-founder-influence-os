"""Exercise current offline demo contracts through the real runtime APIs."""
import hashlib
import json
import sys
from itertools import combinations
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'scripts'))
from native_demo import (create_native_demo, prepare_native_demo, simulate_approval,
                         verify_native_demo, verify_internal_delivery, PROVENANCE)
from native_demo_data import LABELS, SECTIONS, package_body
from release_gate import build_package_manifest, run_release_gate

COMBINATIONS = [list(c) for n in range(1, 4) for c in combinations(LABELS, n)]


@pytest.mark.parametrize('platforms', COMBINATIONS)
def test_all_combinations_obey_h2_scope_and_source(tmp_path, platforms):
    rt, run, plan, provenance = prepare_native_demo(tmp_path, platforms, 'demo-test')
    body = package_body(platforms)
    with pytest.raises(ValueError, match='确认'):
        rt.write('package', run['slug'], body, run_id=run['run_id'])
    assert not list((tmp_path / 'pipeline/package').glob('*.md'))
    simulate_approval(rt, 'topic_template', plan['path'], run['run_id'], provenance)
    package = rt.write('package', run['slug'], body, run_id=run['run_id'])
    simulate_approval(rt, 'content_package', package['path'], run['run_id'], provenance)
    assert rt.approval_status('content_package', package['path'], run['run_id'])['approved']
    manifest = build_package_manifest(Path(package['path']).read_text())
    assert manifest['valid'] and manifest['target_platforms'] == platforms
    gate = run_release_gate(body)
    assert not gate['blocking_issues']
    assert gate['status'] == ('review_required' if 'wechat' in platforms else 'pass')
    assert rt.verify_author_source(run['run_id'])['verified']
    assert not list((tmp_path / 'runs').rglob('market-research/*.json'))
    # Malformed native packages must never receive final confirmation.
    invalid = []
    if 'xhs' in platforms:
        invalid.append('\n'.join(line for line in body.splitlines() if not line.startswith('| P8 |')))
    absent = next((p for p in LABELS if p not in platforms), None)
    if absent:
        invalid.append(body + '\n' + SECTIONS[absent])
    for bad in invalid:
        assert not build_package_manifest(bad)['valid']
        try:
            draft = rt.write('package', run['slug'], bad, run_id=run['run_id'])
        except ValueError:
            continue  # Unselected platform is blocked at the write boundary.
        # Editable incomplete drafts may be saved, but demo auto-confirmation
        # must run the structural gate before calling the approval API.
        with pytest.raises(RuntimeError, match='不完整'):
            simulate_approval(rt, 'content_package', draft['path'], run['run_id'], provenance)


@pytest.mark.parametrize('change', ['material', 'platform'])
def test_changed_material_or_platform_invalidates_demo_confirmation(tmp_path, change):
    rt, run, plan, provenance = prepare_native_demo(tmp_path, ['wechat'], 'changed-demo')
    simulate_approval(rt, 'topic_template', plan['path'], run['run_id'], provenance)
    original = Path(plan['path']).read_bytes()
    if change == 'material':
        path = tmp_path / 'sessions/material-analysis/changed-demo.json'
        data = json.loads(path.read_text())
        data['input']['rawMaterial'] += '新增另一项交付'
        path.write_text(json.dumps(data, ensure_ascii=False))
    else:
        # Simulate persisted state changing independently, as in recovery.
        with rt._state_lock():
            current = rt._load_run_unlocked(run['run_id'], run['slug'])
            current['target_platforms'] = ['xhs']
            rt._save_run_unlocked(current)
    assert not rt.approval_status('topic_template', plan['path'], run['run_id'])['approved']
    with pytest.raises(ValueError, match='确认'):
        rt.write('package', run['slug'], package_body(['wechat']), run_id=run['run_id'])
    assert Path(plan['path']).read_bytes() == original


@pytest.mark.parametrize('platform', LABELS)
def test_single_platform_real_local_render_and_internal_delivery(tmp_path, platform, monkeypatch):
    # A user's installed CLI/config must never be called by an offline demo.
    fake = tmp_path / 'md2wechat'
    marker = tmp_path / 'external-api-would-have-run'
    fake.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\nexit 1\n')
    fake.chmod(0o755)
    monkeypatch.setenv('MD2WECHAT_BINARY', str(fake))
    project = tmp_path / 'demo'
    result = create_native_demo(project, [platform], platform + '-demo')
    assert not marker.exists()
    assert result['human_acceptance'] is False and result['model_calls'] == 0
    assert result['zip_path'] is None and result['formal_delivery'] is False
    assert len(result['local_outputs']) == {'wechat': 1, 'xhs': 8, 'shipinhao': 0}[platform]
    # The independent verifier must reject edited outputs, not just trust status.
    if result['local_outputs']:
        output = project / result['local_outputs'][0]
    else:
        state = json.loads((project / 'runs' / (platform + '-demo.json')).read_text())
        output = project / state['steps']['package']['latest']
    output.write_bytes(output.read_bytes() + b'\ntampered')
    with pytest.raises((ValueError, RuntimeError)):
        verify_native_demo(project, [platform], platform + '-demo')


def test_demo_refuses_existing_project(tmp_path):
    file = tmp_path / 'customer.md'
    file.write_text('existing work')
    with pytest.raises(RuntimeError, match='空目录'):
        prepare_native_demo(tmp_path, ['wechat'], 'demo')
    assert file.read_text() == 'existing work'


def test_internal_delivery_cannot_be_mislabeled_customer_ready(tmp_path):
    create_native_demo(tmp_path, ['shipinhao'], 'shipinhao-demo')
    record = json.loads((tmp_path / PROVENANCE).read_text())
    directory = tmp_path / record['delivery_dir']
    payload = json.loads((directory / 'manifest.json').read_text())
    payload['delivery_dir'] = str(directory)
    verify_internal_delivery(payload, 'shipinhao-demo')
    for field, value in [('status', 'ready_for_delivery'), ('formal_delivery', True), ('zip_path', 'customer.zip')]:
        with pytest.raises(RuntimeError):
            verify_internal_delivery({**payload, field: value}, 'shipinhao-demo')
