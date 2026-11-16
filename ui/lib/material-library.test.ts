import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-material-library-${process.pid}`,
}));

vi.mock('./project-root', async (original) => {
  const actual = await original<typeof import('./project-root')>();
  const pathModule = await import('node:path');
  return {
    ...actual,
    PROJECT_DIR: mocks.projectDir,
    safeResolve: (base: string, target: string) => {
      const resolvedBase = pathModule.resolve(base);
      const resolved = pathModule.resolve(resolvedBase, target);
      return resolved === resolvedBase || resolved.startsWith(`${resolvedBase}${pathModule.sep}`) ? resolved : null;
    },
  };
});

import {
  AUTO_ARCHIVE_CONFIDENCE,
  confirmRawMaterialArchive,
  getRawMaterialDashboard,
  listRawMaterials,
  getRawMaterialRecord,
  getRawMaterialDetail,
  updateRawMaterial,
  rawMaterialDraftInput,
  ingestProductionMaterials,
  ingestRawMaterials,
  MaterialLibraryError,
  migrateLegacyRawMaterials,
  reclassifyRawMaterial,
  undoAutoArchivedRawMaterial,
} from './material-library';
import { INSTALL_ROOT } from './project-root';
import * as runtimeWriter from './runtime-writer';
import { readProductionDraft, saveProductionDraft } from './production-drafts';

const execute = promisify(execFile);
async function writeProjectFile(relativePath: string, content: unknown) {
  const absolute = path.join(mocks.projectDir, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
}

// Real runtime approval fixtures, with synthetic research responses and no
// model calls or network requests. The material-library verifier is not mocked.
async function approvedRun(mode: 'author_material' | 'platform') {
  const { stdout } = await execute('python3', ['-c', String.raw`
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]) / 'skills/content-runtime/scripts'))
from content_runtime import ContentRuntime
import author_evidence
import market_signal
project, mode = Path(sys.argv[2]), sys.argv[3]
runtime = ContentRuntime(project)
runtime.init()
run = runtime.create_run(topic='material-1791185319353', platforms='公众号', run_id='run-a')
topic = '客户临时改需求，先确认范围'
intake = runtime.write('intake', run['slug'], '作者提供的方法：先列出改动，再确认费用和时间。', run_id=run['run_id'])
context = {
  'schema': 'aifios.material-analysis.v1', 'runId': run['run_id'],
  'inputFingerprint': 'a' * 64, 'analysisInputFingerprint': 'a' * 64, 'analysisStatus': 'current',
  'input': {'rawMaterial': '这是软件验收用的虚构案例。先列出改动，再确认费用和时间。', 'files': [], 'links': []},
  'analysis': {'summary': '作者提供的方法', 'opinions': ['先确认范围'], 'facts': [], 'cases': [], 'authorRequirements': ['不加销售引导'], 'risks': []},
  'selection': {'materialTypeId': 'method', 'structureId': 'problem-method'},
}
context_path = project / 'sessions/material-analysis/run-a.json'
context_path.parent.mkdir(parents=True, exist_ok=True)
context_path.write_text(json.dumps(context, ensure_ascii=False))
if mode == 'author_material':
  source = runtime.author_source_context(run['run_id'])
  binding = runtime.select_author_source({'run_id': run['run_id'], 'id': 'author_' + 'a' * 32, 'topic': topic, **{key: source[key] for key in ('intake_path', 'intake_sha256', 'material_sha256', 'source_revision')}})
  body = '# 测试写作方案\n' + author_evidence.binding_lines(binding)
else:
  def fixture_fetch(platform, query):
    return {'status': 'available', 'platform': platform, 'endpoint_id': platform + '.fixture.search', 'query_applied': True,
      'raw_payload': {'data': {'items': [{'title': platform + ' ' + query, 'desc': '仅用于验收的虚构样本。', 'url': 'https://example.test/' + platform, 'like_count': 20}]}}}
  research = market_signal.fetch_market_signals('企业出海和自媒体需要低成本样板。', ['wechat'], project, live_fetcher=fixture_fetch)
  snapshot = market_signal.persist_market_snapshot(project=project, run_id=run['run_id'], topic=topic, source_path=intake['path'], result=research)
  runtime.set_topic(run['run_id'], topic, snapshot['manifest_path'], snapshot['snapshot_sha256'])
  body = '# 测试写作方案\n- 研究快照：' + snapshot['manifest_path'] + '\n- 快照 SHA-256：' + snapshot['snapshot_sha256']
body += '\n\n## 公众号独立蓝图\n先列出改动，再确认费用和时间。\n'
blueprint = runtime.write('blueprint', run['slug'], body, run_id=run['run_id'])
runtime.approve_artifact('topic_template', blueprint['path'], run['run_id'])
print(json.dumps({'run': runtime.run_state(run_id=run['run_id']), 'topic': topic}, ensure_ascii=False))
`, INSTALL_ROOT, mocks.projectDir, mode], { cwd: INSTALL_ROOT, timeout: 15_000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout) as { run: Record<string, unknown>; topic: string };
}

describe('raw material library', () => {
  it('reads source declarations from full stored text without trusting title, classification or summary', async () => {
    const content = '【虚构案例】\n一位客户增加修改。';
    const { records } = await ingestRawMaterials({ items: [{ title: '真实成功案例', content }] });
    const id = records[0].id;
    expect(records[0].sourceNature).toEqual({ textAvailable: true, declarations: ['fictional'] });
    expect(records[0]).not.toHaveProperty('content');
    await confirmRawMaterialArchive({ ids: [id], categoryById: { [id]: 'case' } });
    const reclassified = await reclassifyRawMaterial({ id, category: 'fact' });
    expect(reclassified.sourceNature.declarations).toEqual(['fictional']);
    const detail = (await getRawMaterialDetail(id))!;
    await updateRawMaterial({ id, expectedVersion: detail.version, title: '客户访谈摘录', content: detail.content, sourceLabel: '虚构验收文字', sourceUrl: '' });
    const beforeRead = await readFile(path.join(mocks.projectDir, 'materials/library/index.json'), 'utf8');
    const listing = await listRawMaterials();
    expect(listing.items[0].sourceNature.declarations).toEqual(['fictional']);
    expect((await getRawMaterialDashboard()).rawMaterials.total).toBe(1);
    expect(await readFile(path.join(mocks.projectDir, 'materials/library/index.json'), 'utf8')).toBe(beforeRead);
    expect((await getRawMaterialDetail(id))!.content).toBe(content);
  });

  it('makes an explicit new assignment or keeps the original one without changing the library source', async () => {
    const content = '【付费体验模拟，非真实客户经历】\n题目：客户问为什么这么贵。\n以下是虚构练习：一位顾问列出交付范围。\n写给独立顾问，小红书，800字以内，语气平实。不引导私信。结尾给一段回复客户的话。';
    const { records } = await ingestRawMaterials({ items: [{ title: '本期输入素材', content }] });
    const detail = (await getRawMaterialDetail(records[0].id))!;
    const requestId = '11111111-1111-1111-1111-111111111111';
    const fresh = await rawMaterialDraftInput(detail.item.id, detail.version, requestId, { mode: 'new_topic', topic: '怎样确认新增需求' });
    expect(fresh.name).toBe('怎样确认新增需求');
    expect(fresh.state.draft).toMatchObject({ topic: '怎样确认新增需求', writingMode: 'author_material', writingModeChosen: true });
    expect(fresh.state.materialFiles[0].writingRequirements).toBe('reference_only');
    expect(fresh.state.materialText).toBe('题目：怎样确认新增需求');
    expect(await readFile(path.join(mocks.projectDir, fresh.state.materialFiles[0].path), 'utf8')).toContain(content);
    expect(await rawMaterialDraftInput(detail.item.id, detail.version, requestId, { mode: 'new_topic', topic: '怎样确认新增需求' })).toEqual(fresh);
    await saveProductionDraft(fresh);
    const reopened = (await readProductionDraft(fresh.id))!;
    expect(reopened.state.materialFiles).toEqual(fresh.state.materialFiles);
    expect(reopened.state.draft).toMatchObject({ topic: '怎样确认新增需求', writingMode: 'author_material', writingModeChosen: true });
    expect(reopened.state.reviewAssertions).toEqual({});
    const same = await rawMaterialDraftInput(detail.item.id, detail.version, requestId, { mode: 'same_topic', topic: '不应覆盖原题目的请求' });
    expect(same.id).not.toBe(fresh.id);
    expect(same.state.draft).toMatchObject({ topic: '客户问为什么这么贵', writingMode: 'author_material', writingModeChosen: true, selectedPlatforms: ['xhs'] });
    expect(same.state.materialFiles[0].writingRequirements).toBeUndefined();
    expect(same.state.materialText).toBe('');
    expect((await getRawMaterialDetail(detail.item.id))!).toEqual(detail);
    await expect(rawMaterialDraftInput(detail.item.id, detail.version, requestId, { mode: 'new_topic', topic: ' ' })).rejects.toThrow('题目');
    await expect(rawMaterialDraftInput(detail.item.id, detail.version, requestId, { mode: 'invalid' })).rejects.toThrow('请选择');
    await expect(rawMaterialDraftInput(detail.item.id, detail.version, requestId, { mode: 'new_topic', topic: '甲'.repeat(241) })).rejects.toThrow('240');
    const ordinary = await ingestRawMaterials({ items: [{ title: '一次访谈', content: '客户谈起了预算。' }] });
    const withoutTopic = (await getRawMaterialDetail(ordinary.records[0].id))!;
    await expect(rawMaterialDraftInput(withoutTopic.item.id, withoutTopic.version, requestId, { mode: 'same_topic' })).rejects.toThrow('没有读到原题目');
  });

  it('keeps production-input identity after its display title is edited', async () => {
    const item = { title: '本期输入素材', content: '原始资料。', origin: 'production_input', runId: 'run-a' };
    const initial = await ingestRawMaterials({ items: [item], deduplicate: true });
    const detail = (await getRawMaterialDetail(initial.records[0].id))!;
    await updateRawMaterial({ id: detail.item.id, expectedVersion: detail.version, title: '客户问价格的那次访谈', content: detail.content, sourceLabel: '', sourceUrl: '' });
    const repeated = await ingestRawMaterials({ items: [{ ...item, title: '系统根据内容生成的标题' }], deduplicate: true });
    expect(repeated).toMatchObject({ created: 0, existing: 1 });
    expect(repeated.records[0].title).toBe('客户问价格的那次访谈');
  });

  it('does not select a platform merely mentioned in the title or a negative writing request', async () => {
    const { records } = await ingestRawMaterials({ items: [{ content: '题目：小红书上的客户问题。\n写给独立顾问，公众号，800字以内。不要发视频号，不要写小红书。' }] });
    const detail = (await getRawMaterialDetail(records[0].id))!;
    const draft = await rawMaterialDraftInput(detail.item.id, detail.version, '11111111-1111-1111-1111-111111111111', { mode: 'same_topic' });
    expect(draft.state.draft.selectedPlatforms).toEqual(['wechat']);
  });

  beforeEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('reads the whole material, edits with version checks and keeps an immutable draft copy', async () => {
    const original = '客户原话与回答。\n'.repeat(50) + '全文最后一行。';
    const imported = await ingestRawMaterials({ items: [{ title: '客户问题', content: original }] });
    const id = imported.records[0].id;
    const first = (await getRawMaterialDetail(id))!;
    expect(first.content).toBe(original);
    expect(first.item.suggestion.summary.length).toBeLessThan(original.length);
    const requestId = '11111111-1111-1111-1111-111111111111';
    const draft = await rawMaterialDraftInput(id, first.version, requestId);
    const snapshot = path.join(mocks.projectDir, draft.state.materialFiles[0].path);
    expect(await readFile(snapshot, 'utf8')).toContain(original);
    expect(await rawMaterialDraftInput(id, first.version, requestId)).toEqual(draft);
    const changed = await updateRawMaterial({ id, expectedVersion: first.version, title: '客户常问的问题', content: '修改后的独立记录', sourceLabel: '本周访谈', sourceUrl: 'https://example.test/interview' });
    expect(changed.item.title).toBe('客户常问的问题');
    expect(changed.content).toBe('修改后的独立记录');
    expect(changed.item.category).toBe(first.item.category);
    expect(changed.item.sourceLineage.origin).toBe(first.item.sourceLineage.origin);
    expect(await readFile(snapshot, 'utf8')).toContain(original);
    const histories = await readdir(path.join(mocks.projectDir, 'materials/library/history'), { recursive: true });
    const previous = histories.find((file) => String(file).endsWith('.json'))!;
    expect(JSON.parse(await readFile(path.join(mocks.projectDir, 'materials/library/history', String(previous)), 'utf8')).content).toBe(original);
    await expect(updateRawMaterial({ id, expectedVersion: first.version, title: '过期编辑', content: '不要覆盖新内容', sourceLabel: '', sourceUrl: '' })).rejects.toThrow('其他页面更新');
    await expect(rawMaterialDraftInput(id, first.version, requestId)).rejects.toThrow('素材已更新');
    expect((await getRawMaterialDetail(id))!.content).toBe('修改后的独立记录');
  });

  it('binds file-backed full text to its version and never edits the source file', async () => {
    const source = path.join(mocks.projectDir, 'materials/source.txt');
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, '原文件全文。');
    const imported = await ingestRawMaterials({ items: [{ title: '访谈', kind: 'file', sourcePath: 'materials/source.txt' }] });
    const id = imported.records[0].id;
    const first = (await getRawMaterialDetail(id))!;
    expect(first.contentSource).toBe('file');
    expect(first.content).toBe('原文件全文。');
    await writeFile(source, '原文件后来有变化。');
    await expect(rawMaterialDraftInput(id, first.version, '11111111-1111-1111-1111-111111111111')).rejects.toThrow('素材已更新');
    const current = (await getRawMaterialDetail(id))!;
    await updateRawMaterial({ id, expectedVersion: current.version, title: '访谈摘录', content: '我编辑的摘录。', sourceLabel: '原访谈', sourceUrl: '' });
    expect(await readFile(source, 'utf8')).toBe('原文件后来有变化。');
    expect((await getRawMaterialDetail(id))!.contentSource).toBe('library');
  });

  it('does not follow material file symlinks outside the selected source', async () => {
    await mkdir(path.join(mocks.projectDir, 'materials'), { recursive: true });
    await writeFile(path.join(mocks.projectDir, 'original.txt'), '不能通过链接读取');
    await symlink(path.join(mocks.projectDir, 'original.txt'), path.join(mocks.projectDir, 'materials/link.txt'));
    const imported = await ingestRawMaterials({ items: [{ title: '文件', kind: 'file', sourcePath: 'materials/link.txt' }] });
    await expect(getRawMaterialDetail(imported.records[0].id)).rejects.toThrow('链接');
  });

  it('queues uncertain material, auto-archives high-confidence material, and retains an undoable audit trail', async () => {
    const result = await ingestRawMaterials({
      items: [
        {
          title: '随手想法',
          content: '以后可以聊聊这个方向。',
        },
        {
          title: '客户案例复盘',
          content: '客户项目上线后，转化率提升 20%。',
          suggestion: {
            category: 'case',
            confidence: 0.96,
            reason: '已由 AI 确认是客户案例。',
            summary: '一则可复用的客户项目案例。',
            engine: 'ai',
          },
        },
      ],
    });

    expect(AUTO_ARCHIVE_CONFIDENCE).toBe(0.9);
    expect(result.created).toBe(2);
    expect(result.autoArchived).toBe(1);
    expect(result.records[0]).toMatchObject({ status: 'pending_confirmation', category: null });
    expect(result.records[1]).toMatchObject({ status: 'archived', category: 'case', archiveMethod: 'auto' });

    const dashboard = await getRawMaterialDashboard();
    expect(dashboard.rawMaterials).toMatchObject({ all: 2, pendingConfirmation: 1, autoArchived: 1 });
    expect(dashboard.pendingArchiveSuggestions).toHaveLength(1);
    expect(dashboard.recentAutoArchives).toHaveLength(1);

    const undone = await undoAutoArchivedRawMaterial(result.records[1].id);
    expect(undone).toMatchObject({ status: 'pending_confirmation', category: null });

    const confirmed = await confirmRawMaterialArchive({
      ids: [result.records[0].id, result.records[1].id],
      categoryById: { [result.records[0].id]: 'insight' },
    });
    expect(confirmed.map((item) => item.category)).toEqual(['insight', 'case']);

    const reclassified = await reclassifyRawMaterial({ id: result.records[1].id, category: 'fact' });
    expect(reclassified).toMatchObject({ status: 'archived', category: 'fact', archiveMethod: 'reclassified' });
  });

  it('stores source lineage and blocks traversal or credentials in local material records', async () => {
    const result = await ingestRawMaterials({
      items: [{
        title: '报告附件',
        sourcePath: 'materials/intake/report.md',
        sourceLineage: {
          origin: 'manual_file',
          sourcePath: 'materials/intake/report.md',
          sourceLabel: '运营报告原件',
        },
      }],
    });
    const stored = await getRawMaterialRecord(result.records[0].id);
    expect(stored?.sourceLineage).toMatchObject({
      origin: 'manual_file',
      sourcePath: 'materials/intake/report.md',
      sourceLabel: '运营报告原件',
    });

    await expect(ingestRawMaterials({
      items: [{ title: 'bad', sourcePath: '../secrets.md' }],
    })).rejects.toBeInstanceOf(MaterialLibraryError);
    await expect(ingestRawMaterials({
      items: [{ title: 'bad link', sourceUrl: 'https://name:secret@example.com/private' }],
    })).rejects.toThrow('账号或密码');
  });

  it('migrates legacy material files through a sidecar index without moving or rewriting original files', async () => {
    const legacyPath = path.join(mocks.projectDir, 'materials', 'hit-library', 'wechat', 'reference.md');
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, '# 一篇爆款参考\n', 'utf-8');

    const migrated = await migrateLegacyRawMaterials();
    expect(migrated.created).toBe(1);
    expect(migrated.records[0]).toMatchObject({
      category: 'reference',
      status: 'archived',
      sourceLineage: { sourcePath: 'materials/hit-library/wechat/reference.md' },
    });
    expect(await readFile(legacyPath, 'utf-8')).toBe('# 一篇爆款参考\n');
    const storedIndex = JSON.parse(await readFile(path.join(mocks.projectDir, 'materials/library/index.json'), 'utf-8'));
    expect(storedIndex.records).toHaveLength(1);

    const repeated = await migrateLegacyRawMaterials();
    expect(repeated).toMatchObject({ created: 0, existing: 1 });
  });

  it('decomposes a run into idempotent input and artifacts without inventing a topic confirmation', async () => {
    const runId = 'run-a';
    const files = [
      ['runs/run-a.json', JSON.stringify({
        run_id: runId,
        slug: 'run-a',
        topic: '为什么高质量内容要先做研究',
        steps: {
          market_research: { latest: 'runs/run-a/market-research/snapshot.json' },
          write: { latest: 'pipeline/final/run-a.md' },
          performance: { latest: 'pipeline/performance/run-a.md' },
        },
      })],
      ['sessions/material-analysis/run-a.json', JSON.stringify({
        input: {
          rawMaterial: '客户常常在选题前直接写稿，导致观点没有真实市场依据。',
          files: [{ name: '客户访谈.md', sourcePath: 'materials/intake/customer.md' }],
          links: [{ url: 'https://example.com/reference', title: '外部参考', excerpt: '可借鉴的爆点。' }],
        },
      })],
      ['runs/run-a/market-research/snapshot.json', '{"samples":[]}'],
      ['pipeline/final/run-a.md', '# 最终文章\n\n先研究再写作。'],
      ['pipeline/performance/run-a.md', '# 表现\n\n阅读 1000，互动 86。'],
    ] as const;
    for (const [relativePath, content] of files) {
      const absolute = path.join(mocks.projectDir, relativePath);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content, 'utf-8');
    }

    const first = await ingestProductionMaterials({ runId });
    expect(first.created).toBeGreaterThanOrEqual(6);
    expect(first.records.some((item) => item.sourceLineage.origin === 'confirmed_topic')).toBe(false);
    expect(first.records.some((item) => item.sourceLineage.origin === 'research_insight')).toBe(true);
    expect(first.records.some((item) => item.sourceLineage.origin === 'final_content')).toBe(true);
    expect(first.records.some((item) => item.sourceLineage.origin === 'publication_performance')).toBe(true);
    expect(first.records.every((item) => item.sourceLineage.runId === runId)).toBe(true);

    const repeated = await ingestProductionMaterials({ runId });
    expect(repeated).toMatchObject({ created: 0 });
    expect(repeated.existing).toBe(first.records.length);
  });

  it.each(['material-1791185319353', '已经输入但还没确认的题目'])('saves raw input without treating %s as an approved topic', async (topic) => {
    await writeProjectFile('runs/run-a.json', { run_id: 'run-a', slug: 'run-a', topic, steps: {} });
    await writeProjectFile('sessions/material-analysis/run-a.json', { input: { rawMaterial: '作者实际输入的完整素材。', files: [], links: [] } });
    const first = await ingestProductionMaterials({ runId: 'run-a' });
    expect(first.created).toBe(1);
    expect(first.records[0].sourceLineage.origin).toBe('production_input');
    expect((await getRawMaterialDetail(first.records[0].id))?.content).toBe('作者实际输入的完整素材。');
    expect(await ingestProductionMaterials({ runId: 'run-a' })).toMatchObject({ created: 0, existing: 1 });
  });

  it.each(['author_material', 'platform'] as const)('archives the author-selected %s topic only after current runtime approval', async (mode) => {
    const fixture = await approvedRun(mode);
    const first = await ingestProductionMaterials({ runId: 'run-a' });
    const topic = first.records.find((item) => item.sourceLineage.origin === 'confirmed_topic');
    expect(topic?.title).toBe(`本期已确认选题 · ${fixture.topic}`);
    expect((await getRawMaterialDetail(topic!.id))?.content).toBe(fixture.topic);
    expect(first.records.some((item) => item.title.includes('material-1791185319353'))).toBe(false);
    expect(await ingestProductionMaterials({ runId: 'run-a' })).toMatchObject({ created: 0, existing: first.records.length });
  });

  it.each(['author_material', 'platform'] as const)('omits a %s topic when approved blueprint bytes change', async (mode) => {
    const { run } = await approvedRun(mode);
    const blueprint = ((run.steps as Record<string, { latest: string }>).blueprint).latest;
    const absolute = path.join(mocks.projectDir, blueprint);
    await writeFile(absolute, (await readFile(absolute, 'utf8')) + '\n作者另改了写作方案。');
    const result = await ingestProductionMaterials({ runId: 'run-a' });
    expect(result.records.some((item) => item.sourceLineage.origin === 'confirmed_topic')).toBe(false);
    expect(result.records.some((item) => item.sourceLineage.origin === 'production_input')).toBe(true);
  });

  it.each(['invalidated', 'different-topic', 'different-snapshot', 'missing-selection', 'boolean-approval', 'legacy-unbound'])('does not revive a %s topic confirmation', async (change) => {
    const { run } = await approvedRun('platform');
    const approvals = run.approvals as Record<string, Record<string, unknown> | boolean>;
    const approval = approvals.topic_template as Record<string, unknown>;
    const selection = run.topic_selection as Record<string, unknown>;
    if (change === 'invalidated') approval.invalidated_at = '2026-10-05T00:00:00Z';
    if (change === 'different-topic') run.topic = '后来改了题目';
    if (change === 'different-snapshot') selection.market_snapshot_sha256 = 'b'.repeat(64);
    if (change === 'missing-selection') delete run.topic_selection;
    if (change === 'boolean-approval') approvals.topic_template = true;
    if (change === 'legacy-unbound') { delete approvals.topic_template; approvals.blueprint = { approved: true, approved_at: '2026-10-05T00:00:00Z' }; }
    await writeProjectFile('runs/run-a.json', run);
    const result = await ingestProductionMaterials({ runId: 'run-a' });
    expect(result.records.some((item) => item.sourceLineage.origin === 'confirmed_topic')).toBe(false);
    expect(result.records.some((item) => item.sourceLineage.origin === 'production_input')).toBe(true);
  });

  it('accepts a digest-bound legacy approval only through the current runtime verifier', async () => {
    const { run } = await approvedRun('platform');
    const approvals = run.approvals as Record<string, Record<string, unknown>>;
    approvals.blueprint = { ...approvals.topic_template, scope: 'blueprint', method: 'human_blueprint_review' };
    delete approvals.topic_template;
    await writeProjectFile('runs/run-a.json', run);
    const result = await ingestProductionMaterials({ runId: 'run-a' });
    expect(result.records.filter((item) => item.sourceLineage.origin === 'confirmed_topic')).toHaveLength(1);
  });

  it('keeps updated author input when its earlier topic approval no longer matches', async () => {
    await approvedRun('author_material');
    const contextPath = path.join(mocks.projectDir, 'sessions/material-analysis/run-a.json');
    const context = JSON.parse(await readFile(contextPath, 'utf8'));
    context.input.rawMaterial = '作者后来补充了另一段素材。';
    await writeProjectFile('sessions/material-analysis/run-a.json', context);
    const result = await ingestProductionMaterials({ runId: 'run-a' });
    expect(result.records.some((item) => item.sourceLineage.origin === 'confirmed_topic')).toBe(false);
    const raw = result.records.find((item) => item.sourceLineage.origin === 'production_input');
    expect((await getRawMaterialDetail(raw!.id))?.content).toBe(context.input.rawMaterial);
  });

  it('still saves author input if the approval runtime is unavailable', async () => {
    await approvedRun('author_material');
    vi.spyOn(runtimeWriter, 'getRuntimeProductionApproval').mockRejectedValueOnce(new Error('runtime unavailable'));
    const result = await ingestProductionMaterials({ runId: 'run-a' });
    expect(result.records.map((item) => item.sourceLineage.origin)).toEqual(['production_input']);
  });

  it('does not attach an old approval to a topic changed during verification', async () => {
    const { run } = await approvedRun('author_material');
    const verify = runtimeWriter.getRuntimeProductionApproval;
    vi.spyOn(runtimeWriter, 'getRuntimeProductionApproval').mockImplementationOnce(async (...args) => {
      const approval = await verify(...args);
      expect(approval.approved).toBe(true);
      await writeProjectFile('runs/run-a.json', { ...run, topic: '另一个页面刚改过的题目' });
      return approval;
    });
    const result = await ingestProductionMaterials({ runId: 'run-a' });
    expect(result.records.map((item) => item.sourceLineage.origin)).toEqual(['production_input']);
  });
});
