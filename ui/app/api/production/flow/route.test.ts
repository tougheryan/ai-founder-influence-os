import { NextRequest, NextResponse } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  marketBody: null as Record<string, unknown> | null,
  draftBody: null as Record<string, unknown> | null,
  requestedRunId: undefined as string | undefined,
}));

vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => undefined }));
vi.mock('@/lib/project-root', () => ({ redactLocalPaths: <T>(value: T) => value }));
vi.mock('@/lib/production-integrity', () => ({
  resolveProductionIntegrityRun: async (runId?: string) => {
    mocks.requestedRunId = runId;
    return {
      run_id: runId || 'active-run',
      slug: 'demo',
      steps: { package: { latest: 'pipeline/package/demo.md' } },
    };
  },
  buildProductionFlowIntegrity: async (run: { run_id: string; slug: string }) => ({
    run_id: run.run_id,
    slug: run.slug,
    current_phase: { id: 'draft_information', number: 5 },
    artifacts: { content_package: { path: 'pipeline/package/demo.md', sha256: 'a'.repeat(64), exists: true } },
    approvals: { content_package: { approved: true } },
    invalidations: [],
    draft_queue: { path: 'materials/publication/drafts/demo/draft-queue.json', total: 11, complete: true, status_counts: { pending: 11 } },
    publication: { ledger_path: 'materials/publication/ledger/demo/publication-ledger.json', records: 0, confirmed: 0, complete: false },
    weekly_review: { status: 'waiting_metrics', missing_metrics: 3, memory_applied: false },
    resolved_paths: {
      package_path: 'pipeline/package/demo.md',
      deliverables_path: 'pipeline/publish-assets/demo-platform-deliverables.json',
      visual_manifest_path: 'pipeline/visual/demo/selected-assets.json',
      draft_queue_path: 'materials/publication/drafts/demo/draft-queue.json',
      publication_ledger_path: 'materials/publication/ledger/demo/publication-ledger.json',
    },
    recovery: { persistent_tasks: true, write_locking: true, idempotency_supported: true },
  }),
}));

vi.mock('@/app/api/research/market-signal/route', () => ({
  POST: async (req: Request) => {
    mocks.marketBody = await req.json() as Record<string, unknown>;
    return NextResponse.json({ ok: true, path: 'materials/research/demo-market-signal.md' });
  },
}));

vi.mock('@/app/api/publish-assets/route', () => ({
  POST: async (req: Request) => {
    mocks.draftBody = await req.json() as Record<string, unknown>;
    return NextResponse.json({ ok: true, draftQueuePath: 'materials/publication/drafts/demo/draft-queue.json' });
  },
}));

import { GET, POST } from './route';

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/production/flow', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/production/flow', () => {
  it('delegates research without accepting a client-selected platform subset', async () => {
    const response = await POST(request({
      action: 'market_research',
      sourcePath: 'pipeline/intake/demo.md',
      slug: 'demo',
      topic: '主题',
      runId: 'demo-run',
      platforms: ['wechat'],
    }));

    expect(response.status).toBe(200);
    expect(mocks.marketBody).toEqual({
      sourcePath: 'pipeline/intake/demo.md', slug: 'demo', topic: '主题', runId: 'demo-run',
    });
  });

  it('derives the current run package path server-side when preparing platform drafts', async () => {
    const response = await POST(request({
      action: 'prepare_drafts',
      visualManifestPath: 'pipeline/visual/other/selected-assets.json',
    }));

    expect(response.status).toBe(200);
    expect(mocks.draftBody).toEqual({ packagePath: 'pipeline/package/demo.md' });
  });

  it('rejects a stale package path instead of writing another run through the facade', async () => {
    const response = await POST(request({
      action: 'prepare_drafts',
      packagePath: 'pipeline/package/other.md',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  });

  it('rejects unsupported actions before they reach a domain route', async () => {
    const response = await POST(request({ action: 'publish_now' }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  });
});

describe('GET /api/production/flow', () => {
  it('returns a server-resolved integrity snapshot for the requested run', async () => {
    const response = await GET(new NextRequest('http://localhost/api/production/flow?runId=run-42'));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requestedRunId).toBe('run-42');
    expect(payload.integrity).toMatchObject({
      run_id: 'run-42',
      slug: 'demo',
      current_phase: { id: 'draft_information', number: 5 },
      draft_queue: { total: 11, complete: true },
      publication: { confirmed: 0, complete: false },
      resolved_paths: {
        package_path: 'pipeline/package/demo.md',
        visual_manifest_path: 'pipeline/visual/demo/selected-assets.json',
      },
      recovery: { persistent_tasks: true, write_locking: true, idempotency_supported: true },
    });
  });

  it('rejects malformed run IDs before reading runtime state', async () => {
    const response = await GET(new NextRequest('http://localhost/api/production/flow?runId=..%2Fother'));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_request' });
  });
});
