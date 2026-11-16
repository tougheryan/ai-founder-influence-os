import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnownUserFacingError } from '@/lib/user-facing-error';

const mocks = vi.hoisted(() => ({
  stored: new Map<string, Record<string, unknown>>(),
  latestCalls: [] as string[],
  recoverCalls: [] as string[],
  scheduleCalls: [] as string[],
  createError: null as Error | null,
}));

vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/write-guard', () => ({ WriteLockError: class WriteLockError extends Error {} }));
vi.mock('@/lib/production-tasks', () => {
  class ProductionTaskInputError extends Error {}
  const task = (runId: string, taskId: string, kind = 'content-package') => ({
    schema: 'aifios.production-task.v1',
    taskId,
    runId,
    kind,
    status: 'queued',
    currentStep: null,
    steps: [],
    startedAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    result: {},
    resumableFrom: null,
    request: {},
  });
  return {
    ProductionTaskInputError,
    isProductionTaskKind: (value: unknown) => value === 'content-package',
    assertProductionTaskIds: (runId: unknown, taskId?: unknown) => {
      if (typeof runId !== 'string' || !/^run-[a-z]+$/.test(runId)) throw new ProductionTaskInputError('run ID 格式不正确。');
      if (taskId !== undefined && (typeof taskId !== 'string' || !/^task_[a-z0-9_]+$/.test(taskId))) {
        throw new ProductionTaskInputError('任务编号格式不正确。');
      }
      return { runId, ...(taskId ? { taskId } : {}) };
    },
    createOrReadProductionTask: async (input: { runId: string; taskId?: string; kind: string }) => {
      if (mocks.createError) throw mocks.createError;
      const taskId = input.taskId || 'task_generated';
      const key = `${input.runId}:${taskId}`;
      const existing = mocks.stored.get(key);
      if (existing) return { task: existing, created: false };
      const created = task(input.runId, taskId, input.kind);
      mocks.stored.set(key, created);
      return { task: created, created: true };
    },
    getProductionTask: async (runId: string, taskId: string) => mocks.stored.get(`${runId}:${taskId}`) || null,
    latestProductionTaskForRun: async (runId: string) => {
      mocks.latestCalls.push(runId);
      return [...mocks.stored.values()].find((item) => item.runId === runId) || null;
    },
    recoverInterruptedProductionTask: async (runId: string, taskId: string) => {
      mocks.recoverCalls.push(`${runId}:${taskId}`);
      const stored = mocks.stored.get(`${runId}:${taskId}`);
      if (!stored) throw new ProductionTaskInputError('任务不存在。');
      const recovered = { ...stored, status: 'queued', currentStep: null };
      mocks.stored.set(`${runId}:${taskId}`, recovered);
      return { task: recovered, recovered: true };
    },
    refreshKnownLocalProductionTaskFailure: async <T>(value: T) => value,
    productionTaskResponse: <T>(value: T) => value,
    scheduleProductionTask: (runId: string, taskId: string) => {
      mocks.scheduleCalls.push(`${runId}:${taskId}`);
    },
  };
});

import { GET, POST } from './route';

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/production/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

describe('/api/production/tasks durable identity', () => {
  beforeEach(() => {
    mocks.stored.clear();
    mocks.latestCalls = [];
    mocks.recoverCalls = [];
    mocks.scheduleCalls = [];
    mocks.createError = null;
  });

  it('returns the same persistent task for a duplicate client task ID', async () => {
    const body = { runId: 'run-demo', taskId: 'task_content_001', kind: 'content-package', input: {} };
    const first = await post(body);
    const second = await post(body);

    expect(first.status).toBe(202);
    expect((await first.json()).created).toBe(true);
    expect(second.status).toBe(202);
    expect((await second.json()).created).toBe(false);
  });

  it('returns the actionable setup error without scheduling work', async () => {
    mocks.createError = new KnownUserFacingError({ error: '请先完成模型连接。', code: 'model_setup_required', action: { label: '连接写作服务', href: '/settings#model-connection' } }, { status: 422 });
    const response = await post({ runId: 'run-demo', taskId: 'task_missing_model', kind: 'content-package', input: {} });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ ok: false, code: 'model_setup_required', action: { href: '/settings#model-connection' } });
    expect(mocks.stored.size).toBe(0);
    expect(mocks.scheduleCalls).toEqual([]);
  });

  it('recovers the latest task by run when the browser lost its task ID', async () => {
    await post({ runId: 'run-demo', taskId: 'task_content_001', kind: 'content-package', input: {} });
    const response = await GET(new NextRequest('http://localhost/api/production/tasks?runId=run-demo'));

    expect(response.status).toBe(200);
    expect((await response.json()).task.taskId).toBe('task_content_001');
    expect(mocks.latestCalls).toEqual(['run-demo']);
  });

  it('returns an empty successful lookup when the run has no background task yet', async () => {
    const response = await GET(new NextRequest('http://localhost/api/production/tasks?runId=run-demo'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, task: null });
  });

  it('atomically requeues and schedules a task left running by a previous process', async () => {
    await post({ runId: 'run-demo', taskId: 'task_content_001', kind: 'content-package', input: {} });
    const saved = mocks.stored.get('run-demo:task_content_001');
    mocks.stored.set('run-demo:task_content_001', { ...saved, status: 'running', currentStep: 'content-package' });
    mocks.recoverCalls = [];
    mocks.scheduleCalls = [];

    const response = await GET(new NextRequest(
      'http://localhost/api/production/tasks?runId=run-demo&taskId=task_content_001',
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.task.status).toBe('queued');
    expect(mocks.recoverCalls).toEqual(['run-demo:task_content_001']);
    expect(mocks.scheduleCalls).toEqual(['run-demo:task_content_001']);
  });
});
