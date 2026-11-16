import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type TechnicalDetailsProps = {
  children: ReactNode;
  className?: string;
  summary?: string;
  testId?: string;
};

export function TechnicalDetails({
  children,
  className,
  summary = '技术详情',
  testId,
}: TechnicalDetailsProps) {
  return (
    <details
      data-testid={testId}
      className={cn(
        'group overflow-hidden rounded-xl border border-[rgba(28,28,30,0.08)] bg-white',
        className,
      )}
    >
      <summary className="cursor-pointer list-none px-4 py-3 text-[12px] font-semibold text-[#6B6B6B] transition-colors hover:text-[#1A1A1A] [&::-webkit-details-marker]:hidden">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden="true" className="text-[10px] transition-transform group-open:rotate-90">▶</span>
          {summary}
        </span>
      </summary>
      <div className="border-t border-[rgba(28,28,30,0.08)] px-4 py-3 text-[12px] leading-6 text-[#6B6B6B]">
        {children}
      </div>
    </details>
  );
}

export function TechnicalDetailList({
  items,
}: {
  items: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <dl className="grid gap-2 sm:grid-cols-[max-content_minmax(0,1fr)]">
      {items.map((item) => (
        <div className="contents" key={item.label}>
          <dt className="font-medium text-[#4B4743]">{item.label}</dt>
          <dd className="min-w-0 break-all font-mono text-[11px] text-[#77716B]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
