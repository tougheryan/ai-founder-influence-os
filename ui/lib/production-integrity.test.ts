import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-production-integrity-${process.pid}`,
}));

vi.mock('server-only', () => ({}));
vi.mock('./project-root', async (importOriginal) => ({
  ...await importOriginal<typeof import('./project-root')>(),
  PROJECT_DIR: mocks.projectDir,
}));

afterAll(async () => {
  await rm(mocks.projectDir, { recursive: true, force: true });
});

import {
  countBoundPublicationRecords,
  draftApprovalSha256,
  inspectDraftQueueIntegrity,
  inspectProductionArtifact,
  scopeWeeklyReviewIntegrity,
} from './production-integrity';
import type { DraftQueue } from './publish/draft-queue';
import type { PublicationLedger } from './publish/publication-ledger';
import type { WeeklyReviewItem, WeeklyReviewMetric, WeeklyReviewSummary } from './weekly-review';

function ledger(recordId: string): PublicationLedger {
  return {
    schema: 'aifios.publication-ledger.v1',
    ledger_id: 'ledger-a',
    queue_id: 'queue-a',
    run_id: 'run-a',
    run_slug: 'run-a',
    queue_path: 'materials/publication/drafts/run-a/draft-queue.json',
    queue_sha256: 'a'.repeat(64),
    created_at: '2026-08-24T00:00:00.000Z',
    updated_at: '2026-08-24T00:00:00.000Z',
    records: [{
      record_id: recordId,
      queue_id: 'queue-a',
      job_id: 'job-a',
      platform: 'wechat',
      item_id: 'wechat-article',
      final_content_hash: 'b'.repeat(64),
      payload_hash: 'c'.repeat(64),
      selected_asset_hashes: [],
      published_url: 'https://example.test/a',
      published_at: '2026-08-24T00:00:00.000Z',
      human_confirmed: true,
      recorded_at: '2026-08-24T00:00:00.000Z',
    }],
  };
}

type WeeklyBinding = {
  runId: string;
  runSlug: string;
  queueId: string;
  ledgerPath: string;
};

function weeklyItem(sourceRecordId: string, withMetrics: boolean, binding?: WeeklyBinding): WeeklyReviewItem {
  const metrics: Record<string, WeeklyReviewMetric> = withMetrics
    ? { reads: { value: 10, source: 'manual_operator', recorded_at: '2026-08-24T00:00:00.000Z' } }
    : {};
  return {
    source_record_id: sourceRecordId,
    ...(binding ? {
      run_id: binding.runId,
      run_slug: binding.runSlug,
      queue_id: binding.queueId,
      source_ledger_path: binding.ledgerPath,
    } : {}),
    platform: 'wechat' as const,
    item_id: 'wechat-article',
    published_url: 'https://example.test/a',
    published_at: '2026-08-24T00:00:00.000Z',
    final_content_hash: 'b'.repeat(64),
    adopted_visual_assets: [],
    required_metrics: ['reads'],
    metrics,
    comment_samples: [],
  };
}

function weeklyBinding(value: PublicationLedger): WeeklyBinding {
  return {
    runId: value.run_id,
    runSlug: value.run_slug,
    queueId: value.queue_id,
    ledgerPath: `materials/publication/ledger/${value.run_slug}/publication-ledger.json`,
  };
}

describe('production integrity', () => {
  it('reports the current artifact hash instead of trusting a stale registered digest', async () => {
    const relativePath = 'pipeline/package/current.md';
    const target = `${mocks.projectDir}/${relativePath}`;
    await rm(mocks.projectDir, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, 'current bytes');
    const registeredSha256 = createHash('sha256').update('previous bytes').digest('hex');
    const currentSha256 = createHash('sha256').update('current bytes').digest('hex');

    const integrity = await inspectProductionArtifact(relativePath, 'content_package', {
      sha256: registeredSha256,
      version: 2,
    });

    expect(integrity).toMatchObject({
      path: relativePath,
      sha256: currentSha256,
      registered_sha256: registeredSha256,
      hash_matches_registered: false,
      exists: true,
      version: 2,
    });
  });

  it('keeps draft approval hashes stable across operational progress but not payload edits', () => {
    const base = {
      schema: 'aifios.publication-draft-queue.v1',
      queue_id: 'queue-a',
      run_id: 'run-a',
      run_slug: 'run-a',
      package_path: 'pipeline/package/run-a.md',
      package_sha256: 'a'.repeat(64),
      created_at: '2026-08-24T00:00:00.000Z',
      updated_at: '2026-08-24T00:00:00.000Z',
      jobs: [{
        job_id: 'draft_aaaaaaaaaaaaaaaaaaaa',
        item_id: 'wechat-article',
        status: 'pending',
        adapter: 'authorized_browser',
        payload_hash: 'b'.repeat(64),
        events: [],
      }],
    };
    const progressed = {
      ...base,
      updated_at: '2026-08-24T01:00:00.000Z',
      jobs: [{ ...base.jobs[0], status: 'draft_filled', events: [{ status: 'draft_filled' }] }],
    };
    const changedPayload = {
      ...progressed,
      jobs: [{ ...progressed.jobs[0], payload_hash: 'c'.repeat(64) }],
    };

    expect(draftApprovalSha256(Buffer.from(JSON.stringify(progressed))))
      .toBe(draftApprovalSha256(Buffer.from(JSON.stringify(base))));
    expect(draftApprovalSha256(Buffer.from(JSON.stringify(changedPayload))))
      .not.toBe(draftApprovalSha256(Buffer.from(JSON.stringify(base))));
  });

  it('marks a persisted queue stale as soon as its current package bytes change', async () => {
    const packagePath = 'pipeline/package/run-a.md';
    const visualPath = 'pipeline/visual/run-a/selected-assets.json';
    const queuePath = 'materials/publication/drafts/run-a/draft-queue.json';
    const packageBytes = 'approved package';
    const visualBytes = '{"schema":"aifios.visual-asset-manifest.v1"}';
    await rm(mocks.projectDir, { recursive: true, force: true });
    await Promise.all([
      mkdir(dirname(`${mocks.projectDir}/${packagePath}`), { recursive: true }),
      mkdir(dirname(`${mocks.projectDir}/${visualPath}`), { recursive: true }),
      mkdir(dirname(`${mocks.projectDir}/${queuePath}`), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(`${mocks.projectDir}/${packagePath}`, packageBytes),
      writeFile(`${mocks.projectDir}/${visualPath}`, visualBytes),
      writeFile(`${mocks.projectDir}/${queuePath}`, JSON.stringify({
        schema: 'aifios.publication-draft-queue.v1',
        queue_id: 'queue-a',
        run_id: 'run-a',
        run_slug: 'run-a',
        package_path: packagePath,
        package_sha256: createHash('sha256').update(packageBytes).digest('hex'),
        visual_manifest_path: visualPath,
        visual_manifest_sha256: createHash('sha256').update(visualBytes).digest('hex'),
        created_at: '2026-08-24T00:00:00.000Z',
        updated_at: '2026-08-24T00:00:00.000Z',
        jobs: [{
          job_id: 'draft_00000000000000000000',
          platform: 'wechat',
          item_id: 'wechat-article',
          item_label: '公众号长文',
          delivery_kind: 'draft_fill',
          adapter: 'authorized_browser',
          payload: { title: '测试', asset_paths: [] },
          payload_hash: 'b'.repeat(64),
          content_hash: 'c'.repeat(64),
          selected_asset_hashes: [],
          status: 'pending',
          authorization_state: 'not_checked',
          attempt_count: 0,
          retry_count: 0,
          events: [],
        }],
      })),
    ]);
    const run = {
      run_id: 'run-a',
      slug: 'run-a',
      steps: { package: { latest: packagePath } },
      phase_artifacts: { visual_assets: { path: visualPath } },
    } as Parameters<typeof inspectDraftQueueIntegrity>[1];

    const current = await inspectDraftQueueIntegrity(queuePath, run);
    expect(current.queue?.queue_id).toBe('queue-a');
    expect(current.summary).toMatchObject({ lineage_current: true, total: 1 });

    await writeFile(`${mocks.projectDir}/${packagePath}`, 'externally changed package');
    const stale = await inspectDraftQueueIntegrity(queuePath, run);
    expect(stale.queue).toBeNull();
    expect(stale.summary).toMatchObject({
      lineage_current: false,
      complete: false,
      reason: 'upstream_artifact_changed',
    });
  });

  it('does not leak another run weekly status into the requested run', () => {
    const otherBinding: WeeklyBinding = {
      runId: 'run-b',
      runSlug: 'run-b',
      queueId: 'queue-b',
      ledgerPath: 'materials/publication/ledger/run-b/publication-ledger.json',
    };
    const summary: WeeklyReviewSummary = {
      status: 'memory_applied',
      record_path: 'materials/weekly-review/2026-W35/learning-record.json',
      record: {
        schema: 'aifios.weekly-learning-record.v1',
        record_id: 'weekly-1',
        week: '2026-W35',
        status: 'memory_applied',
        run_bindings: [{
          run_id: 'run-b',
          run_slug: 'run-b',
          queue_id: 'queue-b',
          source_ledger_path: otherBinding.ledgerPath,
        }],
        items: [weeklyItem('record-from-run-b', true, otherBinding)],
      },
    };

    expect(scopeWeeklyReviewIntegrity(summary, ledger('record-from-run-a'))).toEqual({
      status: 'waiting_collection',
      missing_metrics: 1,
      memory_applied: false,
    });
  });

  it('does not count another publication from the same run as this ledger item', () => {
    const currentLedger = ledger('record-from-run-a');
    const binding = weeklyBinding(currentLedger);
    const summary: WeeklyReviewSummary = {
      status: 'memory_applied',
      record_path: 'materials/weekly-review/2026-W35/learning-record.json',
      record: {
        schema: 'aifios.weekly-learning-record.v1',
        record_id: 'weekly-1',
        week: '2026-W35',
        status: 'memory_applied',
        run_bindings: [{
          run_id: binding.runId,
          run_slug: binding.runSlug,
          queue_id: binding.queueId,
          source_ledger_path: binding.ledgerPath,
        }],
        items: [weeklyItem('different-record-from-run-a', true, binding)],
      },
    };

    expect(scopeWeeklyReviewIntegrity(summary, currentLedger)).toEqual({
      status: 'waiting_collection',
      missing_metrics: 1,
      memory_applied: false,
    });
  });

  it('rejects an aggregate weekly record whose run binding names another run', () => {
    const currentLedger = ledger('record-from-run-a');
    const summary: WeeklyReviewSummary = {
      status: 'memory_applied',
      record_path: 'materials/weekly-review/2026-W35/learning-record.json',
      record: {
        schema: 'aifios.weekly-learning-record.v1',
        record_id: 'weekly-1',
        week: '2026-W35',
        status: 'memory_applied',
        run_bindings: [{ run_id: 'run-b', run_slug: 'run-b' }],
        items: [{
          ...weeklyItem('record-from-run-a', true, weeklyBinding(currentLedger)),
          run_id: currentLedger.run_id,
          run_slug: currentLedger.run_slug,
          queue_id: currentLedger.queue_id,
        }],
      },
    };

    expect(scopeWeeklyReviewIntegrity(summary, currentLedger)).toEqual({
      status: 'waiting_collection',
      missing_metrics: 1,
      memory_applied: false,
    });
  });

  it('reports memory application only when this run publication is represented and complete', () => {
    const currentLedger = ledger('record-from-run-a');
    const binding = weeklyBinding(currentLedger);
    const summary: WeeklyReviewSummary = {
      status: 'memory_applied',
      record_path: 'materials/weekly-review/2026-W35/learning-record.json',
      record: {
        schema: 'aifios.weekly-learning-record.v1',
        record_id: 'weekly-1',
        week: '2026-W35',
        status: 'memory_applied',
        run_bindings: [{
          run_id: binding.runId,
          run_slug: binding.runSlug,
          queue_id: binding.queueId,
          source_ledger_path: binding.ledgerPath,
        }],
        items: [weeklyItem('record-from-run-a', true, binding), weeklyItem('record-from-run-b', true)],
      },
    };

    expect(scopeWeeklyReviewIntegrity(summary, currentLedger)).toMatchObject({
      status: 'memory_applied',
      missing_metrics: 0,
      memory_applied: true,
    });
  });

  it('keeps legacy weekly items without explicit run and ledger binding in collection state', () => {
    const currentLedger = ledger('record-from-run-a');
    const binding = weeklyBinding(currentLedger);
    const summary: WeeklyReviewSummary = {
      status: 'memory_applied',
      record_path: 'materials/weekly-review/2026-W35/learning-record.json',
      record: {
        schema: 'aifios.weekly-learning-record.v1',
        record_id: 'weekly-legacy',
        week: '2026-W35',
        status: 'memory_applied',
        run_bindings: [{
          run_id: binding.runId,
          run_slug: binding.runSlug,
          queue_id: binding.queueId,
          source_ledger_path: binding.ledgerPath,
        }],
        items: [weeklyItem('record-from-run-a', true)],
      },
    };

    expect(scopeWeeklyReviewIntegrity(summary, currentLedger)).toEqual({
      status: 'waiting_collection',
      missing_metrics: 1,
      memory_applied: false,
    });
  });

  it('does not report weekly learning for an obsolete queue from the same run', () => {
    const currentLedger = ledger('record-from-run-a');
    const binding = weeklyBinding(currentLedger);
    const summary: WeeklyReviewSummary = {
      status: 'memory_applied',
      record: {
        schema: 'aifios.weekly-learning-record.v1',
        record_id: 'weekly-old-queue',
        week: '2026-W35',
        status: 'memory_applied',
        run_bindings: [{
          run_id: binding.runId,
          run_slug: binding.runSlug,
          queue_id: binding.queueId,
          source_ledger_path: binding.ledgerPath,
        }],
        items: [weeklyItem('record-from-run-a', true, binding)],
      },
    };
    const rebuiltQueue = {
      schema: 'aifios.publication-draft-queue.v1',
      queue_id: 'queue-new',
      run_id: currentLedger.run_id,
      run_slug: currentLedger.run_slug,
      jobs: [],
    } as unknown as DraftQueue;

    expect(scopeWeeklyReviewIntegrity(summary, currentLedger, rebuiltQueue)).toEqual({
      status: 'not_due',
      missing_metrics: 0,
      memory_applied: false,
    });
  });

  it('counts a publication only when its queue, content, payload, and visual hashes still match', () => {
    const publicationLedger = ledger('record-from-run-a');
    const record = publicationLedger.records[0];
    record.selected_asset_hashes = [{ path: 'pipeline/visual/run-a/cover.png', sha256: 'd'.repeat(64) }];
    const queue = {
      schema: 'aifios.publication-draft-queue.v1',
      queue_id: publicationLedger.queue_id,
      run_id: publicationLedger.run_id,
      run_slug: publicationLedger.run_slug,
      jobs: [{
        job_id: record.job_id,
        platform: record.platform,
        item_id: record.item_id,
        delivery_kind: 'draft_fill',
        content_hash: record.final_content_hash,
        payload_hash: record.payload_hash,
        selected_asset_hashes: [...record.selected_asset_hashes],
      }],
    } as unknown as DraftQueue;

    expect(countBoundPublicationRecords(publicationLedger, queue)).toBe(1);
    publicationLedger.records[0].payload_hash = 'e'.repeat(64);
    expect(countBoundPublicationRecords(publicationLedger, queue)).toBe(0);
  });

  it('never treats an execution-package row as publication evidence', () => {
    const publicationLedger = ledger('record-from-run-a');
    const record = publicationLedger.records[0];
    const queue = {
      schema: 'aifios.publication-draft-queue.v1',
      queue_id: publicationLedger.queue_id,
      run_id: publicationLedger.run_id,
      run_slug: publicationLedger.run_slug,
      jobs: [{
        job_id: record.job_id,
        platform: record.platform,
        item_id: record.item_id,
        delivery_kind: 'execution_package',
        content_hash: record.final_content_hash,
        payload_hash: record.payload_hash,
        selected_asset_hashes: [],
      }],
    } as unknown as DraftQueue;

    expect(countBoundPublicationRecords(publicationLedger, queue)).toBe(0);
  });
});
