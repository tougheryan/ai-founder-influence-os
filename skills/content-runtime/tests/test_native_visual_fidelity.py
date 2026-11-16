from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(SCRIPTS))
import visual_publish as visual


def test_material_library_records_are_never_visual_evidence(tmp_path: Path) -> None:
    for name in ('materials/library/index.json', 'materials/library/history/item/version.json'):
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('{"id":"9","content":"private instructions"}')
    assert visual._project_material_assets(tmp_path)['assets'] == []
    with pytest.raises(visual.VisualOutputError, match='内部记录'):
        visual._prepare_render_task(tmp_path, {'evidence_sources': ['materials/library/history/item/version.json']})


def test_current_run_without_files_does_not_borrow_other_project_materials(tmp_path: Path) -> None:
    source = tmp_path / 'materials/other.csv'
    source.parent.mkdir(parents=True)
    source.write_text('label,value\nother,99')
    run = tmp_path / 'sessions/material-analysis/current.json'
    run.parent.mkdir(parents=True)
    run.write_text('{}')
    assert visual._project_material_assets(tmp_path, 'current')['assets'] == []


def test_evidence_keeps_actual_values_without_inventing_bars_or_counters() -> None:
    output = visual._evidence_data_panel({'evidence_items': [('结论', '未统计'), ('留存', '42%（样本 100 人）')]})
    assert '未统计' in output and '42%（样本 100 人）' in output
    assert 'width:' not in output and 'evidence-rule' not in output
    assert '>01<' not in output and '>02<' not in output


def _task(page: str = 'P1', body: str = '完整原文，' * 16 + '最后一句不应丢失。') -> dict:
    return {'id': 'xhs-01-p' + page[1:], 'kind': 'xhs_card', 'native_copy': True,
            'payload': {'page': {'page_id': page, 'title': '逐条确认交付范围', 'body': body},
                        'post': {'cover_lines': ['临时增加需求怎么办', '先确认范围，再讨论费用', '虚构练习，不是真实客户经历']}}}


@pytest.mark.parametrize('page', ['P1', 'P2', 'P8'])
def test_native_cards_preserve_every_approved_field_without_template_fillers(page: str) -> None:
    task = _task(page)
    markup = visual._poster_for_task(task)
    for value in visual._native_card_copy(task):
        assert value in markup
    assert '最后一句不应丢失。' in markup
    assert markup.count('data-approved-copy=') == (5 if page == 'P1' else 2)
    assert not any(filler in markup for filler in ['num-mega', 'h-bar-chart', '现在自检', '结论</p>', '来源可追溯'])


def test_native_copy_is_escaped() -> None:
    output = visual._poster_for_task(_task('P2', '<img src=x onerror=alert(1)>'))
    assert '<img src=x' not in output
    assert '&lt;img src=x onerror=alert(1)&gt;' in output


def test_browser_checks_missing_hidden_and_clipped_copy_before_image_delivery(tmp_path: Path) -> None:
    html = tmp_path / 'cases.html'
    cases = {
        'good': '<p data-approved-copy>完整文字</p>',
        'changed': '<p data-approved-copy>被截断</p>',
        'hidden': '<p style="opacity:0" data-approved-copy>完整文字</p>',
        'clipped': '<p style="width:20px;white-space:nowrap;overflow:hidden" data-approved-copy>完整文字</p>',
        'missing': '<p>完整文字</p>',
        'overflow': '<p style="margin-top:400px" data-approved-copy>完整文字</p>',
    }
    html.write_text('<html><meta charset="utf-8"><style>.poster{width:400px;height:300px;overflow:hidden} p{font-size:32px}</style>'
                    + ''.join(f'<section class="poster" id="{key}">{body}</section>' for key, body in cases.items()) + '</html>')
    spec = tmp_path / 'spec.json'
    spec.write_text(json.dumps({'html': str(html), 'metrics': str(tmp_path / 'metrics.json'), 'targets': [
        {'id': key, 'output': str(tmp_path / f'{key}.png'), 'expectedCopy': ['完整文字']} for key in cases
    ]}))
    result = subprocess.run(['node', str(SCRIPTS / 'visual_screenshot.mjs'), str(spec)], capture_output=True, text=True, timeout=60)
    assert result.returncode == 1, result.stderr
    metrics = json.loads((tmp_path / 'metrics.json').read_text())['targets']
    assert metrics['good']['copy_fidelity']['status'] == 'pass'
    assert (tmp_path / 'good.png').exists()
    for key in cases.keys() - {'good'}:
        assert metrics[key]['copy_fidelity']['status'] == 'failed'
        assert not (tmp_path / f'{key}.png').exists()


def test_cached_internal_evidence_recipe_is_rebuilt_without_rewriting_previous(tmp_path: Path) -> None:
    parsed = {
        'schema': 'echo-founder.platform-native-package.v2', 'title': '确认范围',
        'wechat': None, 'selected_platforms': ['xhs'],
        'xhs_posts': [{'index': 1, 'cover_lines': ['确认范围', '逐项核对', '虚构练习'],
                       'pages': [{'page_id': f'P{i}', 'title': f'确认范围 {i}', 'body': '先说明本次增加的内容。'} for i in range(1, 9)]}],
    }
    path, recipe = visual._load_or_build_default_recipe(tmp_path, 'current', parsed, 'pipeline/package/current.md')
    recipe['assets'][1]['source'] = 'materials/library/history/item/version.json'
    path.write_text(json.dumps(recipe, ensure_ascii=False))
    previous = path.read_bytes()
    next_path, next_recipe = visual._load_or_build_default_recipe(tmp_path, 'current', parsed, 'pipeline/package/current.md')
    assert path.read_bytes() == previous
    assert next_path != path and next_recipe['revision_id'] == 'r002'
    assert all(not item.get('source') for item in next_recipe['assets'])


def test_explicit_regeneration_uses_current_copy_and_preserves_old_candidates_and_selection(tmp_path: Path) -> None:
    parsed = {
        'schema': 'echo-founder.platform-native-package.v2', 'title': '范围确认',
        'wechat': None, 'selected_platforms': ['xhs'],
        'xhs_posts': [{'index': 1, 'pages': [{'page_id': f'P{i}', 'title': f'第 {i} 页', 'body': '原来的完整正文。'} for i in range(1, 9)]}],
    }
    first_path, first = visual._load_or_build_default_recipe(tmp_path, 'again', parsed, 'pipeline/package/first.md')
    selection = tmp_path / 'pipeline/visual/again/selected-revision.json'
    selection.write_text(json.dumps({'revision_id': first['revision_id']}))
    first_bytes, selection_bytes = first_path.read_bytes(), selection.read_bytes()
    parsed['xhs_posts'][0]['pages'][1]['body'] = '作者已经确认的新正文。'
    second_path, second = visual._load_or_build_default_recipe(tmp_path, 'again', parsed, 'pipeline/package/second.md', force_new_revision=True)
    assert second['revision_id'] == 'r002'
    assert second['source_package'] == 'pipeline/package/second.md'
    assert second['assets'][1]['copy']['supporting'] == '作者已经确认的新正文。'
    assert second_path != first_path
    assert first_path.read_bytes() == first_bytes
    assert selection.read_bytes() == selection_bytes


def test_native_composition_uses_real_legibility_checks_and_rejects_tiny_or_invisible_copy(tmp_path: Path) -> None:
    brand = json.loads(visual.VISUAL_BRAND_PROFILES_PATH.read_text())['echo_founder']
    tasks = []
    for ident, page, body in [
        ('short', 'P2', '先确认范围，再讨论费用。'),
        ('cover', 'P1', '先确认范围，再讨论费用。'),
        ('long', 'P4', '虚构练习，用于检查长文排版。先确认新增内容，再核对双方的约定。' * 8),
        ('tiny', 'P2', '先确认范围，再讨论费用。'),
        ('faint', 'P2', '先确认范围，再讨论费用。'),
        ('overlap', 'P2', '先确认范围，再讨论费用。'),
        ('excessive', 'P2', '过长内容不能用缩小字号或者截断来掩盖。' * 100),
    ]:
        task = {**_task(page, body), 'id': ident, 'brand_system': brand, 'template_style': 'editorial'}
        tasks.append(task)
    html = visual._build_local_deck_html(tasks, visual.EDITORIAL_TEMPLATE_PATH)
    html = html.replace('</style>', '#tiny [data-approved-copy]{font-size:10px!important} #faint [data-approved-copy]{color:#FDF8F3!important} #overlap .native-body{transform:translateY(-160px)} </style>', 1)
    deck = tmp_path / 'native.html'
    deck.write_text(html)
    spec = tmp_path / 'spec.json'
    spec.write_text(json.dumps({'html': str(deck), 'targets': [
        {'id': task['id'], 'output': str(tmp_path / (task['id'] + '.png')), 'expectedCopy': visual._native_card_copy(task)} for task in tasks
    ]}))
    result = subprocess.run(['node', str(visual.VISUAL_SCREENSHOT_SCRIPT), str(spec)], capture_output=True, text=True, timeout=60)
    assert result.returncode == 1, result.stderr
    metrics = json.loads((tmp_path / 'spec.metrics.json').read_text())['targets']
    from visual_quality import _verified_native_text_layout
    for task in tasks[:3]:
        measurement = metrics[task['id']]
        assert measurement['native_layout']['status'] == 'pass', measurement
        assert _verified_native_text_layout({**measurement, 'expected_text': ' '.join(visual._native_card_copy(task))})
        assert (tmp_path / (task['id'] + '.png')).exists()
    for ident in ['tiny', 'faint', 'overlap', 'excessive']:
        assert not (tmp_path / (ident + '.png')).exists(), ident
