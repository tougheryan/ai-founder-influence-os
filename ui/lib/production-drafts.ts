import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PROJECT_DIR, safeResolve } from './project-root';
import { listRuntimeRuns, runtimeRunById, type RuntimeRun } from './runtime-run-resolver';
import { withProjectWriteLock } from './write-guard';
import { assertJsonInputSize, MAX_TEXT_ARTIFACT_BYTES } from './input-limits';
import { materialInputFingerprintPayload } from './material-input-fingerprint';
import { materialPreparationProgress, MODEL_CONNECTION_PROGRESS } from './material-progress';
import { draftDeliveryStatus, type DraftStatus } from './production-draft-filter';
import type { ProductionFlowIntegrity } from './production-flow';

export type ProductionDraftRecord = {
  schema: 'echo.production-draft.v1'; id: string; name: string; version: number;
  createdAt: string; updatedAt: string; modifiedAt?: string; runId: string; state: Record<string, unknown>; fingerprint: string;
};
export type ProductionDraftSummary = Pick<ProductionDraftRecord, 'id' | 'name' | 'version' | 'updatedAt' | 'modifiedAt' | 'runId'> & {
  platforms: string[]; source: 'saved' | 'runtime'; excerpt?: string; topic?: string; status?: DraftStatus;
  progress?: { label: string; nextStep: string; status?: DraftStatus };
};
export class ProductionDraftError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const ID = /^draft_[a-f0-9]{32}$/;
const RUN_ID = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/;
const root = 'sessions/workbench-drafts';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stateKeys = ['activeStage', 'researchSubview', 'notes', 'materialText', 'materialLinks', 'materialFiles', 'materialAnalysis', 'materialAnalysisStale', 'selectedMaterialTypeId', 'selectedMaterialStructureId', 'topicResearch', 'topicResearchInputFingerprint'];

/** Snapshots hold work, never approval authority or model/account settings. */
export function sanitizeProductionDraftState(value: unknown): Record<string, unknown> {
  const input = record(value);
  if (!Object.keys(input).length) throw new ProductionDraftError('没有可保存的草稿内容。');
  const state = Object.fromEntries(stateKeys.filter((key) => input[key] !== undefined).map((key) => [key, input[key]]));
  const draft = record(input.draft);
  state.draft = Object.fromEntries(['topic', 'writingMode', 'writingModeChosen', 'template', 'projectId', 'runId', 'runSlug', 'selectedPlatforms'].filter((key) => draft[key] !== undefined).map((key) => [key, draft[key]]));
  state.reviewAssertions = {};
  state.approvalModes = {};
  assertJsonInputSize(state, '草稿', MAX_TEXT_ARTIFACT_BYTES);
  return state;
}

async function pathFor(id?: string, create = false) {
  if (id !== undefined && !ID.test(id)) throw new ProductionDraftError('草稿编号不正确。');
  const parts = root.split('/');
  for (let index = 0; index < parts.length; index++) {
    const path = safeResolve(PROJECT_DIR, parts.slice(0, index + 1).join('/'))!;
    if (create) await mkdir(path).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new ProductionDraftError('草稿目录不可用。');
  }
  const result = safeResolve(PROJECT_DIR, id ? `${root}/${id}.json` : root)!;
  if (id) {
    try { const info = await lstat(result); if (!info.isFile() || info.isSymbolicLink()) throw new ProductionDraftError('草稿文件不可用。'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return result;
}

async function readSaved(id: string): Promise<ProductionDraftRecord | null> {
  try {
    const saved = JSON.parse(await readFile(await pathFor(id), 'utf8')) as ProductionDraftRecord;
    if (saved.id !== id || saved.schema !== 'echo.production-draft.v1' || !Number.isSafeInteger(saved.version) || saved.fingerprint !== digest({ name: saved.name, state: saved.state })) throw new ProductionDraftError('草稿校验失败，原文件已保留。', 409);
    return saved;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function readProductionDraft(id: string): Promise<ProductionDraftRecord | null> {
  if (!id.startsWith('run:')) return readSaved(id);
  const runId = id.slice(4);
  if (!RUN_ID.test(runId)) throw new ProductionDraftError('内容编号不正确。');
  const run = await runtimeRunById(runId);
  if (!run || run.run_id !== runId || run.status !== 'active') return null;
  return {
    schema: 'echo.production-draft.v1', id, version: 0, name: run.topic || '未命名内容',
    createdAt: run.updated_at || '', updatedAt: run.updated_at || '', runId,
    state: { draft: { runId, runSlug: run.slug, topic: run.topic, writingMode: run.research_mode === 'author_material' ? 'author_material' : 'platform', projectId: run.project_id || 'default', selectedPlatforms: run.selected_platforms || run.target_platforms, template: run.visual_template }, reviewAssertions: {}, approvalModes: {} }, fingerprint: '',
  };
}

/** Content changes affect modification time; navigation, timestamps and link enrichment do not. */
function authorInputFingerprint(name: string, state: Record<string, unknown>): string {
  const draft = record(state.draft);
  const links = Array.isArray(state.materialLinks) ? state.materialLinks.map((link) => typeof link === 'string' ? link.trim() : text(record(link).url).trim()).filter(Boolean) : [];
  const files = Array.isArray(state.materialFiles) ? state.materialFiles.map((value) => {
    const file = record(value);
    return { name: file.name, size: file.size, source: file.sourcePath || file.path, ...(file.writingRequirements === 'reference_only' ? { writingRequirements: file.writingRequirements } : {}) };
  }) : [];
  const analysis = record(state.materialAnalysis);
  const analysisContent = Object.fromEntries(['summary', 'facts', 'opinions', 'authorRequirements', 'cases', 'illustrations', 'risks', 'recommendedTypeId', 'recommendedStructureId'].filter((key) => analysis[key] !== undefined).map((key) => [key, analysis[key]]));
  const notes = Object.fromEntries(Object.entries(record(state.notes)).filter(([, value]) => typeof value === 'string' && value.trim()).sort(([a], [b]) => a.localeCompare(b)));
  return digest({
    name, topic: text(draft.topic), writingMode: text(draft.writingMode) || 'platform', template: text(draft.template) || 'default',
    platforms: Array.isArray(draft.selectedPlatforms) ? [...draft.selectedPlatforms].sort() : [],
    material: text(state.materialText), links, files, notes, analysis: analysisContent,
    materialType: text(state.selectedMaterialTypeId), materialStructure: text(state.selectedMaterialStructureId),
  });
}

function materialExcerpt(saved: ProductionDraftRecord): string {
  const material = text(saved.state.materialText).trim().replace(/\s+/g, ' ');
  if (material) return [...material].slice(0, 140).join('') + ([...material].length > 140 ? '…' : '');
  const files = Array.isArray(saved.state.materialFiles) ? saved.state.materialFiles.map((value) => text(record(value).name)).filter(Boolean) : [];
  const links = Array.isArray(saved.state.materialLinks) ? saved.state.materialLinks.filter((value) => (typeof value === 'string' ? value : text(record(value).url)).trim()) : [];
  if (files.length || links.length) return [files.length ? `附件：${files.slice(0, 3).join('、')}${files.length > 3 ? `等 ${files.length} 份` : ''}` : '', links.length ? `${links.length} 条素材链接` : ''].filter(Boolean).join(' · ');
  const note = Object.values(record(saved.state.notes)).find((value) => typeof value === 'string' && value.trim());
  if (note) return `笔记：${text(note).trim().replace(/\s+/g, ' ').slice(0, 140)}`;
  const topic = text(record(saved.state.draft).topic).trim();
  return topic ? `题目：${topic.slice(0, 140)}` : '还没有素材摘要';
}

const unknownProgress = { status: 'unknown' as const, label: '进度待核对', nextStep: '打开草稿，核对关联任务和已保存的内容。' };
const artifactStages = [
  { phase: 'visual_assets', step: '', label: '排版文件已保存', nextStep: '打开检查排版与配图，再核对导出内容。' },
  { phase: 'content_package', step: 'package', label: '正文文件已保存', nextStep: '打开核对正文、修改要求和确认状态。' },
  { phase: 'topic_template', step: 'blueprint', label: '写作方案文件已保存', nextStep: '打开核对方案及确认状态，再继续写正文。' },
  { phase: 'material_boundary', step: 'intake', label: '素材整理文件已保存', nextStep: '打开核对素材理解、题目和写作要求。' },
];

async function readableArtifact(path: string, expectedHash?: string): Promise<boolean> {
  if (typeof path !== 'string') return false;
  const parts = path.split('/');
  if (!path || path.includes('\\') || !['pipeline', 'runs'].includes(parts[0]) || parts.some((part) => !part || part === '.' || part === '..')) return false;
  try {
    for (let index = 0; index < parts.length; index++) {
      const component = safeResolve(PROJECT_DIR, parts.slice(0, index + 1).join('/'));
      if (!component) return false;
      const info = await lstat(component);
      if (info.isSymbolicLink() || (index === parts.length - 1 ? !info.isFile() || !info.size || info.size > MAX_TEXT_ARTIFACT_BYTES : !info.isDirectory())) return false;
    }
    if (!expectedHash) return true;
    const bytes = await readFile(safeResolve(PROJECT_DIR, path)!);
    return createHash('sha256').update(bytes).digest('hex') === expectedHash;
  } catch { return false; }
}

function runHasPath(run: RuntimeRun, path: string): boolean {
  return Object.values(run.steps || {}).some((item) => item?.latest === path)
    || Object.values(run.phase_artifacts || {}).some((item) => item?.path === path)
    || (Array.isArray(run.history) && run.history.some((item) => item?.path === path));
}

async function missingModelSetup(): Promise<boolean> {
  const { resolveServerLLMConfig } = await import('./server-config');
  const { getApiKey, validateLLMConfig } = await import('./llm-client');
  const config = await resolveServerLLMConfig({});
  return Boolean(validateLLMConfig(config).length || !getApiKey(config).trim());
}

async function modelConnectionProgress(run: RuntimeRun): Promise<ProductionDraftSummary['progress']> {
  if (!run.run_id) return;
  // Read the same durable task used by the workbench. Merely listing drafts
  // must never resume it, test a connection, or dispatch a model request.
  const { latestProductionTaskForRun } = await import('./production-tasks');
  const task = await latestProductionTaskForRun(run.run_id);
  if (!task || task.runId !== run.run_id || task.status !== 'blocked' || task.error?.code !== 'model_setup_required') return;
  const { assertProductionTaskRunAuthority } = await import('./production-task-authority');
  await assertProductionTaskRunAuthority(task);
  return await missingModelSetup()
    ? MODEL_CONNECTION_PROGRESS
    : { label: '可以继续本期', nextStep: '模型设置已补齐；打开草稿，继续上次未完成的步骤。连接效果仍以实际请求为准。' };
}

async function preparedMaterialProgress(saved: ProductionDraftRecord, run: RuntimeRun): Promise<ProductionDraftSummary['progress']> {
  const { latestProductionTaskForRun } = await import('./production-tasks');
  const task = await latestProductionTaskForRun(saved.runId);
  if (task && task.runId === saved.runId) {
    const { assertProductionTaskRunAuthority } = await import('./production-task-authority');
    const current = await assertProductionTaskRunAuthority(task).then(() => true, () => false);
    // A live, failed or blocked task owns the next action. Preparation must not
    // replace that action merely because it can still read an analysis file.
    if (current && task.status !== 'completed') return;
  }
  const { getMaterialAnalysisContext, isMaterialAnalysisCurrent } = await import('./material-analysis');
  const context = await getMaterialAnalysisContext(saved.runId);
  if (!context) return;
  const fingerprint = createHash('sha256').update(materialInputFingerprintPayload({
    rawMaterial: saved.state.materialText, files: saved.state.materialFiles, links: saved.state.materialLinks,
  })).digest('hex');
  const stale = !isMaterialAnalysisCurrent(context)
    || (!saved.id.startsWith('run:') && fingerprint !== context.inputFingerprint);
  const draft = record(saved.state.draft);
  const writingMode = text(draft.writingMode) || run.research_mode;
  return materialPreparationProgress({
    hasAnalysis: true, stale, writingMode, topic: text(draft.topic),
    modelSetupIssue: !stale && writingMode === 'author_material' && await missingModelSetup() ? 'missing' : null,
  });
}

async function draftProgress(saved: ProductionDraftRecord, runs: RuntimeRun[], delivery: Map<string, Promise<ProductionFlowIntegrity | null>>): Promise<NonNullable<ProductionDraftSummary['progress']>> {
  if (saved.state.materialAnalysisStale === true) return { label: '素材有更改，待重新整理', nextStep: '重新整理素材，再核对题目和写作要求。' };
  if (!saved.runId) {
    const hasMaterial = Boolean(text(saved.state.materialText).trim() || (Array.isArray(saved.state.materialFiles) && saved.state.materialFiles.length) || (Array.isArray(saved.state.materialLinks) && saved.state.materialLinks.some((value) => (typeof value === 'string' ? value : text(record(value).url)).trim())));
    return hasMaterial
      ? { label: '素材已保存', nextStep: '整理素材，再核对题目和写作要求。' }
      : { label: text(record(saved.state.draft).topic).trim() ? '题目已保存' : '还未放入素材', nextStep: '添加一段经历、笔记、文件或素材链接。' };
  }
  const run = await runtimeRunById(saved.runId);
  const draft = record(saved.state.draft);
  if (!run || run.run_id !== saved.runId || run.slug !== draft.runSlug || (run.project_id && run.project_id !== draft.projectId)) return unknownProgress;
  // Obsolete tasks cannot override current artifact evidence. Their authority
  // check fails when material, topic, or the bound source version has changed.
  const connection = await modelConnectionProgress(run).catch(() => undefined);
  if (connection) return connection;
  for (const stage of artifactStages) {
    const registered = run.phase_artifacts?.[stage.phase];
    const stepPath = stage.step ? run.steps?.[stage.step]?.latest : '';
    const path = registered?.path || stepPath;
    if (!path) continue;
    if (registered?.path && stepPath && registered.path !== stepPath) return unknownProgress;
    // A shared or changed file is not evidence of this draft's progress.
    if (runs.some((candidate) => candidate.run_id !== saved.runId && runHasPath(candidate, path)) || !await readableArtifact(path, registered?.sha256)) return unknownProgress;
    if (stage.phase === 'visual_assets' || stage.phase === 'content_package') {
      const runPlatforms = run.selected_platforms || run.target_platforms;
      const normalizePlatforms = (items: unknown[]) => items.map((item) => item === 'xhs' ? 'xiaohongshu' : String(item)).sort().join(',');
      if (Array.isArray(draft.selectedPlatforms) && Array.isArray(runPlatforms) && normalizePlatforms(draft.selectedPlatforms) !== normalizePlatforms(runPlatforms)) return { label: '平台有更改，待核对', nextStep: '打开核对本期平台与成品范围。' };
      if (text(draft.topic) && text(run.topic) && text(draft.topic) !== text(run.topic)) return { label: '题目有更改，待核对', nextStep: '打开核对题目与当前文章，再继续制作。' };
      const { getMaterialAnalysisContext } = await import('./material-analysis');
      const context = await getMaterialAnalysisContext(saved.runId).catch(() => undefined);
      if (context === undefined) return unknownProgress;
      if (!saved.id.startsWith('run:') && context && createHash('sha256').update(materialInputFingerprintPayload({ rawMaterial: saved.state.materialText, files: saved.state.materialFiles, links: saved.state.materialLinks })).digest('hex') !== context.inputFingerprint) return { label: '素材有更改，待重新整理', nextStep: '重新整理素材，再核对题目和写作要求。' };
      const cacheKey = `${saved.runId}:${digest(run)}`;
      if (!delivery.has(cacheKey)) delivery.set(cacheKey, (async () => {
        const { buildProductionFlowIntegrity } = await import('./production-integrity');
        const flow = await buildProductionFlowIntegrity(run);
        // A changing run cannot lend its old confirmations to the new list row.
        return flow?.run_id === saved.runId && digest(await runtimeRunById(saved.runId)) === digest(run) ? flow : null;
      })().catch(() => null));
      const flow = await delivery.get(cacheKey)!;
      const status = draftDeliveryStatus(flow);
      if (status === 'published') return { status, label: flow?.publication.complete ? '当前成品已有发布记录' : '部分成品已有发布记录', nextStep: '打开核对发布记录与尚未发布的成品。' };
      if (status === 'ready') return { status, label: '成品已确认，可导出', nextStep: '打开核对成品，再保存需要的文件。' };
      return { status, label: stage.label, nextStep: stage.nextStep };
    }
    return { label: stage.label, nextStep: stage.nextStep };
  }
  return await preparedMaterialProgress(saved, run).catch(() => unknownProgress)
    || { label: '内容任务已创建', nextStep: '打开查看任务进度，核对生成前的设置。' };
}

async function summary(saved: ProductionDraftRecord, runs: RuntimeRun[], delivery: Map<string, Promise<ProductionFlowIntegrity | null>>): Promise<ProductionDraftSummary> {
  const platforms = record(saved.state.draft).selectedPlatforms;
  const progress = await draftProgress(saved, runs, delivery);
  return {
    id: saved.id, name: saved.name, version: saved.version, updatedAt: saved.updatedAt, modifiedAt: saved.modifiedAt || '', runId: saved.runId,
    source: saved.id.startsWith('run:') ? 'runtime' : 'saved', platforms: Array.isArray(platforms) ? platforms.filter((value): value is string => typeof value === 'string') : [],
    excerpt: materialExcerpt(saved), topic: text(record(saved.state.draft).topic).trim(), progress, status: progress.status || 'pending',
  };
}

export async function listProductionDrafts(): Promise<{ items: ProductionDraftSummary[]; unreadable: number }> {
  let entries: string[] = [];
  try { entries = await readdir(await pathFor()); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const items: ProductionDraftSummary[] = [];
  const runs = await listRuntimeRuns();
  const delivery = new Map<string, Promise<ProductionFlowIntegrity | null>>();
  let unreadable = 0;
  for (const name of entries) {
    const id = name.replace(/\.json$/, '');
    if (!ID.test(id) || !name.endsWith('.json')) continue;
    try { const saved = await readSaved(id); if (saved) items.push(await summary(saved, runs, delivery)); } catch { unreadable++; }
  }
  const savedRuns = new Set(items.map((item) => item.runId));
  for (const run of runs) {
    if (!run.run_id || run.status !== 'active' || savedRuns.has(run.run_id)) continue;
    const draft = await readProductionDraft(`run:${run.run_id}`);
    if (draft) items.push(await summary(draft, runs, delivery));
  }
  return { items: items.sort((a, b) => (b.modifiedAt || b.updatedAt).localeCompare(a.modifiedAt || a.updatedAt)), unreadable };
}

export async function saveProductionDraft(input: { id: unknown; name: unknown; expectedVersion: unknown; state: unknown }): Promise<ProductionDraftRecord> {
  const id = text(input.id);
  if (!ID.test(id)) throw new ProductionDraftError('草稿编号不正确。');
  const state = sanitizeProductionDraftState(input.state);
  const draft = record(state.draft);
  const runId = text(draft.runId);
  if (runId) {
    const run = await runtimeRunById(runId);
    if (!RUN_ID.test(runId) || !run || run.slug !== draft.runSlug || (run.project_id && run.project_id !== draft.projectId)) throw new ProductionDraftError('草稿关联的内容任务已变化，请刷新后再保存。', 409);
  }
  const name = (text(input.name).trim() || text(draft.topic).trim() || text(state.materialText).trim().split(/\r?\n/)[0] || '未命名草稿').slice(0, 100);
  const fingerprint = digest({ name, state });
  return withProjectWriteLock(`production-draft:${id}`, async () => {
    const existing = await readSaved(id);
    if (existing?.fingerprint === fingerprint) return existing;
    if ((existing?.version || 0) !== input.expectedVersion) throw new ProductionDraftError('这份草稿已在其他页面更新。请先重新打开，或另存为新草稿。', 409);
    if (existing && existing.runId && existing.runId !== runId) throw new ProductionDraftError('同一份草稿不能改为另一内容任务。', 409);
    const now = new Date().toISOString();
    const modifiedAt = existing && authorInputFingerprint(existing.name, existing.state) === authorInputFingerprint(name, state) ? existing.modifiedAt || '' : now;
    const saved: ProductionDraftRecord = { schema: 'echo.production-draft.v1', id, name, version: (existing?.version || 0) + 1, createdAt: existing?.createdAt || now, updatedAt: now, modifiedAt, runId, state, fingerprint };
    const destination = await pathFor(id, true);
    const temporary = `${dirname(destination)}/.${id}-${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(saved, null, 2), { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
    return saved;
  });
}
