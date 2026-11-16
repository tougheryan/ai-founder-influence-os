"""Offline, fictional three-platform demonstrations using production contracts.

Only the CLI demo imports this module. It is not shipped in the desktop runtime.
Demonstrations remain internal-only even when the selected-platform contract is complete.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import uuid
from contextlib import contextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'skills/content-runtime/scripts'))
from content_runtime import ContentRuntime
import author_evidence
from release_gate import build_package_manifest, run_release_gate
from blueprint_platform_scope import check_platform_scope
from visual_publish import generate_publish_outputs
from visual_release import build_visual_selection_manifest, resolve_selected_visual_release
from delivery_pack import build_delivery_pack
from native_demo_data import LABELS, DISCLAIMER, package_body, blueprint_body

PROVENANCE = 'demo-provenance.json'


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def require(condition: object, message: str) -> None:
    if not condition:
        raise RuntimeError(message)


@contextmanager
def offline_layout():
    """Force the existing bundled fallback; never invoke a globally configured API."""
    previous = os.environ.get('MD2WECHAT_BINARY')
    # /dev/null is a file, so this executable path cannot exist on supported hosts.
    os.environ['MD2WECHAT_BINARY'] = '/dev/null/echo-founder-offline-demo'
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop('MD2WECHAT_BINARY', None)
        else:
            os.environ['MD2WECHAT_BINARY'] = previous


def prepare_native_demo(project: Path, platforms: list[str], slug: str):
    """Prepare source and plan but intentionally leave H2 unapproved."""
    package_body(platforms)  # Reject invalid scope before creating anything.
    require(not project.exists() or not any(project.iterdir()), '演示需要空目录，不能覆盖已有项目。')
    project.mkdir(parents=True, exist_ok=True)
    provenance = {
        'schema': 'echo-founder.offline-demo.v1', 'run_id': slug,
        'platforms': platforms, 'fictional_material': True,
        'content_origin': 'handwritten_fixture', 'model_calls': 0,
        'platform_research': False, 'external_publication': False,
        'human_acceptance': False, 'commercial_ready': False,
        'approval_operator': 'automated_demo_simulation', 'approvals': [],
        'notice': DISCLAIMER + ' 演示程序会调用现有确认接口；接口中的 human_review 字段不代表真人确认。',
    }
    write_json(project / PROVENANCE, provenance)
    (project / '演示说明.md').write_text(
        '# Echo Founder 离线演示\n\n' + provenance['notice'] +
        '\n\n仅演示素材绑定、确认和本地成品。没有真实客户、外部研究、模型调用、平台登录、发布或付款。'
        '\n\n本演示采用虚构素材和自动化确认，只能得到 internal_review_only 目录，不能生成正式交付 ZIP。'
        '\n\n请通过 /production 体验当前平台工作流；不要将本项目的自动确认作为客户验收记录。\n', encoding='utf-8')
    rt = ContentRuntime(project)
    rt.init()
    run = rt.create_run(topic='虚构演示：新增需求，先写清变化', platforms=platforms,
                        slug=slug, run_id=slug, source='offline-demo-simulation')
    raw = '虚构练习：原定交付一篇文章，后来增加演示材料。用途、页数、期限与费用均待确认。没有真实客户或效果数据。'
    rt.write('intake', slug, '# 虚构素材底稿\n\n' + DISCLAIMER + '\n\n' + raw,
             run_id=slug, source='offline-demo-simulation')
    fingerprint = author_evidence.digest({'rawMaterial': raw, 'files': [], 'links': []})
    write_json(project / 'sessions/material-analysis' / f'{slug}.json', {
        'schema': 'aifios.material-analysis.v1', 'runId': slug,
        'inputFingerprint': fingerprint, 'analysisInputFingerprint': fingerprint,
        'analysisStatus': 'current', 'input': {'rawMaterial': raw, 'files': [], 'links': []},
        'analysis': {'summary': raw, 'opinions': ['先写清变化和待确认事项'],
                     'facts': [], 'cases': [], 'authorRequirements': ['不编造真实案例和效果'], 'risks': []},
        'selection': {'materialTypeId': 'method', 'structureId': 'problem-method'},
    })
    context = rt.author_source_context(slug)
    binding = rt.select_author_source({
        'run_id': slug, 'id': 'author_' + uuid.uuid4().hex, 'topic': run['topic'],
        **{key: context[key] for key in ('intake_path', 'intake_sha256', 'material_sha256', 'source_revision')},
    })
    plan = rt.write('blueprint', slug, blueprint_body(platforms) + '\n' + author_evidence.binding_lines(binding),
                    run_id=slug, source='offline-demo-simulation')
    return rt, run, plan, provenance


def simulate_approval(rt, scope, path, run_id, provenance):
    require((rt.project / PROVENANCE).is_file(), '自动确认只允许在显式演示项目中执行。')
    reviewed_plan = None
    if scope == 'content_package':
        body = Path(path).read_text(encoding='utf-8')
        require(build_package_manifest(body)['valid'] and not run_release_gate(body)['blocking_issues'],
                '不完整的演示成稿不能自动确认。')
        plan = rt.run_state(run_id=run_id)['steps']['blueprint']['latest']
        reviewed_plan = hashlib.sha256((rt.project / plan).read_bytes()).hexdigest()
    approval = rt.approve_artifact(scope, path, run_id, reviewed_plan_sha256=reviewed_plan)
    provenance['approvals'].append({'scope': scope, 'path': approval['path'],
        'sha256': approval['sha256'], 'operator': 'automated_demo_simulation', 'human_acceptance': False})
    write_json(rt.project / PROVENANCE, provenance)


def create_native_demo(project: Path, platforms: list[str], slug: str) -> dict:
    rt, run, plan, provenance = prepare_native_demo(project, platforms, slug)
    simulate_approval(rt, 'topic_template', plan['path'], slug, provenance)
    package = rt.write('package', slug, package_body(platforms), run_id=slug, source='offline-demo-simulation')
    simulate_approval(rt, 'content_package', package['path'], slug, provenance)
    if set(platforms) & {'wechat', 'xhs'}:
        with offline_layout():
            visual = generate_publish_outputs(project, slug, package_path=package['path'], renderer='local')
        index = json.loads(Path(visual['index_path']).read_text())
        require(index.get('quality_summary', {}).get('status') == 'pass', '演示排版未通过质量检查。')
        selection = build_visual_selection_manifest(project, slug, index['revision_id'])
        write_json(project / 'pipeline/visual' / slug / 'selected-revision.json', selection)
    delivery = build_delivery_pack(project, run_id=slug)
    verify_internal_delivery(delivery, slug)
    provenance['delivery_dir'] = str(Path(delivery['delivery_dir']).relative_to(project))
    write_json(project / PROVENANCE, provenance)
    return verify_native_demo(project, platforms, slug)


def verify_internal_delivery(payload: dict, run_id: str) -> None:
    """An offline simulation must never look like a customer-ready handoff."""
    require(payload.get('run_id') == run_id, '交付记录不属于本期。')
    require(payload.get('status') == 'internal_review_only', '演示被误标为正式交付。')
    require(payload.get('formal_delivery') is False and payload.get('zip_path') is None, '演示不得生成正式交付 ZIP。')
    gate = payload.get('delivery_gate') or {}
    require(gate.get('status') == 'blocked' and gate.get('can_deliver') is False, '正式交付门禁未保留阻断。')
    require(bool((gate.get('publication_prerequisites') or {}).get('errors')), '缺少正式交付阻断依据。')
    require((payload.get('privacy_scan') or {}).get('status') == 'pass', '内部检查目录未通过隐私检查。')
    dest = Path(payload['delivery_dir'])
    require(dest.is_dir() and not dest.with_suffix('.zip').exists(), '内部检查目录不存在或出现误导性 ZIP。')
    require((dest / 'manifest.json').is_file(), '内部检查目录缺少 manifest。')


def verify_native_demo(project: Path, platforms: list[str], slug: str) -> dict:
    """Read-only verification against actual runtime bytes, not reported success."""
    provenance = json.loads((project / PROVENANCE).read_text())
    require(provenance['platforms'] == platforms and provenance['run_id'] == slug, '演示来源与所选任务不一致。')
    require(provenance['fictional_material'] is True and provenance['human_acceptance'] is False
            and provenance['commercial_ready'] is False and provenance['model_calls'] == 0
            and provenance['approval_operator'] == 'automated_demo_simulation', '演示性质标注缺失。')
    rt = ContentRuntime(project)
    run = rt.run_state(run_id=slug)
    require(run['target_platforms'] == platforms, '运行时平台不一致。')
    source = rt.verify_author_source(slug)
    require(source['verified'] and source['research_mode'] == 'author_material', '缺少可验证的作者素材绑定。')
    require(not run.get('topic_selection') and not list((project / 'runs').rglob('market-research/*.json')), '演示不应包含平台研究。')
    paths = {'topic_template': run['steps']['blueprint']['latest'], 'content_package': run['steps']['package']['latest']}
    for scope, path in paths.items():
        approval = rt.approval_status(scope, path, slug)
        require(approval['approved'], f'{scope} 确认已失效：{approval}')
        declared = [a for a in provenance['approvals'] if a['scope'] == scope]
        require(len(declared) == 1 and declared[0]['sha256'] == hashlib.sha256((project / path).read_bytes()).hexdigest()
                and declared[0]['operator'] == 'automated_demo_simulation' and declared[0]['human_acceptance'] is False,
                '缺少与实际字节绑定的自动确认说明。')
    blueprint = (project / paths['topic_template']).read_text()
    require(check_platform_scope(blueprint, platforms)['scope_matches'], '方案平台范围错误。')
    body = (project / paths['content_package']).read_text()
    manifest = build_package_manifest(body)
    require(manifest['valid'] and manifest['schema'] == 'echo-founder.platform-native-package.v2'
            and manifest['target_platforms'] == platforms, '原生内容包不完整或混入未选平台。')
    gate = run_release_gate(body)
    require(not gate['blocking_issues'], '原生内容包存在阻断问题。')
    visual_root = project / 'pipeline/visual' / slug
    outputs = []
    if set(platforms) & {'wechat', 'xhs'}:
        release = resolve_selected_visual_release(project, slug)
        require(release['status'] == 'pass', f'所选排版摘要无效：{release.get("errors")}')
        index = release['index']
        require(index.get('quality_summary', {}).get('status') == 'pass', '排版质量检查失败。')
        outputs = index['outputs']
        expected = ({'wechat-html'} if 'wechat' in platforms else set())
        expected |= ({f'xhs-01-p{i}' for i in range(1, 9)} if 'xhs' in platforms else set())
        require({o['id'] for o in outputs} == expected and len(outputs) == len(expected), '排版缺页或生成了未选平台素材。')
        for output in outputs:
            file = project / output['output']
            require(file.is_file() and file.stat().st_size > 0 and output['renderer'] == 'local', '排版成品或本地渲染依据缺失。')
            if output['id'] == 'wechat-html':
                require(output['renderer_source'] == 'skills/dbs-wechat-html/generate_preview.py', '离线演示调用了外部排版。')
            else:
                require(file.read_bytes().startswith(b'\x89PNG\r\n\x1a\n'), '图片不是有效 PNG。')
            if output['id'].startswith('xhs-'):
                require(output['native_layout']['status'] == 'pass' and output['copy_fidelity']['status'] == 'pass', '八页文字或排版核对失败。')
    else:
        require(not visual_root.exists(), '视频号演示不应生成图片任务。')
    delivery_path = project / provenance['delivery_dir'] / 'manifest.json'
    delivery = json.loads(delivery_path.read_text())
    # Packaged manifests use portable paths; the actual directory is known here.
    delivery['delivery_dir'] = str(delivery_path.parent)
    verify_internal_delivery(delivery, slug)
    return {'status': 'demo_ready', 'mode': 'single-platform' if len(platforms) == 1 else 'selected-platforms',
            'project': str(project), 'run_id': slug, 'slug': slug, 'target_platforms': platforms,
            'fictional_material': True, 'human_acceptance': False, 'model_calls': 0,
            'quality_status': gate['status'], 'quality_reviews': gate.get('review_issues', []),
            'local_outputs': [o['output'] for o in outputs], 'delivery_status': 'internal_review_only',
            'formal_delivery': False, 'zip_path': None, 'commercial_ready': False}
