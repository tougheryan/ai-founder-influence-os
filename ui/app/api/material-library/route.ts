import { saveProductionDraft } from '@/lib/production-drafts';
import { NextRequest, NextResponse } from 'next/server';
import { assertJsonInputSize, InputLimitError, MAX_AGENT_PAYLOAD_BYTES } from '@/lib/input-limits';
import {
  confirmRawMaterialArchive,
  getRawMaterialDashboard,
  getRawMaterialRecord,
  getRawMaterialDetail,
  updateRawMaterial,
  rawMaterialDraftInput,
  MaterialLibraryConflictError,
  ingestProductionMaterials,
  ingestRawMaterials,
  listRawMaterials,
  MaterialLibraryError,
  migrateLegacyRawMaterials,
  RAW_MATERIAL_CATEGORIES,
  reclassifyRawMaterial,
  undoAutoArchivedRawMaterial,
} from '@/lib/material-library';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import {
  expectedUserFacingErrorResponse,
  userFacingErrorResponse,
} from '@/lib/user-facing-error';

export const runtime = 'nodejs';

function optionalCategory(value: string | null) {
  if (!value) return undefined;
  if (!(RAW_MATERIAL_CATEGORIES as readonly string[]).includes(value)) {
    throw new MaterialLibraryError('素材分类筛选不受支持。');
  }
  return value as typeof RAW_MATERIAL_CATEGORIES[number];
}

function optionalLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new MaterialLibraryError('素材列表数量必须是整数。');
  return parsed;
}

function errorResponse(error: unknown, fallback: string) {
  const status = error instanceof MaterialLibraryConflictError ? 409 : error instanceof MaterialLibraryError || error instanceof InputLimitError
    ? 400
    : error instanceof WriteLockError
      ? 409
      : 500;
  return userFacingErrorResponse(error, {
    error: fallback,
    code: fallback.startsWith('读取') ? 'material_library_read_failed' : 'material_library_update_failed',
    status,
  });
}

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const view = req.nextUrl.searchParams.get('view') || 'dashboard';
    if (view === 'dashboard') {
      return NextResponse.json(redactLocalPaths(await getRawMaterialDashboard()));
    }
    if (view === 'materials') {
      return NextResponse.json(redactLocalPaths(await listRawMaterials({
        status: (req.nextUrl.searchParams.get('status') || 'all') as 'all' | 'archived' | 'pending_confirmation',
        category: optionalCategory(req.nextUrl.searchParams.get('category')),
        sort: (req.nextUrl.searchParams.get('sort') || 'recent') as 'recent' | 'priority',
        limit: optionalLimit(req.nextUrl.searchParams.get('limit')),
      })));
    }
    if (view === 'detail') {
      const detail = await getRawMaterialDetail(req.nextUrl.searchParams.get('id') || '');
      if (!detail) return expectedUserFacingErrorResponse({ error: '这条素材不存在。', code: 'material_not_found', status: 404 });
      return NextResponse.json(redactLocalPaths(detail));
    }
    if (view === 'record') {
      const id = req.nextUrl.searchParams.get('id') || '';
      const item = await getRawMaterialRecord(id);
      if (!item) {
        return expectedUserFacingErrorResponse({
          error: '这条素材不存在，可能已被删除。',
          code: 'material_not_found',
          status: 404,
        });
      }
      return NextResponse.json(redactLocalPaths({ item }));
    }
    throw new MaterialLibraryError('个人库视图不受支持。');
  } catch (error) {
    return errorResponse(error, '暂时无法读取个人库，请重试。');
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, '个人库操作参数', MAX_AGENT_PAYLOAD_BYTES);
    const action = typeof body.action === 'string' ? body.action : '';
    const payload = await withProjectWriteLock('material-library', async () => {
      if (action === 'edit') return { ok: true, ...(await updateRawMaterial({ id: body.id, expectedVersion: body.expectedVersion, title: body.title, content: body.content, sourceLabel: body.sourceLabel, sourceUrl: body.sourceUrl })) };
      if (action === 'reuse') {
        const input = await rawMaterialDraftInput(String(body.id || ''), body.expectedVersion, body.requestId, { mode: body.mode, topic: body.topic });
        const draft = await saveProductionDraft(input);
        return { ok: true, draftId: draft.id, nextUrl: `/production?openDraft=${draft.id}` };
      }
      if (action === 'ingest') {
        return { ok: true, ...(await ingestRawMaterials({ items: body.items })) };
      }
      if (action === 'ingest-production') {
        return {
          ok: true,
          ...(await ingestProductionMaterials({ runId: body.runId, artifacts: body.artifacts })),
        };
      }
      if (action === 'confirm') {
        return {
          ok: true,
          items: await confirmRawMaterialArchive({ ids: body.ids, categoryById: body.categoryById }),
        };
      }
      if (action === 'reclassify') {
        return { ok: true, item: await reclassifyRawMaterial({ id: body.id, category: body.category }) };
      }
      if (action === 'undo-auto-archive') {
        return { ok: true, item: await undoAutoArchivedRawMaterial(body.id) };
      }
      if (action === 'migrate-legacy') {
        return { ok: true, ...(await migrateLegacyRawMaterials()) };
      }
      throw new MaterialLibraryError('个人库操作不受支持。');
    });
    return NextResponse.json(redactLocalPaths(payload));
  } catch (error) {
    return errorResponse(error, '暂时无法更新个人库，请重试。');
  }
}
