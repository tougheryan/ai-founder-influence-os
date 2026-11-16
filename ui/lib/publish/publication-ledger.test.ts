import { describe, expect, it } from 'vitest';
import type { DraftJob, DraftQueue } from './draft-queue';
import {
  canRecordPublicationResult,
  createPublicationLedger,
  recordPublicationResult,
} from './publication-ledger';

function job(deliveryKind: DraftJob['delivery_kind']): DraftJob {
  const executionPackage = deliveryKind === 'execution_package';
  return {
    job_id: executionPackage ? 'draft_execution_00001' : 'draft_article_000001',
    platform: executionPackage ? 'shipinhao' : 'wechat',
    item_id: executionPackage ? 'shipinhao-video-execution-1' : 'wechat-article',
    item_label: executionPackage ? '视频号口播执行包 1' : '公众号长文',
    delivery_kind: deliveryKind,
    adapter: executionPackage ? 'download' : 'wechat_official_api',
    payload: {
      title: '本期内容',
      asset_paths: [],
      ...(executionPackage ? { execution_package_path: 'pipeline/video/demo/shipinhao-1.md' } : {}),
    },
    payload_hash: 'a'.repeat(64),
    content_hash: 'b'.repeat(64),
    selected_asset_hashes: [],
    status: 'draft_filled',
    authorization_state: 'authorized',
    attempt_count: 1,
    retry_count: 0,
    events: [],
  };
}

function queue(draftJob: DraftJob): DraftQueue {
  return {
    schema: 'aifios.publication-draft-queue.v1',
    queue_id: 'queue_demo',
    run_id: 'run-demo',
    run_slug: 'demo',
    package_path: 'pipeline/package/demo.md',
    package_sha256: 'c'.repeat(64),
    created_at: '2026-08-24T00:00:00.000Z',
    updated_at: '2026-08-24T00:00:00.000Z',
    jobs: [draftJob],
  };
}

describe('publication ledger delivery semantics', () => {
  it('accepts human publication evidence only for draft-fill jobs', () => {
    expect(canRecordPublicationResult(job('draft_fill'))).toBe(true);
    expect(canRecordPublicationResult(job('execution_package'))).toBe(false);
  });

  it('never writes a downloadable execution package to the publication ledger', () => {
    const executionQueue = queue(job('execution_package'));
    const ledger = createPublicationLedger({
      queue: executionQueue,
      queuePath: 'materials/publication/drafts/demo/draft-queue.json',
      queueSha256: 'd'.repeat(64),
    });

    expect(() => recordPublicationResult(executionQueue, ledger, {
      jobId: executionQueue.jobs[0].job_id,
      humanConfirmed: true,
      publicationUrl: 'https://example.com/not-a-publication',
    })).toThrow('执行包在本机下载可用后即完成');
    expect(ledger.records).toEqual([]);
    expect(executionQueue.jobs[0].status).toBe('draft_filled');
  });
});
