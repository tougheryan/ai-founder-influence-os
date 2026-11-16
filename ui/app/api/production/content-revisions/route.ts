import { ContentAttemptError } from '@/lib/content-attempts';
import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { adoptContentRevision, archiveContentRevision, createContentRevision, getContentRevision, getContentRevisionSource, listContentRevisions, scheduleContentRevision, saveRevisionToDraft, ContentRevisionError, type ContentRevision } from '@/lib/content-revisions';
import { assertJsonInputSize, assertOptionalTextInput, assertTextInput, InputLimitError, MAX_SHORT_TEXT_BYTES, MAX_TEXT_ARTIFACT_BYTES } from '@/lib/input-limits';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';
import { WriteLockError } from '@/lib/write-guard';
import type { ContentEditTarget } from '@/lib/content-editing';

export const runtime = 'nodejs';

function present(record: ContentRevision) {
  return Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'baseBody' && key !== 'ownerPid' && key !== 'planBody'));
}

function failure(error: unknown) {
  if (error instanceof ContentRevisionError || error instanceof ContentAttemptError || error instanceof InputLimitError) {
    return expectedUserFacingErrorResponse({ error: error.message, code: 'content_revision_input', status: error instanceof ContentRevisionError || error instanceof ContentAttemptError ? error.status : 400 });
  }
  return userFacingErrorResponse(error, {
    error: '暂时无法处理这次修改，原稿保留，请稍后再试。',
    code: 'content_revision_request_failed',
    status: error instanceof WriteLockError ? 409 : error instanceof SyntaxError ? 400 : 500,
  });
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const runId = assertTextInput(req.nextUrl.searchParams.get('runId'), '内容编号', MAX_SHORT_TEXT_BYTES);
    const id = req.nextUrl.searchParams.get('id');
    if (id) {
      const record = await getContentRevision(runId, id);
      if (!record) return NextResponse.json({ error: '找不到这次修改。' }, { status: 404 });
      if (record.status === 'queued') scheduleContentRevision(runId, id);
      return NextResponse.json({ revision: present(record) });
    }
    const path = req.nextUrl.searchParams.get('path');
    const recoveryId = req.nextUrl.searchParams.get('recoveryId') || undefined;
    const records = await listContentRevisions(runId);
    const source = path ? await getContentRevisionSource(runId, recoveryId) : null;
    for (const record of records) if (record.status === 'queued') scheduleContentRevision(runId, record.id);
    return NextResponse.json({ source, revisions: records.filter((record) => recoveryId ? record.recoveryId === recoveryId : !record.recoveryId).map(present) });
  } catch (error) { return failure(error); }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputLimitError('请提交修改要求。');
    assertJsonInputSize(body, '修改要求', MAX_TEXT_ARTIFACT_BYTES);
    const runId = assertTextInput(body.runId, '内容编号', MAX_SHORT_TEXT_BYTES);
    const id = assertTextInput(body.id, '修改编号', MAX_SHORT_TEXT_BYTES);
    if (body.action === 'save-draft') {
      return NextResponse.json({ revision: present(await saveRevisionToDraft(runId, id, body.expectedArchiveVersion ?? 0)) });
    }
    if (body.action === 'archive' || body.action === 'restore') {
      const record = await archiveContentRevision(runId, id, body.action === 'archive', body.expectedArchiveVersion);
      return NextResponse.json({ revision: present(record) });
    }
    if (body.action === 'adopt' || body.action === 'undo') {
      const record = await adoptContentRevision(runId, id, body.action === 'undo', body.expectedArchiveVersion === undefined ? 0 : body.expectedArchiveVersion);
      return NextResponse.json({ revision: present(record) });
    }
    if (body.action !== 'create') throw new InputLimitError('修改操作不受支持。');
    if (!['section', 'ending', 'selection', 'append'].includes(body.target?.scope)) throw new InputLimitError('请选择要修改的范围。');
    if (body.target?.endingParagraphs !== undefined && (body.target.scope !== 'ending'
      || !Number.isSafeInteger(body.target.endingParagraphs) || body.target.endingParagraphs <= 0)) {
      throw new InputLimitError('结尾段数需要是正整数，且只能用于修改结尾。');
    }
    if (body.target?.selectionOffset !== undefined && (body.target.scope !== 'selection'
      || !Number.isSafeInteger(body.target.selectionOffset) || body.target.selectionOffset < 0)) {
      throw new InputLimitError('原文位置需要是非负整数，且只能用于修改指定文字。');
    }
    const target: ContentEditTarget = {
      sectionId: assertTextInput(body.target?.sectionId, '修改位置', MAX_SHORT_TEXT_BYTES),
      scope: body.target?.scope,
      ...(body.target?.endingParagraphs !== undefined ? { endingParagraphs: body.target.endingParagraphs } : {}),
      ...(body.target?.selectionOffset !== undefined ? { selectionOffset: body.target.selectionOffset } : {}),
      ...(body.target?.scope === 'selection' ? { selection: assertTextInput(body.target.selection, '选中原文', MAX_TEXT_ARTIFACT_BYTES) } : {}),
    };
    const record = await createContentRevision({
      runId, id, target,
      ...(body.planBinding !== undefined ? { planBinding: body.planBinding } : {}),
      materialCorrectionId: assertOptionalTextInput(body.materialCorrectionId, '素材修正版本', MAX_SHORT_TEXT_BYTES) || '',
      recoveryId: assertOptionalTextInput(body.recoveryId, '失败稿编号', MAX_SHORT_TEXT_BYTES) || undefined,
      basePath: assertTextInput(body.basePath, '原稿位置', MAX_SHORT_TEXT_BYTES),
      baseSha256: assertTextInput(body.baseSha256, '原稿版本', MAX_SHORT_TEXT_BYTES),
      mode: body.mode,
      instruction: assertOptionalTextInput(body.instruction, '修改要求', MAX_SHORT_TEXT_BYTES),
      replacement: assertOptionalTextInput(body.replacement, '修改文字', MAX_TEXT_ARTIFACT_BYTES),
    });
    if (record.status === 'queued') scheduleContentRevision(runId, id);
    return NextResponse.json({ revision: present(record) }, { status: 202 });
  } catch (error) { return failure(error); }
}
