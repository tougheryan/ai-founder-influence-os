import { createHash } from 'node:crypto';
import type { MaterialAnalysisContext } from './material-analysis';

/** Input identity alone cannot detect an author's correction to the same text. */
export function materialAnalysisFingerprint(context: MaterialAnalysisContext | null): string {
  if (!context) return '';
  return createHash('sha256').update(JSON.stringify({
    runId: context.runId,
    correctionId: context.correctionId || '',
    inputFingerprint: context.inputFingerprint,
    analysisInputFingerprint: context.analysisInputFingerprint,
    analysisStatus: context.analysisStatus,
    input: context.input,
    source: context.analysis_source,
    analysis: context.analysis,
    selection: context.selection,
  })).digest('hex');
}
