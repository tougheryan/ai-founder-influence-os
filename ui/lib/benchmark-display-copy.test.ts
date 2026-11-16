import { describe, expect, it } from 'vitest';
import { advisorGeneratedDisplayList, advisorGeneratedDisplayText } from './benchmark-display-copy';

describe('benchmark display copy', () => {
  it('maps legacy system wording without changing the stored record', () => {
    const stored = 'TikOmni 公开样本已写入母稿，固定 CTA 并完成机制蒸馏。';

    expect(advisorGeneratedDisplayText(stored)).toBe('平台数据中的参考内容已写入公众号文章，固定结尾引导并完成常用方法。');
    expect(stored).toContain('母稿');
  });

  it('maps each generated line while leaving ordinary copy alone', () => {
    expect(advisorGeneratedDisplayList(['把内容资产沉淀下来', '保留原始来源'])).toEqual([
      '把现有素材保存下来',
      '保留原始来源',
    ]);
  });
});
