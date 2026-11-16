'use client';

import { Columns3, X } from 'lucide-react';
import type { BrandTemplate } from '@/lib/brand-templates';
import { Md2WechatThemePreview } from '@/components/Md2WechatThemePreview';

export function Md2WechatThemeComparison({
  themes,
  selectedThemeId = '',
  defaultThemeId = '',
  onSelect,
  onSetDefault,
  onRemove,
  onClear,
}: {
  themes: readonly BrandTemplate[];
  selectedThemeId?: string;
  defaultThemeId?: string;
  onSelect?: (themeId: string) => void;
  onSetDefault?: (themeId: string) => void;
  onRemove: (themeId: string) => void;
  onClear: () => void;
}) {
  if (themes.length === 0) return null;
  return (
    <section aria-labelledby="md2wechat-comparison-heading" className="mt-4 border-t border-[rgba(28,28,30,0.1)] pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h4 id="md2wechat-comparison-heading" className="flex items-center gap-2 text-[15px] font-bold text-[#1A1A1A]">
            <Columns3 size={15} className="text-[#E85D4C]" />
            主题对比 · {themes.length}/3
          </h4>
          <p className="mt-1 text-[13px] text-[#69635D]">
            逐个生成同一篇示例的排版，再并排比较。加入对比不会自动请求外部排版服务。
          </p>
        </div>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex min-h-[40px] items-center gap-1.5 rounded-[9px] px-3 text-[13px] font-bold text-[#5D5852] transition hover:bg-[#F4EFEA] hover:text-[#1A1A1A] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#E85D4C]/30 active:translate-y-px"
        >
          <X size={12} /> 清空对比
        </button>
      </div>
      <div className={`grid gap-3 ${themes.length === 1 ? 'lg:grid-cols-2' : themes.length === 2 ? 'lg:grid-cols-2' : 'xl:grid-cols-3'}`}>
        {themes.map((theme) => (
          <Md2WechatThemePreview
            key={theme.id}
            theme={theme}
            compact
            className="mt-0"
            selected={theme.id === selectedThemeId}
            isDefault={theme.id === defaultThemeId}
            onSelect={onSelect ? () => onSelect(theme.id) : undefined}
            onSetDefault={onSetDefault ? () => onSetDefault(theme.id) : undefined}
            onClose={() => onRemove(theme.id)}
          />
        ))}
        {themes.length === 1 && (
          <div className="flex min-h-[300px] items-center justify-center rounded-[16px] border border-dashed border-[rgba(28,28,30,0.14)] bg-[#FFFDF9] px-8 text-center">
            <div>
              <Columns3 size={20} className="mx-auto text-[#D99124]" />
              <p className="mt-3 text-[14px] font-bold text-[#4E4943]">再加入一个主题</p>
              <p className="mt-1 text-[13px] leading-[1.6] text-[#69635D]">选择相近版式或相同色系，更容易看出差异。</p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
