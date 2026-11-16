import 'server-only';
import { getMaterialAnalysisContext, assertMaterialAnalysisCurrent } from './material-analysis';

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PROJECT_DIR, safeResolve } from './project-root';
import { parseFrontmatter, runtimeRunById } from './runtime-run-resolver';
import { withProjectWriteLock } from './write-guard';
import { attachContentPlan, type ContentPlanBinding } from './content-plan';

export type ContentAttempt = {
  schema: 'echo.content-attempt.v1'; id: string; runId: string;
  status: 'generating' | 'failed' | 'saved'; body: string;
  createdAt: string; updatedAt: string; ownerPid: number;
  plan: ContentPlanBinding; baseline: { path: string; sha256: string };
  provider: string; model: string; issues: string[]; reason?: string; code?: string;
  savedPath?: string;
  /** Original body stays immutable; each accepted edit also has its own revision record. */
  workingDraft?: { body: string; version: number; revisionId: string; issues: string[]; warnings: string[]; updatedAt: string };
};
export class ContentAttemptError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}
const active: Set<string> = (globalThis as typeof globalThis & { echoContentAttempts?: Set<string> }).echoContentAttempts ??= new Set();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

function assertIds(runId: string, id?: string) {
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId) || (id !== undefined && !/^attempt_[a-f0-9]{32}$/.test(id))) throw new ContentAttemptError('生成记录编号不正确。');
}

async function safeFile(path: string, create = false) {
  const absolute = safeResolve(PROJECT_DIR, path);
  const parts = path.split('/');
  if (!absolute || path.includes('\\') || parts.some((part) => !part || part === '.' || part === '..')) throw new ContentAttemptError('生成记录路径不正确。');
  for (let i = 0; i < parts.length; i += 1) {
    const component = safeResolve(PROJECT_DIR, parts.slice(0, i + 1).join('/'))!;
    if (create && i < parts.length - 1) await mkdir(component).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    try {
      const stat = await lstat(component);
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory())) throw new ContentAttemptError('生成记录不能经过链接或非目录文件。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create || i < parts.length - 1) throw error;
    }
  }
  return absolute;
}

export function contentAttemptPath(runId: string, id: string) {
  assertIds(runId, id);
  return `runs/${runId}/content-attempts/${id}.json`;
}

async function persist(record: ContentAttempt) {
  const path = await safeFile(contentAttemptPath(record.runId, record.id), true);
  record.updatedAt = new Date().toISOString();
  const temporary = `${dirname(path)}/.${record.id}-${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  await rename(temporary, path);
}

async function load(runId: string, id: string): Promise<ContentAttempt | null> {
  try {
    const record = JSON.parse(await readFile(await safeFile(contentAttemptPath(runId, id)), 'utf8')) as ContentAttempt;
    if (record.schema !== 'echo.content-attempt.v1' || record.runId !== runId || record.id !== id || typeof record.body !== 'string') throw new ContentAttemptError('生成记录与本期内容不一致。');
    return record;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

export async function beginContentAttempt(runId: string, plan: ContentPlanBinding, provider: string, model: string): Promise<ContentAttempt> {
  assertIds(runId);
  const run = await runtimeRunById(runId);
  if (!run?.slug || run.status === 'archived') throw new ContentAttemptError('这期内容已变化，请重新打开。');
  const path = run.steps?.package?.latest || '';
  const baseline = { path, sha256: path ? sha(await readFile(await safeFile(path), 'utf8')) : '' };
  const record: ContentAttempt = {
    schema: 'echo.content-attempt.v1', id: `attempt_${randomUUID().replaceAll('-', '')}`, runId,
    status: 'generating', body: '', createdAt: new Date().toISOString(), updatedAt: '', ownerPid: process.pid,
    plan, baseline, provider, model, issues: [],
  };
  active.add(record.id);
  try { await persist(record); return record; }
  catch (error) { active.delete(record.id); throw error; }
}

/** Checkpoints never attach a draft to the production or publication chain. */
export async function checkpointContentAttempt(record: ContentAttempt, body: string) {
  record.body = body;
  await persist(record);
}

export async function finishContentAttempt(record: ContentAttempt, body: string, result: { savedPath: string } | { reason: string; code: string; issues?: string[] }) {
  record.body = body;
  if ('savedPath' in result) { record.status = 'saved'; record.savedPath = result.savedPath; }
  else { record.status = 'failed'; record.reason = result.reason; record.code = result.code; record.issues = [...new Set(result.issues || [])]; }
  try { await persist(record); } finally { active.delete(record.id); }
}

function live(record: ContentAttempt) {
  if (record.ownerPid === process.pid) return active.has(record.id);
  if (!Number.isInteger(record.ownerPid) || record.ownerPid <= 0) return false;
  try { process.kill(record.ownerPid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** A successful runtime write is authoritative even if saving its receipt failed. */
async function committedPath(record: ContentAttempt) {
  const run = await runtimeRunById(record.runId);
  const paths = [...new Set([run?.steps?.package?.latest, ...(run?.history ?? []).filter((entry) => entry.step === 'package').map((entry) => entry.path)])];
  for (const path of paths) {
    if (!path || !/^pipeline\/package\/[^/\\]+\.md$/.test(path)) continue;
    try {
      const source = parseFrontmatter(await readFile(await safeFile(path), 'utf8')).source;
      if (source === `ui-agent:content-package:${record.id}`) return path;
      const revisionId = /^content-revision:(rev_[a-f0-9]{32})$/.exec(source || '')?.[1];
      if (revisionId) {
        const revision = JSON.parse(await readFile(await safeFile(`runs/${record.runId}/content-revisions/${revisionId}.json`), 'utf8'));
        if (revision.runId === record.runId && revision.id === revisionId && revision.recoveryId === record.id && revision.basePath === contentAttemptPath(record.runId, record.id)) return path;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return null;
}

export async function getContentAttempt(runId: string, id: string): Promise<ContentAttempt | null> {
  assertIds(runId, id);
  if (!await runtimeRunById(runId)) throw new ContentAttemptError('这期内容不存在。');
  const record = await load(runId, id);
  if (!record || record.status === 'saved' || (record.status === 'generating' && live(record))) return record;
  return withProjectWriteLock(`content-attempt:${runId}:${id}`, async () => {
    const current = (await load(runId, id))!;
    const savedPath = await committedPath(current);
    if (savedPath) {
      current.status = 'saved'; current.savedPath = savedPath;
      await persist(current);
    } else if (current.status === 'generating' && !live(current)) {
      current.status = 'failed';
      current.code = 'generation_interrupted';
      current.reason = '生成服务已中断，保留了最近一次保存的文字。不会自动重新调用模型。';
      await persist(current);
    }
    return current;
  });
}

export async function listContentAttempts(runId: string): Promise<ContentAttempt[]> {
  assertIds(runId);
  if (!await runtimeRunById(runId)) throw new ContentAttemptError('这期内容不存在。');
  let names: string[];
  try { names = await readdir(await safeFile(`runs/${runId}/content-attempts`)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const records = await Promise.all(names.filter((name) => /^attempt_[a-f0-9]{32}\.json$/.test(name)).map((name) => getContentAttempt(runId, name.slice(0, -5))));
  return records.filter((record): record is ContentAttempt => Boolean(record)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10);
}

export async function contentAttemptSource(runId: string, id: string) {
  const attempt = await getContentAttempt(runId, id);
  return sourceForAttempt(runId, attempt);
}

async function sourceForAttempt(runId: string, attempt: ContentAttempt | null) {
  if (!attempt || attempt.status !== 'failed' || !attempt.body.trim()) throw new ContentAttemptError('这次生成没有可补写的失败稿。');
  const run = await runtimeRunById(runId);
  if (!run?.slug || run.status === 'archived') throw new ContentAttemptError('这期内容已归档，失败稿仍可导出。');
  const material = run.material_correction ? await getMaterialAnalysisContext(runId) : null;
  if (material) assertMaterialAnalysisCurrent(material);
  if ((material?.correctionId || '') !== (attempt.plan.material_correction_id || '')) throw new ContentAttemptError('素材要求已修正。这份失败稿仍可导出，请按当前要求重新生成。');
  if (run.steps?.blueprint?.latest !== attempt.plan.path || sha(await readFile(await safeFile(attempt.plan.path), 'utf8')) !== attempt.plan.sha256) throw new ContentAttemptError('写作方案已变化。请按当前方案重新生成；旧失败稿仍可导出。');
  const latest = run.steps?.package?.latest || '';
  if (latest !== attempt.baseline.path || (latest && sha(await readFile(await safeFile(latest), 'utf8')) !== attempt.baseline.sha256)) throw new ContentAttemptError('已有更新的正文。请修改当前正文；旧失败稿仍可导出。');
  const raw = attachContentPlan(attempt.workingDraft?.body ?? attempt.body, attempt.plan);
  return { run, raw, body: raw, sha256: sha(raw), expected: attempt.baseline, draftVersion: attempt.workingDraft?.version ?? 0,
    draftRevisionId: attempt.workingDraft?.revisionId, remainingIssues: attempt.workingDraft?.issues ?? attempt.issues };
}

/** A local working copy never becomes a runtime package or clears an approval. */
export async function saveContentAttemptDraft(runId: string, id: string, expectedSha: string, body: string,
  revisionId: string, issues: string[], warnings: string[]) {
  assertIds(runId, id);
  return withProjectWriteLock(`content-attempt:${runId}:${id}`, async () => {
    const attempt = await load(runId, id);
    const source = await sourceForAttempt(runId, attempt);
    if (attempt!.workingDraft?.revisionId === revisionId && source.body === attachContentPlan(body, attempt!.plan)) return source;
    if (source.sha256 !== expectedSha) throw new ContentAttemptError('待完成稿已在别处修改，请重新读取；本次候选仍然保留。', 409);
    attempt!.workingDraft = { body, version: source.draftVersion + 1, revisionId, issues: [...issues], warnings: [...warnings], updatedAt: new Date().toISOString() };
    await persist(attempt!);
    return sourceForAttempt(runId, attempt);
  });
}

export async function markContentAttemptRecovered(runId: string, id: string, path: string) {
  const record = await getContentAttempt(runId, id);
  if (record) await finishContentAttempt(record, record.body, { savedPath: path });
}
