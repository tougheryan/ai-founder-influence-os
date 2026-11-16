'use client';

import { Suspense, useEffect } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { PRODUCT_COPY } from '@/lib/product-copy';
import { usePathname } from 'next/navigation';

interface DashboardLayoutProps {
  children: React.ReactNode;
}

const PAGE_TITLES: Record<string, string> = {
  '/': 'Echo Founder · 内容创作工作台',
  '/production': '本期内容生产 · Echo Founder',
  '/materials': `${PRODUCT_COPY.pages.materials.title} · Echo Founder`,
  '/content-radar': '爆款内容雷达 · Echo Founder',
  '/benchmark-advisor': '内容对标研究 · Echo Founder',
  '/publication-desk': '发布准备 · Echo Founder',
  '/delivery': '发布交付 · Echo Founder',
  '/weekly-review': `${PRODUCT_COPY.pages.weeklyReview.title} · Echo Founder`,
  '/settings': '系统设置 · Echo Founder',
};

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const pathname = usePathname();

  useEffect(() => {
    const pageTitle = PAGE_TITLES[pathname] || 'Echo Founder · 内容创作工作台';
    const applyPageTitle = () => {
      if (document.title !== pageTitle) document.title = pageTitle;
    };
    applyPageTitle();
    const titleObserver = new MutationObserver(applyPageTitle);
    titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => titleObserver.disconnect();
  }, [pathname]);

  if (pathname === '/') {
    return (
      <main className="min-h-screen w-full bg-[#FBF8F5]">
        {children}
      </main>
    );
  }

  return (
    <div className="aifios-desktop-shell flex h-screen w-full overflow-hidden">
      <a
        href="#main-content"
        className="fixed left-3 top-3 z-[100] -translate-y-24 rounded-lg bg-[#1C1C1E] px-4 py-3 text-[14px] font-bold text-white shadow-lg transition-transform focus:translate-y-0 focus:outline-none focus:ring-2 focus:ring-[#E85D4C] focus:ring-offset-2"
      >
        跳到主要内容
      </a>
      <Suspense fallback={<aside className="aifios-desktop-sidebar w-[272px] shrink-0 border-r max-md:w-[64px]" aria-hidden="true" />}>
        <Sidebar />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col">
        <Header />
        <main id="main-content" tabIndex={-1} className="aifios-workspace flex-1 overflow-auto px-4 py-5 md:px-8 md:py-8 xl:px-9">{children}</main>
      </div>
    </div>
  );
}
