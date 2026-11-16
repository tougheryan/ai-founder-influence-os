import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: `/tmp/echo-draft-library-${process.pid}`, model: '', key: '' }));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', async (original) => ({ ...await original<typeof import('./project-root')>(), PROJECT_DIR: fixture.root, projectPath: (...parts: string[]) => join(fixture.root, ...parts) }));
vi.mock('./project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('./server-config', () => ({ resolveServerLLMConfig: async () => ({ provider: 'openai', model: fixture.model, apiKey: fixture.key }) }));
import { listProductionDrafts, readProductionDraft, sanitizeProductionDraftState, saveProductionDraft } from './production-drafts';
import { GET, POST } from '@/app/api/production/drafts/route';
import type { ProductionFlowIntegrity } from './production-flow';

const state = () => ({
  activeStage: 'content-package', draft: { runId: 'run-a', runSlug: 'topic-a', projectId: 'default', topic: '客户问题', template: 'wechat-native', selectedPlatforms: ['wechat'], approved: { 'content-package': true }, artifactPaths: { 'content-package': 'stale.md' } },
  materialText: '完整素材\n最后一行也保留。', materialLinks: ['https://example.com/source'], materialFiles: [{ path: 'materials/intake/note.txt', name: '笔记' }],
  notes: { 'content-package': '未确认备注' }, reviewAssertions: { content_article_reviewed: true }, approvalModes: { 'content-package': 'server' },
  config: { apiKey: 'test-only-secret' },
});
const input = () => ({ id: `draft_${randomUUID().replaceAll('-', '')}`, expectedVersion: 0, name: '第一份草稿', state: state() });
beforeEach(async () => {
  fixture.model = ''; fixture.key = '';
  await rm(fixture.root, { recursive: true, force: true });
  await mkdir(join(fixture.root, 'runs'), { recursive: true });
  await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify({ run_id: 'run-a', slug: 'topic-a', topic: '客户问题', status: 'active', project_id: 'default', updated_at: '2026-09-15T12:00:00Z', selected_platforms: ['wechat'] }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
afterAll(async () => { await rm(fixture.root, { recursive: true, force: true }); });

describe('project draft library', () => {
  it.each([true, false])('persists whether the writing route was chosen, including before a run exists: %s', async (writingModeChosen) => {
    const request = input();
    request.state.draft.runId = ''; request.state.draft.runSlug = '';
    const payload = { ...request, state: { ...request.state, draft: { ...request.state.draft, writingMode: 'platform', writingModeChosen } } };
    const saved = await saveProductionDraft(payload);
    expect((await readProductionDraft(saved.id))?.state.draft).toMatchObject({ writingMode: 'platform', writingModeChosen });
  });
  it('preserves full input and notes but does not save credentials or cached approvals', () => {
    const result = sanitizeProductionDraftState(state());
    expect(result.materialText).toBe(state().materialText);
    expect(result.materialFiles).toEqual(state().materialFiles);
    expect(result.notes).toEqual(state().notes);
    expect(result).not.toHaveProperty('config');
    expect(result.draft).not.toHaveProperty('approved');
    expect(result.draft).not.toHaveProperty('artifactPaths');
    expect(result.reviewAssertions).toEqual({});
  });
  it('saves, renames and reopens across reads without deleting material context or changing the run', async () => {
    await mkdir(join(fixture.root, 'runs/run-a/material'), { recursive: true });
    const context = join(fixture.root, 'runs/run-a/material/context.json');
    await writeFile(context, '{"original":true}');
    const beforeRun = await readFile(join(fixture.root, 'runs/run-a.json'), 'utf8');
    const request = input();
    const saved = await saveProductionDraft(request);
    expect(await readProductionDraft(saved.id)).toEqual(saved);
    expect((await listProductionDrafts()).items).toHaveLength(1);
    const renamed = await saveProductionDraft({ ...request, expectedVersion: 1, name: '客户常问的问题' });
    expect(renamed.version).toBe(2);
    expect((await listProductionDrafts()).items[0].name).toBe('客户常问的问题');
    expect(await readFile(context, 'utf8')).toBe('{"original":true}');
    expect(await readFile(join(fixture.root, 'runs/run-a.json'), 'utf8')).toBe(beforeRun);
  });
  it('recovers a repeated save and rejects concurrent stale edits without losing either stored version', async () => {
    const request = input(); await saveProductionDraft(request);
    expect((await saveProductionDraft(request)).version).toBe(1);
    const changed = { ...request, expectedVersion: 1, name: '新标题' };
    const results = await Promise.allSettled([saveProductionDraft(changed), saveProductionDraft({ ...changed, name: '另一标题' })]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await readProductionDraft(request.id))?.version).toBe(2);
    await expect(saveProductionDraft(request)).rejects.toThrow('其他页面更新');
  });
  it('lists old unfinished runs and detached drafts, rejecting another run binding', async () => {
    const initial = await listProductionDrafts();
    expect(initial.items[0]).toMatchObject({ id: 'run:run-a', source: 'runtime' });
    const legacy = await readProductionDraft('run:run-a');
    expect(legacy?.state.draft).toMatchObject({ runId: 'run-a' });
    const request = input(); request.state.draft.runId = ''; request.state.draft.runSlug = '';
    await saveProductionDraft(request);
    expect((await listProductionDrafts()).items).toHaveLength(2);
    await expect(saveProductionDraft({ ...input(), state: { ...state(), draft: { ...state().draft, runSlug: 'other-topic' } } })).rejects.toThrow('关联的内容任务');
  });
  it('rejects unsafe paths and preserves unreadable records while listing other drafts', async () => {
    await expect(readProductionDraft('../other')).rejects.toThrow('编号不正确');
    const saved = await saveProductionDraft(input());
    const broken = input().id;
    await writeFile(join(fixture.root, 'sessions/workbench-drafts', `${broken}.json`), '{}');
    expect((await listProductionDrafts()).unreadable).toBe(1);
    await rm(join(fixture.root, 'sessions/workbench-drafts', `${saved.id}.json`));
    await symlink(join(fixture.root, 'runs/run-a.json'), join(fixture.root, 'sessions/workbench-drafts', `${saved.id}.json`));
    await expect(readProductionDraft(saved.id)).rejects.toThrow('文件不可用');
  });
  it('exposes save/list/open through the API and keeps invalid or stale requests out of storage', async () => {
    const request = input();
    const save = (body: unknown) => POST(new NextRequest('http://localhost/api/production/drafts', { method: 'POST', body: JSON.stringify(body) }));
    expect((await save(null)).status).toBe(400);
    expect((await save(request)).status).toBe(200);
    const response = await GET(new NextRequest(`http://localhost/api/production/drafts?id=${request.id}`));
    expect((await response.json()).draft.state.materialText).toBe(state().materialText);
    expect((await save({ ...request, name: '冲突' })).status).toBe(409);
    const listing = await GET(new NextRequest('http://localhost/api/production/drafts'));
    expect((await listing.json()).items).toHaveLength(1);
  });
});

describe('draft identity, progress and modification times', () => {
  async function preparedAuthorDraft() {
    const { saveMaterialAnalysisContext } = await import('./material-analysis');
    const request = input();
    const material = '我的观点：先确认范围。请写公众号文章，题目是《先问清楚》。';
    const context = await saveMaterialAnalysisContext('run-a', { rawMaterial: material, files: [], links: [] });
    const saved = await saveProductionDraft({ ...request, state: {
      ...request.state, materialText: material, materialFiles: [], materialLinks: [],
      draft: { ...request.state.draft, writingMode: 'author_material', topic: '先问清楚' },
    } });
    return { saved, context };
  }

  it('reports the preflight blocker before any generation task exists and updates after configuration is supplied', async () => {
    const { saved } = await preparedAuthorDraft();
    const before = await readFile(join(fixture.root, 'sessions/material-analysis/run-a.json'), 'utf8');
    const fetch = vi.fn(() => { throw new Error('Listing must only read local state'); });
    vi.stubGlobal('fetch', fetch);
    expect((await listProductionDrafts()).items.find((item) => item.id === saved.id)?.progress).toMatchObject({ label: '等你完成模型连接' });
    fixture.model = 'test-model'; fixture.key = 'test-only-key';
    expect((await listProductionDrafts()).items.find((item) => item.id === saved.id)?.progress).toMatchObject({ label: '素材已整理，待确认' });
    expect(await readFile(join(fixture.root, 'sessions/material-analysis/run-a.json'), 'utf8')).toBe(before);
    await expect(readFile(join(fixture.root, 'runs/run-a/tasks'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not treat cached analysis as evidence, or a changed input as the analysed draft', async () => {
    const { saved } = await preparedAuthorDraft();
    const changed = await saveProductionDraft({ id: saved.id, expectedVersion: saved.version, name: saved.name,
      state: { ...saved.state, materialText: '另一份素材', materialAnalysisStale: false } });
    expect((await listProductionDrafts()).items.find((item) => item.id === changed.id)?.progress?.label).toBe('素材有更改，待重新整理');
    await rm(join(fixture.root, 'sessions/material-analysis/run-a.json'));
    expect((await listProductionDrafts()).items.find((item) => item.id === changed.id)?.progress?.label).toBe('内容任务已创建');
  });

  it('keeps research preparation independent of model setup and requests a missing author title first', async () => {
    const { saved } = await preparedAuthorDraft();
    const research = await saveProductionDraft({ id: saved.id, expectedVersion: saved.version, name: saved.name,
      state: { ...saved.state, draft: { ...(saved.state.draft as object), writingMode: 'platform' } } });
    expect((await listProductionDrafts()).items.find((item) => item.id === research.id)?.progress).toMatchObject({ label: '素材已整理，待确认' });
    const noTitle = await saveProductionDraft({ id: saved.id, expectedVersion: research.version, name: saved.name,
      state: { ...saved.state, draft: { ...(saved.state.draft as object), writingMode: 'author_material', topic: '' } } });
    expect((await listProductionDrafts()).items.find((item) => item.id === noTitle.id)?.progress?.label).toBe('素材已整理，待填写题目');
  });

  async function blockedTask(changes: Record<string, unknown> = {}) {
    const path = join(fixture.root, 'runs/run-a/tasks/task_setup.json');
    await mkdir(join(fixture.root, 'runs/run-a/tasks'), { recursive: true });
    await writeFile(path, JSON.stringify({
      schema: 'aifios.production-task.v1', taskId: 'task_setup', runId: 'run-a', kind: 'author-blueprint',
      status: 'blocked', currentStep: 'content-blueprint', steps: [],
      request: { slug: 'topic-a', topic: '客户问题' }, result: {},
      error: { code: 'model_setup_required', message: '模型设置缺失' },
      startedAt: '2026-09-20T10:00:00Z', updatedAt: '2026-09-20T10:01:00Z', ...changes,
    }));
    return path;
  }

  it('reports the same missing-model action as the durable task without resuming it or testing a connection', async () => {
    const path = await blockedTask();
    const taskBefore = await readFile(path, 'utf8');
    const { latestProductionTaskForRun } = await import('./production-tasks');
    const task = await latestProductionTaskForRun('run-a');
    expect(task?.taskId).toBe('task_setup');
    const { assertProductionTaskRunAuthority } = await import('./production-task-authority');
    await expect(assertProductionTaskRunAuthority(task!)).resolves.toMatchObject({ run_id: 'run-a' });
    const saved = await saveProductionDraft(input());
    const fetch = vi.fn(() => { throw new Error('A draft listing must not send a request'); });
    vi.stubGlobal('fetch', fetch);
    expect((await listProductionDrafts()).items.find((item) => item.id === saved.id)?.progress?.label).toBe('等你完成模型连接');
    fixture.model = 'test-model'; fixture.key = 'unit-test-only';
    const ready = (await listProductionDrafts()).items.find((item) => item.id === saved.id)?.progress;
    expect(ready?.label).toBe('可以继续本期');
    expect(ready?.nextStep).toContain('连接效果仍以实际请求为准');
    expect(await readFile(path, 'utf8')).toBe(taskBefore);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { runId: 'run-b' },
    { request: { slug: 'other-topic' } },
    { result: { materialResearch: { intakePath: 'pipeline/intake/obsolete.md' } } },
    { status: 'completed' },
    { error: { code: 'unrelated_failure' } },
  ])('does not treat a foreign, obsolete or finished task as the current connection blocker: %j', async (changes) => {
    await blockedTask(changes);
    const saved = await saveProductionDraft(input());
    expect((await listProductionDrafts()).items.find((item) => item.id === saved.id)?.progress?.label).toBe('内容任务已创建');
  });
  it('separates content modification from navigation saves, link enrichment and reads', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T10:00:00Z'));
    const request = input();
    const first = await saveProductionDraft(request);
    expect(first.modifiedAt).toBe(first.updatedAt);
    vi.setSystemTime(new Date('2026-09-20T11:00:00Z'));
    const navigation = await saveProductionDraft({ ...request, expectedVersion: 1, state: { ...request.state, activeStage: 'weekly-review', researchSubview: 'other' } });
    expect(navigation.updatedAt).not.toBe(first.updatedAt);
    expect(navigation.modifiedAt).toBe(first.modifiedAt);
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    const enrichment = await saveProductionDraft({ ...request, expectedVersion: 2, state: { ...navigation.state, materialLinks: [{ url: 'https://example.com/source', title: '自动读取的网页名称', status: 'parsed' }], topicResearch: { fetchedAt: 'now' } } });
    expect(enrichment.modifiedAt).toBe(first.modifiedAt);
    const file = join(fixture.root, 'sessions/workbench-drafts', `${request.id}.json`);
    const beforeRead = await readFile(file, 'utf8');
    await readProductionDraft(request.id);
    await listProductionDrafts();
    expect(await readFile(file, 'utf8')).toBe(beforeRead);
    vi.setSystemTime(new Date('2026-09-20T13:00:00Z'));
    const edited = await saveProductionDraft({ ...request, expectedVersion: 3, state: { ...enrichment.state, materialText: '增加真实经历' } });
    expect(edited.modifiedAt).toBe('2026-09-20T13:00:00.000Z');
    expect(edited.updatedAt).toBe(edited.modifiedAt);
  });
  it('counts corrected writing requirements as content but ignores analysis source-reading metadata', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T10:00:00Z'));
    const request = input();
    const initial = { ...request.state, materialAnalysis: { summary: '文章摘要', authorRequirements: ['平实一点'], sources: [{ status: 'pending' }] } };
    const first = await saveProductionDraft({ ...request, state: initial });
    vi.setSystemTime(new Date('2026-09-20T11:00:00Z'));
    const metadata = await saveProductionDraft({ ...request, expectedVersion: 1, state: { ...initial, materialAnalysis: { ...initial.materialAnalysis, sources: [{ status: 'read' }] } } });
    expect(metadata.modifiedAt).toBe(first.modifiedAt);
    const edited = await saveProductionDraft({ ...request, expectedVersion: 2, state: { ...initial, materialAnalysis: { ...initial.materialAnalysis, authorRequirements: ['不引导私信'] } } });
    expect(edited.modifiedAt).toBe('2026-09-20T11:00:00.000Z');
  });
  it('keeps unknown modification times on legacy records until content changes', async () => {
    const request = input();
    const saved = await saveProductionDraft(request);
    delete saved.modifiedAt;
    await writeFile(join(fixture.root, 'sessions/workbench-drafts', `${saved.id}.json`), JSON.stringify(saved));
    const navigation = await saveProductionDraft({ ...request, expectedVersion: 1, state: { ...request.state, activeStage: 'weekly-review' } });
    expect(navigation.modifiedAt).toBe('');
    expect((await listProductionDrafts()).items[0].modifiedAt).toBe('');
    const renamed = await saveProductionDraft({ ...request, expectedVersion: 2, name: '作者新名称' });
    expect(renamed.modifiedAt).toBe(renamed.updatedAt);
  });
  it('uses each draft own material, task and verified artifact without borrowing active progress', async () => {
    const first = input();
    await saveProductionDraft({ ...first, state: { ...first.state, activeStage: 'weekly-review' } });
    const body = '第二份草稿正文';
    const path = 'pipeline/package/b.md';
    await mkdir(join(fixture.root, 'pipeline/package'), { recursive: true });
    await writeFile(join(fixture.root, path), body);
    await writeFile(join(fixture.root, 'runs/run-b.json'), JSON.stringify({ run_id: 'run-b', slug: 'topic-b', topic: '另一份题目', status: 'active', selected_platforms: ['xiaohongshu'], phase_artifacts: { content_package: { path, sha256: createHash('sha256').update(body).digest('hex') } } }));
    await mkdir(join(fixture.root, 'sessions'), { recursive: true });
    await writeFile(join(fixture.root, 'sessions/latest.json'), JSON.stringify({ active_run_id: 'run-b' }));
    const rows = (await listProductionDrafts()).items;
    expect(rows.find((row) => row.id === first.id)).toMatchObject({ excerpt: '完整素材 最后一行也保留。', platforms: ['wechat'], progress: { label: '内容任务已创建' } });
    expect(rows.find((row) => row.id === 'run:run-b')).toMatchObject({ excerpt: '题目：另一份题目', platforms: ['xiaohongshu'], progress: { label: '正文文件已保存' } });
    expect(JSON.stringify(rows)).not.toContain('已完成');
  });
  it.each(['missing', 'hash-mismatch', 'symlink', 'shared'])('reports unknown progress for %s artifact evidence', async (kind) => {
    const body = '保留正文';
    const path = 'pipeline/package/article.md';
    await mkdir(join(fixture.root, 'pipeline/package'), { recursive: true });
    if (kind !== 'missing') await writeFile(join(fixture.root, path), body);
    if (kind === 'symlink') {
      await rm(join(fixture.root, path));
      await symlink(join(fixture.root, 'runs/run-a.json'), join(fixture.root, path));
    }
    if (kind === 'shared') await writeFile(join(fixture.root, 'runs/run-b.json'), JSON.stringify({ run_id: 'run-b', slug: 'topic-b', status: 'active', steps: { package: { latest: path } } }));
    await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify({ run_id: 'run-a', slug: 'topic-a', status: 'active', project_id: 'default', phase_artifacts: { content_package: { path, sha256: kind === 'hash-mismatch' ? 'a'.repeat(64) : createHash('sha256').update(body).digest('hex') } } }));
    const request = input();
    await saveProductionDraft(request);
    expect((await listProductionDrafts()).items.find((row) => row.id === request.id)?.progress?.label).toBe('进度待核对');
  });
  it('shows stale material and missing or rebound runs instead of declaring progress from a saved stage', async () => {
    const request = input();
    await saveProductionDraft({ ...request, state: { ...request.state, materialAnalysisStale: true } });
    expect((await listProductionDrafts()).items[0].progress?.label).toBe('素材有更改，待重新整理');
    await saveProductionDraft({ ...request, expectedVersion: 1 });
    await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify({ run_id: 'run-a', slug: 'different', status: 'active' }));
    expect((await listProductionDrafts()).items[0].progress?.label).toBe('进度待核对');
    await rm(join(fixture.root, 'runs/run-a.json'));
    expect((await listProductionDrafts()).items[0].progress?.label).toBe('进度待核对');
  });
  it('distinguishes attachments and detached input from a generated result', async () => {
    const request = input();
    await saveProductionDraft({ ...request, state: { ...request.state, materialText: '', draft: { ...request.state.draft, runId: '', runSlug: '' } } });
    expect((await listProductionDrafts()).items.find((row) => row.id === request.id)).toMatchObject({ excerpt: '附件：笔记 · 1 条素材链接', progress: { label: '素材已保存' } });
    const listing = await GET(new NextRequest('http://localhost/api/production/drafts'));
    expect(listing.headers.get('cache-control')).toBe('no-store');
  });
});

describe('draft evidence boundary cases', () => {
  it('does not count restored default settings and empty notes as an author edit, but counts an explicit new template', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T10:00:00Z'));
    const request = input();
    const legacy = { ...request.state, draft: { ...request.state.draft, template: undefined, writingMode: undefined }, notes: {} };
    const first = await saveProductionDraft({ ...request, state: legacy });
    vi.setSystemTime(new Date('2026-09-21T10:00:00Z'));
    const restored = { ...legacy, draft: { ...legacy.draft, template: 'default', writingMode: 'platform' }, notes: { 'material-boundary': '' } };
    const navigated = await saveProductionDraft({ ...request, expectedVersion: first.version, state: restored });
    expect(navigated.modifiedAt).toBe(first.modifiedAt);
    expect(navigated.updatedAt).not.toBe(first.updatedAt);
    const edited = await saveProductionDraft({ ...request, expectedVersion: navigated.version, state: { ...restored, draft: { ...restored.draft, template: 'wechat-native' } } });
    expect(edited.modifiedAt).not.toBe(first.modifiedAt);
  });
  it('adds delivery filters only from this run current confirmations, preserving stored files and rejecting changed runs', async () => {
    const path = 'pipeline/package/article.md';
    const body = '仅用于草稿筛选测试的文章';
    const sha256 = createHash('sha256').update(body).digest('hex');
    await mkdir(join(fixture.root, 'pipeline/package'), { recursive: true });
    await writeFile(join(fixture.root, path), body);
    const runFile = join(fixture.root, 'runs/run-a.json');
    const run = JSON.parse(await readFile(runFile, 'utf8'));
    run.phase_artifacts = { content_package: { path, sha256 } };
    await writeFile(runFile, JSON.stringify(run));
    const saved = await saveProductionDraft(input());
    const savedFile = join(fixture.root, 'sessions/workbench-drafts', `${saved.id}.json`);
    const before = await readFile(savedFile, 'utf8');
    const flow: ProductionFlowIntegrity = { run_id: 'run-a', slug: 'topic-a', artifacts: {
      content_package: { path, sha256, exists: true }, draft_information: { path: 'pipeline/queue/a.json', sha256, exists: true },
    }, approvals: {
      content_package: { approved: true, path, sha256 }, draft_information: { approved: true, path: 'pipeline/queue/a.json', sha256 },
    }, draft_queue: { path: '', total: 1, status_counts: {}, lineage_current: true, complete: true }, publication: { ledger_path: '', records: 0, confirmed: 0, complete: false },
      current_phase: { id: 'draft_information', number: 5 }, invalidations: [], weekly_review: { status: 'pending', missing_metrics: 0, memory_applied: false },
      resolved_paths: { package_path: '', deliverables_path: '', visual_manifest_path: '', draft_queue_path: '', publication_ledger_path: '' },
      recovery: { persistent_tasks: true, write_locking: true, idempotency_supported: true },
    };
    const integrity = await import('./production-integrity');
    const read = vi.spyOn(integrity, 'buildProductionFlowIntegrity').mockResolvedValue(flow);
    expect((await listProductionDrafts()).items[0]).toMatchObject({ topic: '客户问题', status: 'ready' });
    flow.publication.confirmed = 1;
    expect((await listProductionDrafts()).items[0]).toMatchObject({ status: 'published', progress: { label: '部分成品已有发布记录' } });
    flow.draft_queue.lineage_current = false;
    expect((await listProductionDrafts()).items[0].status).toBe('pending');
    read.mockImplementation(async () => { await writeFile(runFile, JSON.stringify({ ...run, updated_at: '2026-10-01T00:00:00Z' })); return flow; });
    expect((await listProductionDrafts()).items[0].status).toBe('unknown');
    expect(await readFile(savedFile, 'utf8')).toBe(before);
  });
  it('does not let navigation-only saves move a known draft above later content edits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-20T10:00:00Z'));
    const first = input();
    await saveProductionDraft(first);
    vi.setSystemTime(new Date('2026-09-20T11:00:00Z'));
    const second = input();
    await saveProductionDraft({ ...second, name: '后来编辑的草稿' });
    vi.setSystemTime(new Date('2026-09-20T12:00:00Z'));
    await saveProductionDraft({ ...first, expectedVersion: 1, state: { ...first.state, activeStage: 'weekly-review' } });
    const rows = (await listProductionDrafts()).items;
    expect(rows.map((row) => row.id)).toEqual([second.id, first.id]);
  });
  it('rejects parent-directory symlinks and path traversal without losing the draft from the list', async () => {
    const request = input();
    await saveProductionDraft(request);
    const external = join(fixture.root, 'external');
    await mkdir(external, { recursive: true });
    await writeFile(join(external, 'article.md'), '保留');
    await mkdir(join(fixture.root, 'pipeline'), { recursive: true });
    await symlink(external, join(fixture.root, 'pipeline/package'));
    for (const path of ['pipeline/package/article.md', 'pipeline/../external/article.md']) {
      await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify({ run_id: 'run-a', slug: 'topic-a', status: 'active', steps: { package: { latest: path } } }));
      const result = await listProductionDrafts();
      expect(result.unreadable).toBe(0);
      expect(result.items.find((row) => row.id === request.id)?.progress?.label).toBe('进度待核对');
    }
  });
  it('keeps a malformed artifact pointer visible as unknown instead of misclassifying the saved draft as unreadable', async () => {
    const request = input();
    await saveProductionDraft(request);
    await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify({ run_id: 'run-a', slug: 'topic-a', status: 'active', phase_artifacts: { content_package: { path: { bad: true } } }, history: { bad: true } }));
    const result = await listProductionDrafts();
    expect(result.unreadable).toBe(0);
    expect(result.items.find((row) => row.id === request.id)?.progress?.label).toBe('进度待核对');
  });
});

it('does not choose an older registered body when the same run points at a newer body', async () => {
  const request = input();
  await saveProductionDraft(request);
  await mkdir(join(fixture.root, 'pipeline/package'), { recursive: true });
  await writeFile(join(fixture.root, 'pipeline/package/old.md'), '旧正文');
  await writeFile(join(fixture.root, 'pipeline/package/new.md'), '新正文');
  await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify({ run_id: 'run-a', slug: 'topic-a', status: 'active', phase_artifacts: { content_package: { path: 'pipeline/package/old.md' } }, steps: { package: { latest: 'pipeline/package/new.md' } } }));
  expect((await listProductionDrafts()).items.find((row) => row.id === request.id)?.progress?.label).toBe('进度待核对');
});
