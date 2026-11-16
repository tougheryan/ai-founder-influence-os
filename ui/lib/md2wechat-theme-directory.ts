import type { BrandTemplate } from './brand-templates';

export type ThemeBrowseAxis = 'layout' | 'color';

type CategoryDefinition = {
  id: string;
  label: string;
  description: string;
};

export type ThemeDirectorySection = CategoryDefinition & {
  themes: BrandTemplate[];
};

export type ThemeDirectoryGroup = CategoryDefinition & {
  sections: ThemeDirectorySection[];
  count: number;
};

const LAYOUT_CATEGORIES: CategoryDefinition[] = [
  { id: 'minimal', label: '极简阅读', description: '低装饰、轻量标题，适合长文与方法论' },
  { id: 'bold', label: '醒目标题', description: '满底色与强标题，适合观点和清单内容' },
  { id: 'elegant', label: '层次边框', description: '递进边框与背景层次，适合结构化长文' },
  { id: 'focus', label: '居中聚焦', description: '居中对称与分隔线，适合演讲和品牌观点' },
  { id: 'brand', label: '品牌原生', description: '平台或品牌辨识度明确的成熟排版' },
  { id: 'scene', label: '内容场景', description: '面向新闻、生活方式、文化与兴趣内容' },
];

const COLOR_CATEGORIES: CategoryDefinition[] = [
  { id: 'blue', label: '蓝色与藏青', description: '理性、专业、科技感' },
  { id: 'green', label: '绿色与薄荷', description: '自然、稳妥、轻松' },
  { id: 'warm', label: '红橙暖色', description: '醒目、亲和、有行动感' },
  { id: 'gold', label: '金色', description: '克制、品质、正式' },
  { id: 'neutral', label: '黑白灰', description: '中性、安静、强调内容' },
  { id: 'purple', label: '紫色与赛博', description: '灵感、未来感、强氛围' },
  { id: 'mixed', label: '品牌与多彩', description: '原生品牌色或多色组合' },
];

const BRAND_THEME_IDS = new Set([
  'apple',
  'bytedance',
  'default',
  'github-readme',
  'sspai-red',
  'wechat-native',
]);

function definition(definitions: readonly CategoryDefinition[], id: string): CategoryDefinition {
  return definitions.find((candidate) => candidate.id === id) || definitions[definitions.length - 1];
}

export function md2WechatLayoutCategory(theme: BrandTemplate): CategoryDefinition {
  const id = theme.id.toLowerCase();
  if (id.startsWith('minimal-') || id === 'ink-minimal') return definition(LAYOUT_CATEGORIES, 'minimal');
  if (id.startsWith('bold-')) return definition(LAYOUT_CATEGORIES, 'bold');
  if (id.startsWith('elegant-')) return definition(LAYOUT_CATEGORIES, 'elegant');
  if (id.startsWith('focus-')) return definition(LAYOUT_CATEGORIES, 'focus');
  if (BRAND_THEME_IDS.has(id)) return definition(LAYOUT_CATEGORIES, 'brand');
  return definition(LAYOUT_CATEGORIES, 'scene');
}

export function md2WechatColorCategory(theme: BrandTemplate): CategoryDefinition {
  const signal = `${theme.id} ${theme.detail}`.toLowerCase();
  if (/gold|金色|金色系/.test(signal)) return definition(COLOR_CATEGORIES, 'gold');
  if (/blue|sky|navy|ocean|蓝色|天蓝|藏青|深海/.test(signal)) return definition(COLOR_CATEGORIES, 'blue');
  if (/green|mint|spring|wechat-native|绿色|薄荷|春日/.test(signal)) return definition(COLOR_CATEGORIES, 'green');
  if (/red|orange|sunset|autumn|coffee|红色|橙色|琥珀|秋日|咖啡|巧克力/.test(signal)) {
    return definition(COLOR_CATEGORIES, 'warm');
  }
  if (/purple|lavender|cyber|紫色|赛博|梦幻/.test(signal)) return definition(COLOR_CATEGORIES, 'purple');
  if (/gray|ink|default|nyt|github|黑白|灰色|水墨|新闻纸/.test(signal)) {
    return definition(COLOR_CATEGORIES, 'neutral');
  }
  return definition(COLOR_CATEGORIES, 'mixed');
}

export function previewableMd2WechatThemes(themes: readonly BrandTemplate[]): BrandTemplate[] {
  return themes.filter((theme) => (
    theme.enabled && theme.source === 'md2wechat' && theme.themeType === 'api'
  ));
}

export function recommendedMd2WechatThemes(
  themes: readonly BrandTemplate[],
  context = '',
  priorityThemeIds: readonly string[] = [],
): BrandTemplate[] {
  const previewable = previewableMd2WechatThemes(themes);
  const byId = new Map(previewable.map((theme) => [theme.id, theme]));
  const signal = context.toLowerCase();
  const contextualIds = /故事|经历|人物|情感|生活|访谈|创始人/.test(signal)
    ? ['coffee-house', 'autumn-warm', 'sunset-amber', 'lavender-dream']
    : /研究|数据|报告|趋势|科技|技术|\bai\b|分析/.test(signal)
      ? ['elegant-navy', 'focus-blue', 'minimal-navy', 'github-readme']
      : /观点|方法|清单|商业|获客|复盘|策略/.test(signal)
        ? ['minimal-blue', 'elegant-gray', 'focus-navy', 'wechat-native']
        : ['wechat-native', 'minimal-navy', 'elegant-blue', 'apple'];
  const ids = [...priorityThemeIds, ...contextualIds];
  const selected: BrandTemplate[] = [];
  for (const id of ids) {
    const theme = byId.get(id);
    if (theme && !selected.some((candidate) => candidate.id === theme.id)) selected.push(theme);
    if (selected.length === 3) return selected;
  }
  for (const theme of previewable) {
    if (!selected.some((candidate) => candidate.id === theme.id)) selected.push(theme);
    if (selected.length === 3) break;
  }
  return selected;
}

export function toggleMd2WechatThemeComparison(
  currentThemeIds: readonly string[],
  themeId: string,
  limit = 3,
): string[] {
  if (currentThemeIds.includes(themeId)) {
    return currentThemeIds.filter((id) => id !== themeId);
  }
  return currentThemeIds.length < limit ? [...currentThemeIds, themeId] : [...currentThemeIds];
}

export function buildMd2WechatThemeDirectory(
  themes: readonly BrandTemplate[],
  axis: ThemeBrowseAxis,
): ThemeDirectoryGroup[] {
  const firstDefinitions = axis === 'layout' ? LAYOUT_CATEGORIES : COLOR_CATEGORIES;
  const secondDefinitions = axis === 'layout' ? COLOR_CATEGORIES : LAYOUT_CATEGORIES;
  const firstCategory = axis === 'layout' ? md2WechatLayoutCategory : md2WechatColorCategory;
  const secondCategory = axis === 'layout' ? md2WechatColorCategory : md2WechatLayoutCategory;
  const previewable = previewableMd2WechatThemes(themes);

  return firstDefinitions.flatMap((groupDefinition): ThemeDirectoryGroup[] => {
    const groupThemes = previewable.filter((theme) => firstCategory(theme).id === groupDefinition.id);
    if (groupThemes.length === 0) return [];
    const sections = secondDefinitions.flatMap((sectionDefinition): ThemeDirectorySection[] => {
      const sectionThemes = groupThemes
        .filter((theme) => secondCategory(theme).id === sectionDefinition.id)
        .sort((left, right) => left.id.localeCompare(right.id));
      return sectionThemes.length > 0 ? [{ ...sectionDefinition, themes: sectionThemes }] : [];
    });
    return [{ ...groupDefinition, sections, count: groupThemes.length }];
  });
}

export function themeDirectoryPath(
  themes: readonly BrandTemplate[],
  axis: ThemeBrowseAxis,
  themeId: string,
): { groupId: string; sectionId: string } | null {
  for (const group of buildMd2WechatThemeDirectory(themes, axis)) {
    for (const section of group.sections) {
      if (section.themes.some((theme) => theme.id === themeId)) {
        return { groupId: group.id, sectionId: section.id };
      }
    }
  }
  return null;
}

export function md2WechatThemeSwatchClass(theme: BrandTemplate): string {
  const color = md2WechatColorCategory(theme).id;
  return {
    blue: 'bg-[#496A86]',
    green: 'bg-[#5E7E52]',
    warm: 'bg-[#C86A4C]',
    gold: 'bg-[#A88943]',
    neutral: 'bg-[#6D6D69]',
    purple: 'bg-[#765F85]',
    mixed: 'bg-[linear-gradient(135deg,#5E7E52_0_33%,#D69B45_33%_66%,#496A86_66%)]',
  }[color] || 'bg-[#6D6D69]';
}
