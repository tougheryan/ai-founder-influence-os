/** Metadata records the input actually used for generation, never an inferred new plan. */
export type ContentPlanBinding = { path: string; sha256: string; material_correction_id?: string };
export type ContentPlanStatus = {
  status: 'current' | 'outdated' | 'unknown' | 'retained' | 'unavailable';
  package_path: string;
  blueprint_path: string;
  blueprint_sha256: string;
  source_blueprint_path?: string;
  source_blueprint_sha256?: string;
  reason: string;
  material_correction_id?: string;
};

export function attachContentPlan(body: string, binding: ContentPlanBinding): string {
  if (!/^pipeline\/blueprint\/[^/\\\s]+\.md$/.test(binding.path) || !/^[a-f0-9]{64}$/.test(binding.sha256)) {
    throw new Error('正文缺少可核对的写作方案版本。');
  }
  const clean = body.replace(/<!--\s*echo-content-plan:[\s\S]*?-->/g, '').trim();
  return `<!-- echo-content-plan:${JSON.stringify(binding)} -->\n\n${clean}`;
}

export function contentPlanNeedsReview(status: ContentPlanStatus['status']): boolean {
  return status === 'outdated' || status === 'unknown';
}
