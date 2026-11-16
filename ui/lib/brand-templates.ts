export type Md2WechatThemeType = 'api' | 'ai' | 'catalog' | 'fallback';

export type BrandTemplate = {
  id: string;
  label: string;
  detail: string;
  layoutStyle: string;
  enabled: boolean;
  selectable?: boolean;
  themeType?: Md2WechatThemeType;
  version?: string;
  source?: 'md2wechat' | 'echo-basic-fallback';
};

export class BrandTemplateValidationError extends Error {}

export const MD2WECHAT_THEME_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_TEMPLATES = 80;
const MAX_LABEL_LENGTH = 80;
const MAX_DETAIL_LENGTH = 240;

/** One delivery-safe fallback, not a second theme library. */
export const DEFAULT_BRAND_TEMPLATE: BrandTemplate = {
  id: 'default',
  label: 'default',
  detail: 'md2wechat 当前不可用；本期将使用 Echo Founder 基础排版完成交付。',
  layoutStyle: 'default',
  enabled: true,
  selectable: true,
  themeType: 'fallback',
  source: 'echo-basic-fallback',
};

export function isMd2WechatThemeId(value: unknown): value is string {
  return typeof value === 'string' && MD2WECHAT_THEME_ID_PATTERN.test(value);
}

function readText(value: unknown, field: string, maximumLength: number): string {
  if (typeof value !== 'string') {
    throw new BrandTemplateValidationError(`md2wechat 主题${field}必须是文本。`);
  }
  const text = value.trim();
  if (!text) throw new BrandTemplateValidationError(`md2wechat 主题${field}不能为空。`);
  if (text.length > maximumLength) {
    throw new BrandTemplateValidationError(`md2wechat 主题${field}不能超过 ${maximumLength} 个字符。`);
  }
  return text;
}

function normalizeThemeType(value: unknown): Md2WechatThemeType | undefined {
  return value === 'api' || value === 'ai' || value === 'catalog' || value === 'fallback'
    ? value
    : undefined;
}

function normalizeBrandTemplate(value: unknown, index: number): BrandTemplate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrandTemplateValidationError(`第 ${index + 1} 个 md2wechat 主题格式不正确。`);
  }
  const source = value as Record<string, unknown>;
  const id = readText(source.id, '标识', 64).toLowerCase();
  const layoutStyle = readText(source.layoutStyle, '渲染标识', 64).toLowerCase();
  if (!isMd2WechatThemeId(id) || !isMd2WechatThemeId(layoutStyle)) {
    throw new BrandTemplateValidationError('md2wechat 主题标识只能包含小写字母、数字、连字符和下划线。');
  }
  if (typeof source.enabled !== 'boolean') {
    throw new BrandTemplateValidationError('md2wechat 主题可用状态必须为布尔值。');
  }
  return {
    id,
    label: readText(source.label, '名称', MAX_LABEL_LENGTH),
    detail: readText(source.detail, '说明', MAX_DETAIL_LENGTH),
    layoutStyle,
    enabled: source.enabled,
    selectable: typeof source.selectable === 'boolean' ? source.selectable : source.enabled,
    themeType: normalizeThemeType(source.themeType),
    version: typeof source.version === 'string' ? source.version.trim().slice(0, 32) : undefined,
    source: source.source === 'md2wechat' ? 'md2wechat' : source.source === 'echo-basic-fallback' ? 'echo-basic-fallback' : undefined,
  };
}

export function parseBrandTemplates(value: unknown): BrandTemplate[] {
  if (!Array.isArray(value)) {
    throw new BrandTemplateValidationError('md2wechat 主题目录必须是列表。');
  }
  if (!value.length) throw new BrandTemplateValidationError('md2wechat 主题目录不能为空。');
  if (value.length > MAX_TEMPLATES) {
    throw new BrandTemplateValidationError(`md2wechat 主题目录最多读取 ${MAX_TEMPLATES} 项。`);
  }

  const templates = value.map(normalizeBrandTemplate);
  const ids = new Set<string>();
  for (const template of templates) {
    if (ids.has(template.id)) {
      throw new BrandTemplateValidationError('md2wechat 主题标识不能重复。');
    }
    ids.add(template.id);
  }
  if (!templates.some((template) => template.enabled)) {
    throw new BrandTemplateValidationError('md2wechat 当前没有可直接用于确定性排版的主题。');
  }
  return templates;
}

export function activeBrandTemplates(templates: readonly BrandTemplate[]): BrandTemplate[] {
  return templates.filter((template) => template.enabled).map((template) => ({ ...template }));
}
