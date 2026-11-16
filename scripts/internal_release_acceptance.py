#!/usr/bin/env python3
"""Collect and check the current stable-layout INTERNAL candidate.

This self-review never grants commercial readiness. Historical v1 image-route
records are read-only; the formal release policy remains independently gated.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
VERSION = (ROOT / 'VERSION').read_text(encoding='utf-8').strip()
SCHEMA = 'echo-founder.internal-release-acceptance.v2'
EVIDENCE_SCHEMA = 'echo-founder.internal-acceptance-evidence.v2'
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$')
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_DMG_BYTES = 20 * 1024 * 1024 * 1024
FACTS = {
    'clean_install': {
        'installed_from_bound_dmg': True, 'launched_without_developer_toolchain': True,
        'default_project_created': True,
    },
    'model_and_cost': {
        'real_model_generation_completed': True, 'provider_usage_and_cost_reconciled': True,
        'credential_status_recovers_after_restart': True, 'raw_secrets_absent_from_renderer': True,
    },
    'author_material_path': {
        'authorized_material_confirmed': True, 'author_topic_without_tikomni_completed': True,
        'changed_material_invalidates_approval': True, 'old_draft_recovers_after_restart': True,
    },
    'tikomni_research': {
        'three_selected_platforms_live': True, 'labeled_samples_at_least_45': True,
        'each_platform_at_least_15': True, 'invalid_evidence_false_hits': 0,
        'verified_hit_precision_at_least_90_percent': True,
    },
    'platform_native_production': {
        'real_model_used_for_all_runs': True, 'three_archetypes_all_three_platforms': True,
        'shared_facts_not_cross_platform_mother_draft': True, 'author_edit_adopted': True,
        'final_copy_and_download_match_approved_version': True,
    },
    'stable_layout': {
        'new_run_layout_mode': 'stable', 'paid_image_requests': 0, 'image_accounts_read': False,
        'wechat_complete_html': True, 'authorized_source_images_preserved': True,
        'md2wechat_failure_uses_bundled_renderer': True, 'xiaohongshu_cards_per_post': 8,
        'xiaohongshu_local_renderer': True, 'shipinhao_static_visual_jobs': 0,
        'human_layout_adoption_required': True,
    },
    'platform_drafts': {
        'wechat_drafts': 3, 'xiaohongshu_drafts': 3, 'shipinhao_drafts': 3,
        'no_public_send': True, 'current_payload_hashes_verified': True,
    },
    'fault_and_backup_recovery': {
        'network_offline': True, 'invalid_token': True, 'browser_not_authenticated': True,
        'captcha_or_device_confirmation': True, 'service_exit': True,
        'application_restart': True, 'cross_run_write_rejected': True,
        'backup_restored_to_new_directory': True, 'backup_checksums_verified': True,
        'credentials_and_account_sessions_excluded': True,
    },
    'frozen_dmg_runtime': {
        'not_rebuilt_after_acceptance_started': True, 'single_instance_passed': True,
        'minimal_environment_passed': True, 'soak_at_least_30_minutes_passed': True,
    },
}
REQUIRED_EVIDENCE = frozenset(FACTS)
FLAGS = {
    'non_commercial': True, 'self_reviewed': True, 'ad_hoc_signed': True,
    'apple_notarized': False, 'independent_qa': False, 'public_send_performed': False,
}


class EvidenceError(ValueError):
    pass


def _pairs(items):
    result = {}
    for key, value in items:
        if key in result:
            raise EvidenceError('duplicate JSON field')
        result[key] = value
    return result


def _json(raw: bytes) -> dict[str, Any]:
    value = json.loads(raw.decode('utf-8'), object_pairs_hook=_pairs,
                       parse_constant=lambda _: (_ for _ in ()).throw(EvidenceError('non-finite JSON value')))
    if not isinstance(value, dict):
        raise EvidenceError('JSON root must be an object')
    return value


def _read(path: Path, limit: int, *, keep: bool = True) -> tuple[bytes, str]:
    # Check ancestors as well as the leaf, before opening without following links.
    absolute = path.absolute()
    for part in [absolute, *absolute.parents]:
        if part.is_symlink():
            raise EvidenceError('symbolic links are not evidence files')
    fd = os.open(absolute, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or not 0 < before.st_size <= limit:
            raise EvidenceError('evidence must be a nonempty, single-link regular file within size limit')
        digest = hashlib.sha256(); chunks = []; count = 0
        while True:
            block = os.read(fd, min(1024 * 1024, limit + 1 - count))
            if not block:
                break
            count += len(block)
            if count > limit:
                raise EvidenceError('evidence grew past size limit')
            digest.update(block)
            if keep:
                chunks.append(block)
        after = os.fstat(fd)
        if any(part.is_symlink() for part in [absolute, *absolute.parents]):
            raise EvidenceError('symbolic link appeared while reading evidence')
        current = os.stat(absolute, follow_symlinks=False)
        identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_nlink)
        if identity(before) != identity(after) or identity(after) != identity(current) or count != after.st_size:
            raise EvidenceError('evidence changed while being read')
        return b''.join(chunks), digest.hexdigest()
    finally:
        os.close(fd)


def _reference(root: Path, ref: Any, used: set[str], *, dmg: bool = False) -> tuple[bytes, str]:
    if not isinstance(ref, dict):
        raise EvidenceError('file reference must be an object')
    value, expected = ref.get('path'), ref.get('sha256')
    if not isinstance(value, str) or not value or '\\' in value or ':' in value or any(ord(c) < 32 for c in value):
        raise EvidenceError('file path must be a relative POSIX path')
    parts = value.split('/')
    if PurePosixPath(value).is_absolute() or any(p in {'', '.', '..'} for p in parts):
        raise EvidenceError('file path must stay inside the acceptance directory')
    if value in used:
        raise EvidenceError('duplicate evidence path')
    used.add(value)
    if not isinstance(expected, str) or not SHA256_RE.fullmatch(expected):
        raise EvidenceError('file SHA-256 is required')
    raw, actual = _read(root / value, MAX_DMG_BYTES if dmg else MAX_JSON_BYTES, keep=not dmg)
    if expected != actual:
        raise EvidenceError('file SHA-256 mismatch')
    return raw, actual


def _timestamp(value: Any) -> datetime:
    if not isinstance(value, str):
        raise EvidenceError('timestamp must be timezone-aware ISO-8601')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if result.tzinfo is None or result > datetime.now(timezone.utc):
            raise ValueError()
    except ValueError:
        raise EvidenceError('timestamp is invalid or in the future') from None
    return result


def _exact(value, expected):
    return type(value) is type(expected) and value == expected


def validate(path: Path) -> dict[str, Any]:
    errors = []; missing = []; used: set[str] = set()
    result = {'status': 'invalid', 'candidate_label': '固定排版内部候选未通过',
              'commercial_ready': False, 'non_commercial': True, 'errors': errors, 'missing_evidence': missing}
    try:
        payload = _json(_read(path, MAX_JSON_BYTES)[0])
        if payload.get('schema') == 'echo-founder.internal-release-acceptance.v1':
            return {**result, 'status': 'legacy_read_only', 'candidate_label': '旧生图内部验收记录（只读）',
                    'errors': ['v1 covers the retired image workflow; use a new v2 record for stable layout']}
        if payload.get('schema') == SCHEMA and payload.get('status') == 'pending':
            result.update(status='pending', candidate_label='固定排版内部候选待验收')
            rows = payload.get('evidence')
            observed = {row.get('kind') for row in rows if isinstance(row, dict)
                        and isinstance(row.get('kind'), str) and row.get('result') == 'pass'} if isinstance(rows, list) else set()
            missing.extend(sorted(REQUIRED_EVIDENCE - observed))
        for key, expected in {'schema': SCHEMA, 'status': 'pass', 'product_version': VERSION,
                              'layout_mode': 'stable', **FLAGS}.items():
            if not _exact(payload.get(key), expected):
                errors.append(f'{key} must equal {expected!r}')
        accepted = _timestamp(payload.get('accepted_at'))
        reviewer = payload.get('reviewer')
        if not isinstance(reviewer, dict) or not isinstance(reviewer.get('name'), str) or not reviewer['name'].strip() or not ID_RE.fullmatch(str(reviewer.get('review_id', ''))):
            raise EvidenceError('reviewer name and safe review_id are required')
        root = path.absolute().parent
        candidate = payload.get('candidate')
        if not isinstance(candidate, dict):
            raise EvidenceError('frozen candidate references are required')
        _, dmg_hash = _reference(root, candidate.get('dmg'), used, dmg=True)
        package_raw, package_hash = _reference(root, candidate.get('package_manifest'), used)
        dmg_raw, _ = _reference(root, candidate.get('dmg_manifest'), used)
        package, dmg_manifest = _json(package_raw), _json(dmg_raw)
        for label, manifest in [('package', package), ('dmg', dmg_manifest)]:
            if manifest.get('product') != 'Echo Founder' or manifest.get('version') != VERSION or manifest.get('status') != 'packed':
                errors.append(f'{label} manifest product/version/status mismatch')
        source = package.get('source_control')
        if not isinstance(source, dict) or not re.fullmatch(r'[0-9a-f]{40}', str(source.get('current_sha', ''))) or type(source.get('dirty')) is not bool:
            errors.append('package manifest source revision and dirty state are required')
        if (dmg_manifest.get('artifact') != 'dmg' or dmg_manifest.get('architecture') != 'arm64'
            or dmg_manifest.get('sha256') != dmg_hash
            or not isinstance(dmg_manifest.get('package_manifest'), dict)
            or dmg_manifest['package_manifest'].get('sha256') != package_hash):
            errors.append('DMG manifest does not bind the exact DMG and package manifest')
        rows = payload.get('evidence')
        if not isinstance(rows, list):
            raise EvidenceError('evidence must be an array')
        seen = set()
        for row in rows:
            kind = row.get('kind') if isinstance(row, dict) else None
            if not isinstance(kind, str) or kind not in REQUIRED_EVIDENCE or kind in seen:
                errors.append('unknown or duplicate evidence kind'); continue
            seen.add(kind)
            if row.get('result') != 'pass':
                missing.append(kind); continue
            try:
                artifact = _json(_reference(root, row, used)[0])
                expected = {'schema': EVIDENCE_SCHEMA, 'kind': kind, 'result': 'pass', 'product_version': VERSION,
                            'candidate_dmg_sha256': dmg_hash, 'observer_id': reviewer['review_id']}
                for key, value in expected.items():
                    if not _exact(artifact.get(key), value):
                        errors.append(f'{kind}.{key} mismatch')
                if _timestamp(artifact.get('observed_at')) > accepted:
                    errors.append(f'{kind}: observation is later than acceptance')
                observations = artifact.get('observations')
                if not isinstance(observations, str) or len(observations.strip()) < 20:
                    errors.append(f'{kind}: describe the actual actions and outcome (at least 20 characters)')
                facts = artifact.get('facts')
                if not isinstance(facts, dict) or set(facts) != set(FACTS[kind]):
                    errors.append(f'{kind}: fact fields differ from the stable contract')
                else:
                    for key, value in FACTS[kind].items():
                        if not _exact(facts[key], value):
                            errors.append(f'{kind}.{key} must equal {value!r}')
            except (OSError, UnicodeError, ValueError) as exc:
                errors.append(f'{kind}: cannot read evidence file' if isinstance(exc, OSError) else f'{kind}: {exc}')
        missing.extend(sorted(REQUIRED_EVIDENCE - seen))
        missing[:] = sorted(set(missing))
        if missing:
            errors.append('real observations still missing: ' + ', '.join(missing))
        if not errors:
            result.update(status='pass', candidate_label='固定排版流程已自验（内部候选）',
                          candidate_dmg_sha256=dmg_hash, source_dirty=source['dirty'])
    except (OSError, UnicodeError, ValueError) as exc:
        # Never echo JSON source text or an absolute path in the exported report.
        errors.append('cannot read acceptance evidence' if isinstance(exc, OSError) else str(exc))
    return result


def initialize(workspace: Path) -> Path:
    """Create empty observations; no generated file is passing evidence."""
    workspace = workspace.absolute()
    if any(part.is_symlink() for part in [workspace, *workspace.parents]):
        raise EvidenceError('workspace cannot contain symbolic links')
    workspace.mkdir(parents=True, exist_ok=False, mode=0o700)
    (workspace / 'evidence').mkdir(mode=0o700)
    (workspace / 'candidate').mkdir(mode=0o700)
    record = {'schema': SCHEMA, 'status': 'pending', 'product_version': VERSION, 'layout_mode': 'stable',
              'accepted_at': None, 'reviewer': {'name': '', 'review_id': ''}, **FLAGS,
              'candidate': {name: {'path': 'candidate/' + filename, 'sha256': ''} for name, filename in
                            [('dmg', 'Echo-Founder.dmg'), ('package_manifest', 'package-manifest.json'), ('dmg_manifest', 'dmg-manifest.json')]},
              'evidence': []}
    for kind, facts in FACTS.items():
        rel = f'evidence/{kind}.json'
        record['evidence'].append({'kind': kind, 'result': 'pending', 'path': rel, 'sha256': ''})
        artifact = {'schema': EVIDENCE_SCHEMA, 'kind': kind, 'result': 'pending', 'product_version': VERSION,
                    'candidate_dmg_sha256': '', 'observed_at': None, 'observer_id': '', 'observations': '',
                    'facts': {key: None for key in facts}}
        (workspace / rel).write_text(json.dumps(artifact, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    record_path = workspace / 'internal-release-acceptance.json'
    record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    (workspace / 'expected-facts.json').write_text(json.dumps(FACTS, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return record_path


def main() -> int:
    parser = argparse.ArgumentParser(description='Stable-layout internal self-review; never commercial acceptance')
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--acceptance', type=Path)
    group.add_argument('--init', type=Path, metavar='NEW_WORKSPACE', help='create pending record and blank observation files')
    args = parser.parse_args()
    if args.init:
        try:
            initialize(args.init)
        except (OSError, ValueError):
            print(json.dumps({'status': 'invalid', 'commercial_ready': False,
                              'errors': ['cannot create workspace; choose a new, dedicated directory']}, ensure_ascii=False))
            return 2
        print(json.dumps({'status': 'pending', 'commercial_ready': False, 'record': 'internal-release-acceptance.json',
                          'required_observations': sorted(REQUIRED_EVIDENCE)}, ensure_ascii=False, indent=2))
        return 0
    result = validate(args.acceptance)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['status'] == 'pass' else 2


if __name__ == '__main__':
    raise SystemExit(main())
