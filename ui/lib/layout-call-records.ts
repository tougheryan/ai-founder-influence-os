import 'server-only';

import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { projectPath } from './project-root';
import type { LayoutCallHistory, LayoutCallRecord } from './layout-call-types';

type Stored = LayoutCallRecord & { schema: 'echo.layout-call.v1'; ownerPid: number };
const themePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const slugPattern = /^[A-Za-z0-9\u4e00-\u9fff-]{1,80}$/;
const idPattern = /^layout_[a-f0-9]{32}$/;
const active: Set<string> = (globalThis as typeof globalThis & { echoLayoutCalls?: Set<string> }).echoLayoutCalls ??= new Set();
export class LayoutCallInputError extends Error {}
export class LayoutCallWriteError extends Error {}

async function directory(parts: string[], create = false): Promise<string> {
  for (let i = 1; i <= parts.length; i += 1) {
    const path = projectPath(...parts.slice(0, i));
    if (create) await mkdir(path, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid layout record directory');
  }
  return projectPath(...parts);
}

async function regularJson(path: string, maxBytes = 8000) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Invalid layout record file');
  return JSON.parse(await readFile(path, 'utf8'));
}

const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validate(record: Stored, name: string) {
  if (!record || record.schema !== 'echo.layout-call.v1' || !idPattern.test(record.id) || `${record.id}.json` !== name
    || !['theme-preview', 'article-layout', 'article-restyle'].includes(record.operation)
    || !['started', 'completed', 'failed'].includes(record.status)
    || typeof record.theme !== 'string' || !themePattern.test(record.theme)
    || !(record.runSlug === null || (typeof record.runSlug === 'string' && slugPattern.test(record.runSlug)))
    || !(record.revisionId === null || (typeof record.revisionId === 'string' && /^r[0-9]{3,12}$/.test(record.revisionId)))
    || (record.operation === 'theme-preview' ? record.runSlug !== null || record.revisionId !== null : !record.runSlug)
    || !date(record.startedAt) || !(record.completedAt === null || date(record.completedAt))
    || (record.status === 'started') !== (record.completedAt === null)
    || !Number.isSafeInteger(record.ownerPid) || record.ownerPid <= 0) throw new Error('Invalid layout record');
}

async function write(record: Stored) {
  const dir = await directory(['sessions', 'layout-service-calls'], true);
  const temporary = `${dir}/.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    await rename(temporary, `${dir}/${record.id}.json`);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** A durable dispatch attempt, not a provider receipt or a billing statement. */
export async function startThemePreviewCall(theme: string) {
  if (!themePattern.test(theme)) throw new LayoutCallInputError('排版样式格式不正确。');
  const record: Stored = {
    schema: 'echo.layout-call.v1', id: `layout_${randomUUID().replaceAll('-', '')}`,
    operation: 'theme-preview', runSlug: null, revisionId: null, theme,
    startedAt: new Date().toISOString(), completedAt: null, status: 'started', ownerPid: process.pid,
  };
  try { await write(record); }
  catch { throw new LayoutCallWriteError('无法保存排版请求记录，本次未请求排版服务。请检查项目存储后重试。'); }
  active.add(record.id);
  return {
    async finish(status: 'completed' | 'failed') {
      try { await write({ ...record, status, completedAt: new Date().toISOString() }); }
      catch { throw new LayoutCallWriteError('排版请求已尝试，但结束记录未能保存；费用未知。请先核对已有结果，再决定是否重试。'); }
      finally { active.delete(record.id); }
    },
  };
}

async function runSlug(runId: string) {
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)) throw new LayoutCallInputError('草稿编号无效，没有改为读取其他草稿。');
  let run;
  try {
    const dir = await directory(['runs']);
    run = await regularJson(`${dir}/${runId}.json`, 2_000_000);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LayoutCallInputError('找不到这份草稿的任务，没有改为读取其他草稿。');
    throw error;
  }
  if (run?.run_id !== runId || typeof run.slug !== 'string' || !slugPattern.test(run.slug)) throw new LayoutCallInputError('草稿与内容记录无法核对，请重新打开草稿。');
  return run.slug as string;
}

function interrupted(record: Stored) {
  if (record.ownerPid === process.pid) return !active.has(record.id);
  try { process.kill(record.ownerPid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export async function readLayoutCalls(runId: string | null = null): Promise<LayoutCallHistory> {
  const slug = runId === null ? null : await runSlug(runId);
  let dir: string;
  try { dir = await directory(['sessions', 'layout-service-calls']); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { runId, records: [] };
    throw error;
  }
  const records: LayoutCallRecord[] = [];
  for (const name of await readdir(dir)) {
    if (name.startsWith('.')) continue; // Atomic write in progress.
    if (!/^layout_[a-f0-9]{32}\.json$/.test(name)) throw new Error('Unexpected layout record file');
    const stored: Stored = await regularJson(`${dir}/${name}`);
    validate(stored, name);
    if (slug !== null && stored.runSlug !== slug) continue;
    // Explicit allow-list: never return unknown fields, paths, stderr or owner metadata.
    records.push({
      id: stored.id, operation: stored.operation, runSlug: stored.runSlug, revisionId: stored.revisionId,
      theme: stored.theme, startedAt: stored.startedAt, completedAt: stored.completedAt,
      status: stored.status === 'started' && interrupted(stored) ? 'interrupted' : stored.status,
    });
  }
  return { runId, records: records.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)) };
}
