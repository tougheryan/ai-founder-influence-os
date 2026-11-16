import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductionFlowIntegrity } from './production-flow';

const fixture = vi.hoisted(() => ({
  root: `/tmp/echo-production-outcomes-${process.pid}`,
  flow: vi.fn(), downloads: vi.fn(), calls: vi.fn(), drafts: vi.fn(), queueLock: vi.fn(), writeLock: vi.fn(),
  activeQueueLocks: new Set<string>(),
}));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', () => ({ PROJECT_DIR: fixture.root }));
vi.mock('./production-integrity', () => ({ buildProductionFlowIntegrity: fixture.flow }));
vi.mock('./output-download-events', () => ({ listOutputDownloadEvents: fixture.downloads }));
vi.mock('./service-call-records', () => ({ readServiceCalls: fixture.calls }));
vi.mock('./production-drafts', () => ({ listProductionDrafts: fixture.drafts }));
vi.mock('./write-guard', () => ({ withProjectWriteLock: fixture.writeLock }));
vi.mock('./publish/draft-queue', () => ({
  queuePathForRun: (slug: string) => `materials/publication/drafts/${slug}/draft-queue.json`,
  withDraftQueueWriteLock: fixture.queueLock,
}));

import { listProductionOutcomes, readProductionOutcome, saveProductionOutcome } from './production-outcomes';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const queuePath = (runId = 'run-a') => `materials/publication/drafts/${runId}/draft-queue.json`;
const notePath = (runId = 'run-a') => join(fixture.root, `runs/${runId}/outcome.json`);
const flows = new Map<string, ProductionFlowIntegrity>();

async function put(path: string, value: unknown) {
  const target = join(fixture.root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}

function flowFor(runId: string): ProductionFlowIntegrity {
  const content = { path: `pipeline/package/${runId}.md`, sha256: sha(`${runId}:body`), exists: true, hash_matches_registered: true };
  const deliverables = { path: queuePath(runId), sha256: sha(`${runId}:queue-contract`), exists: true, hash_matches_registered: true };
  return {
    run_id: runId, slug: runId, target_platforms: ['wechat'],
    current_phase: { id: 'draft_information', number: 5 },
    artifacts: { content_package: content, draft_information: deliverables },
    approvals: {
      content_package: { approved: true, path: content.path, sha256: content.sha256 },
      draft_information: { approved: true, path: deliverables.path, sha256: deliverables.sha256 },
    },
    invalidations: [],
    draft_queue: { path: deliverables.path, total: 1, complete: true, lineage_current: true, status_counts: { pending: 1 } },
    publication: { ledger_path: `materials/publication/ledger/${runId}/publication-ledger.json`, records: 0, confirmed: 0, complete: false },
    weekly_review: { status: 'not_due', missing_metrics: 0, memory_applied: false },
    resolved_paths: { package_path: content.path, deliverables_path: '', visual_manifest_path: '', draft_queue_path: deliverables.path, publication_ledger_path: '' },
    recovery: { persistent_tasks: true, write_locking: true, idempotency_supported: true },
  };
}

async function createRun(runId = 'run-a', updatedAt = '2026-09-20T09:00:00.000Z') {
  await put(`runs/${runId}.json`, { run_id: runId, slug: runId, topic: `主题 ${runId}`, updated_at: updatedAt });
  flows.set(runId, flowFor(runId));
}

async function bumpRun(runId = 'run-a') {
  const path = `runs/${runId}.json`;
  const run = JSON.parse(await readFile(join(fixture.root, path), 'utf8'));
  await put(path, { ...run, revision: (run.revision || 0) + 1 });
}

async function command(action: 'save-note' | 'complete' = 'complete', runId = 'run-a') {
  const current = await readProductionOutcome(runId);
  return { runId, expectedVersion: current.note!.version, snapshot: current.snapshot, action };
}

async function tree(path = fixture.root): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      result[entry.name] = null;
      for (const [child, value] of Object.entries(await tree(join(path, entry.name)))) result[`${entry.name}/${child}`] = value;
    } else result[entry.name] = await readFile(join(path, entry.name), 'utf8');
  }
  return result;
}

beforeEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
  await mkdir(fixture.root, { recursive: true });
  flows.clear(); fixture.activeQueueLocks.clear();
  fixture.flow.mockReset().mockImplementation(async (run: { run_id: string }) => flows.get(run.run_id) || null);
  fixture.downloads.mockReset().mockResolvedValue({ items: [], unreadable: 0 });
  fixture.calls.mockReset().mockResolvedValue({ records: [] });
  fixture.drafts.mockReset().mockResolvedValue({ items: [] });
  fixture.writeLock.mockReset().mockImplementation(async (_key: string, task: () => Promise<unknown>) => task());
  fixture.queueLock.mockReset().mockImplementation(async (path: string, task: () => Promise<unknown>) => {
    fixture.activeQueueLocks.add(path);
    try { return await task(); } finally { fixture.activeQueueLocks.delete(path); }
  });
  await createRun();
});
afterAll(async () => { await rm(fixture.root, { recursive: true, force: true }); });

describe('production outcome evidence', () => {
  it('reads existing files without creating records, inferring time or claiming completion', async () => {
    const before = await tree();
    const item = await readProductionOutcome('run-a');
    expect(item).toMatchObject({ contentConfirmed: true, deliverablesConfirmed: true, currentCompletion: null,
      downloads: { count: 0, latestAt: '' }, modelCalls: 0, note: { version: 0, minutesSpent: null, reusedPreviousWork: null, completions: [] } });
    expect((await listProductionOutcomes()).items).toHaveLength(1);
    expect(await tree()).toEqual(before);
    expect(fixture.writeLock).not.toHaveBeenCalled();
    expect(fixture.queueLock).not.toHaveBeenCalled();
  });

  it('does not treat a locally adopted revision as whole-article author confirmation', async () => {
    await put('runs/run-a/content-revisions/adopted.json', { status: 'adopted', scope: 'ending', runId: 'run-a' });
    flows.get('run-a')!.approvals.content_package.approved = false;
    const current = await readProductionOutcome('run-a');
    expect(current.content).not.toBeNull();
    expect(current.contentConfirmed).toBe(false);
    expect(current.deliverablesConfirmed).toBe(false);
    await expect(saveProductionOutcome(await command())).rejects.toMatchObject({ status: 409 });
    await expect(readFile(notePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['body approval', 'deliverable approval', 'body hash', 'deliverable path', 'queue lineage', 'queue completeness', 'registered artifact'])(
    'cannot finish with missing or stale %s', async (failure) => {
      const flow = flows.get('run-a')!;
      if (failure === 'body approval') flow.approvals.content_package.approved = false;
      if (failure === 'deliverable approval') flow.approvals.draft_information.approved = false;
      if (failure === 'body hash') flow.approvals.content_package.sha256 = sha('old-body');
      if (failure === 'deliverable path') flow.approvals.draft_information.path = queuePath('old-run');
      if (failure === 'queue lineage') flow.draft_queue.lineage_current = false;
      if (failure === 'queue completeness') flow.draft_queue.complete = false;
      if (failure === 'registered artifact') flow.artifacts.draft_information!.hash_matches_registered = false;
      expect((await readProductionOutcome('run-a')).deliverablesConfirmed).toBe(false);
      await expect(saveProductionOutcome(await command())).rejects.toMatchObject({ status: 409 });
      await expect(readFile(notePath())).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('records the two confirmed artifact identities exactly once on repeated completion', async () => {
    const input = await command();
    const note = await saveProductionOutcome(input);
    const bytes = await readFile(notePath(), 'utf8');
    const current = await readProductionOutcome('run-a');
    expect(note.completions).toHaveLength(1);
    expect(note.completions[0]).toMatchObject({ content: current.content, deliverables: current.deliverables });
    expect(current.currentCompletion).toEqual(note.completions[0]);
    expect(await saveProductionOutcome(input)).toEqual(note);
    expect(await readFile(notePath(), 'utf8')).toBe(bytes);
    expect(await readdir(dirname(notePath()))).toEqual(['outcome.json']);
  });

  it.each(['content_package', 'draft_information'])('retains history when the current %s changes', async (scope) => {
    const first = await saveProductionOutcome(await command());
    const flow = flows.get('run-a')!;
    flow.artifacts[scope]!.sha256 = sha(`replacement:${scope}`);
    flow.approvals[scope].sha256 = flow.artifacts[scope]!.sha256;
    await bumpRun();
    const current = await readProductionOutcome('run-a');
    expect(current.deliverablesConfirmed).toBe(true);
    expect(current.currentCompletion).toBeNull();
    expect(current.note!.completions).toEqual(first.completions);
    const second = await saveProductionOutcome(await command());
    expect(second.completions).toHaveLength(2);
    expect(second.completions[0]).toEqual(first.completions[0]);
    expect((await readProductionOutcome('run-a')).currentCompletion).toEqual(second.completions[1]);
  });

  it('hides current completion when confirmation is invalidated without erasing its history', async () => {
    const saved = await saveProductionOutcome(await command());
    const bytes = await readFile(notePath(), 'utf8');
    flows.get('run-a')!.approvals.draft_information.approved = false;
    const current = await readProductionOutcome('run-a');
    expect(current.currentCompletion).toBeNull();
    expect(current.note!.completions).toEqual(saved.completions);
    expect(await readFile(notePath(), 'utf8')).toBe(bytes);
  });

  it('rechecks authoritative evidence while holding the existing queue lock before completion', async () => {
    const input = await command();
    const lockStates: boolean[] = [];
    fixture.flow.mockImplementation(async (run: { run_id: string }) => {
      lockStates.push(fixture.activeQueueLocks.has(queuePath(run.run_id)));
      return flows.get(run.run_id);
    });
    await saveProductionOutcome(input);
    expect(fixture.queueLock).toHaveBeenCalledWith(queuePath(), expect.any(Function));
    expect(lockStates).toContain(true);
    expect(fixture.activeQueueLocks.size).toBe(0);
  });

  it('locks the run slug queue when its slug differs from its record ID', async () => {
    const slug = 'article-topic';
    await put('runs/run-a.json', { run_id: 'run-a', slug, topic: '文章题目' });
    const flow = flows.get('run-a')!;
    flow.slug = slug;
    flow.artifacts.draft_information!.path = queuePath(slug);
    flow.approvals.draft_information.path = queuePath(slug);
    flow.draft_queue.path = queuePath(slug);
    flow.resolved_paths.draft_queue_path = queuePath(slug);
    await saveProductionOutcome(await command());
    expect(fixture.queueLock).toHaveBeenCalledWith(queuePath(slug), expect.any(Function));
    expect(JSON.parse(await readFile(notePath(), 'utf8')).runId).toBe('run-a');
  });

  it('rejects a queue approval withdrawn while completion waits for its lock', async () => {
    const input = await command();
    fixture.queueLock.mockImplementation(async (path: string, task: () => Promise<unknown>) => {
      flows.get('run-a')!.approvals.draft_information.approved = false;
      fixture.activeQueueLocks.add(path);
      try { return await task(); } finally { fixture.activeQueueLocks.delete(path); }
    });
    await expect(saveProductionOutcome(input)).rejects.toMatchObject({ status: 409 });
    await expect(readFile(notePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('counts download initiation only, never a prepared response or a published queue status', async () => {
    fixture.downloads.mockResolvedValue({ items: [
      { id: 'prepared', preparedAt: '2026-09-20T09:00:00.000Z' },
      { id: 'started-first', preparedAt: '2026-09-20T09:00:00.000Z', downloadStartedAt: '2026-09-20T09:01:00.000Z' },
      { id: 'started-last', preparedAt: '2026-09-20T09:02:00.000Z', downloadStartedAt: '2026-09-20T09:03:00.000Z' },
    ], unreadable: 1 });
    flows.get('run-a')!.publication = { ledger_path: '', records: 7, confirmed: 1, complete: false };
    const current = await readProductionOutcome('run-a');
    expect(current.downloads).toEqual({ count: 2, latestAt: '2026-09-20T09:03:00.000Z' });
    expect(current.publicationRecords).toBe(1);
    expect(current.warnings).toContain('1 条下载记录无法核对，未计入数量。');
    expect(current.currentCompletion).toBeNull();
  });

  it('reports unavailable evidence as unknown instead of a successful zero', async () => {
    fixture.downloads.mockRejectedValue(new Error('unreadable downloads'));
    fixture.calls.mockRejectedValue(new Error('unreadable model calls'));
    const current = await readProductionOutcome('run-a');
    expect(current.downloads).toBeNull(); expect(current.modelCalls).toBeNull();
    expect(current.warnings).toHaveLength(2);
  });
});

describe('author-entered notes and safe persistence', () => {
  it('treats a missing note in an existing run directory as an unwritten note', async () => {
    await put('runs/run-a/unrelated.json', { retained: true });
    const before = await tree();
    expect((await readProductionOutcome('run-a')).note).toMatchObject({ version: 0, completions: [] });
    expect(await tree()).toEqual(before);
  });

  it('saves explicit minutes, zero, false and empty values without deriving them from model usage', async () => {
    fixture.calls.mockResolvedValue({ records: [{ status: 'completed' }, { status: 'failed' }] });
    const first = await saveProductionOutcome({ ...await command('save-note'), minutesSpent: 37, reusedPreviousWork: true, note: '沿用了上期采访材料。' });
    expect(first).toMatchObject({ version: 1, minutesSpent: 37, reusedPreviousWork: true, note: '沿用了上期采访材料。', completions: [] });
    const zero = await saveProductionOutcome({ ...await command('save-note'), minutesSpent: 0, reusedPreviousWork: false, note: '' });
    expect(zero).toMatchObject({ version: 2, minutesSpent: 0, reusedPreviousWork: false, note: '' });
    const empty = await saveProductionOutcome({ ...await command('save-note'), minutesSpent: null, reusedPreviousWork: null, note: '' });
    expect(empty).toMatchObject({ version: 3, minutesSpent: null, reusedPreviousWork: null, completions: [] });
    expect((await readProductionOutcome('run-a')).modelCalls).toBe(2);
    const stored = JSON.parse(await readFile(notePath(), 'utf8'));
    expect(stored).toMatchObject({ schema: 'echo.production-outcome.v1', runId: 'run-a', ...empty });
  });

  it('does not rewrite an unchanged note or discard completion history when notes change', async () => {
    const completed = await saveProductionOutcome(await command());
    const fields = { minutesSpent: 12, reusedPreviousWork: false, note: '已核对。' };
    const note = await saveProductionOutcome({ ...await command('save-note'), ...fields });
    expect(note.completions).toEqual(completed.completions);
    const bytes = await readFile(notePath(), 'utf8');
    expect(await saveProductionOutcome({ ...await command('save-note'), ...fields })).toEqual(note);
    expect(await readFile(notePath(), 'utf8')).toBe(bytes);
  });

  it.each([-1, 1.5, 100001, '12', undefined])('rejects invalid minutes %s without writing', async (minutesSpent) => {
    await expect(saveProductionOutcome({ ...await command('save-note'), minutesSpent, reusedPreviousWork: null, note: '' })).rejects.toMatchObject({ status: 400 });
    await expect(readFile(notePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects non-string actions instead of advancing the record version', async () => {
    await expect(saveProductionOutcome({ ...await command(), action: ['complete'] })).rejects.toMatchObject({ status: 400 });
    await expect(readFile(notePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['broken JSON', 'foreign run', 'invalid completion'])('preserves an unreadable record: %s', async (failure) => {
    await saveProductionOutcome(await command());
    const stored = JSON.parse(await readFile(notePath(), 'utf8'));
    if (failure === 'foreign run') stored.runId = 'run-b';
    if (failure === 'invalid completion') stored.completions[0].content.sha256 = 'not-a-hash';
    await put('runs/run-a/outcome.json', failure === 'broken JSON' ? '{unfinished' : stored);
    const bytes = await readFile(notePath(), 'utf8');
    const current = await readProductionOutcome('run-a');
    expect(current.note).toBeNull(); expect(current.currentCompletion).toBeNull();
    expect(current.warnings).toContain('制作记录暂时无法读取。');
    await expect(saveProductionOutcome({ runId: 'run-a', snapshot: current.snapshot, expectedVersion: 0, action: 'save-note', minutesSpent: 10, reusedPreviousWork: null, note: '' })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(notePath(), 'utf8')).toBe(bytes);
  });

  it('does not read or overwrite a linked note as a local author record', async () => {
    await saveProductionOutcome(await command());
    const bytes = await readFile(notePath(), 'utf8');
    await put('outside-note.json', bytes);
    await rm(notePath());
    await symlink(join(fixture.root, 'outside-note.json'), notePath());
    const current = await readProductionOutcome('run-a');
    expect(current.note).toBeNull();
    await expect(saveProductionOutcome({ runId: 'run-a', snapshot: current.snapshot, expectedVersion: 1, action: 'complete' })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(join(fixture.root, 'outside-note.json'), 'utf8')).toBe(bytes);
  });

  it('does not mistake an unsafe run directory with no note for a new writable record', async () => {
    await mkdir(join(fixture.root, 'outside'), { recursive: true });
    await symlink(join(fixture.root, 'outside'), join(fixture.root, 'runs/run-a'));
    const current = await readProductionOutcome('run-a');
    expect(current.note).toBeNull();
    await expect(saveProductionOutcome({ runId: 'run-a', snapshot: current.snapshot, expectedVersion: 0, action: 'complete' })).rejects.toMatchObject({ status: 409 });
    expect(await readdir(join(fixture.root, 'outside'))).toEqual([]);
  });

  it('rejects stale note versions and run snapshots without overwriting newer records', async () => {
    const input = { ...await command('save-note'), minutesSpent: 18, reusedPreviousWork: null, note: 'first' };
    await saveProductionOutcome(input);
    const bytes = await readFile(notePath(), 'utf8');
    await expect(saveProductionOutcome({ ...input, note: 'stale edit' })).rejects.toMatchObject({ status: 409 });
    const current = await command('save-note');
    await bumpRun();
    await expect(saveProductionOutcome({ ...current, minutesSpent: 99, reusedPreviousWork: true, note: 'old draft' })).rejects.toMatchObject({ status: 409 });
    expect(await readFile(notePath(), 'utf8')).toBe(bytes);
  });

  it('rejects a run changed during evidence reading', async () => {
    fixture.flow.mockImplementationOnce(async (run: { run_id: string }) => { await bumpRun(run.run_id); return flows.get(run.run_id); });
    await expect(readProductionOutcome('run-a')).rejects.toMatchObject({ status: 409 });
    await expect(readFile(notePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps two runs independent and refuses a flow belonging to another run', async () => {
    await createRun('run-b');
    await saveProductionOutcome({ ...await command('save-note'), minutesSpent: 20, reusedPreviousWork: true, note: 'only A' });
    await saveProductionOutcome(await command());
    const other = await readProductionOutcome('run-b');
    expect(other.note).toMatchObject({ version: 0, minutesSpent: null, completions: [] });
    expect(other.currentCompletion).toBeNull();
    expect(fixture.downloads).toHaveBeenCalledWith('run-b');
    expect(fixture.calls).toHaveBeenCalledWith('run-b');
    fixture.flow.mockImplementationOnce(async () => flows.get('run-a'));
    await expect(readProductionOutcome('run-b')).rejects.toMatchObject({ status: 409 });
    await expect(readFile(notePath('run-b'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsafe or mismatched run identities before reading evidence', async () => {
    await expect(readProductionOutcome('../run-a')).rejects.toMatchObject({ status: 400 });
    await put('runs/run-b.json', { run_id: 'run-a', slug: 'run-a' });
    await expect(readProductionOutcome('run-b')).rejects.toMatchObject({ status: 409 });
    expect(fixture.flow).not.toHaveBeenCalled();
  });

  it('paginates the latest twenty readable runs without silently counting corrupt records', async () => {
    for (let index = 0; index < 22; index++) await createRun(`extra-${index}`, new Date(Date.UTC(2026, 8, 21, 0, index)).toISOString());
    await put('runs/broken.json', '{broken');
    const before = await tree();
    const first = await listProductionOutcomes();
    const second = await listProductionOutcomes(20);
    expect(first).toMatchObject({ offset: 0, limit: 20, total: 23, unreadable: 1 });
    expect(first.items).toHaveLength(20); expect(first.items[0].runId).toBe('extra-21');
    expect(second.items).toHaveLength(3);
    expect(new Set([...first.items, ...second.items].map((item) => item.runId)).size).toBe(23);
    await expect(listProductionOutcomes(-1)).rejects.toMatchObject({ status: 400 });
    expect(await tree()).toEqual(before);
  });

  it('lists a new project with no runs without creating any directories', async () => {
    await rm(join(fixture.root, 'runs'), { recursive: true });
    expect(await listProductionOutcomes()).toEqual({ items: [], offset: 0, total: 0, limit: 20, unreadable: 0 });
    expect(await readdir(fixture.root)).toEqual([]);
  });

  it('finds an old article by its current saved name and topic beyond the first page', async () => {
    for (let index = 0; index < 25; index++) await createRun(`new-${index}`, '2026-10-01T00:00:00Z');
    fixture.drafts.mockResolvedValue({ items: [
      { source: 'saved', runId: 'run-a', id: 'draft-latest', name: 'ACME 客户报价' },
      { source: 'saved', runId: 'run-a', id: 'draft-old', name: '作废的旧名称' },
    ] });
    const before = await tree();
    expect((await listProductionOutcomes()).items.some((item) => item.runId === 'run-a')).toBe(false);
    const result = await listProductionOutcomes(0, { query: '  ａｃｍｅ  run-A ' });
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ runId: 'run-a', title: 'ACME 客户报价', draftId: 'draft-latest' });
    expect((await listProductionOutcomes(0, { query: '作废的旧名称' })).total).toBe(0);
    expect(await tree()).toEqual(before);
  });

  it('filters all current approval evidence before paging and never promotes a file, download or stale publication', async () => {
    for (let index = 0; index < 22; index++) {
      await createRun(`new-${index}`, '2026-10-01T00:00:00Z');
      flows.get(`new-${index}`)!.approvals.content_package.approved = false;
    }
    flows.get('new-0')!.publication.confirmed = 1;
    flows.get('new-1')!.publication.confirmed = 1;
    flows.get('new-1')!.draft_queue.lineage_current = false;
    fixture.downloads.mockResolvedValue({ items: [{ downloadStartedAt: '2026-10-01T00:00:00Z' }], unreadable: 0 });
    const ready = await listProductionOutcomes(0, { filter: 'ready' });
    expect(ready.total).toBe(1); expect(ready.items.map((item) => item.runId)).toEqual(['run-a']);
    const published = await listProductionOutcomes(0, { filter: 'published' });
    expect(published.total).toBe(1); expect(published.items.map((item) => item.runId)).toEqual(['new-0']);
    const second = await listProductionOutcomes(20, { filter: 'content' });
    expect(second.total).toBe(23); expect(second.items).toHaveLength(3);
    const reset = await listProductionOutcomes(20, { filter: 'ready' });
    expect(reset.offset).toBe(0); expect(reset.items.map((item) => item.runId)).toEqual(['run-a']);
  });

  it('excludes unreadable status evidence and reports incomplete name lookup', async () => {
    await createRun('run-b');
    fixture.flow.mockImplementation(async (run: { run_id: string }) => run.run_id === 'run-b' ? null : flows.get(run.run_id));
    fixture.drafts.mockRejectedValue(new Error('unavailable'));
    const result = await listProductionOutcomes(0, { filter: 'ready' });
    expect(result).toMatchObject({ total: 1, unreadable: 1, searchWarning: expect.any(String) });
    expect(result.items.map((item) => item.runId)).toEqual(['run-a']);
  });

  it('uses a saved draft name only for its exact run and preserves the existing shelf order', async () => {
    await createRun('run-b');
    fixture.drafts.mockResolvedValue({ items: [
      { source: 'saved', runId: 'run-b', id: 'draft-b', name: '另一篇的名字' },
      { source: 'saved', runId: 'run-a', id: 'draft-latest', name: '作者最新命名', progress: { label: '等你完成模型连接', nextStep: '连接后继续。' } },
      { source: 'saved', runId: 'run-a', id: 'draft-older', name: '旧名字' },
    ] });
    const result = await listProductionOutcomes();
    expect(result.items.find((item) => item.runId === 'run-a')).toMatchObject({ title: '作者最新命名', draftId: 'draft-latest' });
    expect(result.items.find((item) => item.runId === 'run-b')).toMatchObject({ title: '另一篇的名字', draftId: 'draft-b' });
    expect(result.items.find((item) => item.runId === 'run-a')?.progress).toEqual({ label: '等你完成模型连接', nextStep: '连接后继续。' });
    expect(result.items.find((item) => item.runId === 'run-b')?.progress).toBeUndefined();
  });

  it('keeps the runtime title and identity when no saved draft matches or the shelf is unavailable', async () => {
    fixture.drafts.mockResolvedValue({ items: [
      { source: 'runtime', runId: 'run-a', id: 'run:run-a', name: '未保存的显示名' },
      { source: 'saved', runId: 'run-b', id: 'draft-b', name: '另一篇的名字' },
    ] });
    const item = (await listProductionOutcomes()).items[0];
    expect(item).toMatchObject({ runId: 'run-a', title: '主题 run-a' });
    expect(item).not.toHaveProperty('draftId');
    fixture.drafts.mockRejectedValueOnce(new Error('shelf unavailable'));
    expect((await listProductionOutcomes()).items[0]).toEqual(item);
  });
});
