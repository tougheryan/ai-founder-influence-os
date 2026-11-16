import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WechatLayoutCopyButton } from './WechatLayoutCopyButton';
import type { VisualWorkbenchAsset } from '@/lib/visual-workbench';

const asset: VisualWorkbenchAsset = { revisionId: 'r003', id: 'wechat-html', platform: 'wechat',
  path: 'pipeline/visual/demo/publish/r003/wechat/article.html', role: 'article', status: 'generated', quality: 'pass', sha256: 'a'.repeat(64),
};

describe('WechatLayoutCopyButton', () => {
  it('offers copying for an intact generated HTML and does not claim success before the click', () => {
    const markup = renderToStaticMarkup(<WechatLayoutCopyButton asset={asset} />);
    expect(markup).toContain('复制排版');
    expect(markup).not.toContain('已复制');
  });
  it.each([{ quality: 'blocked' }, { status: 'planned' }, { sha256: undefined }, { sha256: 'invalid' },
    { id: 'xhs-01-p1' }, { path: 'pipeline/visual/demo/publish/r003/wechat/cover.png' }])('hides copying when the candidate cannot be verified (%#)', (change) => {
    expect(renderToStaticMarkup(<WechatLayoutCopyButton asset={{ ...asset, ...change }} />)).toBe('');
  });
});
