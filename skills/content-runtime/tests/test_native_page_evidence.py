"""Page evidence policy must not depend on layout keywords or disclaimers."""
import copy
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / 'scripts'), str(ROOT / 'skills/content-runtime/scripts')]
from native_demo import prepare_native_demo, simulate_approval, offline_layout
from native_demo_data import package_body
from visual_director import build_visual_recipe, VisualDirectorError
from visual_publish import generate_publish_outputs, parse_package_body, _load_or_build_default_recipe
from visual_quality import native_page_evidence, audit_rendered_visual_index

ROUTING = json.loads((ROOT / 'skills/content-runtime/config/visual-routing.json').read_text())
BRANDS = json.loads((ROOT / 'skills/content-runtime/config/brand-profiles.json').read_text()) if (ROOT / 'skills/content-runtime/config/brand-profiles.json').exists() else None
if BRANDS is None:
    from visual_publish import VISUAL_BRAND_PROFILES_PATH
    BRANDS = json.loads(VISUAL_BRAND_PROFILES_PATH.read_text())


@pytest.mark.parametrize('keyword', ['沟通练习', '方法练习'])
def test_advice_really_renders_eight_pages_and_final_quality_passes(tmp_path, keyword):
    rt, run, plan, provenance = prepare_native_demo(tmp_path, ['xhs'], 'advice')
    simulate_approval(rt, 'topic_template', plan['path'], 'advice', provenance)
    package = rt.write('package', 'advice', package_body(['xhs']).replace('沟通练习', keyword), run_id='advice')
    simulate_approval(rt, 'content_package', package['path'], 'advice', provenance)
    with offline_layout():
        result = generate_publish_outputs(tmp_path, 'advice', package['path'])
    index = json.loads(Path(result['index_path']).read_text())
    assert index['quality_summary']['status'] == 'pass', index['quality_summary']
    assert len(index['outputs']) == 8
    assert all(o['copy_fidelity']['status'] == o['native_layout']['status'] == 'pass' for o in index['outputs'])
    # A policy cannot be replayed against different copy, even after rendering.
    tampered = copy.deepcopy(index)
    tampered['recipe_assets'][1]['copy']['supporting'] = '客户采用后收入增长50%。'
    quality = audit_rendered_visual_index(tampered, '')
    assert quality['status'] == 'blocked'
    assert any('page evidence requirement' in e for e in quality['blocking_issues'])


@pytest.mark.parametrize('claim', ['客户采用后收入增长50%。', '研究表明这个方法有效。', '这是实际产品界面。', '我们赚了十万元。'])
def test_concept_disclaimer_does_not_excuse_factual_claim_on_any_page(claim):
    parsed = parse_package_body(package_body(['xhs']))
    page = parsed['xhs_posts'][0]['pages'][5]
    page['body'] = claim
    page['image_prompt'] = '概念图解（非事实证据）'
    with pytest.raises(VisualDirectorError, match='source|screenshot'):
        build_visual_recipe(parsed, {'assets': []}, 'claims', ROUTING, BRANDS)


def test_mixed_pages_use_their_own_sources_and_unknown_assertions_need_review():
    parsed = parse_package_body(package_body(['xhs']))
    page = parsed['xhs_posts'][0]['pages'][5]
    page['body'] = '客户采用后收入增长50%。'
    page['image_prompt'] = 'materials/results.csv'
    recipe = build_visual_recipe(parsed, {'assets': [{'path': 'materials/results.csv', 'kind': 'dataset'}]}, 'mixed', ROUTING, BRANDS)
    assets = recipe['assets']
    assert assets[5]['page_evidence']['status'] == 'required'
    assert assets[5]['source'] == 'materials/results.csv'
    assert assets[1]['page_evidence']['status'] == 'not_required' and 'source' not in assets[1]
    assert native_page_evidence({'supporting': '这种结构天然更适合所有人。'})['status'] == 'review_required'


def test_changed_copy_creates_new_recipe_without_rewriting_adoption(tmp_path):
    parsed = parse_package_body(package_body(['xhs']))
    first_path, first = _load_or_build_default_recipe(tmp_path, 'changed', parsed, 'pipeline/package/one.md')
    original = first_path.read_bytes()
    pointer = tmp_path / 'pipeline/visual/changed/selected-revision.json'
    pointer.write_text(json.dumps({'revision_id': first['revision_id']}))
    old_pointer = pointer.read_bytes()
    parsed['xhs_posts'][0]['pages'][2]['body'] = '请先询问新增要求。'
    second_path, second = _load_or_build_default_recipe(tmp_path, 'changed', parsed, 'pipeline/package/one.md')
    assert second['revision_id'] == 'r002' and second_path != first_path
    assert first_path.read_bytes() == original and pointer.read_bytes() == old_pointer


@pytest.mark.parametrize('change', ['source', 'template'])
def test_recipe_input_changes_preserve_previous_recipe(tmp_path, monkeypatch, change):
    import visual_publish
    source = tmp_path / 'materials/results.csv'
    source.parent.mkdir(parents=True)
    source.write_text('项目,值\n练习,1\n')
    monkeypatch.setattr(visual_publish, '_project_material_assets', lambda *args: {'assets': [{'path': 'materials/results.csv', 'kind': 'dataset'}]})
    parsed = parse_package_body(package_body(['xhs']))
    first_path, first = _load_or_build_default_recipe(tmp_path, 'inputs', parsed, 'pipeline/package/one.md')
    before = first_path.read_bytes()
    if change == 'source': source.write_text('项目,值\n练习,2\n')
    second_path, second = _load_or_build_default_recipe(tmp_path, 'inputs', parsed, 'pipeline/package/one.md', selected_template='editorial' if change == 'template' else None)
    assert second_path != first_path and second['source_input_sha256'] != first['source_input_sha256']
    assert first_path.read_bytes() == before
