import { describe, expect, it } from 'vitest';
import { displayEnhancementError, displayEnhancementOutput } from './CreativeEnhancementDrawer';

describe('CreativeEnhancementDrawer copy boundary', () => {
  it('uses natural product language for generated results', () => {
    expect(displayEnhancementOutput('检查母稿、1+2+3 内容包、CTA 图与 B-roll。')).toBe(
      '检查公众号文章、全部 6 份内容、结尾图与补充画面。',
    );
  });

  it('does not expose technical identifiers or local paths', () => {
    const unsafe = 'TypeError: pipeline/runs/run_abc/schema.json failed at /Users/demo/project';
    expect(displayEnhancementError(unsafe)).toBe(
      '这项检查没有完成。请重试；如果仍然失败，请到系统设置测试连接。',
    );
    expect(displayEnhancementOutput('{"schema":"x","hash":"abcdef"}')).toBe(
      '检查结果暂时无法显示。请重新检查。',
    );
  });
});
