import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, it, vi } from 'vitest';

const root = resolve('..');
const helper = join(root, 'skills/content-runtime/tests/native_delivery_fixture.py');
const combinations = [['wechat'], ['xhs'], ['shipinhao'], ['wechat', 'xhs'], ['wechat', 'shipinhao'], ['xhs', 'shipinhao'], ['wechat', 'xhs', 'shipinhao']];
function python(mode: string, project: string, platforms?: string[]) {
  return JSON.parse(execFileSync('python3', [helper, mode, project, ...(platforms ? [JSON.stringify(platforms)] : [])], { encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }));
}
for (const platforms of combinations) {
  it(`selected delivery: real render → TS assets/queue → source approval → directory/ZIP: ${platforms}`, async () => {
    const project = await mkdtemp(join(tmpdir(), 'echo-selected-delivery-'));
    try {
      const prepared = python('prepare', project, platforms);
      vi.stubEnv('AIFIOS_HOME', root); vi.stubEnv('AIFIOS_PROJECT', project); vi.resetModules();
      const { generatePublishAssets } = await import('../publish-assets');
      const { createDraftQueue, sha256 } = await import('./draft-queue');
      const generated = await generatePublishAssets({ slug: prepared.runId, packagePath: prepared.packagePath, ...(prepared.visualPath ? { visualPlanPath: prepared.visualPath } : {}) });
      const deliverables = generated.platformDeliverables;
      const assetHashes: Record<string, string> = {};
      const contentFileHashes: Record<string, string> = {};
      if (prepared.visualPath) {
        const selected = JSON.parse(await readFile(join(project, prepared.visualPath), 'utf8'));
        for (const item of Object.values(selected.selections) as Array<{path: string; sha256: string}>) assetHashes[item.path] = item.sha256;
      }
      const paths = [prepared.packagePath, ...(deliverables.wechat?.htmlCandidates.map(x => x.path) || []), ...(deliverables.xiaohongshu?.posts.map(x => x.publishPaths.xiaohongshu) || []), ...(deliverables.shipinhao?.scripts.map(x => x.primaryPath!) || [])];
      for (const path of paths) contentFileHashes[path] = sha256(await readFile(join(project, path)));
      const queue = createDraftQueue({ runId: prepared.runId, runSlug: prepared.runId, packagePath: prepared.packagePath,
        packageSha256: contentFileHashes[prepared.packagePath], deliverables, assetHashes, contentFileHashes,
        ...(prepared.visualPath ? { visualManifestPath: prepared.visualPath, visualManifestSha256: sha256(await readFile(join(project, prepared.visualPath))) } : {}) });
      const queuePath = join(project, `materials/publication/drafts/${prepared.runId}/draft-queue.json`);
      await mkdir(resolve(queuePath, '..'), { recursive: true }); await writeFile(queuePath, JSON.stringify(queue));
      const result = python('finish', project);
      expect(result.prerequisites.errors, JSON.stringify(result)).toEqual([]);
      expect(result.audit.status, JSON.stringify(result.audit)).toBe('pass');
      expect(result.audit.delivery_pack.zip_path).toBeTruthy();
      const second = python('audit', project);
      expect(second.status, JSON.stringify(second)).toBe('pass');
      // A directory cannot be accepted after the approved public file changes.
      const directory = second.delivery_pack.delivery_dir;
      const publicManifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
      const publicMember = Object.keys(publicManifest.selected_platform_contract.files).find(p => p.startsWith('artifacts/publish-assets/') && !p.endsWith('.json'))!;
      const publicPath = join(directory, publicMember), originalPublic = await readFile(publicPath);
      await writeFile(publicPath, Buffer.concat([originalPublic, Buffer.from('tampered')]));
      const inspection = JSON.parse(execFileSync('python3', [helper, 'inspect', project, directory], { encoding: 'utf8' }));
      expect(inspection.some((item: { code: string }) => item.code === 'selected-platform-integrity')).toBe(true);
      await writeFile(publicPath, originalPublic);
      if (platforms.length === 3) {
        const zipPath = directory + '.zip', originalZip = await readFile(zipPath);
        execFileSync('python3', ['-c', 'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1],"a"); z.writestr(sys.argv[2],b"changed inside zip"); z.close()', zipPath, publicMember]);
        const zipInspection = JSON.parse(execFileSync('python3', [helper, 'inspect', project, directory], { encoding: 'utf8' }));
        expect(zipInspection.some((item: {code: string}) => item.code === 'selected-platform-integrity')).toBe(true);
        await writeFile(zipPath, originalZip);
        // A completed local draft may still be handed off. This inspection
        // cannot authorize another fill operation or modify the queue.
        const queueBefore = await readFile(queuePath);
        const completed = JSON.parse(queueBefore.toString());
        for (const job of completed.jobs) job.status = 'filled';
        await writeFile(queuePath, JSON.stringify(completed));
        expect(python('check', project).errors).toEqual([]);
        expect(await readFile(queuePath, 'utf8')).toBe(JSON.stringify(completed));
        const { rebuildAuthoritativePublicationRequest } = await import('../../electron/publication-authority.cjs');
        const job = completed.jobs[0];
        await expect(rebuildAuthoritativePublicationRequest({ projectDir: project, request: {
          queuePath: `materials/publication/drafts/${prepared.runId}/draft-queue.json`, runId: prepared.runId,
          jobId: job.job_id, expectedPayloadHash: job.payload_hash,
        } })).rejects.toMatchObject({ code: 'job_not_retryable' });
        await writeFile(queuePath, queueBefore);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mutations: Array<readonly [string, (value: any) => void]> = [
          [`runs/${prepared.runId}.json`, (value) => { value.target_platforms = ['wechat']; }],
          [`runs/${prepared.runId}.json`, (value) => { value.approvals.content_package.invalidated_at = '2026-10-15'; }],
          [`sessions/material-analysis/${prepared.runId}.json`, (value) => { value.input.rawMaterial += '新增来源'; }],
          [`materials/publication/drafts/${prepared.runId}/draft-queue.json`, (value) => { value.jobs.push(value.jobs[0]); }],
          [`materials/publication/drafts/${prepared.runId}/draft-queue.json`, (value) => { value.run_id = 'another-run'; }],
          [`materials/publication/drafts/${prepared.runId}/draft-queue.json`, (value) => { value.jobs.find((j: {platform: string}) => j.platform === 'xiaohongshu').selected_asset_hashes.pop(); }],
          [`pipeline/publish-assets/${prepared.runId}-platform-deliverables.json`, (value) => { value.archive.generatedPaths.push('materials/private.md'); }],
          [`pipeline/publish-assets/${prepared.runId}-platform-deliverables.json`, (value) => { value.moments = {}; }],
          [prepared.visualPath, (value) => { delete value.selections['xhs-01-p8']; }],
        ];
        for (const [relative, mutate] of mutations) {
          const path = join(project, relative), before = await readFile(path);
          const value = JSON.parse(before.toString()); mutate(value); await writeFile(path, JSON.stringify(value));
          expect(python('check', project).errors.length, relative).toBeGreaterThan(0);
          await writeFile(path, before);
        }
      }
      // Changed source must make old approvals and the old passing audit useless.
      const source = join(project, prepared.packagePath);
      await writeFile(source, (await readFile(source, 'utf8')) + '\n新增未经确认的句子。');
      expect(python('check', project).errors.length).toBeGreaterThan(0);
      const rejected = python('pack', project);
      expect(rejected.zip_path).toBeNull();
      expect(['internal_review_only', 'blocked']).toContain(rejected.status);
    } finally { vi.unstubAllEnvs(); vi.resetModules(); await rm(project, { recursive: true, force: true }); }
  }, 180_000);
}
