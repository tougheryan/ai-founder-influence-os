import { activeBrandTemplates, type BrandTemplate } from './brand-templates';
import { readMd2WechatThemeCatalog } from './md2wechat-themes';

export class BrandTemplateResolutionError extends Error {}

export async function readConfiguredBrandTemplates(): Promise<BrandTemplate[]> {
  return (await readMd2WechatThemeCatalog()).templates;
}

export async function resolveConfiguredBrandTemplate(templateId?: string): Promise<BrandTemplate> {
  const templates = activeBrandTemplates(await readConfiguredBrandTemplates());
  const selected = templateId
    ? templates.find((template) => template.id === templateId)
    : templates.find((template) => template.id === 'wechat-native') || templates[0];
  if (!selected) {
    throw new BrandTemplateResolutionError(
      templateId
        ? '这个 md2wechat 主题当前不可直接用于确定性排版，请选择 API 主题。'
        : '本机没有可用的 md2wechat API 主题。',
    );
  }
  return selected;
}
