'use client';

import Link from 'next/link';
import { ArrowRight, DatabaseZap, KeyRound, Send } from 'lucide-react';

const setupItems = [
  {
    id: 'model-connection',
    label: '模型连接',
    detail: '生成文章前连接；可以先保存素材',
    requirement: '生成时需要',
    icon: KeyRound,
  },
  {
    id: 'tikomni-research',
    label: '平台数据服务',
    detail: '按自己的题目写，不需要配置',
    requirement: '找选题时需要',
    icon: DatabaseZap,
  },
  {
    id: 'publication-bridge',
    label: '发布账号连接',
    detail: '公众号、小红书和视频号',
    requirement: '可选',
    icon: Send,
  },
] as const;

export function DesktopFirstRunGuide() {
  return (
    <section className="border-y border-[rgba(28,28,30,0.12)] bg-white px-4 py-4" aria-labelledby="first-run-setup-title">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[12px] font-bold text-[#E85D4C]">首次设置</p>
          <h2 id="first-run-setup-title" className="mt-1 text-[19px] font-bold text-[#1A1A1A]">先存下素材，生成前再连接模型</h2>
          <p className="mt-1 text-[13px] leading-[1.6] text-[#6B6B6B]">已有题目时，不需要平台数据服务。连接模型并核对可用额度后继续生成；发布账号可以以后再设置。</p>
        </div>
        <Link
          href="/production?stage=1"
          className="inline-flex h-9 shrink-0 items-center justify-center gap-2 border border-[rgba(28,28,30,0.12)] bg-white px-3 text-[12px] font-bold text-[#1A1A1A] transition hover:border-[#E85D4C] hover:text-[#C94A3B]"
        >
          先整理素材
          <ArrowRight size={15} />
        </Link>
      </div>

      <div className="mt-4 grid border border-[rgba(28,28,30,0.1)] md:grid-cols-3">
        {setupItems.map((item, index) => {
          const Icon = item.icon;
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              className="group flex min-h-20 items-center gap-3 border-b border-[rgba(28,28,30,0.1)] px-3 py-3 transition hover:bg-[#FFF7F5] md:border-b-0 md:border-r last:border-b-0 md:last:border-r-0"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center bg-[#FDF3F0] text-[12px] font-bold text-[#E85D4C]">
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <Icon size={15} className="shrink-0 text-[#E85D4C]" />
                  <span className="text-[13px] font-bold text-[#1A1A1A]">{item.label}</span>
                  <span className="shrink-0 bg-[#F5EDE4] px-1.5 py-0.5 text-[12px] font-bold text-[#6B5543]">{item.requirement}</span>
                </span>
                <span className="mt-1 block text-[12px] leading-5 text-[#6B6B6B]">{item.detail}</span>
              </span>
            </a>
          );
        })}
      </div>
    </section>
  );
}
