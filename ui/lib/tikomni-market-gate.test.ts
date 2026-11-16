import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verification: {
    verified: true,
    run_id: 'topic-run',
    manifest_path: 'runs/topic-run/market-research/fixture/snapshot.json',
    snapshot_sha256: 'a'.repeat(64),
    source_path: 'pipeline/intake/topic-intake.md',
  } as Record<string, unknown>,
}));

vi.mock('@/lib/runtime-writer', () => ({
  verifyRuntimeTikomniMarketSnapshot: async () => mocks.verification,
}));

import {
  assertMarketSnapshotBoundToIntake,
  marketSignalEvidenceFromReport,
  marketSnapshotBindingFromReport,
} from './tikomni-market-gate';

const report = [
  '# 爆款抓取与对标报告',
  '- 上游素材：pipeline/intake/topic-intake.md',
  '- 研究快照：runs/topic-run/market-research/fixture/snapshot.json',
  `- 快照 SHA-256：${'a'.repeat(64)}`,
].join('\n');

describe('TikOmni market gate', () => {
  beforeEach(() => {
    mocks.verification = {
      verified: true,
      run_id: 'topic-run',
      manifest_path: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshot_sha256: 'a'.repeat(64),
      source_path: 'pipeline/intake/topic-intake.md',
    };
  });

  it('extracts the exact candidate snapshot binding from the market report', () => {
    expect(marketSnapshotBindingFromReport(report, '爆款抓取与对标报告')).toEqual({
      snapshotPath: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshotSha256: 'a'.repeat(64),
    });
  });

  it('requires the verifier to agree on run, source, manifest path, and digest', async () => {
    await expect(assertMarketSnapshotBoundToIntake(
      report,
      'pipeline/intake/topic-intake.md',
      'topic-run',
      '爆款抓取与对标报告',
    )).resolves.toEqual({
      snapshotPath: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshotSha256: 'a'.repeat(64),
    });

    mocks.verification = {
      verified: true,
      run_id: 'topic-run',
      manifest_path: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshot_sha256: 'b'.repeat(64),
      source_path: 'pipeline/intake/topic-intake.md',
    };
    await expect(assertMarketSnapshotBoundToIntake(
      report,
      'pipeline/intake/topic-intake.md',
      'topic-run',
      '爆款抓取与对标报告',
    )).rejects.toThrow('摘要与存档不一致');

    mocks.verification = {
      verified: true,
      run_id: 'topic-run',
      manifest_path: 'runs/topic-run/market-research/fixture/snapshot.json',
      snapshot_sha256: 'a'.repeat(64),
      source_path: 'pipeline/intake/other-intake.md',
    };
    await expect(assertMarketSnapshotBoundToIntake(
      report,
      'pipeline/intake/topic-intake.md',
      'topic-run',
      '爆款抓取与对标报告',
    )).rejects.toThrow('不属于当前素材理解报告');
  });

  it('rejects malformed reports before any snapshot can be trusted', () => {
    expect(() => marketSnapshotBindingFromReport('# 空报告', '爆款抓取与对标报告'))
      .toThrow('缺少 TikOmni 研究快照路径或 SHA-256');
  });

  it('extracts a positive sample count as frozen market evidence', () => {
    expect(marketSignalEvidenceFromReport(`${report}\n- 样本数量：10`, '爆款抓取与对标报告'))
      .toEqual({ sampleCount: 10, creatorMode: false });
  });

  it('rejects zero samples even when a legacy report declares creator mode', () => {
    expect(() => marketSignalEvidenceFromReport(report, '爆款抓取与对标报告'))
      .toThrow('缺少有效的可验证样本数量');
    expect(() => marketSignalEvidenceFromReport(`${report}\n- 样本数量：0\n- 实时信号状态：creator_mode\n- 创作模式：是`, '爆款抓取与对标报告'))
      .toThrow('没有取得任何已选平台的可验证公开样本');
  });
});
