'use client';

import { useMemo, useState } from 'react';
import {
  Check,
  ChevronRight,
  Clock3,
  Columns3,
  Eye,
  LayoutGrid,
  Palette,
  Search,
  Star,
} from 'lucide-react';
import type { BrandTemplate } from '@/lib/brand-templates';
import {
  buildMd2WechatThemeDirectory,
  md2WechatThemeSwatchClass,
  previewableMd2WechatThemes,
  recommendedMd2WechatThemes,
  themeDirectoryPath,
  type ThemeBrowseAxis,
} from '@/lib/md2wechat-theme-directory';
import type { Md2WechatThemePreferences } from '@/lib/md2wechat-theme-preferences';

type ThemeBrowseScope = 'all' | 'favorites' | 'recent';

const EMPTY_PREFERENCES: Md2WechatThemePreferences = {
  favoriteThemeIds: [],
  recentThemeIds: [],
  defaultThemeId: '',
};

type Md2WechatThemeBrowserProps = {
  themes: readonly BrandTemplate[];
  selectedThemeId?: string;
  previewThemeId?: string;
  onPreview: (themeId: string) => void;
  compareThemeIds?: readonly string[];
  onToggleCompare?: (themeId: string) => void;
  preferences?: Md2WechatThemePreferences;
  onToggleFavorite?: (themeId: string) => void;
  recommendationContext?: string;
};

function initialDirectoryState(themes: readonly BrandTemplate[], themeId: string) {
  const groups: Partial<Record<ThemeBrowseAxis, string>> = {};
  const sections: Record<string, string> = {};
  for (const axis of ['layout', 'color'] as const) {
    const path = themeDirectoryPath(themes, axis, themeId);
    if (!path) continue;
    groups[axis] = path.groupId;
    sections[`${axis}:${path.groupId}`] = path.sectionId;
  }
  return { groups, sections };
}

export function Md2WechatThemeBrowser({
  themes,
  selectedThemeId = '',
  previewThemeId = '',
  onPreview,
  compareThemeIds = [],
  onToggleCompare,
  preferences = EMPTY_PREFERENCES,
  onToggleFavorite,
  recommendationContext = '',
}: Md2WechatThemeBrowserProps) {
  const previewable = useMemo(() => previewableMd2WechatThemes(themes), [themes]);
  const initialThemeId = previewThemeId || selectedThemeId || previewable[0]?.id || '';
  const initialState = initialDirectoryState(previewable, initialThemeId);
  const [axis, setAxis] = useState<ThemeBrowseAxis>('layout');
  const [scope, setScope] = useState<ThemeBrowseScope>('all');
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState<Partial<Record<ThemeBrowseAxis, string | null>>>(initialState.groups);
  const [openSections, setOpenSections] = useState<Record<string, string | null>>(initialState.sections);

  const suggestedThemes = useMemo(() => recommendedMd2WechatThemes(
    previewable,
    recommendationContext,
    [selectedThemeId, preferences.defaultThemeId, ...preferences.recentThemeIds].filter(Boolean),
  ), [preferences.defaultThemeId, preferences.recentThemeIds, previewable, recommendationContext, selectedThemeId]);
  const scopedThemes = useMemo(() => {
    if (scope === 'favorites') {
      const favorites = new Set(preferences.favoriteThemeIds);
      return previewable.filter((theme) => favorites.has(theme.id));
    }
    if (scope === 'recent') {
      const order = new Map(preferences.recentThemeIds.map((id, index) => [id, index]));
      return previewable
        .filter((theme) => order.has(theme.id))
        .sort((left, right) => (order.get(left.id) || 0) - (order.get(right.id) || 0));
    }
    return previewable;
  }, [preferences.favoriteThemeIds, preferences.recentThemeIds, previewable, scope]);
  const filteredThemes = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return scopedThemes;
    return scopedThemes.filter((theme) => (
      `${theme.id} ${theme.label} ${theme.detail}`.toLowerCase().includes(needle)
    ));
  }, [query, scopedThemes]);
  const directory = useMemo(
    () => buildMd2WechatThemeDirectory(filteredThemes, axis),
    [axis, filteredThemes],
  );
  const searching = Boolean(query.trim());
  const unavailableCount = themes.length - previewable.length;
  const activePath = themeDirectoryPath(
    previewable,
    axis,
    previewThemeId || selectedThemeId || previewable[0]?.id || '',
  );

  function changeAxis(nextAxis: ThemeBrowseAxis) {
    setAxis(nextAxis);
  }

  function activate(themeId: string) {
    const nextState = initialDirectoryState(previewable, themeId);
    setOpenGroups((values) => ({ ...values, ...nextState.groups }));
    setOpenSections((values) => ({ ...values, ...nextState.sections }));
    onPreview(themeId);
  }

  const savedOpenGroup = openGroups[axis];
  const openGroupId = savedOpenGroup === undefined ? activePath?.groupId : savedOpenGroup;

  return (
    <div className="min-w-0">
      <div className="mb-2.5 rounded-[12px] border-l-[3px] border-[#D99124] bg-[#FFF9EC] px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-bold text-[#7B4D00]">建议先看</span>
          <span className="text-[12px] text-[#8D652C]">先预览，再决定是否选用</span>
        </div>
        <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
          {suggestedThemes.map((theme) => {
            const previewed = theme.id === previewThemeId;
            return (
              <button
                key={theme.id}
                type="button"
                onClick={() => activate(theme.id)}
                aria-pressed={previewed}
                className={`flex min-w-0 items-center gap-2 rounded-[7px] px-2.5 py-2 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#D99124]/30 active:translate-y-px ${previewed ? 'bg-white text-[#9B3F34] shadow-[0_4px_12px_rgba(121,91,45,0.09)]' : 'bg-[rgba(255,255,255,0.58)] text-[#5E5953] hover:bg-white'}`}
              >
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ring-1 ring-black/10 ${md2WechatThemeSwatchClass(theme)}`} />
                <span className="truncate text-[13px] font-bold">{theme.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="rounded-[12px] border border-[rgba(28,28,30,0.1)] bg-[#F6F3EE] p-2.5">
        <div className="flex flex-col gap-2.5 xl:flex-row xl:items-center xl:justify-between">
          <div className="inline-flex w-fit rounded-[8px] border border-[rgba(28,28,30,0.1)] bg-white p-1" aria-label="主题目录方式">
            {([
              { id: 'layout' as const, label: '按版式', icon: LayoutGrid },
              { id: 'color' as const, label: '按颜色', icon: Palette },
            ]).map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={axis === option.id}
                  onClick={() => changeAxis(option.id)}
                  className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-[7px] px-3 text-[13px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E85D4C]/30 active:translate-y-px ${axis === option.id ? 'bg-[#1C1C1E] text-white' : 'text-[#5D5852] hover:bg-[#F4EFEA] hover:text-[#1A1A1A]'}`}
                >
                  <Icon size={13} />
                  {option.label}
                </button>
              );
            })}
          </div>
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-[8px] border border-[rgba(28,28,30,0.1)] bg-white px-2.5 xl:max-w-[250px]">
            <Search size={13} className="shrink-0 text-[#8A8178]" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索主题或风格"
              className="h-11 min-w-0 flex-1 bg-transparent text-[14px] text-[#1A1A1A] outline-none placeholder:text-[#8A8178]"
            />
          </label>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-[rgba(28,28,30,0.07)] pt-2.5">
          <div className="flex items-center gap-1" aria-label="主题范围">
            {([
              { id: 'all' as const, label: '全部', count: previewable.length },
              { id: 'favorites' as const, label: '收藏', count: preferences.favoriteThemeIds.length, icon: Star },
              { id: 'recent' as const, label: '最近', count: preferences.recentThemeIds.length, icon: Clock3 },
            ]).map((option) => {
              const Icon = option.icon;
              return (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={scope === option.id}
                  onClick={() => setScope(option.id)}
                  className={`inline-flex min-h-[36px] items-center gap-1 rounded-[7px] px-2.5 text-[12px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E85D4C]/30 ${scope === option.id ? 'bg-white text-[#1A1A1A] shadow-[0_2px_8px_rgba(78,68,56,0.08)]' : 'text-[#69635D] hover:bg-white/70 hover:text-[#4E4943]'}`}
                >
                  {Icon && <Icon size={10} />}
                  {option.label}
                  <span className="font-mono font-normal text-[#9A938B]">{option.count}</span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-[#69635D]">
            {onToggleCompare && (
              <span className="inline-flex items-center gap-1 font-bold text-[#6B6B6B]">
                <Columns3 size={11} /> 对比 {compareThemeIds.length}/3
              </span>
            )}
            <span>{axis === 'layout' ? '一级版式 · 二级色系' : '一级色系 · 二级版式'}</span>
            <span className="tabular-nums">{filteredThemes.length} 个可选{unavailableCount > 0 ? ` · ${unavailableCount} 个仅目录展示` : ''}</span>
          </div>
        </div>
      </div>

      <div className="mt-2.5 overflow-hidden rounded-[12px] border border-[rgba(28,28,30,0.11)] bg-white">
        {directory.length > 0 ? directory.map((group) => {
          const groupKey = `${axis}:${group.id}`;
          const groupOpen = searching || openGroupId === group.id;
          return (
            <section key={groupKey} className="border-b border-[rgba(28,28,30,0.08)] last:border-b-0">
              <button
                type="button"
                aria-expanded={groupOpen}
                onClick={() => setOpenGroups((values) => ({
                  ...values,
                  [axis]: groupOpen && !searching ? null : group.id,
                }))}
                className="flex w-full items-center gap-2.5 bg-[#FCFBF8] px-3 py-3 text-left transition hover:bg-[#F7F3ED] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E85D4C]/30"
              >
                <ChevronRight size={14} className={`shrink-0 text-[#6B6B6B] transition-transform ${groupOpen ? 'rotate-90' : ''}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-bold text-[#1A1A1A]">{group.label}</span>
                  <span className="mt-0.5 block truncate text-[12px] text-[#69635D]">{group.description}</span>
                </span>
                <span className="font-mono text-[12px] text-[#69635D]">{group.count}</span>
              </button>

              {groupOpen && (
                <div className="bg-white px-2.5 pb-2.5">
                  {group.sections.map((section) => {
                    const sectionKey = `${groupKey}:${section.id}`;
                    const savedOpenSection = openSections[groupKey];
                    const openSectionId = savedOpenSection === undefined && activePath?.groupId === group.id
                      ? activePath.sectionId
                      : savedOpenSection;
                    const sectionOpen = searching
                      || openSectionId === section.id;
                    return (
                      <div key={sectionKey} className="mt-2 overflow-hidden rounded-[9px] border border-[rgba(28,28,30,0.08)]">
                        <button
                          type="button"
                          aria-expanded={sectionOpen}
                          onClick={() => setOpenSections((values) => ({
                            ...values,
                            [groupKey]: sectionOpen && !searching ? null : section.id,
                          }))}
                          className="flex w-full items-center gap-2 bg-[#F8F7F4] px-2.5 py-2 text-left transition hover:bg-[#F2EFEA] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E85D4C]/30"
                        >
                          <ChevronRight size={12} className={`shrink-0 text-[#8A8178] transition-transform ${sectionOpen ? 'rotate-90' : ''}`} />
                          <span className="flex-1 text-[13px] font-semibold text-[#4E4943]">{section.label}</span>
                          <span className="font-mono text-[12px] text-[#756F68]">{section.themes.length}</span>
                        </button>
                        {sectionOpen && (
                          <div className="space-y-1 p-1.5">
                            {section.themes.map((theme) => {
                              const selected = theme.id === selectedThemeId;
                              const previewed = theme.id === previewThemeId || (!previewThemeId && selected);
                              const compared = compareThemeIds.includes(theme.id);
                              const favorite = preferences.favoriteThemeIds.includes(theme.id);
                              const isDefault = theme.id === preferences.defaultThemeId;
                              const compareDisabled = compareThemeIds.length >= 3 && !compared;
                              return (
                                <div
                                  key={theme.id}
                                  className={`flex w-full items-center rounded-[7px] border-l-[3px] transition ${selected ? 'border-[#E85D4C] bg-[#FFF5F1]' : previewed ? 'border-[#D99124] bg-[#FFF9EC]' : 'border-transparent hover:bg-[#F8F5F0]'}`}
                                >
                                  <button
                                    type="button"
                                    aria-pressed={previewed}
                                    onClick={() => activate(theme.id)}
                                    className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#E85D4C]/30 active:translate-y-px"
                                    aria-label={`预览 ${theme.label} 主题`}
                                  >
                                    <span className={`h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10 ${md2WechatThemeSwatchClass(theme)}`} />
                                    <span className="min-w-0 flex-1">
                                      <span className="flex items-center gap-1.5">
                                        <span className="truncate text-[13px] font-bold text-[#1A1A1A]">{theme.label}</span>
                                        {selected && <Check size={12} className="shrink-0 text-[#C94A3B]" strokeWidth={2.6} />}
                                        {isDefault && <span className="rounded bg-[#FFF1E8] px-1.5 py-0.5 text-[10px] font-bold text-[#B4532F]">默认</span>}
                                      </span>
                                      <span className="mt-0.5 block truncate text-[12px] text-[#69635D]">{theme.detail}</span>
                                    </span>
                                    <span className="flex shrink-0 items-center gap-1 text-[11px] text-[#69635D]">
                                      {theme.version && <span className="font-mono">v{theme.version}</span>}
                                      <Eye size={12} className={previewed ? 'text-[#C94A3B]' : ''} />
                                    </span>
                                  </button>
                                  <span className="mr-1 flex shrink-0 items-center border-l border-[rgba(28,28,30,0.07)] pl-1">
                                    {onToggleCompare && (
                                      <button
                                        type="button"
                                        onClick={() => onToggleCompare(theme.id)}
                                        disabled={compareDisabled}
                                        aria-pressed={compared}
                                        aria-label={`${compared ? '移出' : '加入'}对比：${theme.label}`}
                                        title={compareDisabled ? '最多同时对比 3 个主题' : `${compared ? '移出' : '加入'}对比`}
                                        className={`inline-flex h-10 w-10 items-center justify-center rounded-[8px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E85D4C]/30 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-30 ${compared ? 'bg-[#1C1C1E] text-white' : 'text-[#706A63] hover:bg-white hover:text-[#1A1A1A]'}`}
                                      >
                                        <Columns3 size={12} />
                                      </button>
                                    )}
                                    {onToggleFavorite && (
                                      <button
                                        type="button"
                                        onClick={() => onToggleFavorite(theme.id)}
                                        aria-pressed={favorite}
                                        aria-label={`${favorite ? '取消收藏' : '收藏'}：${theme.label}`}
                                        title={favorite ? '取消收藏' : '收藏主题'}
                                        className={`inline-flex h-10 w-10 items-center justify-center rounded-[8px] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E85D4C]/30 active:translate-y-px ${favorite ? 'text-[#B97812]' : 'text-[#7A746D] hover:bg-white hover:text-[#B97812]'}`}
                                      >
                                        <Star size={12} fill={favorite ? 'currentColor' : 'none'} />
                                      </button>
                                    )}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        }) : (
          <div className="px-5 py-10 text-center text-[14px] leading-[1.7] text-[#69635D]">
            {scope === 'favorites'
              ? '还没有收藏主题。回到“全部”，点击星标即可加入。'
              : scope === 'recent'
                ? '还没有预览记录。看过的主题会自动出现在这里。'
                : '没有找到匹配的可用主题，请换一个关键词。'}
          </div>
        )}
      </div>
    </div>
  );
}
