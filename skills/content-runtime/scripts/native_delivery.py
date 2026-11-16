"""Current selected-platform delivery contract, shared before and after packing.

Upstream approvals stay in the project. Portable delivery records contain only
public file digests and the digest of the source/approval inspection, never raw
material contexts or credentials. Historical five-platform delivery is separate.
"""
from __future__ import annotations

import hashlib
import json
import re
import stat
import subprocess
import zipfile
from pathlib import Path
from typing import Any

SCHEMA = 'echo-founder.selected-platform-delivery.v1'
PLATFORMS = ('wechat', 'xiaohongshu', 'shipinhao')


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def normalize_platforms(value: Any) -> list[str]:
    if not isinstance(value, list) or not value or any(not isinstance(p, str) for p in value):
        raise ValueError('本期平台为空或格式无效。')
    result = ['xiaohongshu' if p == 'xhs' else p for p in value]
    if len(set(result)) != len(result) or set(result) - set(PLATFORMS):
        raise ValueError('本期平台重复或包含不支持的平台。')
    return [p for p in PLATFORMS if p in result]


def is_native_run(run: dict) -> bool:
    return run.get('schema') == 'echo-founder.production-run.v2'


def publication_contract(platforms: list[str]) -> tuple[tuple[str, str, str, str], ...]:
    selected = normalize_platforms(platforms)
    items = (
        ('wechat', 'wechat-article', 'draft_fill', '{slug}/wechat-publish.md'),
        ('xiaohongshu', 'xiaohongshu-opinion-1', 'draft_fill', '{slug}/xiaohongshu-01.txt'),
        ('shipinhao', 'shipinhao-video-execution-1', 'execution_package', '{slug}/shipinhao-native-01.md'),
    )
    return tuple(item for item in items if item[0] in selected)


def allowed_asset_path(path: str, slug: str, platforms: list[str]) -> bool:
    fixed = {'pipeline/publish-assets/' + i[3].format(slug=slug) for i in publication_contract(platforms)}
    fixed.update({f'pipeline/publish-assets/{slug}-platform-deliverables.json', f'pipeline/publish-assets/{slug}-publish-assets.md'})
    if path in fixed:
        return True
    prefix = f'pipeline/publish-assets/{slug}/'
    if 'wechat' in platforms and path.startswith(prefix):
        relative = path[len(prefix):]
        return relative == 'wechat-source.md' or bool(re.fullmatch(r'wechat-html/[A-Za-z0-9_.-]+\.(?:html|md)', relative))
    return False


def safe_file(root: Path, relative: str) -> Path:
    if not isinstance(relative, str) or not relative or '\\' in relative or '\0' in relative:
        raise ValueError('交付文件路径无效。')
    parts = relative.split('/')
    if any(p in ('', '.', '..') for p in parts) or Path(relative).is_absolute():
        raise ValueError('交付文件路径越界。')
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink():
            raise ValueError('交付文件不能使用符号链接。')
    if not path.is_file() or path.stat().st_size == 0:
        raise ValueError(f'缺少非空交付文件：{relative}')
    return path


def member_path(source: str, slug: str, package: str) -> str:
    if source == package:
        return 'artifacts/package/' + Path(source).name
    if source == f'materials/publication/drafts/{slug}/draft-queue.json':
        return 'artifacts/publication-draft-queue/draft-queue.json'
    if source.startswith('pipeline/publish-assets/'):
        return 'artifacts/publish-assets/' + source.removeprefix('pipeline/publish-assets/')
    prefix = f'pipeline/visual/{slug}/'
    if source.startswith(prefix):
        return 'artifacts/visual-assets/' + source.removeprefix(prefix)
    raise ValueError('交付包含未授权的文件类型：' + source)


def queue_errors(queue: Any, run_id: str, slug: str, platforms: list[str]) -> list[str]:
    """Structural half of the contract; live source authority verifies every hash."""
    if not isinstance(queue, dict) or queue.get('schema') != 'aifios.publication-draft-queue.v1':
        return ['草稿队列格式无效。']
    try:
        selected = normalize_platforms(platforms)
        if normalize_platforms(queue.get('target_platforms')) != selected:
            raise ValueError('发布队列与本期已选平台不一致。')
        if queue.get('run_id') != run_id or queue.get('run_slug') != slug:
            raise ValueError('草稿队列不属于本期。')
        jobs = queue.get('jobs')
        contract = publication_contract(selected)
        expected = {item[:3] for item in contract}
        if not isinstance(jobs, list) or len(jobs) != len(expected) or any(not isinstance(j, dict) for j in jobs):
            raise ValueError('发布队列必须精确包含每个已选平台的一项成品。')
        if {(j.get('platform'), j.get('item_id'), j.get('delivery_kind')) for j in jobs} != expected:
            raise ValueError('发布队列存在缺项、多项或重复任务。')
        if len({j.get('job_id') for j in jobs}) != len(jobs):
            raise ValueError('发布任务编号重复。')
        expected_paths = {i[0]: 'pipeline/publish-assets/' + i[3].format(slug=slug) for i in contract}
        for job in jobs:
            payload = job.get('payload') or {}
            platform = job['platform']
            if platform != 'wechat' and payload.get('copy_path') != expected_paths[platform]:
                raise ValueError('发布正文没有绑定本期对应文件。')
            if platform == 'shipinhao' and payload.get('execution_package_path') != expected_paths[platform]:
                raise ValueError('视频号没有绑定本期口播与拍摄说明。')
            if platform == 'wechat' and (payload.get('copy_path') != queue.get('package_path') or not payload.get('html_path')):
                raise ValueError('公众号缺少当前正文或已采用 HTML。')
            if platform == 'xiaohongshu':
                ids = [a.get('id') for a in job.get('selected_asset_hashes', []) if isinstance(a, dict)]
                if ids != [f'xhs-01-p{i}' for i in range(1, 9)]:
                    raise ValueError('小红书必须按 P1–P8 提供完整八页。')
            if platform == 'shipinhao' and (job.get('selected_asset_hashes') or payload.get('asset_paths')):
                raise ValueError('视频号执行稿不能冒充已生成视频或图片。')
        return []
    except (ValueError, TypeError, KeyError) as exc:
        return [str(exc)]


def validate_public_copy(package_text: str, queue: dict, read) -> None:
    """Check the auxiliary article copy too; the queue hashes its HTML instead."""
    from visual_publish import parse_package_body
    body = package_text.split('---', 2)[-1].strip() if package_text.startswith('---') else package_text
    parsed = parse_package_body(body)
    wechat = parsed.get('wechat')
    if wechat:
        job = next(j for j in queue['jobs'] if j['platform'] == 'wechat')
        expected = '\n'.join([
            '标题：' + wechat['title'], '摘要：' + wechat['summary'],
            '推荐 HTML：' + job['payload']['html_path'], '', wechat['body'], '',
            '评论区引导：', wechat.get('comment_hook') or '按正文中的问题继续收集读者场景。',
        ])
        path = f'pipeline/publish-assets/{queue["run_slug"]}/wechat-publish.md'
        if read(path).decode('utf-8').strip() != expected.strip():
            raise ValueError('公众号可复制正文与当前成稿不一致，请重新整理成品。')


def prerequisites(project: Path, run: dict) -> dict:
    from content_runtime import ContentRuntime
    from delivery_pack import is_allowed_publication_asset_path, is_sensitive_file
    from release_gate import build_package_manifest, run_release_gate
    from visual_publish import _visual_node_command
    from visual_release import resolve_selected_visual_release

    errors: list[str] = []
    evidence: list[str] = []
    result = {'errors': errors, 'evidence': evidence}
    try:
        project = project.resolve()
        platforms = normalize_platforms(run.get('selected_platforms'))
        if normalize_platforms(run.get('target_platforms')) != platforms:
            raise ValueError('本期平台选择与任务范围不一致，请重新确认写作方案。')
        run_id, slug = run['run_id'], run['slug']
        if not re.fullmatch(r'[A-Za-z0-9_\-\u4e00-\u9fff]+', slug):
            raise ValueError('本期标识无效。')
        package = run.get('steps', {}).get('package', {}).get('latest')
        package_file = safe_file(project, package)
        text = package_file.read_text()
        manifest = build_package_manifest(text)
        if (manifest.get('schema') != 'echo-founder.platform-native-package.v2' or not manifest.get('valid')
                or manifest.get('platform_scope_errors') or normalize_platforms(manifest.get('target_platforms')) != platforms):
            raise ValueError('当前原生成稿与已选平台不一致或内容不完整，请回到成稿阶段核对。')
        body = text.split('---', 2)[-1].strip() if text.startswith('---') else text
        quality = run_release_gate(body)
        if quality.get('blocking_issues'):
            raise ValueError('成稿检查未通过：' + '；'.join(quality['blocking_issues'][:3]))
        rt = ContentRuntime(project)
        scopes = {'topic_template': run.get('steps', {}).get('blueprint', {}).get('latest'), 'content_package': package,
                  'draft_information': f'materials/publication/drafts/{slug}/draft-queue.json'}
        visual = bool(set(platforms) & {'wechat', 'xiaohongshu'})
        if visual:
            scopes['visual_assets'] = f'pipeline/visual/{slug}/selected-assets.json'
        for scope, path in scopes.items():
            if not path:
                raise ValueError(f'{scope} 缺少当前文件，请返回对应阶段完成。')
            safe_file(project, path)
            status = rt.approval_status(scope, path, run_id)
            if not status.get('approved'):
                raise ValueError(f'{scope} 确认已失效：{status.get("reason", "请重新核对")}')
        queue_path = scopes['draft_information']
        queue = json.loads(safe_file(project, queue_path).read_text())
        queue_issues = queue_errors(queue, run_id, slug, platforms)
        if queue_issues:
            raise ValueError('；'.join(queue_issues))
        root = Path(__file__).resolve().parents[3]
        candidates = [root / 'ui/electron/delivery-authority.cjs', root.parent / 'app/electron/delivery-authority.cjs']
        script = next((p for p in candidates if p.is_file()), None)
        if script is None:
            raise ValueError('交付核验组件缺失，请重新安装。')
        command, env = _visual_node_command(script, [str(project), run_id, queue_path])
        response = subprocess.run(command, env=env, text=True, capture_output=True, timeout=60)
        try:
            authority = json.loads(response.stdout)
        except ValueError:
            raise ValueError('无法完成来源与确认记录核验，请重新打开应用后重试。')
        if response.returncode or authority.get('error'):
            raise ValueError(f'来源或发布信息检查失败：{authority.get("error", "请重新确认")}')
        sources = dict(authority['files'])
        sources[package] = digest(package_file.read_bytes())
        sidecar_path = f'pipeline/publish-assets/{slug}-platform-deliverables.json'
        sidecar = json.loads(safe_file(project, sidecar_path).read_text())
        if set(sidecar) & {'wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'} != set(platforms):
            raise ValueError('平台成品清单与本期已选平台不一致。')
        archive = sidecar.get('archive') or {}
        if archive.get('packagePath') != package:
            raise ValueError('平台成品清单引用了其他成稿。')
        declared = archive.get('generatedPaths')
        required = {'pipeline/publish-assets/' + i[3].format(slug=slug) for i in publication_contract(platforms)}
        if (not isinstance(declared, list) or any(not isinstance(p, str) for p in declared)
                or len(set(declared)) != len(declared) or not required.issubset(declared)):
            raise ValueError('平台成品清单存在缺失或重复文件。')
        for path in [*declared, sidecar_path]:
            if not is_allowed_publication_asset_path(path, slug) or not allowed_asset_path(path, slug, platforms):
                raise ValueError('平台成品清单包含非契约文件：' + path)
            sources[path] = digest(safe_file(project, path).read_bytes())
        validate_public_copy(text, queue, lambda path: safe_file(project, path).read_bytes())
        if visual:
            release = resolve_selected_visual_release(project, slug)
            if release.get('status') != 'pass':
                raise ValueError('已采用排版无法交付：' + '；'.join(release.get('errors', [])[:3]))
            for path in release.get('copy_paths', []):
                sources[path] = digest(safe_file(project, path).read_bytes())
        files = {}
        for source, sha in sources.items():
            file = safe_file(project, source)
            if is_sensitive_file(file, Path(source)):
                raise ValueError('交付文件含敏感内容，请回到对应阶段核对：' + source)
            if digest(file.read_bytes()) != sha:
                raise ValueError('交付核验期间文件发生变化，请重试。')
            files[member_path(source, slug, package)] = {'source': source, 'sha256': sha}
            evidence.append(source)
        contract = {'schema': SCHEMA, 'run_id': run_id, 'slug': slug, 'platforms': platforms,
                    'package_path': package, 'package_sha256': sources[package], 'files': files,
                    'source_authority': authority['authority']}
        contract['sha256'] = digest(canonical(contract).encode())
        result['contract'] = contract
        # CLI demos use automated confirmations, never customer acceptance.
        if (project / 'demo-provenance.json').exists() or run.get('source') == 'offline-demo-simulation':
            result['internal_only'] = True
    except (OSError, ValueError, RuntimeError, TypeError, KeyError, AttributeError, StopIteration, subprocess.TimeoutExpired) as exc:
        errors.append(str(exc))
    return result


def contract_errors(contract: Any, manifest: dict, read) -> list[str]:
    """Same content/file requirements for a directory and a ZIP reader."""
    try:
        if not isinstance(contract, dict) or contract.get('schema') != SCHEMA:
            raise ValueError('缺少本期平台交付核验记录。')
        unsigned = {k: v for k, v in contract.items() if k != 'sha256'}
        if digest(canonical(unsigned).encode()) != contract.get('sha256'):
            raise ValueError('本期平台交付核验摘要失效。')
        platforms = normalize_platforms(manifest.get('platforms'))
        if (platforms != contract.get('platforms') or manifest.get('run_id') != contract.get('run_id')
                or manifest.get('slug') != contract.get('slug')):
            raise ValueError('交付清单的平台或任务不匹配。')
        files = contract.get('files')
        if not isinstance(files, dict) or not files:
            raise ValueError('交付核验没有文件摘要。')
        for member, entry in files.items():
            if member_path(entry['source'], contract['slug'], contract['package_path']) != member:
                raise ValueError('交付文件映射不属于当前任务。')
            if digest(read(member)) != entry.get('sha256'):
                raise ValueError('交付文件与已核对版本不一致：' + member)
        package_member = member_path(contract['package_path'], contract['slug'], contract['package_path'])
        if files.get(package_member, {}).get('sha256') != contract.get('package_sha256'):
            raise ValueError('内容包摘要与交付记录不一致。')
        from release_gate import build_package_manifest
        package = build_package_manifest(read(package_member).decode('utf-8'))
        if package.get('schema') != 'echo-founder.platform-native-package.v2' or not package.get('valid') or package.get('platform_scope_errors') or normalize_platforms(package.get('target_platforms')) != platforms:
            raise ValueError('交付内容包与已选平台不一致。')
        queue = json.loads(read('artifacts/publication-draft-queue/draft-queue.json'))
        errors = queue_errors(queue, contract['run_id'], contract['slug'], platforms)
        if errors:
            raise ValueError('；'.join(errors))
        if queue.get('package_path') != contract['package_path'] or queue.get('package_sha256') != contract['package_sha256']:
            raise ValueError('队列与交付内容包不匹配。')
        validate_public_copy(read(package_member).decode('utf-8'), queue,
                             lambda p: read(member_path(p, contract['slug'], contract['package_path'])))
        sidecar_member = f'artifacts/publish-assets/{contract["slug"]}-platform-deliverables.json'
        sidecar = json.loads(read(sidecar_member))
        if set(sidecar) & {'wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments'} != set(platforms):
            raise ValueError('交付平台成品清单与本期不一致。')
        required = ['pipeline/publish-assets/' + i[3].format(slug=contract['slug']) for i in publication_contract(platforms)]
        declared = sidecar.get('archive', {}).get('generatedPaths', [])
        if not isinstance(declared, list) or any(not isinstance(p, str) or not allowed_asset_path(p, contract['slug'], platforms) for p in declared):
            raise ValueError('交付成品清单包含未选平台或非法文件。')
        if sidecar.get('archive', {}).get('packagePath') != contract['package_path'] or len(declared) != len(set(declared)) or not set(required).issubset(declared):
            raise ValueError('交付平台成品清单文件不完整。')
        needed = [package_member, sidecar_member, 'artifacts/publication-draft-queue/draft-queue.json']
        needed += [member_path(path, contract['slug'], contract['package_path']) for path in declared]
        for job in queue['jobs']:
            payload = job['payload']
            source = payload.get('html_path') if job['platform'] == 'wechat' else payload.get('copy_path')
            member = member_path(source, contract['slug'], contract['package_path'])
            if digest(read(member)) != job.get('content_hash'):
                raise ValueError('发布正文摘要失效。')
            needed.append(member)
            for asset in job.get('selected_asset_hashes', []):
                member = member_path(asset['path'], contract['slug'], contract['package_path'])
                if digest(read(member)) != asset.get('sha256'):
                    raise ValueError('发布配图摘要失效。')
                needed.append(member)
        if any(member not in files for member in needed):
            raise ValueError('交付核验缺少必需文件的摘要。')
        return []
    except (OSError, ValueError, TypeError, KeyError, UnicodeError, AttributeError, StopIteration) as exc:
        return [str(exc)]


def inspect_bundle(manifest: dict, directory: Path, zip_path: str | None = None) -> list[str]:
    contract = manifest.get('selected_platform_contract')
    errors = contract_errors(contract, manifest, lambda p: safe_file(directory, p).read_bytes())
    if zip_path:
        try:
            with zipfile.ZipFile(zip_path) as archive:
                infos = archive.infolist()
                names = [i.filename for i in infos]
                disk_names = {p.relative_to(directory).as_posix() for p in directory.rglob('*') if p.is_file()}
                archive_names = {i.filename for i in infos if not i.is_dir()}
                if len(names) != len(set(names)) or disk_names != archive_names:
                    raise ValueError('ZIP 文件列表与已核对目录不一致或存在重复条目。')
                for info in infos:
                    if stat.S_ISLNK(info.external_attr >> 16):
                        raise ValueError('ZIP 不能包含符号链接。')
                    if not info.is_dir() and archive.read(info) != safe_file(directory, info.filename).read_bytes():
                        raise ValueError('ZIP 内容与已核对目录不一致：' + info.filename)
                errors.extend(contract_errors(contract, manifest, archive.read))
        except (OSError, ValueError, zipfile.BadZipFile, KeyError) as exc:
            errors.append(str(exc))
    return errors
