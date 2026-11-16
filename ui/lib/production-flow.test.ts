import { describe, expect, it } from 'vitest';
import {
  FIXED_PRODUCTION_PLATFORMS,
  canRecordPublicationEvidence,
  canPrepareLocalDraft,
  canExplicitlyRetryLocalDraft,
  groupProductionDeliverables,
  hasCompleteDraftQueue,
  hasCompleteFinalDeliverables,
  hasQueuedLocalDrafts,
  isPublicationQueueComplete,
  selectedVisualManifestPath,
  type ProductionDraftQueue,
} from './production-flow';

function queue(status = 'draft_filled'): ProductionDraftQueue {
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
    run_id: 'run-demo',
    run_slug: 'demo',
    package_path: 'pipeline/package/demo.md',
    jobs: contract.map(([platform, itemId, deliveryKind], index) => ({
      job_id: `draft-${index}`,
      platform,
      item_id: itemId,
      item_label: itemId,
      delivery_kind: deliveryKind,
      adapter: deliveryKind === 'execution_package' ? 'download' : 'authorized_browser',
      status: status as ProductionDraftQueue['jobs'][number]['status'],
      payload: { title: '内容' },
    })),
  };
}

function illustratedQueue(): ProductionDraftQueue {
  const result = queue();
  for (const job of result.jobs) {
    const ids = job.platform === 'wechat'
      ? ['wechat-cover', 'inline-01']
      : job.platform === 'xiaohongshu'
        ? ['p1', 'p2', 'p3', 'p4', 'p5']
        : job.platform === 'moments'
          ? ['p1', 'p3', 'p5']
          : [];
    job.selected_asset_hashes = ids.map((id) => ({
      id: job.platform === 'wechat' ? id : `${job.platform}-${job.item_id.at(-1)}-${id}`,
      path: `pipeline/visual/demo/${job.item_id}-${id}.png`,
      sha256: id.padEnd(64, '0').slice(0, 64),
      role: id,
    }));
    job.payload.asset_paths = job.selected_asset_hashes.map((asset) => asset.path);
  }
  return result;
}

describe('production flow contract', () => {
  it('accepts an exact selected-platform v2 queue and requires visuals only for selected image platforms', () => {
    const native: ProductionDraftQueue = {
      run_id: 'run-native', run_slug: 'native', package_path: 'pipeline/package/native.md',
      target_platforms: ['xiaohongshu', 'shipinhao'],
      jobs: [
        {
          job_id: 'draft-xhs', platform: 'xiaohongshu', item_id: 'xiaohongshu-opinion-1', item_label: '小红书', delivery_kind: 'draft_fill', status: 'pending',
          payload: { title: '小红书', asset_paths: Array.from({ length: 8 }, (_, index) => `pipeline/visual/native/xhs-01-p${index + 1}.png`) },
        },
        {
          job_id: 'draft-video', platform: 'shipinhao', item_id: 'shipinhao-video-execution-1', item_label: '视频号', delivery_kind: 'execution_package', adapter: 'download', status: 'pending', payload: { title: '视频号' },
        },
      ],
    };
    expect(hasCompleteDraftQueue(native)).toBe(true);
    expect(hasCompleteFinalDeliverables(native)).toBe(true);
    native.jobs[0].payload.asset_paths?.pop();
    expect(hasCompleteFinalDeliverables(native)).toBe(false);

    const videoOnly: ProductionDraftQueue = { ...native, target_platforms: ['shipinhao'], jobs: [native.jobs[1]] };
    expect(hasCompleteDraftQueue(videoOnly)).toBe(true);
    expect(hasCompleteFinalDeliverables(videoOnly)).toBe(true);

    const wechatOnly: ProductionDraftQueue = {
      run_id: 'run-wechat', run_slug: 'wechat', package_path: 'pipeline/package/wechat.md',
      target_platforms: ['wechat'],
      jobs: [{
        job_id: 'draft-wechat', platform: 'wechat', item_id: 'wechat-article', item_label: '公众号', delivery_kind: 'draft_fill', status: 'pending',
        payload: { title: '公众号', html_path: 'pipeline/visual/wechat/publish/r001/wechat/wechat-layout.html' },
      }],
    };
    expect(hasCompleteDraftQueue(wechatOnly)).toBe(true);
    expect(hasCompleteFinalDeliverables(wechatOnly)).toBe(true);
    delete wechatOnly.jobs[0].payload.html_path;
    expect(hasCompleteFinalDeliverables(wechatOnly)).toBe(false);
  });

  it('locks every run to all five required publishing destinations', () => {
    expect(FIXED_PRODUCTION_PLATFORMS).toEqual([
      'wechat', 'xiaohongshu', 'shipinhao', 'douyin', 'moments',
    ]);
    expect(selectedVisualManifestPath('demo')).toBe('pipeline/visual/demo/selected-assets.json');
  });

  it('requires the full 1 + 3 + 3 + 2 + 2 queue before draft confirmation', () => {
    expect(hasCompleteDraftQueue(queue())).toBe(true);
    const missing = queue();
    missing.jobs.pop();
    expect(hasCompleteDraftQueue(missing)).toBe(false);
  });

  it('does not call a zero-image queue a finished deliverable', () => {
    expect(hasCompleteFinalDeliverables(queue())).toBe(false);
    expect(hasCompleteFinalDeliverables(illustratedQueue())).toBe(true);
    const missingCard = illustratedQueue();
    const firstXhs = missingCard.jobs.find((job) => job.item_id === 'xiaohongshu-opinion-1');
    firstXhs?.selected_asset_hashes?.pop();
    firstXhs?.payload.asset_paths?.pop();
    expect(hasCompleteFinalDeliverables(missingCard)).toBe(false);
  });

  it('presents the platform operations as three reusable content deliverables', () => {
    const groups = groupProductionDeliverables(queue());
    expect(groups.map((group) => [group.id, group.countLabel])).toEqual([
      ['article', '1 篇'],
      ['social-cards', '3 组'],
      ['video-scripts', '2 条'],
    ]);
    expect(groups.map((group) => group.jobs.length)).toEqual([1, 6, 4]);
    expect(groups[1].targetLabels).toEqual(['小红书', '朋友圈']);
  });

  it('rejects a queue that has the right count but substitutes an item or delivery type', () => {
    const wrongIdentity = queue();
    wrongIdentity.jobs[1].item_id = 'xiaohongshu-opinion-4';
    expect(hasCompleteDraftQueue(wrongIdentity)).toBe(false);

    const wrongDelivery = queue();
    wrongDelivery.jobs[0].delivery_kind = 'execution_package';
    expect(hasCompleteDraftQueue(wrongDelivery)).toBe(false);

    const duplicateJobId = queue();
    duplicateJobId.jobs[1].job_id = duplicateJobId.jobs[0].job_id;
    expect(hasCompleteDraftQueue(duplicateJobId)).toBe(false);
  });

  it('does not treat a queued draft as published and never retries unknown completion', () => {
    expect(isPublicationQueueComplete(queue())).toBe(false);
    const completed = queue();
    for (const job of completed.jobs) {
      job.status = job.delivery_kind === 'execution_package' ? 'draft_filled' : 'published_confirmed';
    }
    expect(isPublicationQueueComplete(completed)).toBe(true);

    const falselyPublishedPackages = queue('published_confirmed');
    expect(isPublicationQueueComplete(falselyPublishedPackages)).toBe(false);

    const unpreparedPackage = completed;
    const executionPackage = unpreparedPackage.jobs.find((job) => job.delivery_kind === 'execution_package');
    if (executionPackage) executionPackage.status = 'pending';
    expect(isPublicationQueueComplete(unpreparedPackage)).toBe(false);

    const wrongExecutionAdapter = queue();
    for (const job of wrongExecutionAdapter.jobs) {
      job.status = job.delivery_kind === 'execution_package' ? 'draft_filled' : 'published_confirmed';
    }
    const packageWithWrongAdapter = wrongExecutionAdapter.jobs.find((job) => job.delivery_kind === 'execution_package');
    if (packageWithWrongAdapter) packageWithWrongAdapter.adapter = 'authorized_browser';
    expect(isPublicationQueueComplete(wrongExecutionAdapter)).toBe(false);
    expect(canPrepareLocalDraft({ status: 'pending' })).toBe(true);
    expect(canPrepareLocalDraft({ status: 'retryable_failure' })).toBe(true);
    expect(canPrepareLocalDraft({ status: 'unknown_completion' })).toBe(false);
    expect(canExplicitlyRetryLocalDraft({ status: 'retryable_failure' })).toBe(true);
    expect(canExplicitlyRetryLocalDraft({ status: 'manual_intervention_required' })).toBe(true);
    expect(canExplicitlyRetryLocalDraft({ status: 'unknown_completion' })).toBe(false);
    expect(hasQueuedLocalDrafts(queue('pending'))).toBe(true);
    expect(hasQueuedLocalDrafts(queue('draft_filled'))).toBe(false);
  });

  it('never offers publication evidence for execution packages', () => {
    expect(canRecordPublicationEvidence({ delivery_kind: 'draft_fill', status: 'draft_filled' })).toBe(true);
    expect(canRecordPublicationEvidence({ delivery_kind: 'execution_package', status: 'draft_filled' })).toBe(false);
    expect(canRecordPublicationEvidence({ delivery_kind: 'execution_package', status: 'published_confirmed' })).toBe(false);
    expect(canRecordPublicationEvidence({ delivery_kind: 'draft_fill', status: 'unknown_completion' })).toBe(false);
    expect(canRecordPublicationEvidence({ delivery_kind: 'draft_fill', status: 'unknown_completion' }, true)).toBe(true);
  });
});
