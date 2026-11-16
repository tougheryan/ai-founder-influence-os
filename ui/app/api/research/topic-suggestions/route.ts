import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { userFacingErrorResponse } from '@/lib/user-facing-error';
import {
  assertJsonInputSize,
  assertOptionalTextInput,
  InputLimitError,
  MAX_AGENT_PAYLOAD_BYTES,
  MAX_SHORT_TEXT_BYTES,
} from '@/lib/input-limits';
import { PROJECT_DIR, contentRuntimeToolPath, redactLocalPaths } from '@/lib/project-root';
import { runtimePythonBinary } from '@/lib/runtime-binary';
import {
  assertVerifiedTopicResearchBinding,
  parseTopicResearchBinding,
  TopicResearchAccessError,
  type VerifiedTopicResearchBinding,
} from '@/lib/topic-research';
import {
  readIdempotentResult,
  rememberIdempotentResult,
  withProjectWriteLock,
  writeFingerprint,
  WriteLockError,
} from '@/lib/write-guard';

export const runtime = 'nodejs';

const execFileAsync = promisify(execFile);
const TOPIC_SUGGESTIONS_SCRIPT = contentRuntimeToolPath('topic_suggestions.py');
const SUGGESTION_COUNT = 3;
const TOPIC_SUGGESTIONS_CACHE_TTL_MS = 60 * 60 * 1000;

type TopicSuggestion = {
  id: string;
  title: string;
  reason: string;
  audience: string;
  score: number;
  marketMechanism: string;
  materialEvidence: string;
  risk: string;
};

type SuggestionCacheMode = 'prewarm' | 'retrieve';

type CachedTopicSuggestions = {
  runId: string;
  snapshotPath: string;
  snapshotSha256: string;
  sourcePath: string;
  suggestions: TopicSuggestion[];
};

function compact(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, Math.max(0, max - 3)).trim()}...` : text;
}

function asSuggestion(value: unknown, index: number): TopicSuggestion | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = compact(row.id, 64);
  const title = compact(row.title, 160);
  if (!id || !title) return null;
  const score = typeof row.score === 'number' && Number.isFinite(row.score) ? Math.max(0, Math.min(100, Math.round(row.score))) : 0;
  return {
    id: /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : `topic-${index + 1}`,
    title,
    reason: compact(row.reason, 240),
    audience: compact(row.audience, 160),
    score,
    marketMechanism: compact(row.market_mechanism ?? row.marketMechanism, 100) || '痛点开头',
    materialEvidence: compact(row.material_evidence ?? row.materialEvidence, 200),
    risk: compact(row.risk, 200),
  };
}

function hasCompleteSuggestionSet(suggestions: readonly TopicSuggestion[]): boolean {
  if (suggestions.length > SUGGESTION_COUNT) return false;
  const ids = new Set(suggestions.map((item) => item.id));
  const titles = new Set(suggestions.map((item) => item.title));
  return ids.size === suggestions.length && titles.size === suggestions.length;
}

function assertCompleteSuggestionSet(suggestions: TopicSuggestion[]): TopicSuggestion[] {
  if (suggestions.length > SUGGESTION_COUNT) {
    throw new TopicResearchAccessError('本期最多展示三条有素材依据的选题建议。');
  }
  if (!hasCompleteSuggestionSet(suggestions)) {
    throw new TopicResearchAccessError('选题建议不能重复。');
  }
  return suggestions;
}

function cachedSuggestionsForBinding(
  value: unknown,
  binding: VerifiedTopicResearchBinding,
): TopicSuggestion[] | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cached = value as Partial<CachedTopicSuggestions>;
  if (
    cached.runId !== binding.runId
    || cached.snapshotPath !== binding.snapshotPath
    || cached.snapshotSha256 !== binding.snapshotSha256
    || cached.sourcePath !== binding.sourcePath
    || !Array.isArray(cached.suggestions)
  ) {
    return null;
  }
  const suggestions = cached.suggestions.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
    return asSuggestion(item, index);
  }).filter((item): item is TopicSuggestion => Boolean(item));
  return suggestions.length === cached.suggestions.length && hasCompleteSuggestionSet(suggestions) ? suggestions : null;
}

function topicSuggestionsCacheKey(binding: VerifiedTopicResearchBinding): string {
  return writeFingerprint('topic-suggestions-v3', {
    runId: binding.runId,
    snapshotPath: binding.snapshotPath,
    snapshotSha256: binding.snapshotSha256,
    sourcePath: binding.sourcePath,
  });
}

async function readCachedSuggestions(
  cacheKey: string,
  binding: VerifiedTopicResearchBinding,
): Promise<TopicSuggestion[] | null> {
  const cached = await readIdempotentResult<CachedTopicSuggestions>(
    cacheKey,
    async (value) => cachedSuggestionsForBinding(value, binding) !== null,
    TOPIC_SUGGESTIONS_CACHE_TTL_MS,
  );
  return cached ? cachedSuggestionsForBinding(cached, binding) : null;
}

async function getOrBuildCachedSuggestions(
  binding: VerifiedTopicResearchBinding,
): Promise<{ suggestions: TopicSuggestion[]; cacheStatus: 'hit' | 'built' }> {
  const cacheKey = topicSuggestionsCacheKey(binding);
  const cached = await readCachedSuggestions(cacheKey, binding);
  if (cached) return { suggestions: cached, cacheStatus: 'hit' };

  return withProjectWriteLock(`topic-suggestions:${cacheKey}`, async () => {
    // A concurrent prewarm may have completed while this request was waiting.
    const lockedCached = await readCachedSuggestions(cacheKey, binding);
    if (lockedCached) return { suggestions: lockedCached, cacheStatus: 'hit' as const };

    const suggestions = await buildSuggestions(binding);
    await rememberIdempotentResult<CachedTopicSuggestions>(cacheKey, {
      runId: binding.runId,
      snapshotPath: binding.snapshotPath,
      snapshotSha256: binding.snapshotSha256,
      sourcePath: binding.sourcePath,
      suggestions,
    });
    return { suggestions, cacheStatus: 'built' as const };
  });
}

function parseSuggestionCacheMode(value: unknown): SuggestionCacheMode | undefined {
  const mode = assertOptionalTextInput(value, '主题建议缓存模式', MAX_SHORT_TEXT_BYTES)?.trim();
  if (!mode) return undefined;
  if (mode === 'prewarm' || mode === 'retrieve') return mode;
  throw new InputLimitError('主题建议缓存模式仅支持 prewarm 或 retrieve。');
}

function outputError(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stdout' in error)) return '';
  const stdout = (error as { stdout?: unknown }).stdout;
  return typeof stdout === 'string' ? stdout : '';
}

async function buildSuggestions(input: {
  runId: string;
  snapshotPath: string;
  snapshotSha256: string;
  sourcePath: string;
}): Promise<TopicSuggestion[]> {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(runtimePythonBinary(), [
      TOPIC_SUGGESTIONS_SCRIPT,
      '--project', PROJECT_DIR,
      '--run-id', input.runId,
      '--snapshot', input.snapshotPath,
      '--snapshot-sha256', input.snapshotSha256,
      '--source', input.sourcePath,
    ], {
      cwd: PROJECT_DIR,
      maxBuffer: 1024 * 1024 * 2,
      timeout: 20_000,
    }));
  } catch (error) {
    stdout = outputError(error);
    if (!stdout.trim()) throw error;
  }
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid payload');
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new TopicResearchAccessError('主题建议生成器没有返回可读取结果。');
  }
  if (payload.ok === false) {
    throw new TopicResearchAccessError(compact(payload.error, 300) || '主题建议无法绑定当前 TikOmni 研究快照。');
  }
  if (!Array.isArray(payload.suggestions)) {
    throw new TopicResearchAccessError('选题建议结果暂时无法读取。');
  }
  const suggestions = payload.suggestions.map(asSuggestion).filter((item): item is TopicSuggestion => Boolean(item));
  if (suggestions.length !== payload.suggestions.length) {
    throw new TopicResearchAccessError('选题建议结果暂时无法读取。');
  }
  return assertCompleteSuggestionSet(suggestions);
}

/**
 * Generates up to three material-supported suggestions from a pre-verified snapshot, current
 * intake, and optional session-only material context. Explicit `prewarm` and
 * `retrieve` modes share an exact run/snapshot/hash-bound cache. It never
 * invokes a new TikOmni fetch, so source outages cannot be silently hidden.
 */
export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    assertJsonInputSize(body, '主题建议参数', MAX_AGENT_PAYLOAD_BYTES);
    const mode = parseSuggestionCacheMode(body.mode);
    const binding = parseTopicResearchBinding({
      runId: body.runId,
      snapshotPath: body.snapshotPath,
      snapshotSha256: body.snapshotSha256,
    });
    const verified = await assertVerifiedTopicResearchBinding(binding);
    if (!mode) {
      const suggestions = await buildSuggestions(verified);
      return NextResponse.json(redactLocalPaths({
        ok: true,
        suggestionCount: suggestions.length,
        suggestions,
      }));
    }

    const { suggestions, cacheStatus } = await getOrBuildCachedSuggestions(verified);
    return NextResponse.json(redactLocalPaths({
      ok: true,
      suggestionCount: suggestions.length,
      suggestions,
      cacheStatus,
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
      error: '暂时无法生成主题建议，请重试。',
      code: 'topic_suggestions_failed',
      status,
    });
  }
}
