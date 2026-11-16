import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

const LOG_TAIL_MAX_BYTES = 64 * 1024;
const LOG_TAIL_MAX_LINES = 240;
const LOG_SOURCE_MAX_BYTES = 512 * 1024 * 1024;
const MANIFEST_MAX_BYTES = 1024 * 1024;

export interface SecureFileStats {
  size: number;
  dev: number;
  ino: number;
  mtimeMs: number;
  nlink: number;
  uid: number;
  isFile(): boolean;
}

export interface SecureReadHandle {
  stat(): Promise<SecureFileStats>;
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export type SecureOpenFile = (filePath: string, flags: number) => Promise<SecureReadHandle>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function secureReadFlags(): number {
  if (!Number.isInteger(constants.O_NOFOLLOW)) {
    throw new Error('secure_no_follow_unavailable');
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW;
}

function validateRegularFile(
  stats: SecureFileStats,
  maxBytes: number,
  requireCurrentUserOwner: boolean,
): void {
  if (!stats.isFile()) throw new Error('diagnostic_source_not_regular_file');
  if (!Number.isSafeInteger(stats.size) || stats.size < 0 || stats.size > maxBytes) {
    throw new Error('diagnostic_source_size_out_of_bounds');
  }
  if (!Number.isSafeInteger(stats.nlink) || stats.nlink !== 1) {
    throw new Error('diagnostic_source_has_multiple_links');
  }
  if (requireCurrentUserOwner && typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error('diagnostic_source_owner_mismatch');
  }
}

function assertStableSnapshot(before: SecureFileStats, after: SecureFileStats): void {
  if (!after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs) {
    throw new Error('diagnostic_source_changed_during_read');
  }
}

async function readExact(
  handle: SecureReadHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await handle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) break;
    offset += bytesRead;
  }
  if (offset !== length) throw new Error('diagnostic_source_short_read');
  return buffer;
}

async function readVerifiedSnapshot<T>(
  filePath: string,
  maxBytes: number,
  requireCurrentUserOwner: boolean,
  reader: (handle: SecureReadHandle, stats: SecureFileStats) => Promise<T>,
  openFile: SecureOpenFile,
): Promise<{ value: T; stats: SecureFileStats }> {
  const handle = await openFile(filePath, secureReadFlags());
  try {
    const before = await handle.stat();
    validateRegularFile(before, maxBytes, requireCurrentUserOwner);
    const value = await reader(handle, before);
    const after = await handle.stat();
    validateRegularFile(after, maxBytes, requireCurrentUserOwner);
    assertStableSnapshot(before, after);
    return { value, stats: before };
  } finally {
    await handle.close();
  }
}

const defaultSecureOpen: SecureOpenFile = (filePath, flags) => open(filePath, flags);

export async function readTextTail(
  filePath: string,
  openFile: SecureOpenFile = defaultSecureOpen,
): Promise<JsonRecord> {
  if (!filePath) {
    return {
      status: 'not_configured',
      note: 'AIFIOS_DESKTOP_USER_DATA_DIR 未配置，无法定位桌面日志。',
    };
  }

  try {
    const snapshot = await readVerifiedSnapshot(
      filePath,
      LOG_SOURCE_MAX_BYTES,
      true,
      async (handle, stats) => {
        const tailBytes = Math.min(stats.size, LOG_TAIL_MAX_BYTES);
        const buffer = await readExact(handle, tailBytes, Math.max(0, stats.size - tailBytes));
        return { buffer, tailBytes };
      },
      openFile,
    );
    const { buffer, tailBytes } = snapshot.value;
    const stats = snapshot.stats;
    const lines = buffer.toString('utf-8').split(/\r?\n/).slice(-LOG_TAIL_MAX_LINES);
    return {
      status: 'included_tail',
      path: filePath,
      sizeBytes: stats.size,
      tailBytes,
      maxTailBytes: LOG_TAIL_MAX_BYTES,
      maxTailLines: LOG_TAIL_MAX_LINES,
      truncated: stats.size > tailBytes || lines.length >= LOG_TAIL_MAX_LINES,
      tail: lines.join('\n').trim(),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'unavailable',
      path: filePath,
      error: message,
    };
  }
}

function pickFields(source: JsonRecord, fields: string[]): JsonRecord {
  return Object.fromEntries(fields.filter((field) => field in source).map((field) => [field, source[field]]));
}

function summarizeManifest(payload: unknown): JsonRecord {
  if (!isRecord(payload)) return { status: 'invalid_manifest' };
  const summary = pickFields(payload, [
    'status',
    'app_name',
    'bundle_id',
    'version',
    'signature',
    'created_at',
    'prebuilt_next_dist',
    'volume_name',
    'format',
    'size_bytes',
    'sha256',
    'app_path',
    'dmg_path',
    'resources_root',
  ]);

  const pythonRuntime = payload.embedded_python_runtime;
  if (isRecord(pythonRuntime)) {
    summary.embedded_python_runtime = pickFields(pythonRuntime, [
      'status',
      'mode',
      'version',
      'runtime_root',
      'binary',
      'portability',
      'component_signature',
      'macho_files_checked',
      'size_bytes',
    ]);
  }

  return summary;
}

export async function readManifestSummary(
  filePath: string,
  openFile: SecureOpenFile = defaultSecureOpen,
): Promise<JsonRecord> {
  try {
    const snapshot = await readVerifiedSnapshot(
      filePath,
      MANIFEST_MAX_BYTES,
      false,
      (handle, stats) => readExact(handle, stats.size, 0),
      openFile,
    );
    const raw = snapshot.value.toString('utf-8');
    return {
      status: 'included_summary',
      path: filePath,
      sizeBytes: snapshot.stats.size,
      summary: summarizeManifest(JSON.parse(raw)),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: 'unavailable',
      path: filePath,
      error: message,
    };
  }
}
