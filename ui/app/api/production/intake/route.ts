import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import {
  assertMaterialAnalysisCurrent,
  assertMaterialReadyForResearch,
  getMaterialAnalysisContext,
  MaterialAnalysisInputError,
  MaterialAnalysisStaleError,
  MaterialReadinessError,
} from '@/lib/material-analysis';
import { materialDirectionFor } from '@/lib/material-direction';
import { buildMaterialIntakeReport } from '@/lib/material-intake-report';
import { MATERIAL_INTAKE_FAILURES } from '@/lib/material-intake-errors';
import { assertJsonInputSize, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';
import { listRuntimeRuns } from '@/lib/runtime-run-resolver';
import { RuntimeOutputValidationError, writeValidatedRuntimeOutput } from '@/lib/runtime-writer';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { KnownUserFacingError, userFacingErrorResponse } from '@/lib/user-facing-error';
import { inspectGeneratedLanguage } from '@/lib/product-voice';

function intakeError(code: keyof typeof MATERIAL_INTAKE_FAILURES, detail?: unknown): KnownUserFacingError {
  return new KnownUserFacingError({ code, error: MATERIAL_INTAKE_FAILURES[code] }, {
    status: code.startsWith('material_report_') ? 500 : 409,
    detail,
  });
}

async function currentMaterialIntake(runId: string) {
  const context = await getMaterialAnalysisContext(runId);
  if (!context) throw intakeError('material_analysis_missing');
  try {
    assertMaterialAnalysisCurrent(context);
    await assertMaterialReadyForResearch(context.input);
  } catch (error) {
    if (error instanceof MaterialAnalysisStaleError) throw intakeError('material_analysis_stale', error);
    if (error instanceof MaterialReadinessError) throw intakeError('material_source_unreadable', error);
    throw error;
  }
  const direction = context.selection || {
    materialTypeId: context.analysis.recommendedTypeId,
    structureId: context.analysis.recommendedStructureId,
  };
  if (!materialDirectionFor(direction.materialTypeId, direction.structureId)) {
    throw intakeError('material_direction_invalid');
  }
  const run = (await listRuntimeRuns()).find((item) => item.run_id === runId);
  if (!run || run.status === 'archived') throw intakeError('material_run_unavailable');
  return { context, slug: run.slug || runId };
}

/**
 * This endpoint persists the source-backed material boundary that the live
 * research gate consumes. It deliberately does not make a second hidden LLM
 * request: the source ledger and operator-selected direction are already
 * available from material analysis and are validated again below.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, '素材理解参数', MAX_AGENT_PAYLOAD_BYTES);
    const runId = assertTextInput(body.runId, '当前 runtime run ID', MAX_SHORT_TEXT_BYTES).trim();
    const result = await withProjectWriteLock(`material-analysis:${runId}`, async () => {
      const current = await currentMaterialIntake(runId);
      const report = buildMaterialIntakeReport(current.context);
      const languageReview = inspectGeneratedLanguage(report);
      if (languageReview.blocking.length > 0) {
        throw intakeError('material_report_language_blocked', languageReview.blocking);
      }
      const { path, validation } = await writeValidatedRuntimeOutput(
        'intake',
        current.slug,
        report,
        'production-material-analysis',
        runId,
      );
      return {
        path,
        validation,
        languageQuality: {
          status: languageReview.warnings.length ? 'review_required' : 'pass',
          warnings: languageReview.warnings.map((finding) => finding.message),
        },
      };
    });
    return NextResponse.json(redactLocalPaths({ ok: true, ...result }));
  } catch (error) {
    const cause = error instanceof RuntimeOutputValidationError
      ? intakeError('material_report_invalid', error.validation)
      : error;
    const status = error instanceof InputLimitError || error instanceof MaterialAnalysisInputError || error instanceof MaterialReadinessError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : 500;
    return userFacingErrorResponse(cause, {
      error: '暂时无法整理本期素材，请重试。',
      code: 'material_intake_failed',
      status,
    });
  }
}
