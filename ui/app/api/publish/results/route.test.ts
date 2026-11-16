import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-results-route-${process.pid}`,
  approval: true,
  registrations: [] as Array<{ scope: string; path: string; runId?: string }>,
  lockKeys: [] as string[],
}));

vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => { await mkdir(mocks.projectDir, { recursive: true }); },
}));

vi.mock('@/lib/project-root', async () => {
  const pathModule = await import('node:path');
  return {
    PROJECT_DIR: mocks.projectDir,
    redactLocalPaths: <T>(value: T) => value,
    safeResolve: (base: string, target: string) => {
      const resolved = pathModule.resolve(base, target);
      const root = pathModule.resolve(base);
      return resolved === root || resolved.startsWith(`${root}${pathModule.sep}`) ? resolved : null;
    },
  };
});

vi.mock('@/lib/runtime-writer', () => ({
  getRuntimeProductionApproval: async () => ({ approved: mocks.approval }),
  registerRuntimePhaseArtifact: async (scope: string, path: string, runId?: string) => {
    mocks.registrations.push({ scope, path, runId });
    return { registered: true, scope, path, run_id: runId };
  },
}));

vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  withProjectWriteLock: async <T>(key: string, callback: () => Promise<T>) => {
    mocks.lockKeys.push(key);
    return callback();
  },
}));

import { writeDraftQueue, type DraftQueue } from '@/lib/publish/draft-queue';
import {
  createPublicationLedger,
  writePublicationLedger,
  type PublicationLedger,
} from '@/lib/publish/publication-ledger';
import { POST } from './route';

const queuePath = 'materials/publication/drafts/demo/draft-queue.json';
const ledgerPath = 'materials/publication/ledger/demo/publication-ledger.json';
const jobId = 'draft_0123456789abcdef0123';

function queue(): DraftQueue {
  return {
    schema: 'aifios.publication-draft-queue.v1',
    queue_id: 'queue_demo',
    run_id: 'demo-run',
    run_slug: 'demo',
    package_path: 'pipeline/package/demo.md',
    package_sha256: 'a'.repeat(64),
    created_at: '2026-07-15T00:00:00.000Z',
    updated_at: '2026-07-15T00:00:00.000Z',
    jobs: [{
      job_id: jobId,
      platform: 'wechat',
      item_id: 'wechat-article',
      item_label: '公众号长文',
      delivery_kind: 'draft_fill',
      adapter: 'wechat_official_api',
      payload: { title: '文章', asset_paths: [] },
      payload_hash: 'b'.repeat(64),
      content_hash: 'c'.repeat(64),
      selected_asset_hashes: [{ path: 'pipeline/visual/demo/cover.png', sha256: 'd'.repeat(64) }],
      status: 'draft_filled',
      authorization_state: 'authorized',
      attempt_count: 1,
      retry_count: 0,
      events: [],
    }],
  };
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/publish/results', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function saveOldLedger(withRecord: boolean): Promise<PublicationLedger> {
  const oldQueue = { ...queue(), queue_id: 'queue_old' };
  const ledger = createPublicationLedger({
    queue: oldQueue,
    queuePath,
    queueSha256: 'f'.repeat(64),
    now: '2026-07-14T00:00:00.000Z',
  });
  if (withRecord) {
    const job = oldQueue.jobs[0];
    ledger.records.push({
      record_id: 'publication_old_evidence',
      queue_id: oldQueue.queue_id,
      job_id: job.job_id,
      platform: job.platform,
      item_id: job.item_id,
      final_content_hash: job.content_hash,
      payload_hash: job.payload_hash,
      selected_asset_hashes: job.selected_asset_hashes,
      published_url: 'https://example.com/old-publication',
      published_at: '2026-07-14T12:00:00.000Z',
      human_confirmed: true,
      recorded_at: '2026-07-14T12:00:00.000Z',
    });
  }
  await writePublicationLedger(ledgerPath, ledger);
  return ledger;
}

describe('POST /api/publish/results', () => {
  beforeEach(async () => {
    mocks.approval = true;
    mocks.registrations = [];
    mocks.lockKeys = [];
    await rm(mocks.projectDir, { recursive: true, force: true });
    await mkdir(mocks.projectDir, { recursive: true });
    await mkdir(path.join(mocks.projectDir, 'materials', 'publish-proof'), { recursive: true });
    await writeFile(path.join(mocks.projectDir, 'materials', 'publish-proof', 'moments-proof.png'), 'proof');
    await writeDraftQueue(queuePath, queue());
  });

  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('requires an explicit human checkbox and valid publication evidence', async () => {
    const noCheckbox = await POST(request({ queuePath, jobId, humanConfirmed: false, publicationUrl: 'https://example.com/post' }));
    expect(noCheckbox.status).toBe(400);

    const noUrl = await POST(request({ queuePath, jobId, humanConfirmed: true, publicationUrl: 'not-a-url' }));
    expect(noUrl.status).toBe(400);
    expect(await noUrl.json()).toMatchObject({ code: 'invalid_request' });

    const noEvidence = await POST(request({ queuePath, jobId, humanConfirmed: true }));
    expect(noEvidence.status).toBe(400);
    expect(await noEvidence.json()).toMatchObject({ code: 'invalid_request' });
  });

  it('accepts a hash-bound local proof when a platform has no public URL', async () => {
    const response = await POST(request({
      queuePath,
      jobId,
      humanConfirmed: true,
      proofPath: 'materials/publish-proof/moments-proof.png',
      publishedAt: '2026-07-15T12:00:00.000Z',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.record.published_url).toBeUndefined();
    expect(payload.record.proof_path).toBe('materials/publish-proof/moments-proof.png');
    expect(payload.record.proof_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(mocks.lockKeys).toEqual([
      'publication-draft-queue:materials/publication/drafts/demo/draft-queue.json',
    ]);
  });

  it('records immutable evidence and registers the publication-result artifact', async () => {
    const response = await POST(request({
      queuePath,
      jobId,
      humanConfirmed: true,
      publicationUrl: 'https://mp.weixin.qq.com/s/example',
      publishedAt: '2026-07-15T12:00:00.000Z',
      notes: '已由操作者在平台内发送。',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.record.human_confirmed).toBe(true);
    expect(payload.record.final_content_hash).toBe('c'.repeat(64));
    expect(payload.record.selected_asset_hashes).toEqual([{ path: 'pipeline/visual/demo/cover.png', sha256: 'd'.repeat(64) }]);
    expect(payload.ledgerPath).toBe('materials/publication/ledger/demo/publication-ledger.json');
    expect(mocks.registrations).toEqual([{
      scope: 'publication_result',
      path: 'materials/publication/ledger/demo/publication-ledger.json',
      runId: 'demo-run',
    }]);

    const ledger = JSON.parse(await readFile(path.join(mocks.projectDir, payload.ledgerPath), 'utf-8'));
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0].published_url).toBe('https://mp.weixin.qq.com/s/example');
  });

  it('rejects publication evidence for a downloadable execution package', async () => {
    const executionQueue = queue();
    executionQueue.jobs[0] = {
      ...executionQueue.jobs[0],
      platform: 'shipinhao',
      item_id: 'shipinhao-video-execution-1',
      item_label: '视频号口播执行包 1',
      delivery_kind: 'execution_package',
      adapter: 'download',
      status: 'draft_filled',
    };
    await writeDraftQueue(queuePath, executionQueue);

    const response = await POST(request({
      queuePath,
      jobId,
      humanConfirmed: true,
      publicationUrl: 'https://example.com/should-not-be-recorded',
    }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({ code: 'execution_package_not_publishable' });
    expect(mocks.registrations).toEqual([]);
    await expect(readFile(path.join(mocks.projectDir, ledgerPath), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    const savedQueue = JSON.parse(await readFile(path.join(mocks.projectDir, queuePath), 'utf-8'));
    expect(savedQueue.jobs[0].status).toBe('draft_filled');
  });

  it('archives an empty obsolete ledger and atomically rebinds the canonical path to the new queue', async () => {
    const oldLedger = await saveOldLedger(false);

    const response = await POST(request({
      queuePath,
      jobId,
      humanConfirmed: true,
      publicationUrl: 'https://example.com/new-publication',
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.archivedLedgerPath).toMatch(/^materials\/publication\/ledger\/demo\/archive\/ledger-[a-f0-9]{64}\.json$/);
    const archived = JSON.parse(await readFile(path.join(mocks.projectDir, payload.archivedLedgerPath), 'utf-8'));
    const current = JSON.parse(await readFile(path.join(mocks.projectDir, ledgerPath), 'utf-8'));
    expect(archived.queue_id).toBe(oldLedger.queue_id);
    expect(archived.records).toEqual([]);
    expect(current.queue_id).toBe('queue_demo');
    expect(current.queue_contract_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(current.records).toHaveLength(1);
  });

  it('does not rotate a ledger or write evidence when live queue lineage approval is invalid', async () => {
    const oldLedger = await saveOldLedger(false);
    mocks.approval = false;

    const response = await POST(request({
      queuePath,
      jobId,
      humanConfirmed: true,
      publicationUrl: 'https://example.com/must-not-save',
    }));
    const current = JSON.parse(await readFile(path.join(mocks.projectDir, ledgerPath), 'utf-8'));

    expect(response.status).toBe(409);
    expect(current.queue_id).toBe(oldLedger.queue_id);
    expect(current.records).toEqual([]);
    expect(mocks.registrations).toEqual([]);
  });

  it('blocks a rebuilt queue when the obsolete ledger already contains real publication evidence', async () => {
    const oldLedger = await saveOldLedger(true);

    const response = await POST(request({
      queuePath,
      jobId,
      humanConfirmed: true,
      publicationUrl: 'https://example.com/new-publication',
    }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({
      code: 'publication_lineage_changed',
      action: { label: '新建本期任务', href: '/production' },
    });
    expect(JSON.stringify(payload)).not.toContain('materials/publication/ledger');
    const archiveDir = path.join(mocks.projectDir, 'materials/publication/ledger/demo/archive');
    const [archivedName] = await readdir(archiveDir);
    expect(archivedName).toMatch(/^ledger-[a-f0-9]{64}\.json$/);
    const archived = JSON.parse(await readFile(path.join(archiveDir, archivedName), 'utf-8'));
    expect(archived.queue_id).toBe(oldLedger.queue_id);
    expect(archived.records).toHaveLength(1);
    const current = JSON.parse(await readFile(path.join(mocks.projectDir, ledgerPath), 'utf-8'));
    expect(current.queue_id).toBe(oldLedger.queue_id);
    expect(current.records).toHaveLength(1);
  });
});
