export function serviceRecordStatus(value: string | null | undefined): string {
  if (!value || value === 'pending') return '尚无记录';
  if (['ready', 'completed', 'success', 'already_collected'].includes(value)) return '已完成';
  if (['blocked', 'failed', 'error'].includes(value)) return '未完成';
  if (['running', 'queued'].includes(value)) return '记录为进行中';
  if (value === 'skipped') return '未执行';
  return '状态未知';
}

export function serviceRecordTime(value: string | null | undefined): string {
  if (!value) return '尚无时间记录';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(parsed);
}
