import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  root: `/tmp/echo-content-revisions-${process.pid}`,
  completion: vi.fn(),
  blocked: false,
  lostSaveResponse: false,
  writes: 0,
  mutatePlanOnSave: false,
  compareReview: false,
}));
vi.mock('server-only', () => ({}));
vi.mock('./project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('./project-root', async (original) => {
  const actual = await original<typeof import('./project-root')>();
  return { ...actual, PROJECT_DIR: fixture.root, projectPath: (...parts: string[]) => join(fixture.root, ...parts) };
});
vi.mock('./server-config', () => ({ resolveServerLLMConfig: async () => ({ provider: 'test', model: 'test-model', apiKey: 'test-only' }) }));
vi.mock('./llm-client', () => ({ validateLLMConfig: () => [], getApiKey: () => 'test-only', createLLMTextCompletion: fixture.completion }));
vi.mock('./content-release-gate', () => ({ runContentReleaseGate: async (body: string) => ({
  status: fixture.blocked ? 'blocked' : 'pass', repaired: false, repairedBody: body,
  blocking_issues: fixture.blocked ? ['正文缺少必要内容。'] : [], review_issues: fixture.compareReview ? [`公众号正文当前约 ${body.length} 字；请按本篇要求核对。`, ...(body.includes('新结尾待核对') ? ['新结尾待核对来源'] : [])] : [], units: [],
}) }));
vi.mock('./runtime-writer', () => ({ writeRuntimeOutput: async (
  _step: string, _slug: string, body: string, source: string, runId: string, expected: { path: string; sha256: string; blueprint?: { path: string; sha256: string } },
) => withProjectWriteLock(`test-runtime:${runId}`, async () => {
  const run = await readRun(runId);
  if (fixture.mutatePlanOnSave && expected.blueprint) {
    await writeFile(join(fixture.root, expected.blueprint.path), '# saved between client check and runtime lock');
    fixture.mutatePlanOnSave = false;
  }
  if (expected.blueprint && (run.steps.blueprint?.latest !== expected.blueprint.path
    || hash(await readFile(join(fixture.root, expected.blueprint.path), 'utf8')) !== expected.blueprint.sha256)) {
    throw new Error('带入的写作方案已经更新');
  }
  const current = run.steps.package?.latest || '';
  const raw = current ? await readFile(join(fixture.root, current), 'utf8') : '';
  if (current !== expected.path || (current && hash(raw) !== expected.sha256)) throw new Error('原稿已经变化');
  const path = `pipeline/package/${++fixture.writes}.md`;
  await writeFile(join(fixture.root, path), `---\nsource: ${source}\n---\n\n${body}\n`);
  run.steps.package = { latest: path };
  run.history.push({ step: 'package', path });
  await writeFile(join(fixture.root, 'runs', `${runId}.json`), JSON.stringify(run));
  if (fixture.lostSaveResponse) { fixture.lostSaveResponse = false; throw new Error('response lost after runtime committed'); }
  return path;
}) }));

import { withProjectWriteLock } from './write-guard';
import { adoptContentRevision, saveRevisionToDraft, archiveContentRevision, createContentRevision, getContentRevision, getContentRevisionSource, listContentRevisions, scheduleContentRevision, type ContentRevision } from './content-revisions';
import { GET, POST } from '@/app/api/production/content-revisions/route';
import { contentAttemptSource, beginContentAttempt, checkpointContentAttempt, finishContentAttempt, getContentAttempt, contentAttemptPath, listContentAttempts } from './content-attempts';
import { GET as getAttempts } from '@/app/api/production/content-attempts/route';
import { attachContentPlan } from './content-plan';
import { applyWritingBrief } from './writing-brief';
import { inspectPublishingSections } from './content-editing';

const body = '# 内容\n\n## 0. 共享事实底稿\n事实不能变。\n\n## 1. 公众号原生长文\n- 发布标题：客户的问题\n\n### 正文\n开头保留。\n\n方法保留。\n\n这是旧结尾。\n\n### 评论区承接\n评论区原文。';
const raw = `---\nsource: original\n---\n\n${body}\n`;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const newId = () => `rev_${randomUUID().replaceAll('-', '')}`;
const readRun = async (id = 'run-a') => JSON.parse(await readFile(join(fixture.root, 'runs', `${id}.json`), 'utf8'));
const request = (extra = {}) => ({
  runId: 'run-a', id: newId(), basePath: 'pipeline/package/original.md', baseSha256: hash(raw),
  target: { sectionId: 'wechat:正文', scope: 'ending' as const }, mode: 'manual' as const,
  replacement: '先记下今天被问到的那个问题。', ...extra,
});
const settle = async (id: string) => {
  let record: ContentRevision | null = null;
  await vi.waitFor(async () => {
    record = await getContentRevision('run-a', id);
    expect(['queued', 'running']).not.toContain(record?.status);
  });
  return record!;
};

describe('reader findings use a specific occurrence and immutable source', () => {
  it('saves inherited and new checks separately without changing adoption blockers or the original', async () => {
    fixture.compareReview = true;
    fixture.blocked = true;
    try {
      const input = request({ replacement: '新结尾待核对。' });
      await createContentRevision(input); scheduleContentRevision(input.runId, input.id);
      const result = await settle(input.id);
      expect(result.status).toBe('needs_work');
      expect(result.reviewComparison?.existingIssues).toEqual(['正文缺少必要内容。']);
      expect(result.reviewComparison?.existingWarnings).toHaveLength(1);
      expect(result.reviewComparison?.newWarnings).toEqual(['新结尾待核对来源']);
      await expect(adoptContentRevision('run-a', input.id)).rejects.toThrow();
      expect(await readFile(join(fixture.root, 'pipeline/package/original.md'), 'utf8')).toBe(raw);
      expect(fixture.completion).not.toHaveBeenCalled();
    } finally { fixture.compareReview = false; }
  });
  it('preserves the first repeated sentence while previewing, adopting and undoing the second through the route', async () => {
    const sentence = '素材提供者提出，先记录客户的问题。';
    const repeated = raw.replace('方法保留。', `${sentence}\n\n中间不变。${sentence}`);
    await writeFile(join(fixture.root, 'pipeline/package/original.md'), repeated);
    const issue = inspectPublishingSections(repeated)[1];
    const response = await POST(new NextRequest('http://localhost/api/production/content-revisions', {
      method: 'POST', body: JSON.stringify(request({ action: 'create', baseSha256: hash(repeated),
        target: { sectionId: issue.sectionId, scope: 'selection', selection: issue.quote, selectionOffset: issue.selectionOffset },
        replacement: '先把问题记下来。' })),
    }));
    expect(response.status).toBe(202);
    const { revision } = await response.json();
    expect(revision.target.selectionOffset).toBe(issue.selectionOffset);
    expect((await settle(revision.id)).status).toBe('ready');
    const adopted = await adoptContentRevision('run-a', revision.id);
    const candidate = await readFile(join(fixture.root, adopted.adoptedPath!), 'utf8');
    expect(candidate).toContain(`${sentence}\n\n中间不变。先把问题记下来。`);
    expect(candidate).toContain('评论区原文。');
    expect(await readFile(join(fixture.root, 'pipeline/package/original.md'), 'utf8')).toBe(repeated);
    const undone = await adoptContentRevision('run-a', revision.id, true);
    expect(await readFile(join(fixture.root, undone.revertedPath!), 'utf8')).toContain(`${sentence}\n\n中间不变。${sentence}`);
    expect(fixture.completion).not.toHaveBeenCalled();
  });
  it('rejects malformed positions and a stale file before creating a revision or calling a model', async () => {
    for (const target of [
      { sectionId: 'wechat:正文', scope: 'selection', selection: '开头保留。', selectionOffset: -1 },
      { sectionId: 'wechat:正文', scope: 'selection', selection: '开头保留。', selectionOffset: '0' },
      { sectionId: 'wechat:正文', scope: 'selection', selection: '开头保留。', selectionOffset: 0.5 },
      { sectionId: 'wechat:正文', scope: 'selection', selection: '开头保留。', selectionOffset: 3 },
      { sectionId: 'wechat:正文', scope: 'ending', selectionOffset: 0 },
    ]) {
      const response = await POST(new NextRequest('http://localhost/api/production/content-revisions', { method: 'POST', body: JSON.stringify(request({ action: 'create', mode: 'model', instruction: '改自然', target })) }));
      expect(response.status).toBe(400);
    }
    await writeFile(join(fixture.root, 'pipeline/package/original.md'), raw + '\n文件已改变');
    await expect(createContentRevision(request({ target: { sectionId: 'wechat:正文', scope: 'selection', selection: '开头保留。', selectionOffset: 0 } }))).rejects.toThrow('原稿内容已变化');
    expect(await listContentRevisions('run-a')).toEqual([]);
    expect(fixture.completion).not.toHaveBeenCalled();
  });
});
const ready = async () => {
  const input = request();
  await createContentRevision(input);
  scheduleContentRevision(input.runId, input.id);
  return settle(input.id);
};

async function failedAttempt(firstDraft = false) {
  await mkdir(join(fixture.root, 'pipeline/blueprint'), { recursive: true });
  await writeFile(join(fixture.root, 'pipeline/blueprint/plan.md'), '# 已确认方案');
  const run = await readRun();
  run.steps.blueprint = { latest: 'pipeline/blueprint/plan.md' };
  if (firstDraft) delete run.steps.package;
  await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify(run));
  const record = await beginContentAttempt('run-a', { path: 'pipeline/blueprint/plan.md', sha256: hash('# 已确认方案') }, 'fixture', 'simulated');
  await checkpointContentAttempt(record, body);
  await finishContentAttempt(record, body, { reason: '模拟：未完成', code: 'fixture_incomplete', issues: ['缺少收尾说明。'] });
  return record;
}

describe('retained initial generation and scoped recovery', () => {
  it('reviews explicit requirements even when the material never needed a manual correction', async () => {
    const { saveMaterialAnalysisContext } = await import('./material-analysis');
    await saveMaterialAnalysisContext('run-a', { rawMaterial: '写作要求：口播250至350字；结尾只问一个具体问题。' });
    await writeFile(join(fixture.root, 'pipeline/package/original.md'), '## 3. 视频号原生口播\n- 发布标题：测试\n### 逐句口播稿\n只有这一句。\n### 镜头清单\n正面口播。');
    const source = await getContentRevisionSource('run-a');
    expect(source.writingReview.findings.map((finding) => finding.kind)).toEqual(['length', 'ending']);
    expect(source.writingReview.characterCount).toBe(6);
  });
  it('saves successive unfinished edits, rejects stale windows, and explicitly promotes only the latest complete draft', async () => {
    const attempt = await failedAttempt(true);
    fixture.blocked = true;
    const source = await getContentRevisionSource('run-a', attempt.id);
    const edit = async (base: typeof source, replacement: string) => {
      const revision = await createContentRevision({ runId: 'run-a', id: newId(), basePath: base.path, baseSha256: base.sha256, recoveryId: attempt.id, mode: 'manual', target: { sectionId: 'wechat:正文', scope: 'ending' }, replacement });
      scheduleContentRevision('run-a', revision.id); return settle(revision.id);
    };
    const first = await edit(source, '先保存这一句。');
    const stale = await edit(source, '旧窗口不应覆盖。');
    expect(first.status).toBe('needs_work');
    await expect(saveRevisionToDraft('run-a', first.id, 1)).rejects.toThrow();
    expect(await saveRevisionToDraft('run-a', first.id)).toMatchObject({ status: 'saved_draft', savedDraftVersion: 1 });
    await saveRevisionToDraft('run-a', first.id); // Lost-response retry does not increment the version.
    await expect(saveRevisionToDraft('run-a', stale.id)).rejects.toThrow('已在别处修改');
    await expect(adoptContentRevision('run-a', first.id)).rejects.toThrow('不完整');
    const reopened = await getContentRevisionSource('run-a', attempt.id);
    expect(reopened).toMatchObject({ draftVersion: 1, remainingIssues: ['正文缺少必要内容。'] });
    expect(reopened.sections.find((section) => section.id === 'wechat:正文')?.text).toContain('先保存这一句。');
    expect((await getContentAttempt('run-a', attempt.id))?.body).toBe(body);
    expect((await readRun()).steps.package).toBeUndefined();
    fixture.blocked = false;
    const second = await edit(reopened, '这次补齐后再核对。');
    await saveRevisionToDraft('run-a', second.id);
    expect(await getContentRevisionSource('run-a', attempt.id)).toMatchObject({ draftVersion: 2 });
    await expect(adoptContentRevision('run-a', first.id)).rejects.toThrow();
    expect(fixture.writes).toBe(0);
    const originalDownload = await getAttempts(new NextRequest(`http://localhost/api/production/content-attempts?runId=run-a&id=${attempt.id}&download=1`));
    expect((await originalDownload.text()).endsWith(body)).toBe(true);
    const currentDownload = await getAttempts(new NextRequest(`http://localhost/api/production/content-attempts?runId=run-a&id=${attempt.id}&download=1&working=1`));
    expect(await currentDownload.text()).toContain('这次补齐后再核对。');
    fixture.lostSaveResponse = true;
    const saved = await adoptContentRevision('run-a', second.id);
    expect(saved.status).toBe('adopted');
    await adoptContentRevision('run-a', second.id);
    expect(fixture.writes).toBe(1);
    expect(await readFile(join(fixture.root, saved.adoptedPath!), 'utf8')).toContain('这次补齐后再核对。');
    expect((await getContentAttempt('run-a', attempt.id))?.body).toBe(body);
    expect(fixture.completion).not.toHaveBeenCalled();
  });
  it('keeps the full failed body downloadable without attaching it to the run', async () => {
    const record = await failedAttempt(true);
    const full = body + '\n' + '尚未完成的长文。'.repeat(2_000);
    await finishContentAttempt(record, full, { reason: '模拟中断', code: 'fixture_interrupt' });
    const response = await getAttempts(new NextRequest(`http://localhost/api/production/content-attempts?runId=run-a&id=${record.id}&download=1`));
    const exported = await response.text();
    expect(exported).toContain('公开限制待核对');
    expect(exported.endsWith(full)).toBe(true);
    expect((await getContentAttempt('run-a', record.id))?.body).toBe(full);
    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect((await readRun()).steps.package).toBeUndefined();
    expect(fixture.completion).not.toHaveBeenCalled();
  });
  it('keeps a live attempt running and reconciles a dead worker without a model retry', async () => {
    const fixtureAttempt = await failedAttempt(true);
    const live = await beginContentAttempt('run-a', fixtureAttempt.plan, 'fixture', 'simulated');
    await checkpointContentAttempt(live, '收到的部分');
    expect((await getContentAttempt('run-a', live.id))?.status).toBe('generating');
    live.ownerPid = 2147483647;
    await checkpointContentAttempt(live, '收到的部分');
    expect((await getContentAttempt('run-a', live.id))?.status).toBe('failed');
    expect((await getContentAttempt('run-a', live.id))?.body).toBe('收到的部分');
    expect(fixture.completion).not.toHaveBeenCalled();
    await finishContentAttempt(live, live.body, { reason: 'fixture cleanup', code: 'fixture' });
  });
  it('previews a supplement, preserves the original, and adopts a first draft only after explicit action', async () => {
    const record = await failedAttempt(true);
    const source = await getContentRevisionSource('run-a', record.id);
    const revision = await createContentRevision({ runId: 'run-a', id: newId(), basePath: source.path, baseSha256: source.sha256, recoveryId: record.id, mode: 'manual', target: { sectionId: 'recovery:append', scope: 'append' }, replacement: '### 补充说明\n方法也有适用边界。' });
    scheduleContentRevision('run-a', revision.id);
    expect((await settle(revision.id)).status).toBe('ready');
    expect((await readRun()).steps.package).toBeUndefined();
    const adopted = await adoptContentRevision('run-a', revision.id);
    const output = await readFile(join(fixture.root, adopted.adoptedPath!), 'utf8');
    expect(output).toContain(attachContentPlan(body, record.plan) + '\n\n### 补充说明\n方法也有适用边界。');
    expect((await getContentAttempt('run-a', record.id))?.body).toBe(body);
    expect((await getContentAttempt('run-a', record.id))?.status).toBe('saved');
    await adoptContentRevision('run-a', revision.id);
    expect(fixture.writes).toBe(1);
    await expect(adoptContentRevision('run-a', revision.id, true)).rejects.toThrow('不会还原为不完整稿件');
  });
  it('does not adopt an incomplete supplement or overwrite a newer plan/body', async () => {
    const record = await failedAttempt();
    const source = await getContentRevisionSource('run-a', record.id);
    const revision = await createContentRevision({ runId: 'run-a', id: newId(), basePath: source.path, baseSha256: source.sha256, recoveryId: record.id, mode: 'manual', target: { sectionId: 'recovery:append', scope: 'append' }, replacement: '还未补齐' });
    fixture.blocked = true;
    scheduleContentRevision('run-a', revision.id);
    expect((await settle(revision.id)).status).toBe('needs_work');
    await expect(adoptContentRevision('run-a', revision.id)).rejects.toThrow('还不能采用');
    expect(fixture.writes).toBe(0);
    await writeFile(join(fixture.root, 'pipeline/blueprint/plan.md'), '# 已修改方案');
    await expect(getContentRevisionSource('run-a', record.id)).rejects.toThrow('写作方案已变化');
    await writeFile(join(fixture.root, 'pipeline/blueprint/plan.md'), '# 已确认方案');
    await writeFile(join(fixture.root, 'pipeline/package/original.md'), raw + '新修改');
    await expect(getContentRevisionSource('run-a', record.id)).rejects.toThrow('已有更新的正文');
  });
  it('sends only one explicit supplement request and recovers a lost adoption response', async () => {
    const attempt = await failedAttempt(true);
    const source = await getContentRevisionSource('run-a', attempt.id);
    const input = { runId: 'run-a', id: newId(), action: 'create', basePath: source.path, baseSha256: source.sha256, recoveryId: attempt.id, mode: 'model', target: { sectionId: 'recovery:append', scope: 'append' }, instruction: '只补充缺少的收尾说明，不重复已有文字。' };
    fixture.completion.mockResolvedValue('### 补充说明\n先核对适用条件。');
    for (let count = 0; count < 2; count += 1) {
      const response = await POST(new NextRequest('http://localhost/api/production/content-revisions', { method: 'POST', body: JSON.stringify(input) }));
      expect(response.status).toBe(202);
    }
    expect((await settle(input.id)).status).toBe('ready');
    expect(fixture.completion).toHaveBeenCalledOnce();
    expect(fixture.completion.mock.calls[0][1][1].content).toContain('只返回需要追加的缺少部分');
    expect(fixture.completion.mock.calls[0][2].maxRetries).toBe(0);
    fixture.lostSaveResponse = true;
    const saved = await adoptContentRevision('run-a', input.id);
    expect(saved.status).toBe('adopted');
    expect((await getContentAttempt('run-a', attempt.id))?.savedPath).toBe(saved.adoptedPath);
    await adoptContentRevision('run-a', input.id);
    expect(fixture.writes).toBe(1);
  });
  it('recognizes a committed generation after its receipt was lost without redispatching', async () => {
    const attempt = await failedAttempt(true);
    const path = 'pipeline/package/committed.md';
    await writeFile(join(fixture.root, path), `---\nsource: ui-agent:content-package:${attempt.id}\n---\n\n${body}`);
    const run = await readRun(); run.steps.package = { latest: path };
    await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify(run));
    expect(await getContentAttempt('run-a', attempt.id)).toMatchObject({ status: 'saved', savedPath: path, body });
    expect(fixture.completion).not.toHaveBeenCalled();
    expect(fixture.writes).toBe(0);
  });
  it('rejects a linked attempt record and an append request on an ordinary article', async () => {
    const attempt = await failedAttempt();
    const path = join(fixture.root, contentAttemptPath('run-a', attempt.id));
    const outside = join(fixture.root, 'outside.json');
    await writeFile(outside, JSON.stringify(attempt));
    await rm(path);
    await symlink(outside, path);
    await expect(getContentAttempt('run-a', attempt.id)).rejects.toThrow('不能经过链接');
    const response = await POST(new NextRequest('http://localhost/api/production/content-revisions', { method: 'POST', body: JSON.stringify({ ...request(), action: 'create', target: { sectionId: 'recovery:append', scope: 'append' } }) }));
    expect(response.status).toBe(400);
    expect(fixture.writes).toBe(0);
  });
  it('rejects foreign records and traversal, and does not expose the worker process ID', async () => {
    const record = await failedAttempt();
    const response = await getAttempts(new NextRequest('http://localhost/api/production/content-attempts?runId=run-a'));
    const result = await response.json();
    expect(result.attempts[0]).not.toHaveProperty('ownerPid');
    await expect(getContentAttempt('run-a', '../other')).rejects.toThrow('编号');
    const file = join(fixture.root, contentAttemptPath('run-a', record.id));
    await writeFile(file, JSON.stringify({ ...record, runId: 'run-b' }));
    await expect(listContentAttempts('run-a')).rejects.toThrow('不一致');
  });
});

beforeEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
  await mkdir(join(fixture.root, 'pipeline/package'), { recursive: true });
  await mkdir(join(fixture.root, 'runs'), { recursive: true });
  await writeFile(join(fixture.root, 'pipeline/package/original.md'), raw);
  await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify({ run_id: 'run-a', slug: 'topic-a', steps: { package: { latest: 'pipeline/package/original.md' } }, history: [{ step: 'package', path: 'pipeline/package/original.md' }] }));
  fixture.blocked = false; fixture.lostSaveResponse = false; fixture.writes = 0; fixture.mutatePlanOnSave = false;
  fixture.completion.mockReset().mockResolvedValue('模型改好的结尾。');
});
afterAll(async () => { await rm(fixture.root, { recursive: true, force: true }); });
afterEach(async () => {
  await vi.waitFor(() => expect((globalThis as typeof globalThis & { echoContentRevisionJobs?: Map<string, Promise<void>> }).echoContentRevisionJobs?.size ?? 0).toBe(0));
});

describe('persistent content revisions', () => {
  async function setPlan(ending = '结尾只保留一个行动，不引导购买。', name = 'current.md') {
    const path = `pipeline/blueprint/${name}`;
    const brief = { audience: '小团队负责人', point: '先确认范围', structure: '经历、做法、收尾', ending };
    const raw = applyWritingBrief('# 写作方案', brief);
    await mkdir(join(fixture.root, 'pipeline/blueprint'), { recursive: true });
    await writeFile(join(fixture.root, path), raw);
    const run = await readRun(); run.steps.blueprint = { latest: path };
    await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify(run));
    return { path, sha256: hash(raw), brief, raw };
  }

  it('offers the current plan for explicit use and keeps normal editing available when it cannot be read', async () => {
    const unbound = await getContentRevisionSource('run-a');
    expect(unbound).toMatchObject({ path: request().basePath, planError: expect.any(String) });
    expect(unbound.sections).not.toHaveLength(0);
    const { raw: planRaw, ...plan } = await setPlan();
    expect(await getContentRevisionSource('run-a')).toMatchObject({ plan });
    const revision = await ready();
    expect(revision).not.toHaveProperty('planBinding');
    expect(revision).not.toHaveProperty('planBody');
    expect(planRaw).toContain('结尾只保留一个行动');
  });

  it('freezes only the explicitly selected plan, sends it to the model and omits its full body from the API', async () => {
    const plan = await setPlan();
    const input = { ...request(), mode: 'model' as const, instruction: plan.brief.ending, planBinding: { path: plan.path, sha256: plan.sha256 } };
    const created = await createContentRevision(input);
    expect(created).toMatchObject({ planBinding: input.planBinding, planBody: plan.raw, planBrief: plan.brief });
    scheduleContentRevision('run-a', input.id);
    expect((await settle(input.id)).status).toBe('ready');
    const sent = JSON.parse(fixture.completion.mock.calls[0][1][1].content);
    expect(sent.selectedPlan).toEqual({ ...input.planBinding, brief: plan.brief });
    expect(sent.selectedPlanRule).toContain('不能宣称整篇文章已经同步');
    const response = await GET(new NextRequest(`http://localhost/api/production/content-revisions?runId=run-a&id=${input.id}`));
    const presented = (await response.json()).revision;
    expect(presented.planBinding).toEqual(input.planBinding);
    expect(presented).not.toHaveProperty('planBody');
    await expect(createContentRevision({ ...input, planBinding: undefined })).rejects.toThrow('已绑定其他要求');
  });

  it('rejects stale plan requests before generation and detects same-path changes while queued', async () => {
    const plan = await setPlan();
    const input = { ...request(), mode: 'model' as const, instruction: '改结尾', planBinding: { path: plan.path, sha256: plan.sha256 } };
    await createContentRevision(input);
    await setPlan('请改成新的结尾');
    await expect(createContentRevision({ ...input, id: newId() })).rejects.toThrow('写作方案已经更新');
    scheduleContentRevision('run-a', input.id);
    const result = await settle(input.id);
    expect(result.status).toBe('failed');
    expect(result.issues.join(' ')).toContain('写作方案已经更新');
    expect(fixture.completion).not.toHaveBeenCalled();
    expect(fixture.writes).toBe(0);
  });

  it('retains model output but refuses a candidate when its plan changes during the request', async () => {
    const plan = await setPlan();
    let resolve!: (text: string) => void;
    fixture.completion.mockImplementation(() => new Promise<string>((done) => { resolve = done; }));
    const input = { ...request(), mode: 'model' as const, instruction: '只改最后一段', planBinding: { path: plan.path, sha256: plan.sha256 } };
    await createContentRevision(input); scheduleContentRevision('run-a', input.id);
    await vi.waitFor(() => expect(fixture.completion).toHaveBeenCalledOnce());
    await setPlan('换一个行动', 'next.md');
    resolve('先记录下一次改需求的原因。');
    const result = await settle(input.id);
    expect(result).toMatchObject({ status: 'failed', replacement: '先记录下一次改需求的原因。' });
    expect(result.issues.join(' ')).toContain('写作方案已经更新');
    await expect(adoptContentRevision('run-a', input.id)).rejects.toThrow('还不能采用');
    expect(fixture.completion).toHaveBeenCalledOnce();
    expect(fixture.writes).toBe(0);
  });

  it('rejects a ready plan-bound edit after either the plan path or bytes change, retaining the preview', async () => {
    const plan = await setPlan();
    const input = { ...request(), planBinding: { path: plan.path, sha256: plan.sha256 } };
    await createContentRevision(input); scheduleContentRevision('run-a', input.id);
    expect((await settle(input.id)).status).toBe('ready');
    await setPlan('新方案要求', 'next.md');
    await expect(createContentRevision(input)).rejects.toThrow('写作方案已经更新');
    await expect(adoptContentRevision('run-a', input.id)).rejects.toThrow('写作方案已经更新');
    expect((await getContentRevision('run-a', input.id))?.replacement).toBe(input.replacement);
    expect(fixture.writes).toBe(0);
  });

  it('passes the plan expectation through the final runtime save and preserves a rejected candidate', async () => {
    const plan = await setPlan();
    const input = { ...request(), planBinding: { path: plan.path, sha256: plan.sha256 } };
    await createContentRevision(input); scheduleContentRevision('run-a', input.id); await settle(input.id);
    fixture.mutatePlanOnSave = true;
    await expect(adoptContentRevision('run-a', input.id)).rejects.toThrow('写作方案已经更新');
    expect((await getContentRevision('run-a', input.id))).toMatchObject({ status: 'ready', replacement: input.replacement });
    expect(fixture.writes).toBe(0);
  });

  it('rejects an altered saved plan snapshot before using the model while retaining the author input', async () => {
    const plan = await setPlan();
    const input = { ...request(), mode: 'model' as const, instruction: '只改末尾', planBinding: { path: plan.path, sha256: plan.sha256 } };
    const record = await createContentRevision(input);
    await writeFile(join(fixture.root, `runs/run-a/content-revisions/${input.id}.json`), JSON.stringify({ ...record, planBody: `${plan.raw}\n被修改` }));
    scheduleContentRevision('run-a', input.id);
    const result = await settle(input.id);
    expect(result).toMatchObject({ status: 'failed', instruction: input.instruction });
    expect(result.issues.join(' ')).toContain('方案版本无法核对');
    expect(fixture.completion).not.toHaveBeenCalled();
    expect(fixture.writes).toBe(0);
  });

  it('preserves the full draft original plan when adopting a selected edit and when undoing after a later plan change', async () => {
    const oldBinding = { path: 'pipeline/blueprint/original.md', sha256: 'a'.repeat(64) };
    const markedBody = attachContentPlan(body, oldBinding);
    const markedRaw = `---\nsource: original\n---\n\n${markedBody}\n`;
    await writeFile(join(fixture.root, request().basePath), markedRaw);
    const plan = await setPlan();
    const input = { ...request(), baseSha256: hash(markedRaw), planBinding: { path: plan.path, sha256: plan.sha256 } };
    await createContentRevision(input); scheduleContentRevision('run-a', input.id); await settle(input.id);
    const adopted = await adoptContentRevision('run-a', input.id);
    const adoptedBody = await readFile(join(fixture.root, adopted.adoptedPath!), 'utf8');
    expect(adoptedBody).toContain(markedBody.replace('这是旧结尾。', input.replacement));
    expect(adoptedBody).not.toContain(plan.sha256);
    await setPlan('后续另一份方案');
    const undone = await adoptContentRevision('run-a', input.id, true);
    expect(await readFile(join(fixture.root, undone.revertedPath!), 'utf8')).toContain(markedBody);
    expect(fixture.completion).not.toHaveBeenCalled();
  });

  it('validates ending paragraph count and explicit plan bindings at the API boundary', async () => {
    const invalid = [
      { target: { sectionId: 'wechat:正文', scope: 'ending', endingParagraphs: 0 } },
      { target: { sectionId: 'wechat:正文', scope: 'ending', endingParagraphs: 1.5 } },
      { target: { sectionId: 'wechat:正文', scope: 'ending', endingParagraphs: '2' } },
      { target: { sectionId: 'wechat:正文', scope: 'selection', selection: '这是旧结尾。', endingParagraphs: 2 } },
      { planBinding: null }, { planBinding: {} },
      { planBinding: { path: '../other.md', sha256: 'a'.repeat(64) } },
    ];
    for (const extra of invalid) {
      const result = await POST(new NextRequest('http://localhost/api/production/content-revisions', { method: 'POST', body: JSON.stringify({ ...request(), ...extra, action: 'create' }) }));
      expect(result.status).toBe(400);
    }
    const response = await POST(new NextRequest('http://localhost/api/production/content-revisions', { method: 'POST', body: JSON.stringify({ ...request(), action: 'create', target: { sectionId: 'wechat:正文', scope: 'ending', endingParagraphs: 2 } }) }));
    expect(response.status).toBe(202);
    const record = (await response.json()).revision;
    expect(record.original).toBe('方法保留。\n\n这是旧结尾。');
    await settle(record.id);
  });

  async function correctMaterial() {
    const { saveMaterialAnalysisContext } = await import('./material-analysis');
    const base = await saveMaterialAnalysisContext('run-a', { rawMaterial: '作者要求：不引导销售。我的观点：先记录问题。' });
    const correctionId = 'correction_' + 'a'.repeat(32);
    const path = `runs/run-a/material-corrections/${correctionId}.json`;
    const text = JSON.stringify({ schema: 'echo.material-correction.v1', run_id: 'run-a', id: correctionId, input_fingerprint: base.inputFingerprint, created_at: 'now', analysis: { ...base.analysis, authorRequirements: ['结尾只写记录问题，不引导销售'] } });
    await mkdir(join(fixture.root, 'runs/run-a/material-corrections'), { recursive: true });
    await writeFile(join(fixture.root, path), text);
    const run = await readRun(); run.material_correction = { id: correctionId, path, sha256: hash(text) };
    await writeFile(join(fixture.root, 'runs/run-a.json'), JSON.stringify(run));
    return correctionId;
  }
  it('keeps an old candidate readable but rejects adopting it after material is corrected', async () => {
    const record = await ready();
    await correctMaterial();
    expect((await getContentRevision('run-a', record.id))?.replacement).toBe(record.replacement);
    await expect(adoptContentRevision('run-a', record.id)).rejects.toThrow('素材整理结果已经修正');
    expect(fixture.writes).toBe(0);
  });
  it('binds a new edit to the correction the editor actually reviewed and passes it to the model', async () => {
    const correctionId = await correctMaterial();
    await expect(createContentRevision(request())).rejects.toThrow('素材整理结果已经修正');
    const input = { ...request(), materialCorrectionId: correctionId, mode: 'model' as const, instruction: '改好结尾' };
    await createContentRevision(input); scheduleContentRevision('run-a', input.id);
    expect((await settle(input.id)).status).toBe('ready');
    expect(JSON.stringify(fixture.completion.mock.calls)).toContain('结尾只写记录问题，不引导销售');
  });
  it('blocks recovery of a failed generation based on superseded material while preserving its download', async () => {
    const attempt = await failedAttempt(true);
    await correctMaterial();
    await expect(contentAttemptSource('run-a', attempt.id)).rejects.toThrow('素材要求已修正');
    expect((await getContentAttempt('run-a', attempt.id))?.body).toBe(body);
  });

  it('exposes preview and current-version recovery through the API, omitting internal storage fields', async () => {
    const input = request();
    const response = await POST(new NextRequest('http://localhost/api/production/content-revisions', {
      method: 'POST', body: JSON.stringify({ ...input, action: 'create' }),
    }));
    expect(response.status).toBe(202);
    const { revision } = await response.json();
    expect(revision).not.toHaveProperty('baseBody');
    expect(revision).not.toHaveProperty('ownerPid');
    await settle(input.id);
    const adopted = await adoptContentRevision('run-a', input.id);
    const refreshed = await GET(new NextRequest('http://localhost/api/production/content-revisions?runId=run-a&path=pipeline/package/original.md'));
    expect(refreshed.status).toBe(200);
    expect((await refreshed.json()).source.path).toBe(adopted.adoptedPath);
  });

  it('rejects missing bodies and invalid scopes as input errors before creating a job', async () => {
    for (const value of [null, { ...request(), action: 'create', target: { scope: 'unknown' } }]) {
      const response = await POST(new NextRequest('http://localhost/api/production/content-revisions', { method: 'POST', body: JSON.stringify(value) }));
      expect(response.status).toBe(400);
    }
    expect(await listContentRevisions('run-a')).toEqual([]);
    expect(fixture.completion).not.toHaveBeenCalled();
  });
  it('previews without writing, adopts only the ending, and undoes to another version without deleting old files', async () => {
    const revision = await ready();
    expect(revision.status).toBe('ready');
    expect(fixture.writes).toBe(0);
    expect(fixture.completion).not.toHaveBeenCalled();
    const adopted = await adoptContentRevision('run-a', revision.id);
    const changed = await readFile(join(fixture.root, adopted.adoptedPath!), 'utf8');
    expect(changed.split('---\n\n')[1]).toBe(body.replace('这是旧结尾。', revision.replacement) + '\n');
    expect(await readFile(join(fixture.root, revision.basePath), 'utf8')).toBe(raw);
    expect((await getContentRevisionSource('run-a')).path).toBe(adopted.adoptedPath);
    await adoptContentRevision('run-a', revision.id);
    expect(fixture.writes).toBe(1);
    const reverted = await adoptContentRevision('run-a', revision.id, true);
    expect(await readFile(join(fixture.root, reverted.revertedPath!), 'utf8')).toContain(body);
    expect(await readFile(join(fixture.root, adopted.adoptedPath!), 'utf8')).toBe(changed);
    await adoptContentRevision('run-a', revision.id, true);
    expect(fixture.writes).toBe(2);
  });

  it('submits author instructions once and serves the same request while its model call is live', async () => {
    let resolve!: (value: string) => void;
    fixture.completion.mockImplementation(() => new Promise<string>((done) => { resolve = done; }));
    const input = { ...request(), mode: 'model' as const, instruction: '结尾只保留一句具体行动。' };
    await createContentRevision(input);
    scheduleContentRevision('run-a', input.id);
    await vi.waitFor(() => expect(fixture.completion).toHaveBeenCalledOnce());
    const duplicate = await createContentRevision(input);
    expect(duplicate.status).toBe('running');
    scheduleContentRevision('run-a', input.id);
    expect(fixture.completion.mock.calls[0][1][1].content).toContain(input.instruction);
    expect(fixture.completion.mock.calls[0][2].maxRetries).toBe(0);
    resolve('先记下今天被问到的那个问题。');
    expect((await settle(input.id)).status).toBe('ready');
    expect(fixture.completion).toHaveBeenCalledOnce();
    await expect(createContentRevision({ ...input, instruction: '另一条要求' })).rejects.toThrow('已绑定其他要求');
  });

  it('rejects stale candidates, changed bytes and a package from another run', async () => {
    const first = await ready();
    const second = await ready();
    const outcomes = await Promise.allSettled([adoptContentRevision('run-a', first.id), adoptContentRevision('run-a', second.id)]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(fixture.writes).toBe(1);
    const source = await getContentRevisionSource('run-a');
    await writeFile(join(fixture.root, source.path), 'externally changed');
    await expect(createContentRevision(request({ basePath: source.path, baseSha256: source.sha256 }))).rejects.toThrow('原稿内容已变化');
    await writeFile(join(fixture.root, 'runs/run-b.json'), JSON.stringify({ run_id: 'run-b', slug: 'topic-b', steps: { package: { latest: 'pipeline/package/b.md' } } }));
    await expect(createContentRevision(request({ runId: 'run-b' }))).rejects.toThrow('不属于这期内容');
  });

  it('keeps a failed candidate and concrete issues available, without adopting it', async () => {
    fixture.blocked = true;
    const revision = await ready();
    expect(revision.status).toBe('needs_work');
    expect(revision.replacement).toContain('先记下');
    expect(revision.issues).toContain('正文缺少必要内容。');
    await expect(adoptContentRevision('run-a', revision.id)).rejects.toThrow('还不能采用');
    expect((await listContentRevisions('run-a'))[0].replacement).toBe(revision.replacement);
    expect(fixture.writes).toBe(0);
  });

  it('recovers a committed save after a lost response without making a second version', async () => {
    const revision = await ready();
    fixture.lostSaveResponse = true;
    const saved = await adoptContentRevision('run-a', revision.id);
    expect(saved.status).toBe('adopted');
    expect(saved.adoptedPath).toBe((await readRun()).steps.package.latest);
    expect(fixture.writes).toBe(1);
  });

  it('marks a model job with no live handle interrupted and never redispatches it', async () => {
    const input = request();
    const record = await createContentRevision(input);
    const interrupted = { ...record, status: 'running', ownerPid: process.pid, dispatchedAt: new Date().toISOString(), mode: 'model' };
    await writeFile(join(fixture.root, `runs/run-a/content-revisions/${input.id}.json`), JSON.stringify(interrupted));
    expect((await getContentRevision('run-a', input.id))?.status).toBe('failed');
    scheduleContentRevision('run-a', input.id);
    await vi.waitFor(() => expect(fixture.completion).not.toHaveBeenCalled());
    expect((await getContentRevision('run-a', input.id))?.issues[0]).toContain('不会自动重复调用');
  });

  it('rejects symlinked source files and invalid selections before dispatch', async () => {
    await expect(createContentRevision(request({ target: { sectionId: 'wechat:正文', scope: 'selection', selection: '不存在的原文' } }))).rejects.toThrow('唯一定位');
    await rm(join(fixture.root, 'pipeline/package/original.md'));
    await symlink('/etc/hosts', join(fixture.root, 'pipeline/package/original.md'));
    await expect(createContentRevision(request())).rejects.toThrow('不能经过链接');
    expect(fixture.completion).not.toHaveBeenCalled();
  });
});


describe('candidate history and shelving', () => {
  async function ready() {
    const record = await createContentRevision(request());
    scheduleContentRevision('run-a', record.id);
    return settle(record.id);
  }
  const postAction = (id: string, action: string, expectedArchiveVersion?: unknown) => POST(new NextRequest('http://localhost/api/production/content-revisions', {
    method: 'POST', body: JSON.stringify({ runId: 'run-a', id, action, expectedArchiveVersion }),
  }));

  it('archives and restores through the API without changing the draft or dispatching a model', async () => {
    const record = await ready();
    const before = await readFile(join(fixture.root, 'runs/run-a.json'), 'utf8');
    const response = await postAction(record.id, 'archive', 0);
    expect(response.status).toBe(200);
    const { revision } = await response.json();
    expect(revision).toMatchObject({ status: 'ready', archiveVersion: 1, replacement: record.replacement });
    expect(revision.archivedAt).toBeTruthy();
    expect(revision.baseBody).toBeUndefined();
    expect(revision.ownerPid).toBeUndefined();
    expect((await postAction(record.id, 'adopt', 0)).status).toBe(409);
    expect((await postAction(record.id, 'adopt', 1)).status).toBe(409);
    const restored = await postAction(record.id, 'restore', 1);
    expect(restored.status).toBe(200);
    expect((await restored.json()).revision).toMatchObject({ status: 'ready', archiveVersion: 2 });
    expect((await getContentRevision('run-a', record.id))?.archivedAt).toBeUndefined();
    expect(await readFile(join(fixture.root, 'runs/run-a.json'), 'utf8')).toBe(before);
    expect(await readFile(join(fixture.root, 'pipeline/package/original.md'), 'utf8')).toBe(raw);
    expect(fixture.writes).toBe(0);
    expect(fixture.completion).not.toHaveBeenCalled();
    expect((await postAction(record.id, 'adopt', 0)).status).toBe(409);
    expect((await postAction(record.id, 'adopt', 2)).status).toBe(200);
    expect(fixture.writes).toBe(1);
  });

  it('recovers lost responses but rejects a delayed archive after restore and a delayed restore after re-archiving', async () => {
    const record = await ready();
    const archived = await archiveContentRevision('run-a', record.id, true, 0);
    expect(await archiveContentRevision('run-a', record.id, true, 0)).toEqual(archived);
    const restored = await archiveContentRevision('run-a', record.id, false, 1);
    expect(await archiveContentRevision('run-a', record.id, false, 1)).toEqual(restored);
    await expect(archiveContentRevision('run-a', record.id, true, 0)).rejects.toMatchObject({ status: 409 });
    await archiveContentRevision('run-a', record.id, true, 2);
    await expect(archiveContentRevision('run-a', record.id, false, 1)).rejects.toMatchObject({ status: 409 });
    expect((await getContentRevision('run-a', record.id))?.archiveVersion).toBe(3);
    expect(fixture.writes).toBe(0);
  });

  it('serializes archive against adopt so a shelved candidate cannot alter the article', async () => {
    const record = await ready();
    const results = await Promise.allSettled([
      archiveContentRevision('run-a', record.id, true, 0),
      adoptContentRevision('run-a', record.id),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const actual = (await getContentRevision('run-a', record.id))!;
    if (actual.archivedAt) { expect(actual.status).toBe('ready'); expect(fixture.writes).toBe(0); }
    else { expect(actual.status).toBe('adopted'); expect(fixture.writes).toBe(1); }
  });

  it('does not restore stale article authority along with a candidate', async () => {
    const record = await ready();
    await archiveContentRevision('run-a', record.id, true, 0);
    await writeFile(join(fixture.root, record.basePath), raw + '\n后来保存的内容。');
    await archiveContentRevision('run-a', record.id, false, 1);
    await expect(adoptContentRevision('run-a', record.id, false, 2)).rejects.toThrow('原稿内容已变化');
    expect(fixture.writes).toBe(0);
  });

  it('preserves generation state and rejects shelving an in-flight or committed version', async () => {
    const record = await ready();
    const path = join(fixture.root, 'runs/run-a/content-revisions', `${record.id}.json`);
    for (const status of ['ready', 'needs_work', 'failed'] as const) {
      await writeFile(path, JSON.stringify({ ...record, status }));
      const archived = await archiveContentRevision('run-a', record.id, true, 0);
      expect(archived.status).toBe(status);
      expect((await archiveContentRevision('run-a', record.id, false, 1)).status).toBe(status);
    }
    for (const status of ['queued', 'running', 'adopting', 'adopted', 'reverting', 'reverted'] as const) {
      await writeFile(path, JSON.stringify({ ...record, status }));
      await expect(archiveContentRevision('run-a', record.id, true, 0)).rejects.toMatchObject({ status: 409 });
    }
  });

  it('requires an exact version and safe ownership for metadata changes', async () => {
    const record = await ready();
    for (const version of [undefined, null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER]) {
      expect((await postAction(record.id, 'archive', version)).status).toBe(400);
    }
    await expect(archiveContentRevision('../run-a', record.id, true, 0)).rejects.toThrow('编号');
    await expect(archiveContentRevision('run-a', '../escape', true, 0)).rejects.toThrow('编号');
    await expect(archiveContentRevision('run-b', record.id, true, 0)).rejects.toThrow('不存在');
    const path = join(fixture.root, 'runs/run-a/content-revisions', `${record.id}.json`);
    await writeFile(path, JSON.stringify({ ...record, runId: 'run-b' }));
    await expect(archiveContentRevision('run-a', record.id, true, 0)).rejects.toThrow('不一致');
    for (const metadata of [{ archiveVersion: '1' }, { archiveVersion: -1 }, { archivedAt: 'unknown' }, { archivedAt: '2026-09-22T01:00:00Z', status: 'queued' }]) {
      await writeFile(path, JSON.stringify({ ...record, ...metadata }));
      await expect(archiveContentRevision('run-a', record.id, true, 0)).rejects.toThrow('暂存状态无法核对');
    }
    const outside = join(fixture.root, 'outside.json');
    await writeFile(outside, JSON.stringify(record));
    await rm(path); await symlink(outside, path);
    await expect(archiveContentRevision('run-a', record.id, true, 0)).rejects.toThrow('链接');
    expect(JSON.parse(await readFile(outside, 'utf8')).archivedAt).toBeUndefined();
  });

  it('returns history older than thirty records, including archived entries, without dispatching anything', async () => {
    const record = await ready();
    for (let index = 0; index < 36; index += 1) {
      const id = newId();
      await writeFile(join(fixture.root, 'runs/run-a/content-revisions', `${id}.json`), JSON.stringify({
        ...record, id, createdAt: new Date(Date.UTC(2025, 0, 1, 0, index)).toISOString(),
        ...(index === 0 ? { archivedAt: '2025-02-01T00:00:00Z', archiveVersion: 1 } : {}),
      }));
    }
    expect(await listContentRevisions('run-a')).toHaveLength(37);
    const response = await GET(new NextRequest('http://localhost/api/production/content-revisions?runId=run-a&path=pipeline/package/original.md'));
    const { revisions } = await response.json();
    expect(revisions).toHaveLength(37);
    expect(revisions.at(-1)).toMatchObject({ createdAt: '2025-01-01T00:00:00.000Z', archiveVersion: 1 });
    expect(revisions.every((item: Record<string, unknown>) => item.baseBody === undefined && item.planBody === undefined && item.ownerPid === undefined)).toBe(true);
    expect(fixture.completion).not.toHaveBeenCalled();
    expect(fixture.writes).toBe(0);
  });
});
