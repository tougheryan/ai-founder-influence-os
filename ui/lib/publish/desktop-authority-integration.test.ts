import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDraftQueue } from './draft-queue';
import type { PlatformDeliverables } from '../publish-assets';
import { rebuildAuthoritativePublicationRequest, draftQueueContractSha256 } from '../../electron/publication-authority.cjs';
import { createQueueFixture, RUN_ID, QUEUE_PATH } from '../../electron/fixtures/publication-fixture.cjs';

const combinations = [['wechat'], ['xhs'], ['shipinhao'], ['wechat', 'xhs'], ['wechat', 'shipinhao'], ['xhs', 'shipinhao'], ['wechat', 'xhs', 'shipinhao']];

describe('real TypeScript queue → Python author evidence → desktop authority', () => {
  it('blocks a truncated native XHS file even when its hashes and approvals are current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'echo-queue-copy-mismatch-'));
    try {
      const fixture = await createQueueFixture(root, { platforms: ['xhs'], content: '第一段原文。' });
      const job = fixture.queue.jobs[0];
      await expect(rebuildAuthoritativePublicationRequest({ projectDir: root, request: {
        queuePath: QUEUE_PATH, runId: RUN_ID, jobId: job.job_id, expectedPayloadHash: job.payload_hash,
      } })).rejects.toMatchObject({ code: 'native_copy_mismatch' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  for (const researchMode of ['platform', 'author_material']) {
    for (const platforms of combinations) {
      it(`${researchMode}: ${platforms.join(' + ')}`, async () => {
        const root = await mkdtemp(join(tmpdir(), 'echo-queue-authority-'));
        try {
          const fixture = await createQueueFixture(root, { platforms, researchMode });
          const oldQueue = fixture.queue;
          const assets = Object.fromEntries(oldQueue.jobs.flatMap((job) => job.selected_asset_hashes.map((asset) => [asset.path, asset.sha256])));
          const contentHashes: Record<string, string> = {};
          const deliverables: Record<string, unknown> = {};
          for (const job of oldQueue.jobs) {
            const payload = job.payload;
            const path = payload.html_path || payload.copy_path || payload.execution_package_path!;
            contentHashes[path] = job.content_hash;
            const visualAssets = job.selected_asset_hashes.map((asset) => ({ ...asset, label: asset.role, status: 'ready', action: 'upload' }));
            if (job.platform === 'wechat') {
              deliverables.wechat = { recommendedTitle: '实际生成器构造的本地验收稿', summary: '仅本地测试', coverOptions: visualAssets, visualAssets: [], htmlCandidates: [{ path, recommended: true }], markdownPath: path, shareCopyPaths: [] };
            } else if (job.platform === 'xiaohongshu') {
              deliverables.xiaohongshu = { posts: [{ index: 1, title: '八页图文', publishForms: { xiaohongshu: { title: '八页图文', imageOrder: 'P1-P8', tags: ['#本地验收'] } }, publishPaths: { xiaohongshu: path }, platformVisualAssets: { xiaohongshu: visualAssets } }] };
            } else {
              deliverables.shipinhao = { scripts: [{ index: 1, title: '口播执行稿', primaryPath: path, tags: [], visualAssets: [] }] };
            }
          }
          const queue = createDraftQueue({ runId: RUN_ID, runSlug: oldQueue.run_slug,
            packagePath: oldQueue.package_path, packageSha256: oldQueue.package_sha256,
            visualManifestPath: oldQueue.visual_manifest_path, visualManifestSha256: oldQueue.visual_manifest_sha256,
            deliverables: deliverables as unknown as PlatformDeliverables, assetHashes: assets, contentFileHashes: contentHashes });
          await writeFile(join(root, QUEUE_PATH), JSON.stringify(queue));
          const runPath = join(root, fixture.runPath);
          const run = JSON.parse(await readFile(runPath, 'utf8'));
          run.approvals.draft_information.sha256 = draftQueueContractSha256(queue);
          run.phase_artifacts.draft_information.sha256 = draftQueueContractSha256(queue);
          await writeFile(runPath, JSON.stringify(run));
          for (const job of queue.jobs) {
            const authority = await rebuildAuthoritativePublicationRequest({ projectDir: root, request: { queuePath: QUEUE_PATH, runId: RUN_ID, jobId: job.job_id, expectedPayloadHash: job.payload_hash } });
            expect(authority.rawJob.job_id).toBe(job.job_id);
            expect(authority.rawJob.platform).toBe(job.platform);
            expect(authority.verifiedFiles.size).toBe(1 + job.selected_asset_hashes.length);
          }
        } finally { await rm(root, { recursive: true, force: true }); }
      });
    }
  }
});
