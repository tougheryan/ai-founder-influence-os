import { describe, expect, it } from 'vitest';
import { applyContentEdit, contentEditSpan, contentSections, contentParagraphs, contentEndingSpan, inspectPublishingSections, publishingIssueTarget } from './content-editing';

const source = '# 内容\n\n## 0. 共享事实底稿\n- 约束：素材提供者要求不要引导购买。\n\n## 1. 公众号原生长文\n- 发布标题：客户的问题\n- 摘要：一份方法\n\n### 正文\n开头原样保留。\n\n具体方法，保留标点。\n\n这是旧结尾。\n\n### 评论区承接\n留下你的问题。\n\n## 3. 视频号原生口播\n- 发布标题：另一个标题\n### 逐句口播稿\n这是独立口播。\n';

describe('scoped content editing', () => {
  it('changes only the final paragraph and preserves every other byte and platform', () => {
    const result = applyContentEdit(source, { sectionId: 'wechat:正文', scope: 'ending' }, '先记下今天被问到的那个问题。');
    expect(result).toBe(source.replace('这是旧结尾。', '先记下今天被问到的那个问题。'));
  });
  it('replaces a chosen multi-paragraph ending without touching the earlier body, comments, other platforms or plan binding', () => {
    const bound = '<!-- echo-content-plan:{"path":"pipeline/blueprint/old.md","sha256":"old"} -->\n\n' + source;
    const target = { sectionId: 'wechat:正文', scope: 'ending' as const, endingParagraphs: 2 };
    const selected = contentEditSpan(bound, target);
    expect(selected.text).toBe('具体方法，保留标点。\n\n这是旧结尾。');
    expect(applyContentEdit(bound, target, '只留这一句。')).toBe(bound.replace(selected.text, '只留这一句。'));
    expect(applyContentEdit(bound, target, '')).toBe(bound.replace(selected.text, ''));
  });
  it('uses the same visible range as the saved range with CRLF and multiple blank lines', () => {
    const windows = source.replace('具体方法，保留标点。\n\n这是旧结尾。', '收尾建议。\n\n\n\n最后一句。').replaceAll('\n', '\r\n');
    const section = contentSections(windows).find((item) => item.id === 'wechat:正文')!;
    expect(contentParagraphs(section.text).map((item) => item.text)).toEqual(['开头原样保留。', '收尾建议。', '最后一句。']);
    const visible = contentEndingSpan(section, 2);
    const saved = contentEditSpan(windows, { sectionId: section.id, scope: 'ending', endingParagraphs: 2 });
    expect(saved).toEqual(visible);
    expect(windows.slice(saved.start, saved.end)).toBe('收尾建议。\r\n\r\n\r\n\r\n最后一句。');
  });
  it.each([0, -1, 1.5, 4, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid ending count %s instead of broadening the edit', (endingParagraphs) => {
    expect(() => applyContentEdit(source, { sectionId: 'wechat:正文', scope: 'ending', endingParagraphs }, '新结尾')).toThrow('起始段落');
  });
  it('does not silently accept ending counts for another edit scope', () => {
    expect(() => applyContentEdit(source, { sectionId: 'wechat:正文', scope: 'section', endingParagraphs: 2 }, '新正文')).toThrow('只用于修改结尾');
  });
  it('targets an exact unique selection and rejects missing or ambiguous text', () => {
    expect(applyContentEdit(source, { sectionId: 'wechat:正文', scope: 'selection', selection: '具体方法，保留标点。' }, '改好的方法。')).toBe(source.replace('具体方法，保留标点。', '改好的方法。'));
    expect(() => contentEditSpan(source, { sectionId: 'wechat:正文', scope: 'selection', selection: '不存在' })).toThrow();
    expect(() => contentEditSpan(source.replace('这是旧结尾。', '开头原样保留。'), { sectionId: 'wechat:正文', scope: 'selection', selection: '开头原样保留。' })).toThrow();
  });
  it('keeps shared facts and bindings out of editable sections', () => {
    expect(contentSections(source).map((x) => x.id)).toEqual(['wechat:field:发布标题', 'wechat:field:摘要', 'wechat:正文', 'wechat:评论区承接', 'shipinhao:field:发布标题', 'shipinhao:逐句口播稿']);
    expect(() => applyContentEdit(source, { sectionId: '0. 共享事实底稿', scope: 'section' }, '更改事实')).toThrow();
  });
  it('preserves CRLF and rejects duplicate section labels instead of editing the wrong text', () => {
    const windows = source.replaceAll('\n', '\r\n');
    expect(applyContentEdit(windows, { sectionId: 'wechat:正文', scope: 'ending' }, '新结尾。')).toBe(windows.replace('这是旧结尾。', '新结尾。'));
    expect(() => applyContentEdit(source.replace('### 评论区承接', '### 正文'), { sectionId: 'wechat:正文', scope: 'ending' }, '新结尾。')).toThrow('标题重复');
  });
  it('flags the observed internal narration only inside publishable copy', () => {
    expect(inspectPublishingSections(source)).toEqual([]);
    const issues = inspectPublishingSections(source.replace('这是旧结尾。', '本文能确认的事实只有一条：素材提供者提出，问题可以成为选题。\n\n这里不引导私信、购买或预约。'));
    expect(issues).toHaveLength(2);
    expect(issues.every((item) => item.sectionId === 'wechat:正文')).toBe(true);
    expect(issues[0].quote).toContain('本文能确认的事实只有一条');
  });
});

describe('publishing copy findings and exact occurrence edits', () => {
  const sentence = '根据用户提供的素材，这篇文章先谈记录。';
  const repeated = source.replace('具体方法，保留标点。', `🙂开场。${sentence}\r\n\r\n保留中间。${sentence}`);
  it('finds both identical occurrences and changes only the selected occurrence', () => {
    const issues = inspectPublishingSections(repeated);
    expect(issues).toHaveLength(2);
    expect(issues[0].quote).toBe(sentence);
    expect(issues[1].quote).toBe(sentence);
    const section = contentSections(repeated).find((item) => item.id === issues[1].sectionId)!;
    const request = { path: 'pipeline/package/current.md', sha256: 'a'.repeat(64), issue: issues[1] };
    const target = publishingIssueTarget({ ...request, sections: contentSections(repeated) }, request);
    const at = section.start + issues[1].selectionOffset;
    expect(applyContentEdit(repeated, target, '先记录今天被问到的问题。')).toBe(repeated.slice(0, at) + '先记录今天被问到的问题。' + repeated.slice(at + sentence.length));
    expect(() => applyContentEdit(repeated, { sectionId: section.id, scope: 'selection', selection: sentence }, '')).toThrow('唯一定位');
  });
  it.each([-1, 0.5, Number.NaN, 999999])('rejects invalid or mismatching positions: %s', (selectionOffset) => {
    expect(() => contentEditSpan(repeated, { sectionId: 'wechat:正文', scope: 'selection', selection: sentence, selectionOffset })).toThrow('原文位置');
  });
  it('does not accept a position for another scope or mismatching quote', () => {
    expect(() => contentEditSpan(source, { sectionId: 'wechat:正文', scope: 'section', selectionOffset: 0 })).toThrow('只用于');
    expect(() => contentEditSpan(source, { sectionId: 'wechat:正文', scope: 'selection', selection: '别的原文', selectionOffset: 0 })).toThrow('原文位置');
  });
  it('refuses old findings after a path, hash, field or quote change', () => {
    const issue = inspectPublishingSections(repeated)[0];
    const snapshot = { path: 'pipeline/package/current.md', sha256: 'a'.repeat(64), sections: contentSections(repeated) };
    for (const request of [
      { ...snapshot, path: 'pipeline/package/other.md', issue },
      { ...snapshot, sha256: 'b'.repeat(64), issue },
      { ...snapshot, issue: { ...issue, quote: '别的文字' } },
      { ...snapshot, issue: { ...issue, sectionId: 'xhs:发布正文' } },
    ]) expect(() => publishingIssueTarget(snapshot, request)).toThrow('文章版本已变化');
    expect(() => publishingIssueTarget({ ...snapshot, sections: [...snapshot.sections, snapshot.sections.find((section) => section.id === issue.sectionId)!] }, { ...snapshot, issue })).toThrow('文章版本已变化');
  });
  it('ignores shared facts, comments, fenced code, camera notes and layout columns', () => {
    const material = source + `\n### 镜头清单\n${sentence}\n\n### B-roll 建议\n${sentence}\n`;
    const hidden = material.replace('这是旧结尾。', `<!-- ${sentence} -->\n\n\x60\x60\x60text\n${sentence}\n\x60\x60\x60\n\n正常的结尾。`);
    expect(inspectPublishingSections(hidden)).toEqual([]);
    const cards = `## 2. 小红书原生图文\n### 图文卡片脚本\n| 页码 | 标题 | 正文 | 图片提示 | 排版 |\n| P1 | ${sentence} | 先记录。 | ${sentence} | ${sentence} |\n| P2 | 标题 | ${sentence} | ${sentence} | 居中 |\n`;
    const issues = inspectPublishingSections(cards);
    expect(issues).toHaveLength(2);
    expect(issues.every((issue) => issue.quote === sentence)).toBe(true);
  });
});
