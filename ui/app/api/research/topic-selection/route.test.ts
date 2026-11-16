import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saved: null as Record<string, unknown> | null,
  blocked: false,
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async (_key: string, callback: () => Promise<unknown>) => callback(),
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
vi.mock('@/lib/runtime-writer', () => ({
  setRuntimeRunTopic: async (input: Record<string, unknown>) => {
    mocks.saved = input;
    return {
      status: 'selected',
      run_id: input.runId,
      slug: 'neutral-material-run',
      topic: input.topic,
      changed: true,
      market_snapshot_path: input.snapshotPath,
      market_snapshot_sha256: input.snapshotSha256,
      suggestion_id: input.suggestionId,
    };
  },
}));

import { POST } from './route';

function request(topic = '把一次客户复盘写成可执行判断') {
  return new NextRequest('http://localhost/api/research/topic-selection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      runId: 'topic-run',
      snapshotPath: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshotSha256: 'a'.repeat(64),
      topic,
      suggestionId: 'topic-2',
    }),
  });
}

describe('POST /api/research/topic-selection', () => {
  beforeEach(() => {
    mocks.saved = null;
    mocks.blocked = false;
  });

  it('persists a selected or edited topic on the existing run rather than creating another run', async () => {
    const response = await POST(request());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.saved).toEqual({
      runId: 'topic-run',
      topic: '把一次客户复盘写成可执行判断',
      snapshotPath: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshotSha256: 'a'.repeat(64),
      suggestionId: 'topic-2',
    });
    expect(payload).toMatchObject({ ok: true, runId: 'topic-run', runSlug: 'neutral-material-run' });
  });

  it('keeps topic persistence blocked when the snapshot guard fails', async () => {
    mocks.blocked = true;
    const response = await POST(request());

    expect(response.status).toBe(424);
    expect(mocks.saved).toBeNull();
  });
});
