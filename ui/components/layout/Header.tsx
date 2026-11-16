'use client';

import { usePathname } from 'next/navigation';
import { PanelLeft, Settings } from 'lucide-react';
import { useUIStore } from '@/store/uiStore';
import { PRODUCT_COPY } from '@/lib/product-copy';
import Link from 'next/link';

const pageTitleMap: Record<string, { title: string; breadcrumbs: readonly string[] }> = {
  '/': { title: '工作台', breadcrumbs: ['工作台'] },
  '/case': { title: '案例展示', breadcrumbs: ['工作台', '案例展示'] },
  '/production': PRODUCT_COPY.pages.production,
  '/publication-desk': PRODUCT_COPY.pages.publicationDesk,
  '/materials': PRODUCT_COPY.pages.materials,
  '/content-radar': PRODUCT_COPY.pages.contentRadar,
  '/benchmark-advisor': PRODUCT_COPY.pages.benchmarkAdvisor,
  '/weekly-review': PRODUCT_COPY.pages.weeklyReview,
  '/settings': PRODUCT_COPY.pages.settings,
  '/closing': { title: '关于', breadcrumbs: ['关于'] },
};

export function Header() {
  const pathname = usePathname();
  const { toggleSidebar } = useUIStore();
  const { breadcrumbs } = pageTitleMap[pathname] || {
    title: PRODUCT_COPY.workspaceName,
    breadcrumbs: [PRODUCT_COPY.workspaceName],
  };

  return (
    <header className="aifios-desktop-header flex h-[68px] shrink-0 items-center justify-between gap-2 border-b px-5 md:px-7">
      <div className="flex min-w-0 items-center gap-3">
        <button
          onClick={toggleSidebar}
          className="aifios-header-icon-button flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          aria-label="切换侧边栏"
        >
          <PanelLeft size={18} />
        </button>
        <div className="flex min-w-0 items-center gap-2">
          {breadcrumbs.map((crumb, idx) => (
            <span key={idx} className="aifios-header-crumb flex min-w-0 items-center gap-2 text-[14px]">
              {idx > 0 && <span className="aifios-header-separator">/</span>}
              <span className={`truncate ${idx === breadcrumbs.length - 1 ? 'aifios-header-crumb--current font-semibold' : 'max-sm:hidden'}`}>
                {crumb}
              </span>
            </span>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <Link
          href="/settings"
          aria-label="系统设置"
          className="aifios-header-icon-button flex h-9 w-9 items-center justify-center rounded-lg"
        >
          <Settings size={18} />
        </Link>
      </div>
    </header>
  );
}
