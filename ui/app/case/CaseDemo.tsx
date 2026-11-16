"use client";

import { useState } from "react";
import type { ComponentType } from "react";
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Layers3,
  MessageSquare,
  Smartphone,
  Sparkles,
} from "lucide-react";

const sourceSignals = [
  { label: "素材类型", value: "创始人访谈 + 主题分享" },
  { label: "主要问题", value: "AI 提高了写作速度，但个人判断没有留下" },
  { label: "可写角度", value: "写得更快以后，怎样留下自己的判断" },
  { label: "适合平台", value: "公众号 / 小红书" },
];

const systemMetrics = [
  { label: "选题角度", value: "3 个" },
  { label: "发布平台", value: "2 个" },
  { label: "素材依据", value: "完整" },
];

const breakdownItems = [
  {
    label: "公众号标题",
    value: "我用 AI 写了 100 篇内容后，真正留下来的不是效率",
    platform: "长文",
  },
  {
    label: "小红书封面",
    value: "用 AI 写内容 / 别只追求更快 / 要留下判断",
    platform: "图文",
  },
];

const platformOutputs = [
  {
    id: "wechat",
    icon: FileText,
    platform: "公众号",
    tag: "4000-6000 字",
    title: "我用 AI 写了 100 篇内容后，真正留下来的不是效率",
    excerpt:
      "上周在一场闭门访谈里，我被问到一个问题：用了这么多 AI 工具之后，你最大的变化是什么？",
    fullOutput:
      "上周在一场闭门访谈里，我被问到一个问题：用了这么多 AI 工具之后，你最大的变化是什么？我当时的第一反应是效率变高了，但说出口之前，我停了一下。真正的变化不是我写得更快，而是我开始意识到，过去很多判断都散落在聊天记录、会议纪要和临时灵感里。AI 可以帮我生成一篇文章，但如果每一次生成之后，观点、案例、表达偏好和用户反馈都没有留下，三个月后我还是在从零开始。",
    stats: ["从访谈开头", "个人反思", "具体做法"],
  },
  {
    id: "xhs",
    icon: Smartphone,
    platform: "小红书",
    tag: "3-4 张图",
    title: "用 AI 写内容，别只追求更快",
    excerpt:
      "AI 可以让你更快写完一篇内容，但真正值钱的是：你有没有留下自己的判断、案例和表达偏好。",
    fullOutput:
      "AI 可以让你更快写完一篇内容，但真正值钱的是：你有没有留下自己的判断、案例和表达偏好。不要只问这篇写得快不快，也要看看下次写作时能不能直接用上这次留下的资料。",
    stats: ["观点卡片", "短句表达", "适合收藏"],
  },
];

export default function CaseDemo() {
  const [activeOutputId, setActiveOutputId] = useState(platformOutputs[0].id);
  const activeOutput =
    platformOutputs.find((output) => output.id === activeOutputId) || platformOutputs[0];

  return (
    <div className="space-y-[18px]">
      <div className="flex flex-col gap-[8px]">
        <p className="text-[13px] font-semibold text-[#9A9A9A]">工作台</p>
        <div className="flex items-center gap-[10px]">
          <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-[rgba(232,93,76,0.1)] text-[#E85D4C]">
            <FileText size={18} strokeWidth={2.4} />
          </span>
          <h1 className="text-[25px] font-bold leading-tight text-[#1A1A1A]">
            案例展示
          </h1>
        </div>
        <p className="max-w-[880px] text-[14px] leading-[1.65] text-[#6B6B6B]">
          用一个完整样例展示素材如何被拆解成公众号和小红书两类表达。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-[16px] xl:grid-cols-[minmax(0,0.96fr)_minmax(0,1.04fr)]">
        <section
          className="rounded-[20px] border border-[rgba(28,28,30,0.08)] bg-white p-[18px] shadow-[0_8px_24px_rgba(28,28,30,0.04)]"
        >
          <div className="mb-[14px] flex items-center justify-between gap-[12px]">
            <div className="flex items-center gap-[10px]">
              <span className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-[rgba(232,93,76,0.09)] text-[#E85D4C]">
                <FileText size={19} />
              </span>
              <div>
                <div className="text-[16px] font-bold text-[#1A1A1A]">原始素材</div>
                <div className="mt-[2px] text-[12px] text-[#9A9A9A]">创始人访谈摘录</div>
              </div>
            </div>
            <span className="rounded-full bg-[#FDF8F3] px-[10px] py-[5px] text-[12px] font-semibold text-[#6B6B6B]">
              原始内容
            </span>
          </div>

          <p className="text-[15px] leading-[1.78] text-[#6B6B6B]">
            在一次闭门访谈里，主持人问创始人：「用了这么多 AI 工具之后，你最大的变化是什么？」他停了几秒说：不是写得更快，而是我开始意识到，过去很多判断都散落在聊天记录、会议纪要和临时灵感里。如果每次创作结束后，观点、案例、表达偏好和用户反馈都没有留下，三个月后我还是在从零开始。
          </p>

          <div className="mt-[16px] grid grid-cols-1 gap-[8px] md:grid-cols-2">
            {sourceSignals.map((signal) => (
              <div
                key={signal.label}
                className="rounded-[12px] border border-[rgba(28,28,30,0.07)] bg-[#FDF8F3] p-[11px]"
              >
                <div className="mb-[5px] text-[12px] font-semibold text-[#9A9A9A]">
                  {signal.label}
                </div>
                <div className="text-[13px] font-semibold leading-[1.45] text-[#1A1A1A]">
                  {signal.value}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section
          className="rounded-[20px] border border-[rgba(28,28,30,0.08)] bg-[#1C1C1E] p-[18px] shadow-[0_12px_30px_rgba(28,28,30,0.12)]"
        >
          <div className="mb-[14px] flex flex-col gap-[12px] sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-[10px]">
              <span className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-[rgba(244,162,97,0.22)] text-[#F4A261]">
                <MessageSquare size={19} />
              </span>
              <div>
                <div className="text-[16px] font-bold text-white">内容整理结果</div>
                <div className="mt-[2px] text-[12px] text-[#9A9A9A]">从素材中找出可以直接写的内容</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-[6px]">
              {systemMetrics.map((metric) => (
                <span
                  key={metric.label}
                  className="rounded-full border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.06)] px-[9px] py-[5px] text-[12px] font-semibold text-white"
                >
                  {metric.label} · {metric.value}
                </span>
              ))}
            </div>
          </div>

          <div className="space-y-[10px]">
            {breakdownItems.map((item) => (
              <div
                key={item.label}
                className="rounded-[16px] border border-[rgba(255,255,255,0.1)] bg-[rgba(255,255,255,0.055)] p-[14px]"
              >
                <div className="mb-[7px] flex items-center justify-between gap-[10px]">
                  <div className="text-[12px] font-semibold text-[#9A9A9A]">{item.label}</div>
                  <span className="rounded-full bg-[rgba(244,162,97,0.16)] px-[8px] py-[3px] text-[11px] font-semibold text-[#F4A261]">
                    {item.platform}
                  </span>
                </div>
                <div className="text-[15px] font-semibold leading-[1.55] text-white">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <div className="pt-[4px]">
        <div className="flex flex-col gap-[6px] sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-[24px] font-bold text-[#1A1A1A]">各平台内容</h2>
            <p className="mt-[5px] text-[14px] text-[#6B6B6B]">
              同一段素材会按公众号和小红书的阅读习惯分别改写。点击卡片查看全文。
            </p>
          </div>
          <div className="flex items-center gap-[7px] text-[13px] font-semibold text-[#E85D4C]">
            <Layers3 size={15} />
            1 个观点 · 2 个平台
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-[14px] xl:grid-cols-3">
        {platformOutputs.map((output) => (
          <PlatformCard
            key={output.id}
            id={output.id}
            icon={output.icon}
            platform={output.platform}
            tag={output.tag}
            title={output.title}
            excerpt={output.excerpt}
            stats={output.stats}
            active={activeOutputId === output.id}
            onSelect={() => setActiveOutputId(output.id)}
          />
        ))}
      </div>

      <section
        className="rounded-[20px] border border-[rgba(28,28,30,0.08)] bg-white p-[18px] shadow-[0_8px_24px_rgba(28,28,30,0.04)]"
        data-testid="case-output-preview"
      >
        <div className="mb-[12px] flex flex-col gap-[8px] sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-[10px]">
            <span className="flex h-[36px] w-[36px] items-center justify-center rounded-[11px] bg-[rgba(232,93,76,0.09)] text-[#E85D4C]">
              <Sparkles size={17} />
            </span>
            <div>
              <div className="text-[15px] font-bold text-[#1A1A1A]">内容预览</div>
              <div className="mt-[2px] text-[12px] text-[#9A9A9A]">当前选择：{activeOutput.platform}</div>
            </div>
          </div>
          <span className="inline-flex w-fit items-center gap-[6px] rounded-full bg-[#FDF8F3] px-[10px] py-[5px] text-[12px] font-semibold text-[#6B6B6B]">
            <CheckCircle2 size={14} className="text-[#22C55E]" />
            可以继续扩写
          </span>
        </div>
        <div className="rounded-[14px] bg-[#FDF8F3] p-[14px]">
          <h3 className="text-[18px] font-bold leading-[1.45] text-[#1A1A1A]">
            {activeOutput.title}
          </h3>
          <p className="mt-[10px] text-[14px] leading-[1.8] text-[#6B6B6B]">
            {activeOutput.fullOutput}
          </p>
        </div>
      </section>
    </div>
  );
}

interface PlatformCardProps {
  id: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  platform: string;
  tag: string;
  title: string;
  excerpt: string;
  stats: string[];
  active: boolean;
  onSelect: () => void;
}

function PlatformCard({
  id,
  icon: Icon,
  platform,
  tag,
  title,
  excerpt,
  stats,
  active,
  onSelect,
}: PlatformCardProps) {
  return (
    <button
      type="button"
      data-testid={`case-platform-card-${id}`}
      onClick={onSelect}
      className={`flex min-h-[340px] w-full flex-col rounded-[20px] border bg-white p-[16px] text-left shadow-[0_8px_24px_rgba(28,28,30,0.035)] transition ${
        active
          ? "border-[#E85D4C] shadow-[0_12px_32px_rgba(232,93,76,0.11)]"
          : "border-[rgba(28,28,30,0.08)] hover:border-[rgba(232,93,76,0.34)]"
      }`}
    >
      <div className="mb-[18px] flex items-center justify-between gap-[10px]">
        <div className="flex items-center gap-[10px]">
          <span className="flex h-[38px] w-[38px] items-center justify-center rounded-[12px] bg-[rgba(232,93,76,0.09)] text-[#E85D4C]">
            <Icon size={19} />
          </span>
          <span className="text-[16px] font-bold text-[#1A1A1A]">{platform}</span>
        </div>
        <span className="rounded-full border border-[rgba(28,28,30,0.08)] bg-[#FDF8F3] px-[10px] py-[5px] text-[12px] font-bold text-[#1A1A1A]">
          {tag}
        </span>
      </div>

      <h3 className="min-h-[58px] text-[19px] font-bold leading-[1.45] text-[#1A1A1A]">
        {title}
      </h3>

      <p className="mt-[12px] line-clamp-5 flex-1 text-[14px] leading-[1.75] text-[#6B6B6B]">
        {excerpt}
      </p>

      <div className="mt-[16px] flex flex-wrap gap-[7px]">
        {stats.map((stat) => (
          <span
            key={stat}
            className="rounded-full border border-[rgba(28,28,30,0.07)] bg-[#FDF8F3] px-[9px] py-[5px] text-[12px] text-[#6B6B6B]"
          >
            {stat}
          </span>
        ))}
      </div>

      <div className={`mt-[16px] flex items-center gap-[6px] text-[13px] font-semibold ${active ? "text-[#E85D4C]" : "text-[#9A9A9A]"}`}>
        查看全文
        <ArrowRight size={14} />
      </div>
    </button>
  );
}
