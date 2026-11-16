import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: unknown[] }>,
  ensureStatusError: '',
  readStatusError: '',
}));

vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => undefined,
}));

vi.mock('@/lib/project-root', () => ({
  redactLocalPaths: <T>(value: T) => value,
}));

vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async <T>(_key: string, callback: () => Promise<T>) => callback(),
}));

vi.mock('@/lib/weekly-review', () => ({
  isWeeklyReviewRecordPath: (value: string) => /^materials\/weekly-review\/\d{4}-W\d{2}\/learning-record\.json$/.test(value),
  getWeeklyReviewStatus: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'status', args });
    if (args[0] === true && mocks.ensureStatusError) throw new Error(mocks.ensureStatusError);
    if (args[0] === false && mocks.readStatusError) throw new Error(mocks.readStatusError);
    if (args[0] === false) return { status: 'not_due' };
    return { status: 'waiting_metrics', record_path: 'materials/weekly-review/2026-W30/learning-record.json' };
  },
  collectWeeklyReview: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'collect', args });
    return { status: 'waiting_metrics' };
  },
  saveWeeklyReviewMetrics: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'metrics', args });
    return { status: 'ready', missing_metrics: [] };
  },
  completeWeeklyReview: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'complete', args });
    return { status: 'completed', report_path: 'materials/weekly-review/2026-W30/weekly-review.md' };
  },
  applyWeeklyReviewMemory: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'memory', args });
    return { status: 'memory_applied' };
  },
  acknowledgeWeeklyReminder: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'acknowledge', args });
    return { status: 'acknowledged' };
  },
}));

import { GET, POST } from './route';

const recordPath = 'materials/weekly-review/2026-W30/learning-record.json';
const recordId = 'publication_0123456789abcdef0123';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/weekly-review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/weekly-review', () => {
  beforeEach(() => {
    mocks.calls = [];
    mocks.ensureStatusError = '';
    mocks.readStatusError = '';
  });

  it('hydrates the local weekly state and can create a waiting review', async () => {
    const status = await GET();
    const collected = await POST(request({ action: 'collect' }));

    expect(status.status).toBe(200);
    expect((await status.json()).status).toBe('waiting_metrics');
    expect(collected.status).toBe(200);
    expect((await collected.json()).status).toBe('waiting_metrics');
    expect(mocks.calls.map((item) => item.name)).toEqual(['status', 'collect']);
  });

  it('falls back to a read-only page status when a historical ledger breaks automatic collection', async () => {
    mocks.ensureStatusError = '历史发布台账 schema 无效';

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'not_due' });
    expect(mocks.calls).toEqual([
      { name: 'status', args: [true] },
      { name: 'status', args: [false] },
    ]);
  });

  it('does not hide an invalid current review when the read-only integrity check also fails', async () => {
    mocks.ensureStatusError = '历史发布台账 schema 无效';
    mocks.readStatusError = '当前周报来源链已变化';

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'weekly_review_read_failed' });
    expect(mocks.calls).toEqual([
      { name: 'status', args: [true] },
      { name: 'status', args: [false] },
    ]);
  });

  it('accepts bounded manual metrics and only writes memory after an explicit human confirmation', async () => {
    const metrics = await POST(request({
      action: 'save_metrics',
      recordPath,
      updates: {
        [recordId]: {
          metrics: { reads: 1200, likes: 80 },
          comments: ['这条说到了我的问题。'],
        },
      },
    }));
    const unconfirmed = await POST(request({ action: 'apply_memory', recordPath, humanConfirmed: false }));
    const confirmed = await POST(request({ action: 'apply_memory', recordPath, humanConfirmed: true }));

    expect(metrics.status).toBe(200);
    expect(unconfirmed.status).toBe(400);
    expect(confirmed.status).toBe(200);
    expect(mocks.calls).toEqual([
      {
        name: 'metrics',
        args: [recordPath, {
          [recordId]: {
            metrics: { reads: 1200, likes: 80 },
            comments: ['这条说到了我的问题。'],
          },
        }],
      },
      { name: 'memory', args: [recordPath, true] },
    ]);
  });

  it('rejects paths and metric values outside the local weekly-review contract', async () => {
    const escaped = await POST(request({ action: 'complete', recordPath: '../outside.json' }));
    const invalidMetric = await POST(request({
      action: 'save_metrics',
      recordPath,
      updates: { [recordId]: { metrics: { reads: -1 } } },
    }));

    expect(escaped.status).toBe(400);
    expect(invalidMetric.status).toBe(400);
    expect(mocks.calls).toEqual([]);
  });
});
