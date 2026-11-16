import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { redactLocalPaths } from '@/lib/project-root';
import {
  ContentRadarInputError,
  ContentRadarRuntimeError,
  parseContentRadarIndustry,
  parseContentRadarPlatform,
  readContentRadarComparison,
  readLatestContentRadar,
  runContentRadar,
} from '@/lib/content-radar';
import {
  assertJsonInputSize,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
} from '@/lib/input-limits';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';
import { userFacingErrorResponse } from '@/lib/user-facing-error';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    if (req.nextUrl.searchParams.get('view') === 'compare') {
      const industry = parseContentRadarIndustry(req.nextUrl.searchParams.get('industry') || '美妆行业');
      const comparison = await readContentRadarComparison(industry);
      return NextResponse.json(redactLocalPaths({ ok: true, comparison }));
    }
    const platform = parseContentRadarPlatform(req.nextUrl.searchParams.get('platform') || 'xiaohongshu');
    const radar = await readLatestContentRadar(platform);
    return NextResponse.json(redactLocalPaths({ ok: true, radar }));
  } catch (error) {
    const status = error instanceof ContentRadarInputError ? 400 : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法读取内容趋势，请重试。',
      code: 'content_radar_read_failed',
      status,
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    assertJsonInputSize(body, '内容雷达请求', MAX_AGENT_PAYLOAD_BYTES);
    const platform = parseContentRadarPlatform(body.platform);
    const radar = await withProjectWriteLock(`content-radar:${platform}`, () => runContentRadar({
      industry: body.industry,
      platform,
    }));
    return NextResponse.json(redactLocalPaths({ ok: true, radar }));
  } catch (error) {
    const status = error instanceof ContentRadarInputError || error instanceof InputLimitError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : error instanceof ContentRadarRuntimeError
          ? 424
          : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法更新内容趋势，请重试。',
      code: 'content_radar_refresh_failed',
      status,
    });
  }
}
