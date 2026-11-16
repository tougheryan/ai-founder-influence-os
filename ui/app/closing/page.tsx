import { Sparkles } from 'lucide-react';
import { redirect } from 'next/navigation';
import { connection } from 'next/server';

export default async function ClosingPage() {
  await connection();
  if (process.env.AIFIOS_ENABLE_DEMO_SURFACES !== '1') {
    redirect('/');
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-1 text-[13px] font-medium text-[#9A9A9A]">关于</p>
        <h1 className="text-[24px] font-bold text-[#1A1A1A]">把真实素材做成可以发布、可以复盘的内容</h1>
      </div>

      <div className="rounded-xl bg-[#1C1C1E] p-8 text-center md:p-12">
        <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-lg bg-[rgba(173,241,62,0.16)] text-[#52790C]">
          <Sparkles size={28} />
        </div>

        <p className="mx-auto max-w-3xl text-[16px] leading-[1.8] text-[#9A9A9A] md:text-[18px]">
          Echo Founder 用来整理个人知识、访谈、业务经验和日常记录。
          你可以从一份素材开始，完成选题、写作、配图、发布准备和复盘；每一步都由你确认。
        </p>
      </div>
    </div>
  );
}
