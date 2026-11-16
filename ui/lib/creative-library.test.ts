import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  project: '/tmp/aifios-creative-library-test',
}));
const PROJECT = mocks.project;

vi.mock('./project-root', () => ({
  PROJECT_DIR: mocks.project,
  projectPath: (...parts: string[]) => `${mocks.project}/${parts.join('/')}`,
  runtimeJoin: (...parts: string[]) => parts.join('/'),
  safeResolve: (base: string, target: string) => {
    const normalized = target.replace(/\\/g, '/').replace(/^\/+/, '');
    if (normalized.split('/').some((part) => part === '..')) return null;
    return `${base}/${normalized}`;
  },
}));

import {
  collectPublishedScript,
  collectAllPublishedScripts,
  createCreativeProposal,
  creativeLibraryContext,
  listPublishedScriptCandidates,
  listPublishedScripts,
  readCreativeProfile,
  readCreativeRules,
  resolveCreativeProposal,
  saveCreativeProfile,
  saveCreativeRules,
} from './creative-library';

const HASH = 'a'.repeat(64);
const NOW = '2026-07-17T08:00:00.000Z';
const RECORD_ID = 'publication_1234567890abcdef1234';
const JOB_ID = 'draft_1234567890abcdef1234';

async function writeConfirmedPublicationFixture() {
  await mkdir(`${PROJECT}/materials/publication/ledger/demo`, { recursive: true });
  await mkdir(`${PROJECT}/materials/publication/drafts/demo`, { recursive: true });
  await mkdir(`${PROJECT}/pipeline/package`, { recursive: true });
  await writeFile(`${PROJECT}/pipeline/package/demo.md`, '# 已确认的文章\n\n这里是一篇可以学习的发布正文。', 'utf-8');
  await writeFile(`${PROJECT}/materials/publication/drafts/demo/draft-queue.json`, JSON.stringify({
    schema: 'aifios.publication-draft-queue.v1',
    queue_id: 'queue_demo',
    run_id: 'run_demo',
    run_slug: 'demo',
    package_path: 'pipeline/package/demo.md',
    package_sha256: HASH,
    created_at: NOW,
    updated_at: NOW,
    jobs: [{
      job_id: JOB_ID,
      platform: 'wechat',
      item_id: 'wechat_article',
      item_label: '公众号文章',
      delivery_kind: 'draft_fill',
      adapter: 'wechat_official_api',
      payload: {
        title: '稳定入口如何沉淀内容资产',
        copy_path: 'pipeline/package/demo.md',
        asset_paths: [],
      },
      payload_hash: HASH,
      content_hash: HASH,
      selected_asset_hashes: [],
      status: 'published_confirmed',
      authorization_state: 'authorized',
      attempt_count: 1,
      retry_count: 0,
      events: [],
    }],
  }, null, 2), 'utf-8');
  await writeFile(`${PROJECT}/materials/publication/ledger/demo/publication-ledger.json`, JSON.stringify({
    schema: 'aifios.publication-ledger.v1',
    ledger_id: 'ledger_demo',
    queue_id: 'queue_demo',
    run_id: 'run_demo',
    run_slug: 'demo',
    queue_path: 'materials/publication/drafts/demo/draft-queue.json',
    queue_sha256: HASH,
    created_at: NOW,
    updated_at: NOW,
    records: [{
      record_id: RECORD_ID,
      queue_id: 'queue_demo',
      job_id: JOB_ID,
      platform: 'wechat',
      item_id: 'wechat_article',
      final_content_hash: HASH,
      payload_hash: HASH,
      selected_asset_hashes: [],
      published_url: 'https://mp.weixin.qq.com/s/demo',
      published_at: NOW,
      human_confirmed: true,
      recorded_at: NOW,
    }],
  }, null, 2), 'utf-8');
}

describe('creative library contracts', () => {
  beforeEach(async () => {
    await rm(PROJECT, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(PROJECT, { recursive: true, force: true });
  });

  it('loads concurrent first-use context without requiring existing asset directories', async () => {
    const contexts = await Promise.all(Array.from({ length: 8 }, () => creativeLibraryContext()));
    expect(contexts).toEqual(Array(8).fill(''));
    expect((await readCreativeProfile()).initialized).toBe(false);
    expect((await readCreativeRules()).initialized).toBe(false);
  });

  it('rejects a symlink in the asset directory during first-use context loading', async () => {
    await mkdir(`${PROJECT}/outside`, { recursive: true });
    await symlink(`${PROJECT}/outside`, `${PROJECT}/brain`);
    await expect(creativeLibraryContext()).rejects.toThrow('创作资产目录不能使用符号链接');
  });

  it('requires a manual profile first and retains exactly the previous approved version', async () => {
    await expect(saveCreativeProfile({ action: 'update', profile: { identity: '内容创作者' } }))
      .rejects.toThrow('请先手动初始化');

    const first = await saveCreativeProfile({
      action: 'initialize',
      profile: { creatorName: '常欢', identity: '商业内容创作者', contentPillars: ['商业诊断', '个人成长'] },
    });
    const second = await saveCreativeProfile({
      action: 'update',
      profile: { writingStyle: '直给、有证据、避免空话' },
    });

    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.previous?.version).toBe(1);
    expect(second.previous?.profile.writingStyle).toBe('');
    expect((await readCreativeProfile()).profile.writingStyle).toBe('直给、有证据、避免空话');
    expect(await creativeLibraryContext()).toContain('本篇明确提出的要求优先');
  });

  it('applies or rejects profile and rules proposals one by one after initialization', async () => {
    await saveCreativeProfile({ action: 'initialize', profile: { identity: '内容创作者' } });
    await saveCreativeRules({ action: 'initialize', items: [] });

    const profileProposal = await createCreativeProposal({
      target: 'profile',
      reason: '5 篇发布稿都使用了具体场景开头。',
      patch: { expressionPreferences: '优先从一个具体场景进入' },
      source: { kind: 'published_scripts', scriptIds: [] },
    });
    const accepted = await resolveCreativeProposal({ action: 'accept', proposalId: profileProposal.id });
    expect(accepted.profile?.profile.expressionPreferences).toBe('优先从一个具体场景进入');
    expect(accepted.pending.total).toBe(0);

    const rulesProposal = await createCreativeProposal({
      target: 'rules',
      reason: '反复人工修改表明开头不应堆背景。',
      patch: {
        upsert: [{
          title: '开头规则',
          content: '开头先给冲突或现场，不先堆背景。',
          category: 'style',
          enabled: true,
        }],
      },
    });
    const rejected = await resolveCreativeProposal({ action: 'reject', proposalId: rulesProposal.id });
    expect(rejected.proposal.status).toBe('rejected');
    expect((await readCreativeRules()).items).toEqual([]);
  });

  it('does not save unsafe generated proposals into the writing profile', async () => {
    await saveCreativeProfile({ action: 'initialize', profile: { identity: '内容创作者' } });

    await expect(createCreativeProposal({
      target: 'profile',
      reason: '作为一个 AI，已经完成分析。',
      patch: { expressionPreferences: '读取 /Users/example/private/profile.md 后写作' },
    })).rejects.toThrow('暂时不能保存为写作参考');

    expect((await readCreativeProfile()).profile.expressionPreferences).toBe('');
  });

  it('refuses stale profile/rule saves and stale proposals without overwriting approved settings', async () => {
    await saveCreativeProfile({ action: 'initialize', profile: { writingStyle: '原风格' }, expectedVersion: 0 });
    const proposal = await createCreativeProposal({ target: 'profile', reason: '作者核对', patch: { writingStyle: '旧建议' } });
    await saveCreativeProfile({ action: 'update', profile: { writingStyle: '新设置' }, expectedVersion: 1 });
    await expect(saveCreativeProfile({ action: 'update', profile: { writingStyle: '过期窗口' }, expectedVersion: 1 })).rejects.toThrow('写作设置已更新');
    await expect(resolveCreativeProposal({ action: 'accept', proposalId: proposal.id })).rejects.toThrow('写作设置已更新');
    expect((await readCreativeProfile()).profile.writingStyle).toBe('新设置');
    await saveCreativeRules({ action: 'initialize', items: [], expectedVersion: 0 });
    await expect(saveCreativeRules({ action: 'update', items: [], expectedVersion: 0 })).rejects.toThrow('写作设置已更新');
    // Rejecting an old suggestion does not mutate settings and remains allowed.
    expect((await resolveCreativeProposal({ action: 'reject', proposalId: proposal.id })).proposal.status).toBe('rejected');
  });

  it('lists confirmed publication candidates and collects a script idempotently from the ledger', async () => {
    await writeConfirmedPublicationFixture();

    const candidates = await listPublishedScriptCandidates();
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceRecordId: RECORD_ID,
      title: '稳定入口如何沉淀内容资产',
      platform: 'wechat',
      form: 'wechat_article',
      contentAvailable: true,
      collected: false,
    });

    const first = await collectPublishedScript(RECORD_ID);
    const second = await collectPublishedScript(RECORD_ID);
    expect(first.idempotent).toBe(false);
    expect(first.item.content).toContain('可以学习的发布正文');
    expect(first.item.learnable).toBe(true);
    expect(second.idempotent).toBe(true);
    expect(second.item.id).toBe(first.item.id);

    const scripts = await listPublishedScripts();
    expect(scripts.total).toBe(1);
    expect((scripts.items[0] as unknown as Record<string, unknown>).content).toBeUndefined();
    expect((await listPublishedScriptCandidates())[0].collected).toBe(true);
  });

  it('collects all confirmed publication candidates in one idempotent action', async () => {
    await writeConfirmedPublicationFixture();

    const first = await collectAllPublishedScripts();
    const second = await collectAllPublishedScripts();

    expect(first).toMatchObject({ created: 1, existing: 0 });
    expect(first.items).toHaveLength(1);
    expect(second).toMatchObject({ created: 0, existing: 1 });
    expect(second.items[0].sourceRecordId).toBe(RECORD_ID);
  });
});
