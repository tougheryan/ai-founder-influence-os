import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { PROJECT_DIR, safeResolve } from './project-root';
import { getApiKey, getModel, getProviderPreset } from './llm-client';
import type { LLMConfig } from './types';

export type ModelConnectionRecord = {
  id: string; provider: string; model: string; startedAt: string; completedAt: string | null;
  status: 'running' | 'success' | 'failed' | 'interrupted'; message: string; latencyMs: number | null;
};
type Stored = ModelConnectionRecord & { fingerprint: string; ownerPid: number };
const active: Set<string> = (globalThis as typeof globalThis & { echoModelConnectionChecks?: Set<string> }).echoModelConnectionChecks ??= new Set();
const directory = 'sessions/model-connection-tests';
function fingerprint(config: LLMConfig) {
  return createHash('sha256').update(JSON.stringify([config.provider, getModel(config), config.baseUrl || getProviderPreset(config.provider).baseUrl, getApiKey(config)])).digest('hex');
}
async function folder(create = false) {
  for (const path of ['sessions', directory]) {
    const absolute = safeResolve(PROJECT_DIR, path)!;
    if (create) await mkdir(absolute, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Connection record directory is not a regular directory');
  }
  return safeResolve(PROJECT_DIR, directory)!;
}
async function persist(record: Stored) {
  const dir = await folder(true);
  const temporary = `${dir}/.${record.id}-${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
  await rename(temporary, `${dir}/${record.id}.json`);
}
function present(record: Stored): ModelConnectionRecord {
  return { id: record.id, provider: record.provider, model: record.model, startedAt: record.startedAt, completedAt: record.completedAt, status: record.status, message: record.message, latencyMs: record.latencyMs };
}
function live(record: Stored) {
  if (record.ownerPid === process.pid) return active.has(record.id);
  if (!Number.isInteger(record.ownerPid) || record.ownerPid <= 0) return false;
  try { process.kill(record.ownerPid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export async function beginModelConnectionRecord(config: LLMConfig): Promise<Stored> {
  const record: Stored = { id: `check_${randomUUID().replaceAll('-', '')}`, provider: config.provider, model: getModel(config), fingerprint: fingerprint(config), ownerPid: process.pid, startedAt: new Date().toISOString(), completedAt: null, status: 'running', message: '连接测试已开始，尚未收到完整结果。', latencyMs: null };
  active.add(record.id);
  try { await persist(record); return record; } catch (error) { active.delete(record.id); throw error; }
}
export async function finishModelConnectionRecord(record: Stored, success: boolean): Promise<ModelConnectionRecord> {
  record.status = success ? 'success' : 'failed';
  record.completedAt = new Date().toISOString();
  record.latencyMs = Math.max(0, Date.now() - Date.parse(record.startedAt));
  record.message = success ? '本次短文本请求返回成功；不代表余额、长文效果或其他服务已通过。' : '本次模型请求未完成，请检查模型权限、密钥和网络后再试。';
  try { await persist(record); return present(record); } finally { active.delete(record.id); }
}
export async function readModelConnectionRecord(config: LLMConfig): Promise<{ record: ModelConnectionRecord | null; matchesCurrentSettings: boolean }> {
  let dir: string;
  try { dir = await folder(); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { record: null, matchesCurrentSettings: false }; throw error; }
  const records: Stored[] = [];
  for (const name of (await readdir(dir)).filter((name) => /^check_[a-f0-9]{32}\.json$/.test(name))) {
    const path = `${dir}/${name}`;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Connection record is not a regular file');
    const item = JSON.parse(await readFile(path, 'utf8')) as Stored;
    if (item.id !== name.slice(0, -5) || !['running', 'success', 'failed'].includes(item.status) || !/^[a-f0-9]{64}$/.test(item.fingerprint)) throw new Error('Invalid connection record');
    records.push(item);
  }
  records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const current = fingerprint(config);
  const record = records.find((item) => item.fingerprint === current) || records[0];
  if (!record) return { record: null, matchesCurrentSettings: false };
  if (record.status === 'running' && !live(record)) {
    record.status = 'interrupted'; record.message = '上次测试在服务中断前未取得结果；不会自动重新调用，费用以服务商记录为准。';
  }
  return { record: present(record), matchesCurrentSettings: record.fingerprint === current };
}
