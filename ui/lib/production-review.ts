export const PRODUCTION_REVIEW_REQUIREMENTS = {
  'topic-template': [
    'market_evidence_reviewed',
    'topic_boundary_and_goal_confirmed',
    'brand_template_confirmed',
  ],
  'content-package': [
    'content_article_reviewed',
    'content_video_1_reviewed',
    'content_video_2_reviewed',
    'content_opinion_1_reviewed',
    'content_opinion_2_reviewed',
    'content_opinion_3_reviewed',
  ],
  'draft-information': [
    'platform_payloads_reviewed',
    'visual_order_reviewed',
    'human_send_boundary_confirmed',
  ],
} as const;

export type ProductionReviewStage = keyof typeof PRODUCTION_REVIEW_REQUIREMENTS;
export type ProductionReviewAssertion = (typeof PRODUCTION_REVIEW_REQUIREMENTS)[ProductionReviewStage][number] | 'author_source_reviewed';
export type ProductionReviewAssertions = Partial<Record<ProductionReviewAssertion, boolean>>;

export type TopicResearchEvidence = {
  reportPath: string;
  snapshotPath: string;
  snapshotSha256: string;
  status: string;
  sampleCount: number;
  queries: string[];
  requiredPlatforms: string[];
  readyPlatforms?: string[];
  partial?: boolean;
};

export function isProductionReviewStage(value: string): value is ProductionReviewStage {
  return Object.prototype.hasOwnProperty.call(PRODUCTION_REVIEW_REQUIREMENTS, value);
}

export function requiredProductionReviewAssertions(
  stage: ProductionReviewStage,
  selectedPlatforms?: readonly string[],
  researchMode?: string,
): readonly ProductionReviewAssertion[] {
  if (stage === 'topic-template' && researchMode === 'author_material') {
    return ['author_source_reviewed', 'topic_boundary_and_goal_confirmed', 'brand_template_confirmed'];
  }
  if (stage === 'content-package' && selectedPlatforms?.length) {
    return [
      ...(selectedPlatforms.includes('wechat') ? ['content_article_reviewed' as const] : []),
      ...(selectedPlatforms.some((platform) => platform === 'xhs' || platform === 'xiaohongshu') ? ['content_opinion_1_reviewed' as const] : []),
      ...(selectedPlatforms.includes('shipinhao') ? ['content_video_1_reviewed' as const] : []),
    ];
  }
  return PRODUCTION_REVIEW_REQUIREMENTS[stage];
}

export function hasCompletedProductionReview(
  stage: ProductionReviewStage,
  assertions: ProductionReviewAssertions | null | undefined,
  selectedPlatforms?: readonly string[],
  researchMode?: string,
): boolean {
  return requiredProductionReviewAssertions(stage, selectedPlatforms, researchMode).every((key) => assertions?.[key] === true);
}
