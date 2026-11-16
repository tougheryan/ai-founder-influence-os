import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-publish-assets-route-${process.pid}`,
  registrations: [] as Array<{ scope: string; path: string; runId?: string }>,
  approvals: {
    content_package: true,
    visual_assets: true,
  } as Record<string, boolean>,
  releaseGate: { status: 'pass', repaired: false, review_issues: [], blocking_issues: [], units: [] } as Record<string, unknown>,
  lockKeys: [] as string[],
  lockFailure: false,
  generateInput: null as Record<string, unknown> | null,
  emptyVisuals: false,
  partialWechatVisuals: false,
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

vi.mock('@/lib/output-files', () => ({ readOutputFile: async () => '# 内容包\n' }));
vi.mock('@/lib/content-release-gate', () => ({
  runContentReleaseGate: async () => mocks.releaseGate,
}));
vi.mock('@/lib/runtime-run-resolver', () => ({
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
  writeRuntimeOutput: async () => 'pipeline/package/repaired.md',
}));
vi.mock('@/lib/write-guard', () => {
  class WriteLockError extends Error {}
  return {
    WriteLockError,
    withProjectWriteLock: async <T>(key: string, callback: () => Promise<T>) => {
      mocks.lockKeys.push(key);
      if (mocks.lockFailure) throw new WriteLockError('同一任务正在执行');
      return callback();
    },
  };
});

function readyAsset(id: string, path: string, role = id) {
  return { id, role, label: id, path, status: 'ready' as const, action: '上传' };
}

function post(index: number, empty = false) {
  const xhsAssets = empty ? [] : Array.from({ length: 5 }, (_, page) => readyAsset(
    `xhs-0${index}-p${page + 1}`,
    `pipeline/visual/demo/publish/r001/xhs/post-0${index}/${page + 1}.png`,
  ));
  const momentsAssets = empty ? [] : [1, 3, 5].map((page) => readyAsset(
    `moments-0${index}-p${page}`,
    `pipeline/visual/demo/publish/r001/moments/post-0${index}/${page}.png`,
  ));
  return {
    index,
    title: `观点 ${index}`,
    copy: `正文 ${index}`,
    publishForms: {
      xiaohongshu: { title: `小红书 ${index}`, copy: `小红书正文 ${index}`, tags: [], imageOrder: 'P1-P5' },
      moments: { title: `朋友圈 ${index}`, copy: `朋友圈正文 ${index}`, tags: [], imageOrder: 'P1,P3,P5' },
    },
    publishPaths: { xiaohongshu: `pipeline/publish-assets/demo/xhs-${index}.md`, moments: `pipeline/publish-assets/demo/moments-${index}.md` },
    visualAssets: [...xhsAssets, ...momentsAssets],
    platformVisualAssets: { xiaohongshu: xhsAssets, moments: momentsAssets },
  };
}

function script(index: number) {
  return {
    index,
    title: `视频 ${index}`,
    oralScript: `口播 ${index}`,
    teleprompterScript: `提词器 ${index}`,
    hook: '钩子', duration: '45 秒', platformNote: '说明', tags: [],
    primaryPath: `pipeline/publish-assets/demo/video-${index}.md`, visualAssets: [],
  };
}

vi.mock('@/lib/publish-assets', () => ({
  generatePublishAssets: async (input: Record<string, unknown>) => {
    mocks.generateInput = input;
    const posts = [post(1, mocks.emptyVisuals), post(2, mocks.emptyVisuals), post(3, mocks.emptyVisuals)];
    const scripts = [script(1), script(2)];
    const coverOptions = mocks.emptyVisuals ? [] : [readyAsset(
      'wechat-cover',
      'pipeline/visual/demo/publish/r001/wechat/cover.png',
      'wechat_cover',
    )];
    const visualAssets = mocks.emptyVisuals || mocks.partialWechatVisuals ? [] : [readyAsset(
      'inline-01',
      'pipeline/visual/demo/publish/r001/inline/inline-01.png',
      'inline-01',
    )];
    return {
      slug: 'demo', reportPath: 'pipeline/publish-assets/demo.md', markdown: '# 发布成稿', generatedPaths: [],
      platformDeliverables: {
        wechat: {
          recommendedTitle: '公众号文章', summary: '摘要', markdownPath: 'pipeline/publish-assets/demo/wechat.md',
          htmlCandidates: [{ path: 'pipeline/publish-assets/demo/wechat.html', recommended: true }], copyText: '公众号正文',
          visualAssets, coverOptions, shareCopyPaths: [],
        },
        xiaohongshu: { posts }, moments: { posts }, shipinhao: { scripts }, douyin: { scripts },
        archive: { packagePath: 'pipeline/package/demo-package.md', reportPath: 'pipeline/publish-assets/demo.md', generatedPaths: [] },
      },
    };
  },
}));

import { POST } from './route';

const packagePath = 'pipeline/package/demo-package.md';

describe('POST /api/publish-assets', () => {
  beforeEach(async () => {
    mocks.registrations = [];
    mocks.approvals = { content_package: true, visual_assets: true };
    mocks.releaseGate = { status: 'pass', repaired: false, review_issues: [], blocking_issues: [], units: [] };
    mocks.lockKeys = [];
    mocks.lockFailure = false;
    mocks.generateInput = null;
    mocks.emptyVisuals = false;
    mocks.partialWechatVisuals = false;
    await rm(mocks.projectDir, { recursive: true, force: true });
    await mkdir(path.join(mocks.projectDir, 'pipeline', 'package'), { recursive: true });
    await mkdir(path.join(mocks.projectDir, 'pipeline', 'visual', 'demo'), { recursive: true });
    await writeFile(path.join(mocks.projectDir, packagePath), '# 内容包\n');
    await writeFile(
      path.join(mocks.projectDir, 'pipeline', 'visual', 'demo', 'selected-assets.json'),
      JSON.stringify({ schema: 'aifios.visual-asset-manifest.v1' }),
    );
    const visualPaths = [
      'pipeline/visual/demo/publish/r001/wechat/cover.png',
      'pipeline/visual/demo/publish/r001/inline/inline-01.png',
      ...[1, 2, 3].flatMap((index) => [
        ...Array.from({ length: 5 }, (_, page) => `pipeline/visual/demo/publish/r001/xhs/post-0${index}/${page + 1}.png`),
        ...[1, 3, 5].map((page) => `pipeline/visual/demo/publish/r001/moments/post-0${index}/${page}.png`),
      ]),
    ];
    await Promise.all(visualPaths.map(async (relativePath) => {
      const target = path.join(mocks.projectDir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, relativePath);
    }));
    const contentPaths = [
      'pipeline/publish-assets/demo/wechat.html',
      ...[1, 2, 3].flatMap((index) => [
        `pipeline/publish-assets/demo/xhs-${index}.md`,
        `pipeline/publish-assets/demo/moments-${index}.md`,
      ]),
      ...[1, 2].map((index) => `pipeline/publish-assets/demo/video-${index}.md`),
    ];
    await Promise.all(contentPaths.map(async (relativePath) => {
      const target = path.join(mocks.projectDir, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `approved body:${relativePath}`);
    }));
  });

  afterAll(async () => { await rm(mocks.projectDir, { recursive: true, force: true }); });

  it('turns approved platform deliverables into the draft-information phase artifact', async () => {
    const response = await POST(new Request('http://localhost/api/publish-assets', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packagePath }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.generateInput?.slug).toBe('demo');
    expect(payload.draftQueue.jobs).toHaveLength(11);
    expect(payload.draftQueue.jobs.find((job: { platform: string }) => job.platform === 'wechat').payload.asset_paths).toHaveLength(2);
    expect(payload.draftQueue.jobs.filter((job: { platform: string }) => job.platform === 'xiaohongshu').every((job: { payload: { asset_paths: string[] } }) => job.payload.asset_paths.length === 5)).toBe(true);
    expect(payload.draftQueue.jobs.filter((job: { platform: string }) => job.platform === 'moments').every((job: { payload: { asset_paths: string[] } }) => job.payload.asset_paths.length === 3)).toBe(true);
    expect(payload.draftQueuePath).toBe('materials/publication/drafts/demo/draft-queue.json');
    expect(mocks.registrations).toEqual([{
      scope: 'draft_information', path: 'materials/publication/drafts/demo/draft-queue.json', runId: 'demo-run',
    }]);
    expect(mocks.lockKeys).toEqual([
      'publish-assets:demo-run',
      'publication-draft-queue:materials/publication/drafts/demo/draft-queue.json',
    ]);
    expect(payload.idempotent_replay).toBe(false);
  });

  it('reuses an equivalent queue so a repeated prepare cannot reset adapter progress', async () => {
    const first = await POST(new Request('http://localhost/api/publish-assets', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packagePath }),
    }));
    expect(first.status).toBe(200);
    const queuePath = path.join(
      mocks.projectDir,
      'materials',
      'publication',
      'drafts',
      'demo',
      'draft-queue.json',
    );
    const persisted = JSON.parse(await readFile(queuePath, 'utf-8')) as {
      updated_at: string;
      jobs: Array<{ status: string; authorization_state: string; attempt_count: number }>;
    };
    persisted.updated_at = '2026-08-24T01:00:00.000Z';
    persisted.jobs[0].status = 'draft_filled';
    persisted.jobs[0].authorization_state = 'authorized';
    persisted.jobs[0].attempt_count = 1;
    await writeFile(queuePath, JSON.stringify(persisted));

    const second = await POST(new Request('http://localhost/api/publish-assets', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packagePath }),
    }));
    const payload = await second.json();

    expect(second.status).toBe(200);
    expect(payload.idempotent_replay).toBe(true);
    expect(payload.draftQueue.jobs[0]).toMatchObject({
      status: 'draft_filled',
      authorization_state: 'authorized',
      attempt_count: 1,
    });
  });

  it('blocks queue creation until the current selected-assets manifest has a visual approval', async () => {
    mocks.approvals.visual_assets = false;

    const response = await POST(new Request('http://localhost/api/publish-assets', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packagePath }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'visual_approval_required' });
    expect(mocks.registrations).toEqual([]);
  });

  it('refuses to create a final queue when approved visuals were lost during binding', async () => {
    mocks.emptyVisuals = true;

    const response = await POST(new Request('http://localhost/api/publish-assets', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packagePath }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toMatchObject({ code: 'visual_assets_incomplete' });
    expect(payload.issues).not.toContain('公众号缺少已采用的封面图');
    expect(payload.issues.some((issue: string) => issue.includes('小红书'))).toBe(true);
    expect(mocks.registrations).toEqual([]);
  });

  it('keeps an optional partial WeChat image selection without requiring a full image suite', async () => {
    mocks.partialWechatVisuals = true;

    const response = await POST(new Request('http://localhost/api/publish-assets', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packagePath }),
    }));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload.draftQueue.jobs.find((job: { platform: string }) => job.platform === 'wechat').payload.asset_paths).toEqual([
      'pipeline/visual/demo/publish/r001/wechat/cover.png',
    ]);
    expect(mocks.registrations).toHaveLength(1);
  });

  it('allows a content package already confirmed by the operator to proceed after a review-required result', async () => {
    mocks.releaseGate = {
      status: 'review_required',
      repaired: false,
      review_issues: ['需要负责人确认表达边界。'],
      blocking_issues: [],
      units: [],
    };

    const response = await POST(new Request('http://localhost/api/publish-assets', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packagePath }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.registrations).toHaveLength(1);
  });

  it('returns a recoverable conflict while the same run is already preparing drafts', async () => {
    mocks.lockFailure = true;

    const response = await POST(new Request('http://localhost/api/publish-assets', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ packagePath }),
    }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'content_changed' });
  });
});
