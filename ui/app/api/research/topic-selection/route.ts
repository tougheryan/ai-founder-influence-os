import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import {
  assertJsonInputSize,
  assertOptionalTextInput,
  assertTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';
import { setRuntimeRunTopic } from '@/lib/runtime-writer';
import {
  assertVerifiedTopicResearchBinding,
  parseTopicResearchBinding,
  TopicResearchAccessError,
} from '@/lib/topic-research';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';

export const runtime = 'nodejs';

function parseTopic(value: unknown): string {
  const topic = assertTextInput(value, '本期主题', MAX_SHORT_TEXT_BYTES).replace(/\s+/g, ' ').trim();
  if (!topic || topic.length > 240) throw new InputLimitError('本期主题不能为空且不能超过 240 个字符。');
  return topic;
}

function parseSuggestionId(value: unknown): string | undefined {
  const suggestionId = assertOptionalTextInput(value, '主题建议标识', MAX_SHORT_TEXT_BYTES)?.trim();
  if (!suggestionId) return undefined;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(suggestionId)) {
    throw new InputLimitError('主题建议标识格式不正确。');
  }
  return suggestionId;
}

/**
 * Writes a chosen or manually edited title back to the current run. The route
 * does not create a replacement run and only accepts the already verified
 * snapshot that powered this suggestion page.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, '主题确认参数', MAX_AGENT_PAYLOAD_BYTES);
    const binding = parseTopicResearchBinding({
      runId: body.runId,
      snapshotPath: body.snapshotPath,
      snapshotSha256: body.snapshotSha256,
    });
    const topic = parseTopic(body.topic);
    const suggestionId = parseSuggestionId(body.suggestionId);
    const verified = await assertVerifiedTopicResearchBinding(binding);
    const result = await withProjectWriteLock(`topic-selection:${verified.runId}`, () => (
      setRuntimeRunTopic({
        runId: verified.runId,
        topic,
        snapshotPath: verified.snapshotPath,
        snapshotSha256: verified.snapshotSha256,
        ...(suggestionId ? { suggestionId } : {}),
      })
    ));
    if (result.run_id !== verified.runId || result.topic !== topic || !result.slug) {
      throw new TopicResearchAccessError('主题确认没有安全写入当前内容任务。');
    }
    return NextResponse.json(redactLocalPaths({
      ok: true,
      runId: result.run_id,
      runSlug: result.slug,
      topic: result.topic,
      changed: result.changed === true,
      snapshotPath: result.market_snapshot_path,
      snapshotSha256: result.market_snapshot_sha256,
      ...(result.suggestion_id ? { suggestionId: result.suggestion_id } : {}),
    }));
  } catch (error) {
    const status = error instanceof InputLimitError
      ? 400
      : error instanceof TopicResearchAccessError
        ? 424
        : error instanceof WriteLockError
          ? 409
          : 500;
    return userFacingErrorResponse(error, {
      error: '暂时无法保存本期主题，请重试。',
      code: 'topic_selection_save_failed',
      status,
    });
  }
}
