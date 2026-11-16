import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalProject = process.env.AIFIOS_PROJECT;
let projectDir = '';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function loadWriteGuard(tempProjectDir: string) {
  process.env.AIFIOS_PROJECT = tempProjectDir;
  vi.resetModules();
  return import('./write-guard');
}

async function waitForText(pathname: string, expected: string[], timeoutMs = 10_000): Promise<void> {
  const startedAt = Date.now();
  while (true) {
    try {
      const content = await readFile(pathname, 'utf-8');
      if (expected.every((item) => content.includes(item))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (Date.now() - startedAt >= timeoutMs) throw new Error(`timed out waiting for ${pathname}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function runLockChild(label: string, environment: Record<string, string>) {
  const viteNode = path.join(process.cwd(), 'node_modules', 'vite-node', 'vite-node.mjs');
  const helper = path.join(process.cwd(), 'lib', 'write-guard.child.ts');
  const child = spawn(process.execPath, [viteNode, helper], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment, AIFIOS_LOCK_TEST_LABEL: label },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('withProjectWriteLock', () => {
  afterEach(async () => {
    if (originalProject === undefined) delete process.env.AIFIOS_PROJECT;
    else process.env.AIFIOS_PROJECT = originalProject;
    vi.resetModules();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
    projectDir = '';
  });

  it('serializes concurrent mutations that use the same queue lock key', async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'aifios-write-guard-'));
    const { withProjectWriteLock } = await loadWriteGuard(projectDir);
    const events: string[] = [];
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = withProjectWriteLock('publication-draft-queue:materials/publication/drafts/demo/draft-queue.json', async () => {
      events.push('first:start');
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push('first:end');
    });
    await firstEntered.promise;

    const second = withProjectWriteLock('publication-draft-queue:materials/publication/drafts/demo/draft-queue.json', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(events).toEqual(['first:start']);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('never treats a live claim as stale when staleMs is zero', async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'aifios-write-guard-'));
    const { withProjectWriteLock, WriteLockError } = await loadWriteGuard(projectDir);
    const firstEntered = deferred();
    const releaseFirst = deferred();

    const first = withProjectWriteLock('same-process-live-owner', async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    }, { staleMs: 0 });
    await firstEntered.promise;

    await expect(withProjectWriteLock(
      'same-process-live-owner',
      async () => 'must-not-enter',
      { timeoutMs: 120, staleMs: 0 }
    )).rejects.toBeInstanceOf(WriteLockError);

    releaseFirst.resolve();
    await first;
  });

  it('protects the legacy mkdir-to-owner initialization window even when staleMs is zero', async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'aifios-write-guard-'));
    const { withProjectWriteLock, WriteLockError } = await loadWriteGuard(projectDir);
    const key = 'legacy-owner-initializing';
    const digest = createHash('sha256').update(key).digest('hex');
    const lockPath = path.join(projectDir, 'sessions', 'locks', digest);
    await mkdir(lockPath, { recursive: true });
    let entered = false;

    await expect(withProjectWriteLock(key, async () => {
      entered = true;
    }, { timeoutMs: 120, staleMs: 0 })).rejects.toBeInstanceOf(WriteLockError);
    expect(entered).toBe(false);

    await utimes(lockPath, new Date(0), new Date(0));
    await expect(withProjectWriteLock(key, async () => 'recovered', { timeoutMs: 500, staleMs: 0 }))
      .resolves.toBe('recovered');
  });

  it('serializes same-process reclaimers without allowing either to erase the new owner', async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'aifios-write-guard-'));
    const { withProjectWriteLock } = await loadWriteGuard(projectDir);
    const key = 'double-stale-reclaimer';
    const digest = createHash('sha256').update(key).digest('hex');
    const lockPath = path.join(projectDir, 'sessions', 'locks', digest);
    const orphanId = 'orphaned-owner';
    const orphanClaimPath = path.join(lockPath, `ticket-${orphanId}.json`);
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, '.claim-layout-v1'), 'aifios.write-lock-claim.v1');
    await writeFile(orphanClaimPath, JSON.stringify({
      schema: 'aifios.write-lock-claim.v1',
      kind: 'ticket',
      key,
      pid: 999_999_999,
      ownerId: orphanId,
      createdAt: new Date(0).toISOString(),
      ticket: 1,
    }));
    await utimes(orphanClaimPath, new Date(0), new Date(0));

    const beginTogether = deferred();
    let activeTasks = 0;
    let maximumActiveTasks = 0;
    const entered: string[] = [];
    const contender = async (label: string) => {
      await beginTogether.promise;
      return withProjectWriteLock(key, async () => {
        activeTasks += 1;
        maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks);
        entered.push(label);
        await new Promise((resolve) => setTimeout(resolve, 40));
        activeTasks -= 1;
      }, { timeoutMs: 1_000, staleMs: 0 });
    };

    const first = contender('first');
    const second = contender('second');
    beginTogether.resolve();
    await Promise.all([first, second]);

    expect(maximumActiveTasks).toBe(1);
    expect(entered.sort()).toEqual(['first', 'second']);
  });

  it('serializes two OS processes released from the same stale-reclaim barrier', async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'aifios-write-guard-'));
    const key = 'cross-process-stale-reclaim';
    const digest = createHash('sha256').update(key).digest('hex');
    const lockPath = path.join(projectDir, 'sessions', 'locks', digest);
    const orphanId = 'cross-process-orphan';
    const orphanClaimPath = path.join(lockPath, `ticket-${orphanId}.json`);
    const readyPath = path.join(projectDir, 'children.ready');
    const barrierPath = path.join(projectDir, 'children.go');
    const activePath = path.join(projectDir, 'critical-section.active');
    const eventPath = path.join(projectDir, 'critical-section.events');
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, '.claim-layout-v1'), 'aifios.write-lock-claim.v1');
    await writeFile(orphanClaimPath, JSON.stringify({
      schema: 'aifios.write-lock-claim.v1',
      kind: 'ticket',
      key,
      pid: 999_999_999,
      ownerId: orphanId,
      createdAt: new Date(0).toISOString(),
      ticket: 1,
    }));
    await utimes(orphanClaimPath, new Date(0), new Date(0));

    const environment = {
      AIFIOS_PROJECT: projectDir,
      AIFIOS_LOCK_TEST_READY_PATH: readyPath,
      AIFIOS_LOCK_TEST_BARRIER_PATH: barrierPath,
      AIFIOS_LOCK_TEST_ACTIVE_PATH: activePath,
      AIFIOS_LOCK_TEST_EVENT_PATH: eventPath,
    };
    const first = runLockChild('first', environment);
    const second = runLockChild('second', environment);
    await waitForText(readyPath, ['first\n', 'second\n']);
    await writeFile(barrierPath, 'go');

    const results = await Promise.all([first, second]);
    for (const result of results) {
      expect(result.code, result.stderr || result.stdout).toBe(0);
    }
    const events = (await readFile(eventPath, 'utf-8')).trim().split('\n');
    expect(events).toHaveLength(4);
    expect(events).not.toContain('OVERLAP first');
    expect(events).not.toContain('OVERLAP second');
    expect(events[0]).toMatch(/^start (first|second)$/);
    expect(events[1]).toBe(events[0].replace('start', 'end'));
    expect(events[2]).toMatch(/^start (first|second)$/);
    expect(events[3]).toBe(events[2].replace('start', 'end'));
    expect(events[0]).not.toBe(events[2]);
  }, 15_000);

  it('does not reclaim a stale-looking lock while its owner process is still alive', async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'aifios-write-guard-'));
    const { withProjectWriteLock, WriteLockError } = await loadWriteGuard(projectDir);
    const key = 'visual-publish:demo';
    const digest = createHash('sha256').update(key).digest('hex');
    const lockPath = path.join(projectDir, 'sessions', 'locks', digest);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ key, pid: process.pid, ownerId: 'still-running', createdAt: new Date(0).toISOString() })
    );
    await utimes(lockPath, new Date(0), new Date(0));

    await expect(withProjectWriteLock(key, async () => undefined, { timeoutMs: 120, staleMs: 1 }))
      .rejects.toBeInstanceOf(WriteLockError);
  });

  it('reclaims an expired lock whose recorded owner is no longer running', async () => {
    projectDir = await mkdtemp(path.join(tmpdir(), 'aifios-write-guard-'));
    const { withProjectWriteLock } = await loadWriteGuard(projectDir);
    const key = 'visual-publish:orphaned';
    const digest = createHash('sha256').update(key).digest('hex');
    const lockPath = path.join(projectDir, 'sessions', 'locks', digest);
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, 'owner.json'),
      JSON.stringify({ key, pid: 999_999_999, ownerId: 'orphaned', createdAt: new Date(0).toISOString() })
    );
    await utimes(lockPath, new Date(0), new Date(0));

    await expect(withProjectWriteLock(key, async () => 'recovered', { timeoutMs: 500, staleMs: 1 }))
      .resolves.toBe('recovered');
  });
});
