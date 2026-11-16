import { describe, expect, it } from 'vitest';
import { appendPreferenceText, draftPreferenceCandidates, reusablePreferenceText } from './draft-preference-candidates';

describe('optional reusable author preferences', () => {
  it('keeps exact audience, tone and prohibitions, omitting the article assignment', () => {
    const choices = draftPreferenceCandidates(['想写一篇公众号文章给小团队负责人。', '只做公众号，700至900字，平实一点，不写营销口号、不引导私信或购买，结尾只保留一句行动建议。']);
    expect(choices.map(({ field, value }) => ({ field, value }))).toEqual([
      { field: 'targetAudience', value: '小团队负责人' },
      { field: 'writingStyle', value: '平实一点' },
      { field: 'prohibitions', value: '不写营销口号、不引导私信或购买' },
    ]);
  });
  it('does not turn a one-off qualifier, third-party quote or internal constraint into a permanent habit', () => {
    expect(draftPreferenceCandidates(['本次要求：平实一点，不引导私信。', '仅供内部测试，不要公开。', '客户说：“语气：平实，不写营销口号。”', '例如：语气：口语化。', '目标读者：本次验收人员。', '不写客户姓名。'])).toEqual([]);
  });
  it.each(['这一篇', '这一次', '这一条', '这个月临时', '这回', '本轮', '今天的稿子', '这份稿子'])('keeps explicit one-off scope across compound clauses: %s', (scope) => {
    expect(draftPreferenceCandidates([`语气：平实，只用于${scope}，不引导私信。`])).toEqual([]);
    expect(reusablePreferenceText(`仅用于${scope}，不引导私信`)).toBe(false);
  });
  it('keeps time limits attached to an otherwise reusable expression clause', () => {
    expect(draftPreferenceCandidates(['语气：克制，只有今天的稿子这样写。', '这一次，语气：平实，不写营销口号。'])).toEqual([]);
  });
  it('does not confuse an explicit ongoing habit with a one-off assignment', () => {
    expect(draftPreferenceCandidates(['语气：平实', '不引导私信或购买'])).toHaveLength(2);
  });
  it('does not infer the creator or audience from facts and rejects quotes as preferences', () => {
    expect(draftPreferenceCandidates(['我经营一家设计公司。', '客户都是创始人。', '语气：“像马云一样说话”。'])).toEqual([]);
  });
  it('offers only current supplied requirements, and deduplicates exact repeats', () => {
    expect(draftPreferenceCandidates(['语气：平实', '语气：平实', '目标受众：项目负责人']).map((item) => item.value)).toEqual(['平实', '项目负责人']);
    expect(draftPreferenceCandidates([])).toEqual([]);
  });
  it('preserves existing text when adding a selected preference and does not repeat it', () => {
    expect(appendPreferenceText('温和\n不堆术语', ['平实', '平实', '温和'])).toBe('温和\n不堆术语\n平实');
  });
  it.each(['700字', '八百字', '本篇不要营销', '内部验收使用', '只做公众号', '不要写客户名字', '第一条\n第二条', '', 'a'.repeat(601)])('does not allow edited one-off preference %s', (value) => {
    expect(reusablePreferenceText(value)).toBe(false);
  });
});
