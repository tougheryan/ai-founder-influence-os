from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path

import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import layout_call_records as ledger
import visual_publish
from layout_call_records import LayoutCallRecordError
from visual_publish import VisualOutputError, _render_md2wechat_html


def records(project):
    return [json.loads(path.read_text()) for path in sorted((project / 'sessions/layout-service-calls').glob('*.json'))]


def render(project, **kwargs):
    return _render_md2wechat_html(project / 'article.html', 'private-title', 'private-body', 'minimal', project=project,
                                  task={'slug': 'my-article', 'revision_id': 'r001'}, **kwargs)


def test_article_failure_retry_and_validation_are_recorded_without_private_text(tmp_path, monkeypatch):
    monkeypatch.setenv('MD2WECHAT_BINARY', 'offline-fixture')
    dispatched = []
    def run(args, **kwargs):
        assert records(tmp_path)[-1]['status'] in {'started', 'failed'}
        dispatched.append(args)
        if len(dispatched) == 1:
            return subprocess.CompletedProcess(args, 1, '', 'secret-provider-message')
        Path(args[args.index('--output') + 1]).write_text('<p>fixture</p>')
        return subprocess.CompletedProcess(args, 0, '', '')
    monkeypatch.setattr(visual_publish.subprocess, 'run', run)
    with pytest.raises(VisualOutputError):
        render(tmp_path)
    render(tmp_path)
    rows = records(tmp_path)
    assert sorted(row['status'] for row in rows) == ['completed', 'failed']
    assert all(row['theme'] == 'minimal-green' and row['runSlug'] == 'my-article' for row in rows)
    assert all(row['completedAt'] is not None for row in rows)
    serialized = json.dumps(rows)
    for secret in ('private-title', 'private-body', 'secret-provider-message', str(tmp_path)):
        assert secret not in serialized


def test_timeout_remains_in_ledger_after_candidate_cleanup(tmp_path, monkeypatch):
    monkeypatch.setenv('MD2WECHAT_BINARY', 'offline-fixture')
    def run(*args, **kwargs):
        raise subprocess.TimeoutExpired('redacted', 120)
    monkeypatch.setattr(visual_publish.subprocess, 'run', run)
    with pytest.raises(subprocess.TimeoutExpired):
        render(tmp_path)
    assert records(tmp_path)[0]['status'] == 'failed'
    assert not (tmp_path / 'article.html').exists()


def test_no_dispatch_on_invalid_binding_or_record_directory(tmp_path, monkeypatch):
    monkeypatch.setenv('MD2WECHAT_BINARY', 'offline-fixture')
    def unexpected(*args, **kwargs):
        pytest.fail('must not invoke service')
    monkeypatch.setattr(visual_publish.subprocess, 'run', unexpected)
    with pytest.raises(LayoutCallRecordError, match='所属内容'):
        _render_md2wechat_html(tmp_path / 'article.html', 'title', 'body', 'minimal', project=tmp_path, task={})
    (tmp_path / 'sessions').mkdir()
    (tmp_path / 'sessions/layout-service-calls').symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(LayoutCallRecordError, match='本次未请求'):
        render(tmp_path)


def test_finish_write_failure_keeps_unconfirmed_start_record(tmp_path, monkeypatch):
    original = ledger._write
    def write(project, record):
        if record['status'] != 'started':
            raise OSError('private-path')
        original(project, record)
    monkeypatch.setattr(ledger, '_write', write)
    with pytest.raises(LayoutCallRecordError, match='结束记录未能保存'):
        with ledger.record_article_layout(tmp_path, slug='my-article', revision_id='r002', theme='minimal-blue', restyle=True):
            pass
    row = records(tmp_path)[0]
    assert row['status'] == 'started' and row['completedAt'] is None
    assert row['operation'] == 'article-restyle'


def test_missing_binary_and_invalid_theme_do_not_create_service_attempt(tmp_path, monkeypatch):
    monkeypatch.delenv('MD2WECHAT_BINARY', raising=False)
    monkeypatch.setattr(visual_publish.shutil, 'which', lambda _: None)
    with pytest.raises(VisualOutputError):
        render(tmp_path)
    assert not (tmp_path / 'sessions/layout-service-calls').exists()
