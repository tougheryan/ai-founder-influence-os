'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  BarChart3,
  ChevronLeft,
  FolderOpen,
  Radar,
  Settings,
  Target,
  Workflow,
} from 'lucide-react';
import { EchoFounderMark } from '@/components/brand/EchoFounderMark';
import { PRODUCT_COPY } from '@/lib/product-copy';
import { useUIStore } from '@/store/uiStore';

// The left sidebar is a stable product contract. Workbench stage copy can
// evolve without silently renaming the global navigation or its progress row.
export const SIDEBAR_COPY_CONTRACT = {
  brand: 'Echo Founder',
  navigationLabel: '主导航',
  sections: {
    workbench: '工作台',
    assets: '内容资产',
    system: '系统',
  },
  workflow: '本期内容生产',
  progress: '当前进度',
  productionStages: {
    '1': '素材入库',
    '2': '公开信息研究、立项与模板',
    '3': '平台原生内容确认',
    '4': '按需视觉效果确认',
    '5': '已选平台成品确认',
    '6': '各平台发布结果',
    '7': '平台复盘与沉淀',
  },
  publicationDesk: {
    number: '05–06',
    label: '平台草稿与发布确认',
  },
  supportItems: [
    PRODUCT_COPY.pages.materials.title,
    '爆款内容雷达',
    '内容对标研究',
    PRODUCT_COPY.pages.weeklyReview.title,
  ],
  settings: '系统设置',
  expand: '展开侧边栏',
  collapse: '收起侧边栏',
} as const;

const WORKFLOW_STAGES: Readonly<Record<string, string>> = SIDEBAR_COPY_CONTRACT.productionStages;

const SUPPORT_ITEMS = [
  { label: SIDEBAR_COPY_CONTRACT.supportItems[0], href: '/materials', icon: FolderOpen },
  { label: SIDEBAR_COPY_CONTRACT.supportItems[1], href: '/content-radar', icon: Radar },
  { label: SIDEBAR_COPY_CONTRACT.supportItems[2], href: '/benchmark-advisor', icon: Target },
  { label: SIDEBAR_COPY_CONTRACT.supportItems[3], href: '/weekly-review', icon: BarChart3 },
] as const;

const SYSTEM_ITEMS = [{ label: SIDEBAR_COPY_CONTRACT.settings, href: '/settings', icon: Settings }] as const;

function isWorkflowRoute(pathname: string): boolean {
  return ['/production', '/publication-desk'].includes(pathname);
}

function workflowStageLabel(pathname: string, selectedStage: string): { number: string; label: string } {
  if (pathname === '/publication-desk') return SIDEBAR_COPY_CONTRACT.publicationDesk;
  const number = WORKFLOW_STAGES[selectedStage] ? selectedStage : '1';
  return {
    number: number.padStart(2, '0'),
    label: WORKFLOW_STAGES[number],
  };
}

type NavItem = {
  label: string;
  href: string;
  icon: typeof Workflow;
};

function NavigationItem({
  item,
  active,
  collapsed,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      title={collapsed ? item.label : undefined}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      className={`aifios-sidebar-link group relative flex h-[44px] items-center rounded-lg ${
        collapsed ? 'justify-center px-0' : 'gap-[12px] px-[12px] max-md:justify-center max-md:px-0'
      } ${
        active
          ? 'is-active'
          : ''
      }`}
    >
      {active && <span className="aifios-sidebar-link__marker absolute -left-[12px] top-1/2 h-[24px] w-[3px] -translate-y-1/2 max-md:left-0" />}
      <Icon size={18} strokeWidth={1.8} className="shrink-0" />
      {!collapsed && <span className="text-[14px] font-semibold max-md:hidden">{item.label}</span>}
    </Link>
  );
}

function NavigationSection({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: React.ReactNode;
}) {
  return (
    <section>
      {collapsed ? (
        <div className="aifios-sidebar-rule mx-auto mb-[8px] h-px w-[34px]" aria-hidden="true" />
      ) : (
        <h2 className="aifios-sidebar-section-title mb-[8px] px-[12px] text-[12px] font-medium max-md:hidden">{label}</h2>
      )}
      {children}
    </section>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { sidebarCollapsed, toggleSidebar, productionStage } = useUIStore();
  const selectedStage = searchParams.get('stage') || '1';
  const workflowActive = isWorkflowRoute(pathname);
  const currentWorkflowStage = pathname === '/production' && productionStage
    ? productionStage : workflowStageLabel(pathname, selectedStage);

  return (
    <aside
      className={`aifios-desktop-sidebar relative flex shrink-0 flex-col border-r ${
        sidebarCollapsed ? 'w-[64px]' : 'w-[272px] max-md:w-[64px]'
      }`}
    >
      <div
        className={`aifios-desktop-brand flex h-[68px] items-center border-b ${
          sidebarCollapsed ? 'justify-center px-0' : 'gap-[12px] px-[16px] max-md:justify-center max-md:px-0'
        }`}
      >
        <div className="aifios-app-mark flex h-[36px] w-[36px] shrink-0 items-center justify-center rounded-md" title={SIDEBAR_COPY_CONTRACT.brand}>
          <EchoFounderMark alt={SIDEBAR_COPY_CONTRACT.brand} size={36} />
        </div>
        {!sidebarCollapsed && (
          <span className="aifios-app-name truncate text-[16px] font-bold max-md:hidden">
            {SIDEBAR_COPY_CONTRACT.brand}
          </span>
        )}
      </div>

      <nav className={`flex-1 overflow-y-auto ${sidebarCollapsed ? 'px-[8px] py-[16px]' : 'p-[16px] max-md:px-[8px] max-md:py-[16px]'}`} aria-label={SIDEBAR_COPY_CONTRACT.navigationLabel}>
        <div className="space-y-[22px]">
          <NavigationSection label={SIDEBAR_COPY_CONTRACT.sections.workbench} collapsed={sidebarCollapsed}>
            <NavigationItem
              item={{ label: SIDEBAR_COPY_CONTRACT.workflow, href: '/production?stage=1', icon: Workflow }}
              active={workflowActive}
              collapsed={sidebarCollapsed}
            />
            {!sidebarCollapsed && workflowActive && (
              <div className="aifios-sidebar-progress mx-[12px] mt-[8px] border-l-2 pl-[10px] max-md:hidden" aria-live="polite">
                <p className="text-[11px] font-medium">{SIDEBAR_COPY_CONTRACT.progress}</p>
                <p className="mt-[2px] text-[12px] font-semibold">
                  {currentWorkflowStage.number} · {currentWorkflowStage.label}
                </p>
              </div>
            )}
          </NavigationSection>

          <NavigationSection label={SIDEBAR_COPY_CONTRACT.sections.assets} collapsed={sidebarCollapsed}>
            <div className="space-y-[4px]">
              {SUPPORT_ITEMS.map((item) => (
                <NavigationItem key={item.href} item={item} active={pathname === item.href} collapsed={sidebarCollapsed} />
              ))}
            </div>
          </NavigationSection>

          <NavigationSection label={SIDEBAR_COPY_CONTRACT.sections.system} collapsed={sidebarCollapsed}>
            <div className="space-y-[4px]">
              {SYSTEM_ITEMS.map((item) => (
                <NavigationItem key={item.href} item={item} active={pathname === item.href} collapsed={sidebarCollapsed} />
              ))}
            </div>
          </NavigationSection>
        </div>
      </nav>

      <div className={`aifios-sidebar-footer border-t ${sidebarCollapsed ? 'p-[8px]' : 'p-[12px]'}`}>
        <button
          type="button"
          onClick={toggleSidebar}
          className="aifios-sidebar-toggle mx-auto flex h-[36px] w-[36px] items-center justify-center rounded-lg"
          aria-label={sidebarCollapsed ? SIDEBAR_COPY_CONTRACT.expand : SIDEBAR_COPY_CONTRACT.collapse}
        >
          <span className={sidebarCollapsed ? 'block rotate-180' : 'block'}>
            <ChevronLeft size={18} />
          </span>
        </button>
      </div>
    </aside>
  );
}
