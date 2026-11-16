import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  args: [] as string[],
  generatorCalls: 0,
  blocked: false,
  count: 3,
  cache: new Map<string, unknown>(),
}));

vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  return {
    execFile: Object.assign(() => undefined, {
      [custom]: (_file: string, args: string[]) => {
        mocks.args = args;
        mocks.generatorCalls += 1;
        return Promise.resolve({
          stdout: JSON.stringify({
            ok: true,
            suggestions: Array.from({ length: mocks.count }, (_, index) => ({
              id: `topic-${index + 1}`,
              title: `第 ${mocks.generatorCalls} 次生成的主题建议 ${index + 1}`,
              reason: '素材与研究共同支持。',
              audience: '目标读者',
              score: 90 - index,
              market_mechanism: '痛点开头',
              material_evidence: '素材命中：案例',
              risk: '不夸大结果。',
            })),
          }),
          stderr: '',
        });
      },
    }),
  };
});
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({
  PROJECT_DIR: '/tmp/aifios-topic-suggestions',
  contentRuntimeToolPath: (name: string) => `/tmp/${name}`,
  redactLocalPaths: <T>(value: T) => value,
}));
vi.mock('@/lib/runtime-binary', () => ({ runtimePythonBinary: () => 'python3' }));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async (_key: string, callback: () => Promise<unknown>) => callback(),
  writeFingerprint: (scope: string, payload: unknown) => `${scope}:${JSON.stringify(payload)}`,
  readIdempotentResult: async <T>(
    key: string,
    validate?: (value: T) => Promise<boolean>,
  ): Promise<T | null> => {
    const cached = mocks.cache.get(key) as T | undefined;
    if (cached === undefined) return null;
    return !validate || await validate(cached) ? cached : null;
  },
  rememberIdempotentResult: async <T>(key: string, value: T) => {
    mocks.cache.set(key, value);
  },
}));
vi.mock('@/lib/topic-research', () => {
  class TopicResearchAccessError extends Error {}
  return {
    TopicResearchAccessError,
    parseTopicResearchBinding: (value: Record<string, string>) => value,
    assertVerifiedTopicResearchBinding: async (binding: Record<string, string>) => {
      if (mocks.blocked) throw new TopicResearchAccessError('snapshot blocked');
      return { ...binding, sourcePath: 'pipeline/intake/topic-intake.md' };
    },
  };
});

import { POST } from './route';

function request(options: {
  runId?: string;
  snapshotPath?: string;
  snapshotSha256?: string;
  mode?: 'prewarm' | 'retrieve' | 'invalid';
} = {}) {
  const runId = options.runId || 'topic-run';
  return new NextRequest('http://localhost/api/research/topic-suggestions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId,
      snapshotPath: options.snapshotPath || `runs/${runId}/market-research/fixture/snapshot.json`,
      snapshotSha256: options.snapshotSha256 || 'a'.repeat(64),
      ...(options.mode ? { mode: options.mode } : {}),
    }),
  });
}

describe('POST /api/research/topic-suggestions', () => {
  beforeEach(() => {
    mocks.args = [];
    mocks.generatorCalls = 0;
    mocks.blocked = false;
    mocks.count = 3;
    mocks.cache.clear();
  });

  it('creates up to three suggestions from the existing verified snapshot without a new market request', async () => {
    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.suggestionCount).toBe(3);
    expect(payload.suggestions).toHaveLength(3);
    expect(payload.cacheStatus).toBeUndefined();
    expect(mocks.generatorCalls).toBe(1);
    expect(mocks.args).toEqual(expect.arrayContaining([
      '/tmp/topic_suggestions.py', '--snapshot', 'runs/topic-run/market-research/fixture/snapshot.json',
      '--snapshot-sha256', 'a'.repeat(64), '--source', 'pipeline/intake/topic-intake.md',
    ]));
    expect(mocks.args.join(' ')).not.toContain('market_signal_report.py');
  });

  it('prewarms once and returns the exact cached suggestions when the topic page retrieves them', async () => {
    const prewarmResponse = await POST(request({ mode: 'prewarm' }));
    const prewarmPayload = await prewarmResponse.json();
    const retrieveResponse = await POST(request({ mode: 'retrieve' }));
    const retrievePayload = await retrieveResponse.json();

    expect(prewarmResponse.status).toBe(200);
    expect(prewarmPayload).toMatchObject({ suggestionCount: 3, cacheStatus: 'built' });
    expect(prewarmPayload.suggestions).toHaveLength(3);
    expect(retrieveResponse.status).toBe(200);
    expect(retrievePayload).toMatchObject({ suggestionCount: 3, cacheStatus: 'hit' });
    expect(retrievePayload.suggestions).toEqual(prewarmPayload.suggestions);
    expect(mocks.generatorCalls).toBe(1);
  });

  it('builds synchronously on retrieve cache misses so the topic page can recover', async () => {
    const response = await POST(request({ mode: 'retrieve' }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toMatchObject({ suggestionCount: 3, cacheStatus: 'built' });
    expect(payload.suggestions).toHaveLength(3);
    expect(mocks.generatorCalls).toBe(1);
  });

  it('does not reuse a cached set across snapshot hashes or runs', async () => {
    const firstResponse = await POST(request({ mode: 'prewarm' }));
    const firstPayload = await firstResponse.json();
    const changedSnapshotResponse = await POST(request({
      mode: 'retrieve',
      snapshotSha256: 'b'.repeat(64),
    }));
    const changedSnapshotPayload = await changedSnapshotResponse.json();
    const otherRunResponse = await POST(request({ mode: 'retrieve', runId: 'other-topic-run' }));
    const otherRunPayload = await otherRunResponse.json();

    expect(firstPayload.cacheStatus).toBe('built');
    expect(changedSnapshotPayload.cacheStatus).toBe('built');
    expect(otherRunPayload.cacheStatus).toBe('built');
    expect(changedSnapshotPayload.suggestions).not.toEqual(firstPayload.suggestions);
    expect(otherRunPayload.suggestions).not.toEqual(firstPayload.suggestions);
    expect(mocks.generatorCalls).toBe(3);
  });

  it('keeps fewer supported choices without padding and permits manual titles for empty material', async () => {
    for (const count of [0, 1, 2]) {
      mocks.count = count;
      const response = await POST(request());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ suggestionCount: count });
    }
  });

  it('rejects an unsupported cache mode before generating suggestions', async () => {
    const response = await POST(request({ mode: 'invalid' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.generatorCalls).toBe(0);
  });

  it('does not run the suggestion generator when the strict snapshot guard fails', async () => {
    await POST(request({ mode: 'prewarm' }));
    mocks.blocked = true;
    const response = await POST(request({ mode: 'retrieve' }));

    expect(response.status).toBe(424);
    const payload = await response.json();
    expect(payload).toMatchObject({ code: 'content_changed' });
    expect(JSON.stringify(payload)).not.toContain('snapshot blocked');
    expect(mocks.generatorCalls).toBe(1);
  });
});
