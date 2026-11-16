from __future__ import annotations

import sys
import hashlib
import json
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import visual_publish as visual


def test_fallback_preserves_punctuation_in_paragraph_quote_and_list():
    renderer = visual._load_wechat_html_renderer()
    result = renderer.md_to_html('保留句号。\n\n> 引用。\n\n- 列表。')
    assert '<p>保留句号。</p>' in result
    assert '<blockquote>引用。</blockquote>' in result
    assert '<li>列表。</li>' in result


def test_fallback_links_keep_labels_queries_and_inline_code_literal():
    renderer = visual._load_wechat_html_renderer()
    result = renderer.md_to_html('[研究 **原文**](https://example.org/p?a=1&b=2)\n\n`[代码](https://example.org)`')
    assert 'href="https://example.org/p?a=1&amp;b=2"' in result
    assert '研究 <strong>原文</strong></a>' in result
    assert '<code>[代码](https://example.org)</code>' in result
    assert result.count('<a ') == 1


def test_fallback_does_not_activate_unsafe_links_or_raw_html():
    renderer = visual._load_wechat_html_renderer()
    result = renderer.md_to_html('[坏链接](javascript:alert(1)) <img src=x onerror=alert(1)>')
    assert '<a ' not in result
    assert '<img ' not in result
    assert 'javascript:alert(1)' in result


@pytest.mark.parametrize('change', ['period', 'paragraph', 'added', 'reordered', 'link', 'link_missing'])
def test_independent_fidelity_rejects_changed_text_or_references(change):
    from wechat_fidelity import check_wechat_html
    good = '<h1>标题</h1><p>第一段。</p><p>第二段。<a href="https://example.org/p">依据</a></p>'
    changes = {
        'period': good.replace('第一段。', '第一段'),
        'paragraph': good.replace('<p>第一段。</p>', ''),
        'added': good.replace('第一段。', '第一段。额外承诺。'),
        'reordered': good.replace('第一段。', '临时。').replace('第二段。', '第一段。').replace('临时。', '第二段。'),
        'link': good.replace('https://example.org/p', 'https://example.org/wrong'),
        'link_missing': good.replace('<a href="https://example.org/p">依据</a>', '依据'),
    }
    result = check_wechat_html('标题', '第一段。\n\n第二段。[依据](https://example.org/p)', changes[change])
    assert result['status'] == 'failed'
    assert result['errors']


def test_fidelity_accepts_formatting_without_ignoring_punctuation():
    from wechat_fidelity import check_wechat_html
    result = check_wechat_html('标题', '**小标题**\n\n第一段。\n\n第二段。[依据](https://example.org/p?a=1&b=2)',
        '<html><head><title>不属于正文</title><style>p{color:black}</style></head><body><section><h1>标题</h1>'
        '<h2>小标题</h2><p><span>第一段。</span></p><p>第二段。<a href="https://example.org/p?a=1&amp;b=2">依据</a></p></section></body></html>')
    assert result['status'] == 'pass', result
    assert result['block_count'] == 4
    assert result['link_count'] == 1


def test_legacy_figure_caption_is_verified_without_hiding_changed_body():
    from wechat_fidelity import check_wechat_html
    html = '<h1>标题</h1><figure data-aifios-asset-id="figure-1"><img src="figure.png"><figcaption>原配图说明</figcaption></figure><p>正文。</p>'
    captions = {'figure-1': '原配图说明'}
    assert check_wechat_html('标题', '正文。', html, figure_captions=captions)['status'] == 'pass'
    for bad in (html.replace('正文。', '正文'), html.replace('原配图说明', '多出的内容'), html.replace('<p>正文。</p>', '')):
        assert check_wechat_html('标题', '正文。', bad, figure_captions=captions)['status'] == 'failed'


@pytest.fixture
def wechat_project(tmp_path, monkeypatch):
    from content_runtime import ContentRuntime

    runtime = ContentRuntime(tmp_path)
    runtime.init()
    package = tmp_path / 'pipeline/package/article.md'
    package.write_text('# 平台原生成稿\n\n## 0. 共享事实底稿\n- 本期平台：公众号\n\n'
                       '## 1. 公众号原生长文\n- 发布标题：保真测试\n- 摘要：测试稿\n\n'
                       '### 正文\n第一段。\n\n第二段。[依据](https://example.org/p?a=1&b=2)\n\n'
                       '### 评论区承接\n- 置顶评论：你怎么看？\n')
    # These files are only preflight dependencies; a WeChat-only run never renders them.
    unused = tmp_path / 'unused-xhs-template.html'
    unused.write_text('<html></html>')
    monkeypatch.setattr(visual, 'XHS_TEMPLATE_PATH', unused)
    monkeypatch.setattr(visual, 'EDITORIAL_TEMPLATE_PATH', unused)
    return tmp_path, package


def _generate(project, package, **kwargs):
    return visual.generate_publish_outputs(project, 'article', package, renderer='local', write_runtime_record=False, **kwargs)


def test_real_fallback_generates_proof_and_keeps_previous_revision(wechat_project):
    project, package = wechat_project
    result = _generate(project, package)
    index_path = Path(result['index_path'])
    first = index_path.read_bytes()
    index = json.loads(first)
    article = index['outputs'][0]
    assert index['quality_summary']['status'] == 'pass', index['quality_summary']
    assert article['wechat_fidelity']['link_count'] == 1
    assert visual.main(['--project', str(project), 'verify', '--slug', 'article', '--revision', 'r001']) == 0
    old_html = (project / article['output']).read_bytes()
    second = _generate(project, package, force_new_revision=True)
    assert json.loads(Path(second['index_path']).read_text())['revision_id'] == 'r002'
    assert (project / 'pipeline/visual/article/revisions/r001.index.json').read_bytes() == first
    assert (project / article['output']).read_bytes() == old_html


@pytest.mark.parametrize('corruption', [None, 'period', 'link'])
def test_primary_renderer_uses_the_same_gate(wechat_project, monkeypatch, corruption):
    project, package = wechat_project

    def cli_render(path, title, body, layout_style, **kwargs):
        # Local stand-in for the external service response; no account or network call.
        rendered = '<h1>保真测试</h1><p>第一段。</p><p>第二段。<a href="https://example.org/p?a=1&amp;b=2">依据</a></p>'
        if corruption == 'period':
            rendered = rendered.replace('第一段。', '第一段')
        if corruption == 'link':
            rendered = rendered.replace('example.org/p?', 'example.org/wrong?')
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered)
        return {'renderer_source': 'md2wechat-cli', 'renderer_theme': layout_style}

    monkeypatch.setattr(visual, '_render_md2wechat_html', cli_render)
    if corruption:
        with pytest.raises(visual.VisualOutputError, match='公众号排版'):
            _generate(project, package)
        index = json.loads((project / 'pipeline/visual/article/revisions/r001.index.json').read_text())
        assert index['status'] == 'failed'
        assert index['quality_summary']['status'] != 'pass'
    else:
        result = _generate(project, package)
        assert result['quality_summary']['status'] == 'pass'
        assert result['outputs'][0]['renderer_source'] == 'md2wechat-cli'


@pytest.mark.parametrize('change', ['html', 'source', 'proof', 'kind', 'format', 'empty'])
def test_verification_rejects_stale_or_missing_proof_even_with_cached_pass(wechat_project, change):
    project, package = wechat_project
    result = _generate(project, package)
    index_path = project / 'pipeline/visual/article/revisions/r001.index.json'
    index = json.loads(index_path.read_text())
    output = index['outputs'][0]
    if change in {'html', 'kind', 'format'}:
        target = project / output['output']
        target.write_text(target.read_text().replace('第一段。', '第一段'))
        output['sha256'] = hashlib.sha256(target.read_bytes()).hexdigest()
        output['size'] = target.stat().st_size
    if change == 'source':
        package.write_text(package.read_text().replace('第一段。', '已经改稿。'))
    if change == 'proof':
        output.pop('wechat_fidelity')
    if change == 'kind':
        output.pop('kind')
    if change == 'format':
        output['format'] = 'TEXT'
    if change == 'empty':
        index['outputs'] = []
    index_path.write_text(json.dumps(index, ensure_ascii=False))
    assert visual.main(['--project', str(project), 'verify', '--slug', 'article', '--revision', 'r001']) == 1
