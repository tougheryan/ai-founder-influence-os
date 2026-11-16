import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { INSTALL_ROOT, PROJECT_DIR, contentRuntimeToolPath } from './project-root';
import { runtimePythonBinary } from './runtime-binary';

const execFileAsync = promisify(execFile);
const CONTENT_LINK_SCHEMA = 'aifios.content-link.v1';
const MAX_SOURCE_URL_CHARS = 2_000;
const MAX_COLLECTOR_OUTPUT_CHARS = 512 * 1024;
const MAX_TITLE_CHARS = 500;
const MAX_DETAIL_CHARS = 24_000;
const MAX_EXCERPT_CHARS = 600;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Keep this aligned with material-analysis. Runtime runs can predate the
// current ASCII-only collector convention and may therefore include uppercase
// or Chinese characters. They are never used directly as an archive path.
const RUN_ID_RE = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/;

const CONTENT_PLATFORMS = ['wechat_mp', 'wechat_channels', 'douyin', 'xiaohongshu'] as const;
const CONTENT_KINDS = ['article', 'video', 'note'] as const;

export type TikOmniContentPlatform = (typeof CONTENT_PLATFORMS)[number];
export type TikOmniContentKind = (typeof CONTENT_KINDS)[number];

const CONTENT_KIND_BY_PLATFORM: Record<TikOmniContentPlatform, TikOmniContentKind> = {
  wechat_mp: 'article',
  wechat_channels: 'video',
  douyin: 'video',
  xiaohongshu: 'note',
};

export type TikOmniContentLinkReadInput = {
  projectId: string;
  runId: string;
  url: string;
};

export type TikOmniPlatformContent = {
  title: string;
  excerpt: string;
  detail: string;
  platform: TikOmniContentPlatform;
  contentKind: TikOmniContentKind;
};

export type TikOmniContentLinkCollectorOutput = {
  stdout: string;
  stderr?: string;
};

/** Receives the complete Python argument vector, including the script path. */
export type TikOmniContentLinkCollectorRunner = (
  args: readonly string[],
) => Promise<TikOmniContentLinkCollectorOutput>;

export class TikOmniContentLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TikOmniContentLinkError';
  }
}

export class TikOmniContentLinkInputError extends TikOmniContentLinkError {
  constructor(message: string) {
    super(message);
    this.name = 'TikOmniContentLinkInputError';
  }
}

function contentLinkCollectorScript(): string {
  return contentRuntimeToolPath('content_link_collector.py');
}

type SupportedUrl = {
  platform: TikOmniContentPlatform;
  sourceUrl: string;
};

type UrlInspection =
  | { kind: 'supported'; value: SupportedUrl }
  | { kind: 'unsupported' }
  | { kind: 'unsafe'; message: string };

type ValidatedReadInput = TikOmniContentLinkReadInput & SupportedUrl & {
  /** ASCII-only collector/archive scope derived from the operator-facing run ID. */
  collectorRunId: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown, max = MAX_COLLECTOR_OUTPUT_CHARS): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\u0000/g, '').trim().slice(0, max);
}

function compactText(value: string, max: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function boundedDetail(value: unknown): string {
  const text = asText(value, MAX_DETAIL_CHARS + 1);
  if (text.length <= MAX_DETAIL_CHARS) return text;
  return `${text.slice(0, MAX_DETAIL_CHARS - 3).trimEnd()}...`;
}

function hostMatches(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function isArticlePath(pathname: string): boolean {
  return pathname === '/s' || pathname.startsWith('/s/');
}

function hasContentPath(pathname: string): boolean {
  return pathname !== '/' && pathname.length > 1;
}

function platformForUrl(url: URL): TikOmniContentPlatform | null {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');

  if (hostname === 'mp.weixin.qq.com') {
    return isArticlePath(url.pathname) ? 'wechat_mp' : null;
  }
  if (hostname === 'weixin.qq.com') {
    return url.pathname === '/sph' || url.pathname.startsWith('/sph/') ? 'wechat_channels' : null;
  }
  if (hostname === 'channels.weixin.qq.com' || hostname === 'finder.video.qq.com') {
    return hasContentPath(url.pathname) ? 'wechat_channels' : null;
  }
  if (hostMatches(hostname, 'douyin.com') || hostMatches(hostname, 'douyin.cn') || hostMatches(hostname, 'iesdouyin.com')) {
    return hasContentPath(url.pathname) ? 'douyin' : null;
  }
  if (hostMatches(hostname, 'xiaohongshu.com') || hostMatches(hostname, 'xhslink.com') || hostMatches(hostname, 'xhsurl.com')) {
    return hasContentPath(url.pathname) ? 'xiaohongshu' : null;
  }
  return null;
}

function isKnownPlatformHost(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  return hostname === 'mp.weixin.qq.com'
    || hostname === 'weixin.qq.com'
    || hostname === 'channels.weixin.qq.com'
    || hostname === 'finder.video.qq.com'
    || hostMatches(hostname, 'douyin.com')
    || hostMatches(hostname, 'douyin.cn')
    || hostMatches(hostname, 'iesdouyin.com')
    || hostMatches(hostname, 'xiaohongshu.com')
    || hostMatches(hostname, 'xhslink.com')
    || hostMatches(hostname, 'xhsurl.com');
}

function inspectTikOmniContentUrl(value: unknown): UrlInspection {
  if (typeof value !== 'string' || !value.trim()) {
    return { kind: 'unsafe', message: '平台内容链接不能为空。' };
  }
  const source = value.trim();
  if (source.length > MAX_SOURCE_URL_CHARS) {
    return { kind: 'unsafe', message: '平台内容链接过长。' };
  }

  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch {
    return { kind: 'unsafe', message: '平台内容链接格式不正确。' };
  }

  if (!isKnownPlatformHost(parsed)) return { kind: 'unsupported' };
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'unsafe', message: '平台内容链接仅支持 HTTP 或 HTTPS。' };
  }
  if (parsed.username || parsed.password) {
    return { kind: 'unsafe', message: '平台内容链接不能包含账号信息。' };
  }
  if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
    return { kind: 'unsafe', message: '平台内容链接只能使用标准 Web 端口。' };
  }

  const platform = platformForUrl(parsed);
  if (!platform) return { kind: 'unsupported' };
  parsed.hash = '';
  return { kind: 'supported', value: { platform, sourceUrl: parsed.toString() } };
}

/** True only for public WeChat, WeChat Channels, Douyin, or Xiaohongshu content links. */
export function isTikOmniPlatformContentUrl(url: string): boolean {
  return inspectTikOmniContentUrl(url).kind === 'supported';
}

function validateProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_RE.test(value)) {
    throw new TikOmniContentLinkInputError('项目 ID 格式不正确。');
  }
  return value;
}

function validateRunId(value: unknown): string {
  const runId = typeof value === 'string' ? value.trim() : '';
  if (!RUN_ID_RE.test(runId)) {
    throw new TikOmniContentLinkInputError('本次运行 ID 格式不正确。');
  }
  return runId;
}

/**
 * Produces the collector-only run scope for one material-analysis run.
 *
 * The original run ID remains the runtime/material context key. Hashing it
 * here makes the temporary third-party evidence path deterministic, bounded,
 * and compatible with the collector's strict ASCII path contract.
 */
export function tikomniContentLinkRunScope(runId: string): string {
  const validatedRunId = validateRunId(runId);
  return `content-link-${createHash('sha256').update(validatedRunId, 'utf8').digest('hex')}`;
}

function validateReadInput(input: TikOmniContentLinkReadInput): ValidatedReadInput | null {
  const projectId = validateProjectId(input?.projectId);
  const runId = validateRunId(input?.runId);
  const inspected = inspectTikOmniContentUrl(input?.url);
  if (inspected.kind === 'unsupported') return null;
  if (inspected.kind === 'unsafe') throw new TikOmniContentLinkInputError(inspected.message);
  return {
    projectId,
    runId,
    collectorRunId: tikomniContentLinkRunScope(runId),
    url: input.url,
    ...inspected.value,
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return asRecord(value);
  const candidates = [value.trim(), ...value.trim().split(/\r?\n/).map((line) => line.trim()).reverse()];
  for (const candidate of candidates) {
    if (!candidate || candidate.length > MAX_COLLECTOR_OUTPUT_CHARS) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const record = asRecord(parsed);
      if (Object.keys(record).length) return record;
    } catch {
      // Python may include a short diagnostic before its final JSON line.
    }
  }
  return {};
}

function isContentPlatform(value: unknown): value is TikOmniContentPlatform {
  return typeof value === 'string' && (CONTENT_PLATFORMS as readonly string[]).includes(value);
}

function isContentKind(value: unknown): value is TikOmniContentKind {
  return typeof value === 'string' && (CONTENT_KINDS as readonly string[]).includes(value);
}

function safeArchivePath(
  value: unknown,
  input: ValidatedReadInput,
  kind: 'raw' | 'normalized',
): boolean {
  const path = asText(value, 1_000).replace(/\\/g, '/');
  const prefix = `sessions/content-link-reads/${input.projectId}/${input.collectorRunId}/${kind}/`;
  return Boolean(path)
    && path.startsWith(prefix)
    && !path.startsWith('/')
    && !path.includes('\u0000')
    && path.split('/').every((part) => part && part !== '.' && part !== '..');
}

function failureKind(value: Record<string, unknown>): 'not_configured' | 'no_body' | 'unavailable' {
  const detail = [value.status, value.reason, value.error, value.message, value.primary_text_source]
    .map((item) => asText(item, 2_000).toLowerCase())
    .join(' ');
  if (/(token|credential|api[_ -]?key|authorization|auth|未配置|未授权)/i.test(detail)) {
    return 'not_configured';
  }
  if (/(primary[_ -]?text|正文|字幕|逐字稿|transcript|caption|no[ _-]?body|missing[ _-]?body)/i.test(detail)) {
    return 'no_body';
  }
  return 'unavailable';
}

function failureError(kind: ReturnType<typeof failureKind>): TikOmniContentLinkError {
  if (kind === 'not_configured') {
    return new TikOmniContentLinkError('TikOmni 未配置或 Token 无效。请在设置中完成 TikOmni 授权后重试。');
  }
  if (kind === 'no_body') {
    return new TikOmniContentLinkError('TikOmni 已抓到该内容，但没有可用正文、字幕或逐字稿。请补充可读文本后继续。');
  }
  return new TikOmniContentLinkError('TikOmni 平台接口暂时不可用，请稍后重试。');
}

function contractError(): TikOmniContentLinkError {
  return new TikOmniContentLinkError('TikOmni 返回的内容读取结果无效，请稍后重试。');
}

function validatePayloadBinding(payload: Record<string, unknown>, input: ValidatedReadInput): TikOmniContentKind {
  if (payload.schema !== CONTENT_LINK_SCHEMA) throw contractError();
  if (asText(payload.project_id, 64) !== input.projectId) {
    throw new TikOmniContentLinkError('TikOmni 返回的内容不属于当前项目。');
  }
  if (asText(payload.run_id, 128) !== input.collectorRunId) {
    throw new TikOmniContentLinkError('TikOmni 返回的内容不属于本次运行。');
  }
  if (!isContentPlatform(payload.platform) || payload.platform !== input.platform) throw contractError();
  if (!isContentKind(payload.content_kind) || payload.content_kind !== CONTENT_KIND_BY_PLATFORM[input.platform]) {
    throw contractError();
  }

  const returnedUrl = inspectTikOmniContentUrl(asText(payload.source_url, MAX_SOURCE_URL_CHARS));
  if (returnedUrl.kind !== 'supported'
    || returnedUrl.value.platform !== input.platform
    || returnedUrl.value.sourceUrl !== input.sourceUrl) {
    throw new TikOmniContentLinkError('TikOmni 返回的内容链接与当前请求不一致。');
  }
  return payload.content_kind;
}

/**
 * Validates the collector's v1 response and returns only display-safe content.
 * It intentionally never exposes raw evidence paths, collector reasons, or credentials.
 */
export function parseTikOmniContentLinkCollectorOutput(
  value: unknown,
  input: TikOmniContentLinkReadInput,
): TikOmniPlatformContent {
  const validatedInput = validateReadInput(input);
  if (!validatedInput) {
    throw new TikOmniContentLinkInputError('该链接不是受支持的平台内容链接。');
  }
  const payload = parseJsonRecord(value);
  if (!Object.keys(payload).length) throw contractError();

  if (payload.status !== 'available' && payload.status !== 'incomplete') {
    throw failureError(failureKind(payload));
  }
  const contentKind = validatePayloadBinding(payload, validatedInput);
  const detail = boundedDetail(payload.primary_text);
  if (!detail) throw failureError('no_body');
  if (
    !safeArchivePath(payload.raw_path, validatedInput, 'raw')
    || !safeArchivePath(payload.normalized_path, validatedInput, 'normalized')
  ) {
    throw contractError();
  }
  const title = compactText(asText(payload.title, MAX_TITLE_CHARS), MAX_TITLE_CHARS) || '未命名平台内容';
  return {
    title,
    excerpt: compactText(detail, MAX_EXCERPT_CHARS),
    detail,
    platform: validatedInput.platform,
    contentKind,
  };
}

export const runTikOmniContentLinkCollector: TikOmniContentLinkCollectorRunner = async (args) => {
  const { stdout, stderr } = await execFileAsync(runtimePythonBinary(), [...args], {
    cwd: INSTALL_ROOT,
    maxBuffer: MAX_COLLECTOR_OUTPUT_CHARS,
    timeout: 190_000,
  });
  return { stdout: String(stdout), stderr: String(stderr || '') };
};

function cliFailurePayload(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== 'object') return {};
  const candidate = error as { stderr?: unknown; stdout?: unknown };
  const stderrPayload = parseJsonRecord(asText(candidate.stderr, MAX_COLLECTOR_OUTPUT_CHARS));
  if (Object.keys(stderrPayload).length) return stderrPayload;
  return parseJsonRecord(asText(candidate.stdout, MAX_COLLECTOR_OUTPUT_CHARS));
}

/**
 * Reads one supported public platform link. A null result only means that the
 * URL is not a supported content URL; all collection failures are explicit.
 */
export async function readTikOmniPlatformContent(
  input: TikOmniContentLinkReadInput,
  collectorRunner: TikOmniContentLinkCollectorRunner = runTikOmniContentLinkCollector,
): Promise<TikOmniPlatformContent | null> {
  const validatedInput = validateReadInput(input);
  if (!validatedInput) return null;

  const args = [
    contentLinkCollectorScript(),
    '--project', PROJECT_DIR,
    '--project-id', validatedInput.projectId,
    '--run-id', validatedInput.collectorRunId,
    '--source-url', validatedInput.sourceUrl,
  ];

  try {
    const result = await collectorRunner(args);
    if (asText(result.stdout, MAX_COLLECTOR_OUTPUT_CHARS + 1).length > MAX_COLLECTOR_OUTPUT_CHARS) {
      throw contractError();
    }
    return parseTikOmniContentLinkCollectorOutput(result.stdout, validatedInput);
  } catch (error) {
    if (error instanceof TikOmniContentLinkError) throw error;
    const payload = cliFailurePayload(error);
    if (Object.keys(payload).length) throw failureError(failureKind(payload));
    throw failureError('unavailable');
  }
}
