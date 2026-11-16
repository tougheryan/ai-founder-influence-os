import { createHash, randomUUID } from 'crypto';
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { projectPath, runtimeJoin } from './project-root';

const LOCK_ROOT = projectPath('sessions', 'locks');
const IDEMPOTENCY_ROOT = projectPath('sessions', 'idempotency');
const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_STALE_MS = 5 * 60_000;
const DEFAULT_IDEMPOTENCY_TTL_MS = 10 * 60_000;
const LOCK_POLL_INTERVAL_MS = 50;
const LOCK_INITIALIZATION_GRACE_MS = 1_000;
const LOCK_LAYOUT_FILE = '.claim-layout-v1';
const LOCK_CLAIM_SCHEMA = 'aifios.write-lock-claim.v1';

export class WriteLockError extends Error {}

export type ProjectWriteLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
};

type CacheEnvelope<T> = {
  createdAt: string;
  data: T;
};

type LockOwner = {
  key?: unknown;
  pid?: unknown;
  ownerId?: unknown;
  createdAt?: unknown;
};

type LockClaimKind = 'choosing' | 'ticket';

type LockClaim = {
  schema: typeof LOCK_CLAIM_SCHEMA;
  kind: LockClaimKind;
  key: string;
  pid: number;
  ownerId: string;
  createdAt: string;
  ticket?: number;
};

type InspectedClaim = {
  claim: LockClaim | null;
  path: string;
  ageMs: number;
};

type AcquiredClaim = {
  ticketPath: string;
};

class LockDirectoryResetError extends Error {}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function lockPath(key: string): string {
  return runtimeJoin(LOCK_ROOT, digest(key));
}

function cachePath(key: string): string {
  return runtimeJoin(IDEMPOTENCY_ROOT, `${digest(key)}.json`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizedDuration(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, value)
    : fallback;
}

function ownerProcessIsAlive(owner: LockOwner): boolean {
  const pid = typeof owner.pid === 'number' ? owner.pid : Number(owner.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but this runtime cannot signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function lockWaitError(): WriteLockError {
  return new WriteLockError('同一任务正在执行，请稍后再试');
}

async function waitForRetry(startedAt: number, timeoutMs: number): Promise<void> {
  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) throw lockWaitError();
  await sleep(Math.min(LOCK_POLL_INTERVAL_MS, remainingMs));
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function claimFileName(kind: LockClaimKind, ownerId: string): string {
  return `${kind}-${ownerId}.json`;
}

function ownerIdFromClaimFile(kind: LockClaimKind, name: string): string | null {
  const prefix = `${kind}-`;
  const suffix = '.json';
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return null;
  const ownerId = name.slice(prefix.length, -suffix.length);
  return ownerId || null;
}

function validClaim(
  value: unknown,
  kind: LockClaimKind,
  key: string,
  ownerId: string
): LockClaim | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<LockClaim>;
  const createdAt = typeof candidate.createdAt === 'string' ? Date.parse(candidate.createdAt) : Number.NaN;
  if (
    candidate.schema !== LOCK_CLAIM_SCHEMA
    || candidate.kind !== kind
    || candidate.key !== key
    || candidate.ownerId !== ownerId
    || !Number.isInteger(candidate.pid)
    || Number(candidate.pid) <= 0
    || !Number.isFinite(createdAt)
  ) return null;
  if (kind === 'ticket' && (!Number.isSafeInteger(candidate.ticket) || Number(candidate.ticket) <= 0)) {
    return null;
  }
  return candidate as LockClaim;
}

async function publishClaim(path: string, claim: LockClaim): Promise<void> {
  const temporaryPath = runtimeJoin(dirname(path), `.initializing-${claim.ownerId}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(claim), { flag: 'wx', mode: 0o600 });
    // The final claim name is unique to this acquisition. rename publishes a
    // complete record in one namespace operation, so readers never mistake a
    // half-written claim for a dead owner when staleMs is zero.
    await rename(temporaryPath, path);
  } finally {
    await unlinkIfPresent(temporaryPath);
  }
}

async function inspectClaims(
  path: string,
  kind: LockClaimKind,
  key: string,
  staleMs: number
): Promise<{ claims: LockClaim[]; hasInitializingClaim: boolean }> {
  let names: string[];
  try {
    names = await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LockDirectoryResetError();
    throw error;
  }

  const inspected: InspectedClaim[] = [];
  for (const name of names) {
    const ownerId = ownerIdFromClaimFile(kind, name);
    if (!ownerId) continue;
    const claimPath = runtimeJoin(path, name);
    try {
      const [stats, raw] = await Promise.all([stat(claimPath), readFile(claimPath, 'utf-8')]);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // A published claim is immutable and atomically renamed into place.
        // Invalid content therefore belongs to a crashed/legacy writer, but a
        // minimum grace period still protects externally-created init files.
      }
      inspected.push({
        claim: validClaim(parsed, kind, key, ownerId),
        path: claimPath,
        ageMs: Math.max(0, Date.now() - stats.mtimeMs),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  const claims: LockClaim[] = [];
  let hasInitializingClaim = false;
  for (const item of inspected) {
    if (!item.claim) {
      const invalidClaimStaleMs = Math.max(staleMs, LOCK_INITIALIZATION_GRACE_MS);
      if (item.ageMs <= invalidClaimStaleMs) {
        hasInitializingClaim = true;
      } else {
        // Claim names contain a never-reused UUID. Exact-file deletion cannot
        // remove a later owner, even when several reclaimers arrive together.
        await unlinkIfPresent(item.path);
      }
      continue;
    }

    if (ownerProcessIsAlive(item.claim) || item.ageMs <= staleMs) {
      claims.push(item.claim);
      continue;
    }
    await unlinkIfPresent(item.path);
  }

  return { claims, hasInitializingClaim };
}

async function legacyOwnerBlocks(path: string, staleMs: number): Promise<boolean> {
  const ownerPath = runtimeJoin(path, 'owner.json');
  let pathAgeMs: number;
  try {
    pathAgeMs = Math.max(0, Date.now() - (await stat(path)).mtimeMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LockDirectoryResetError();
    throw error;
  }

  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf-8')) as LockOwner;
    if (ownerProcessIsAlive(owner)) return true;
    const ownerIsReadable = typeof owner.ownerId === 'string' && owner.ownerId.length > 0;
    const reclaimAfterMs = ownerIsReadable ? staleMs : Math.max(staleMs, LOCK_INITIALIZATION_GRACE_MS);
    if (pathAgeMs <= reclaimAfterMs) return true;
    await unlinkIfPresent(ownerPath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && error instanceof Error && error.name !== 'SyntaxError') {
      throw error;
    }
    // An unmarked directory with no complete legacy owner record is the exact
    // old implementation's mkdir -> owner.json initialization window. It may
    // only be adopted after a fixed grace, regardless of staleMs.
    if (pathAgeMs <= Math.max(staleMs, LOCK_INITIALIZATION_GRACE_MS)) return true;
    await unlinkIfPresent(ownerPath);
    return false;
  }
}

async function ensureClaimLayout(
  path: string,
  startedAt: number,
  timeoutMs: number,
  staleMs: number
): Promise<void> {
  const layoutPath = runtimeJoin(path, LOCK_LAYOUT_FILE);
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 });
      // The marker's existence is the protocol switch; its contents do not
      // need to be observed, so O_EXCL creation is sufficient publication.
      await writeFile(layoutPath, LOCK_CLAIM_SCHEMA, { flag: 'wx', mode: 0o600 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOENT') throw error;
      if (code === 'ENOENT') {
        await waitForRetry(startedAt, timeoutMs);
        continue;
      }
    }

    try {
      await access(layoutPath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    try {
      if (await legacyOwnerBlocks(path, staleMs)) {
        await waitForRetry(startedAt, timeoutMs);
        continue;
      }
      try {
        await writeFile(layoutPath, LOCK_CLAIM_SCHEMA, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          await waitForRetry(startedAt, timeoutMs);
          continue;
        }
        if (code !== 'EEXIST') throw error;
      }
      return;
    } catch (error) {
      if (error instanceof LockDirectoryResetError) {
        await waitForRetry(startedAt, timeoutMs);
        continue;
      }
      throw error;
    }
  }
}

function ticketHasPriority(candidate: LockClaim, current: LockClaim): boolean {
  const candidateTicket = Number(candidate.ticket);
  const currentTicket = Number(current.ticket);
  return candidateTicket < currentTicket
    || (candidateTicket === currentTicket && candidate.ownerId.localeCompare(current.ownerId) < 0);
}

async function acquireClaimLock(
  key: string,
  path: string,
  startedAt: number,
  timeoutMs: number,
  staleMs: number
): Promise<AcquiredClaim> {
  while (true) {
    await ensureClaimLayout(path, startedAt, timeoutMs, staleMs);
    const ownerId = randomUUID();
    const choosingPath = runtimeJoin(path, claimFileName('choosing', ownerId));
    let ticketPath: string | null = null;

    try {
      const baseClaim = {
        schema: LOCK_CLAIM_SCHEMA,
        key,
        pid: process.pid,
        ownerId,
        createdAt: new Date().toISOString(),
      } as const;
      await publishClaim(choosingPath, { ...baseClaim, kind: 'choosing' });

      let nextTicket: number | null = null;
      while (nextTicket === null) {
        const snapshot = await inspectClaims(path, 'ticket', key, staleMs);
        if (snapshot.hasInitializingClaim) {
          await waitForRetry(startedAt, timeoutMs);
          continue;
        }
        nextTicket = snapshot.claims.reduce(
          (maximum, claim) => Math.max(maximum, Number(claim.ticket)),
          0
        ) + 1;
        if (!Number.isSafeInteger(nextTicket)) {
          throw new WriteLockError('写锁排号已超出安全范围');
        }
      }

      const currentClaim: LockClaim = { ...baseClaim, kind: 'ticket', ticket: nextTicket };
      ticketPath = runtimeJoin(path, claimFileName('ticket', ownerId));
      await publishClaim(ticketPath, currentClaim);
      await unlinkIfPresent(choosingPath);

      while (true) {
        const choosing = await inspectClaims(path, 'choosing', key, staleMs);
        const anotherContenderIsChoosing = choosing.hasInitializingClaim
          || choosing.claims.some((claim) => claim.ownerId !== ownerId);
        if (anotherContenderIsChoosing) {
          await waitForRetry(startedAt, timeoutMs);
          continue;
        }

        const tickets = await inspectClaims(path, 'ticket', key, staleMs);
        const earlierTicketExists = tickets.hasInitializingClaim
          || tickets.claims.some((claim) => (
            claim.ownerId !== ownerId && ticketHasPriority(claim, currentClaim)
          ));
        if (earlierTicketExists) {
          await waitForRetry(startedAt, timeoutMs);
          continue;
        }

        try {
          await access(ticketPath);
          return { ticketPath };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          throw new LockDirectoryResetError();
        }
      }
    } catch (error) {
      await unlinkIfPresent(choosingPath);
      if (ticketPath) await unlinkIfPresent(ticketPath);
      if (
        error instanceof LockDirectoryResetError
        || (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        await waitForRetry(startedAt, timeoutMs);
        continue;
      }
      throw error;
    }
  }
}

export function writeFingerprint(scope: string, payload: unknown): string {
  return `${scope}:${digest(stableStringify(payload))}`;
}

export async function projectFileExists(relativePath: string): Promise<boolean> {
  try {
    await access(projectPath(relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function withProjectWriteLock<T>(
  key: string,
  task: () => Promise<T>,
  options: ProjectWriteLockOptions = {}
): Promise<T> {
  const timeoutMs = normalizedDuration(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const staleMs = normalizedDuration(options.staleMs, DEFAULT_LOCK_STALE_MS);
  const path = lockPath(key);
  const startedAt = Date.now();

  await mkdir(LOCK_ROOT, { recursive: true });
  const acquired = await acquireClaimLock(key, path, startedAt, timeoutMs, staleMs);

  try {
    return await task();
  } finally {
    // A ticket filename includes this acquisition's UUID and is never reused.
    // Releasing it cannot erase a successor, even after a long task or a race
    // between multiple stale-claim collectors.
    await unlinkIfPresent(acquired.ticketPath);
  }
}

export async function readIdempotentResult<T>(
  key: string,
  validate?: (data: T) => Promise<boolean>,
  ttlMs = DEFAULT_IDEMPOTENCY_TTL_MS
): Promise<T | null> {
  try {
    const envelope = JSON.parse(await readFile(cachePath(key), 'utf-8')) as CacheEnvelope<T>;
    if (Date.now() - new Date(envelope.createdAt).getTime() > ttlMs) return null;
    if (validate && !(await validate(envelope.data))) return null;
    return envelope.data;
  } catch {
    return null;
  }
}

export async function rememberIdempotentResult<T>(key: string, data: T): Promise<void> {
  const path = cachePath(key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ createdAt: new Date().toISOString(), data }, null, 2));
}
