import { describe, expect, it } from 'vitest';
import {
  inspectGeneratedLanguage,
  productVoiceInstructionForSkill,
  PRODUCT_VOICE_INSTRUCTION,
  scoreHumanizedInterfaceCopy,
} from './product-voice';

describe('product voice contract', () => {
  it('tells generators to write plainly without changing machine contracts', () => {
    expect(PRODUCT_VOICE_INSTRUCTION).toContain('直接给判断和下一步');
    expect(PRODUCT_VOICE_INSTRUCTION).toContain('公众号、小红书或视频号');
    expect(PRODUCT_VOICE_INSTRUCTION).toContain('JSON 字段、固定报告标题');
  });

  it('keeps the coworker tone out of publishable content prompts', () => {
    const publishing = productVoiceInstructionForSkill('content-package');
    const analysis = productVoiceInstructionForSkill('content-validate');

    expect(analysis).toContain('内容团队里负责把事情说清楚的同事');
    expect(publishing).toContain('必须服从当前客户的创作名片');
    expect(publishing).toContain('不要套用产品界面的“内容团队同事”口吻');
    expect(publishing).not.toContain('直接给判断和下一步');
  });

  it('blocks assistant meta-language and local secrets before save', () => {
    const review = inspectGeneratedLanguage([
      '作为一个 AI，我建议先完成这一步。',
      '希望以上内容对你有所帮助。',
      '草稿在 /Users/example/private/draft.md',
      'sk-1234567890abcdefghijkl',
    ].join('\n'));

    expect(review.blocking.map((item) => item.code)).toEqual([
      'assistant_identity',
      'assistant_signoff',
      'local_path',
      'secret_like_value',
    ]);
  });

  it('blocks unfinished placeholders and deployment paths', () => {
    const review = inspectGeneratedLanguage('正文：{{客户案例}}\n附件：/workspace/private/draft.md');
    expect(review.blocking.map((item) => item.code)).toEqual(['local_path', 'template_placeholder']);
  });

  it('blocks raw exceptions, system paths, and Chinese credential labels before save', () => {
    const review = inspectGeneratedLanguage([
      '文件：/Applications/Echo Founder.app/private.json',
      '密钥：my-private-token',
      'TypeError: cannot read property',
      '    at render (/opt/app/server.js:12:4)',
    ].join('\n'));

    expect(review.blocking.map((item) => item.code)).toEqual([
      'local_path',
      'secret_like_value',
      'raw_exception',
    ]);
  });

  it('checks fixed machine text for safety without applying tone warnings to it', () => {
    const review = inspectGeneratedLanguage(
      '固定字段：综上所述\n文件：/Library/private.json',
      '根据本周三条已发布内容，下周先补一条具体案例。',
    );
    expect(review.blocking.map((item) => item.code)).toEqual(['local_path']);
    expect(review.warnings).toEqual([]);
  });

  it('warns about formulaic filler without blocking legitimate AI topics', () => {
    const review = inspectGeneratedLanguage('AI 产品先解决客户问题。综上所述，需要持续优化并形成闭环。');
    expect(review.blocking).toEqual([]);
    expect(review.warnings.map((item) => item.code)).toContain('formulaic_conclusion');
    expect(review.warnings.map((item) => item.code)).toContain('abstract_phrase_density');
  });

  it('scores the core interface copy above the humanizer delivery gate', () => {
    const score = scoreHumanizedInterfaceCopy([
      '从添加素材到准备发布，按顺序完成 7 个步骤。',
      '集中管理账号资料、已发布内容和原始素材，写作时会自动参考。',
      '查看公众号、小红书和视频号的同类内容，再决定本期主题。',
      '系统会整理出 7 份平台草稿和 4 个可下载文件，只准备内容，不会自动发布。',
      '补录真实数据和评论，确认后保存为今后的写作参考。',
    ]);
    expect(score.total).toBeGreaterThanOrEqual(45);
    expect(score).toMatchObject({
      directness: 10,
      credibility: 10,
      authenticity: 10,
      concision: 10,
    });
  });
});
