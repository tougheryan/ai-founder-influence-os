'use client';

import Link from 'next/link';
import {
  FileText,
  GitBranch,
  FolderOpen,
  BookOpenText,
  Settings,
  Sparkles,
} from 'lucide-react';

const actions = [
  { label: '运行 intake', href: '/production?stage=1', icon: FileText, accent: true },
  { label: '进入生产线', href: '/production?stage=1', icon: GitBranch },
  { label: '浏览个人库', href: '/materials', icon: FolderOpen },
  { label: '编辑创作档案', href: '/materials', icon: BookOpenText },
  { label: '设置 LLM', href: '/settings', icon: Settings },
];

export function QuickActionsWidget() {
  return (
    <div className="rounded-xl border border-[rgba(28,28,30,0.08)] bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <Sparkles size={16} className="text-[#E85D4C]" />
        <span className="text-[15px] font-bold text-[#1A1A1A]">快捷操作</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <Link
              key={action.label}
              href={action.href}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2.5 text-[13px] font-medium transition-all ${
                action.accent
                  ? 'border-[rgba(232,93,76,0.2)] bg-[rgba(232,93,76,0.06)] text-[#E85D4C] hover:bg-[rgba(232,93,76,0.1)]'
                  : 'border-[rgba(28,28,30,0.06)] bg-[#FDF8F3] text-[#1A1A1A] hover:border-[rgba(28,28,30,0.12)]'
              }`}
            >
              <Icon size={15} />
              {action.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
