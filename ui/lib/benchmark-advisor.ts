import { createHash, randomUUID } from 'crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { advisorGeneratedDisplayText } from './benchmark-display-copy';
import { createLLMTextCompletion } from './llm-client';
import { inspectGeneratedLanguage, PRODUCT_VOICE_INSTRUCTION } from './product-voice';
import { INSTALL_ROOT, PROJECT_DIR, contentRuntimeToolPath, runtimeJoin, safeResolve } from './project-root';
import { runtimePythonBinary } from './runtime-binary';
import { resolveServerLLMConfig } from './server-config';

const execFileAsync = promisify(execFile);
const ADVISOR_ROOT_RELATIVE = 'materials/advisors/benchmark';
const BENCHMARK_COLLECTOR_SCRIPT = contentRuntimeToolPath('benchmark_advisor.py');
const VIRAL_VIDEO_COLLECTOR_SCRIPT = contentRuntimeToolPath('viral_video_advisor.py');
const BENCHMARK_COLLECTOR_TEMP_PREFIX = 'aifios-benchmark-advisor-';
const MAX_ACCOUNTS = 5;
const MAX_CHAT_MESSAGES = 100;
const MAX_REPORTS = 52;
const MAX_VIDEO_PRIMARY_TEXT_CHARS = 16_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const REQUIRED_TIKOMNI_PLATFORMS = ['wechat_mp', 'xiaohongshu', 'wechat_channels'] as const;

export type BenchmarkPlatform = (typeof REQUIRED_TIKOMNI_PLATFORMS)[number];
export type ViralVideoPlatform = 'douyin' | 'xiaohongshu' | 'wechat_channels';
export type BenchmarkPriority = 'P0' | 'P1' | 'P2';
export type BenchmarkEvidenceKind = 'profile' | 'work' | 'comment';

export type BenchmarkWorkStructureAnalysis = {
  status: 'ready' | 'limited';
  topicSignals: string[];
  promiseTypes: string[];
  narrativeStructure: string[];
  proofSignals: string[];
  ctaTypes: string[];
  visualSignals: string[];
  basis: string[];
  evidenceLimits: string[];
};

export type BenchmarkPattern = {
  dimension: 'topic' | 'promise' | 'structure' | 'proof' | 'cta' | 'visual';
  label: string;
  sampleCount: number;
  sampleUrls: string[];
  confidence: 'repeated' | 'single_sample';
};

export type BenchmarkAccount = {
  id: string;
  label: string;
  handle: string;
  platform: BenchmarkPlatform;
  publicUrl: string;
  focus: string;
  observation: string;
  createdAt: string;
  updatedAt: string;
};

export type BenchmarkEvidenceLink = {
  url: string;
  capturedAt: string;
  kind: BenchmarkEvidenceKind;
};

export type BenchmarkWorkEvidence = {
  sourceUrl: string;
  publishedAt: string;
  capturedAt: string;
  format: string;
  metrics: Record<string, number>;
  openingMechanisms: string[];
  ctaPresent: boolean;
  interactionSignal: string;
  title: string;
  author: string;
  summary: string;
  coverImage: string;
  // A locally archived copy of the public cover. It is optional so reports
  // created before local media caching remain readable.
  coverPath?: string;
  coverContentType?: string;
  embedUrl: string;
  primaryText: string;
  primaryTextSource: string;
  // Optional for archives created before deterministic structure analysis was
  // introduced. Newly collected evidence always includes it.
  structureAnalysis?: BenchmarkWorkStructureAnalysis;
};

export type BenchmarkAccountEvidence = {
  accountId: string;
  platform: BenchmarkPlatform;
  status: 'available' | 'unavailable';
  capturedAt: string;
  reason: string;
  profile: {
    status: 'available' | 'unavailable';
    links: BenchmarkEvidenceLink[];
    publicMetricFields: string[];
    reason: string;
  };
  works: {
    status: 'available' | 'unavailable';
    items: BenchmarkWorkEvidence[];
    links: BenchmarkEvidenceLink[];
    reason: string;
  };
  comments: {
    status: 'available' | 'unavailable';
    links: BenchmarkEvidenceLink[];
    reason: string;
  };
  rawEntries: Array<{ kind: string; endpointId: string; path: string; sha256: string; capturedAt: string }>;
  evidenceLinks: BenchmarkEvidenceLink[];
};

export type BenchmarkResearchEvidence = {
  projectId: string;
  snapshotPath: string;
  normalizedPath: string;
  capturedAt: string;
  accounts: BenchmarkAccountEvidence[];
};

export type BenchmarkAction = {
  id: string;
  priority: BenchmarkPriority;
  title: string;
  rationale: string;
  mechanism: string;
  adoptionText: string;
  guardrail: string;
  proposedExperiment: string;
  evidenceLinks: BenchmarkEvidenceLink[];
};

export type BenchmarkComparisonRow = {
  dimension: string;
  cells: Array<{ accountId: string; value: string; evidenceLinks: BenchmarkEvidenceLink[] }>;
};

export type TikOmniAdvisorEvidence = {
  status: 'available' | 'unavailable';
  snapshotPath: string;
  normalizedPath: string;
  capturedAt: string;
  accountEvidenceCount: number;
  unavailableAccountCount: number;
  note: string;
};

export type BenchmarkReport = {
  id: string;
  generatedAt: string;
  accountFingerprint: string;
  evidenceFingerprint: string;
  accounts: Array<Pick<BenchmarkAccount, 'id' | 'label' | 'handle' | 'platform' | 'publicUrl' | 'focus'> & {
    mechanisms: string[];
    patterns?: BenchmarkPattern[];
    works: BenchmarkWorkEvidence[];
    observationStatus: 'ready' | 'needs_observation';
    evidenceStatus: 'available' | 'unavailable';
    evidenceLinks: BenchmarkEvidenceLink[];
    evidenceReason: string;
  }>;
  comparison: BenchmarkComparisonRow[];
  actions: BenchmarkAction[];
  evidence: TikOmniAdvisorEvidence;
  changeSummary: string;
  qualityWarnings?: string[];
};

export type ViralVideoEvidence = {
  projectId: string;
  platform: ViralVideoPlatform;
  sourceUrl: string;
  canonicalUrl: string;
  capturedAt: string;
  fingerprint: string;
  title: string;
  author: string;
  publishedAt: string;
  metrics: Record<string, number>;
  coverImage: string;
  coverType: 'cover' | 'first_frame' | '';
  // Some providers return an extracted opening frame without returning a
  // platform-authored cover. Keep the two fields separate so the UI never
  // presents a frame as an official cover.
  firstFrameImage: string;
  // Local visuals are only accepted through the constrained media route.
  // A `video_first_frame` is intentionally not represented as a formal cover.
  coverPath: string;
  coverContentType: string;
  coverSource: 'tikomni_cover' | 'wechat_channels_public_preview' | 'video_first_frame' | '';
  coverLabel: string;
  videoUrl: string;
  primaryText: string;
  primaryTextSource: string;
  durationMs: number | null;
  missingFields: string[];
  analysisFields: ViralVideoAnalysisFields;
  rawPath: string;
  normalizedPath: string;
};

export type ViralVideoAnalysisFields = {
  status: 'ready' | 'limited' | '';
  topic: string;
  openingHook: string;
  narrativeStructure: string[];
  expressionMethods: string[];
  reusableMethods: string[];
  productionNotes: string[];
  evidenceLimits: string[];
};

export type ViralVideoAngle = {
  id: string;
  title: string;
  rationale: string;
  adoptionText: string;
  proposedExperiment: string;
  guardrail: string;
};

export type ViralVideoBreakdown = {
  status: 'ready' | 'limited';
  topic: string;
  hook: string;
  audience: string;
  whyItWorks: string[];
  structure: string[];
  expressionMethods: string[];
  reusablePractices: string[];
  productionNotes: string[];
  guardrails: string[];
  angles: ViralVideoAngle[];
  qualityWarnings?: string[];
};

export type ViralVideoAnalysis = {
  id: string;
  projectId: string;
  createdAt: string;
  evidence: ViralVideoEvidence;
  breakdown: ViralVideoBreakdown;
};

export type AdvisorChatMessage = {
  id: string;
  role: 'user' | 'advisor';
  content: string;
  createdAt: string;
  reportId?: string;
  videoAnalysisId?: string;
  context?: {
    accountId?: string;
    workUrl?: string;
  };
  qualityWarnings?: string[];
};

export type BenchmarkAdvisorState = {
  projectId: string;
  authorizationConfirmed: boolean;
  accounts: BenchmarkAccount[];
  latestReport: BenchmarkReport | null;
  latestVideoAnalysis: ViralVideoAnalysis | null;
  reportCount: number;
  chatHistory: AdvisorChatMessage[];
  weekly: {
    lastRefreshAt: string | null;
    nextRefreshAt: string | null;
    refreshDue: boolean;
    unreadChangeSummary: boolean;
    changeSummary: string;
    lastAttemptAt: string | null;
    lastRefreshError: string;
  };
  archivePaths: {
    accounts: string;
    research: string;
    chat: string;
    evidence: string;
    videoAnalysis: string;
  };
};

type ProjectPaths = {
  root: string;
  config: string;
  archive: string;
  chat: string;
  status: string;
  videoAnalysis: string;
};

type AccountConfig = {
  schema: 'aifios.benchmark-advisor.accounts.v2';
  projectId: string;
  authorizationConfirmedAt: string;
  updatedAt: string;
  accounts: BenchmarkAccount[];
};

type ResearchArchive = {
  schema: 'aifios.benchmark-advisor.research.v2';
  projectId: string;
  reports: BenchmarkReport[];
};

type ChatArchive = {
  schema: 'aifios.benchmark-advisor.chat.v2';
  projectId: string;
  messages: AdvisorChatMessage[];
};

type WeeklyState = {
  schema: 'aifios.benchmark-advisor.weekly-state.v2';
  projectId: string;
  lastRefreshAt: string | null;
  nextRefreshAt: string | null;
  unreadChangeSummary: boolean;
  changeSummary: string;
  desktopNotifiedAt: string | null;
  lastAttemptAt: string | null;
  lastRefreshError: string;
  lastRefreshErrorCode?: string;
  lastRefreshDebugId?: string;
};

export type BenchmarkAdvisorDesktopReminder = {
  shouldNotify: boolean;
  message: string;
  refreshedAt: string | null;
};

export type BenchmarkEvidenceCollector = (
  projectId: string,
  accounts: BenchmarkAccount[],
) => Promise<BenchmarkResearchEvidence>;

export type ViralVideoEvidenceCollector = (
  projectId: string,
  sourceUrl: string,
) => Promise<ViralVideoEvidence>;

export type ViralVideoBreakdownGenerator = (
  evidence: ViralVideoEvidence,
) => Promise<ViralVideoBreakdown>;

export class BenchmarkAdvisorInputError extends Error {}

const PLATFORM_LABELS: Record<BenchmarkPlatform, string> = {
  wechat_mp: '公众号',
  xiaohongshu: '小红书',
  wechat_channels: '视频号',
};

function now(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter(Boolean) : [];
}

function safeGeneratedText(value: unknown, fallback = '这条旧分析包含不适合展示的技术信息，请重新分析。'): string {
  const text = asString(value);
  return inspectGeneratedLanguage(text).blocking.length ? fallback : text;
}

function safeGeneratedList(value: unknown): string[] {
  return asStringList(value).map((item) => safeGeneratedText(item)).filter(Boolean);
}

function toRelative(path: string): string {
  const root = PROJECT_DIR.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalized = path.replace(/\\/g, '/');
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function parseProjectId(value: unknown): string {
  const projectId = safeText(value, '项目 ID', 64).toLowerCase();
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new BenchmarkAdvisorInputError('项目 ID 只能包含小写字母、数字、连字符和下划线。');
  }
  return projectId;
}

function pathsForProject(projectId: string): ProjectPaths {
  const root = runtimeJoin(PROJECT_DIR, ADVISOR_ROOT_RELATIVE, projectId);
  return {
    root,
    config: runtimeJoin(root, 'accounts.json'),
    archive: runtimeJoin(root, 'research-archive.json'),
    chat: runtimeJoin(root, 'chat-history.json'),
    status: runtimeJoin(root, 'weekly-state.json'),
    videoAnalysis: runtimeJoin(root, 'single-video', 'latest-video-analysis.json'),
  };
}

function emptyConfig(projectId: string): AccountConfig {
  return {
    schema: 'aifios.benchmark-advisor.accounts.v2',
    projectId,
    authorizationConfirmedAt: '',
    updatedAt: now(),
    accounts: [],
  };
}

function emptyArchive(projectId: string): ResearchArchive {
  return { schema: 'aifios.benchmark-advisor.research.v2', projectId, reports: [] };
}

function emptyChat(projectId: string): ChatArchive {
  return { schema: 'aifios.benchmark-advisor.chat.v2', projectId, messages: [] };
}

function emptyWeeklyState(projectId: string): WeeklyState {
  return {
    schema: 'aifios.benchmark-advisor.weekly-state.v2',
    projectId,
    lastRefreshAt: null,
    nextRefreshAt: null,
    unreadChangeSummary: false,
    changeSummary: '',
    desktopNotifiedAt: null,
    lastAttemptAt: null,
    lastRefreshError: '',
  };
}

function isBenchmarkPlatform(value: unknown): value is BenchmarkPlatform {
  return typeof value === 'string' && (REQUIRED_TIKOMNI_PLATFORMS as readonly string[]).includes(value);
}

function isViralVideoPlatform(value: unknown): value is ViralVideoPlatform {
  return value === 'douyin' || value === 'xiaohongshu' || value === 'wechat_channels';
}

function safeText(value: unknown, label: string, maxLength: number, required = true): string {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throw new BenchmarkAdvisorInputError(`${label}必须是文本。`);
  }
  const text = value.trim();
  if (required && !text) throw new BenchmarkAdvisorInputError(`${label}不能为空。`);
  if (text.length > maxLength) throw new BenchmarkAdvisorInputError(`${label}过长。`);
  return text;
}

function publicUrl(value: unknown): string {
  const url = safeText(value, '公开账号链接', 500);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new BenchmarkAdvisorInputError('公开账号链接必须使用 http 或 https。');
    }
    if (parsed.username || parsed.password) {
      throw new BenchmarkAdvisorInputError('公开账号链接不能包含账号凭据。');
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof BenchmarkAdvisorInputError) throw error;
    throw new BenchmarkAdvisorInputError('公开账号链接格式不正确。');
  }
}

function safeAccountId(value: unknown): string {
  if (typeof value !== 'string' || !/^benchmark_[a-f0-9]{12,32}$/.test(value)) {
    return `benchmark_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  }
  return value;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function accountFingerprint(accounts: BenchmarkAccount[]): string {
  return hash(accounts
    .map((account) => [account.id, account.platform, account.handle, account.publicUrl, account.focus, account.observation].join('|'))
    .sort()
    .join('\n'));
}

function parseAccount(raw: unknown, existing?: BenchmarkAccount): BenchmarkAccount {
  const value = asRecord(raw);
  const platform = value.platform;
  if (!isBenchmarkPlatform(platform)) {
    throw new BenchmarkAdvisorInputError('参考账号只支持公众号、小红书或视频号。');
  }
  const timestamp = now();
  return {
    id: safeAccountId(value.id),
    label: safeText(value.label, '账号名称', 80),
    handle: safeText(value.handle, '账号公开 ID', 160),
    platform,
    publicUrl: publicUrl(value.publicUrl),
    focus: safeText(value.focus, '关注主题', 240, false),
    observation: safeText(value.observation, '公开观察', 1600, false),
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return fallback;
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
  await rename(temporary, path);
}

function isStoredAccount(value: unknown): value is BenchmarkAccount {
  const item = asRecord(value);
  return typeof item.id === 'string'
    && typeof item.label === 'string'
    && typeof item.handle === 'string'
    && isBenchmarkPlatform(item.platform)
    && typeof item.publicUrl === 'string'
    && typeof item.focus === 'string'
    && typeof item.observation === 'string'
    && typeof item.createdAt === 'string'
    && typeof item.updatedAt === 'string';
}

function isStoredReport(value: unknown): value is BenchmarkReport {
  const item = asRecord(value);
  return typeof item.id === 'string'
    && typeof item.generatedAt === 'string'
    && typeof item.accountFingerprint === 'string'
    && typeof item.evidenceFingerprint === 'string'
    && Array.isArray(item.accounts)
    && Array.isArray(item.comparison)
    && Array.isArray(item.actions)
    && Object.keys(asRecord(item.evidence)).length > 0;
}

function isStoredMessage(value: unknown): value is AdvisorChatMessage {
  const item = asRecord(value);
  return (item.role === 'user' || item.role === 'advisor')
    && typeof item.id === 'string'
    && typeof item.content === 'string'
    && typeof item.createdAt === 'string';
}

async function readConfig(projectId: string): Promise<AccountConfig> {
  const config = await readJson<AccountConfig>(pathsForProject(projectId).config, emptyConfig(projectId));
  if (config.schema !== 'aifios.benchmark-advisor.accounts.v2' || config.projectId !== projectId) return emptyConfig(projectId);
  return {
    ...emptyConfig(projectId),
    ...config,
    accounts: Array.isArray(config.accounts) ? config.accounts.filter(isStoredAccount) : [],
    authorizationConfirmedAt: typeof config.authorizationConfirmedAt === 'string' ? config.authorizationConfirmedAt : '',
  };
}

async function readArchive(projectId: string): Promise<ResearchArchive> {
  const archive = await readJson<ResearchArchive>(pathsForProject(projectId).archive, emptyArchive(projectId));
  if (archive.schema !== 'aifios.benchmark-advisor.research.v2' || archive.projectId !== projectId) return emptyArchive(projectId);
  const reports = Array.isArray(archive.reports)
    ? archive.reports.filter(isStoredReport).map(sanitizeStoredReport)
    : [];
  return { ...emptyArchive(projectId), ...archive, reports };
}

async function readChat(projectId: string): Promise<ChatArchive> {
  const chat = await readJson<ChatArchive>(pathsForProject(projectId).chat, emptyChat(projectId));
  if (chat.schema !== 'aifios.benchmark-advisor.chat.v2' || chat.projectId !== projectId) return emptyChat(projectId);
  const messages = Array.isArray(chat.messages)
    ? chat.messages.filter(isStoredMessage).slice(-MAX_CHAT_MESSAGES).map((message) => ({
      ...message,
      content: safeGeneratedText(message.content, '这条旧消息包含不适合展示的技术信息，请重新提问。'),
      qualityWarnings: safeGeneratedList(message.qualityWarnings).slice(0, 8),
    }))
    : [];
  return { ...emptyChat(projectId), ...chat, messages };
}

function sanitizeStoredReport(report: BenchmarkReport): BenchmarkReport {
  return {
    ...report,
    accounts: report.accounts.map((account) => ({
      ...account,
      mechanisms: safeGeneratedList(account.mechanisms),
      evidenceReason: account.evidenceStatus === 'unavailable'
        ? '这次没有读到该账号的公开信息，请检查账号后重试。'
        : '',
    })),
    comparison: report.comparison.map((row) => ({
      ...row,
      cells: row.cells.map((cell) => ({ ...cell, value: safeGeneratedText(cell.value) })),
    })),
    actions: report.actions.map((action) => ({
      ...action,
      title: safeGeneratedText(action.title),
      rationale: safeGeneratedText(action.rationale),
      mechanism: safeGeneratedText(action.mechanism),
      adoptionText: safeGeneratedText(action.adoptionText),
      guardrail: safeGeneratedText(action.guardrail),
      proposedExperiment: safeGeneratedText(action.proposedExperiment),
    })),
    evidence: { ...report.evidence, note: safeGeneratedText(report.evidence.note) },
    changeSummary: safeGeneratedText(report.changeSummary),
    qualityWarnings: safeGeneratedList(report.qualityWarnings).slice(0, 8),
  };
}

function optionalPublicUrl(value: unknown): string {
  const text = asString(value);
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function hostMatchesVideoPlatform(hostname: string, suffixes: string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isSupportedViralVideoUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return hostMatchesVideoPlatform(host, ['douyin.com', 'douyin.cn', 'iesdouyin.com'])
      || hostMatchesVideoPlatform(host, ['xiaohongshu.com', 'xhslink.com', 'xhsurl.com'])
      || hostMatchesVideoPlatform(host, ['channels.weixin.qq.com', 'finder.video.qq.com'])
      || (hostMatchesVideoPlatform(host, ['weixin.qq.com']) && parsed.pathname.startsWith('/sph/'));
  } catch {
    return false;
  }
}

function normalizedVideoCoverType(value: unknown): ViralVideoEvidence['coverType'] {
  const type = asString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['first_frame', 'firstframe', 'video_first_frame', 'frame'].includes(type)) return 'first_frame';
  if (['cover', 'official_cover', 'platform_cover', 'dynamic_cover', 'thumbnail'].includes(type)) return 'cover';
  return '';
}

function normalizedVideoCoverSource(value: unknown): ViralVideoEvidence['coverSource'] {
  const source = asString(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (source === 'video_first_frame') return 'video_first_frame';
  if (source === 'tikomni_cover') return 'tikomni_cover';
  if (source === 'wechat_channels_public_preview') return 'wechat_channels_public_preview';
  return '';
}

function parseVideoAnalysisFields(value: unknown): ViralVideoAnalysisFields {
  const raw = asRecord(value);
  const status = raw.status === 'ready' || raw.status === 'limited' ? raw.status : '';
  return {
    status,
    topic: asString(raw.topic).slice(0, 300),
    openingHook: asString(raw.openingHook ?? raw.opening_hook).slice(0, 500),
    narrativeStructure: asStringList(raw.narrativeStructure ?? raw.narrative_structure).slice(0, 8),
    expressionMethods: asStringList(raw.expressionMethods ?? raw.expression_methods).slice(0, 8),
    reusableMethods: asStringList(raw.reusableMethods ?? raw.reusable_methods).slice(0, 8),
    productionNotes: asStringList(raw.productionNotes ?? raw.production_notes).slice(0, 8),
    evidenceLimits: asStringList(raw.evidenceLimits ?? raw.evidence_limits).slice(0, 8),
  };
}

function videoCoverFields(value: Record<string, unknown>, projectId: string): Pick<ViralVideoEvidence, 'coverImage' | 'coverType' | 'firstFrameImage' | 'coverPath' | 'coverContentType' | 'coverSource' | 'coverLabel'> {
  const reportedCover = optionalPublicUrl(value.coverImage ?? value.cover_image);
  const coverType = normalizedVideoCoverType(value.coverType ?? value.cover_type);
  const coverSource = normalizedVideoCoverSource(value.coverSource ?? value.cover_source);
  const reportedFirstFrame = optionalPublicUrl(
    value.firstFrameImage
    ?? value.first_frame_image
    ?? value.firstFrame
    ?? value.first_frame,
  );
  const localPath = relativeVideoEvidencePath(value.coverPath ?? value.cover_path, projectId);
  const isFirstFrame = coverType === 'first_frame' || coverSource === 'video_first_frame';
  const firstFrameImage = reportedFirstFrame || (isFirstFrame ? reportedCover : '');
  const coverImage = isFirstFrame ? '' : reportedCover;
  return {
    coverImage,
    coverType: coverType || (isFirstFrame ? 'first_frame' : coverImage || localPath ? 'cover' : firstFrameImage ? 'first_frame' : ''),
    firstFrameImage,
    coverPath: localPath,
    coverContentType: asString(value.coverContentType ?? value.cover_content_type),
    coverSource,
    coverLabel: asString(value.coverLabel ?? value.cover_label).slice(0, 80),
  };
}

function relativeVideoEvidencePath(value: unknown, projectId: string): string {
  const path = asString(value);
  return path.startsWith(`${ADVISOR_ROOT_RELATIVE}/${projectId}/single-video/`) ? path : '';
}

function parseViralVideoAngle(value: unknown, analysisId: string, index: number): ViralVideoAngle | null {
  const raw = asRecord(value);
  const title = safeGeneratedText(raw.title);
  const rationale = safeGeneratedText(raw.rationale);
  const adoptionText = safeGeneratedText(raw.adoption_text ?? raw.adoptionText);
  const proposedExperiment = safeGeneratedText(raw.proposed_experiment ?? raw.proposedExperiment);
  const guardrail = safeGeneratedText(raw.guardrail);
  if (!title || !rationale || !adoptionText || !proposedExperiment || !guardrail) return null;
  const id = asString(raw.id) || `viral_angle_${hash(`${analysisId}:${index}:${title}`).slice(0, 16)}`;
  return { id, title, rationale, adoptionText, proposedExperiment, guardrail };
}

function parseViralVideoAnalysis(value: unknown, expectedProjectId: string): ViralVideoAnalysis | null {
  const raw = asRecord(value);
  const projectId = asString(raw.projectId ?? raw.project_id);
  const id = asString(raw.id);
  const createdAt = asString(raw.createdAt ?? raw.created_at);
  const evidenceRaw = asRecord(raw.evidence);
  const breakdownRaw = asRecord(raw.breakdown);
  if (projectId !== expectedProjectId || !id || !createdAt || !isViralVideoPlatform(evidenceRaw.platform)) return null;
  const sourceUrl = optionalPublicUrl(evidenceRaw.sourceUrl ?? evidenceRaw.source_url);
  const canonicalUrl = optionalPublicUrl(evidenceRaw.canonicalUrl ?? evidenceRaw.canonical_url) || sourceUrl;
  const rawPath = relativeVideoEvidencePath(evidenceRaw.rawPath ?? evidenceRaw.raw_path, expectedProjectId);
  const normalizedPath = relativeVideoEvidencePath(evidenceRaw.normalizedPath ?? evidenceRaw.normalized_path, expectedProjectId);
  if (!sourceUrl || !rawPath || !normalizedPath) return null;
  const coverFields = videoCoverFields(evidenceRaw, projectId);
  const evidence: ViralVideoEvidence = {
    projectId,
    platform: evidenceRaw.platform,
    sourceUrl,
    canonicalUrl,
    capturedAt: asString(evidenceRaw.capturedAt ?? evidenceRaw.captured_at) || createdAt,
    fingerprint: asString(evidenceRaw.fingerprint) || hash(`${projectId}:${canonicalUrl}`),
    title: asString(evidenceRaw.title),
    author: asString(evidenceRaw.author),
    publishedAt: asString(evidenceRaw.publishedAt ?? evidenceRaw.published_at),
    metrics: parseMetricMap(evidenceRaw.metrics),
    ...coverFields,
    videoUrl: optionalPublicUrl(evidenceRaw.videoUrl ?? evidenceRaw.video_url),
    primaryText: asString(evidenceRaw.primaryText ?? evidenceRaw.primary_text).slice(0, MAX_VIDEO_PRIMARY_TEXT_CHARS),
    primaryTextSource: asString(evidenceRaw.primaryTextSource ?? evidenceRaw.primary_text_source),
    durationMs: typeof evidenceRaw.durationMs === 'number' && Number.isFinite(evidenceRaw.durationMs) && evidenceRaw.durationMs >= 0
      ? evidenceRaw.durationMs
      : typeof evidenceRaw.duration_ms === 'number' && Number.isFinite(evidenceRaw.duration_ms) && evidenceRaw.duration_ms >= 0
        ? evidenceRaw.duration_ms
        : null,
    missingFields: asStringList(evidenceRaw.missingFields ?? evidenceRaw.missing_fields),
    analysisFields: parseVideoAnalysisFields(evidenceRaw.analysisFields ?? evidenceRaw.analysis_fields),
    rawPath,
    normalizedPath,
  };
  const status = breakdownRaw.status === 'ready' ? 'ready' : breakdownRaw.status === 'limited' ? 'limited' : '';
  const angles = (Array.isArray(breakdownRaw.angles) ? breakdownRaw.angles : [])
    .map((angle, index) => parseViralVideoAngle(angle, id, index))
    .filter((angle): angle is ViralVideoAngle => Boolean(angle));
  if (!status || angles.length !== 3) return null;
  const whyItWorks = asStringList(breakdownRaw.whyItWorks ?? breakdownRaw.why_it_works);
  const reusablePractices = asStringList(
    breakdownRaw.reusablePractices
    ?? breakdownRaw.reusable_practices
    ?? breakdownRaw.reusableMethods
    ?? breakdownRaw.reusable_methods,
  );
  return {
    id,
    projectId,
    createdAt,
    evidence,
    breakdown: {
      status,
      topic: safeGeneratedText(breakdownRaw.topic),
      hook: safeGeneratedText(breakdownRaw.hook),
      audience: safeGeneratedText(breakdownRaw.audience),
      whyItWorks: whyItWorks.map((item) => safeGeneratedText(item)),
      structure: safeGeneratedList(breakdownRaw.structure),
      expressionMethods: safeGeneratedList(breakdownRaw.expressionMethods ?? breakdownRaw.expression_methods),
      // Existing local archives did not persist this dedicated field. Their
      // evidence-based mechanism notes remain the least surprising fallback.
      reusablePractices: (reusablePractices.length ? reusablePractices : whyItWorks).map((item) => safeGeneratedText(item)),
      productionNotes: safeGeneratedList(breakdownRaw.productionNotes ?? breakdownRaw.production_notes),
      guardrails: safeGeneratedList(breakdownRaw.guardrails),
      angles,
      qualityWarnings: safeGeneratedList(breakdownRaw.qualityWarnings ?? breakdownRaw.quality_warnings).slice(0, 8),
    },
  };
}

async function readLatestVideoAnalysis(projectId: string): Promise<ViralVideoAnalysis | null> {
  const value = await readJson<unknown>(pathsForProject(projectId).videoAnalysis, null);
  return parseViralVideoAnalysis(value, projectId);
}

async function readWeeklyState(projectId: string): Promise<WeeklyState> {
  const state = await readJson<WeeklyState>(pathsForProject(projectId).status, emptyWeeklyState(projectId));
  if (state.schema !== 'aifios.benchmark-advisor.weekly-state.v2' || state.projectId !== projectId) return emptyWeeklyState(projectId);
  return {
    ...emptyWeeklyState(projectId),
    ...state,
    lastRefreshAt: typeof state.lastRefreshAt === 'string' ? state.lastRefreshAt : null,
    nextRefreshAt: typeof state.nextRefreshAt === 'string' ? state.nextRefreshAt : null,
    unreadChangeSummary: state.unreadChangeSummary === true,
    changeSummary: typeof state.changeSummary === 'string' ? state.changeSummary : '',
    desktopNotifiedAt: typeof state.desktopNotifiedAt === 'string' ? state.desktopNotifiedAt : null,
    lastAttemptAt: typeof state.lastAttemptAt === 'string' ? state.lastAttemptAt : null,
    lastRefreshError: state.lastRefreshError ? '平台数据连接失败。请到系统设置检查密钥后重试。' : '',
    lastRefreshErrorCode: typeof state.lastRefreshErrorCode === 'string' ? state.lastRefreshErrorCode : undefined,
    lastRefreshDebugId: typeof state.lastRefreshDebugId === 'string' && /^[a-z0-9_-]{6,80}$/i.test(state.lastRefreshDebugId)
      ? state.lastRefreshDebugId
      : undefined,
  };
}

function weeklyView(state: WeeklyState) {
  const next = state.nextRefreshAt ? new Date(state.nextRefreshAt).getTime() : 0;
  return {
    lastRefreshAt: state.lastRefreshAt,
    nextRefreshAt: state.nextRefreshAt,
    refreshDue: !next || Number.isNaN(next) || next <= Date.now(),
    unreadChangeSummary: state.unreadChangeSummary,
    changeSummary: state.changeSummary,
    lastAttemptAt: state.lastAttemptAt,
    lastRefreshError: state.lastRefreshError,
  };
}

function desktopReminder(state: WeeklyState): BenchmarkAdvisorDesktopReminder {
  const refreshStamp = state.lastRefreshAt || '';
  return {
    shouldNotify: Boolean(refreshStamp && state.unreadChangeSummary && state.changeSummary && state.desktopNotifiedAt !== refreshStamp),
    message: state.changeSummary || '参考账号的本周分析已更新。',
    refreshedAt: state.lastRefreshAt,
  };
}

function parseEvidenceLink(value: unknown): BenchmarkEvidenceLink | null {
  const item = asRecord(value);
  const url = asString(item.url);
  const capturedAt = asString(item.captured_at ?? item.capturedAt);
  const kind = asString(item.kind);
  if (!/^https?:\/\//.test(url) || !capturedAt || !['profile', 'work', 'comment'].includes(kind)) return null;
  return { url, capturedAt, kind: kind as BenchmarkEvidenceKind };
}

function parseMetricMap(value: unknown): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(asRecord(value))) {
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) result[key] = raw;
  }
  return result;
}

function parseWorkStructureAnalysis(value: unknown): BenchmarkWorkStructureAnalysis {
  const raw = asRecord(value);
  return {
    status: raw.status === 'ready' ? 'ready' : 'limited',
    topicSignals: asStringList(raw.topic_signals ?? raw.topicSignals).slice(0, 8),
    promiseTypes: asStringList(raw.promise_types ?? raw.promiseTypes).slice(0, 8),
    narrativeStructure: asStringList(raw.narrative_structure ?? raw.narrativeStructure).slice(0, 8),
    proofSignals: asStringList(raw.proof_signals ?? raw.proofSignals).slice(0, 8),
    ctaTypes: asStringList(raw.cta_types ?? raw.ctaTypes).slice(0, 8),
    visualSignals: asStringList(raw.visual_signals ?? raw.visualSignals).slice(0, 8),
    basis: asStringList(raw.basis).slice(0, 12),
    evidenceLimits: asStringList(raw.evidence_limits ?? raw.evidenceLimits).slice(0, 8),
  };
}

function parseEvidenceAccount(value: unknown): BenchmarkAccountEvidence | null {
  const item = asRecord(value);
  const accountId = asString(item.account_id ?? item.accountId);
  if (!/^benchmark_[a-f0-9]{12,32}$/.test(accountId) || !isBenchmarkPlatform(item.platform)) return null;
  const profile = asRecord(item.profile);
  const works = asRecord(item.works);
  const comments = asRecord(item.comments);
  const parseSection = (section: Record<string, unknown>) => ({
    status: section.status === 'available' ? 'available' as const : 'unavailable' as const,
    links: (Array.isArray(section.links) ? section.links : []).map(parseEvidenceLink).filter((link): link is BenchmarkEvidenceLink => Boolean(link)),
    reason: section.status === 'available' ? '' : '这部分公开信息暂时不可用，请稍后重试。',
  });
  const workItems = (Array.isArray(works.items) ? works.items : []).map((raw) => {
    const work = asRecord(raw);
    return {
      sourceUrl: asString(work.source_url ?? work.sourceUrl),
      publishedAt: asString(work.published_at ?? work.publishedAt),
      capturedAt: asString(work.captured_at ?? work.capturedAt),
      format: asString(work.format),
      metrics: parseMetricMap(work.metrics),
      openingMechanisms: asStringList(work.opening_mechanisms ?? work.openingMechanisms),
      ctaPresent: work.cta_present === true || work.ctaPresent === true,
      interactionSignal: asString(work.interaction_signal ?? work.interactionSignal),
      title: asString(work.title),
      author: asString(work.author ?? work.account ?? work.creator),
      summary: asString(work.summary ?? work.hook),
      coverImage: asString(work.cover_image ?? work.coverImage ?? work.thumbnail),
      coverPath: asString(work.cover_path ?? work.coverPath),
      coverContentType: asString(work.cover_content_type ?? work.coverContentType),
      embedUrl: asString(work.embed_url ?? work.embedUrl),
      primaryText: asString(work.primary_text ?? work.primaryText),
      primaryTextSource: asString(work.primary_text_source ?? work.primaryTextSource),
      structureAnalysis: parseWorkStructureAnalysis(work.structure_analysis ?? work.structureAnalysis),
    } satisfies BenchmarkWorkEvidence;
  }).filter((work) => work.sourceUrl || work.title || work.openingMechanisms.length || Object.keys(work.metrics).length);
  const rawEntryValues = item.raw_entries ?? item.rawEntries;
  const rawEntries = (Array.isArray(rawEntryValues) ? rawEntryValues : []).map((raw: unknown) => {
    const entry = asRecord(raw);
    return {
      kind: asString(entry.kind),
      endpointId: asString(entry.endpoint_id ?? entry.endpointId),
      path: asString(entry.path),
      sha256: asString(entry.sha256),
      capturedAt: asString(entry.captured_at ?? entry.capturedAt),
    };
  }).filter((entry: { path: string; sha256: string }) => entry.path && entry.sha256);
  const evidenceLinkValues = item.evidence_links ?? item.evidenceLinks;
  return {
    accountId,
    platform: item.platform,
    status: item.status === 'available' ? 'available' : 'unavailable',
    capturedAt: asString(item.captured_at ?? item.capturedAt),
    reason: item.status === 'available' ? '' : '这次没有读到该账号的公开信息，请检查账号后重试。',
    profile: {
      ...parseSection(profile),
      publicMetricFields: asStringList(profile.public_metric_fields ?? profile.publicMetricFields),
    },
    works: { ...parseSection(works), items: workItems },
    comments: parseSection(comments),
    rawEntries,
    evidenceLinks: (Array.isArray(evidenceLinkValues) ? evidenceLinkValues : [])
      .map(parseEvidenceLink).filter((link: BenchmarkEvidenceLink | null): link is BenchmarkEvidenceLink => Boolean(link)),
  };
}

function parseCollectorResult(value: unknown, expectedProjectId: string): BenchmarkResearchEvidence {
  const payload = asRecord(value);
  if (payload.status === 'blocked') {
    throw new BenchmarkAdvisorInputError('平台数据没有通过检查。请检查账号链接后重试。');
  }
  const projectId = asString(payload.project_id ?? payload.projectId);
  if (projectId !== expectedProjectId) throw new BenchmarkAdvisorInputError('平台数据和当前项目不匹配。请重新获取。');
  const snapshotPath = asString(payload.snapshot_path ?? payload.snapshotPath);
  const normalizedPath = asString(payload.normalized_path ?? payload.normalizedPath);
  if (!snapshotPath.startsWith(`${ADVISOR_ROOT_RELATIVE}/${projectId}/`) || !normalizedPath.startsWith(`${ADVISOR_ROOT_RELATIVE}/${projectId}/`)) {
    throw new BenchmarkAdvisorInputError('平台数据的保存位置不正确。请重新获取。');
  }
  return {
    projectId,
    snapshotPath,
    normalizedPath,
    capturedAt: asString(payload.captured_at ?? payload.capturedAt) || now(),
    accounts: (Array.isArray(payload.accounts) ? payload.accounts : []).map(parseEvidenceAccount).filter((item): item is BenchmarkAccountEvidence => Boolean(item)),
  };
}

async function writeCollectorAccounts(accounts: BenchmarkAccount[]): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), BENCHMARK_COLLECTOR_TEMP_PREFIX));
  const path = join(directory, 'accounts.json');
  await writeFile(path, JSON.stringify(accounts), { encoding: 'utf-8', mode: 0o600 });
  return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

export const collectBenchmarkAdvisorEvidence: BenchmarkEvidenceCollector = async (projectId, accounts) => {
  const input = await writeCollectorAccounts(accounts);
  try {
    const { stdout } = await execFileAsync(runtimePythonBinary(), [
      BENCHMARK_COLLECTOR_SCRIPT,
      '--project', PROJECT_DIR,
      '--project-id', projectId,
      '--accounts', `@${input.path}`,
    ], {
      cwd: INSTALL_ROOT,
      maxBuffer: 1024 * 1024 * 8,
      timeout: 90_000,
    });
    return parseCollectorResult(JSON.parse(stdout) as unknown, projectId);
  } catch {
    throw new BenchmarkAdvisorInputError('平台数据连接失败。请到系统设置检查密钥后重试。');
  } finally {
    await input.cleanup();
  }
};

function parseViralVideoCollectorResult(value: unknown, expectedProjectId: string): ViralVideoEvidence {
  const payload = asRecord(value);
  if (payload.status === 'blocked' || payload.status === 'failed' || payload.status === 'unavailable') {
    throw new BenchmarkAdvisorInputError('没有读到这条视频的公开信息。请检查链接后重试。');
  }
  const candidate = Object.keys(asRecord(payload.evidence)).length ? asRecord(payload.evidence) : payload;
  const projectId = asString(candidate.project_id ?? candidate.projectId);
  if (projectId !== expectedProjectId) throw new BenchmarkAdvisorInputError('单条视频证据不属于当前项目。');
  if (!isViralVideoPlatform(candidate.platform)) throw new BenchmarkAdvisorInputError('仅支持抖音、视频号或小红书的公开视频链接。');
  const sourceUrl = optionalPublicUrl(candidate.source_url ?? candidate.sourceUrl);
  const canonicalUrl = optionalPublicUrl(candidate.canonical_url ?? candidate.canonicalUrl) || sourceUrl;
  const rawPath = relativeVideoEvidencePath(candidate.raw_path ?? candidate.rawPath, expectedProjectId);
  const normalizedPath = relativeVideoEvidencePath(candidate.normalized_path ?? candidate.normalizedPath, expectedProjectId);
  if (!sourceUrl || !rawPath || !normalizedPath) {
    throw new BenchmarkAdvisorInputError('平台数据没有返回这条视频的原始来源。请确认链接可以公开访问后重试。');
  }
  const coverFields = videoCoverFields(candidate, projectId);
  return {
    projectId,
    platform: candidate.platform,
    sourceUrl,
    canonicalUrl,
    capturedAt: asString(candidate.captured_at ?? candidate.capturedAt) || now(),
    fingerprint: asString(candidate.fingerprint) || hash(`${projectId}:${canonicalUrl}:${asString(candidate.captured_at ?? candidate.capturedAt)}`),
    title: asString(candidate.title),
    author: asString(candidate.author),
    publishedAt: asString(candidate.published_at ?? candidate.publishedAt),
    metrics: parseMetricMap(candidate.metrics),
    ...coverFields,
    videoUrl: optionalPublicUrl(candidate.video_url ?? candidate.videoUrl),
    primaryText: asString(candidate.primary_text ?? candidate.primaryText).slice(0, MAX_VIDEO_PRIMARY_TEXT_CHARS),
    primaryTextSource: asString(candidate.primary_text_source ?? candidate.primaryTextSource),
    durationMs: typeof candidate.duration_ms === 'number' && Number.isFinite(candidate.duration_ms) && candidate.duration_ms >= 0
      ? candidate.duration_ms
      : typeof candidate.durationMs === 'number' && Number.isFinite(candidate.durationMs) && candidate.durationMs >= 0
        ? candidate.durationMs
        : null,
    missingFields: asStringList(candidate.missing_fields ?? candidate.missingFields),
    analysisFields: parseVideoAnalysisFields(candidate.analysis_fields ?? candidate.analysisFields),
    rawPath,
    normalizedPath,
  };
}

export const collectViralVideoEvidence: ViralVideoEvidenceCollector = async (projectId, sourceUrl) => {
  const url = optionalPublicUrl(sourceUrl);
  if (!url) throw new BenchmarkAdvisorInputError('请粘贴有效的公开视频链接。');
  try {
    const { stdout } = await execFileAsync(runtimePythonBinary(), [
      VIRAL_VIDEO_COLLECTOR_SCRIPT,
      '--project', PROJECT_DIR,
      '--project-id', projectId,
      '--source-url', url,
    ], {
      cwd: INSTALL_ROOT,
      maxBuffer: 1024 * 1024 * 12,
      // Two bounded source attempts plus the evidence-only model pass. The
      // collector itself has tighter per-step limits, while this remains a
      // final guard against a stalled child process.
      timeout: 80_000,
    });
    return parseViralVideoCollectorResult(JSON.parse(stdout) as unknown, projectId);
  } catch {
    throw new BenchmarkAdvisorInputError('平台数据连接失败。请到系统设置检查密钥后重试。');
  }
};

function textList(value: unknown, maxItems = 6): string[] {
  return asStringList(value).map((item) => item.slice(0, 300)).filter(Boolean).slice(0, maxItems);
}

function buildVideoAngle(analysisId: string, index: number, title: string, rationale: string, adoptionText: string): ViralVideoAngle {
  return {
    id: `viral_angle_${hash(`${analysisId}:${index}:${title}`).slice(0, 16)}`,
    title,
    rationale,
    adoptionText,
    proposedExperiment: '用自己的素材分别做一个 30 秒口播开头和一页观点图文，记录完播、评论问题与收藏。',
    guardrail: '不复制原账号的人设、标题、原文、经历、镜头、配乐或视觉。只测试这套写法是否适合自己。',
  };
}

function limitedVideoBreakdown(evidence: ViralVideoEvidence, analysisId: string, reason: string): ViralVideoBreakdown {
  const analysisFields = evidence.analysisFields;
  const topic = analysisFields.topic || evidence.title || '公开视频主题待人工确认';
  const hook = analysisFields.openingHook || (evidence.title ? `标题呈现的入口：${evidence.title}` : '未取得可读标题，不能可靠判断开场。');
  return {
    status: 'limited',
    topic,
    hook,
    audience: '缺少完整字幕或正文，暂不推断受众画像。',
    whyItWorks: [reason, evidence.title ? '这里只把标题、互动和公开信息当作参考。' : '现有文字不够，暂时不能判断这条内容为什么有效。'],
    structure: analysisFields.narrativeStructure.length ? analysisFields.narrativeStructure : ['公开文字不够，暂时不能还原完整内容结构。', '请先打开原内容检查，再决定是否借鉴。'],
    expressionMethods: analysisFields.expressionMethods.length ? analysisFields.expressionMethods : [evidence.primaryText ? `可读文字来自：${evidence.primaryTextSource || '公开文字字段'}。` : '没有取得字幕、转写文本或正文，不猜测具体写法。'],
    reusablePractices: analysisFields.reusableMethods.length ? analysisFields.reusableMethods : [
      '先打开原内容检查开头和上下文，不要只看标题。',
      evidence.title ? '把问题换成自己读者的真实场景，再用自己的事实回答。' : '补足来源文字后，再判断哪些做法值得借鉴。',
      '使用后记录自己的完播、评论和收藏，不追求复刻原内容。',
    ],
    productionNotes: Array.from(new Set([
      ...analysisFields.productionNotes,
      evidence.durationMs ? `公开时长：${Math.max(1, Math.round(evidence.durationMs / 1000))} 秒。` : '公开时长未返回。',
      evidence.coverImage ? '已保留公开封面链接，可在原内容页人工核验。' : '公开封面未返回。',
      !evidence.coverImage && (evidence.firstFrameImage || evidence.coverSource === 'video_first_frame') ? '来源提供了视频首帧，页面会明确按“视频首帧”展示，不作为正式封面。' : '未取得可验证的首帧素材。',
      ...analysisFields.evidenceLimits,
    ])),
    guardrails: ['现有信息不够，这不是完整的逐镜头或逐句分析。', '不复制原账号的身份、声音、标题、原文或视觉。'],
    angles: [
      buildVideoAngle(analysisId, 0, '从自己的真实问题切入', '把可见入口改造成自己受众正在面对的具体问题，而不是复述原视频主题。', '用一个自有场景提出问题，再用一条自己验证过的事实推进回答。'),
      buildVideoAngle(analysisId, 1, '把结论拆成可验证步骤', '用自己的案例把主题改写为可执行、可检查的小步骤。', '用“误区 - 判断 - 第一步”的结构重写，不沿用原视频的句子或事例。'),
      buildVideoAngle(analysisId, 2, '把观点转成一页分享卡', '保留问题密度，用自己的证据压缩成一条独立观点。', '做一页“一个反问 + 一个判断 + 一个行动”的图文，不使用原封面或标题。'),
    ],
  };
}

function jsonObjectFromCompletion(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  try {
    const parsed = JSON.parse(candidate) as unknown;
    return asRecord(parsed);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return asRecord(JSON.parse(candidate.slice(start, end + 1)) as unknown);
    } catch {
      return null;
    }
  }
}

function parseGeneratedVideoBreakdown(value: unknown, evidence: ViralVideoEvidence, analysisId: string): ViralVideoBreakdown | null {
  const raw = asRecord(value);
  const rawAngles = Array.isArray(raw.angles) ? raw.angles : [];
  const angles = rawAngles.map((item, index) => {
    const angle = asRecord(item);
    const title = asString(angle.title);
    const rationale = asString(angle.rationale);
    const adoptionText = asString(angle.adoptionText ?? angle.adoption_text);
    if (!title || !rationale || !adoptionText) return null;
    return buildVideoAngle(analysisId, index, title.slice(0, 80), rationale.slice(0, 500), adoptionText.slice(0, 500));
  }).filter((angle): angle is ViralVideoAngle => Boolean(angle));
  if (angles.length !== 3) return null;
  const lists = {
    whyItWorks: textList(raw.whyItWorks ?? raw.why_it_works),
    structure: textList(raw.structure).length ? textList(raw.structure) : textList(evidence.analysisFields.narrativeStructure),
    expressionMethods: textList(raw.expressionMethods ?? raw.expression_methods).length ? textList(raw.expressionMethods ?? raw.expression_methods) : textList(evidence.analysisFields.expressionMethods),
    reusablePractices: textList(raw.reusablePractices ?? raw.reusable_practices ?? raw.reusableMethods ?? raw.reusable_methods).length
      ? textList(raw.reusablePractices ?? raw.reusable_practices ?? raw.reusableMethods ?? raw.reusable_methods)
      : textList(evidence.analysisFields.reusableMethods),
    productionNotes: textList(raw.productionNotes ?? raw.production_notes).length ? textList(raw.productionNotes ?? raw.production_notes) : textList(evidence.analysisFields.productionNotes),
  };
  if (!lists.whyItWorks.length || !lists.structure.length || !lists.expressionMethods.length) return null;
  return {
    status: 'ready',
    topic: asString(raw.topic).slice(0, 200) || evidence.title || '本条视频的公开主题',
    hook: asString(raw.hook).slice(0, 300) || evidence.title || '未从证据中确认开场文本。',
    audience: asString(raw.audience).slice(0, 300) || '仅依据公开视频文本判断，需用自己的受众反馈验证。',
    ...lists,
    reusablePractices: lists.reusablePractices.length ? lists.reusablePractices : lists.whyItWorks,
    guardrails: [
      '只借鉴选题、内容结构和写法，不复制原账号的人设、标题、原文、经历、镜头、声音或视觉。',
      '所有改写角度必须以自己的事实、案例和观点重新完成。',
    ],
    angles,
  };
}

function hasUnsupportedNumericVideoClaim(value: unknown, evidence: ViralVideoEvidence): boolean {
  const generated = JSON.stringify(value);
  const supported = JSON.stringify({
    title: evidence.title,
    publishedAt: evidence.publishedAt,
    metrics: evidence.metrics,
    durationMs: evidence.durationMs,
    analysisFields: evidence.analysisFields,
    primaryText: evidence.primaryText,
  });
  const claimPattern = /\d+(?:\.\d+)?\s*(?:%|万|亿|秒|分钟|小时|天|点赞|评论|转发|收藏|播放)/g;
  return (generated.match(claimPattern) || []).some((claim) => !supported.includes(claim.replace(/\s+/g, ''))
    && !supported.replace(/\s+/g, '').includes(claim.replace(/\s+/g, '')));
}

export const generateViralVideoBreakdown: ViralVideoBreakdownGenerator = async (evidence) => {
  const analysisId = `viral_video_${hash(`${evidence.projectId}:${evidence.fingerprint}`).slice(0, 20)}`;
  if (!evidence.primaryText.trim()) {
    return limitedVideoBreakdown(evidence, analysisId, '平台数据没有返回字幕、转写文本或正文，因此不会只看标题猜测整条视频。');
  }
  const factualInput = JSON.stringify({
    platform: evidence.platform,
    title: evidence.title,
    author: evidence.author,
    publishedAt: evidence.publishedAt,
    metrics: evidence.metrics,
    durationMs: evidence.durationMs,
    analysisFields: evidence.analysisFields,
    primaryTextSource: evidence.primaryTextSource,
    primaryText: evidence.primaryText,
  });
  try {
    const config = await resolveServerLLMConfig(null);
    const completion = await createLLMTextCompletion(config, [
      {
        role: 'system',
        content: [
          '你是内容研究顾问。只基于给定的公开视频事实拆解可借鉴的选题、内容结构与表达方法。不要复述、改写或模仿原文；不要编造镜头、受众、数据或作者经历。仅输出一个合法 JSON 对象，不要 Markdown。',
          PRODUCT_VOICE_INSTRUCTION,
        ].join('\n\n'),
      },
      {
        role: 'user',
        content: [
          '请返回字段：topic, hook, audience, whyItWorks(string[]), structure(string[]), expressionMethods(string[]), reusablePractices(string[]), productionNotes(string[]), angles(刚好 3 项)。',
          '把它写成可扫描的拆解：structure 按推进顺序给 3-6 步；expressionMethods、reusablePractices、productionNotes 各给 2-5 条具体且可检查的观察。事实不足时直接写“不足”，不要用泛泛而谈的套话填充。',
          '每个 angle 必须含 title, rationale, adoptionText；它们必须是原创的、自有事实可执行的改写方向，不得复用原账号的标题、语气、身份或案例。',
          '如果证据不足，请明确写“不足”，不要补造细节。',
          `事实：${factualInput}`,
        ].join('\n\n'),
      },
    ], { temperature: 0.25, maxTokens: 2400, timeoutMs: 30_000 });
    const languageReview = inspectGeneratedLanguage(completion);
    if (languageReview.blocking.length > 0) {
      return limitedVideoBreakdown(evidence, analysisId, '本次分析含有无关说明，已改为只显示公开事实。');
    }
    const parsed = jsonObjectFromCompletion(completion);
    if (parsed && hasUnsupportedNumericVideoClaim(parsed, evidence)) {
      return limitedVideoBreakdown(evidence, analysisId, '本次分析出现了公开信息无法核对的数字，现在只显示能确认的内容。');
    }
    const breakdown = parsed ? parseGeneratedVideoBreakdown(parsed, evidence, analysisId) : null;
    if (breakdown) {
      return {
        ...breakdown,
        ...(languageReview.warnings.length
          ? { qualityWarnings: languageReview.warnings.map((finding) => finding.message) }
          : {}),
      };
    }
    return limitedVideoBreakdown(evidence, analysisId, '这次返回的分析不完整，现在只显示能从公开来源确认的内容。');
  } catch {
    return limitedVideoBreakdown(evidence, analysisId, '这次没有完成内容分析。已保留公开信息和可以手动核对的改写方向。');
  }
};

function accountEvidenceMap(evidence: BenchmarkResearchEvidence): Map<string, BenchmarkAccountEvidence> {
  return new Map(evidence.accounts.map((item) => [item.accountId, item]));
}

function mechanismsForEvidence(evidence: BenchmarkAccountEvidence | undefined): string[] {
  if (!evidence || evidence.status !== 'available') return [];
  return Array.from(new Set(evidence.works.items.flatMap((item) => item.openingMechanisms)))
    .filter((mechanism) => mechanism && !mechanism.includes('待人工核验'))
    .slice(0, 6);
}

function patternsForWorks(works: BenchmarkWorkEvidence[]): BenchmarkPattern[] {
  const analysisFor = (work: BenchmarkWorkEvidence): BenchmarkWorkStructureAnalysis => (
    work.structureAnalysis || parseWorkStructureAnalysis(null)
  );
  const valuesForWork = (work: BenchmarkWorkEvidence): Array<[BenchmarkPattern['dimension'], string[]]> => {
    const analysis = analysisFor(work);
    const sequenceSignalsAreReady = analysis.status === 'ready';
    return [
      ['topic', analysis.topicSignals],
      ['promise', analysis.promiseTypes],
      ['structure', sequenceSignalsAreReady ? analysis.narrativeStructure : []],
      ['proof', sequenceSignalsAreReady ? analysis.proofSignals : []],
      ['cta', sequenceSignalsAreReady ? analysis.ctaTypes : []],
      ['visual', analysis.visualSignals],
    ];
  };
  const matches = new Map<string, { dimension: BenchmarkPattern['dimension']; label: string; urls: Set<string> }>();
  works.forEach((work, index) => {
    for (const [dimension, labels] of valuesForWork(work)) {
      for (const label of new Set(labels.filter(Boolean))) {
        const key = `${dimension}:${label}`;
        const match = matches.get(key) || { dimension, label, urls: new Set<string>() };
        match.urls.add(work.sourceUrl || `sample:${index}`);
        matches.set(key, match);
      }
    }
  });
  return Array.from(matches.values()).map((match) => ({
    dimension: match.dimension,
    label: match.label,
    sampleCount: match.urls.size,
    sampleUrls: Array.from(match.urls).filter((url) => /^https?:\/\//.test(url)).slice(0, 6),
    confidence: match.urls.size >= 2 ? 'repeated' as const : 'single_sample' as const,
  })).sort((left, right) => (
    Number(right.confidence === 'repeated') - Number(left.confidence === 'repeated')
    || right.sampleCount - left.sampleCount
    || left.dimension.localeCompare(right.dimension)
    || left.label.localeCompare(right.label, 'zh-CN')
  )).slice(0, 24);
}

function patternsForEvidence(evidence: BenchmarkAccountEvidence | undefined): BenchmarkPattern[] {
  if (!evidence || evidence.status !== 'available') return [];
  return patternsForWorks(evidence.works.items);
}

function evidenceLinksFor(evidence: BenchmarkAccountEvidence | undefined): BenchmarkEvidenceLink[] {
  return evidence?.evidenceLinks.slice(0, 4) || [];
}

function evidenceFingerprint(evidence: BenchmarkResearchEvidence): string {
  return hash(JSON.stringify(evidence.accounts.map((item) => ({
    id: item.accountId,
    status: item.status,
    links: item.evidenceLinks.map((link) => [link.url, link.kind]),
    mechanisms: mechanismsForEvidence(item),
    patterns: patternsForEvidence(item).map((pattern) => [pattern.dimension, pattern.label, pattern.sampleCount]),
    works: item.works.items.map((work) => [work.sourceUrl, work.publishedAt, work.format, work.metrics, work.structureAnalysis]),
  })).sort((left, right) => left.id.localeCompare(right.id))));
}

function evidenceOverview(evidence: BenchmarkResearchEvidence): TikOmniAdvisorEvidence {
  const available = evidence.accounts.filter((item) => item.status === 'available' && item.evidenceLinks.length);
  return {
    status: available.length ? 'available' : 'unavailable',
    snapshotPath: evidence.snapshotPath,
    normalizedPath: evidence.normalizedPath,
    capturedAt: evidence.capturedAt,
    accountEvidenceCount: available.length,
    unavailableAccountCount: evidence.accounts.length - available.length,
    note: available.length
      ? '这里只使用项目内保存的公开来源。没有读到数据的账号会明确标出，不用手填印象代替。'
      : '当前没有可核对的账号数据。手填标签和旧记录不会被当成账号分析结果。',
  };
}

function assertCompleteTikOmniAdvisorEvidence(accounts: BenchmarkAccount[], evidence: BenchmarkResearchEvidence): void {
  const byAccount = accountEvidenceMap(evidence);
  const failures = accounts.flatMap((account) => {
    const item = byAccount.get(account.id);
    if (!item) return [`${account.label}：没有获取到账号信息`];
    if (item.platform !== account.platform) return [`${account.label}：返回的平台不匹配`];
    if (item.status !== 'available') return [`${account.label}：${advisorGeneratedDisplayText(item.reason || '账号公开信息暂时不可用')}`];
    if (!item.evidenceLinks.length || !item.rawEntries.length) {
      return [`${account.label}：没有返回可核对的公开链接`];
    }
    return [];
  });
  if (failures.length || evidence.accounts.length !== accounts.length) {
    throw new BenchmarkAdvisorInputError(
      `账号分析没有完成：${failures.join('；') || '账号信息不完整'}。已保留上次成功的结果，请检查后重试。`,
    );
  }
}

function evidenceStrength(evidence: BenchmarkAccountEvidence | undefined): string {
  if (!evidence || evidence.status !== 'available') return '数据不足：这次没有读到账号公开信息';
  const workCount = evidence.works.items.length;
  const links = evidence.evidenceLinks.length;
  return `已验证 ${links} 条公开链接、${workCount} 条公开作品元数据`;
}

function cadenceText(works: BenchmarkWorkEvidence[]): string {
  const dates = Array.from(new Set(works.map((item) => item.publishedAt).filter(Boolean))).sort();
  if (dates.length < 2) return dates.length ? '作品日期不足，暂时看不出发布频率' : '没有可核对的作品日期';
  return `参考内容覆盖 ${dates[0]} 至 ${dates.at(-1)}，只用来估算发布频率`;
}

function metricText(works: BenchmarkWorkEvidence[]): string {
  const comments = works.reduce((total, item) => total + (item.metrics.comments || 0), 0);
  const shares = works.reduce((total, item) => total + (item.metrics.shares || 0), 0);
  return `可见评论 ${comments}、分享 ${shares}；不做因果归因`;
}

function comparisonValue(
  dimension: string,
  account: BenchmarkAccount,
  evidence: BenchmarkAccountEvidence | undefined,
): string {
  const works = evidence?.works.items || [];
  const mechanisms = mechanismsForEvidence(evidence);
  const patterns = patternsForEvidence(evidence);
  const repeated = (dimension: BenchmarkPattern['dimension']) => patterns.filter((pattern) => (
    pattern.dimension === dimension && pattern.confidence === 'repeated'
  ));
  const patternText = (dimension: BenchmarkPattern['dimension']) => repeated(dimension)
    .map((pattern) => `${pattern.label}（${pattern.sampleCount}/${works.length}）`)
    .join('、');
  if (!evidence || evidence.status !== 'available') return `不可用：${evidence?.reason || '尚未采到可验证公开证据'}`;
  switch (dimension) {
    case '定位': return `操作者标注：${account.focus || '未标注'}；${evidenceStrength(evidence)}`;
    case '受众线索': return mechanisms.length ? `常见开头：${mechanisms.join('、')}` : '公开信息不够，暂时不判断受众';
    case '主题分布': return patternText('topic') || '没有在至少 2 条作品中重复出现的主题信号';
    case '内容形式': return Array.from(new Set(works.map((item) => item.format).filter(Boolean))).join('、') || '未返回可验证形式字段';
    case '开场机制': return mechanisms.join('、') || '还没有从公开信息中找到重复的开头做法';
    case '叙事推进': return patternText('structure') || (works.length ? '尚无跨作品重复结构；查看单条结构和证据限制' : '无可验证作品');
    case '证据方法': return patternText('proof') || '没有在至少 2 条作品中重复出现的论证信号';
    case 'CTA': return patternText('cta') || `${works.filter((item) => item.ctaPresent).length}/${works.length} 条作品出现结尾引导，还看不出固定做法`;
    case '互动': return metricText(works);
    case '更新节奏': return cadenceText(works);
    case '证据强度': return evidenceStrength(evidence);
    case '可迁移机制': {
      const transferable = patterns.filter((pattern) => (
        pattern.confidence === 'repeated' && ['promise', 'structure', 'proof', 'cta'].includes(pattern.dimension)
      ));
      return transferable.length
        ? transferable.map((pattern) => `${pattern.label}（${pattern.sampleCount} 条重复）`).join('、')
        : '当前只出现过一次；至少在 2 条作品中重复出现后再借鉴';
    }
    case '不可迁移条件': return '不复制账号的人设、资源、经历、标题、原文、视觉或声音；只测试内容结构';
    default: return '待核验';
  }
}

function buildComparison(accounts: BenchmarkAccount[], evidence: BenchmarkResearchEvidence): BenchmarkComparisonRow[] {
  const byAccount = accountEvidenceMap(evidence);
  const dimensions = ['定位', '受众线索', '主题分布', '内容形式', '开场机制', '叙事推进', '证据方法', 'CTA', '互动', '更新节奏', '证据强度', '可迁移机制', '不可迁移条件'];
  return dimensions.map((dimension) => ({
    dimension,
    cells: accounts.map((account) => {
      const item = byAccount.get(account.id);
      return { accountId: account.id, value: comparisonValue(dimension, account, item), evidenceLinks: evidenceLinksFor(item) };
    }),
  }));
}

function actionId(reportId: string, index: number): string {
  return `advisor_action_${hash(`${reportId}:${index}`).slice(0, 16)}`;
}

function buildActions(reportId: string, accounts: BenchmarkAccount[], evidence: BenchmarkResearchEvidence): BenchmarkAction[] {
  const byAccount = accountEvidenceMap(evidence);
  const available = accounts.filter((account) => byAccount.get(account.id)?.status === 'available');
  const mechanisms = available.flatMap((account) => mechanismsForEvidence(byAccount.get(account.id)));
  const repeatedPatterns = available.flatMap((account) => patternsForEvidence(byAccount.get(account.id)))
    .filter((pattern) => pattern.confidence === 'repeated' && ['promise', 'structure', 'proof', 'cta'].includes(pattern.dimension))
    .sort((left, right) => right.sampleCount - left.sampleCount);
  const mechanism = advisorGeneratedDisplayText(repeatedPatterns[0]?.label || mechanisms[0] || '补齐公开来源');
  const links = available.flatMap((account) => evidenceLinksFor(byAccount.get(account.id))).slice(0, 4);
  const values: Omit<BenchmarkAction, 'id'>[] = [
    {
      priority: 'P0',
      title: available.length ? '先验证一个自己的读者问题' : '先补齐参考账号的公开来源',
      rationale: available.length
        ? '已经取得部分账号公开信息，但这些信息不能代替你自己的读者反馈。'
        : '当前没有读到账号数据，不能只凭手填标签得出结论。',
      mechanism: available.length ? '问题入口与事实边界' : '补齐公开来源',
      adoptionText: '本期文章提纲先写清：谁在什么场景遇到什么可核对的问题；只用自己的素材、案例和引用回答它。',
      guardrail: '不复制任何账号的人设、语气、标题、原文、视觉、经历或声音。',
      proposedExperiment: '未来 4 周：围绕同一真实问题测试两种自有开场，记录评论问题与完成率，只比较自身发布数据。',
      evidenceLinks: links,
    },
    {
      priority: 'P1',
      title: `把「${mechanism}」改写成自己的结构`,
      rationale: available.length ? '账号对比只能说明哪些内容结构重复出现，不能证明照着写就有效。' : '等平台数据恢复后，再确认这套做法是否真的出现。',
      mechanism,
      adoptionText: `在公众号文章、口播稿和图文页里，用自己的事实实现「${mechanism}」。每一段只推进一个判断。`,
      guardrail: '不把第三方的观点、经历、标题、图卡、镜头、评论或风格迁移到本期内容。',
      proposedExperiment: '未来 4 周：在两条同主题内容中分别用“具体问题”和“方法结构”开场，结尾引导保持不变，再对比评论和收藏。',
      evidenceLinks: links,
    },
    {
      priority: 'P2',
      title: '建立下周的证据复核清单',
      rationale: '公开内容会变化。每次判断都要能回到原链接和获取时间。',
      mechanism: '证据复核',
      adoptionText: '下周补充公开链接、获取时间、作品信息和自己的发布结果，再决定是否修改判断。',
      guardrail: '没有可核对的链接时直接标为不可用，不用模型推测或旧记录代替。',
      proposedExperiment: '未来 4 周：每周只新增一条可验证的公开观察，并记录它是否改变了自己的选题优先级。',
      evidenceLinks: links,
    },
  ];
  return values.map((action, index) => ({ ...action, id: actionId(reportId, index) }));
}

function hasMaterialResearchChange(previous: BenchmarkReport | undefined, accounts: BenchmarkAccount[], evidence: BenchmarkResearchEvidence): boolean {
  if (!previous) return true;
  return previous.accountFingerprint !== accountFingerprint(accounts) || previous.evidenceFingerprint !== evidenceFingerprint(evidence);
}

function changeSummary(previous: BenchmarkReport | undefined, accounts: BenchmarkAccount[], evidence: BenchmarkResearchEvidence): string {
  if (!previous) return `已完成 ${accounts.length} 个参考账号的第一次分析。`;
  const changed = previous.accountFingerprint !== accountFingerprint(accounts);
  const evidenceChanged = previous.evidenceFingerprint !== evidenceFingerprint(evidence);
  if (!changed && !evidenceChanged) return '本周没有检测到账号配置或已验证公开证据的实质变化。';
  return [changed ? '账号设置或手动备注有更新' : '', evidenceChanged ? '账号公开信息有更新' : ''].filter(Boolean).join('；') + '。只更新分析结果，不复制任何账号的表达风格。';
}

function buildReport(accounts: BenchmarkAccount[], evidence: BenchmarkResearchEvidence, previous?: BenchmarkReport): BenchmarkReport {
  const generatedAt = now();
  const fingerprint = accountFingerprint(accounts);
  const reportId = `benchmark_report_${hash(`${fingerprint}:${evidenceFingerprint(evidence)}:${generatedAt}`).slice(0, 20)}`;
  const byAccount = accountEvidenceMap(evidence);
  return {
    id: reportId,
    generatedAt,
    accountFingerprint: fingerprint,
    evidenceFingerprint: evidenceFingerprint(evidence),
    accounts: accounts.map((account) => {
      const item = byAccount.get(account.id);
      return {
        id: account.id,
        label: account.label,
        handle: account.handle,
        platform: account.platform,
        publicUrl: account.publicUrl,
        focus: account.focus,
        mechanisms: mechanismsForEvidence(item),
        patterns: patternsForEvidence(item),
        works: item?.works.items || [],
        observationStatus: item?.status === 'available' ? 'ready' : 'needs_observation',
        evidenceStatus: item?.status === 'available' ? 'available' : 'unavailable',
        evidenceLinks: evidenceLinksFor(item),
        evidenceReason: item?.reason || '',
      };
    }),
    comparison: buildComparison(accounts, evidence),
    actions: buildActions(reportId, accounts, evidence),
    evidence: evidenceOverview(evidence),
    changeSummary: changeSummary(previous, accounts, evidence),
  };
}

function benchmarkReportLanguageText(report: BenchmarkReport): string {
  return [
    ...report.accounts.flatMap((account) => [
      ...account.mechanisms,
      account.evidenceReason,
    ]),
    ...report.comparison.flatMap((row) => row.cells.map((cell) => cell.value)),
    ...report.actions.flatMap((action) => [
      action.title,
      action.rationale,
      action.mechanism,
      action.adoptionText,
      action.guardrail,
      action.proposedExperiment,
    ]),
    report.evidence.note,
    report.changeSummary,
  ].filter(Boolean).join('\n');
}

function formatCitation(links: BenchmarkEvidenceLink[]): string {
  const link = links[0];
  return link ? `来源：${link.url}（${link.capturedAt}）` : '来源：当前没有可核对的公开链接。';
}

function comparisonDimensionDisplayName(dimension: string): string {
  const labels: Record<string, string> = {
    '定位': '账号定位',
    '受众线索': '可能的读者',
    '主题分布': '常讲的主题',
    '内容形式': '常用形式',
    '开场机制': '常用开头',
    '叙事推进': '内容顺序',
    '证据方法': '怎么让人相信',
    'CTA': '结尾引导',
    '互动': '互动数据',
    '更新节奏': '发布频率',
    '证据强度': '数据完整度',
    '可迁移机制': '可以借鉴的方法',
    '不可迁移条件': '不要复制的内容',
  };
  return labels[dimension] || dimension;
}

function recentUserQuestion(history: AdvisorChatMessage[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === 'user' && history[index]?.content.trim()) return history[index].content.trim();
  }
  return '';
}

function questionContext(question: string, history: AdvisorChatMessage[]): string {
  const normalized = question.trim().toLowerCase();
  const continuation = /^(为什么|为何|然后|继续|展开|具体|这个|那|它|怎么|如何|下一步|再说)/.test(normalized) || normalized.length <= 8;
  const previous = recentUserQuestion(history).toLowerCase();
  return continuation && previous ? `${previous} ${normalized}` : normalized;
}

function comparisonRowsForQuestion(report: BenchmarkReport, context: string): BenchmarkComparisonRow[] {
  const groups: Array<{ terms: string[]; dimensions: string[] }> = [
    { terms: ['开头', '开场', '钩子', '叙事', '结构'], dimensions: ['开场机制', '叙事推进', '内容形式'] },
    { terms: ['cta', '转化', '互动', '评论', '线索'], dimensions: ['CTA', '互动', '受众线索'] },
    { terms: ['更新', '频率', '节奏', '发布'], dimensions: ['更新节奏', '主题分布', '内容形式'] },
    { terms: ['定位', '人群', '受众', '差异', '对比'], dimensions: ['定位', '受众线索', '可迁移机制', '不可迁移条件'] },
  ];
  const selected = groups.find((group) => group.terms.some((term) => context.includes(term)));
  const dimensions = selected?.dimensions || ['可迁移机制', '不可迁移条件', '证据强度'];
  return dimensions
    .map((dimension) => report.comparison.find((row) => row.dimension === dimension))
    .filter((row): row is BenchmarkComparisonRow => Boolean(row));
}

function accountsForQuestion(report: BenchmarkReport, context: string): BenchmarkReport['accounts'] {
  const matched = report.accounts.filter((account) => {
    const label = account.label.toLowerCase();
    const handle = account.handle.toLowerCase();
    return (label.length > 1 && context.includes(label)) || (handle.length > 1 && context.includes(handle));
  });
  return matched.length ? matched : report.accounts;
}

function uniqueEvidenceLinks(accounts: BenchmarkReport['accounts']): BenchmarkEvidenceLink[] {
  return Array.from(new Map(accounts.flatMap((account) => account.evidenceLinks).map((link) => [link.url, link])).values()).slice(0, 3);
}

function actionLinesForQuestion(report: BenchmarkReport, context: string): string[] {
  const asksWhy = /为什么|为何|依据|证据/.test(context);
  const asksExperiment = /实验|测试|四周|计划|下一步|优先|先做|怎么做/.test(context);
  const actions = asksExperiment ? report.actions : report.actions.slice(0, 2);
  return actions.map((action) => {
    const detail = asksWhy ? action.rationale : asksExperiment ? action.proposedExperiment : action.adoptionText;
    return `${action.priority} ${action.title}：${detail}`;
  });
}

function advisorReply(question: string, report: BenchmarkReport | null, history: AdvisorChatMessage[]): string {
  if (!report) return '先添加 1 至 5 个已获授权的公开账号，再开始分析。结论只使用原链接和获取时间，不会模仿账号的声音或内容。';
  const context = questionContext(question, history);
  const directQuestion = question.trim().toLowerCase();
  const comparedAccounts = accountsForQuestion(report, context);
  const rows = comparisonRowsForQuestion(report, context);
  const asksExperiment = /实验|测试|四周|计划|下一步|优先|先做|怎么做/.test(directQuestion);
  const asksComparison = !asksExperiment && (/对比|差异|区别|哪个|谁/.test(context) || rows.some((row) => /开场|叙事|定位|互动|节奏/.test(row.dimension)));
  const comparison = rows.map((row) => {
    const cells = row.cells
      .filter((cell) => comparedAccounts.some((account) => account.id === cell.accountId))
      .map((cell) => `${report.accounts.find((account) => account.id === cell.accountId)?.label || cell.accountId}：${advisorGeneratedDisplayText(cell.value)}`);
    return `${comparisonDimensionDisplayName(row.dimension)}：${cells.join(' / ')}`;
  }).filter(Boolean);
  const citations = uniqueEvidenceLinks(comparedAccounts);
  const accountScope = comparedAccounts.length === 1
    ? `这次只看 ${comparedAccounts[0].label} 的参考内容。`
    : `这次对比 ${comparedAccounts.length} 个账号的公开内容。`;
  const historyHint = recentUserQuestion(history)
    ? `已延续本项目上一轮问题「${recentUserQuestion(history).slice(0, 80)}」。`
    : '';
  const body = asksComparison && comparison.length
    ? comparison.join('\n')
    : actionLinesForQuestion(report, context).join('\n');
  return [
    accountScope,
    historyHint,
    body,
    ...citations.map((link) => formatCitation([link])),
    '先用自己的事实完成“优先”项，再测试“其次”项的内容结构。“可选”项留到最后。',
    '接下来 4 周，只测试自己内容的开头、结构和结尾引导。记下评论问题和咨询线索即可。',
  ].filter(Boolean).join('\n\n');
}

function validRunId(value: string): boolean {
  return /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(value);
}

function runAdoptionPath(runId: string): string {
  return runtimeJoin(PROJECT_DIR, 'runs', runId, 'benchmark-advisor', 'adopted-conclusions.json');
}

async function runProjectId(runId: string): Promise<string> {
  const path = safeResolve(PROJECT_DIR, runtimeJoin('runs', `${runId}.json`));
  if (!path) throw new BenchmarkAdvisorInputError('内容任务路径不正确。');
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file');
    const payload = asRecord(JSON.parse(await readFile(path, 'utf-8')) as unknown);
    const projectId = asString(payload.project_id);
    if (!PROJECT_ID_RE.test(projectId)) throw new Error('project id missing');
    return projectId;
  } catch {
    throw new BenchmarkAdvisorInputError('当前内容任务不完整。请回到“做本期内容”重新打开后再试。');
  }
}

export async function getBenchmarkAdvisorState(projectIdValue: unknown): Promise<BenchmarkAdvisorState> {
  const projectId = parseProjectId(projectIdValue);
  const paths = pathsForProject(projectId);
  const [config, archive, chat, weekly, latestVideoAnalysis] = await Promise.all([
    readConfig(projectId),
    readArchive(projectId),
    readChat(projectId),
    readWeeklyState(projectId),
    readLatestVideoAnalysis(projectId),
  ]);
  return {
    projectId,
    authorizationConfirmed: Boolean(config.authorizationConfirmedAt),
    accounts: config.accounts,
    latestReport: archive.reports[0] || null,
    latestVideoAnalysis,
    reportCount: archive.reports.length,
    chatHistory: chat.messages,
    weekly: weeklyView(weekly),
    archivePaths: {
      accounts: toRelative(paths.config),
      research: toRelative(paths.archive),
      chat: toRelative(paths.chat),
      evidence: `${ADVISOR_ROOT_RELATIVE}/${projectId}/`,
      videoAnalysis: toRelative(paths.videoAnalysis),
    },
  };
}

export async function saveBenchmarkAccounts(
  projectIdValue: unknown,
  value: unknown,
  authorizationConfirmed: unknown,
): Promise<BenchmarkAdvisorState> {
  const projectId = parseProjectId(projectIdValue);
  if (authorizationConfirmed !== true) throw new BenchmarkAdvisorInputError('保存前，请确认已获得查看这些公开账号并保存分析结果的授权。');
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ACCOUNTS) {
    throw new BenchmarkAdvisorInputError(`请添加 1 至 ${MAX_ACCOUNTS} 个公开参考账号。`);
  }
  const previous = await readConfig(projectId);
  const previousById = new Map(previous.accounts.map((account) => [account.id, account]));
  const accounts = value.map((item) => {
    const raw = asRecord(item);
    return parseAccount(item, previousById.get(asString(raw.id)));
  });
  const ids = new Set<string>();
  const identities = new Set<string>();
  for (const account of accounts) {
    if (ids.has(account.id)) throw new BenchmarkAdvisorInputError('这个参考账号已经添加过了。');
    ids.add(account.id);
    const identity = `${account.platform}:${account.publicUrl.toLowerCase()}`;
    if (identities.has(identity)) throw new BenchmarkAdvisorInputError('同一公开账号不能重复配置。');
    identities.add(identity);
  }
  await writeJson(pathsForProject(projectId).config, {
    schema: 'aifios.benchmark-advisor.accounts.v2',
    projectId,
    authorizationConfirmedAt: previous.authorizationConfirmedAt || now(),
    updatedAt: now(),
    accounts,
  } satisfies AccountConfig);
  return getBenchmarkAdvisorState(projectId);
}

export async function refreshBenchmarkAdvisorResearch(
  projectIdValue: unknown,
  collector: BenchmarkEvidenceCollector = collectBenchmarkAdvisorEvidence,
): Promise<BenchmarkAdvisorState> {
  const projectId = parseProjectId(projectIdValue);
  const [config, archive, weekly] = await Promise.all([readConfig(projectId), readArchive(projectId), readWeeklyState(projectId)]);
  if (!config.authorizationConfirmedAt) throw new BenchmarkAdvisorInputError('请先确认已获授权，再更新账号分析。');
  if (!config.accounts.length) throw new BenchmarkAdvisorInputError('请先添加至少 1 个公开参考账号。');
  let evidence: BenchmarkResearchEvidence;
  try {
    evidence = await collector(projectId, config.accounts);
    if (evidence.projectId !== projectId) throw new BenchmarkAdvisorInputError('平台数据和当前项目不匹配。请重新获取。');
    assertCompleteTikOmniAdvisorEvidence(config.accounts, evidence);
  } catch {
    const debugId = `benchmark_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    await writeJson(pathsForProject(projectId).status, {
      ...weekly,
      lastAttemptAt: now(),
      lastRefreshError: '平台数据连接失败。请到系统设置检查密钥后重试。',
      lastRefreshErrorCode: 'benchmark_platform_data_failed',
      lastRefreshDebugId: debugId,
    } satisfies WeeklyState);
    throw new BenchmarkAdvisorInputError('平台数据连接失败。请到系统设置检查密钥后重试。');
  }
  const previous = archive.reports[0];
  const reportDraft = buildReport(config.accounts, evidence, previous);
  const languageReview = inspectGeneratedLanguage(benchmarkReportLanguageText(reportDraft));
  if (languageReview.blocking.length) {
    throw new BenchmarkAdvisorInputError('账号分析里出现了不适合展示的信息，请重新获取平台数据。');
  }
  const report: BenchmarkReport = {
    ...reportDraft,
    qualityWarnings: languageReview.warnings.map((finding) => finding.message).slice(0, 8),
  };
  const materialChanged = hasMaterialResearchChange(previous, config.accounts, evidence);
  const refreshedAt = now();
  const paths = pathsForProject(projectId);
  await Promise.all([
    writeJson(paths.archive, {
      schema: 'aifios.benchmark-advisor.research.v2',
      projectId,
      reports: [report, ...archive.reports].slice(0, MAX_REPORTS),
    } satisfies ResearchArchive),
    writeJson(paths.status, {
      schema: 'aifios.benchmark-advisor.weekly-state.v2',
      projectId,
      lastRefreshAt: refreshedAt,
      nextRefreshAt: new Date(Date.now() + WEEK_MS).toISOString(),
      unreadChangeSummary: materialChanged ? true : weekly.unreadChangeSummary,
      changeSummary: materialChanged ? report.changeSummary : weekly.changeSummary,
      desktopNotifiedAt: materialChanged ? null : (weekly.desktopNotifiedAt ? refreshedAt : null),
      lastAttemptAt: refreshedAt,
      lastRefreshError: '',
      lastRefreshErrorCode: undefined,
      lastRefreshDebugId: undefined,
    } satisfies WeeklyState),
  ]);
  return getBenchmarkAdvisorState(projectId);
}

export async function analyzeBenchmarkVideo(
  projectIdValue: unknown,
  sourceUrlValue: unknown,
  collector: ViralVideoEvidenceCollector = collectViralVideoEvidence,
  generator: ViralVideoBreakdownGenerator = generateViralVideoBreakdown,
): Promise<BenchmarkAdvisorState & { cached: boolean }> {
  const projectId = parseProjectId(projectIdValue);
  const sourceUrl = optionalPublicUrl(sourceUrlValue);
  if (!sourceUrl || !isSupportedViralVideoUrl(sourceUrl)) {
    throw new BenchmarkAdvisorInputError('请粘贴有效的抖音、视频号或小红书公开视频链接。');
  }
  const latest = await readLatestVideoAnalysis(projectId);
  if (latest && (latest.evidence.sourceUrl === sourceUrl || latest.evidence.canonicalUrl === sourceUrl)) {
    return { ...await getBenchmarkAdvisorState(projectId), cached: true };
  }
  let evidence: ViralVideoEvidence;
  try {
    evidence = await collector(projectId, sourceUrl);
  } catch {
    throw new BenchmarkAdvisorInputError('平台数据连接失败。请到系统设置检查密钥后重试。');
  }
  if (evidence.projectId !== projectId) throw new BenchmarkAdvisorInputError('单条视频证据不属于当前项目。');
  if (!isViralVideoPlatform(evidence.platform)) throw new BenchmarkAdvisorInputError('仅支持抖音、视频号或小红书的公开视频链接。');
  if (!relativeVideoEvidencePath(evidence.rawPath, projectId) || !relativeVideoEvidencePath(evidence.normalizedPath, projectId)) {
    throw new BenchmarkAdvisorInputError('单条视频证据路径不属于当前项目。');
  }
  const createdAt = now();
  const analysisId = `viral_video_${hash(`${projectId}:${evidence.fingerprint}:${createdAt}`).slice(0, 20)}`;
  const breakdown = await generator({ ...evidence, primaryText: evidence.primaryText.slice(0, MAX_VIDEO_PRIMARY_TEXT_CHARS) });
  if (!breakdown || !['ready', 'limited'].includes(breakdown.status) || breakdown.angles.length !== 3) {
    throw new BenchmarkAdvisorInputError('单条视频拆解未生成完整的 3 个原创改写方向。');
  }
  const languageReview = inspectGeneratedLanguage(JSON.stringify(breakdown));
  if (languageReview.blocking.length) {
    throw new BenchmarkAdvisorInputError('视频分析里出现了不适合展示的信息，请重新分析这条视频。');
  }
  const checkedBreakdown: ViralVideoBreakdown = {
    ...breakdown,
    qualityWarnings: Array.from(new Set([
      ...(breakdown.qualityWarnings || []),
      ...languageReview.warnings.map((finding) => finding.message),
    ])).slice(0, 8),
  };
  const analysis: ViralVideoAnalysis = {
    id: analysisId,
    projectId,
    createdAt,
    evidence: { ...evidence, projectId, primaryText: evidence.primaryText.slice(0, MAX_VIDEO_PRIMARY_TEXT_CHARS) },
    breakdown: checkedBreakdown,
  };
  await writeJson(pathsForProject(projectId).videoAnalysis, {
    schema: 'aifios.benchmark-advisor.single-video.v1',
    ...analysis,
  });
  return { ...await getBenchmarkAdvisorState(projectId), cached: false };
}

type AdvisorChatContext = {
  accountId?: string;
  workUrl?: string;
  videoAnalysisId?: string;
};

function parseAdvisorChatContext(value: unknown, report: BenchmarkReport | null, video: ViralVideoAnalysis | null): AdvisorChatContext {
  const raw = asRecord(value);
  const accountId = asString(raw.accountId ?? raw.account_id);
  const workUrl = optionalPublicUrl(raw.workUrl ?? raw.work_url);
  const videoAnalysisId = asString(raw.videoAnalysisId ?? raw.video_analysis_id);
  const matchingAccount = report?.accounts.find((account) => account.id === accountId);
  const matchingWork = (matchingAccount?.works || []).find((work) => work.sourceUrl === workUrl);
  return {
    ...(matchingAccount ? { accountId: matchingAccount.id } : {}),
    ...(matchingWork ? { workUrl: matchingWork.sourceUrl } : {}),
    ...(video && videoAnalysisId === video.id ? { videoAnalysisId: video.id } : {}),
  };
}

function videoAdvisorReply(question: string, analysis: ViralVideoAnalysis): string {
  const directQuestion = question.trim();
  const asksStructure = /结构|叙事|推进|开头|钩子/.test(directQuestion);
  const asksExpression = /表达|说法|文案|语气|口播/.test(directQuestion);
  const asksAction = /怎么做|下一步|采用|改写|实验|行动/.test(directQuestion);
  const focus = asksStructure
    ? analysis.breakdown.structure
    : asksExpression
      ? analysis.breakdown.expressionMethods
      : asksAction
        ? analysis.breakdown.angles.map((angle) => `${angle.title}：${angle.adoptionText}`)
        : analysis.breakdown.whyItWorks;
  return [
    `当前围绕《${analysis.evidence.title || '这条公开视频'}》提供建议。`,
    ...focus.map((item) => `- ${advisorGeneratedDisplayText(item)}`),
    `公开证据：${analysis.evidence.sourceUrl}（${analysis.evidence.capturedAt}）`,
    ...analysis.breakdown.guardrails.map((item) => `边界：${advisorGeneratedDisplayText(item)}`),
  ].filter(Boolean).join('\n\n');
}

export async function sendBenchmarkAdvisorMessage(
  projectIdValue: unknown,
  value: unknown,
  contextValue?: unknown,
): Promise<BenchmarkAdvisorState> {
  const projectId = parseProjectId(projectIdValue);
  const question = safeText(value, '问题', 2000);
  const [archive, chat, video] = await Promise.all([readArchive(projectId), readChat(projectId), readLatestVideoAnalysis(projectId)]);
  const report = archive.reports[0] || null;
  const context = parseAdvisorChatContext(contextValue, report, video);
  const contextualVideo = context.videoAnalysisId && video?.id === context.videoAnalysisId ? video : null;
  const contextualHistory = chat.messages.filter((message) => {
    if (contextualVideo) return message.videoAnalysisId === contextualVideo.id;
    if (context.accountId || context.workUrl) {
      return message.context?.accountId === context.accountId
        && (!context.workUrl || message.context?.workUrl === context.workUrl);
    }
    return true;
  });
  const contextFields = Object.keys(context).length ? { context: { accountId: context.accountId, workUrl: context.workUrl } } : {};
  const userMessage: AdvisorChatMessage = {
    id: `advisor_message_${randomUUID().replace(/-/g, '')}`,
    role: 'user',
    content: question,
    createdAt: now(),
    ...(report ? { reportId: report.id } : {}),
    ...(contextualVideo ? { videoAnalysisId: contextualVideo.id } : {}),
    ...contextFields,
  };
  const responseMessage: AdvisorChatMessage = {
    id: `advisor_message_${randomUUID().replace(/-/g, '')}`,
    role: 'advisor',
    content: contextualVideo ? videoAdvisorReply(question, contextualVideo) : advisorReply(question, report, contextualHistory),
    createdAt: now(),
    ...(report ? { reportId: report.id } : {}),
    ...(contextualVideo ? { videoAnalysisId: contextualVideo.id } : {}),
    ...contextFields,
  };
  const responseLanguageReview = inspectGeneratedLanguage(responseMessage.content);
  if (responseLanguageReview.blocking.length) {
    throw new BenchmarkAdvisorInputError('这次建议里出现了不适合展示的信息，请重新提问。');
  }
  responseMessage.qualityWarnings = responseLanguageReview.warnings.map((finding) => finding.message).slice(0, 8);
  await writeJson(pathsForProject(projectId).chat, {
    schema: 'aifios.benchmark-advisor.chat.v2',
    projectId,
    messages: [...chat.messages, userMessage, responseMessage].slice(-MAX_CHAT_MESSAGES),
  } satisfies ChatArchive);
  return getBenchmarkAdvisorState(projectId);
}

export async function adoptBenchmarkAdvisorAction(
  projectIdValue: unknown,
  runIdValue: unknown,
  actionIdValue: unknown,
): Promise<{ runId: string; path: string; adoptedCount: number; action: BenchmarkAction }> {
  const projectId = parseProjectId(projectIdValue);
  const runId = safeText(runIdValue, '内容任务 ID', 100);
  if (!validRunId(runId)) throw new BenchmarkAdvisorInputError('内容任务 ID 格式不正确。');
  const actionId = safeText(actionIdValue, '分析建议', 100);
  const runPath = safeResolve(PROJECT_DIR, runtimeJoin('runs', `${runId}.json`));
  if (!runPath) throw new BenchmarkAdvisorInputError('内容任务路径不正确。');
  try {
    const info = await lstat(runPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file');
  } catch {
    throw new BenchmarkAdvisorInputError('没有找到本期内容。请回到“做本期内容”重新打开后再试。');
  }
  const boundProjectId = await runProjectId(runId);
  if (boundProjectId !== projectId) {
    throw new BenchmarkAdvisorInputError('这条建议属于另一个项目，不能用到当前内容。');
  }
  const archive = await readArchive(projectId);
  const report = archive.reports[0];
  const action = report?.actions.find((candidate) => candidate.id === actionId);
  if (!report || !action) throw new BenchmarkAdvisorInputError('这条建议不是当前项目的最新结果。请更新分析后重试。');
  const path = runAdoptionPath(runId);
  const existing = await readJson<{ projectId?: string; adopted?: Array<BenchmarkAction & { adoptedAt: string; reportId: string; projectId: string }> }>(path, {});
  if (asString(existing.projectId) && asString(existing.projectId) !== projectId) {
    throw new BenchmarkAdvisorInputError('当前内容已使用另一个项目的分析建议，不能混用。');
  }
  const adopted = Array.isArray(existing.adopted) ? existing.adopted : [];
  if (adopted.some((item) => asString(asRecord(item).projectId) && asString(asRecord(item).projectId) !== projectId)) {
    throw new BenchmarkAdvisorInputError('当前内容里有其他项目的分析建议。请先检查项目归属。');
  }
  const next = adopted.some((item) => item?.id === action.id && item?.projectId === projectId) ? adopted : [
    ...adopted,
    { ...action, adoptedAt: now(), reportId: report.id, projectId },
  ];
  await writeJson(path, {
    schema: 'aifios.benchmark-advisor.run-adoption.v2',
    runId,
    projectId,
    updatedAt: now(),
    sourceReportId: report.id,
    adopted: next,
    guardrails: [
      '只借鉴能说明来源的内容做法，不复制参考账号的人设、语气、句式、标题、视觉、经历或声音。',
      '这是人工选中记录，不能代替本期平台数据和用户确认。',
    ],
  });
  return { runId, path: toRelative(path), adoptedCount: next.length, action };
}

export async function adoptBenchmarkVideoAngle(
  projectIdValue: unknown,
  runIdValue: unknown,
  analysisIdValue: unknown,
  angleIdValue: unknown,
): Promise<{ runId: string; path: string; adoptedCount: number; action: BenchmarkAction }> {
  const projectId = parseProjectId(projectIdValue);
  const runId = safeText(runIdValue, '内容任务 ID', 100);
  if (!validRunId(runId)) throw new BenchmarkAdvisorInputError('内容任务 ID 格式不正确。');
  const analysisId = safeText(analysisIdValue, '单条视频拆解', 120);
  const angleId = safeText(angleIdValue, '改写方向', 120);
  const runPath = safeResolve(PROJECT_DIR, runtimeJoin('runs', `${runId}.json`));
  if (!runPath) throw new BenchmarkAdvisorInputError('内容任务路径不正确。');
  try {
    const info = await lstat(runPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('not a regular file');
  } catch {
    throw new BenchmarkAdvisorInputError('没有找到本期内容。请回到“做本期内容”重新打开后再试。');
  }
  if (await runProjectId(runId) !== projectId) {
    throw new BenchmarkAdvisorInputError('这份视频分析属于另一个项目，不能用到当前内容。');
  }
  const analysis = await readLatestVideoAnalysis(projectId);
  if (!analysis || analysis.id !== analysisId) {
    throw new BenchmarkAdvisorInputError('这份视频分析不是当前项目的最新结果。请重新分析后再试。');
  }
  const angle = analysis.breakdown.angles.find((item) => item.id === angleId);
  if (!angle) throw new BenchmarkAdvisorInputError('改写方向不属于当前单条视频拆解。');
  const action: BenchmarkAction = {
    id: angle.id,
    priority: 'P1',
    title: angle.title,
    rationale: angle.rationale,
    mechanism: '单条视频里可以借鉴的选题、内容结构和写法',
    adoptionText: angle.adoptionText,
    guardrail: angle.guardrail,
    proposedExperiment: angle.proposedExperiment,
    evidenceLinks: [{ url: analysis.evidence.sourceUrl, capturedAt: analysis.evidence.capturedAt, kind: 'work' }],
  };
  const path = runAdoptionPath(runId);
  const existing = await readJson<{ projectId?: string; adopted?: Array<BenchmarkAction & { adoptedAt: string; reportId?: string; sourceAnalysisId?: string; projectId: string }> }>(path, {});
  if (asString(existing.projectId) && asString(existing.projectId) !== projectId) {
    throw new BenchmarkAdvisorInputError('当前内容已使用另一个项目的分析建议，不能混用。');
  }
  const adopted = Array.isArray(existing.adopted) ? existing.adopted : [];
  if (adopted.some((item) => asString(asRecord(item).projectId) && asString(asRecord(item).projectId) !== projectId)) {
    throw new BenchmarkAdvisorInputError('当前内容里有其他项目的分析建议。请先检查项目归属。');
  }
  const next = adopted.some((item) => item?.id === action.id && item?.projectId === projectId)
    ? adopted
    : [...adopted, { ...action, adoptedAt: now(), sourceAnalysisId: analysis.id, projectId }];
  await writeJson(path, {
    schema: 'aifios.benchmark-advisor.run-adoption.v2',
    runId,
    projectId,
    updatedAt: now(),
    sourceVideoAnalysisId: analysis.id,
    adopted: next,
    guardrails: [
      '只借鉴能说明来源的内容做法，不复制原账号的人设、语气、句式、标题、视觉、经历或声音。',
      '单条视频分析必须有当前项目保存的公开来源，不能代替本期平台数据。',
    ],
  });
  return { runId, path: toRelative(path), adoptedCount: next.length, action };
}

export async function benchmarkAdvisorContextForRun(runId: string): Promise<string> {
  if (!validRunId(runId)) return '';
  let projectId = '';
  try {
    projectId = await runProjectId(runId);
  } catch {
    return '';
  }
  const payload = await readJson<{ projectId?: string; adopted?: Array<BenchmarkAction & { adoptedAt?: string; projectId?: string }> }>(runAdoptionPath(runId), {});
  if (asString(payload.projectId) !== projectId) return '';
  const adopted = Array.isArray(payload.adopted)
    ? payload.adopted.filter((item) => asRecord(item).projectId === projectId && asRecord(item).id)
    : [];
  if (!adopted.length) return '';
  return [
    '# 已确认使用的参考账号结论',
    '以下结论只用于调整内容结构和优先级。不得模仿参考账号的人设、语气、句式、标题、视觉或经历，也不能替代本期平台数据。',
    ...adopted.slice(0, 5).map((item) => [
      `- ${item.priority || 'P1'}：${advisorGeneratedDisplayText(item.title || '已选做法')}`,
      `  写作约束：${advisorGeneratedDisplayText(item.adoptionText || '')}`,
      `  边界：${advisorGeneratedDisplayText(item.guardrail || '')}`,
      `  建议实验：${advisorGeneratedDisplayText(item.proposedExperiment || '')}`,
    ].join('\n')),
  ].join('\n');
}

export async function acknowledgeBenchmarkAdvisorNotification(projectIdValue: unknown): Promise<BenchmarkAdvisorState> {
  const projectId = parseProjectId(projectIdValue);
  const state = await readWeeklyState(projectId);
  await writeJson(pathsForProject(projectId).status, { ...state, unreadChangeSummary: false } satisfies WeeklyState);
  return getBenchmarkAdvisorState(projectId);
}

export async function refreshBenchmarkAdvisorIfDue(
  projectIdValue: unknown,
  collector: BenchmarkEvidenceCollector = collectBenchmarkAdvisorEvidence,
): Promise<{ refreshed: boolean; state: BenchmarkAdvisorState; reminder: BenchmarkAdvisorDesktopReminder }> {
  const projectId = parseProjectId(projectIdValue);
  const [config, weekly] = await Promise.all([readConfig(projectId), readWeeklyState(projectId)]);
  if (!config.accounts.length || !config.authorizationConfirmedAt || !weeklyView(weekly).refreshDue) {
    return { refreshed: false, state: await getBenchmarkAdvisorState(projectId), reminder: desktopReminder(weekly) };
  }
  const state = await refreshBenchmarkAdvisorResearch(projectId, collector);
  return { refreshed: true, state, reminder: desktopReminder(await readWeeklyState(projectId)) };
}

export async function getBenchmarkAdvisorDesktopReminder(projectIdValue: unknown): Promise<BenchmarkAdvisorDesktopReminder> {
  return desktopReminder(await readWeeklyState(parseProjectId(projectIdValue)));
}

export async function acknowledgeBenchmarkAdvisorDesktopReminder(projectIdValue: unknown): Promise<BenchmarkAdvisorDesktopReminder> {
  const projectId = parseProjectId(projectIdValue);
  const state = await readWeeklyState(projectId);
  if (!state.lastRefreshAt) return desktopReminder(state);
  const next: WeeklyState = { ...state, desktopNotifiedAt: state.lastRefreshAt };
  await writeJson(pathsForProject(projectId).status, next);
  return desktopReminder(next);
}

export async function listBenchmarkAdvisorProjectIds(): Promise<string[]> {
  const root = runtimeJoin(PROJECT_DIR, ADVISOR_ROOT_RELATIVE);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && PROJECT_ID_RE.test(entry.name)).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

export function benchmarkPlatformLabel(platform: BenchmarkPlatform): string {
  return PLATFORM_LABELS[platform];
}
