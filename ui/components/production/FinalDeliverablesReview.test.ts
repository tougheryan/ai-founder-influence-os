import { describe, expect, it } from 'vitest';

import {
  displayDeliverableError,
  hasReviewedEveryDeliverableGroup,
} from './FinalDeliverablesReview';

describe('FinalDeliverablesReview error copy', () => {
  it('naturalizes safe compatibility errors', () => {
    expect(displayDeliverableError('三类成品的内容包还没有准备好。请返回上一步。'))
      .toBe('发布成品的全部内容还没有准备好。请返回上一步。');
  });

  it('does not render paths, hashes, stacks, tokens or raw JSON', () => {
    const message = displayDeliverableError(
      'failed /Users/alice/private.md hash=0123456789abcdef0123456789abcdef {"token":"secret"}',
    );
    expect(message).toBe('发布成品没有读取成功。请重新生成后再试。');
    expect(message).not.toMatch(/alice|hash|token|secret|\{|failed/i);
  });
});

describe('FinalDeliverablesReview progress', () => {
  const required = ['article', 'social-cards', 'video-scripts'] as const;

  it('requires every visible deliverable group before the single confirmation', () => {
    expect(hasReviewedEveryDeliverableGroup(['article', 'social-cards'], required)).toBe(false);
    expect(hasReviewedEveryDeliverableGroup(required, required)).toBe(true);
  });

  it('does not report completion when no deliverable group exists', () => {
    expect(hasReviewedEveryDeliverableGroup([], [])).toBe(false);
  });
});
