import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it } from 'vitest';
import type { OutputDisclosure } from './output-disclosure';
import { disclosureNotice, markExportText } from './output-disclosure-format';

const internal: OutputDisclosure = { status: 'internal_only', restrictions: ['本期仅供内部交流，不对外发布。'] };
const limited: OutputDisclosure = { status: 'restricted_details', restrictions: ['不要公开客户姓名。'] };
const unknown: OutputDisclosure = { status: 'unverified', restrictions: [] };
const noWholeLimit: OutputDisclosure = { status: 'no_whole_draft_limit', restrictions: [] };

describe('export disclosure formatting', () => {
  it('runs after compilation without Node globals or a runtime import of the server disclosure reader', () => {
    const source = readFileSync(new URL('./output-disclosure-format.ts', import.meta.url), 'utf8');
    const { outputText } = transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2020 } });
    const exported: Partial<typeof import('./output-disclosure-format')> = {};
    runInNewContext(outputText, { exports: exported }, { timeout: 1000 });
    expect(exported.disclosureNotice?.(internal)).toContain('仅供内部预览');
    expect(exported.markExportText?.('<p>模拟正文。</p>', '.html', { ...internal, restrictions: ['<script>模拟</script>'] })).toContain('&lt;script&gt;');
  });

  it('keeps whole-draft and partial restrictions distinct, without inferring public permission', () => {
    expect(disclosureNotice(internal)).toContain('仅供内部预览');
    expect(disclosureNotice(internal)).toContain(internal.restrictions[0]);
    expect(disclosureNotice(limited)).toContain('含局部公开限制');
    expect(disclosureNotice(limited)).not.toContain('本期材料设有整期公开限制');
    expect(disclosureNotice(unknown)).toContain('公开限制待核对 · 仅供内部预览');
    expect(disclosureNotice(noWholeLimit)).toBe('');
  });

  it.each(['md', '.markdown', 'TXT'])('retains the complete %s source after an independent notice', (extension) => {
    const source = '# 模拟稿\r\n\r\n第一段。\n\n---\n\n最后一段。\n';
    const originalDisclosure = structuredClone(internal);
    const result = markExportText(source, extension, internal);
    expect(result).toContain('导出使用说明');
    expect(result.endsWith(source)).toBe(true);
    expect(internal).toEqual(originalDisclosure);
    expect(source).toBe('# 模拟稿\r\n\r\n第一段。\n\n---\n\n最后一段。\n');
  });

  it.each(['md', '.txt', 'html', 'htm', 'json'])('does not label %s as approved when no whole-draft limit was found', (extension) => {
    const source = '<p>原始内容，不代表公开授权。</p>';
    expect(markExportText(source, extension, noWholeLimit)).toBe(source);
  });

  it('escapes HTML and Markdown syntax in restriction text, including additional lines', () => {
    const malicious: OutputDisclosure = {
      status: 'restricted_details',
      restrictions: ['</aside><script>alert("模拟")</script>\n![链接](javascript:alert(1)) & <img src=x onerror=alert(1)>'],
    };
    const source = '<p>保留正文。</p>';
    const html = markExportText(source, '.html', malicious);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;/aside&gt;&lt;script&gt;alert(&quot;模拟&quot;)&lt;/script&gt;');
    expect(html).toContain('&amp; &lt;img');
    expect(html.endsWith(source)).toBe(true);
    const markdown = markExportText('# 正文', '.md', malicious);
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('![链接](');
    expect(markdown).toContain('\n> \\!\\[链接\\]');
  });

  it('inserts a visible notice inside a complete HTML body without changing existing markup', () => {
    const before = '<!DOCTYPE html>\n<html><head><title>模拟导出</title></head><BODY class="page" data-comparison="a > b">';
    const after = '<main><h1>完整标题</h1><p>完整正文。</p></main></BODY></html>';
    const result = markExportText(before + after, '.HTM', internal);
    expect(result.startsWith(before + '\n<aside ')).toBe(true);
    expect(result.endsWith(after)).toBe(true);
    expect(result).toContain('role="note"');
  });

  it('ignores body-looking text in comments, scripts, styles and inert templates', () => {
    const before = '<!doctype html><html><!-- <body> --><head><script>const x="<body>";</script><style>/* <body> */</style></head><template><body>旧模板</body></template><body id="actual">';
    const after = '<p>实际正文。</p></body></html>';
    const result = markExportText(before + after, 'html', unknown);
    expect(result.startsWith(before + '\n<aside ')).toBe(true);
    expect(result.endsWith(after)).toBe(true);
  });

  it('adds a notice before an HTML fragment, and after a full document head with an implicit body', () => {
    const fragment = '<section><p>片段全文。</p></section>';
    expect(markExportText(fragment, 'html', limited)).toMatch(/^\n<aside /);
    expect(markExportText(fragment, 'html', limited).endsWith(fragment)).toBe(true);
    const implicit = '<!doctype html><html><head><title>标题</title></head><p>无 body 标签的正文。</p></html>';
    expect(markExportText(implicit, 'html', limited)).toContain('</head>\n<aside ');
    expect(markExportText(implicit, 'html', limited)).toMatch(/<p>无 body 标签的正文。<\/p><\/html>$/);
  });

  it('does not pretend an unsupported binary format can have text inserted', () => {
    expect(markExportText('模拟字节', '.png', internal)).toBe('模拟字节');
  });
});
