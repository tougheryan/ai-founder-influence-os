import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  args: [] as string[],
  result: { status: 'ready', collected: true, week: '2026-W29', snapshot_path: 'materials/research/weekly/2026-W29/snapshot.json' } as Record<string, unknown>,
}));

vi.mock('child_process', () => ({
  execFile: Object.assign(
    (...args: unknown[]) => {
      mocks.args = (args[1] as string[]) || [];
      const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
      callback(null, JSON.stringify(mocks.result), '');
    },
    { [Symbol.for('nodejs.util.promisify.custom')]: (...args: unknown[]) => {
      mocks.args = (args[1] as string[]) || [];
      return Promise.resolve({ stdout: JSON.stringify(mocks.result), stderr: '' });
    } },
  ),
}));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => undefined }));
vi.mock('@/lib/project-root', () => ({ PROJECT_DIR: '/tmp/aifios-weekly-market', contentRuntimeToolPath: (name: string) => `/tmp/${name}`, redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/write-guard', () => ({ WriteLockError: class WriteLockError extends Error {}, withProjectWriteLock: async <T>(_key: string, callback: () => Promise<T>) => callback() }));

import { POST } from './route';

function request(body: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/research/weekly-market', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('POST /api/research/weekly-market', () => {
  beforeEach(() => {
    mocks.args = [];
    mocks.result = { status: 'ready', collected: true, week: '2026-W29', snapshot_path: 'materials/research/weekly/2026-W29/snapshot.json' };
  });

  it('runs the due-only local collector without weakening the topic gate', async () => {
    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.args).toContain('collect-if-due');
    expect(mocks.args).not.toContain('--force');
    expect(payload).toMatchObject({ ok: true, nonBlocking: true, collected: true });
  });

  it('returns a blocked weekly source as observable non-blocking state', async () => {
    mocks.result = { status: 'blocked', blockers: [{ code: 'tikomni_unavailable' }] };

    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ ok: false, nonBlocking: true, status: 'blocked' });
  });
});
