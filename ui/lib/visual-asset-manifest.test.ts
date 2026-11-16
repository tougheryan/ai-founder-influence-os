import { describe, expect, it } from 'vitest';
import {
  selectVisualAsset,
  validateVisualAssetManifest,
  type VisualAssetCandidate,
  type VisualAssetManifest,
} from './visual-asset-manifest';

const candidate = (
  assetId: string,
  semanticRole: string,
  revisionId = 'r001',
  platforms = ['wechat'],
): VisualAssetCandidate => ({
  assetId,
  semanticRole,
  revisionId,
  path: `pipeline/visual/demo/publish/${revisionId}/${assetId}.png`,
  sha256: assetId.padEnd(64, '0').slice(0, 64),
  platformBindings: platforms,
});

function manifest(): VisualAssetManifest {
  return {
    schema: 'aifios.visual-asset-manifest.v1',
    slug: 'demo',
    sourceContentHash: 'a'.repeat(64),
    requiredRoles: ['wechat_cover', 'inline-argument-1', 'xhs-01-p1'],
    selections: {},
  };
}

describe('visual asset manifest', () => {
  it('selects one cover candidate while retaining independently adopted illustrations', () => {
    const withCover = selectVisualAsset(manifest(), candidate('wechat-cover-editorial', 'wechat_cover'));
    const withIllustration = selectVisualAsset(withCover, candidate('inline-argument-1', 'inline-argument-1'));
    const replacedCover = selectVisualAsset(withIllustration, candidate('wechat-cover-concept', 'wechat_cover', 'r002'));

    expect(replacedCover.selections.wechat_cover.assetId).toBe('wechat-cover-concept');
    expect(replacedCover.selections['inline-argument-1'].assetId).toBe('inline-argument-1');
  });

  it('regenerates one card without replacing accepted assets from another revision', () => {
    const initial = selectVisualAsset(
      selectVisualAsset(manifest(), candidate('wechat-cover-editorial', 'wechat_cover')),
      candidate('inline-argument-1', 'inline-argument-1'),
    );
    const selected = selectVisualAsset(initial, candidate('xhs-01-p1-r002', 'xhs-01-p1', 'r002', ['xiaohongshu', 'moments']));

    expect(selected.selections['xhs-01-p1'].revisionId).toBe('r002');
    expect(selected.selections.wechat_cover.revisionId).toBe('r001');
    expect(selected.selections['inline-argument-1'].revisionId).toBe('r001');
  });

  it('requires one selected candidate for every required role before visual approval', () => {
    const incomplete = selectVisualAsset(manifest(), candidate('wechat-cover-editorial', 'wechat_cover'));
    const complete = selectVisualAsset(
      selectVisualAsset(incomplete, candidate('inline-argument-1', 'inline-argument-1')),
      candidate('xhs-01-p1', 'xhs-01-p1', 'r001', ['xiaohongshu']),
    );

    expect(validateVisualAssetManifest(incomplete).valid).toBe(false);
    expect(validateVisualAssetManifest(complete)).toEqual({ valid: true, missingRoles: [] });
  });
});
