import { NextRequest, NextResponse } from 'next/server';
import { getCreativeLibraryOverview } from '@/lib/creative-library';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

function parseLimit(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return undefined;
  return parsed;
}

/** Returns the compact data needed by the four creative-library tabs. */
export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    return NextResponse.json(redactLocalPaths(await getCreativeLibraryOverview({
      scriptsLimit: parseLimit(req.nextUrl.searchParams.get('scriptsLimit')),
    })));
  } catch (error) {
    return userFacingErrorResponse(error, {
      error: '暂时无法读取个人库，请重试。',
      code: 'creative_library_read_failed',
      status: 500,
    });
  }
}
