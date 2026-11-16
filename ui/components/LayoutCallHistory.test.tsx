import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LayoutCallRecords } from './LayoutCallHistory';
import type { LayoutCallRecord } from '@/lib/layout-call-types';
const record: LayoutCallRecord = { id: `layout_${'a'.repeat(32)}`, operation: 'theme-preview', runSlug: null, revisionId: null, theme: 'minimal-blue', startedAt: '2026-10-09T02:00:00.000Z', completedAt: null, status: 'interrupted' };
describe('layout call history copy and scope', () => {
  it('does not equate empty history with no expense', () => {
    const html = renderToStaticMarkup(<LayoutCallRecords data={{ runId: 'run-a', records: [] }} />);
    expect(html).toContain('不代表历史上没有调用或费用');
    expect(html).toContain('费用未知');
    expect(html).toContain('不计入模型调用次数上限');
    expect(html).toContain('/settings#layout-service-calls');
    expect(html).not.toContain('0 元');
  });
  it('distinguishes unbound previews, interrupted calls and acquired but unadopted files', () => {
    const html = renderToStaticMarkup(<LayoutCallRecords data={{ runId: null, records: [record, { ...record, id: 'second', operation: 'article-restyle', runSlug: 'my-article', revisionId: 'r002', status: 'completed' }] }} />);
    expect(html).toContain('内置示例，未绑定草稿');
    expect(html).toContain('中断，结果未确认');
    expect(html).toContain('给成稿换版');
    expect(html).toContain('取得排版文件不代表最终成品通过检查或已被采用');
    expect(html).not.toContain('<button');
  });
});
