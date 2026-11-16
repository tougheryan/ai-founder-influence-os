export const VISUAL_REVISION_CLIENT_KEYS = new Set(['slug', 'request', 'targetAssetIds', 'baseRevisionId', 'wechatLayout']);

export type WechatLayoutRefinement = {
  profile: 'title-spacing-v1';
  title_lines: string[];
  heading_blocks: Array<{ block_index: number; text_sha256: string; segments: string[] }>;
};

export type WechatLayoutRequest = {
  theme: string;
  source_package_sha256: string;
  refinement?: WechatLayoutRefinement;
};

function exactObject(value: unknown, allowed: readonly string[], required: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}格式不正确`);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(record, key))) {
    throw new Error(`${label}含不支持或缺失的字段`);
  }
  return record;
}

function textParts(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3 || value.some((part) => (
    typeof part !== 'string' || !part.trim() || part.length > 500 || /[<>\u0000-\u001f\u007f]/.test(part)
  ))) throw new Error(`${label}须为一至三段原文，不能包含 HTML 或控制字符`);
  return [...value] as string[];
}

export function parseWechatLayout(value: unknown): WechatLayoutRequest | undefined {
  if (value === undefined) return undefined;
  const layout = exactObject(value, ['theme', 'source_package_sha256', 'refinement'], ['theme', 'source_package_sha256'], '公众号排版参数');
  if (typeof layout.theme !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(layout.theme)) throw new Error('公众号主题标识格式不正确');
  if (typeof layout.source_package_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(layout.source_package_sha256)) throw new Error('公众号排版缺少有效的原稿绑定');
  const result: WechatLayoutRequest = { theme: layout.theme, source_package_sha256: layout.source_package_sha256 };
  if (Object.hasOwn(layout, 'refinement')) {
    const refinement = exactObject(layout.refinement, ['profile', 'title_lines', 'heading_blocks'], ['profile', 'title_lines', 'heading_blocks'], '排版微调参数');
    if (refinement.profile !== 'title-spacing-v1') throw new Error('不支持这组排版微调参数');
    if (!Array.isArray(refinement.heading_blocks) || refinement.heading_blocks.length > 30) throw new Error('小标题定位最多为三十处');
    const positions = new Set<number>();
    const headingBlocks = refinement.heading_blocks.map((value) => {
      const block = exactObject(value, ['block_index', 'text_sha256', 'segments'], ['block_index', 'text_sha256', 'segments'], '小标题定位');
      if (!Number.isSafeInteger(block.block_index) || Number(block.block_index) < 0 || Number(block.block_index) > 9999 || positions.has(Number(block.block_index))) throw new Error('小标题定位不正确或重复');
      if (typeof block.text_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(block.text_sha256)) throw new Error('小标题缺少有效的原文绑定');
      positions.add(Number(block.block_index));
      return { block_index: Number(block.block_index), text_sha256: block.text_sha256, segments: textParts(block.segments, '小标题分组') };
    });
    result.refinement = { profile: 'title-spacing-v1', title_lines: textParts(refinement.title_lines, '标题断行'), heading_blocks: headingBlocks };
  }
  return result;
}

export function assertVisualRevisionClientShape(raw: Record<string, unknown>): void {
  const forbidden = Object.keys(raw).filter((key) => !VISUAL_REVISION_CLIENT_KEYS.has(key));
  if (forbidden.length) {
    throw new Error('视觉修订不接受配方路径、JSON patch 或客户端操作列表');
  }
  parseWechatLayout(raw.wechatLayout);
}
