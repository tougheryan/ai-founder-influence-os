import { describe, expect, it } from 'vitest';
import {
  invalidateDownstreamApprovals,
  type RunApproval,
} from './production-state';

const approval = (
  scope: RunApproval['scope'],
  sha256 = scope.repeat(8).slice(0, 64),
): RunApproval => ({
  scope,
  runSlug: 'founder-content-run',
  version: 1,
  sha256,
  approvedAt: '2026-07-15T10:00:00.000Z',
  method: 'human_review',
});

describe('production approval state', () => {
  it('invalidates every downstream human decision after a content package hash changes', () => {
    const approvals = [
      approval('topic_template'),
      approval('content_package', 'a'.repeat(64)),
      approval('visual_assets'),
      approval('draft_information'),
      approval('publication_result'),
    ];

    const next = invalidateDownstreamApprovals(approvals, 'content_package', {
      at: '2026-07-15T11:00:00.000Z',
      reason: 'content_changed',
    });

    expect(next.find((item) => item.scope === 'topic_template')?.invalidatedAt).toBeUndefined();
    expect(next.find((item) => item.scope === 'content_package')?.invalidatedAt).toBeUndefined();
    expect(next.find((item) => item.scope === 'visual_assets')?.invalidationReason).toBe('content_changed');
    expect(next.find((item) => item.scope === 'draft_information')?.invalidationReason).toBe('content_changed');
    expect(next.find((item) => item.scope === 'publication_result')?.invalidationReason).toBe('content_changed');
  });

  it('does not mutate the material boundary because it is immutable run evidence', () => {
    const next = invalidateDownstreamApprovals([
      approval('topic_template'),
      approval('content_package'),
    ], 'topic_template', {
      at: '2026-07-15T11:00:00.000Z',
      reason: 'template_changed',
    });

    expect(next).toHaveLength(2);
    expect(next[0]?.invalidatedAt).toBeUndefined();
    expect(next[1]?.invalidationReason).toBe('template_changed');
  });
});
