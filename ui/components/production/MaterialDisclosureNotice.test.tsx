import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MaterialDisclosureNotice } from './MaterialDisclosureNotice';

describe('disclosure in subsequent writing and delivery steps', () => {
  it('keeps explicit restrictions visible, quotes the source and separates local use from external drafts', () => {
    const html = renderToStaticMarkup(<MaterialDisclosureNotice risks={['公开边界：【模拟验收材料，不对外发布】']} onReview={() => {}} />);
    expect(html).toContain('本期仅供内部预览');
    expect(html).toContain('可以继续写作、排版和下载');
    expect(html).toContain('填入外部平台草稿也属于对外传送');
    expect(html).toContain('公开边界：【模拟验收材料，不对外发布】');
    expect(html).toContain('核对公开限制');
  });
  it('asks for review after a source edit instead of treating old restrictions as current', () => {
    const html = renderToStaticMarkup(<MaterialDisclosureNotice risks={['不对外发布']} stale onReview={() => {}} />);
    expect(html).toContain('素材已变化，请重新核对公开限制');
    expect(html).not.toContain('本期仅供内部预览');
  });
  it('does not promise permission or blanket-ban articles with detail-specific restrictions', () => {
    expect(renderToStaticMarkup(<MaterialDisclosureNotice risks={['不要公开客户的姓名']} onReview={() => {}} />)).toBe('');
    expect(renderToStaticMarkup(<MaterialDisclosureNotice onReview={() => {}} />)).toBe('');
  });
});
