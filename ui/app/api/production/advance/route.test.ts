import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  approvalBody: null as Record<string, unknown> | null,
  approvalCalls: 0,
  queue: null as Record<string, unknown> | null,
  runTemplate: 'editorial',
  run: {} as Record<string, unknown>,
  fileHashes: {} as Record<string, string>,
  approvalStatus: true,
  lockFailure: false,
  copyMismatch: false,
  cache: new Map<string, unknown>(),
}));

vi.mock('@/lib/publish-copy-integrity', () => ({
  verifyNativeXhsQueueCopy: async () => {
    if (mocks.copyMismatch) throw new Error('copy mismatch');
  },
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/app/api/production/approval/route', () => ({
  POST: async (req: Request) => {
    mocks.approvalCalls += 1;
    mocks.approvalBody = await req.json() as Record<string, unknown>;
    return Response.json({ approved: true, path: mocks.approvalBody.path });
  },
}));
vi.mock('@/lib/write-guard', () => {
  class WriteLockError extends Error {}
  return {
    WriteLockError,
    withProjectWriteLock: async (_key: string, task: () => Promise<unknown>) => {
      if (mocks.lockFailure) throw new WriteLockError('同一任务正在执行');
      return task();
    },
    writeFingerprint: (scope: string, value: unknown) => `${scope}:${JSON.stringify(value)}`,
    readIdempotentResult: async (key: string) => mocks.cache.get(key) || null,
    rememberIdempotentResult: async (key: string, value: unknown) => { mocks.cache.set(key, value); },
  };
});
vi.mock('@/lib/brand-template-config', () => ({
  BrandTemplateResolutionError: class BrandTemplateResolutionError extends Error {},
  resolveConfiguredBrandTemplate: async (id: string) => ({ id, layoutStyle: id }),
}));
vi.mock('@/lib/runtime-run-resolver', () => ({
  runtimeRunById: async () => ({ ...mocks.run, visual_template: mocks.runTemplate }),
}));
vi.mock('@/lib/runtime-writer', () => ({
  getRuntimeProductionApproval: async () => ({ approved: mocks.approvalStatus }),
}));
vi.mock('@/lib/publish/draft-queue', () => ({
  isDraftQueuePath: (path: string) => /^materials\/publication\/drafts\/demo\/draft-queue\.json$/.test(path),
  queuePathForRun: (slug: string) => `materials/publication/drafts/${slug}/draft-queue.json`,
  hashProjectFiles: async (paths: string[]) => Object.fromEntries(paths.map((path) => [path, mocks.fileHashes[path] || ''])),
  readDraftQueue: async () => mocks.queue,
}));

import { POST } from './route';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/production/advance', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fullQueue(status = 'draft_filled') {
  const contract = [
    ['wechat', 'wechat-article', 'draft_fill'],
    ['xiaohongshu', 'xiaohongshu-opinion-1', 'draft_fill'],
    ['xiaohongshu', 'xiaohongshu-opinion-2', 'draft_fill'],
    ['xiaohongshu', 'xiaohongshu-opinion-3', 'draft_fill'],
    ['moments', 'moments-opinion-1', 'draft_fill'],
    ['moments', 'moments-opinion-2', 'draft_fill'],
    ['moments', 'moments-opinion-3', 'draft_fill'],
    ['shipinhao', 'shipinhao-video-execution-1', 'execution_package'],
    ['shipinhao', 'shipinhao-video-execution-2', 'execution_package'],
    ['douyin', 'douyin-video-execution-1', 'execution_package'],
    ['douyin', 'douyin-video-execution-2', 'execution_package'],
  ] as const;
  return {
    schema: 'aifios.publication-draft-queue.v1',
    queue_id: 'queue-demo',
    run_id: 'demo-run',
    run_slug: 'demo',
    package_path: 'pipeline/package/demo.md',
    package_sha256: 'a'.repeat(64),
    visual_manifest_path: 'pipeline/visual/demo/selected-assets.json',
    visual_manifest_sha256: 'b'.repeat(64),
    jobs: contract.map(([platform, itemId, deliveryKind], index) => ({
      platform,
      status,
      job_id: `${platform}-${index}`,
      item_id: itemId,
      delivery_kind: deliveryKind,
    })),
  };
}

function reviewAssertions(stage: 'topic-template' | 'content-package' | 'draft-information') {
  return stage === 'topic-template'
    ? {
      market_evidence_reviewed: true,
      topic_boundary_and_goal_confirmed: true,
      brand_template_confirmed: true,
    }
    : stage === 'content-package'
      ? {
        content_article_reviewed: true,
        content_video_1_reviewed: true,
        content_video_2_reviewed: true,
        content_opinion_1_reviewed: true,
        content_opinion_2_reviewed: true,
        content_opinion_3_reviewed: true,
      }
    : {
      platform_payloads_reviewed: true,
      visual_order_reviewed: true,
      human_send_boundary_confirmed: true,
    };
}

describe('POST /api/production/advance', () => {
  beforeEach(() => {
    mocks.approvalBody = null;
    mocks.approvalCalls = 0;
    mocks.queue = null;
    mocks.runTemplate = 'editorial';
    mocks.run = {
      run_id: 'demo-run',
      slug: 'demo',
      steps: { package: { latest: 'pipeline/package/demo.md' } },
      phase_artifacts: {
        visual_assets: { path: 'pipeline/visual/demo/selected-assets.json' },
      },
    };
    mocks.fileHashes = {
      'pipeline/package/demo.md': 'a'.repeat(64),
      'pipeline/visual/demo/selected-assets.json': 'b'.repeat(64),
    };
    mocks.approvalStatus = true;
    mocks.lockFailure = false;
    mocks.copyMismatch = false;
    mocks.cache.clear();
  });

  it('requires the chosen template to already be bound before approving the frozen topic artifact', async () => {
    const response = await POST(request({
      stage: 'topic-template',
      runId: 'demo-run',
      artifactPath: 'pipeline/blueprint/demo.md',
      templateId: 'editorial',
      reviewAssertions: reviewAssertions('topic-template'),
    }));

    expect(response.status).toBe(200);
    expect(mocks.approvalBody).toEqual({
      scope: 'topic_template', path: 'pipeline/blueprint/demo.md', runId: 'demo-run',
    });
    expect((await response.json()).advanced).toBe(true);
  });

  it('uses runtime author mode for review assertions, ignoring a browser claim of market review', async () => {
    mocks.run.research_mode = 'author_material';
    const body = { stage: 'topic-template', runId: 'demo-run', artifactPath: 'pipeline/blueprint/demo.md', templateId: 'editorial' };
    const rejected = await POST(request({ ...body, reviewAssertions: reviewAssertions('topic-template') }));
    expect(rejected.status).toBe(409); expect(mocks.approvalCalls).toBe(0);
    const accepted = await POST(request({ ...body, reviewAssertions: { author_source_reviewed: true, topic_boundary_and_goal_confirmed: true, brand_template_confirmed: true } }));
    expect(accepted.status).toBe(200); expect(mocks.approvalCalls).toBe(1);
  });

  it('does not repeat a template write and rejects a stale template binding', async () => {
    mocks.runTemplate = 'publish_template';
    const response = await POST(request({
      stage: 'topic-template',
      runId: 'demo-run',
      artifactPath: 'pipeline/blueprint/demo.md',
      templateId: 'editorial',
      reviewAssertions: reviewAssertions('topic-template'),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'production_precondition_failed' });
    expect(mocks.approvalBody).toBeNull();
  });

  it('does not approve an incomplete five-platform draft queue', async () => {
    const queue = fullQueue();
    queue.jobs.pop();
    mocks.queue = queue;

    const response = await POST(request({
      stage: 'draft-information',
      runId: 'demo-run',
      artifactPath: 'materials/publication/drafts/demo/draft-queue.json',
      queuePath: 'materials/publication/drafts/demo/draft-queue.json',
      reviewAssertions: reviewAssertions('draft-information'),
    }));

    expect(response.status).toBe(409);
    expect(mocks.approvalBody).toBeNull();
  });

  it('does not approve a queue whose native copy differs from the reviewed source', async () => {
    mocks.queue = fullQueue();
    mocks.copyMismatch = true;
    const response = await POST(request({
      stage: 'draft-information', runId: 'demo-run',
      artifactPath: 'materials/publication/drafts/demo/draft-queue.json',
      queuePath: 'materials/publication/drafts/demo/draft-queue.json',
      reviewAssertions: reviewAssertions('draft-information'),
    }));
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain('重新整理成品');
    expect(mocks.approvalCalls).toBe(0);
  });

  it('rejects a structurally valid queue when it belongs to another run', async () => {
    mocks.queue = { ...fullQueue(), run_id: 'other-run' };

    const response = await POST(request({
      stage: 'draft-information',
      runId: 'demo-run',
      artifactPath: 'materials/publication/drafts/demo/draft-queue.json',
      queuePath: 'materials/publication/drafts/demo/draft-queue.json',
      reviewAssertions: reviewAssertions('draft-information'),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
    expect(mocks.approvalBody).toBeNull();
  });

  it('rejects re-approving an old queue after the current run package changes', async () => {
    mocks.queue = fullQueue();
    const body = {
      stage: 'draft-information',
      runId: 'demo-run',
      artifactPath: 'materials/publication/drafts/demo/draft-queue.json',
      queuePath: 'materials/publication/drafts/demo/draft-queue.json',
      reviewAssertions: reviewAssertions('draft-information'),
      requestId: 'approval-old-queue-0001',
    };
    const first = await POST(request(body));
    mocks.run = {
      ...mocks.run,
      steps: { package: { latest: 'pipeline/package/demo-v2.md' } },
    };
    mocks.fileHashes['pipeline/package/demo-v2.md'] = 'c'.repeat(64);
    const replay = await POST(request(body));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: 'production_precondition_failed' });
    expect(mocks.approvalCalls).toBe(1);
  });

  it('rejects a queue whose saved upstream hashes no longer match current bytes', async () => {
    mocks.queue = fullQueue();
    mocks.fileHashes['pipeline/visual/demo/selected-assets.json'] = 'c'.repeat(64);

    const response = await POST(request({
      stage: 'draft-information',
      runId: 'demo-run',
      artifactPath: 'materials/publication/drafts/demo/draft-queue.json',
      queuePath: 'materials/publication/drafts/demo/draft-queue.json',
      reviewAssertions: reviewAssertions('draft-information'),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'production_precondition_failed' });
    expect(mocks.approvalBody).toBeNull();
  });

  it('does not approve a topic or draft stage until every required human review assertion is explicit', async () => {
    const topic = await POST(request({
      stage: 'topic-template',
      runId: 'demo-run',
      artifactPath: 'pipeline/blueprint/demo.md',
      templateId: 'editorial',
      reviewAssertions: { market_evidence_reviewed: true },
    }));

    expect(topic.status).toBe(409);
    expect(await topic.json()).toMatchObject({ code: 'production_precondition_failed' });
    expect(mocks.approvalBody).toBeNull();

    mocks.queue = fullQueue();
    const draft = await POST(request({
      stage: 'draft-information',
      runId: 'demo-run',
      artifactPath: 'materials/publication/drafts/demo/draft-queue.json',
      queuePath: 'materials/publication/drafts/demo/draft-queue.json',
      reviewAssertions: { platform_payloads_reviewed: true },
    }));

    expect(draft.status).toBe(409);
    expect(await draft.json()).toMatchObject({ code: 'production_precondition_failed' });
    expect(mocks.approvalBody).toBeNull();
  });

  it('does not approve a content package until all six deliverable units are directly reviewed', async () => {
    const incomplete = await POST(request({
      stage: 'content-package',
      runId: 'demo-run',
      artifactPath: 'pipeline/package/demo.md',
      reviewAssertions: {
        content_article_reviewed: true,
        content_video_1_reviewed: true,
        content_video_2_reviewed: true,
        content_opinion_1_reviewed: true,
        content_opinion_2_reviewed: true,
      },
    }));

    expect(incomplete.status).toBe(409);
    expect(await incomplete.json()).toMatchObject({ code: 'production_precondition_failed' });
    expect(mocks.approvalBody).toBeNull();

    const complete = await POST(request({
      stage: 'content-package',
      runId: 'demo-run',
      artifactPath: 'pipeline/package/demo.md',
      reviewAssertions: reviewAssertions('content-package'),
    }));

    expect(complete.status).toBe(200);
    expect(mocks.approvalBody).toEqual({
      scope: 'content_package', path: 'pipeline/package/demo.md', runId: 'demo-run',
    });
  });

  it('requires seven human-confirmed drafts and four ready download packages', async () => {
    const completedQueue = fullQueue('published_confirmed');
    completedQueue.jobs = completedQueue.jobs.map((job) => job.delivery_kind === 'execution_package'
      ? { ...job, status: 'draft_filled', adapter: 'download' }
      : job);
    mocks.queue = completedQueue;

    const response = await POST(request({
      stage: 'publication-result',
      runId: 'demo-run',
      artifactPath: 'materials/publication/ledger/demo/publication-ledger.json',
      queuePath: 'materials/publication/drafts/demo/draft-queue.json',
    }));

    expect(response.status).toBe(200);
    expect(mocks.approvalBody).toEqual({
      scope: 'publication_result',
      path: 'materials/publication/ledger/demo/publication-ledger.json',
      runId: 'demo-run',
    });
  });

  it('serializes confirmation and replays an explicit idempotency key without approving twice', async () => {
    const body = {
      stage: 'content-package',
      runId: 'demo-run',
      artifactPath: 'pipeline/package/demo.md',
      reviewAssertions: reviewAssertions('content-package'),
      requestId: 'approval-request-0001',
    };

    const first = await POST(request(body));
    const second = await POST(request(body));

    expect(first.status).toBe(200);
    expect((await first.json()).idempotent_replay).toBe(false);
    expect(second.status).toBe(200);
    expect((await second.json()).idempotent_replay).toBe(true);
    expect(mocks.approvalCalls).toBe(1);
  });

  it('rejects reusing one idempotency key with a different confirmation payload', async () => {
    const body = {
      stage: 'content-package',
      runId: 'demo-run',
      artifactPath: 'pipeline/package/demo.md',
      reviewAssertions: reviewAssertions('content-package'),
      requestId: 'approval-request-conflict-0001',
    };

    const first = await POST(request(body));
    const conflicting = await POST(request({
      ...body,
      artifactPath: 'pipeline/package/different.md',
    }));

    expect(first.status).toBe(200);
    expect(conflicting.status).toBe(409);
    expect(await conflicting.json()).toMatchObject({ code: 'content_changed' });
    expect(mocks.approvalCalls).toBe(1);
  });

  it('does not replay a cached success after the runtime approval has been invalidated', async () => {
    const body = {
      stage: 'content-package',
      runId: 'demo-run',
      artifactPath: 'pipeline/package/demo.md',
      reviewAssertions: reviewAssertions('content-package'),
      requestId: 'approval-request-invalidated-0001',
    };

    const first = await POST(request(body));
    mocks.approvalStatus = false;
    const replay = await POST(request(body));

    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: 'content_changed' });
    expect(mocks.approvalCalls).toBe(1);
  });

  it('returns a recoverable conflict when another confirmation owns the write lock', async () => {
    mocks.lockFailure = true;

    const response = await POST(request({
      stage: 'content-package',
      runId: 'demo-run',
      artifactPath: 'pipeline/package/demo.md',
      reviewAssertions: reviewAssertions('content-package'),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'content_changed' });
    expect(mocks.approvalCalls).toBe(0);
  });
});
