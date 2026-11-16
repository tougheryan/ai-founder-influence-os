import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import { InputLimitError } from '@/lib/input-limits';
import {
  parseTopicResearchBinding,
  readVerifiedTopicResearchSamples,
  TopicResearchAccessError,
} from '@/lib/topic-research';
import { redactLocalPaths } from '@/lib/project-root';

export const runtime = 'nodejs';

/**
 * Read-only research browser payload. The underlying helper first verifies the
 * immutable TikOmni snapshot and then exposes only normalized display fields.
 */
export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const binding = parseTopicResearchBinding({
      runId: req.nextUrl.searchParams.get('runId'),
      snapshotPath: req.nextUrl.searchParams.get('snapshotPath'),
      snapshotSha256: req.nextUrl.searchParams.get('snapshotSha256'),
    });
    const research = await readVerifiedTopicResearchSamples(binding);
    return NextResponse.json(redactLocalPaths({
      ok: true,
      requiredPlatforms: research.requiredPlatforms,
      totalSampleCount: research.totalSampleCount,
      groups: research.groups,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError
      ? 400
      : error instanceof TopicResearchAccessError
        ? 424
        : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法读取平台样本，请重试。',
      code: 'research_samples_read_failed',
      status,
    });
  }
}
