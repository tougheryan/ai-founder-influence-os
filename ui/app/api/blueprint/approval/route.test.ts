import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  approved: false,
  approvalCalls: [] as Array<{ path: string; runId?: string }>,
}));

vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => {},
}));

vi.mock('@/lib/project-root', () => ({
  redactLocalPaths: <T>(value: T) => value,
}));

vi.mock('@/lib/runtime-run-resolver', () => ({
  runsForPipelinePath: async () => [{
    run_id: 'topic-run',
    slug: 'topic',
    steps: { blueprint: { latest: 'pipeline/blueprint/topic-blueprint.md' } },
  }],
}));

vi.mock('@/lib/runtime-writer', () => ({
  validateRuntimeOutput: async () => ({ valid: true, result: { valid: true } }),
  approveRuntimeBlueprint: async (path: string, runId?: string) => {
    mocks.approvalCalls.push({ path, runId });
    mocks.approved = true;
    return { approved: true, run_id: runId, path };
  },
  getRuntimeBlueprintApproval: async () => ({ approved: mocks.approved }),
}));

import { GET, POST } from './route';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/blueprint/approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('blueprint approval route', () => {
  beforeEach(() => {
    mocks.approved = false;
    mocks.approvalCalls = [];
  });

  it('approves only the current blueprint of its bound run', async () => {
    const response = await POST(request({
      blueprintPath: 'pipeline/blueprint/topic-blueprint.md',
      runId: 'topic-run',
    }));

    expect(response.status).toBe(200);
    expect(mocks.approvalCalls).toEqual([{
      path: 'pipeline/blueprint/topic-blueprint.md',
      runId: 'topic-run',
    }]);

    const status = await GET(new NextRequest(
      'http://localhost/api/blueprint/approval?blueprintPath=pipeline%2Fblueprint%2Ftopic-blueprint.md&runId=topic-run',
    ));
    expect((await status.json()).approved).toBe(true);
  });

  it('rejects an approval request bound to another run', async () => {
    const response = await POST(request({
      blueprintPath: 'pipeline/blueprint/topic-blueprint.md',
      runId: 'other-run',
    }));

    expect(response.status).toBe(400);
    expect(mocks.approvalCalls).toEqual([]);
  });
});
