import { describe, expect, it } from 'vitest';
import { publicationTextFromPackage, spokenScript } from './publication-text';

const table = '| 时间段 | 口播文案 | 屏幕字幕 | 对应画面 |\n|---|---|---|---|\n| 0-10秒 | 第一段原话，数字 12:30 不改。 | 字幕一 | 白板 |\n| 10-20秒 | A\\|B 是原话。<br>下一句。 | 字幕二 | 正面 |';
const video = `## 3. 视频号原生口播\n- 发布标题：标题原话\n- 3秒钩子：未确认是否加入的开场提示\n### 逐句口播稿\n${table}\n### 镜头清单\n内部说明不能复制进正文`;
const xhs = '## 2. 小红书原生图文\n### 发布正文\n- 标题：图文标题\n- 正文：第一段。\n\n第二段。\n- 结尾问题：你怎么看？\n### 结尾标签\n#原标签';

describe('publication fields and spoken script', () => {
  it('extracts only spoken words while retaining exact punctuation, escaped pipes, line breaks and order', () => {
    const result = spokenScript(table);
    expect(result.text).toBe('第一段原话，数字 12:30 不改。\n\nA|B 是原话。\n下一句。');
    expect(result.segments[1]).toEqual({ time: '10-20秒', words: 'A|B 是原话。\n下一句。', subtitle: '字幕二', picture: '正面' });
  });
  it('preserves prose without guessing that a colon or list is metadata', () => {
    expect(spokenScript('客户说：先等等。\n\n- 第一点：确认范围。').text).toBe('客户说：先等等。\n\n- 第一点：确认范围。');
  });
  it('keeps title, body, and spoken copy as separate source-derived fields', () => {
    expect(publicationTextFromPackage(xhs + '\n' + video, 'xhs-title')).toBe('图文标题');
    expect(publicationTextFromPackage(xhs + '\n' + video, 'xhs-body')).toBe('第一段。\n\n第二段。\n\n你怎么看？\n\n#原标签');
    expect(publicationTextFromPackage(xhs + '\n' + video, 'video-title')).toBe('标题原话');
    expect(publicationTextFromPackage(xhs + '\n' + video, 'video-spoken')).toBe(spokenScript(table).text);
  });
  it.each([
    table.replace('| 口播文案 |', '| 错误字段 |'),
    table.replace('第一段原话，数字 12:30 不改。', ''),
    table + '\n这句话也要念，不能悄悄丢弃。',
    table.replace('| 字幕二 | 正面 |', '| 正面 |'),
    table.replace('| 屏幕字幕 |', '| 口播文案 |'),
    table.replace('| 对应画面 |', '| 补充口播 |'),
    table + '\n|---|---|---|---|',
    '```\n'+table+'\n```',
  ])('refuses ambiguous or incomplete tables instead of omitting words', (text) => {
    expect(() => spokenScript(text)).toThrow();
  });
  it('rejects duplicated sections or video titles', () => {
    expect(() => publicationTextFromPackage(video + '\n' + video, 'video-spoken')).toThrow();
    expect(() => publicationTextFromPackage(video.replace('- 发布标题：标题原话', '- 发布标题：标题原话\n- 发布标题：第二个'), 'video-title')).toThrow();
  });
});
