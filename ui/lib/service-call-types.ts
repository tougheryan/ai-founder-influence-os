import type { LLMUsage } from './llm-usage';

export type ServiceCallRecord = {
  id: string; runId: string; operation: string; provider: string; model: string;
  transport: 'stream' | 'completion';
  startedAt: string; completedAt: string | null;
  status: 'started' | 'completed' | 'failed' | 'interrupted';
  usage: LLMUsage;
  previousCallId: string | null;
};
export type ModelCallLimit = { maxCalls: number | null; revision: number; recordedCalls: number; remaining: number | null };
export type ServiceCallHistory = { runId: string; records: ServiceCallRecord[]; limit?: ModelCallLimit };

const operations: Record<string, string> = {
  'content-intake': '整理素材', 'content-validate': '核对选题', 'content-blueprint': '准备写作方案',
  'wechat-writer': '撰写公众号文章', 'content-package': '生成本期内容', 'content-audit': '检查文章',
  'content-prelaunch': '检查成品', 'content-review': '回看发布表现', 'content-revision': '按要求改稿',
  'self-archive': '整理创作记录', 'content-twin': '整理表达偏好',
};
export function serviceCallLabel(operation: string) { return operations[operation] || '本期模型处理'; }
export function serviceCallStatus(status: ServiceCallRecord['status']) {
  return { started: '结果尚未确认', completed: '已收到响应', failed: '未正常完成', interrupted: '结果未能确认' }[status];
}
