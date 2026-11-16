import { getMaterialAnalysisContext, assertMaterialAnalysisCurrent, normalizeMaterialCorrection } from './material-analysis';
import { materialAnalysisFingerprint } from './material-analysis-version';
import { correctionDigest, materialCorrectionPath, readMaterialCorrection, readMaterialRecord, type MaterialCorrectionRecord } from './material-correction-record';
import { runtimeRunById } from './runtime-run-resolver';
import { applyRuntimeMaterialCorrection } from './runtime-writer';
import { withProjectWriteLock } from './write-guard';
import { KnownUserFacingError } from './user-facing-error';

function conflict(message = '本期整理结果已更新，请重新读取后核对修改。'): never {
  throw new KnownUserFacingError({ error: message, code: 'material_correction_conflict' }, { status: 409 });
}

export async function saveMaterialCorrection(input: { runId: string; id: string; expectedFingerprint: string; changes: unknown }) {
  materialCorrectionPath(input.runId, input.id);
  if (!/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) conflict('请先读取当前整理结果再修改。');
  return withProjectWriteLock(`material-analysis:${input.runId}`, async () => {
    const context = await getMaterialAnalysisContext(input.runId);
    if (!context) conflict('这期还没有整理结果，请先整理素材。');
    assertMaterialAnalysisCurrent(context);
    const analysis = normalizeMaterialCorrection(context.analysis, input.changes);
    let previous: MaterialCorrectionRecord | null = null;
    try { previous = await readMaterialCorrection(input.runId, input.id); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous) {
      if (previous.expected_fingerprint !== input.expectedFingerprint || JSON.stringify(previous.analysis) !== JSON.stringify(analysis)) conflict('同一次保存不能换成另一组修改，请重新读取后保存。');
    } else if (materialAnalysisFingerprint(context) !== input.expectedFingerprint) conflict();
    const run = await runtimeRunById(input.runId);
    const raw = await readMaterialRecord(`sessions/material-analysis/${input.runId}.json`);
    const record: MaterialCorrectionRecord = previous || {
      schema: 'echo.material-correction.v1', run_id: input.runId, id: input.id,
      previous_id: run?.material_correction?.id || '', input_fingerprint: context.inputFingerprint,
      base_file_sha256: correctionDigest(raw), expected_fingerprint: input.expectedFingerprint,
      analysis, created_at: new Date().toISOString(),
    };
    try { await applyRuntimeMaterialCorrection(record); }
    catch { conflict('未能确认修正已保存。你的修改还在，可重试同一次保存；若版本已变化，请重新读取后核对。'); }
    const saved = await getMaterialAnalysisContext(input.runId);
    if (!saved || saved.correctionId !== input.id) conflict();
    return { context: saved, analysisFingerprint: materialAnalysisFingerprint(saved) };
  });
}
