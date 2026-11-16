import 'server-only';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { secureReadProjectFile } from '@/electron/publication-authority.cjs';
import { PROJECT_DIR } from './project-root';
import { buildProductionFlowIntegrity } from './production-integrity';
import type { RuntimeRun } from './runtime-run-resolver';
import type { ProductionFlowIntegrity } from './production-flow';
import { readServiceCalls } from './service-call-records';
import { listOutputDownloadEvents } from './output-download-events';
import { withProjectWriteLock } from './write-guard';
import { queuePathForRun, withDraftQueueWriteLock } from './publish/draft-queue';
import { listProductionDrafts } from './production-drafts';
import type { OutcomeCompletion, OutcomeNote, OutcomeVersion, ProductionOutcome, ProductionOutcomes } from './production-outcome-types';
import { OUTCOME_FILTERS, type OutcomeFilter } from './production-outcome-types';

const RUN_ID = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/;
const HASH = /^[a-f0-9]{64}$/;
const PAGE_SIZE = 20;
const MAX_JSON = 2 * 1024 * 1024;
type RunEntry = { run: RuntimeRun & { run_id: string; slug: string }; sha256: string };
type StoredNote = OutcomeNote & { schema: 'echo.production-outcome.v1'; runId: string };
export class ProductionOutcomeError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const emptyNote = (): OutcomeNote => ({ version: 0, minutesSpent: null, reusedPreviousWork: null, note: '', updatedAt: '', completions: [] });
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const relative = (value: unknown): value is string => typeof value === 'string' && value.length < 2048
  && /^(pipeline|materials)\//.test(value) && !/[\\\x00-\x1f]/.test(value)
  && value.split('/').every((part) => part && part !== '.' && part !== '..');
const version = (value: unknown): value is OutcomeVersion => Boolean(value && typeof value === 'object'
  && relative((value as OutcomeVersion).path) && HASH.test((value as OutcomeVersion).sha256));

async function runEntry(runId: string): Promise<RunEntry> {
  if (!RUN_ID.test(runId)) throw new ProductionOutcomeError('请从已有草稿打开制作记录。');
  const file = await secureReadProjectFile(PROJECT_DIR, `runs/${runId}.json`, { maxBytes: MAX_JSON });
  const run = JSON.parse(file.buffer.toString('utf8')) as RunEntry['run'];
  if (!run || run.run_id !== runId || typeof run.slug !== 'string' || !RUN_ID.test(run.slug)) {
    throw new ProductionOutcomeError('这份草稿的任务记录需要核对。', 409);
  }
  return { run, sha256: file.sha256 };
}

async function readNote(runId: string): Promise<OutcomeNote> {
  let data: StoredNote;
  try {
    // Distinguish genuinely absent first-use records from secure-read failures,
    // which deliberately conceal filesystem errors behind a common code.
    for (const path of ['runs', `runs/${runId}`]) {
      const info = await lstat(join(PROJECT_DIR, path));
      if (!info.isDirectory() || info.isSymbolicLink()) throw new ProductionOutcomeError('制作记录目录不可用。', 409);
    }
    await lstat(join(PROJECT_DIR, `runs/${runId}/outcome.json`));
    const file = await secureReadProjectFile(PROJECT_DIR, `runs/${runId}/outcome.json`, { maxBytes: MAX_JSON });
    data = JSON.parse(file.buffer.toString('utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyNote();
    throw error;
  }
  if (!data || data.schema !== 'echo.production-outcome.v1' || data.runId !== runId
    || !Number.isSafeInteger(data.version) || data.version < 1 || !date(data.updatedAt)
    || !(data.minutesSpent === null || (Number.isInteger(data.minutesSpent) && data.minutesSpent >= 0 && data.minutesSpent <= 100000))
    || !(data.reusedPreviousWork === null || typeof data.reusedPreviousWork === 'boolean')
    || typeof data.note !== 'string' || data.note.length > 500 || !Array.isArray(data.completions)
    || data.completions.some((item) => !item || !/^finish_[a-f0-9]{32}$/.test(item.id) || !date(item.recordedAt)
      || !version(item.content) || !version(item.deliverables))) throw new ProductionOutcomeError('制作记录无法核对，原记录已保留。', 409);
  return { version: data.version, minutesSpent: data.minutesSpent, reusedPreviousWork: data.reusedPreviousWork,
    note: data.note, updatedAt: data.updatedAt, completions: data.completions };
}

function artifact(flow: ProductionFlowIntegrity, scope: string): OutcomeVersion | null {
  const item = flow.artifacts[scope];
  if (!item?.exists || item.hash_matches_registered === false || !relative(item.path) || !HASH.test(item.sha256)) return null;
  return { path: item.path, sha256: item.sha256 };
}
function confirmed(flow: ProductionFlowIntegrity, scope: string, item: OutcomeVersion | null): boolean {
  const approval = flow.approvals[scope];
  return Boolean(item && approval?.approved === true && approval.path === item.path && approval.sha256 === item.sha256);
}
const same = (a: OutcomeVersion | null, b: OutcomeVersion | null) => Boolean(a && b && a.path === b.path && a.sha256 === b.sha256);

export async function readProductionOutcome(runId: string): Promise<ProductionOutcome> {
  const entry = await runEntry(runId);
  const warnings: string[] = [];
  const [flow, note, downloads, calls] = await Promise.all([
    buildProductionFlowIntegrity(entry.run),
    readNote(runId).catch(() => { warnings.push('制作记录暂时无法读取。'); return null; }),
    listOutputDownloadEvents(runId).catch(() => { warnings.push('下载记录暂时无法读取。'); return null; }),
    readServiceCalls(runId).catch(() => { warnings.push('模型调用记录暂时无法读取。'); return null; }),
  ]);
  if (!flow || flow.run_id !== runId || (await runEntry(runId)).sha256 !== entry.sha256) {
    throw new ProductionOutcomeError('草稿正在更新，请刷新制作记录。', 409);
  }
  const content = artifact(flow, 'content_package');
  const deliverables = artifact(flow, 'draft_information');
  const contentConfirmed = confirmed(flow, 'content_package', content);
  const deliverablesConfirmed = contentConfirmed && confirmed(flow, 'draft_information', deliverables)
    && flow.draft_queue.lineage_current === true && flow.draft_queue.complete;
  const completed = note?.completions.find((item) => same(item.content, content) && same(item.deliverables, deliverables)) || null;
  const started = downloads?.items.filter((item) => Boolean(item.downloadStartedAt)) || [];
  if (downloads?.unreadable) warnings.push(`${downloads.unreadable} 条下载记录无法核对，未计入数量。`);
  return {
    runId, title: entry.run.topic && entry.run.topic !== runId ? entry.run.topic : '未命名内容', platforms: flow.target_platforms || [], updatedAt: entry.run.updated_at || '',
    snapshot: entry.sha256, content, contentConfirmed, deliverables, deliverablesConfirmed,
    // These are current-queue-bound confirmations, not all historical publications.
    publicationRecords: flow.draft_queue.lineage_current === true ? flow.publication.confirmed : 0,
    downloads: downloads ? { count: started.length, latestAt: started.map((item) => item.downloadStartedAt || '').sort().at(-1) || '' } : null,
    note, currentCompletion: deliverablesConfirmed ? completed : null,
    modelCalls: calls ? calls.records.length : null, warnings,
  };
}

export async function listProductionOutcomes(offset = 0, options: { query?: string; filter?: OutcomeFilter } = {}): Promise<ProductionOutcomes> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ProductionOutcomeError('页码不正确。');
  const { query = '', filter = 'all' } = options;
  if (typeof query !== 'string' || query.length > 200 || !OUTCOME_FILTERS.some((item) => item.value === filter)) {
    throw new ProductionOutcomeError('请使用不超过 200 字的关键词和有效的文章状态。');
  }
  let names: string[];
  try {
    const info = await lstat(join(PROJECT_DIR, 'runs'));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid runs directory');
    names = await readdir(join(PROJECT_DIR, 'runs'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], offset, total: 0, limit: PAGE_SIZE, unreadable: 0 };
    throw error;
  }
  let unreadable = 0;
  const entries: RunEntry[] = [];
  for (const name of names.filter((name) => name.endsWith('.json'))) {
    try { entries.push(await runEntry(name.slice(0, -5))); } catch { unreadable++; }
  }
  entries.sort((a, b) => (b.run.updated_at || '').localeCompare(a.run.updated_at || '') || a.run.run_id.localeCompare(b.run.run_id));
  const drafts = await listProductionDrafts().catch(() => null);
  const searchWarning = !drafts || drafts.unreadable
    ? '部分草稿名称暂时无法核对，搜索结果可能不完整；可以清除条件或稍后重试。' : undefined;
  const savedFor = (runId: string) => drafts?.items.find((draft) => draft.source === 'saved' && draft.runId === runId);
  const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase();
  const terms = normalize(query).trim().split(/\s+/).filter(Boolean);
  const matching = entries.filter(({ run }) => terms.every((term) => normalize(`${savedFor(run.run_id)?.name || ''} ${run.topic || ''}`).includes(term)));
  const items: ProductionOutcome[] = [];
  // Search the entire project before pagination. Status filters require current
  // artifact/approval evidence, so inspect all matches with bounded concurrency.
  const selected = filter === 'all' ? matching.slice(offset, offset + PAGE_SIZE) : matching;
  for (let index = 0; index < selected.length; index += 2) {
    const batch = await Promise.allSettled(selected.slice(index, index + 2).map((entry) => readProductionOutcome(entry.run.run_id)));
    for (const result of batch) { if (result.status === 'fulfilled') items.push(result.value); else unreadable++; }
  }
  const filtered = items.filter((item) => filter === 'all'
    || (filter === 'content' && item.content !== null)
    || (filter === 'ready' && item.deliverablesConfirmed)
    || (filter === 'published' && item.publicationRecords !== null && item.publicationRecords > 0));
  const total = filter === 'all' ? matching.length : filtered.length;
  // A refreshed project may have fewer matches than the page the user was on.
  // Return the first page rather than stranding them on an empty later page.
  if (offset > 0 && offset >= total) return listProductionOutcomes(0, options);
  const page = filter === 'all' ? filtered : filtered.slice(offset, offset + PAGE_SIZE);
  for (const item of page) {
    // The draft shelf already validates snapshots and sorts them by author
    // activity. Reuse its most recent saved identity for this exact run.
    const saved = savedFor(item.runId);
    if (saved) { item.draftId = saved.id; item.title = saved.name; }
    item.progress = (saved || drafts?.items.find((draft) => draft.runId === item.runId))?.progress;
  }
  return { items: page, offset, total, limit: PAGE_SIZE, unreadable, ...(searchWarning ? { searchWarning } : {}) };
}

async function persist(runId: string, data: StoredNote) {
  const bytes = Buffer.from(JSON.stringify(data, null, 2));
  if (bytes.length > MAX_JSON) throw new ProductionOutcomeError('制作记录已超过可保存大小，原记录已保留。', 409);
  for (const path of ['runs', `runs/${runId}`]) {
    const full = join(PROJECT_DIR, path);
    await mkdir(full, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(full);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ProductionOutcomeError('制作记录目录不可用。', 409);
  }
  const temporary = join(PROJECT_DIR, `runs/${runId}/.outcome-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(PROJECT_DIR, `runs/${runId}/outcome.json`));
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function saveProductionOutcome(input: {
  runId: unknown; expectedVersion: unknown; snapshot: unknown; action: unknown;
  minutesSpent?: unknown; reusedPreviousWork?: unknown; note?: unknown;
}): Promise<OutcomeNote> {
  if (typeof input.runId !== 'string' || !RUN_ID.test(input.runId) || !Number.isSafeInteger(input.expectedVersion)
    || (input.expectedVersion as number) < 0 || typeof input.snapshot !== 'string' || !HASH.test(input.snapshot)
    || typeof input.action !== 'string' || !['save-note', 'complete'].includes(input.action)) throw new ProductionOutcomeError('请重新读取制作记录后保存。');
  const runId = input.runId;
  if (input.action === 'save-note' && (!(input.minutesSpent === null || (typeof input.minutesSpent === 'number'
    && Number.isInteger(input.minutesSpent) && input.minutesSpent >= 0 && input.minutesSpent <= 100000))
    || !(input.reusedPreviousWork === null || typeof input.reusedPreviousWork === 'boolean')
    || typeof input.note !== 'string' || input.note.length > 500)) throw new ProductionOutcomeError('请填写有效的分钟数和不超过 500 字的记录；未记录的时间可留空。');
  const save = async () => {
    const current = await readProductionOutcome(runId);
    const previous = current.note;
    if (!previous || current.snapshot !== input.snapshot) throw new ProductionOutcomeError('草稿已更新，请刷新后再保存。已填写内容保留。', 409);
    const completion = input.action === 'complete' && current.currentCompletion;
    if (completion) return previous;
    if (previous.version !== input.expectedVersion) throw new ProductionOutcomeError('记录已在其他页面修改，请重新读取后核对。', 409);
    let completions = previous.completions;
    if (input.action === 'complete') {
      if (!current.deliverablesConfirmed || !current.content || !current.deliverables) throw new ProductionOutcomeError('请先在工作台核对文章和成品，再结束本次制作。', 409);
      const item: OutcomeCompletion = { id: `finish_${randomUUID().replaceAll('-', '')}`, recordedAt: new Date().toISOString(), content: current.content, deliverables: current.deliverables };
      completions = [...completions, item];
    }
    const fields = input.action === 'save-note'
      ? { minutesSpent: input.minutesSpent as number | null, reusedPreviousWork: input.reusedPreviousWork as boolean | null, note: input.note as string }
      : { minutesSpent: previous.minutesSpent, reusedPreviousWork: previous.reusedPreviousWork, note: previous.note };
    if (input.action === 'save-note' && JSON.stringify(fields) === JSON.stringify({ minutesSpent: previous.minutesSpent, reusedPreviousWork: previous.reusedPreviousWork, note: previous.note })) return previous;
    if ((await runEntry(runId)).sha256 !== input.snapshot) throw new ProductionOutcomeError('草稿已更新，请刷新后再保存。', 409);
    const stored: StoredNote = { ...fields, schema: 'echo.production-outcome.v1', runId, version: previous.version + 1, updatedAt: new Date().toISOString(), completions };
    await persist(runId, stored);
    return { version: stored.version, minutesSpent: stored.minutesSpent, reusedPreviousWork: stored.reusedPreviousWork, note: stored.note, updatedAt: stored.updatedAt, completions };
  };
  return withProjectWriteLock(`production-outcome:${runId}`, async () => {
    if (input.action !== 'complete') return save();
    const entry = await runEntry(runId);
    // Queue producers replace the file before registering it in the run. Hold
    // their shared lock while rechecking approvals and recording completion.
    return withDraftQueueWriteLock(queuePathForRun(entry.run.slug), save);
  });
}
