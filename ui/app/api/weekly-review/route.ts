import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import {
  assertJsonInputSize,
  assertOptionalTextInput,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import {
  acknowledgeWeeklyReminder,
  applyWeeklyReviewMemory,
  collectWeeklyReview,
  completeWeeklyReview,
  getWeeklyReviewStatus,
  isWeeklyReviewRecordPath,
  saveWeeklyReviewMetrics,
  type WeeklyMetricsUpdate,
} from '@/lib/weekly-review';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

type WeeklyAction = 'collect' | 'save_metrics' | 'complete' | 'apply_memory' | 'acknowledge_reminder';

type WeeklyReviewRequest = {
  action?: unknown;
  recordPath?: unknown;
  updates?: unknown;
  humanConfirmed?: unknown;
};

function parseAction(value: unknown): WeeklyAction {
  const action = assertTextInput(value, '每周复盘操作', MAX_SHORT_TEXT_BYTES).trim();
  if (action === 'collect' || action === 'save_metrics' || action === 'complete' || action === 'apply_memory' || action === 'acknowledge_reminder') {
    return action;
  }
  throw new InputLimitError('每周复盘操作不受支持。');
}

function parseRecordPath(value: unknown): string {
  const recordPath = assertTextInput(value, '每周复盘记录路径', MAX_SHORT_TEXT_BYTES).trim();
  if (!isWeeklyReviewRecordPath(recordPath) || recordPath.includes('..') || recordPath.includes('\\')) {
    throw new InputLimitError('每周复盘记录路径不在允许的本地目录中。');
  }
  return recordPath;
}

function parseNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1_000_000_000_000) {
    throw new InputLimitError(`${label}必须是合理的非负数字。`);
  }
  return value;
}

function parseUpdates(value: unknown): WeeklyMetricsUpdate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputLimitError('关键指标输入必须是对象。');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 30) throw new InputLimitError('关键指标输入数量无效。');
  const updates: WeeklyMetricsUpdate = {};
  for (const [recordId, rawUpdate] of entries) {
    if (!/^publication_[a-f0-9]{20}$/.test(recordId)) {
      throw new InputLimitError('关键指标包含无效发布记录。');
    }
    if (!rawUpdate || typeof rawUpdate !== 'object' || Array.isArray(rawUpdate)) {
      throw new InputLimitError('关键指标条目格式无效。');
    }
    const raw = rawUpdate as { metrics?: unknown; comments?: unknown };
    const metrics: Record<string, number> = {};
    if (raw.metrics !== undefined) {
      if (!raw.metrics || typeof raw.metrics !== 'object' || Array.isArray(raw.metrics)) {
        throw new InputLimitError('指标必须是对象。');
      }
      const metricEntries = Object.entries(raw.metrics as Record<string, unknown>);
      if (metricEntries.length > 20) throw new InputLimitError('单条发布记录的指标过多。');
      for (const [metric, metricValue] of metricEntries) {
        if (!/^[a-z_]{2,40}$/.test(metric)) throw new InputLimitError('指标名无效。');
        metrics[metric] = parseNumber(metricValue, `指标 ${metric}`);
      }
    }
    const comments: string[] = [];
    if (raw.comments !== undefined) {
      if (!Array.isArray(raw.comments) || raw.comments.length > 10) {
        throw new InputLimitError('评论样本必须是不超过 10 条的列表。');
      }
      for (const item of raw.comments) {
        const comment = assertOptionalTextInput(item, '评论样本', 600)?.trim();
        if (comment) comments.push(comment);
      }
    }
    if (Object.keys(metrics).length === 0 && raw.comments === undefined) {
      throw new InputLimitError('请至少填写一个指标或评论样本。');
    }
    updates[recordId] = {
      ...(Object.keys(metrics).length ? { metrics } : {}),
      ...(raw.comments !== undefined ? { comments } : {}),
    };
  }
  return updates;
}

function assertHumanConfirmed(value: unknown): void {
  if (value !== true) throw new InputLimitError('写入长期学习前必须由操作者明确勾选确认。');
}

export async function GET() {
  try {
    await ensureProjectInitialized();
    let status;
    try {
      status = await getWeeklyReviewStatus(true);
    } catch {
      // A stale historical ledger must not make the workbench unavailable.
      // The read-only fallback still validates an existing current-week
      // record inside weekly_learning.py before returning it.
      status = await getWeeklyReviewStatus(false);
    }
    return NextResponse.json(redactLocalPaths(status));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取每周复盘，请重试。',
      code: 'weekly_review_read_failed',
      status: 500,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as WeeklyReviewRequest;
    assertJsonInputSize(body, '每周复盘请求', MAX_AGENT_PAYLOAD_BYTES);
    const action = parseAction(body.action);

    if (action === 'collect') {
      const result = await withProjectWriteLock('weekly-review:collect', collectWeeklyReview);
      return NextResponse.json(redactLocalPaths({ ok: true, action, ...result }));
    }

    const recordPath = parseRecordPath(body.recordPath);
    if (action === 'save_metrics') {
      const updates = parseUpdates(body.updates);
      const result = await withProjectWriteLock(
        `weekly-review:metrics:${recordPath}`,
        () => saveWeeklyReviewMetrics(recordPath, updates),
      );
      return NextResponse.json(redactLocalPaths({ ok: true, action, ...result }));
    }
    if (action === 'complete') {
      const result = await withProjectWriteLock(
        `weekly-review:complete:${recordPath}`,
        () => completeWeeklyReview(recordPath),
      );
      return NextResponse.json(redactLocalPaths({ ok: true, action, ...result }));
    }
    if (action === 'apply_memory') {
      assertHumanConfirmed(body.humanConfirmed);
      const result = await withProjectWriteLock(
        `weekly-review:memory:${recordPath}`,
        () => applyWeeklyReviewMemory(recordPath, true),
      );
      return NextResponse.json(redactLocalPaths({ ok: true, action, ...result }));
    }
    const result = await withProjectWriteLock(
      `weekly-review:reminder:${recordPath}`,
      () => acknowledgeWeeklyReminder(recordPath),
    );
    return NextResponse.json(redactLocalPaths({ ok: true, action, ...result }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : error instanceof WriteLockError ? 409 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法更新每周复盘，请重试。',
      code: 'weekly_review_update_failed',
      status,
    });
  }
}
