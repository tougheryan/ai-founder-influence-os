import { describe, expect, it } from 'vitest';

import {
  contentRadarGeneratedDisplayList,
  contentRadarGeneratedDisplayText,
} from './content-radar-display-copy';

describe('content radar display copy', () => {
  it('keeps old reports readable without rewriting their stored structure', () => {
    const stored = '基于 24 条公开样本，按机会分筛选，并从本批样本提取 4 类可迁移机制。';

    expect(contentRadarGeneratedDisplayText(stored)).toBe(
      '基于 24 条参考内容，按推荐分筛选，并从这批参考内容归纳出 4 种值得尝试的写法。',
    );
    expect(stored).toContain('公开样本');
  });

  it('renames legacy report headings and evidence labels', () => {
    expect(contentRadarGeneratedDisplayList([
      '小红书「美妆行业」内容机会深度报告',
      '小红书内容机制手册',
      '样本语义推导（非评论事实）',
    ])).toEqual([
      '小红书「美妆行业」选题分析报告',
      '小红书常用写法',
      '根据参考内容判断（非评论事实）',
    ]);
  });

  it('never renders local paths, identifiers, secrets, stacks or raw JSON', () => {
    const unsafe = [
      '报告路径：/Users/alice/private/report.json',
      'run_id: run_123456789',
      'API Key=sk-private-secret',
      'TypeError: failed\n    at run (app.js:1:1)',
      '{"snapshot":"private","token":"secret"}',
    ];

    for (const value of unsafe) {
      expect(contentRadarGeneratedDisplayText(value)).toBe('这部分结果暂时无法显示。请更新选题后再看。');
    }
  });
});
