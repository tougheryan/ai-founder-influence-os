import { ScrollArea } from '@/components/ui/scroll-area';
import type { LogEntry } from '@/lib/types';

interface LogViewerProps {
  logs: LogEntry[];
}

export function LogViewer({ logs }: LogViewerProps) {
  if (logs.length === 0) return null;

  const levelColors = {
    info: 'text-[#6B6B6B]',
    warning: 'text-[#F4A261]',
    error: 'text-[#E85D4C]',
    success: 'text-[#22C55E]',
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-[rgba(28,28,30,0.08)] bg-white shadow-sm">
      <div className="border-b border-[rgba(28,28,30,0.08)] px-5 py-3 text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">
        运行日志
      </div>
      <ScrollArea className="h-48">
        <div className="space-y-1 p-5">
          {logs.map((log, idx) => (
            <div key={idx} className="flex gap-3 text-[14px]">
              <span className="whitespace-nowrap text-[#9A9A9A]">
                {new Date(log.time).toLocaleTimeString()}
              </span>
              <span className={`font-semibold ${levelColors[log.level]}`}>
                {log.level.toUpperCase()}
              </span>
              <span className="text-[#1A1A1A]">{log.message}</span>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
