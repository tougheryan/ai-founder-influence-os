import { describe, expect, it } from 'vitest';
import { PRODUCTION_STATUS_DISPLAY_NAMES } from '@/lib/product-copy';

describe('production status copy contract', () => {
  it('uses only the five user-facing states across tasks and publication bridges', () => {
    expect(PRODUCTION_STATUS_DISPLAY_NAMES).toEqual({
      queued: '未开始',
      running: '进行中',
      completed: '已完成',
      failed: '失败',
      blocked: '待你确认',
      pending: '未开始',
      skipped: '已完成',
      draft_filled: '已完成',
      retryable_failure: '失败',
      manual_intervention_required: '待你确认',
      unknown_completion: '待你确认',
      published_confirmed: '已完成',
      authorizing: '进行中',
    });
    expect(new Set(Object.values(PRODUCTION_STATUS_DISPLAY_NAMES))).toEqual(new Set([
      '未开始',
      '进行中',
      '待你确认',
      '已完成',
      '失败',
    ]));
  });
});
