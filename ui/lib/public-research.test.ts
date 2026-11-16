import { describe, expect, it, vi } from 'vitest';

vi.mock('./output-files', () => ({
  writeOutputFile: vi.fn(),
}));
vi.mock('./baoyu-visual-layer', () => ({
  buildBaoyuVisualLayer: vi.fn(),
}));

import { assertGeneratedResearchLanguage, buildRepairedValidateMarkdown } from './public-research';

describe('assertGeneratedResearchLanguage', () => {
  it('returns safe warning codes for reviewable wording', () => {
    expect(assertGeneratedResearchLanguage('综上所述，先核对三条平台数据。')).toEqual([
      { code: 'formulaic_conclusion', message: '结尾像模板总结，建议直接保留结论。' },
    ]);
  });

  it('blocks placeholders and local paths with a retry action', () => {
    try {
      assertGeneratedResearchLanguage('作为 AI，我会读取 /Users/example/private.md 和 {{待补充}}。');
      throw new Error('expected language gate to block');
    } catch (error) {
      expect(error).toMatchObject({
        definition: {
          code: 'research_language_blocked',
          action: { label: '重新生成', href: '/production' },
        },
      });
    }
  });
});

const sourceContent = `# 素材理解报告 · 测试

服务型创始人需要先说清客户问题，再介绍自己的方法。`;
const passagePlanContent = `# 低证据通行方案 · 测试

- 推荐低风险路线：行业观察 + 方法论清单
- 推荐首发平台：wechat
- 推荐理由：原案例缺少授权，改用一手观察和问题征集表达。`;

function buildReport(marketSignalContent: string) {
  return buildRepairedValidateMarkdown({
    sourcePath: 'pipeline/intake/market-check-intake.md',
    sourceContent,
    passagePlanPath: 'materials/research/market-check-passage-plan.md',
    passagePlanContent,
    marketSignalPath: 'materials/research/market-check-market-signal.md',
    marketSignalContent,
    platforms: ['wechat'],
  }).markdown;
}

describe('buildRepairedValidateMarkdown', () => {
  it('refuses to use deterministic repair as a zero-sample market bypass', () => {
    expect(() => buildReport(`## 0. 研究范围
- 样本数量：0`)).toThrow('不能通过低证据修复绕过选题门禁');
  });

  it('carries a completed market report count without relabeling it as sample-insufficient', () => {
    const markdown = buildReport(`## 0. 研究范围
- 样本数量：3`);

    expect(markdown).toContain('- 公开样本状态：已完成');
    expect(markdown).toContain('- 可验证样本数：3');
    expect(markdown).toContain('已经核对 3 条公开内容，只参考标题入口、文章结构和互动方式');
    expect(markdown).not.toContain('公开样本不足，立项只依据一手素材');
  });
});
