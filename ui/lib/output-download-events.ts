import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { PROJECT_DIR, safeResolve } from './project-root';
import { getOutputDisclosure, type OutputDisclosure } from './output-disclosure';
import { MAX_OUTPUT_DOWNLOAD_BYTES } from './output-export';
import { withProjectWriteLock } from './write-guard';
import { secureReadProjectFile } from '@/electron/publication-authority.cjs';

export type OutputDownloadEvent = {
  schema: 'echo.output-download-event.v1';
  id: string; runId: string; path: string;
  sourceSha256: string; outputSha256: string; outputBytes: number; fileName: string;
  preparedAt: string;
  /** The browser reported its download click; this does not prove a file was saved or published. */
  downloadStartedAt?: string;
};
export class OutputDownloadEventError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const RUN_ID = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/;
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 16 * 1024;
// A marked download adds a bounded notice/archive to the bounded original.
const MAX_EXPORTED_BYTES = MAX_OUTPUT_DOWNLOAD_BYTES + 1024 * 1024;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const safeRelative = (value: unknown): value is string => typeof value === 'string' && value.length <= 2048 && !/[\\\x00-\x1f]/.test(value) && !/^[A-Za-z]:/.test(value) && value.split('/').every((part) => part && part !== '.' && part !== '..');
const safeName = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && !/[\/\\\x00-\x1f\x7f]/.test(value) && Buffer.byteLength(value, 'utf8') <= 255;
function requireIds(runId: unknown, id?: unknown): asserts runId is string {
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || (id !== undefined && (typeof id !== 'string' || !ID.test(id)))) throw new OutputDownloadEventError('下载记录标识不正确。');
}
const directory = (runId: string) => `runs/${runId}/output-download-events`;
const recordPath = (runId: string, id: string) => `${directory(runId)}/${id}.json`;

async function ensureEventDirectory(runId: string, create: boolean): Promise<string> {
  requireIds(runId);
  const parts = directory(runId).split('/');
  for (let index = 1; index <= parts.length; index++) {
    const target = safeResolve(PROJECT_DIR, parts.slice(0, index).join('/'));
    if (!target) throw new OutputDownloadEventError('下载记录目录不可用。');
    if (create) await mkdir(target, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new OutputDownloadEventError('下载记录目录不可用。');
  }
  return safeResolve(PROJECT_DIR, directory(runId))!;
}

function parseEvent(value: unknown, runId: string, id: string): OutputDownloadEvent {
  if (!isObject(value) || value.schema !== 'echo.output-download-event.v1' || value.runId !== runId || value.id !== id
    || !safeRelative(value.path) || !safeName(value.fileName) || typeof value.sourceSha256 !== 'string' || !HASH.test(value.sourceSha256)
    || typeof value.outputSha256 !== 'string' || !HASH.test(value.outputSha256)
    || !Number.isSafeInteger(value.outputBytes) || Number(value.outputBytes) < 0 || Number(value.outputBytes) > MAX_EXPORTED_BYTES
    || !time(value.preparedAt) || (value.downloadStartedAt !== undefined && (!time(value.downloadStartedAt) || Date.parse(value.downloadStartedAt) < Date.parse(value.preparedAt)))) {
    throw new OutputDownloadEventError('下载记录校验失败，原记录已保留。', 409);
  }
  // Only public event metadata crosses this boundary, including for legacy/tampered JSON.
  return { schema: 'echo.output-download-event.v1', id, runId, path: value.path, sourceSha256: value.sourceSha256, outputSha256: value.outputSha256,
    outputBytes: Number(value.outputBytes), fileName: value.fileName, preparedAt: value.preparedAt,
    ...(typeof value.downloadStartedAt === 'string' ? { downloadStartedAt: value.downloadStartedAt } : {}) };
}
async function readEvent(runId: string, id: string): Promise<OutputDownloadEvent> {
  const file = await secureReadProjectFile(PROJECT_DIR, recordPath(runId, id), { maxBytes: MAX_RECORD_BYTES });
  return parseEvent(JSON.parse(file.buffer.toString('utf8')), runId, id);
}
async function writeEvent(event: OutputDownloadEvent): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(event, null, 2));
  if (bytes.length > MAX_RECORD_BYTES) throw new OutputDownloadEventError('下载记录过大。');
  const root = await ensureEventDirectory(event.runId, true);
  const destination = safeResolve(PROJECT_DIR, recordPath(event.runId, event.id))!;
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new OutputDownloadEventError('下载记录文件不可用。');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = `${root}/.${event.id}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, destination);
  } finally { await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
}

/** A successful file preparation may be recorded; reading or finding a file alone never creates an event. */
export async function prepareOutputDownloadEvent(input: {
  path: string; source: Buffer; output: Buffer; fileName: string; disclosure: OutputDisclosure;
}): Promise<OutputDownloadEvent | null> {
  const { disclosure } = input;
  if (disclosure.status === 'unverified' || !disclosure.runId || !RUN_ID.test(disclosure.runId) || !disclosure.fingerprint || !HASH.test(disclosure.fingerprint)) return null;
  if (!safeRelative(input.path) || !safeName(input.fileName) || input.source.length > MAX_OUTPUT_DOWNLOAD_BYTES || input.output.length > MAX_EXPORTED_BYTES) throw new OutputDownloadEventError('下载记录内容不正确。');
  // Bind both the original bytes and the prepared response to a freshly verified
  // owner. An unverified result that happens to carry runId is never sufficient.
  const source = await secureReadProjectFile(PROJECT_DIR, input.path, { maxBytes: MAX_OUTPUT_DOWNLOAD_BYTES });
  const sourceSha256 = sha(input.source);
  if (source.sha256 !== sourceSha256) return null;
  const current = await getOutputDisclosure(input.path);
  if (current.status === 'unverified' || current.runId !== disclosure.runId || current.fingerprint !== disclosure.fingerprint) return null;
  const event: OutputDownloadEvent = {
    schema: 'echo.output-download-event.v1', id: randomUUID(), runId: disclosure.runId, path: input.path,
    sourceSha256, outputSha256: sha(input.output), outputBytes: input.output.length, fileName: input.fileName, preparedAt: new Date().toISOString(),
  };
  await withProjectWriteLock(`output-download-event:${event.id}`, () => writeEvent(event));
  return event;
}

/** Acknowledge one server-prepared receipt. Repeated acknowledgements do not add a download or move its time. */
export async function acknowledgeOutputDownloadEvent(runId: string, receiptId: string): Promise<OutputDownloadEvent> {
  requireIds(runId, receiptId);
  return withProjectWriteLock(`output-download-event:${receiptId}`, async () => {
    let event: OutputDownloadEvent;
    try { event = await readEvent(runId, receiptId); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new OutputDownloadEventError('找不到本篇对应的下载准备记录。', 404);
      if (error instanceof OutputDownloadEventError) throw error;
      throw new OutputDownloadEventError('下载准备记录无法核对。', 409);
    }
    if (event.downloadStartedAt) return event;
    const acknowledged = { ...event, downloadStartedAt: new Date(Math.max(Date.now(), Date.parse(event.preparedAt))).toISOString() };
    await writeEvent(acknowledged);
    return acknowledged;
  });
}

export async function listOutputDownloadEvents(runId: string): Promise<{ items: OutputDownloadEvent[]; unreadable: number }> {
  requireIds(runId);
  let names: string[];
  try { names = await readdir(await ensureEventDirectory(runId, false)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { items: [], unreadable: 0 };
    return { items: [], unreadable: 1 };
  }
  const items: OutputDownloadEvent[] = [];
  let unreadable = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!ID.test(id)) { unreadable++; continue; }
    try { items.push(await readEvent(runId, id)); } catch { unreadable++; }
  }
  return { items: items.sort((a, b) => b.preparedAt.localeCompare(a.preparedAt)), unreadable };
}
