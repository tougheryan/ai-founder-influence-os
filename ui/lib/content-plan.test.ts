import { describe, expect, it } from 'vitest';
import { attachContentPlan, contentPlanNeedsReview } from './content-plan';

describe('content plan binding', () => {
  const binding = { path: 'pipeline/blueprint/one.md', sha256: 'a'.repeat(64) };
  it('records the actual generation input and replaces any model-supplied binding', () => {
    const text = '<!-- echo-content-plan:{"path":"fake"} -->\n\n# 正文\n\n保留这句话。';
    const result = attachContentPlan(text, binding);
    expect(result).toContain(JSON.stringify(binding));
    expect(result).not.toContain('fake');
    expect(result.endsWith('# 正文\n\n保留这句话。')).toBe(true);
    expect(attachContentPlan(result, binding)).toBe(result);
  });
  it('rejects invalid bindings and requires review of unknown or obsolete plans', () => {
    expect(() => attachContentPlan('正文', { ...binding, path: '../plan.md' })).toThrow();
    expect(() => attachContentPlan('正文', { ...binding, sha256: '' })).toThrow();
    expect(contentPlanNeedsReview('outdated')).toBe(true);
    expect(contentPlanNeedsReview('unknown')).toBe(true);
    expect(contentPlanNeedsReview('current')).toBe(false);
    expect(contentPlanNeedsReview('retained')).toBe(false);
  });
});
