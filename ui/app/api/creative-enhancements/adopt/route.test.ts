import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  input: null as Record<string, string> | null,
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/creative-enhancements', () => ({
  CreativeEnhancementError: class CreativeEnhancementError extends Error {},
  adoptCreativeEnhancement: async (input: Record<string, string>) => {
    mocks.input = input;
    return {
      item: { id: 'enhancement_demo', ...input },
      archivePath: 'materials/creative-enhancements/client-a/run-a/adoptions.json',
    };
  },
}));

import { POST } from './route';

describe('POST /api/creative-enhancements/adopt', () => {
  beforeEach(() => {
    mocks.input = null;
  });

  it('persists only an explicit run-scoped DBS adoption', async () => {
    const response = await POST(new NextRequest('http://localhost/api/creative-enhancements/adopt', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'run-a',
        projectId: 'client-a',
        stage: 'topic-template',
        tool: 'dbs-diagnosis',
        sourcePath: 'pipeline/dbs-fusion/diagnosis.md',
        adoptedText: '只把这条结论用于本期内容。',
      }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.input).toEqual({
      runId: 'run-a',
      projectId: 'client-a',
      stage: 'topic-template',
      tool: 'dbs-diagnosis',
      sourcePath: 'pipeline/dbs-fusion/diagnosis.md',
      adoptedText: '只把这条结论用于本期内容。',
    });
  });
});
