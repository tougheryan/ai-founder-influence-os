import { describe, expect, it } from 'vitest';
import {
  AUTOMATION_STEPS,
  REQUIRED_HANDOFFS,
  getRuntimeStepBySkill,
  getRuntimeStepForStepId,
  getStepDefinition,
  getStepIdByOutputPath,
} from './pipeline-registry';

describe('default editorial automation', () => {
  it('uses the validate-to-blueprint main path and leaves angle/breakdown exploratory', () => {
    expect(AUTOMATION_STEPS).toEqual([1, 2, 4, 5, 6, 7]);
    expect(AUTOMATION_STEPS).not.toContain(3);
    expect(getStepDefinition(2)).toMatchObject({
      skill: 'content-blueprint',
      autoRunnable: true,
    });
    expect(getStepDefinition(3)).toMatchObject({
      autoRunnable: false,
    });
    expect(REQUIRED_HANDOFFS[4]).toEqual([2]);
    expect(REQUIRED_HANDOFFS[4]).not.toContain(3);
    expect(getStepIdByOutputPath('pipeline/blueprint/demo-blueprint.md')).toBe(2);
    expect(getStepIdByOutputPath('pipeline/angles/demo-angle.md')).toBe(3);
    expect(getStepIdByOutputPath('pipeline/breakdown/demo-breakdown.md')).toBe(3);
    expect(getRuntimeStepBySkill('content-blueprint')).toBe('blueprint');
  });

  it('hydrates grouped steps from their terminal production artifact', () => {
    expect(getRuntimeStepForStepId(2, {
      validate: 'pipeline/validate/topic-validate.md',
      blueprint: 'pipeline/blueprint/topic-blueprint.md',
    })).toBe('blueprint');
    expect(getRuntimeStepForStepId(4, {
      write: 'pipeline/final/topic-write.md',
      package: 'pipeline/package/topic-package.md',
    })).toBe('package');
    expect(getRuntimeStepForStepId(7, {
      prelaunch: 'pipeline/prelaunch/topic-prelaunch.md',
      compliance: 'pipeline/compliance/topic-compliance.md',
      audit: 'pipeline/audit/topic-audit.md',
    })).toBe('audit');
  });

  it('does not treat an intermediate grouped artifact as the completed group output', () => {
    expect(getRuntimeStepForStepId(2, {
      validate: 'pipeline/validate/topic-validate.md',
    })).toBe('blueprint');
    expect(getRuntimeStepForStepId(4, {
      write: 'pipeline/final/topic-write.md',
    })).toBe('package');
    expect(getRuntimeStepForStepId(7, {
      prelaunch: 'pipeline/prelaunch/topic-prelaunch.md',
      compliance: 'pipeline/compliance/topic-compliance.md',
    })).toBe('audit');
  });
});
