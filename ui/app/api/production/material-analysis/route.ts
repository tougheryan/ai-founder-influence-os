import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { materialAnalysisFingerprint } from '@/lib/material-analysis-version';
import {
  assertMaterialAnalysisCurrent,
  assertMaterialReadyForResearch,
  clearMaterialAnalysisContext,
  createSourceBackedMaterialAnalysis,
  getMaterialAnalysisContext,
  getMaterialWritingRequirements,
  MaterialAnalysisConflictError,
  MaterialAnalysisInputError,
  MaterialAnalysisStaleError,
  MaterialReadinessError,
  resolveInspirationLinks,
  saveMaterialAnalysisContext,
  type MaterialAnalysisUpdate,
} from '@/lib/material-analysis';
import {
  assertJsonInputSize,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';
import {
  isTikOmniPlatformContentUrl,
  readTikOmniPlatformContent,
} from '@/lib/tikomni-content-link';
import { clearTikOmniContentLinkEvidence } from '@/lib/tikomni-content-link-evidence';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import {
  expectedUserFacingErrorResponse,
  KnownUserFacingError,
  userFacingErrorResponse,
} from '@/lib/user-facing-error';

function parseRunId(value: unknown): string {
  return assertTextInput(value, 'run ID', MAX_SHORT_TEXT_BYTES).trim();
}

function parseProjectId(value: unknown): string {
  const projectId = assertTextInput(value, '项目 ID', MAX_SHORT_TEXT_BYTES).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(projectId)) {
    throw new MaterialAnalysisInputError('项目 ID 格式不正确。');
  }
  return projectId;
}

function parseOptionalProjectId(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return parseProjectId(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function hasTikOmniPlatformLink(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.some((item) => {
    const url = typeof item === 'string'
      ? item
      : item && typeof item === 'object' && !Array.isArray(item)
        ? (item as Record<string, unknown>).url
        : '';
    return typeof url === 'string' && isTikOmniPlatformContentUrl(url);
  });
}

function parseInputFingerprint(value: unknown, label = '素材快照标识'): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const fingerprint = assertTextInput(value, label, MAX_SHORT_TEXT_BYTES).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new MaterialAnalysisInputError(`${label}格式不正确。`);
  }
  return fingerprint;
}

function parseMode(value: unknown): 'analyze' | 'invalidate' {
  if (value === undefined || value === null || value === '') return 'analyze';
  const mode = assertTextInput(value, '素材分析操作', MAX_SHORT_TEXT_BYTES).trim();
  if (mode === 'analyze' || mode === 'invalidate') return mode;
  throw new MaterialAnalysisInputError('素材分析操作不受支持。');
}

function materialInputMismatchResponse(runId: string, serverInputFingerprint?: string) {
  return NextResponse.json(redactLocalPaths({
    error: '本机素材输入已变更，旧的素材分析不能恢复。请重新分析当前输入。',
    code: 'MATERIAL_INPUT_MISMATCH',
    runId,
    ...(serverInputFingerprint ? { serverInputFingerprint } : {}),
  }), { status: 409 });
}

/**
 * The material page writes only session-scoped context here. It does not add a
 * pipeline artifact or a brain/archive record, so restarting a content run
 * does not turn exploratory material into a long-term knowledge asset.
 */
export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const search = new URL(req.url).searchParams;
    const runId = parseRunId(search.get('runId'));
    const inputFingerprint = parseInputFingerprint(search.get('inputFingerprint'));
    const context = await getMaterialAnalysisContext(runId);
    if (!context) {
      return expectedUserFacingErrorResponse({
        error: '本期还没有素材分析，请先整理素材。',
        code: 'material_analysis_not_found',
        status: 404,
      });
    }
    // Do not send an old server snapshot back into an edited local form.  The
    // client uses this conditional GET on reload before it adopts context.
    if (inputFingerprint && context.inputFingerprint !== inputFingerprint) {
      return materialInputMismatchResponse(runId, context.inputFingerprint);
    }
    return NextResponse.json(redactLocalPaths({ ok: true, context, editableAnalysis: { ...context.analysis, authorRequirements: getMaterialWritingRequirements(context) }, analysisFingerprint: materialAnalysisFingerprint(context) }));
  } catch (error) {
    const status = error instanceof InputLimitError || error instanceof MaterialAnalysisInputError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法读取本期素材分析，请重试。',
      code: 'material_analysis_read_failed',
      status,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, '素材分析参数', MAX_AGENT_PAYLOAD_BYTES);
    const runId = parseRunId(body.runId);
    const mode = parseMode(body.mode);
    const expectedInputFingerprint = parseInputFingerprint(body.expectedInputFingerprint);
    const expectedAnalysisFingerprint = parseInputFingerprint(body.expectedAnalysisFingerprint, '整理结果版本');
    const assertAnalysisRevision = (existing: Awaited<ReturnType<typeof getMaterialAnalysisContext>>) => {
      if (existing && hasOwn(body, 'analysis') && !expectedAnalysisFingerprint) {
        throw new KnownUserFacingError({ error: '请先读取当前整理结果，再保存修改，避免覆盖另一窗口的内容。', code: 'MATERIAL_ANALYSIS_VERSION_REQUIRED' }, { status: 409 });
      }
      if (expectedAnalysisFingerprint && materialAnalysisFingerprint(existing) !== expectedAnalysisFingerprint) {
        throw new KnownUserFacingError({ error: '本期整理结果已在其他窗口更新，请重新读取后核对修改。', code: 'MATERIAL_ANALYSIS_CONFLICT' }, { status: 409 });
      }
    };
    // Reject an obsolete edit before any reference request that may cost money,
    // and check again under the write lock after reference retrieval.
    if (hasOwn(body, 'analysis') || expectedAnalysisFingerprint) assertAnalysisRevision(await getMaterialAnalysisContext(runId));

    if (hasOwn(body, 'analysis') && await getMaterialAnalysisContext(runId)) {
      throw new KnownUserFacingError({ error: '请通过写作要求旁的“修改”或“调整素材分类与全部要求”保存修正，以便同时更新后续确认。', code: 'MATERIAL_CORRECTION_REQUIRED' }, { status: 409 });
    }

    // Keep the transport aliases narrow so the client can evolve from the
    // existing `materialText` and `uploadedFiles` state without duplicating
    // session data in the component layer.
    const update: MaterialAnalysisUpdate = {
      ...(hasOwn(body, 'rawMaterial') ? { rawMaterial: body.rawMaterial } : hasOwn(body, 'materialText') ? { rawMaterial: body.materialText } : {}),
      ...(hasOwn(body, 'files') ? { files: body.files } : hasOwn(body, 'uploadedFiles') ? { files: body.uploadedFiles } : {}),
      ...(hasOwn(body, 'links') ? { links: body.links } : {}),
      ...(hasOwn(body, 'analysis') ? { analysis: body.analysis } : {}),
      ...(hasOwn(body, 'analysisSource') ? { analysisSource: body.analysisSource } : hasOwn(body, 'analysis_source') ? { analysisSource: body.analysis_source } : {}),
      ...(hasOwn(body, 'selection')
        ? { selection: body.selection }
        : hasOwn(body, 'selectedTypeId') || hasOwn(body, 'selectedStructureId')
          ? { selection: {
            materialTypeId: body.selectedTypeId,
            structureId: body.selectedStructureId,
          } }
          : {}),
      ...(mode === 'invalidate' ? { invalidateAnalysis: true } : {}),
    };
    // Reference retrieval is best-effort and intentionally happens before the
    // short write lock. Each individual failure is persisted as `failed`, not
    // promoted to a blocker for the user's own text or files.
    const hasPlatformLink = mode === 'analyze'
      && hasOwn(update as Record<string, unknown>, 'links')
      && hasTikOmniPlatformLink(update.links);
    const projectId = hasPlatformLink ? parseProjectId(body.projectId) : '';
    const resolvedUpdate = mode === 'analyze' && hasOwn(update as Record<string, unknown>, 'links')
      ? {
        ...update,
        links: await resolveInspirationLinks(
          update.links,
          undefined,
          hasPlatformLink
            ? async (url) => {
              if (!isTikOmniPlatformContentUrl(url.toString())) return null;
              const content = await readTikOmniPlatformContent({
                projectId,
                runId,
                url: url.toString(),
              });
              if (!content) return null;
              return {
                title: content.title,
                // Material analysis keeps a bounded, run-scoped excerpt; the
                // compact UI preview comes from that same retained content.
                excerpt: content.detail,
                reader: 'tikomni' as const,
              };
            }
            : undefined,
        ),
      }
      : update;
    const hasInputUpdate = hasOwn(resolvedUpdate as Record<string, unknown>, 'rawMaterial')
      || hasOwn(resolvedUpdate as Record<string, unknown>, 'files')
      || hasOwn(resolvedUpdate as Record<string, unknown>, 'links');
    const hasSelectionUpdate = hasOwn(resolvedUpdate as Record<string, unknown>, 'selection');
    if (mode === 'invalidate') {
      if (!hasOwn(resolvedUpdate as Record<string, unknown>, 'rawMaterial')
        || !hasOwn(resolvedUpdate as Record<string, unknown>, 'files')
        || !hasOwn(resolvedUpdate as Record<string, unknown>, 'links')) {
        throw new MaterialAnalysisInputError('失效旧分析时必须提交当前完整的文字、文件与链接快照。');
      }
      if (hasSelectionUpdate) {
        throw new MaterialAnalysisInputError('素材输入已变更，不能同时沿用之前的系统判断。');
      }
    }
    const context = await withProjectWriteLock(`material-analysis:${runId}`, async () => {
      const existing = await getMaterialAnalysisContext(runId);
      assertAnalysisRevision(existing);
      if (expectedInputFingerprint && (!existing || existing.inputFingerprint !== expectedInputFingerprint)) {
        throw new MaterialAnalysisConflictError('本期素材已在其他窗口更新，旧分析不能继续使用。');
      }
      const saved = await saveMaterialAnalysisContext(runId, resolvedUpdate);
      if (mode === 'invalidate' || !hasInputUpdate) return saved;
      const analysis = await createSourceBackedMaterialAnalysis(saved.input);
      return saveMaterialAnalysisContext(runId, {
        analysis,
        analysisSource: 'heuristic',
        // The system owns this provisional direction. It is internal routing
        // metadata for research and may be revised after a topic is chosen;
        // the operator is no longer asked to confirm it as a hard gate.
        selection: hasSelectionUpdate
          ? resolvedUpdate.selection
          : {
            materialTypeId: analysis.recommendedTypeId,
            structureId: analysis.recommendedStructureId,
          },
      });
    });
    if (hasSelectionUpdate) {
      try {
        assertMaterialAnalysisCurrent(context);
        await assertMaterialReadyForResearch(context.input);
      } catch (error) {
        if (error instanceof MaterialReadinessError) {
          return expectedUserFacingErrorResponse({
            error: '素材还未准备好，请完成文字整理或音频转写后再继续。',
            code: 'material_not_ready',
            status: 422,
          });
        }
        throw error;
      }
    }
    return NextResponse.json(redactLocalPaths({ ok: true, context, editableAnalysis: { ...context.analysis, authorRequirements: getMaterialWritingRequirements(context) }, analysisFingerprint: materialAnalysisFingerprint(context) }));
  } catch (error) {
    const status = error instanceof MaterialReadinessError
      ? 422
      : error instanceof MaterialAnalysisConflictError
        || error instanceof MaterialAnalysisStaleError
        ? 409
      : error instanceof InputLimitError || error instanceof MaterialAnalysisInputError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : 500;
    const cause = error instanceof MaterialAnalysisConflictError
      ? new KnownUserFacingError({
        error: '本期素材已在其他窗口更新，请刷新后重新分析。',
        code: 'MATERIAL_INPUT_CONFLICT',
      }, { status: 409, detail: error })
      : error instanceof MaterialAnalysisStaleError
        ? new KnownUserFacingError({
          error: '素材输入已经变更，请重新分析当前内容。',
          code: 'MATERIAL_ANALYSIS_STALE',
        }, { status: 409, detail: error })
        : error;
    return userFacingErrorResponse(cause, {
      error: '暂时无法保存本期素材分析，请重试。',
      code: 'material_analysis_save_failed',
      status,
    });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const search = new URL(req.url).searchParams;
    const runId = parseRunId(search.get('runId'));
    const projectId = parseOptionalProjectId(search.get('projectId'));
    await withProjectWriteLock(`material-analysis:${runId}`, async () => {
      // This route is reached only for an explicit reset. Keep normal same-run
      // edits untouched, while removing the linked raw/normalized capture when
      // the UI supplied its exact project namespace.
      if (projectId) {
        await clearTikOmniContentLinkEvidence({ projectId, runId });
      }
      await clearMaterialAnalysisContext(runId);
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const status = error instanceof InputLimitError || error instanceof MaterialAnalysisInputError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法清除本期素材分析，请重试。',
      code: 'material_analysis_delete_failed',
      status,
    });
  }
}
