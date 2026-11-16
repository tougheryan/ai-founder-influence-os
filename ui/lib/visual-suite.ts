export type VisualSuitePlatform = 'wechat' | 'social';

export type VisualSuiteAsset = {
  id: string;
  title?: string;
  platform?: string;
};

export type VisualAssetSuite<T extends VisualSuiteAsset = VisualSuiteAsset> = {
  id: string;
  platform: VisualSuitePlatform;
  label: string;
  title: string;
  assets: T[];
  previewAssets: T[];
};

const WECHAT_PAIR_RE = /^wechat-(cover|share)(?:-alt-(\d+))?$/i;
const SOCIAL_PAGE_RE = /^(?:xhs|moments)-(\d+)-p([1-8])$/i;

function optionLabel(index: number): string {
  return `文章配图 ${String.fromCharCode(65 + index)}`;
}

function pageNumber(asset: VisualSuiteAsset): number {
  return Number(asset.id.match(SOCIAL_PAGE_RE)?.[2] || 0);
}

function socialTitle(assets: VisualSuiteAsset[], postIndex: number): string {
  const cover = assets.find((asset) => pageNumber(asset) === 1 && asset.title?.trim());
  return cover?.title?.trim() || `图文卡片 ${postIndex}`;
}

/**
 * Build the only adoption units exposed to operators.
 *
 * - New WeChat runs expose one md2wechat HTML layout as the adoption unit.
 *   Legacy cover/share pairs remain readable for historical runs.
 * - Social suites use one canonical P1-P8 carousel for Xiaohongshu.
 *   Legacy moments-* files join the adoption payload so old manifests remain
 *   valid, but they never create a second visible suite.
 */
export function buildVisualAssetSuites<T extends VisualSuiteAsset>(
  platform: VisualSuitePlatform,
  assets: T[],
): VisualAssetSuite<T>[] {
  if (platform === 'social') {
    const postIndexes = [...new Set(assets.flatMap((asset) => {
      const match = asset.id.match(SOCIAL_PAGE_RE);
      return match ? [Number(match[1])] : [];
    }))].sort((left, right) => left - right);

    return postIndexes.map((postIndex) => {
      const suiteAssets = assets.filter((asset) => Number(asset.id.match(SOCIAL_PAGE_RE)?.[1]) === postIndex);
      const canonical = suiteAssets
        .filter((asset) => /^xhs-/i.test(asset.id))
        .sort((left, right) => pageNumber(left) - pageNumber(right));
      const legacyFallback = suiteAssets
        .filter((asset) => /^moments-/i.test(asset.id))
        .sort((left, right) => pageNumber(left) - pageNumber(right));
      return {
        id: `social-${String(postIndex).padStart(2, '0')}`,
        platform,
        label: `图文卡片 ${postIndex}`,
        title: socialTitle(canonical.length ? canonical : legacyFallback, postIndex),
        assets: suiteAssets,
        previewAssets: canonical.length ? canonical : legacyFallback,
      };
    });
  }

  const paired = assets.flatMap((asset) => {
    const match = asset.id.match(WECHAT_PAIR_RE);
    return match ? [{ asset, variant: match[2] || 'primary' }] : [];
  });
  const variants = [...new Set(paired.map((item) => item.variant))]
    .sort((left, right) => {
      if (left === 'primary') return -1;
      if (right === 'primary') return 1;
      return Number(left) - Number(right);
    });

  const shared = assets.filter((asset) => !WECHAT_PAIR_RE.test(asset.id));
  const resolvedVariants = variants.length ? variants : ['primary'];
  return resolvedVariants.map((variant, index) => {
    const pair = paired.filter((item) => item.variant === variant).map((item) => item.asset);
    const label = variants.length > 1 ? optionLabel(index) : '公众号排版';
    return {
      id: variant === 'primary' ? 'wechat-primary' : `wechat-alt-${variant}`,
      platform,
      label,
      title: pair.find((asset) => asset.title?.trim())?.title?.trim()
        || shared.find((asset) => asset.title?.trim())?.title?.trim()
        || label,
      assets: [...pair, ...shared],
      previewAssets: [...pair, ...shared],
    };
  });
}
