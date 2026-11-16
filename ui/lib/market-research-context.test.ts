import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ files: {} as Record<string, string>, verified: true }));
vi.mock('./output-files', () => ({ readOutputFile: async (path: string) => {
  if (!(path in fixture.files)) throw new Error('研究文件不存在');
  return fixture.files[path];
} }));
vi.mock('./runtime-writer', () => ({ verifyRuntimeTikomniMarketSnapshot: async (runId: string, path: string) => ({ verified: fixture.verified, run_id: runId, manifest_path: path, snapshot_sha256: JSON.parse(fixture.files[path]).sha256 }) }));
import { formatMarketResearchContext, verifiedMarketResearchContext } from './market-research-context';

const snapshotPath = 'runs/run-a/market-research/sample/snapshot.json';
const normalizedPath = 'runs/run-a/market-research/sample/normalized-samples.json';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const signals = Array.from({ length: 10 }, (_, index) => ({
  platform: 'wechat_mp', title: `客户问题 ${index + 1}`, sample_class: 'insufficient',
  classification_reason: '有效表现指标少于两个', metrics: { reads: null, likes: null },
  source_url: `https://mp.weixin.qq.com/s/example-${index}`, provider: 'tikomni',
  captured_at: '2026-09-15T15:45:17+08:00', hook: '记录、筛选、展开客户问题。',
}));
function archive(overrides = {}) {
  const normalized = JSON.stringify({ signals });
  const digest = hash('fixture digest excluding sha256 field');
  const manifest = JSON.stringify({ sha256: digest, run_id: 'run-a', normalized_path: normalizedPath, normalized_sha256: hash(normalized), required_platforms: ['wechat_mp'], ...overrides });
  fixture.files[normalizedPath] = normalized;
  fixture.files[snapshotPath] = manifest;
  return { snapshotPath, snapshotSha256: digest };
}
beforeEach(() => { fixture.files = {}; fixture.verified = true; });

describe('archived research prompt context', () => {
  it('preserves all ten WeChat samples, insufficient grades, sources and unknown metrics', async () => {
    const context = await verifiedMarketResearchContext(archive(), 'run-a');
    expect(context).toContain('公众号：10 条');
    expect(context).toContain('指标不足 10 条');
    expect(context).toContain('example-9');
    expect(context).toContain('reads=未知');
    expect(context).not.toContain('reads=0');
    expect(context).toContain('不能称为已验证爆款');
    expect(context).toContain('记录、筛选、展开客户问题');
    expect(context).not.toContain('小红书：');
  });
  it('keeps complete platform totals when examples are shortened, separating absent platforms', () => {
    const context = formatMarketResearchContext({ signals: [...signals, ...signals, { ...signals[0], platform: 'xhs', sample_class: 'related', metrics: { likes: 0 } }] }, ['wechat_mp', 'xhs', 'shipinhao']);
    expect(context).toContain('公众号：20 条');
    expect(context).toContain('统计覆盖全部 20 条');
    expect(context).toContain('小红书：1 条');
    expect(context).toContain('相关样本 1 条');
    expect(context).toContain('likes=0');
    expect(context).toContain('视频号：0 条');
  });
  it('refuses changed archives, changed samples, missing data and cross-run references', async () => {
    let binding = archive();
    fixture.files[snapshotPath] = fixture.files[snapshotPath].replace(binding.snapshotSha256, '0'.repeat(64));
    await expect(verifiedMarketResearchContext(binding, 'run-a')).rejects.toThrow('研究快照摘要已变化');
    binding = archive(); fixture.files[normalizedPath] += ' ';
    await expect(verifiedMarketResearchContext(binding, 'run-a')).rejects.toThrow('分平台样本摘要已变化');
    binding = archive();
    await expect(verifiedMarketResearchContext(binding, 'run-b')).rejects.toThrow('不属于当前研究快照');
    binding = archive({ normalized_path: 'runs/other/normalized-samples.json' });
    await expect(verifiedMarketResearchContext(binding, 'run-a')).rejects.toThrow('不属于当前研究快照');
    binding = archive(); delete fixture.files[normalizedPath];
    await expect(verifiedMarketResearchContext(binding, 'run-a')).rejects.toThrow('研究文件不存在');
    binding = archive(); fixture.verified = false;
    await expect(verifiedMarketResearchContext(binding, 'run-a')).rejects.toThrow('未通过存档校验');
  });
});
