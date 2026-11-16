import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelCallRecords } from './ProductionCallHistory';
import { ModelCallAction, ModelCallSummary } from './ModelCallAction';
import { newerCallHistory, verifiedCallHistory } from '@/hooks/useServiceCallHistory';
import { ProductionTaskPanel, type ProductionTaskPanelTask } from './ProductionStagePanel';
import { emptyLLMUsage } from '@/lib/llm-usage';
import type { ServiceCallRecord, ServiceCallHistory } from '@/lib/service-call-types';

const record: ServiceCallRecord = { id: `call_${'a'.repeat(32)}`, runId: 'run-a', operation: 'content-package', provider: 'openai', model: 'test-model', transport: 'stream', startedAt: '2026-09-18T10:00:00Z', completedAt: null, status: 'failed', usage: emptyLLMUsage(), previousCallId: null };

describe('cost information before a model action', () => {
  const history: ServiceCallHistory = { runId: 'run-a', records: [record], limit: { maxCalls: 3, revision: 2, recordedCalls: 1, remaining: 2 } };
  it('shows actual recorded requests, an explicit cap, remaining calls and unknown cost', () => {
    const html = renderToStaticMarkup(<ModelCallSummary limit={history.limit} pending={false} error="" />);
    expect(html).toContain('本期已记录 1 次'); expect(html).toContain('上限 3 次 · 剩余 2 次');
    expect(html).toContain('本次费用未知'); expect(html).toContain('一次生成可能包含多次请求');
    expect(html).not.toMatch(/免费|0 元/);
  });
  it('distinguishes unlimited, paused, exhausted and stale counts', () => {
    const paused = renderToStaticMarkup(<ModelCallSummary limit={{ maxCalls: 0, revision: 1, recordedCalls: 1, remaining: 0 }} pending={false} error="" />);
    expect(paused).toContain('上限 0 次'); expect(paused).toContain('手动改稿仍可使用');
    const unlimited = renderToStaticMarkup(<ModelCallSummary limit={{ maxCalls: null, revision: 0, recordedCalls: 1, remaining: null }} pending={false} error="" />);
    expect(unlimited).toContain('未设次数上限'); expect(unlimited).not.toContain('剩余');
    const stale = renderToStaticMarkup(<ModelCallSummary limit={history.limit} pending={false} error="本期调用次数暂时无法核对" />);
    expect(stale).toContain('上次读取'); expect(stale).toContain('role="alert"');
  });
  it('does not enable generation before the current run limit is read, or charge a local recovery', () => {
    const bound = renderToStaticMarkup(<ModelCallAction runId="run-a">{(unavailable) => <button disabled={unavailable}>生成</button>}</ModelCallAction>);
    expect(bound).toContain('正在核对调用次数'); expect(bound).toContain('<button disabled="">生成</button>');
    const local = renderToStaticMarkup(<ModelCallAction>{(unavailable) => <button disabled={unavailable}>查找已保存结果</button>}</ModelCallAction>);
    expect(local).toBe('<button>查找已保存结果</button>');
  });
  it('checks limits before retrying a model task, while allowing recovery of an existing result', () => {
    const task: ProductionTaskPanelTask = { taskId: 'task-a', kind: 'content-package', status: 'blocked', currentStep: null,
      steps: [], startedAt: '2026-09-30T10:00:00Z', updatedAt: '2026-09-30T10:00:00Z', retryMayCharge: true };
    const retry = renderToStaticMarkup(<ProductionTaskPanel runId="run-a" task={task} currentStageId="content-package" onRetry={() => {}} />);
    expect(retry).toContain('正在核对调用次数');
    expect(retry).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?从这里重试/);
    const recover = renderToStaticMarkup(<ProductionTaskPanel runId="run-a" task={{ ...task, error: { code: 'operation_outcome_unknown' } }} currentStageId="content-package" onRetry={() => {}} />);
    expect(recover).toContain('恢复已有结果');
    expect(recover).not.toContain('生成前的调用与费用');
    expect(recover).not.toContain('disabled=""');
  });
  it('rejects missing, wrong-run or inconsistent limit data instead of assuming unlimited', () => {
    expect(verifiedCallHistory(history, 'run-a')).toBe(history);
    for (const bad of [null, { ...history, runId: 'run-b' }, { ...history, limit: undefined },
      { ...history, limit: { ...history.limit, maxCalls: '3' } }, { ...history, limit: { ...history.limit, remaining: 9 } },
      { ...history, limit: { ...history.limit, recordedCalls: 0 } }, { ...history, limit: { ...history.limit, revision: -1 } }]) {
      expect(() => verifiedCallHistory(bad, 'run-a')).toThrow();
    }
  });
  it('cannot roll a saved cap or consumed call count back with a delayed read', () => {
    const old = { ...history, limit: { ...history.limit!, maxCalls: 9, revision: 1, remaining: 8 } };
    expect(newerCallHistory(history, old)).toBe(history);
    const consumed = { ...history, records: [record, record], limit: { ...history.limit!, recordedCalls: 2, remaining: 1 } };
    expect(newerCallHistory(consumed, history)).toBe(consumed);
    expect(newerCallHistory(history, consumed)).toBe(consumed);
    const other = { ...history, runId: 'run-b' };
    expect(newerCallHistory(history, other)).toBe(other);
  });
});
describe('honest per-article usage display', () => {
  it('does not equate an empty new ledger with no historical calls or zero cost', () => {
    const html = renderToStaticMarkup(<ModelCallRecords data={{ runId: 'run-a', records: [] }} />);
    expect(html).toContain('不代表历史上没有调用或没有费用');
    expect(html).toContain('费用未知'); expect(html).toContain('不能当作完整账单');
    expect(html).not.toContain('0 元');
  });
  it('preserves known zero separately from missing usage and never calls a service response an adopted article', () => {
    const html = renderToStaticMarkup(<ModelCallRecords data={{ runId: 'run-a', records: [{ ...record, status: 'completed', usage: { ...emptyLLMUsage(), outputTokens: 0 } }] }} />);
    expect(html).toContain('输入用量：未知'); expect(html).toContain('输出用量：0');
    expect(html).toContain('已收到响应'); expect(html).toContain('不等于文章已通过检查');
    expect(html).not.toContain('服务返回合计：0');
  });
  it('links separate repeated operations without inventing a retry or exposing a retry action', () => {
    const repeat = { ...record, id: `call_${'b'.repeat(32)}`, previousCallId: record.id, status: 'completed' as const };
    const html = renderToStaticMarkup(<ModelCallRecords data={{ runId: 'run-a', records: [repeat, record] }} />);
    expect(html).toContain(`href="#${record.id}"`); expect(html).toContain('不自动视为失败重试');
    expect(html).toContain('再次请求可能产生费用'); expect(html).not.toContain('<button');
  });
});
