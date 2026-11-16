import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  calls: [] as Array<{ scope: string; path: string; runId?: string }>,
  approval: { approved: true, scope: 'content_package', run_id: 'content-run' },
  written: [] as Array<{ step: string; slug: string; content: string; source: string; runId?: string }>,
  releaseGate: {
    status: 'pass' as 'pass' | 'review_required' | 'blocked',
    repaired: false,
    repairedBody: '# 内容包',
    blocking_issues: [] as string[],
    review_issues: [] as string[],
    units: [] as Array<Record<string, unknown>>,
  },
  planStatus: 'current',
  reviewedPlan: '',
  artifactBody: '# 内容包',
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/runtime-run-resolver', () => ({
  runsForPipelinePath: async (path: string) => [path.includes('materials/publication/ledger/')
    ? {
      run_id: 'content-run',
      slug: 'content-run',
      steps: {},
      phase_artifacts: {
        publication_result: { path: 'materials/publication/ledger/content-run/publication-ledger.json' },
      },
    }
    : path.includes('materials/publication/drafts/')
      ? {
        run_id: 'content-run',
        slug: 'content-run',
        steps: {},
        phase_artifacts: {
          draft_information: { path: 'materials/publication/drafts/content-run/draft-queue.json' },
        },
      }
    : {
      run_id: 'content-run',
      slug: 'content-run',
      steps: { package: { latest: 'pipeline/package/content-package.md' } },
    }],
}));
vi.mock('@/lib/runtime-writer', () => ({
  getRuntimeContentPlanStatus: async () => ({ status: mocks.planStatus, blueprint_sha256: 'a'.repeat(64), blueprint_path: 'pipeline/blueprint/current.md', package_path: 'pipeline/package/content-package.md' }),
  approveRuntimeProductionArtifact: async (scope: string, path: string, runId?: string, reviewedPlan?: string) => {
    mocks.reviewedPlan = reviewedPlan || '';
    mocks.calls.push({ scope, path, runId });
    return { ...mocks.approval, scope, run_id: runId, path };
  },
  getRuntimeProductionApproval: async (scope: string, path: string, runId?: string) => ({
    ...mocks.approval,
    scope,
    path,
    run_id: runId,
  }),
  writeRuntimeOutput: async (step: string, slug: string, content: string, source: string, runId?: string) => {
    mocks.written.push({ step, slug, content, source, runId });
    return 'pipeline/package/repaired-content-package.md';
  },
}));
vi.mock('@/lib/output-files', () => ({ readOutputFile: async () => mocks.artifactBody }));
vi.mock('@/lib/content-release-gate', () => ({ runContentReleaseGate: async () => mocks.releaseGate }));

import { GET, POST } from './route';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/production/approval', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('production approval route', () => {
  beforeEach(() => {
    mocks.calls = [];
    mocks.planStatus = 'current';
    mocks.reviewedPlan = '';
    mocks.written = [];
    mocks.approval = { approved: true, scope: 'content_package', run_id: 'content-run' };
    mocks.releaseGate = {
      status: 'pass',
      repaired: false,
      repairedBody: '# 内容包',
      blocking_issues: [],
      review_issues: [],
      units: [],
    };
    mocks.artifactBody = '# 内容包';
  });

  it('approves a current phase artifact through the runtime-bound hash contract', async () => {
    const response = await POST(request({
      scope: 'content_package',
      path: 'pipeline/package/content-package.md',
      runId: 'content-run',
      approved: true,
    }));

    expect(response.status).toBe(200);
    expect(mocks.calls).toEqual([{
      scope: 'content_package',
      path: 'pipeline/package/content-package.md',
      runId: 'content-run',
    }]);
  });

  it('requires an explicit review of the current plan before retaining an older draft', async () => {
    mocks.planStatus = 'outdated';
    const input = { scope: 'content_package', path: 'pipeline/package/content-package.md', runId: 'content-run' };
    expect((await POST(request(input))).status).toBe(409);
    expect((await POST(request({ ...input, reviewedPlanSha256: 'b'.repeat(64) }))).status).toBe(409);
    expect(mocks.calls).toEqual([]);
    expect((await POST(request({ ...input, reviewedPlanSha256: 'a'.repeat(64) }))).status).toBe(200);
    expect(mocks.reviewedPlan).toBe('a'.repeat(64));
  });

  it('rejects a request whose run does not own the artifact', async () => {
    const response = await POST(request({
      scope: 'content_package',
      path: 'pipeline/package/content-package.md',
      runId: 'other-run',
    }));

    expect(response.status).toBe(400);
    expect(mocks.calls).toEqual([]);
  });

  it('allows explicit human confirmation when the release gate only needs review', async () => {
    mocks.releaseGate = {
      ...mocks.releaseGate,
      status: 'review_required',
      review_issues: ['仍有明显模板化 AI 表达，需要人工确认语气。'],
    };

    const response = await POST(request({
      scope: 'content_package',
      path: 'pipeline/package/content-package.md',
      runId: 'content-run',
    }));

    expect(response.status).toBe(200);
    expect(mocks.calls).toEqual([{
      scope: 'content_package',
      path: 'pipeline/package/content-package.md',
      runId: 'content-run',
    }]);
  });

  it('blocks owner confirmation when selected-platform content is structurally incomplete', async () => {
    mocks.releaseGate = {
      ...mocks.releaseGate,
      status: 'blocked',
      blocking_issues: ['视频执行稿缺少可发布的口播内容。'],
    };

    const response = await POST(request({
      scope: 'content_package',
      path: 'pipeline/package/content-package.md',
      runId: 'content-run',
    }));

    expect(response.status).toBe(400);
    expect(mocks.calls).toEqual([]);
  });

  it('does not rewrite the generated package during owner confirmation', async () => {
    mocks.releaseGate = { ...mocks.releaseGate, repaired: true, repairedBody: '# 已修订内容包' };

    const response = await POST(request({
      scope: 'content_package',
      path: 'pipeline/package/content-package.md',
      runId: 'content-run',
    }));

    expect(response.status).toBe(200);
    expect(mocks.calls).toEqual([{
      scope: 'content_package',
      path: 'pipeline/package/content-package.md',
      runId: 'content-run',
    }]);
    expect(mocks.written).toEqual([]);
  });

  it('rejects a path that does not belong to the requested approval scope', async () => {
    const response = await POST(request({
      scope: 'content_package',
      path: 'pipeline/blueprint/content-blueprint.md',
      runId: 'content-run',
    }));

    expect(response.status).toBe(400);
    expect(mocks.calls).toEqual([]);
  });

  it('rejects an empty or incomplete draft queue before the runtime approval command runs', async () => {
    mocks.artifactBody = JSON.stringify({
      schema: 'aifios.publication-draft-queue.v1',
      run_id: 'content-run',
      run_slug: 'content-run',
      package_path: 'pipeline/package/content-package.md',
      jobs: [],
    });

    const response = await POST(request({
      scope: 'draft_information',
      path: 'materials/publication/drafts/content-run/draft-queue.json',
      runId: 'content-run',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.calls).toEqual([]);
  });

  it('reads only the current run status', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/production/approval?scope=content_package&path=pipeline%2Fpackage%2Fcontent-package.md&runId=content-run',
    ));

    expect(response.status).toBe(200);
    expect((await response.json()).approved).toBe(true);
  });

  it('accepts a local publication ledger phase artifact rather than requiring legacy publish Markdown', async () => {
    const response = await POST(request({
      scope: 'publication_result',
      path: 'materials/publication/ledger/content-run/publication-ledger.json',
      runId: 'content-run',
    }));

    expect(response.status).toBe(200);
    expect(mocks.calls.at(-1)).toEqual({
      scope: 'publication_result',
      path: 'materials/publication/ledger/content-run/publication-ledger.json',
      runId: 'content-run',
    });
  });
});
