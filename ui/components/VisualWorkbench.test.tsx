import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { displayVisualReason, VisualWorkbench } from './VisualWorkbench';
import type { VisualWorkbenchState } from '@/lib/visual-workbench';

function asset(id: string, platform: 'wechat' | 'xhs') {
  return {
    revisionId: 'r001',
    id,
    platform,
    path: `pipeline/visual/demo/publish/r001/${id}.${id === 'wechat-html' ? 'html' : 'png'}`,
    role: id,
    status: 'generated',
    quality: 'pass',
  } as const;
}

const STATE: VisualWorkbenchState = {
  slug: 'demo',
  selectedRevisionId: 'r001',
  hasExplicitSelection: false,
  revisions: [{ revisionId: 'r001', recipePath: 'recipe.json', status: 'ready' }],
  assets: [],
  assetCandidates: [
    asset('wechat-html', 'wechat'),
    ...Array.from({ length: 8 }, (_, index) => asset(`xhs-01-p${index + 1}`, 'xhs')),
  ],
  reviewAssets: [],
  comparison: [],
};

describe('VisualWorkbench platform adoption UI', () => {
  it('allows a previously selected suite to be checked again only when the current phase needs review', () => {
    const assets = STATE.assetCandidates!.filter((item) => item.platform === 'xhs');
    const state = { ...STATE, assets, assetCandidates: assets, hasExplicitAssetSelection: true,
      hasCompleteAssetSelection: true, selectedAssetKeys: assets.map((item) => `${item.revisionId}:${item.id}`) };
    const render = (needsReview: boolean) => renderToStaticMarkup(<VisualWorkbench state={state}
      selectionNeedsReview={needsReview} onRequestRevision={async () => undefined} onAdoptAllAssets={async () => undefined} />);
    expect(render(true)).toMatch(/<button(?![^>]*disabled)[^>]*>[\s\S]*?核对并沿用这套图文<\/button>/);
    expect(render(false)).not.toContain('核对并沿用这套图文');
    const blocked = { ...state, assetCandidates: assets.map((item) => ({ ...item, quality: 'blocked' as const })) };
    expect(renderToStaticMarkup(<VisualWorkbench state={blocked} selectionNeedsReview onRequestRevision={async () => undefined}
      onAdoptAllAssets={async () => undefined} />)).not.toContain('核对并沿用这套图文');
  });
  it('offers one bundle only for the complete adopted native set, and binds the displayed selection', () => {
    const pages = STATE.assetCandidates!.filter((item) => item.platform === 'xhs').map((item) => ({ ...item, nativeCopyVerified: true }));
    const state: VisualWorkbenchState = { ...STATE, assets: pages, hasExplicitAssetSelection: true,
      adoptedAssetManifest: { selectionSha256: 'a'.repeat(64), sourceContentHash: 'b'.repeat(64), requiredRoles: pages.map((item) => item.id), assets: [] } };
    const render = (value: VisualWorkbenchState) => renderToStaticMarkup(<VisualWorkbench state={value} onRequestRevision={async () => undefined} />);
    expect(render(state)).toContain('下载整套图文');
    expect(render(state)).toContain(`selection=${'a'.repeat(64)}`);
    expect(render({ ...state, assets: pages.slice(0, 7) })).not.toContain('下载整套图文');
    expect(render({ ...state, assets: pages.map((item, index) => index === 0 ? { ...item, quality: 'blocked' } : item) })).not.toContain('下载整套图文');
    expect(render({ ...state, assets: pages.map((item, index) => index === 0 ? { ...item, revisionId: 'r002' } : item) })).not.toContain('下载整套图文');
    expect(render({ ...state, assets: pages.map((item) => ({ ...item, nativeCopyVerified: false })) })).not.toContain('下载整套图文');
    expect(render(STATE)).not.toContain('下载整套图文');
  });
  it('presents complete suites without global or single-image adoption controls', () => {
    const html = renderToStaticMarkup(
      <VisualWorkbench
        state={STATE}
        onRequestRevision={async () => undefined}
        onAdoptAllAssets={async () => undefined}
      />,
    );

    expect(html).toContain('平台完整发布件');
    expect(html).toContain('公众号排版');
    expect(html).toContain('小红书图文卡片');
    expect(html).toContain('查看 P1-P8 八张图文卡片');
    expect(html).toContain('公众号全文排版已生成');
    expect(html).toContain('选择这套');
    expect(html).toContain('查看排版');
    expect(html).toContain('查看图片');
    expect(html).toContain('修改这套');
    expect(html).not.toContain('成套采用');
    expect(html).not.toContain('单独采用');
    expect(html).not.toContain('短视频套图');
    expect(html).not.toContain('视觉套装');
    expect(html).not.toContain('采用整套');
    expect(html).toContain('公众号排版已经生成');
    expect(html).toContain('查看封面');
    expect(html).toContain('查看正文配图');
    expect(html).toContain('查看结尾图');
    expect(html).not.toContain('说明图');
    expect(html).not.toContain('结尾引导图');
    expect(html).not.toContain('分享图');
    expect(html).not.toContain('技术详情');
    expect(html).not.toContain('服务：');
    expect(html).not.toContain('自动配图');
    expect(html).not.toContain('AI 视觉');
  });

  it('shows page-specific recovery controls and previews without download or adoption for a blocked candidate', () => {
    const state: VisualWorkbenchState = {
      ...STATE,
      revisions: [{ ...STATE.revisions[0], status: 'blocked', issues: ['xhs-01-p2 density 11% is below 68%', 'xhs-01-p4 density 16% is below 68%'] }],
      assetCandidates: STATE.assetCandidates?.filter((item) => item.platform === 'xhs').map((item) => ({ ...item, quality: 'blocked' })),
    };
    const html = renderToStaticMarkup(<VisualWorkbench state={state} onRequestRevision={async () => undefined} onRegenerate={() => {}} onReviewCopy={() => {}} onAdoptAllAssets={async () => undefined} />);
    expect(html).toContain('小红书 P2、P4 留白较多');
    expect(html).toContain('需要调整');
    expect(html).toContain('返回正文调整');
    expect(html).toContain('重新生成排版');
    expect(html).toContain('查看图片');
    expect(html).not.toContain('下载图片与说明');
    expect(html).not.toContain('选择这套成品');
    expect(html).not.toContain('density');
  });

  it('does not promise image previews when artifact verification failed', () => {
    const state: VisualWorkbenchState = {
      ...STATE, assets: [], assetCandidates: [],
      revisions: [{ ...STATE.revisions[0], status: 'blocked', reason: '成品文件不存在' }],
    };
    const html = renderToStaticMarkup(<VisualWorkbench state={state} onRequestRevision={async () => undefined} onRegenerate={() => {}} />);
    expect(html).toContain('这版排版暂时无法预览');
    expect(html).toContain('有成品文件缺失或已经变动');
    expect(html).toContain('重新生成排版');
    expect(html).not.toContain('下面的图片可用于检查');
  });

  it('renders bounded cover, evidence and CTA comparisons with per-asset controls', () => {
    const current = [
      { ...asset('xhs-01-p1', 'xhs'), role: 'cover' },
      { ...asset('xhs-01-p2', 'xhs'), role: 'evidence' },
      { ...asset('xhs-01-p5', 'xhs'), role: 'cta' },
    ];
    const candidate = current.map((item) => ({
      ...item,
      revisionId: 'r002',
      path: item.path.replace('/r001/', '/r002/'),
    }));
    const state: VisualWorkbenchState = {
      ...STATE,
      hasExplicitSelection: true,
      revisions: [
        ...STATE.revisions,
        { revisionId: 'r002', parentRevisionId: 'r001', recipePath: 'recipe-2.json', status: 'ready' },
      ],
      comparison: (['cover', 'evidence', 'cta'] as const).map((role, index) => ({
        role,
        leftLabel: 'current',
        leftRevisionId: 'r001',
        left: current[index],
        rightLabel: 'candidate',
        rightRevisionId: 'r002',
        right: candidate[index],
      })),
    };

    const html = renderToStaticMarkup(
      <VisualWorkbench
        state={state}
        onRequestRevision={async () => undefined}
        onAdoptAsset={async () => undefined}
        onAdoptAllAssets={async () => undefined}
      />,
    );

    expect(html).toContain('data-testid="visual-version-comparison"');
    expect(html).toContain('data-testid="visual-comparison-cover"');
    expect(html).toContain('data-testid="visual-comparison-evidence"');
    expect(html).toContain('data-testid="visual-comparison-cta"');
    expect(html).toContain('选择这张');
    expect(html).toContain('修改这张');
    expect(html).toContain('可以使用');
    expect(html).not.toContain('技术详情');
    expect(html).not.toContain('质量 pass');
    expect(html).not.toContain('r001 · xhs-01-p1');
  });

  it('maps raw technical reasons to a short explanation without leaking diagnostics', () => {
    const rawReason = 'renderer cloud_renderer_x9 failed for run_private_42 because schema_private_v9 is invalid at /Users/alice/Secret';
    const state: VisualWorkbenchState = {
      ...STATE,
      revisions: [{ ...STATE.revisions[0], status: 'blocked', reason: rawReason }],
      assetCandidates: STATE.assetCandidates?.map((item) => (
        item.id === 'xhs-01-p1' ? { ...item, title: 'pipeline artifact_queue private title' } : item
      )),
    };

    const html = renderToStaticMarkup(
      <VisualWorkbench
        state={state}
        onRequestRevision={async () => undefined}
        onAdoptAllAssets={async () => undefined}
      />,
    );

    expect(html).toContain('这组平台成品的数据不完整，暂时不能使用。请重新生成。');
    expect(html).not.toContain('cloud_renderer_x9');
    expect(html).not.toContain('run_private_42');
    expect(html).not.toContain('schema_private_v9');
    expect(html).not.toContain('/Users/alice/Secret');
    expect(html).not.toContain('artifact_queue private title');
  });

  it('turns unknown English errors and raw objects into safe Chinese next steps', () => {
    const messages = [
      displayVisualReason(new Error('Unexpected renderer crash in runtime')),
      displayVisualReason({ message: 'pipeline failed', stack: 'private stack' }),
      displayVisualReason('{"schema":"private","sha256":"secret"}'),
    ];
    const forbidden = /schema|slug|\bid\b|revision|renderer|json|legacy|\brun\b|runtime|pipeline|hash|sha|cta|b-?roll|证据图|视觉资产/i;

    for (const message of messages) {
      expect(message).toMatch(/请/);
      expect(message).not.toMatch(forbidden);
    }
    expect(displayVisualReason('截图来源等待人工确认')).toBe('这项成品需要你检查。确认内容无误后再选择。');
  });

  it('distinguishes a basic fallback from the requested theme and keeps version numbers stable', () => {
    const state: VisualWorkbenchState = {
      ...STATE,
      revisions: [{ revisionId: 'r003', recipePath: 'r3.json', status: 'ready' }, ...STATE.revisions],
      assetCandidates: [{ ...asset('wechat-html', 'wechat'), wechatLayout: {
        requestedTheme: 'apple', renderedTheme: 'echo-basic', usedFallback: true, candidates: ['apple', 'bytedance'],
      } }],
    };
    const html = renderToStaticMarkup(<VisualWorkbench state={state} onRequestRevision={async () => undefined} />);
    expect(html).toContain('当前是基础排版，原选样式 apple 未应用。');
    expect(html).toContain('换排版样式');
    expect(html).toContain('使用这版排版');
    expect(html).toContain('版本 3');
    expect(html).toContain('版本 1');
    expect(html).not.toContain('版本 2');
    expect(html).not.toContain('实际样式：apple');
  });

  it('does not infer the actual layout of an old artifact from its requested style', () => {
    const state: VisualWorkbenchState = { ...STATE, assetCandidates: [{ ...asset('wechat-html', 'wechat'), wechatLayout: {
      requestedTheme: 'apple', usedFallback: false, candidates: ['apple'],
    } }] };
    const html = renderToStaticMarkup(<VisualWorkbench state={state} onRequestRevision={async () => undefined} />);
    expect(html).toContain('实际样式未记录');
    expect(html).not.toContain('实际样式：apple');
  });

  it('describes the refined md2wechat layout without presenting it as untouched API output', () => {
    const state: VisualWorkbenchState = { ...STATE, assetCandidates: [{ ...asset('wechat-html', 'wechat'), wechatLayout: {
      requestedTheme: 'elegant-blue', renderedTheme: 'elegant-blue', usedFallback: false, candidates: ['elegant-blue'],
      locallyRefined: true, refinementProfile: 'title-spacing-v1',
    } }] };
    const html = renderToStaticMarkup(<VisualWorkbench state={state} onRequestRevision={async () => undefined} />);
    expect(html).toContain('md2wechat · elegant-blue · 已调整标题与间距');
    expect(html).not.toContain('原始 API');
  });

  it('reopens the adopted article layout even when the legacy revision pointer still refers to its parent', () => {
    const parent = { ...asset('wechat-html', 'wechat'), wechatLayout: { requestedTheme: 'apple', renderedTheme: 'apple', usedFallback: false, candidates: ['apple', 'bytedance'] } };
    const adopted = { ...parent, revisionId: 'r002', path: parent.path.replace('/r001/', '/r002/'), wechatLayout: { ...parent.wechatLayout, requestedTheme: 'bytedance', renderedTheme: 'bytedance' } };
    const state: VisualWorkbenchState = { ...STATE, hasExplicitAssetSelection: true, hasCompleteAssetSelection: true,
      selectedAssetKeys: ['r002:wechat-html'], assets: [adopted], assetCandidates: [parent, adopted],
      revisions: [...STATE.revisions, { revisionId: 'r002', recipePath: 'r2.json', status: 'ready' }],
    };
    const html = renderToStaticMarkup(<VisualWorkbench state={state} onRequestRevision={async () => undefined} />);
    expect(html).toContain('实际样式：bytedance');
    expect(html).not.toContain('实际样式：apple');
    expect(html).not.toContain('修改排版与图文');
    expect(html).toContain('aria-label="查看版本 2" aria-pressed="true"');
  });
});
