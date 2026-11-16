import { createHash } from 'node:crypto';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftQueue } from './publish/draft-queue';

const context = vi.hoisted(() => ({ root: `/tmp/echo-copy-integrity-${process.pid}` }));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', () => ({ PROJECT_DIR: context.root }));
import { verifyNativeXhsQueueCopy } from './publish-copy-integrity';

const source = '## 2. 小红书原生图文\n### 发布正文\n- 标题：一个标题\n- 正文：第一段。\n\n第二段。\n- 结尾问题：你怎么看？\n### 结尾标签\n#验收';
const prepared = '第一段。\n\n第二段。\n\n你怎么看？\n\n#验收';
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const sourcePath = 'pipeline/package/source.md';
const copyPath = 'pipeline/publish-assets/xhs.txt';
let queue: DraftQueue;
async function put(path: string, content: string) {
  await mkdir(dirname(join(context.root, path)), { recursive: true });
  await writeFile(join(context.root, path), content);
}
beforeEach(async () => {
  await rm(context.root, { recursive: true, force: true });
  await put(sourcePath, source); await put(copyPath, prepared);
  queue = { schema: 'aifios.publication-draft-queue.v1', queue_id: 'copy-test', run_id: 'copy-test', run_slug: 'copy-test',
    created_at: '2026-10-09', updated_at: '2026-10-09',
    target_platforms: ['xiaohongshu'], package_path: sourcePath, package_sha256: sha(source), jobs: [{
      job_id: 'copy-test', item_id: 'xiaohongshu-opinion-1', item_label: '图文', delivery_kind: 'draft_fill', adapter: 'authorized_browser',
      platform: 'xiaohongshu', content_hash: sha(prepared), payload_hash: 'test',
      status: 'pending', authorization_state: 'not_checked', attempt_count: 0, retry_count: 0, events: [], selected_asset_hashes: [],
      payload: { title: '一个标题', copy_path: copyPath, asset_paths: [], metadata: { tags: '#验收' } },
    }] };
});
afterEach(async () => { await rm(context.root, { recursive: true, force: true }); });

describe('native XHS source and prepared file integrity', () => {
  it('accepts the exact full publishing copy', async () => { await expect(verifyNativeXhsQueueCopy(queue)).resolves.toBeUndefined(); });
  it('rejects a truncated file even when its hash is correctly recorded', async () => {
    await put(copyPath, '第一段。'); queue.jobs[0].content_hash = sha('第一段。');
    await expect(verifyNativeXhsQueueCopy(queue)).rejects.toThrow('重新整理成品');
  });
  it('rejects stale source bytes, changed prepared bytes, and altered payload title', async () => {
    await put(sourcePath, `${source}\n新版`);
    await expect(verifyNativeXhsQueueCopy(queue)).rejects.toThrow();
    await put(sourcePath, source); await put(copyPath, prepared + '\n上传说明');
    await expect(verifyNativeXhsQueueCopy(queue)).rejects.toThrow();
    await put(copyPath, prepared); queue.jobs[0].payload.title = '替换标题';
    await expect(verifyNativeXhsQueueCopy(queue)).rejects.toThrow();
  });
  it('rejects a missing copy or symlink, including one with identical content', async () => {
    await rm(join(context.root, copyPath));
    await expect(verifyNativeXhsQueueCopy(queue)).rejects.toThrow();
    await put('pipeline/publish-assets/other.txt', prepared);
    await symlink(join(context.root, 'pipeline/publish-assets/other.txt'), join(context.root, copyPath));
    await expect(verifyNativeXhsQueueCopy(queue)).rejects.toThrow();
  });
  it('does not impose a native XHS contract on a legacy or video-only queue', async () => {
    await rm(join(context.root, copyPath));
    delete queue.target_platforms;
    await expect(verifyNativeXhsQueueCopy(queue)).resolves.toBeUndefined();
    queue.target_platforms = ['shipinhao'];
    await expect(verifyNativeXhsQueueCopy(queue)).resolves.toBeUndefined();
  });
});
