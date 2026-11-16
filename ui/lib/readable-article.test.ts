import { describe, expect, it } from 'vitest';
import { readableArticleFromPackage, readableArticleHtml, readableArticleText, readableArticleFileName } from './readable-article';

const source = `---
step: package
slug: internal-run
---
# 本期内容
## 0. 共享事实底稿
- 本期平台：公众号、小红书
- 内部备注：不要导出内部记录
## 1. 公众号原生长文
- 发布标题：先把范围说清楚
- 摘要：先问用途，再给选择。
- 标题备选：不要导出的备选标题
- 头图文案：不要导出的封面要求
### 正文
#### 先问用途
这一段保留。

> 不要急着答应。

最后一段也保留。
### 评论区承接
不要导出的评论区说明
## 2. 小红书原生图文
### 发布正文
- 发布标题：另一平台标题
这一段属于另一个平台。`;

describe('readable article extraction and rendering', () => {
  it('copies and exports heading-based title and summary without their field labels', () => {
    const markdown = source.replace('- 发布标题：先把范围说清楚', '### 发布标题：\n先把范围说清楚').replace('- 摘要：先问用途，再给选择。', '### 摘要：\n先问用途，再给选择。');
    expect(readableArticleFromPackage(markdown)).toEqual(readableArticleFromPackage(source));
    expect(readableArticleText(readableArticleFromPackage(markdown))).not.toContain('发布标题');
  });
  it('keeps title, summary and the complete body while excluding production fields and other platforms', () => {
    const article = readableArticleFromPackage(source);
    expect(article).toEqual({ title: '先把范围说清楚', summary: '先问用途，再给选择。', body: '#### 先问用途\n这一段保留。\n\n> 不要急着答应。\n\n最后一段也保留。' });
    const text = readableArticleText(article);
    expect(text).toContain('文章草稿');
    expect(text).toContain('最后一段也保留。');
    expect(text).not.toMatch(/internal-run|不要导出|另一平台|####|^>/m);
    const html = readableArticleHtml(article);
    expect(html).toContain('<h2>先问用途</h2><p>这一段保留。</p>');
    expect(html).toContain('<blockquote>不要急着答应。</blockquote>');
    expect(html).not.toMatch(/共享事实|内部备注|头图文案|评论区承接/);
  });

  it.each(['公众号母稿', '公众号长文'])('supports legacy %s packages with BOM and CRLF', (heading) => {
    const legacy = '\uFEFF' + source.replace('公众号原生长文', heading).replaceAll('\n', '\r\n');
    expect(readableArticleFromPackage(legacy).title).toBe('先把范围说清楚');
  });

  it('does not treat fenced headings in body examples as section boundaries', () => {
    const code = '```md\n## 1. 公众号原生长文\n### 正文\n代码里的例子\n```';
    expect(readableArticleFromPackage(source.replace('这一段保留。', code)).body).toContain(code);
    expect(readableArticleFromPackage(source.replace('这一段保留。', code)).body).toContain('最后一段也保留。');
  });

  it.each([
    source + '\n## 1. 公众号原生长文\n- 发布标题：重复\n### 正文\n重复正文',
    source.replace('### 评论区承接', '### 正文'),
    source.replace('- 摘要：', '- 发布标题：'),
    source.replace('- 发布标题：先把范围说清楚', '- 发布标题：'),
    source.replace('### 正文', '### 写作说明'),
    source.replace(/---\n# 本期内容/, '# 本期内容'),
  ])('refuses missing or ambiguous sections without falling back to the raw package', (content) => {
    expect(() => readableArticleFromPackage(content)).toThrow();
  });

  it('escapes all article markup, including hostile titles, with no scripts or remote images', () => {
    const article = { title: '<script>alert(1)</script>', summary: '<img src="https://tracker.invalid">', body: '#### <iframe src=x>\n<script>steal()</script>' };
    const html = readableArticleHtml(article);
    expect(html).toContain('&lt;script&gt;steal()&lt;/script&gt;');
    expect(html).not.toMatch(/<(script|img|iframe)\b/);
    expect(readableArticleFileName('价格/范围: "如何改"')).toBe('价格 范围   如何改-草稿.html');
  });
});
