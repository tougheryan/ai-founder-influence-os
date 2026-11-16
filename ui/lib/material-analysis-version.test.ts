import { describe, expect, it } from 'vitest';
import type { MaterialAnalysisContext } from './material-analysis';
import { materialAnalysisFingerprint } from './material-analysis-version';

const context: MaterialAnalysisContext = {
  schema: 'aifios.material-analysis.v1', runId: 'run-a', createdAt: 'first', updatedAt: 'latest',
  inputFingerprint: 'a'.repeat(64), analysisInputFingerprint: 'a'.repeat(64), analysisStatus: 'current',
  analysis_source: 'manual', input: { rawMaterial: '原始记录保留', files: [], links: [] },
  analysis: { summary: '整理结果', facts: ['三个人'], opinions: ['先确认范围'], cases: [], risks: ['不公开客户名称'], authorRequirements: ['结尾不引导私信'], recommendedTypeId: 'business-growth', recommendedStructureId: 'customer-question-method' },
  selection: null,
};

describe('material analysis version identity', () => {
  it.each(['facts', 'opinions', 'cases', 'risks', 'authorRequirements'] as const)('detects a correction to %s even when original input is unchanged', (key) => {
    const changed = { ...context, analysis: { ...context.analysis, [key]: ['作者已修正'] } };
    expect(changed.inputFingerprint).toBe(context.inputFingerprint);
    expect(materialAnalysisFingerprint(changed)).not.toBe(materialAnalysisFingerprint(context));
  });
  it('does not expire a generation just because a read or identical save changed its timestamp', () => {
    expect(materialAnalysisFingerprint({ ...context, updatedAt: 'later' })).toBe(materialAnalysisFingerprint(context));
  });
  it('binds to the run, editorial selection and stale/current state', () => {
    for (const patch of [
      { runId: 'run-b' }, { analysisStatus: 'stale' as const },
      { selection: { materialTypeId: 'business-growth' as const, structureId: 'customer-question-method' } },
    ]) expect(materialAnalysisFingerprint({ ...context, ...patch })).not.toBe(materialAnalysisFingerprint(context));
    expect(materialAnalysisFingerprint(null)).not.toBe(materialAnalysisFingerprint(context));
  });
});
