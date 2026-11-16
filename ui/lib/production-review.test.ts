import { describe, expect, it } from 'vitest';
import {
  hasCompletedProductionReview,
  requiredProductionReviewAssertions,
} from './production-review';

describe('production review requirements', () => {
  it('requires explicit author-source review instead of claiming market research in author mode', () => {
    const common = { topic_boundary_and_goal_confirmed: true, brand_template_confirmed: true };
    expect(hasCompletedProductionReview('topic-template', { ...common, market_evidence_reviewed: true }, ['wechat'], 'author_material')).toBe(false);
    expect(hasCompletedProductionReview('topic-template', { ...common, author_source_reviewed: true }, ['wechat'], 'author_material')).toBe(true);
    expect(hasCompletedProductionReview('topic-template', { ...common, author_source_reviewed: true }, ['wechat'], 'platform')).toBe(false);
  });
  it('requires all topic review assertions before a frozen topic can advance', () => {
    expect(hasCompletedProductionReview('topic-template', {
      market_evidence_reviewed: true,
      topic_boundary_and_goal_confirmed: true,
    })).toBe(false);
    expect(hasCompletedProductionReview('topic-template', {
      market_evidence_reviewed: true,
      topic_boundary_and_goal_confirmed: true,
      brand_template_confirmed: true,
    })).toBe(true);
  });

  it('keeps the publication draft review separate from topic review', () => {
    expect(requiredProductionReviewAssertions('draft-information')).toEqual([
      'platform_payloads_reviewed',
      'visual_order_reviewed',
      'human_send_boundary_confirmed',
    ]);
    expect(hasCompletedProductionReview('draft-information', {
      platform_payloads_reviewed: true,
      visual_order_reviewed: true,
      human_send_boundary_confirmed: true,
    })).toBe(true);
  });

  it('requires a direct review of the article, both videos, and all three opinion posts', () => {
    expect(requiredProductionReviewAssertions('content-package')).toEqual([
      'content_article_reviewed',
      'content_video_1_reviewed',
      'content_video_2_reviewed',
      'content_opinion_1_reviewed',
      'content_opinion_2_reviewed',
      'content_opinion_3_reviewed',
    ]);
    expect(hasCompletedProductionReview('content-package', {
      content_article_reviewed: true,
      content_video_1_reviewed: true,
      content_video_2_reviewed: true,
      content_opinion_1_reviewed: true,
      content_opinion_2_reviewed: true,
    })).toBe(false);
    expect(hasCompletedProductionReview('content-package', {
      content_article_reviewed: true,
      content_video_1_reviewed: true,
      content_video_2_reviewed: true,
      content_opinion_1_reviewed: true,
      content_opinion_2_reviewed: true,
      content_opinion_3_reviewed: true,
    })).toBe(true);
  });
});
