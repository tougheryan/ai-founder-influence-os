'use client';

import Link from 'next/link';
import { BookOpenText, ChevronRight } from 'lucide-react';

const brainItems = [
  { label: '创作定位', href: '/materials', tab: 'identity', desc: '身份、账号与内容支柱' },
  { label: '目标受众', href: '/materials', tab: 'audience', desc: '用户画像与内容边界' },
  { label: '表达规则', href: '/materials', tab: 'rules', desc: '风格、禁忌与平台提示' },
];

export function BrainShortcutsWidget() {
  return (
    <div className="rounded-xl border border-[rgba(28,28,30,0.08)] bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <BookOpenText size={16} className="text-[#E85D4C]" />
        <span className="text-[15px] font-bold text-[#1A1A1A]">创作档案</span>
      </div>
      <div className="space-y-1">
        {brainItems.map((item) => (
          <Link
            key={item.tab}
            href={item.href}
            className="group flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors hover:bg-[#FDF8F3]"
          >
            <div>
              <div className="text-[13px] font-medium text-[#1A1A1A]">{item.label}</div>
              <div className="text-[12px] text-[#9A9A9A]">{item.desc}</div>
            </div>
            <ChevronRight
              size={16}
              className="text-[#D4D4D4] transition-colors group-hover:text-[#E85D4C]"
            />
          </Link>
        ))}
      </div>
    </div>
  );
}
