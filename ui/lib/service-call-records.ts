import 'server-only';

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { PROJECT_DIR, safeResolve } from './project-root';
import { emptyLLMUsage, type LLMRequestRecorder, type LLMUsage } from './llm-usage';
import type { ModelCallLimit, ServiceCallHistory, ServiceCallRecord } from './service-call-types';
import { withProjectWriteLock } from './write-guard';
import { KnownUserFacingError } from './user-facing-error';

type Stored = ServiceCallRecord & { schema: 'echo.service-call.v1'; ownerPid: number };
const active: Set<string> = (globalThis as typeof globalThis & { echoServiceCalls?: Set<string> }).echoServiceCalls ??= new Set();
const callId = /^call_[a-f0-9]{32}$/;
const validRunId = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/;
export class ServiceCallInputError extends Error {}
const limitLock = (runId: string) => `model-call-limit:${runId}`;
type StoredLimit = { schema: 'echo.model-call-limit.v1'; runId: string; maxCalls: number | null; revision: number };
const validLimit = (value: unknown) => value === null || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 10000);

async function readLimit(runId: string, recordedCalls: number): Promise<ModelCallLimit> {
  let stored: StoredLimit = { schema: 'echo.model-call-limit.v1', runId, maxCalls: null, revision: 0 };
  try {
    await directory(`runs/${runId}`);
    stored = await regularJson(safeResolve(PROJECT_DIR, `runs/${runId}/service-call-limit.json`)!);
    if (stored.schema !== 'echo.model-call-limit.v1' || stored.runId !== runId || !validLimit(stored.maxCalls)
      || !Number.isSafeInteger(stored.revision) || stored.revision < 1) throw new Error('Invalid model call limit');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new KnownUserFacingError({ error: '本期调用限制无法核对，已暂停新的模型请求。请检查本机记录后重试。', code: 'model_call_limit_unavailable' });
  }
  return { maxCalls: stored.maxCalls, revision: stored.revision, recordedCalls, remaining: stored.maxCalls === null ? null : Math.max(0, stored.maxCalls - recordedCalls) };
}

export async function readServiceCallsWithLimit(runId: string): Promise<ServiceCallHistory> {
  const history = await readServiceCalls(runId);
  return { ...history, limit: await readLimit(runId, history.records.length) };
}

export async function saveModelCallLimit(runId: string, maxCalls: unknown, expectedRevision: unknown): Promise<ModelCallLimit> {
  await assertRun(runId);
  if (!validLimit(maxCalls) || !Number.isSafeInteger(expectedRevision) || Number(expectedRevision) < 0) throw new ServiceCallInputError('请填写 0 到 10000 的整数次数；留空表示不限次数。');
  return withProjectWriteLock(limitLock(runId), async () => {
    const history = await readServiceCalls(runId);
    const current = await readLimit(runId, history.records.length);
    if (current.revision !== expectedRevision) throw new KnownUserFacingError({ error: '调用限制已在其他窗口修改。请重新读取后核对，你填写的次数仍保留。', code: 'model_call_limit_conflict' }, { status: 409 });
    const dir = await directory(`runs/${runId}`, true);
    const temporary = `${dir}/.call-limit-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ schema: 'echo.model-call-limit.v1', runId, maxCalls, revision: current.revision + 1 }), { flag: 'wx', mode: 0o600 });
      await rename(temporary, `${dir}/service-call-limit.json`);
    } finally { await unlink(temporary).catch(() => {}); }
    return readLimit(runId, history.records.length);
  });
}

async function directory(relative: string, create = false) {
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index += 1) {
    const path = safeResolve(PROJECT_DIR, parts.slice(0, index + 1).join('/'))!;
    if (create) await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Call record directory is not a regular directory');
  }
  return safeResolve(PROJECT_DIR, relative)!;
}
async function regularJson(path: string, maxBytes = 100_000) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Invalid call record file');
  return JSON.parse(await readFile(path, 'utf8'));
}
async function assertRun(runId: string) {
  if (!validRunId.test(runId)) throw new ServiceCallInputError('请先打开一份草稿，再查看本期调用记录。');
  const runs = await directory('runs');
  const run = await regularJson(`${runs}/${runId}.json`, 2_000_000).catch((error) => {
    if (error.code === 'ENOENT') throw new ServiceCallInputError('找不到这份草稿的任务，没有改为读取其他草稿。');
    throw error;
  });
  if (run?.run_id !== runId) throw new ServiceCallInputError('这份草稿的任务信息不一致，请重新打开草稿。');
}
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validate(record: Stored, runId: string, name: string) {
  if (!record || record.schema !== 'echo.service-call.v1' || record.runId !== runId || `${record.id}.json` !== name || !callId.test(record.id)
    || !/^[a-z][a-z0-9-]{0,79}$/.test(record.operation)
    || typeof record.provider !== 'string' || record.provider.length > 80
    || typeof record.model !== 'string' || record.model.length > 200
    || !['stream', 'completion'].includes(record.transport)
    || !['started', 'completed', 'failed', 'interrupted'].includes(record.status)
    || !date(record.startedAt) || !(record.completedAt === null || date(record.completedAt))
    || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0
    || !(record.previousCallId === null || callId.test(record.previousCallId))
    || !record.usage || Object.keys(emptyLLMUsage()).some((key) => {
      const value = record.usage[key as keyof LLMUsage];
      return value !== null && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    })) throw new Error('Invalid call record');
}
function live(record: Stored) {
  if (record.ownerPid === process.pid) return active.has(record.id);
  try { process.kill(record.ownerPid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
function present(record: Stored): ServiceCallRecord {
  return {
    id: record.id, runId: record.runId, operation: record.operation, provider: record.provider, model: record.model,
    transport: record.transport, startedAt: record.startedAt, completedAt: record.completedAt,
    status: record.status === 'started' && !live(record) ? 'interrupted' : record.status,
    previousCallId: record.previousCallId,
    usage: Object.fromEntries(Object.keys(emptyLLMUsage()).map((key) => [key, record.usage[key as keyof LLMUsage]])) as LLMUsage,
  };
}
async function persist(record: Stored) {
  const dir = await directory(`runs/${record.runId}/service-calls`, true);
  const temporary = `${dir}/.${record.id}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await rename(temporary, `${dir}/${record.id}.json`);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Read-only: never schedules work, repairs records, or falls back to an active run. */
export async function readServiceCalls(runId: string): Promise<ServiceCallHistory> {
  await assertRun(runId);
  let dir: string;
  try { dir = await directory(`runs/${runId}/service-calls`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runId, records: [] }; throw error; }
  const records: ServiceCallRecord[] = [];
  for (const name of (await readdir(dir)).filter((name) => name.endsWith('.json'))) {
    if (!/^call_[a-f0-9]{32}\.json$/.test(name)) throw new Error('Invalid call record name');
    const record = await regularJson(`${dir}/${name}`) as Stored;
    validate(record, runId, name); records.push(present(record));
  }
  records.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  return { runId, records };
}

/** Called only at a model dispatch boundary. No prompt, response, URL, key or error body is stored. */
export function recordRunModelCall(runId: string, operation: string): LLMRequestRecorder {
  return async (request) => {
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(operation)) throw new ServiceCallInputError('调用操作不明确，本次尚未请求生成服务。');
    await assertRun(runId);
    const record = await withProjectWriteLock(limitLock(runId), async () => {
      const history = await readServiceCalls(runId);
      const limit = await readLimit(runId, history.records.length);
      if (limit.remaining === 0) throw new KnownUserFacingError({ error: `本期已达到你设置的 ${limit.maxCalls} 次模型调用上限，本次未请求模型。可在“本期模型调用与用量”核对并调整限制，或继续手动修改。`, code: 'model_call_limit_reached' }, { status: 409 });
      const record: Stored = {
        schema: 'echo.service-call.v1', id: `call_${randomUUID().replaceAll('-', '')}`, runId, operation,
        provider: request.provider, model: request.model, transport: request.transport,
        ownerPid: process.pid, startedAt: new Date().toISOString(), completedAt: null, status: 'started', usage: emptyLLMUsage(),
        // Same operation is a navigational association, not proof of a retry.
        previousCallId: history.records.find((item) => item.operation === operation)?.id || null,
      };
      validate(record, runId, `${record.id}.json`);
      active.add(record.id);
      try { await persist(record); }
      catch { active.delete(record.id); throw new ServiceCallInputError('调用记录未能保存，本次尚未请求生成服务。请检查本机存储后重试。'); }
      return record;
    });
    let finished = false;
    return { finish: async (status, usage) => {
      if (finished) return;
      finished = true;
      record.status = status; record.usage = usage; record.completedAt = new Date().toISOString();
      try { validate(record, runId, `${record.id}.json`); await persist(record); }
      finally { active.delete(record.id); }
    } };
  };
}
