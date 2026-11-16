import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SelectableArticleBody } from './SelectableArticleBody';

describe('article selection reader', () => {
  const props = { path: 'pipeline/package/test.md', sha256: 'a'.repeat(64), section: { id: 'wechat:正文', label: '正文', text: '#### 小标题\n第一段。\n\n> 引用段。', start: 0, end: 100 }, onEdit: vi.fn() };
  it('keeps a readable article and exposes named paragraph actions for keyboard access', () => {
    const html = renderToStaticMarkup(<SelectableArticleBody {...props} />);
    expect(html).toContain('可选段修改的正文');
    expect(html).toContain('修改第 1 段'); expect(html).toContain('修改第 3 段');
    expect(html).toContain('小标题'); expect(html).not.toContain('####');
    expect(html).toContain('<blockquote');
    expect(props.onEdit).not.toHaveBeenCalled();
  });
  it('disables every paragraph action during an active mutation', () => {
    const html = renderToStaticMarkup(<SelectableArticleBody {...props} disabled />);
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });
  it('renders untrusted markup as text', () => {
    const html = renderToStaticMarkup(<SelectableArticleBody {...props} section={{ ...props.section, text: '<img src=x onerror=alert(1)>' }} />);
    expect(html).toContain('&lt;img'); expect(html).not.toContain('<img');
  });
  it('labels a card field and displays only its bound value with a keyboard action', () => {
    const html = renderToStaticMarkup(<SelectableArticleBody {...props} section={{ ...props.section, id: 'xhs:图文卡片脚本', text: '| P2 | 相同句。 | 画面不变 |' }} range={{start:7,end:11}} label="P2 正文" compact />);
    expect(html).toContain('可选段修改的P2 正文');
    expect(html).toContain('修改P2 正文');
    expect(html).not.toContain('画面不变');
  });
});
