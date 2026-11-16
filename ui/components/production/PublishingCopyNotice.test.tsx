import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { inspectPublishingSections } from '@/lib/content-editing';
import { PublishingCopyNotice } from './PublishingCopyNotice';

const issues = inspectPublishingSections('## 1. 公众号原生长文\n### 正文\n素材提供者提出，先记录。\n\n素材提供者提出，先记录。');

describe('reader-visible copy review', () => {
  it('keeps human judgment and displays each occurrence without implying a blocked or approved article', () => {
    const html = renderToStaticMarkup(<PublishingCopyNotice issues={issues} path="pipeline/package/a.md" sha256={'a'.repeat(64)} onEdit={() => {}} />);
    expect(html).toContain('核对这 2 处文字');
    expect(html).toContain('不会自动删除');
    expect(html).toContain('可以保留');
    expect(html).toContain('修改第 1 处文字');
    expect(html).toContain('修改第 2 处文字');
    expect(html).not.toContain('已通过');
  });
  it('does not offer mutation when reading an old draft or when its snapshot is unavailable', () => {
    const readOnly = renderToStaticMarkup(<PublishingCopyNotice issues={issues} path="pipeline/package/old.md" sha256="" />);
    const unhashed = renderToStaticMarkup(<PublishingCopyNotice issues={issues} path="pipeline/package/old.md" sha256="" onEdit={() => {}} />);
    expect(readOnly).toContain(issues[0].quote);
    expect(readOnly + unhashed).not.toContain('<button');
    expect(renderToStaticMarkup(<PublishingCopyNotice issues={[]} path="" sha256="" />)).toBe('');
  });
});
