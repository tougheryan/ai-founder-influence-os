import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueueFixture } from '@/electron/fixtures/publication-fixture.cjs';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-draft-route-${process.pid}`,
  approvals: {
    content_package: true,
    visual_assets: true,
    draft_information: true,
  } as Record<string, boolean>,
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

vi.mock('@/lib/runtime-run-resolver', () => ({
  runtimeRunById: async (id: string) => ({ run_id: id, steps: { intake: { latest: 'pipeline/intake/demo.md' } } }),
  runsForPipelinePath: async () => [{
    run_id: 'demo-run',
    slug: 'demo',
    steps: { package: { latest: 'pipeline/package/demo-package.md' } },
  }],
}));

vi.mock('@/lib/runtime-writer', () => ({
  getRuntimeProductionApproval: async (scope: string) => ({ approved: mocks.approvals[scope] === true }),
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

import { GET, POST } from './route';
import {
  DESKTOP_PUBLICATION_RECEIPT_SCHEMA,
  signDesktopPublicationReceiptForTest,
} from '@/lib/publish/desktop-receipt';

const packagePath = 'pipeline/package/demo-package.md';
const deliverablesPath = 'pipeline/publish-assets/demo-platform-deliverables.json';

function post(index: number) {
  return {
    index,
    title: `观点 ${index}`,
    copy: `正文 ${index}`,
    publishForms: {
      xiaohongshu: { title: `小红书 ${index}`, copy: `小红书正文 ${index}`, tags: [], imageOrder: 'P1-P5' },
      moments: { title: `朋友圈 ${index}`, copy: `朋友圈正文 ${index}`, tags: [], imageOrder: 'P1,P3,P5' },
    },
    publishPaths: {
      xiaohongshu: `pipeline/publish-assets/demo/xhs-${index}.md`,
      moments: `pipeline/publish-assets/demo/moments-${index}.md`,
    },
    visualAssets: [],
  };
}

function script(index: number) {
  return {
    index,
    title: `视频 ${index}`,
    oralScript: `口播 ${index}`,
    teleprompterScript: `提词器 ${index}`,
    hook: '钩子',
    duration: '45 秒',
    platformNote: '说明',
    tags: [],
    primaryPath: `pipeline/publish-assets/demo/video-${index}.md`,
    visualAssets: [],
  };
}

async function writeFixture() {
  await mkdir(path.join(mocks.projectDir, 'pipeline/intake'), { recursive: true });
  await writeFile(path.join(mocks.projectDir, 'pipeline/intake/demo.md'), '## 7. 不可公开信息\n- 当前未识别具体限制。\n');
  const posts = [post(1), post(2), post(3)];
  const scripts = [script(1), script(2)];
  const deliverables = {
    wechat: {
      recommendedTitle: '公众号文章',
      summary: '摘要',
      markdownPath: 'pipeline/publish-assets/demo/wechat.md',
      htmlCandidates: [{ path: 'pipeline/publish-assets/demo/wechat.html', recommended: true }],
      copyText: '公众号正文',
      visualAssets: [],
      coverOptions: [],
      shareCopyPaths: [],
    },
    xiaohongshu: { posts },
    moments: { posts },
    shipinhao: { scripts },
    douyin: { scripts },
    archive: { packagePath, reportPath: 'pipeline/publish-assets/demo.md', generatedPaths: [] },
  };
  await mkdir(path.join(mocks.projectDir, 'pipeline', 'package'), { recursive: true });
  await mkdir(path.join(mocks.projectDir, 'pipeline', 'publish-assets'), { recursive: true });
  await mkdir(path.join(mocks.projectDir, 'pipeline', 'visual', 'demo'), { recursive: true });
  await writeFile(path.join(mocks.projectDir, packagePath), '# 内容包\n');
  await writeFile(path.join(mocks.projectDir, deliverablesPath), JSON.stringify(deliverables));
  await writeFile(
    path.join(mocks.projectDir, 'pipeline', 'visual', 'demo', 'selected-assets.json'),
    JSON.stringify({ schema: 'aifios.visual-asset-manifest.v1' }),
  );
  const contentFiles = [
    ['pipeline/publish-assets/demo/wechat.html', '<p>公众号正文</p>'],
    ...posts.flatMap((item) => [
      [item.publishPaths.xiaohongshu, `小红书正文 ${item.index}`],
      [item.publishPaths.moments, `朋友圈正文 ${item.index}`],
    ]),
    ...scripts.map((item) => [item.primaryPath, `视频执行包 ${item.index}`]),
  ] as Array<[string, string]>;
  await Promise.all(contentFiles.map(async ([relativePath, content]) => {
    const target = path.join(mocks.projectDir, relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }));
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/publish/drafts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/publish/drafts', () => {
  beforeEach(async () => {
    mocks.approvals = { content_package: true, visual_assets: true, draft_information: true };
    mocks.registrations = [];
    mocks.lockKeys = [];
    await rm(mocks.projectDir, { recursive: true, force: true });
    await writeFixture();
  });

  afterAll(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('requires the viewed native version and exact full copy before exposing review readiness', async () => {
    const { queue } = await createQueueFixture(mocks.projectDir, { platforms: ['xhs'] });
    const job = queue.jobs[0];
    const query = new URLSearchParams({ queuePath: 'materials/publication/drafts/demo/draft-queue.json', review: '1', source: queue.package_sha256, copy: job.content_hash, payload: job.payload_hash });
    const review = () => GET(new NextRequest(`http://localhost/api/publish/drafts?${query}`));
    const valid = await review();
    expect(valid.status).toBe(200);
    expect(valid.headers.get('cache-control')).toBe('no-store');
    query.set('payload', '0'.repeat(64));
    expect((await review()).status).toBe(409);
    query.set('payload', job.payload_hash);
    await writeFile(path.join(mocks.projectDir, job.payload.copy_path!), '第一段原文。');
    const truncated = await review();
    expect(truncated.status).toBe(409);
    expect((await truncated.json()).error).toContain('重新整理成品');
  });

  it('rejects an approved but truncated native queue before sending any job', async () => {
    await createQueueFixture(mocks.projectDir, { platforms: ['xhs'], content: '第一段原文。' });
    const response = await POST(request({ action: 'execute', queuePath: 'materials/publication/drafts/demo/draft-queue.json' }));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('native_copy_mismatch');
  });

  it('creates and registers a local draft-information queue for the current run', async () => {
    const response = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.queue.jobs).toHaveLength(11);
    expect(payload.queuePath).toBe('materials/publication/drafts/demo/draft-queue.json');
    expect(mocks.registrations).toEqual([{
      scope: 'draft_information',
      path: 'materials/publication/drafts/demo/draft-queue.json',
      runId: 'demo-run',
    }]);
    const stored = JSON.parse(await readFile(path.join(mocks.projectDir, payload.queuePath), 'utf-8'));
    expect(stored.jobs).toHaveLength(11);
  });

  it('retains a local queue but refuses sending internal-only material despite existing approval', async () => {
    const prepared = await (await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }))).json();
    await writeFile(path.join(mocks.projectDir, 'pipeline/intake/demo.md'), '## 7. 不可公开信息\n- 公开边界：不对外发布\n');
    const before = await readFile(path.join(mocks.projectDir, prepared.queuePath), 'utf8');
    for (const action of ['execute', 'retry']) {
      const response = await POST(request({ action, queuePath: prepared.queuePath }));
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('material_internal_only');
      expect(await readFile(path.join(mocks.projectDir, prepared.queuePath), 'utf8')).toBe(before);
    }
    const video = prepared.queue.jobs.find((job: { delivery_kind: string }) => job.delivery_kind === 'execution_package');
    const localOnly = await POST(request({ action: 'execute', queuePath: prepared.queuePath, jobIds: [video.job_id] }));
    expect(localOnly.status).toBe(200);
    expect((await localOnly.json()).attemptedJobIds).toEqual([video.job_id]);
  });

  it('does not send when the current restriction record is corrupt', async () => {
    const prepared = await (await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }))).json();
    await mkdir(path.join(mocks.projectDir, 'sessions/material-analysis'), { recursive: true });
    await writeFile(path.join(mocks.projectDir, 'sessions/material-analysis/demo-run.json'), '{broken');
    const response = await POST(request({ action: 'execute', queuePath: prepared.queuePath }));
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('material_disclosure_unavailable');
  });

  it('does not fill drafts until the digest-bound draft-information approval exists', async () => {
    const prepared = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));
    const preparedPayload = await prepared.json();
    mocks.approvals.draft_information = false;

    const response = await POST(request({ action: 'execute', queuePath: preparedPayload.queuePath }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'draft_approval_required' });
  });

  it('refuses direct execution after a queue is manually truncated', async () => {
    const prepared = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));
    const preparedPayload = await prepared.json();
    const target = path.join(mocks.projectDir, preparedPayload.queuePath);
    const queue = JSON.parse(await readFile(target, 'utf-8'));
    queue.jobs.pop();
    await writeFile(target, JSON.stringify(queue));

    const response = await POST(request({
      action: 'execute',
      runId: 'demo-run',
      queuePath: preparedPayload.queuePath,
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'draft_queue_incomplete' });
  });

  it('returns a recoverable conflict when a direct caller supplies malformed queue JSON', async () => {
    const prepared = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));
    const preparedPayload = await prepared.json();
    await writeFile(path.join(mocks.projectDir, preparedPayload.queuePath), '{not valid json');

    const response = await POST(request({
      action: 'execute',
      runId: 'demo-run',
      queuePath: preparedPayload.queuePath,
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'draft_queue_invalid' });
  });

  it('does not project raw legacy queue errors through the browser API', async () => {
    const prepared = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));
    const preparedPayload = await prepared.json();
    const target = path.join(mocks.projectDir, preparedPayload.queuePath);
    const queue = JSON.parse(await readFile(target, 'utf-8'));
    queue.jobs[0].status = 'retryable_failure';
    queue.jobs[0].last_error = {
      code: 'legacy_adapter_failed',
      message: 'TypeError: token=sk-route-secret at /Users/alice/private/bridge.ts:27',
    };
    queue.jobs[0].events.push({
      at: '2026-08-24T00:00:00.000Z',
      status: 'retryable_failure',
      code: 'legacy_adapter_failed',
      message: '{"stack":"at /Users/alice/private/bridge.ts:27","cookie":"session-secret"}',
    });
    await writeFile(target, JSON.stringify(queue));

    const response = await GET(new NextRequest(
      `http://localhost/api/publish/drafts?queuePath=${encodeURIComponent(preparedPayload.queuePath)}`,
    ));
    const payload = await response.json();
    const serialized = JSON.stringify(payload);

    expect(response.status).toBe(200);
    expect(payload.queue.jobs[0].last_error).toMatchObject({
      code: 'legacy_adapter_failed',
      displayMessage: expect.any(String),
      debugId: expect.stringMatching(/^err_legacy_/),
    });
    expect(payload.queue.jobs[0].last_error).not.toHaveProperty('message');
    expect(serialized).not.toMatch(/sk-route-secret|session-secret|\/Users\/alice|TypeError|bridge\.ts|"stack"/i);
  });

  it('fills every eligible queue item in order when execute omits job IDs', async () => {
    const prepared = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));
    const preparedPayload = await prepared.json();
    const previous = process.env.AIFIOS_PUBLICATION_MOCK_ADAPTERS;
    process.env.AIFIOS_PUBLICATION_MOCK_ADAPTERS = '1';
    try {
      const response = await POST(request({
        action: 'execute',
        runId: 'demo-run',
        queuePath: preparedPayload.queuePath,
      }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.attemptedJobIds).toHaveLength(11);
      expect(payload.queue.jobs.every((job: { status: string }) => job.status === 'draft_filled')).toBe(true);
      expect(mocks.lockKeys).toEqual([
        'publication-draft-queue:materials/publication/drafts/demo/draft-queue.json',
        'publication-draft-queue:materials/publication/drafts/demo/draft-queue.json',
      ]);
    } finally {
      if (previous === undefined) delete process.env.AIFIOS_PUBLICATION_MOCK_ADAPTERS;
      else process.env.AIFIOS_PUBLICATION_MOCK_ADAPTERS = previous;
    }
  });

  it('never enables mock platform adapters inside a packaged desktop service', async () => {
    const prepared = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));
    const preparedPayload = await prepared.json();
    const previous = {
      mock: process.env.AIFIOS_PUBLICATION_MOCK_ADAPTERS,
      desktop: process.env.AIFIOS_DESKTOP,
      standalone: process.env.AIFIOS_NEXT_STANDALONE,
    };
    process.env.AIFIOS_PUBLICATION_MOCK_ADAPTERS = '1';
    process.env.AIFIOS_DESKTOP = '1';
    process.env.AIFIOS_NEXT_STANDALONE = '1';
    try {
      const response = await POST(request({
        action: 'execute',
        runId: 'demo-run',
        queuePath: preparedPayload.queuePath,
      }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.attemptedJobIds).toHaveLength(11);
      expect(payload.queue.jobs.some((job: { external_reference?: string }) => (
        job.external_reference?.startsWith('mock:')
      ))).toBe(false);
      expect(payload.queue.jobs
        .filter((job: { delivery_kind: string }) => job.delivery_kind === 'draft_fill')
        .every((job: { status: string }) => job.status !== 'draft_filled')).toBe(true);
    } finally {
      if (previous.mock === undefined) delete process.env.AIFIOS_PUBLICATION_MOCK_ADAPTERS;
      else process.env.AIFIOS_PUBLICATION_MOCK_ADAPTERS = previous.mock;
      if (previous.desktop === undefined) delete process.env.AIFIOS_DESKTOP;
      else process.env.AIFIOS_DESKTOP = previous.desktop;
      if (previous.standalone === undefined) delete process.env.AIFIOS_NEXT_STANDALONE;
      else process.env.AIFIOS_NEXT_STANDALONE = previous.standalone;
    }
  });

  it('applies only an Electron-signed desktop bridge result to the current queue item', async () => {
    const prepared = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));
    const preparedPayload = await prepared.json();
    const target = preparedPayload.queue.jobs.find((job: { platform: string }) => job.platform === 'wechat');
    const previous = process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET;
    const secret = 'desktop-publication-route-test-secret-123456';
    process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET = secret;
    try {
      const receipt = signDesktopPublicationReceiptForTest({
        schema: DESKTOP_PUBLICATION_RECEIPT_SCHEMA,
        receipt_id: 'receipt_1234567890',
        issued_at: new Date().toISOString(),
        queue_path: preparedPayload.queuePath,
        run_id: 'demo-run',
        job_id: target.job_id,
        payload_hash: target.payload_hash,
        adapter: 'wechat_official_api',
        result: { status: 'draft_filled', authorizationState: 'authorized', externalReference: 'wechat-draft:test' },
      }, secret);
      const response = await POST(request({
        action: 'desktop_result',
        queuePath: preparedPayload.queuePath,
        runId: 'demo-run',
        desktopReceipt: receipt,
      }));
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload.queue.jobs.find((job: { job_id: string }) => job.job_id === target.job_id).status).toBe('draft_filled');
      expect(mocks.lockKeys).toEqual([
        'publication-draft-queue:materials/publication/drafts/demo/draft-queue.json',
        'publication-draft-queue:materials/publication/drafts/demo/draft-queue.json',
      ]);
    } finally {
      if (previous === undefined) delete process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET;
      else process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET = previous;
    }
  });

  it('records a signed manual-prerequisite retry result and increments the authoritative attempt counter', async () => {
    const prepared = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));
    const preparedPayload = await prepared.json();
    const target = preparedPayload.queue.jobs.find((job: { platform: string }) => job.platform === 'xiaohongshu');
    const previous = process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET;
    const secret = 'desktop-publication-route-test-secret-123456';
    process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET = secret;
    try {
      const manualReceipt = signDesktopPublicationReceiptForTest({
        schema: DESKTOP_PUBLICATION_RECEIPT_SCHEMA,
        receipt_id: 'receipt_manual_required_01',
        issued_at: new Date().toISOString(),
        queue_path: preparedPayload.queuePath,
        run_id: 'demo-run',
        job_id: target.job_id,
        payload_hash: target.payload_hash,
        adapter: 'authorized_browser',
        result: {
          status: 'manual_intervention_required',
          authorizationState: 'requires_human_action',
          code: 'browser_session_required',
        },
      }, secret);
      const manualResponse = await POST(request({
        action: 'desktop_result',
        queuePath: preparedPayload.queuePath,
        runId: 'demo-run',
        desktopReceipt: manualReceipt,
      }));
      const manualPayload = await manualResponse.json();
      const manualJob = manualPayload.queue.jobs.find((job: { job_id: string }) => job.job_id === target.job_id);
      expect(manualResponse.status).toBe(200);
      expect(manualJob.status).toBe('manual_intervention_required');
      expect(manualJob.attempt_count).toBe(1);

      const retryReceipt = signDesktopPublicationReceiptForTest({
        schema: DESKTOP_PUBLICATION_RECEIPT_SCHEMA,
        receipt_id: 'receipt_manual_retry_02',
        issued_at: new Date().toISOString(),
        queue_path: preparedPayload.queuePath,
        run_id: 'demo-run',
        job_id: target.job_id,
        payload_hash: target.payload_hash,
        adapter: 'authorized_browser',
        result: {
          status: 'unknown_completion',
          authorizationState: 'requires_human_action',
          code: 'browser_save_confirmation_required',
        },
      }, secret);
      const retryResponse = await POST(request({
        action: 'desktop_result',
        queuePath: preparedPayload.queuePath,
        runId: 'demo-run',
        desktopReceipt: retryReceipt,
      }));
      const retryPayload = await retryResponse.json();
      const retriedJob = retryPayload.queue.jobs.find((job: { job_id: string }) => job.job_id === target.job_id);
      expect(retryResponse.status).toBe(200);
      expect(retriedJob.status).toBe('unknown_completion');
      expect(retriedJob.attempt_count).toBe(2);
      expect(retriedJob.desktop_receipt_ids).toEqual([
        'receipt_manual_required_01',
        'receipt_manual_retry_02',
      ]);
    } finally {
      if (previous === undefined) delete process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET;
      else process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET = previous;
    }
  });

  it('rejects a signed desktop receipt after runtime queue lineage approval becomes stale', async () => {
    const prepared = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));
    const preparedPayload = await prepared.json();
    const target = preparedPayload.queue.jobs.find((job: { platform: string }) => job.platform === 'wechat');
    const previous = process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET;
    const secret = 'desktop-publication-route-test-secret-123456';
    process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET = secret;
    mocks.approvals.draft_information = false;
    try {
      const receipt = signDesktopPublicationReceiptForTest({
        schema: DESKTOP_PUBLICATION_RECEIPT_SCHEMA,
        receipt_id: 'receipt_stale_queue_01',
        issued_at: new Date().toISOString(),
        queue_path: preparedPayload.queuePath,
        run_id: 'demo-run',
        job_id: target.job_id,
        payload_hash: target.payload_hash,
        adapter: 'wechat_official_api',
        result: { status: 'draft_filled', authorizationState: 'authorized' },
      }, secret);
      const response = await POST(request({
        action: 'desktop_result',
        queuePath: preparedPayload.queuePath,
        runId: 'demo-run',
        desktopReceipt: receipt,
      }));
      const stored = JSON.parse(await readFile(path.join(mocks.projectDir, preparedPayload.queuePath), 'utf-8'));

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'draft_approval_required' });
      expect(stored.jobs.find((job: { job_id: string }) => job.job_id === target.job_id).status).toBe('pending');
    } finally {
      if (previous === undefined) delete process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET;
      else process.env.AIFIOS_DESKTOP_PUBLICATION_RECEIPT_SECRET = previous;
    }
  });

  it('refuses a queue when the current per-asset visual manifest is not approved', async () => {
    mocks.approvals.visual_assets = false;

    const response = await POST(request({ action: 'prepare', runId: 'demo-run', packagePath, deliverablesPath }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_approval_required' });
    expect(mocks.registrations).toEqual([]);
  });
});
