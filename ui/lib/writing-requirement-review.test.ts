import { describe, expect, it } from 'vitest';
import { inspectWritingRequirements } from './writing-requirement-review';

const video = (words: string) => `## 3. 视频号原生口播\n- 发布标题：测试\n### 逐句口播稿\n| 时间段 | 口播文案 | 屏幕字幕 | 对应画面 |\n|---|---|---|---|\n| 0-30 秒 | ${words} | 字幕不会计入口播 | 白板 |\n### 镜头清单\n其他内容不计入`;
describe('checks this piece against its explicit requirements', () => {
  it.each([196, 204, 317])('counts %i non-whitespace characters independently of subtitle and time columns', (count) => {
    const result = inspectWritingRequirements(video('文'.repeat(count - 4) + ' 12？。'), ['口播控制在250–350字']);
    expect(result.characterCount).toBe(count);
    expect(result.findings.some((finding) => finding.kind === 'length')).toBe(count < 250);
  });
  it('quotes the ending, first-person statements and explicitly banned words without certifying facts', () => {
    const result = inspectWritingRequirements(video('我们已经修好了。<br>带来赋能。<br>现在可以交付。'), ['不用第一人称。', '不写“赋能、闭环”。', '结尾用一个具体问题。']);
    expect(result.ending).toBe('现在可以交付。');
    expect(result.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'ending', quote: '现在可以交付。' }),
      expect.objectContaining({ kind: 'first-person', quote: '我们已经修好了。' }),
      expect.objectContaining({ kind: 'banned-word', quote: '带来赋能。' }),
    ]));
  });
  it('does not impose a length, style or question rule when the author did not request it', () => {
    const result = inspectWritingRequirements(video('我们已经修好了。'), []);
    expect(result.range).toBeUndefined(); expect(result.findings).toEqual([]);
    expect(inspectWritingRequirements(video('我试过了。'), ['结尾不要提问。']).findings).toEqual([]);
    expect(inspectWritingRequirements(video('你会先检查哪一项？'), ['结尾留一个问题。']).findings).toEqual([]);
  });
  it('does not invent a range when requirements conflict, or count an unreadable table as zero', () => {
    expect(inspectWritingRequirements(video('正文。'), ['口播250–350字', '口播150–200字']).range).toBeUndefined();
    const report = inspectWritingRequirements(video('正文。').replace('| 口播文案 |', '| 未知 |'), []);
    expect(report.characterCount).toBeNull(); expect(report.findings[0].kind).toBe('unreadable');
  });
});
