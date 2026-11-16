import { describe, expect, it, vi } from 'vitest';
import {
  canAutomaticallyRetry,
  applyDesktopDraftResult,
  canAcceptDesktopReceipt,
  collectDraftContentPaths,
  collectReadyAssetPaths,
  createDraftQueue,
  runDraftQueue,
  sha256,
  type DraftAdapter,
} from './draft-queue';
import type { PlatformDeliverables } from '../publish-assets';

function readyAsset(path: string, id: string) {
  return { id, label: id, path, status: 'ready' as const, action: 'upload' };
}

function opinionPost(index: number) {
  const xhsAssets = Array.from({ length: 5 }, (_, page) => readyAsset(
    `pipeline/visual/demo/xhs-${index}-p${page + 1}.png`,
    `xhs-${index}-p${page + 1}`,
  ));
  const momentsAssets = [1, 3, 5].map((page) => readyAsset(
    `pipeline/visual/demo/moments-${index}-p${page}.png`,
    `moments-${index}-p${page}`,
  ));
  return {
    index,
    label: `观点 ${index}`,
    title: `观点标题 ${index}`,
    coverText: `封面 ${index}`,
    coreViewpoint: `观点 ${index}`,
    copy: `观点正文 ${index}`,
    tags: ['#内容'],
    pages: [],
    platformAdaptations: {},
    publishForms: {
      wechat: { title: `公众号 ${index}`, copy: `公众号配文 ${index}`, tags: [], imageOrder: 'P1' },
      xiaohongshu: { title: `小红书 ${index}`, copy: `小红书配文 ${index}`, tags: ['#内容'], imageOrder: 'P1-P5' },
      moments: { title: `朋友圈 ${index}`, copy: `朋友圈配文 ${index}`, tags: [], imageOrder: 'P1,P3,P5' },
    },
    publishCopies: {
      wechat: `公众号配文 ${index}`,
      xiaohongshu: `小红书配文 ${index}`,
      moments: `朋友圈配文 ${index}`,
    },
    publishPaths: {
      wechat: `pipeline/publish-assets/demo/wechat-share-${index}.md`,
      xiaohongshu: `pipeline/publish-assets/demo/xhs-${index}.md`,
      moments: `pipeline/publish-assets/demo/moments-${index}.md`,
    },
    commentGuide: '',
    visualAssets: [...xhsAssets, ...momentsAssets],
    platformVisualAssets: { xiaohongshu: xhsAssets, moments: momentsAssets },
    primaryPath: `pipeline/publish-assets/demo/xhs-${index}.md`,
  };
}

function videoScript(index: number) {
  return {
    index,
    label: `短视频 ${index}`,
    title: `短视频标题 ${index}`,
    coverText: `视频封面 ${index}`,
    hook: `钩子 ${index}`,
    duration: '45 秒',
    oralScript: `口播 ${index}`,
    teleprompterScript: `提词器 ${index}`,
    shotList: '镜头清单',
    subtitleHighlights: ['字幕重点'],
    bRollSuggestions: ['B-roll'],
    publishCopy: `发布文案 ${index}`,
    tags: ['#内容'],
    platformNote: '平台说明',
    commentGuide: '',
    visualAssets: [],
    primaryPath: `pipeline/publish-assets/demo/video-${index}.md`,
  };
}

function deliverables(): PlatformDeliverables {
  const posts = [opinionPost(1), opinionPost(2), opinionPost(3)];
  const scripts = [videoScript(1), videoScript(2)];
  return {
    wechat: {
      platform: 'wechat',
      label: '公众号',
      recommendedTitle: '公众号长文',
      alternativeTitles: [],
      summary: '摘要',
      markdownPath: 'pipeline/publish-assets/demo/wechat.md',
      htmlCandidates: [{ label: '正文', path: 'pipeline/visual/demo/article.html', recommended: true }],
      visualAssets: [readyAsset('pipeline/visual/demo/inline.png', 'inline')],
      coverOptions: [readyAsset('pipeline/visual/demo/cover.png', 'cover')],
      copyText: '公众号正文',
      sharePosts: posts,
      shareCopyText: '',
      shareCopyPaths: posts.map((post) => post.publishPaths.wechat),
      publishChecks: [],
      qualityStatus: 'ready',
      qualityIssues: [],
    },
    xiaohongshu: {
      platform: 'xiaohongshu',
      label: '小红书',
      coverTitle: '小红书',
      firstThreeLines: [],
      cardPlan: [],
      bodyCopy: '',
      tags: [],
      commentGuide: '',
      posts,
      videoScripts: [],
      videoCopyText: '',
      videoCopyPaths: [],
      videoVisualAssets: [],
      visualAssets: posts.flatMap((post) => post.visualAssets),
      copyText: '',
      publishChecks: [],
      qualityStatus: 'ready',
      qualityIssues: [],
    },
    moments: {
      platform: 'moments',
      label: '朋友圈',
      posts,
      visualAssets: posts.flatMap((post) => post.visualAssets),
      copyText: '',
      publishChecks: [],
      qualityStatus: 'ready',
      qualityIssues: [],
    },
    shipinhao: {
      platform: 'shipinhao',
      label: '视频号',
      scripts,
      visualAssets: [],
      copyText: '',
      publishChecks: [],
      qualityStatus: 'ready',
      qualityIssues: [],
    },
    douyin: {
      platform: 'douyin',
      label: '抖音',
      scripts,
      visualAssets: [],
      copyText: '',
      publishChecks: [],
      qualityStatus: 'ready',
      qualityIssues: [],
    },
    archive: { reportPath: 'pipeline/publish-assets/demo.md', generatedPaths: [] },
  } as unknown as PlatformDeliverables;
}

function queue() {
  const platformDeliverables = deliverables();
  return createDraftQueue({
    runId: 'run-demo',
    runSlug: 'demo',
    packagePath: 'pipeline/package/demo-package.md',
    packageSha256: 'package-hash',
    deliverables: platformDeliverables,
    assetHashes: Object.fromEntries(collectReadyAssetPaths(platformDeliverables).map((path) => [path, sha256(path)])),
    contentFileHashes: Object.fromEntries(collectDraftContentPaths(platformDeliverables).map((path) => [path, sha256(`body:${path}`)])),
    now: '2026-07-15T00:00:00.000Z',
  });
}

function adapter(kind: DraftAdapter['kind'], fill: DraftAdapter['fill']): DraftAdapter {
  return { kind, fill };
}

describe('draft queue', () => {
  it('creates a queue only for the platforms selected by a v2 run', () => {
    const post = opinionPost(1);
    const script = videoScript(1);
    const native = {
      xiaohongshu: {
        platform: 'xiaohongshu', label: '小红书', coverTitle: '封面', firstThreeLines: [], cardPlan: [], bodyCopy: '', tags: [], commentGuide: '',
        posts: [post], videoScripts: [], videoCopyText: '', videoCopyPaths: [], videoVisualAssets: [], visualAssets: post.visualAssets,
        copyText: '', publishChecks: [], qualityStatus: 'ready', qualityIssues: [],
      },
      shipinhao: {
        platform: 'shipinhao', label: '视频号', scripts: [script], visualAssets: [], copyText: '', publishChecks: [], qualityStatus: 'ready', qualityIssues: [],
      },
      archive: { reportPath: 'pipeline/publish-assets/demo.md', generatedPaths: [] },
    } as unknown as PlatformDeliverables;
    const result = createDraftQueue({
      runId: 'run-native', runSlug: 'native', packagePath: 'pipeline/package/native.md', packageSha256: 'hash', deliverables: native,
      assetHashes: Object.fromEntries(collectReadyAssetPaths(native).map((path) => [path, sha256(path)])),
      contentFileHashes: Object.fromEntries(collectDraftContentPaths(native).map((path) => [path, sha256(path)])),
      now: '2026-08-25T00:00:00.000Z',
    });
    expect(result.target_platforms).toEqual(['xiaohongshu', 'shipinhao']);
    expect(result.jobs.map((job) => [job.platform, job.item_id])).toEqual([
      ['xiaohongshu', 'xiaohongshu-opinion-1'],
      ['shipinhao', 'shipinhao-video-execution-1'],
    ]);
  });

  it('creates the fixed 1 + 2 + 3 publication queue for all five platforms', () => {
    const result = queue();
    expect(result.jobs).toHaveLength(11);
    expect(result.jobs.filter((job) => job.platform === 'wechat')).toHaveLength(1);
    expect(result.jobs.filter((job) => job.platform === 'xiaohongshu')).toHaveLength(3);
    expect(result.jobs.filter((job) => job.platform === 'moments')).toHaveLength(3);
    expect(result.jobs.filter((job) => job.platform === 'shipinhao')).toHaveLength(2);
    expect(result.jobs.filter((job) => job.platform === 'douyin')).toHaveLength(2);
    expect(result.jobs.filter((job) => job.delivery_kind === 'execution_package').map((job) => job.item_label)).toEqual([
      '视频号口播稿与拍摄说明 1',
      '视频号口播稿与拍摄说明 2',
      '抖音口播稿与拍摄说明 1',
      '抖音口播稿与拍摄说明 2',
    ]);
    expect(result.jobs.filter((job) => job.delivery_kind === 'execution_package').every((job) => !job.item_label.includes('执行包'))).toBe(true);
    expect(result.jobs.find((job) => job.platform === 'wechat')?.payload.asset_paths).toHaveLength(2);
    expect(result.jobs.filter((job) => job.platform === 'xiaohongshu').every((job) => job.payload.asset_paths.length === 5)).toBe(true);
    expect(result.jobs.filter((job) => job.platform === 'moments').every((job) => job.payload.asset_paths.length === 3)).toBe(true);
    expect(result.jobs.filter((job) => job.platform === 'moments').flatMap((job) => job.payload.asset_paths).every((path) => path.includes('/moments-'))).toBe(true);
    expect(result.jobs.every((job) => job.status === 'pending')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/token|cookie|secret/i);
  });

  it('uses the logged-in browser for a layout-only WeChat draft without a cover', () => {
    const platformDeliverables = deliverables();
    const wechat = platformDeliverables.wechat!;
    wechat.coverOptions = [];
    wechat.visualAssets = [];
    const selectedDeliverables = { wechat } as PlatformDeliverables;
    const result = createDraftQueue({
      runId: 'run-layout-only',
      runSlug: 'layout-only',
      packagePath: 'pipeline/package/layout-only.md',
      packageSha256: 'package-hash',
      deliverables: selectedDeliverables,
      assetHashes: {},
      contentFileHashes: Object.fromEntries(
        collectDraftContentPaths(selectedDeliverables).map((path) => [path, sha256(`body:${path}`)]),
      ),
      now: '2026-09-08T00:00:00.000Z',
    });

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      platform: 'wechat',
      adapter: 'authorized_browser',
      payload: { asset_paths: [] },
    });
    expect(result.jobs[0].fallback_adapter).toBeUndefined();
  });

  it('refuses direct execution when a queue is incomplete or its fixed job contract is altered', async () => {
    const incomplete = queue();
    incomplete.jobs.pop();
    const api = vi.fn(async () => ({ status: 'draft_filled' as const }));

    await expect(runDraftQueue(incomplete, {
      wechatOfficialApi: adapter('wechat_official_api', api),
    })).rejects.toThrow('发布任务必须完整包含');
    expect(api).not.toHaveBeenCalled();

    const wrongDelivery = queue();
    wrongDelivery.jobs[0].delivery_kind = 'execution_package';
    await expect(runDraftQueue(wrongDelivery, {})).rejects.toThrow('任务标识与交付类型必须匹配');
  });

  it('continues later jobs after one platform failure', async () => {
    const xhsCalls = vi.fn(async () => ({ status: 'retryable_failure' as const, code: 'temporary_network', message: 'later retry' }));
    const result = await runDraftQueue(queue(), {
      wechatOfficialApi: adapter('wechat_official_api', async () => ({ status: 'draft_filled' })),
      wechatBrowser: adapter('authorized_browser', async () => ({ status: 'draft_filled' })),
      xiaohongshuBrowser: adapter('authorized_browser', xhsCalls),
      momentsMobileBridge: adapter('mobile_bridge', async () => ({ status: 'draft_filled' })),
      executionPackage: adapter('download', async () => ({ status: 'draft_filled' })),
    }, { now: () => '2026-07-15T00:00:01.000Z' });

    expect(result.attemptedJobIds).toHaveLength(11);
    expect(xhsCalls).toHaveBeenCalledTimes(3);
    expect(result.queue.jobs.filter((job) => job.platform === 'xiaohongshu').every((job) => job.status === 'retryable_failure')).toBe(true);
    expect(result.queue.jobs.filter((job) => job.platform === 'moments').every((job) => job.status === 'draft_filled')).toBe(true);
    expect(result.queue.jobs.filter((job) => job.platform === 'douyin').every((job) => job.status === 'draft_filled')).toBe(true);
  });

  it('persists adapter failures only as safe code, display message, and debug ID', async () => {
    const logger = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await runDraftQueue(queue(), {
        wechatOfficialApi: adapter('wechat_official_api', async () => {
          throw new Error('TypeError: token=sk-super-secret at /Users/alice/private/adapter.ts:18');
        }),
        xiaohongshuBrowser: adapter('authorized_browser', async () => ({ status: 'draft_filled' })),
        momentsMobileBridge: adapter('mobile_bridge', async () => ({ status: 'draft_filled' })),
        executionPackage: adapter('download', async () => ({ status: 'draft_filled' })),
      });
      const job = result.queue.jobs.find((candidate) => candidate.platform === 'wechat')!;
      const serialized = JSON.stringify({ last_error: job.last_error, events: job.events });

      expect(job.last_error).toMatchObject({
        code: 'adapter_unavailable',
        displayMessage: expect.any(String),
        debugId: expect.stringMatching(/^err_/),
      });
      expect(job.last_error).not.toHaveProperty('message');
      expect(job.events.at(-1)).toMatchObject({
        code: 'adapter_unavailable',
        displayMessage: expect.any(String),
        debugId: expect.stringMatching(/^err_/),
      });
      expect(job.events.at(-1)).not.toHaveProperty('message');
      expect(serialized).not.toMatch(/sk-super-secret|\/Users\/alice|TypeError|adapter\.ts|\bat\s/i);
    } finally {
      logger.mockRestore();
    }
  });

  it('sanitizes legacy queue messages before returning or persisting them again', async () => {
    const initial = queue();
    const target = initial.jobs[0];
    target.status = 'retryable_failure';
    target.last_error = {
      code: 'legacy_adapter_failed',
      message: 'SyntaxError: cookie=session-secret at /Users/alice/private/legacy.ts:12',
    };
    target.events.push({
      at: '2026-07-15T00:00:01.000Z',
      status: 'retryable_failure',
      code: 'legacy_adapter_failed',
      message: '{"path":"/Users/alice/private/result.json","token":"sk-legacy-secret"}',
    });

    const result = await runDraftQueue(initial, {}, { jobIds: ['draft_not_selected'] });
    const restored = result.queue.jobs[0];
    const serialized = JSON.stringify({ last_error: restored.last_error, events: restored.events });

    expect(restored.last_error).toMatchObject({
      code: 'legacy_adapter_failed',
      displayMessage: expect.any(String),
      debugId: expect.stringMatching(/^err_legacy_/),
    });
    expect(restored.last_error).not.toHaveProperty('message');
    expect(restored.events.at(-1)).not.toHaveProperty('message');
    expect(serialized).not.toMatch(/session-secret|sk-legacy-secret|\/Users\/alice|SyntaxError|legacy\.ts|result\.json/i);
  });

  it('falls back to the authorized browser only when the official API is unavailable', async () => {
    const browser = vi.fn(async () => ({ status: 'draft_filled' as const }));
    const result = await runDraftQueue(queue(), {
      wechatOfficialApi: adapter('wechat_official_api', async () => ({ status: 'retryable_failure', code: 'api_unavailable' })),
      wechatBrowser: adapter('authorized_browser', browser),
      xiaohongshuBrowser: adapter('authorized_browser', async () => ({ status: 'draft_filled' })),
      momentsMobileBridge: adapter('mobile_bridge', async () => ({ status: 'draft_filled' })),
      executionPackage: adapter('download', async () => ({ status: 'draft_filled' })),
    });
    const wechat = result.queue.jobs.find((job) => job.platform === 'wechat');
    expect(browser).toHaveBeenCalledTimes(1);
    expect(wechat?.status).toBe('draft_filled');
    expect(wechat?.adapter).toBe('authorized_browser');
  });

  it('pauses CAPTCHA and device-confirmation outcomes for human handling', async () => {
    const result = await runDraftQueue(queue(), {
      wechatOfficialApi: adapter('wechat_official_api', async () => ({ status: 'draft_filled' })),
      xiaohongshuBrowser: adapter('authorized_browser', async () => ({ status: 'retryable_failure', code: 'captcha' })),
      momentsMobileBridge: adapter('mobile_bridge', async () => ({ status: 'retryable_failure', code: 'device_confirmation' })),
      executionPackage: adapter('download', async () => ({ status: 'draft_filled' })),
    });

    expect(result.queue.jobs.filter((job) => job.platform === 'xiaohongshu').every((job) => job.status === 'manual_intervention_required')).toBe(true);
    expect(result.queue.jobs.filter((job) => job.platform === 'moments').every((job) => job.status === 'manual_intervention_required')).toBe(true);
    expect(result.queue.jobs.filter((job) => job.platform === 'moments').every((job) => job.authorization_state === 'requires_human_action')).toBe(true);
  });

  it('never automatically retries an unknown completion', async () => {
    const initial = queue();
    const target = initial.jobs[0];
    target.status = 'unknown_completion';
    const api = vi.fn(async () => ({ status: 'draft_filled' as const }));
    const result = await runDraftQueue(initial, {
      wechatOfficialApi: adapter('wechat_official_api', api),
    }, { jobIds: [target.job_id] });

    expect(canAutomaticallyRetry(target)).toBe(false);
    expect(result.attemptedJobIds).toEqual([]);
    expect(result.skippedJobIds).toContain(target.job_id);
    expect(api).not.toHaveBeenCalled();
    expect(result.queue.jobs[0].status).toBe('unknown_completion');
  });

  it('only accepts a desktop bridge result bound to the current job and platform', () => {
    const initial = queue();
    const wechat = initial.jobs.find((job) => job.platform === 'wechat')!;
    const updated = applyDesktopDraftResult(initial, {
      jobId: wechat.job_id,
      payloadHash: wechat.payload_hash,
      receiptId: 'receipt_1234567890',
      adapter: 'wechat_official_api',
      result: {
        status: 'draft_filled',
        authorizationState: 'authorized',
        externalReference: 'wechat-draft:test',
      },
      now: '2026-07-15T00:00:02.000Z',
    });

    expect(updated.jobs.find((job) => job.job_id === wechat.job_id)?.status).toBe('draft_filled');
    expect(updated.jobs.find((job) => job.job_id === wechat.job_id)?.attempt_count).toBe(1);
    expect(updated.jobs.find((job) => job.job_id === wechat.job_id)?.desktop_receipt_ids).toEqual(['receipt_1234567890']);
    expect(() => applyDesktopDraftResult(initial, {
      jobId: wechat.job_id,
      payloadHash: wechat.payload_hash,
      receiptId: 'receipt_abcdefghij',
      adapter: 'mobile_bridge',
      result: { status: 'draft_filled' },
    })).toThrow('适配器');
  });

  it('accepts an explicitly retried manual prerequisite receipt but never unknown completion', () => {
    const initial = queue();
    const target = initial.jobs.find((job) => job.platform === 'xiaohongshu')!;
    target.status = 'manual_intervention_required';
    target.attempt_count = 1;
    expect(canAcceptDesktopReceipt(target)).toBe(true);

    const updated = applyDesktopDraftResult(initial, {
      jobId: target.job_id,
      payloadHash: target.payload_hash,
      receiptId: 'receipt_manual_retry_01',
      adapter: 'authorized_browser',
      result: { status: 'unknown_completion', authorizationState: 'requires_human_action' },
      now: '2026-07-15T00:00:03.000Z',
    });
    const completed = updated.jobs.find((job) => job.job_id === target.job_id)!;
    expect(completed.attempt_count).toBe(2);
    expect(completed.status).toBe('unknown_completion');
    expect(canAcceptDesktopReceipt(completed)).toBe(false);
    expect(() => applyDesktopDraftResult(updated, {
      jobId: target.job_id,
      payloadHash: target.payload_hash,
      receiptId: 'receipt_unknown_retry_02',
      adapter: 'authorized_browser',
      result: { status: 'draft_filled' },
    })).toThrow('不允许');
  });
});
