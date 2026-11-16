import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ name: string; args: unknown[] }>,
  due: { refreshed: true, state: { projectId: 'client_alpha', accounts: [] }, reminder: { shouldNotify: true, message: '研究有更新', refreshedAt: '2026-07-15T00:00:00.000Z' } },
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => undefined }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async <T>(_key: string, callback: () => Promise<T>) => callback(),
}));
vi.mock('@/lib/benchmark-advisor', () => ({
  BenchmarkAdvisorInputError: class BenchmarkAdvisorInputError extends Error {},
  listBenchmarkAdvisorProjectIds: async () => ['client_alpha'],
  getBenchmarkAdvisorState: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'state', args });
    return { projectId: args[0], accounts: [], weekly: {} };
  },
  saveBenchmarkAccounts: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'save', args });
    return { projectId: args[0], accounts: [] };
  },
  refreshBenchmarkAdvisorResearch: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'refresh', args });
    return { projectId: args[0], accounts: [] };
  },
  refreshBenchmarkAdvisorIfDue: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'due', args });
    return mocks.due;
  },
  sendBenchmarkAdvisorMessage: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'chat', args });
    return { projectId: args[0], accounts: [] };
  },
  adoptBenchmarkAdvisorAction: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'adopt', args });
    return { runId: 'run', path: 'runs/run/benchmark-advisor/adopted-conclusions.json', adoptedCount: 1, action: {} };
  },
  analyzeBenchmarkVideo: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'analyze-video', args });
    return { projectId: args[0], accounts: [], latestVideoAnalysis: { id: 'video' } };
  },
  adoptBenchmarkVideoAngle: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'adopt-video', args });
    return { runId: 'run', path: 'runs/run/benchmark-advisor/adopted-conclusions.json', adoptedCount: 1, action: {} };
  },
  acknowledgeBenchmarkAdvisorNotification: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'acknowledge', args });
    return { projectId: args[0], accounts: [] };
  },
  getBenchmarkAdvisorDesktopReminder: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'desktop-reminder', args });
    return mocks.due.reminder;
  },
  acknowledgeBenchmarkAdvisorDesktopReminder: async (...args: unknown[]) => {
    mocks.calls.push({ name: 'desktop-acknowledge', args });
    return { shouldNotify: false, message: '', refreshedAt: null };
  },
}));

import { GET, POST } from './route';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/benchmark-advisor', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/benchmark-advisor', () => {
  beforeEach(() => {
    mocks.calls = [];
  });

  it('requires a project ID for state and scopes desktop reminders to that project', async () => {
    const missing = await GET(new NextRequest('http://localhost/api/benchmark-advisor'));
    const response = await GET(new NextRequest('http://localhost/api/benchmark-advisor?desktopReminder=1&projectId=client_alpha'));

    expect(missing.status).toBe(400);
    expect(response.status).toBe(200);
    expect((await response.json()).reminder).toMatchObject({ shouldNotify: true, message: '研究有更新' });
    expect(mocks.calls).toEqual([{ name: 'desktop-reminder', args: ['client_alpha'] }]);
  });

  it('forwards project id and explicit customer authorization when saving accounts', async () => {
    const response = await POST(request({
      action: 'save_accounts',
      projectId: 'client_alpha',
      customerAuthorizationConfirmed: true,
      accounts: [],
    }));

    expect(response.status).toBe(200);
    expect(mocks.calls).toEqual([{
      name: 'save',
      args: ['client_alpha', [], true],
    }]);
  });

  it('runs a due-only refresh within the requested project', async () => {
    const response = await POST(request({ action: 'refresh_if_due', projectId: 'client_alpha' }));

    expect(response.status).toBe(200);
    expect((await response.json()).reminder).toMatchObject({ shouldNotify: true });
    expect(mocks.calls).toEqual([{ name: 'due', args: ['client_alpha'] }]);
  });

  it('routes a single-video analysis and video angle adoption through the requested project', async () => {
    const analysis = await POST(request({
      action: 'analyze_video',
      projectId: 'client_alpha',
      sourceUrl: 'https://v.douyin.com/fixture-work/',
    }));
    const adoption = await POST(request({
      action: 'adopt_video_angle',
      projectId: 'client_alpha',
      runId: 'run',
      analysisId: 'video',
      angleId: 'angle-1',
    }));

    expect(analysis.status).toBe(200);
    expect(adoption.status).toBe(200);
    expect(mocks.calls).toEqual([
      { name: 'analyze-video', args: ['client_alpha', 'https://v.douyin.com/fixture-work/'] },
      { name: 'adopt-video', args: ['client_alpha', 'run', 'video', 'angle-1'] },
    ]);
  });

  it('rejects unsupported actions before invoking an advisor operation', async () => {
    const response = await POST(request({ action: 'delete_all_history', projectId: 'client_alpha' }));

    expect(response.status).toBe(400);
    expect(mocks.calls).toEqual([]);
  });
});
