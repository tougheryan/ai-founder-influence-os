import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, extname, relative } from 'node:path';
import { assertTextInput, MAX_SHORT_TEXT_BYTES, textByteLength } from './input-limits';
import { PROJECT_DIR, safeResolve } from './project-root';
import { getRuntimeProductionApproval } from './runtime-writer';
import { materialSourceNature, type MaterialSourceNature } from './material-source-nature';
import { materialTitleSuggestion } from './material-title-suggestion';
import { materialWritingRequirements } from './material-writing-requirements';
import type { MaterialUpload } from './material-analysis';

export const RAW_MATERIAL_LIBRARY_SCHEMA = 'aifios.raw-material-library.v1' as const;
export const RAW_MATERIAL_CATEGORIES = ['insight', 'case', 'fact', 'reference', 'brand'] as const;
export const AUTO_ARCHIVE_CONFIDENCE = 0.9;

const STORAGE_PATH = 'materials/library/index.json';
const MAX_RECORDS = 5_000;
const MAX_EVENTS = 2_000;
const MAX_INGEST_ITEMS = 100;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_TITLE_BYTES = 512;
const MAX_REASON_BYTES = 2 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024;
const MAX_SOURCE_LABEL_BYTES = 1_024;
const MAX_LEGACY_FILES = 1_000;
const MAX_PRODUCTION_ARTIFACTS = 40;
const RUN_ID_RE = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/;
const SAFE_PROJECT_SOURCE_ROOTS = ['materials/', 'pipeline/', 'runs/', 'sessions/'] as const;

export type RawMaterialCategory = (typeof RAW_MATERIAL_CATEGORIES)[number];
export type RawMaterialKind = 'text' | 'file' | 'link' | 'production';
export type RawMaterialStatus = 'pending_confirmation' | 'archived';
export type RawMaterialArchiveMethod = 'auto' | 'manual_confirmation' | 'reclassified';
export type RawMaterialSuggestionEngine = 'heuristic' | 'ai' | 'legacy' | 'system';
export type RawMaterialOrigin =
  | 'manual_text'
  | 'manual_file'
  | 'manual_link'
  | 'production_input'
  | 'confirmed_topic'
  | 'research_insight'
  | 'final_content'
  | 'publication_performance'
  | 'legacy_library';

export const RAW_MATERIAL_CATEGORY_META: ReadonlyArray<{
  id: RawMaterialCategory;
  label: string;
  description: string;
}> = [
  { id: 'insight', label: '观点与洞察', description: '判断、方法、灵感和可复用表达。' },
  { id: 'case', label: '案例与经历', description: '客户、项目、人物与真实经历。' },
  { id: 'fact', label: '事实与数据', description: '数据、报告、证据与可核验信息。' },
  { id: 'reference', label: '对标与参考', description: '文章、视频、对标样本与外部链接。' },
  { id: 'brand', label: '品牌与产品资料', description: '产品、服务、用户与品牌信息。' },
] as const;

export type RawMaterialSuggestion = {
  category: RawMaterialCategory;
  /** Decimal confidence, from 0 to 1. The UI can render this as a percentage. */
  confidence: number;
  reason: string;
  summary: string;
  engine: RawMaterialSuggestionEngine;
  generatedAt: string;
};

export type RawMaterialSourceLineage = {
  origin: RawMaterialOrigin;
  importedAt: string;
  sourcePath?: string;
  sourceUrl?: string;
  sourceLabel?: string;
  runId?: string;
  platform?: string;
};

export type RawMaterialRecord = {
  id: string;
  title: string;
  kind: RawMaterialKind;
  /** Text is stored only for text/link/production records and remains local. */
  content?: string;
  category: RawMaterialCategory | null;
  status: RawMaterialStatus;
  suggestion: RawMaterialSuggestion;
  sourceLineage: RawMaterialSourceLineage;
  archivedAt?: string;
  archiveMethod?: RawMaterialArchiveMethod;
  createdAt: string;
  updatedAt: string;
};

export type RawMaterialArchiveEvent = {
  id: string;
  materialId: string;
  action: 'auto_archived' | 'confirmed' | 'reclassified' | 'auto_archive_undone';
  fromCategory: RawMaterialCategory | null;
  toCategory: RawMaterialCategory | null;
  occurredAt: string;
};

type RawMaterialLibraryIndex = {
  schema: typeof RAW_MATERIAL_LIBRARY_SCHEMA;
  updatedAt: string;
  records: RawMaterialRecord[];
  events: RawMaterialArchiveEvent[];
};

export type RawMaterialSummary = Omit<RawMaterialRecord, 'content'> & { sourceNature: MaterialSourceNature };

export type RawMaterialListQuery = {
  status?: 'all' | RawMaterialStatus;
  category?: RawMaterialCategory;
  sort?: 'recent' | 'priority';
  limit?: number;
};

export type RawMaterialListResult = {
  categories: Array<{ id: RawMaterialCategory; label: string; count: number }>;
  totals: {
    total: number;
    all: number;
    archived: number;
    pendingConfirmation: number;
    autoArchived: number;
  };
  items: RawMaterialSummary[];
};

export type RawMaterialDashboard = {
  rawMaterials: RawMaterialListResult['totals'] & {
    categories: RawMaterialListResult['categories'];
  };
  pendingArchiveSuggestions: RawMaterialSummary[];
  recentAutoArchives: Array<{
    event: RawMaterialArchiveEvent;
    item: RawMaterialSummary;
  }>;
};

export type RawMaterialInput = {
  title?: unknown;
  kind?: unknown;
  content?: unknown;
  text?: unknown;
  sourcePath?: unknown;
  path?: unknown;
  sourceUrl?: unknown;
  url?: unknown;
  sourceLineage?: unknown;
  origin?: unknown;
  runId?: unknown;
  platform?: unknown;
  suggestion?: unknown;
};

export type IngestRawMaterialsInput = {
  items: unknown;
  /** Production deposits are idempotent by source lineage. */
  deduplicate?: boolean;
};

export type IngestRawMaterialsResult = {
  records: RawMaterialSummary[];
  created: number;
  existing: number;
  autoArchived: number;
};

export type ProductionArtifactInput = RawMaterialInput & {
  origin?: unknown;
};

export class MaterialLibraryError extends Error {}
export class MaterialLibraryConflictError extends MaterialLibraryError {}

export type RawMaterialDetail = {
  item: RawMaterialRecord;
  content: string;
  version: string;
  contentSource: 'library' | 'file' | 'unread';
};

function materialVersion(item: RawMaterialRecord): string {
  return createHash('sha256').update(JSON.stringify(item)).digest('hex');
}

async function safeLibraryFile(path: string, createParents = false): Promise<string> {
  const normalized = sourcePath(path);
  if (!normalized || normalized !== path) throw new MaterialLibraryError('素材文件路径不正确。');
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    const component = safeResolve(PROJECT_DIR, parts.slice(0, index + 1).join('/'))!;
    if (createParents && index < parts.length - 1) await mkdir(component, { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    try {
      const info = await lstat(component);
      if (info.isSymbolicLink() || (index < parts.length - 1 ? !info.isDirectory() : !info.isFile())) throw new MaterialLibraryError('素材文件不可通过链接或目录读取。');
    } catch (error) {
      if (!createParents || index < parts.length - 1 || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return safeResolve(PROJECT_DIR, path)!;
}

export async function getRawMaterialDetail(id: string): Promise<RawMaterialDetail | null> {
  const item = await getRawMaterialRecord(id);
  if (!item) return null;
  let content = item.content || '';
  let contentSource: RawMaterialDetail['contentSource'] = content ? 'library' : 'unread';
  if (!content && item.sourceLineage.sourcePath && isLikelyTextPath(item.sourceLineage.sourcePath)) {
    try {
      const file = await safeLibraryFile(item.sourceLineage.sourcePath);
      if ((await stat(file)).size <= MAX_CONTENT_BYTES) {
        content = await readFile(file, 'utf8');
        contentSource = 'file';
      }
    } catch (error) {
      if (error instanceof MaterialLibraryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { item, content, contentSource, version: createHash('sha256').update(JSON.stringify({ item, content })).digest('hex') };
}

/** Caller holds the material-library write lock. Original files are never edited. */
export async function updateRawMaterial(input: { id: unknown; expectedVersion: unknown; title: unknown; content: unknown; sourceLabel: unknown; sourceUrl: unknown }): Promise<RawMaterialDetail> {
  const index = await readIndex();
  const item = findRecord(index, cleanRequiredText(input.id, '素材编号', MAX_SHORT_TEXT_BYTES));
  if (input.expectedVersion !== (await getRawMaterialDetail(item.id))?.version) throw new MaterialLibraryConflictError('素材已在其他页面更新。你的文字仍在，请重新读取后再合并。');
  const title = cleanRequiredText(input.title, '素材标题', MAX_TITLE_BYTES);
  const content = cleanOptionalText(input.content, '素材全文', MAX_CONTENT_BYTES) || '';
  const sourceLabel = cleanOptionalText(input.sourceLabel, '来源说明', MAX_SOURCE_LABEL_BYTES);
  const url = sourceUrl(input.sourceUrl);
  if (!content && !item.sourceLineage.sourcePath && !url) throw new MaterialLibraryError('请保留素材全文、来源文件或来源链接中的至少一项。');
  const previous = JSON.stringify(item, null, 2);
  // Keep the previous library record so corrections never erase its provenance.
  const history = await safeLibraryFile(`materials/library/history/${createHash('sha256').update(item.id).digest('hex')}/${materialVersion(item)}.json`, true);
  await writeFile(history, previous, { flag: 'wx', mode: 0o600 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
  item.title = title;
  if (content) item.content = content; else delete item.content;
  if (sourceLabel) item.sourceLineage.sourceLabel = sourceLabel; else delete item.sourceLineage.sourceLabel;
  if (url) item.sourceLineage.sourceUrl = url; else delete item.sourceLineage.sourceUrl;
  item.suggestion.summary = summarizeText({ title, content, sourcePath: item.sourceLineage.sourcePath, sourceUrl: url });
  item.updatedAt = nowIso();
  await writeIndex(index);
  return (await getRawMaterialDetail(item.id))!;
}

/** A new draft quotes an immutable copy, so subsequent library edits cannot change it. */
export async function rawMaterialDraftInput(id: string, expectedVersion: unknown, requestId: unknown, reuse?: { mode?: unknown; topic?: unknown }) {
  const detail = await getRawMaterialDetail(id);
  if (!detail) throw new MaterialLibraryError('这条素材不存在。');
  if (detail.version !== expectedVersion) throw new MaterialLibraryConflictError('素材已更新，请重新读取后再用于写作。');
  if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId)) throw new MaterialLibraryError('请重新发起这次素材复用。');
  const { item, content } = detail;
  if (reuse && !['new_topic', 'same_topic'].includes(String(reuse.mode))) throw new MaterialLibraryError('请选择这次怎样使用素材。');
  const inheritedTopic = materialTitleSuggestion(content);
  const topic = reuse?.mode === 'same_topic' ? inheritedTopic || '' : reuse ? cleanRequiredText(reuse.topic, '这篇题目', MAX_SHORT_TEXT_BYTES) : '';
  if (reuse && (!topic || topic.length > 240 || /[\u0000-\u001f\u007f]/.test(topic))) throw new MaterialLibraryError('请填写 240 字以内的明确题目；没有读到原题目时，请选择写新题目。');
  const choice = reuse ? `:${reuse.mode}:${topic}` : '';
  const draftId = `draft_${createHash('sha256').update(`${id}:${detail.version}:${requestId}${choice}`).digest('hex').slice(0, 32)}`;
  let files: Array<MaterialUpload & { path: string }> = [];
  const links: string[] = [];
  if (content.trim()) {
    const snapshot = [`# ${item.title}`, `> 来源：${item.sourceLineage.sourceLabel || '个人素材库'}`, ...(item.sourceLineage.sourceUrl ? [`> 原始链接：${item.sourceLineage.sourceUrl}`] : []), `> 素材保存时间：${item.updatedAt}`, '', '## 原文', '', content].join('\n');
    const path = `materials/library/reuse/${draftId}.md`;
    const file = await safeLibraryFile(path, true);
    await writeFile(file, snapshot, { flag: 'wx', mode: 0o600 }).catch(async (error) => {
      if (error.code !== 'EEXIST') throw error;
      if (await readFile(file, 'utf8') !== snapshot) throw new MaterialLibraryConflictError('这次引用的素材已经变化，请重新发起写作。');
    });
    files = [{ name: `${item.title}.md`, path, sourcePath: path, size: Buffer.byteLength(snapshot), extractionStatus: 'existing_extraction' }];
  } else if (item.sourceLineage.sourcePath?.startsWith('materials/')) {
    await safeLibraryFile(item.sourceLineage.sourcePath);
    files = [{ name: basename(item.sourceLineage.sourcePath), path: item.sourceLineage.sourcePath, sourcePath: item.sourceLineage.sourcePath }];
  } else if (item.sourceLineage.sourceUrl) links.push(item.sourceLineage.sourceUrl);
  else throw new MaterialLibraryError('素材暂时没有可读取的全文，请补充文字或检查原文件。');
  if (reuse?.mode === 'new_topic') files = files.map((file) => ({ ...file, writingRequirements: 'reference_only' }));
  const requirements = reuse?.mode === 'same_topic' ? materialWritingRequirements(content).join('\n') : '';
  const platforms = [['wechat', '公众号'], ['xhs', '小红书'], ['shipinhao', '视频号']]
    .filter(([, label]) => new RegExp(`(?:^|[，,；;、\\n])\\s*(?:(?:请|只)?(?:写|写成|发|发布到|用于|做)(?:一篇|一条)?|平台[：:]\\s*)?${label}(?=$|[，,；;、\\s])`).test(requirements))
    .map(([platform]) => platform);
  return { id: draftId, name: topic || item.title, expectedVersion: 0, state: { activeStage: 'material-boundary', materialText: reuse?.mode === 'new_topic' ? `题目：${topic}` : '', materialLinks: links, materialFiles: files, notes: {}, draft: { topic, ...(reuse ? { writingMode: 'author_material', writingModeChosen: true } : {}), runId: '', runSlug: '', selectedPlatforms: platforms.length ? platforms : ['wechat'] } } };
}

const CATEGORY_SIGNALS: Record<RawMaterialCategory, readonly string[]> = {
  insight: ['观点', '洞察', '判断', '方法', '框架', '公式', '灵感', '思考', '复盘', '经验'],
  case: ['案例', '客户', '项目', '经历', '故事', '访谈', '实践', '合作', '服务'],
  fact: ['数据', '报告', '研究', '统计', '数字', '事实', '证据', '截图', '指标', '增长率'],
  reference: ['对标', '参考', '爆款', '文章', '视频', '链接', '公众号', '小红书', '抖音', '视频号'],
  brand: ['品牌', '产品', '服务', '用户', '定位', '功能', '商业', '公司', '业务', '客户画像'],
};

const ORIGINS: readonly RawMaterialOrigin[] = [
  'manual_text',
  'manual_file',
  'manual_link',
  'production_input',
  'confirmed_topic',
  'research_insight',
  'final_content',
  'publication_performance',
  'legacy_library',
];

const KINDS: readonly RawMaterialKind[] = ['text', 'file', 'link', 'production'];
const SUGGESTION_ENGINES: readonly RawMaterialSuggestionEngine[] = ['heuristic', 'ai', 'legacy', 'system'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function compactText(value: string, maxBytes: number): string {
  const compacted = normalizeText(value);
  if (textByteLength(compacted) <= maxBytes) return compacted;
  let end = compacted.length;
  while (end > 0 && textByteLength(compacted.slice(0, end)) > maxBytes - 3) end -= 1;
  return `${compacted.slice(0, Math.max(0, end)).trim()}...`;
}

function cleanRequiredText(value: unknown, label: string, maxBytes: number): string {
  const text = assertTextInput(value, label, maxBytes).trim();
  if (!text) throw new MaterialLibraryError(`${label}不能为空。`);
  return text;
}

function cleanOptionalText(value: unknown, label: string, maxBytes: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = assertTextInput(value, label, maxBytes).trim();
  return text || undefined;
}

function cleanRunId(value: unknown, label = 'run ID'): string {
  const runId = cleanRequiredText(value, label, MAX_SHORT_TEXT_BYTES);
  if (!RUN_ID_RE.test(runId)) throw new MaterialLibraryError(`${label}格式不正确。`);
  return runId;
}

function category(value: unknown, label = '素材分类'): RawMaterialCategory {
  const parsed = cleanRequiredText(value, label, MAX_SHORT_TEXT_BYTES);
  if (!(RAW_MATERIAL_CATEGORIES as readonly string[]).includes(parsed)) {
    throw new MaterialLibraryError(`${label}必须是 insight、case、fact、reference 或 brand。`);
  }
  return parsed as RawMaterialCategory;
}

function categoryOrNull(value: unknown): RawMaterialCategory | null {
  return value === null || value === undefined ? null : category(value);
}

function sourcePath(value: unknown): string | undefined {
  const supplied = cleanOptionalText(value, '素材来源路径', MAX_SHORT_TEXT_BYTES);
  if (!supplied) return undefined;
  const normalized = supplied.replace(/\\/g, '/').replace(/^\/+/, '');
  if (
    normalized.includes('..')
    || !SAFE_PROJECT_SOURCE_ROOTS.some((root) => normalized.startsWith(root))
    || !safeResolve(PROJECT_DIR, normalized)
  ) {
    throw new MaterialLibraryError('素材来源路径必须位于本机项目的 materials、pipeline、runs 或 sessions 目录。');
  }
  return normalized;
}

function sourceUrl(value: unknown): string | undefined {
  const supplied = cleanOptionalText(value, '素材来源链接', MAX_SHORT_TEXT_BYTES);
  if (!supplied) return undefined;
  let url: URL;
  try {
    url = new URL(supplied);
  } catch {
    throw new MaterialLibraryError('素材来源链接格式不正确。');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new MaterialLibraryError('素材来源链接仅支持 HTTP 或 HTTPS。');
  }
  if (url.username || url.password) {
    throw new MaterialLibraryError('素材来源链接不能包含账号或密码。');
  }
  return url.toString();
}

function origin(value: unknown, fallback: RawMaterialOrigin): RawMaterialOrigin {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = cleanRequiredText(value, '素材来源类型', MAX_SHORT_TEXT_BYTES);
  if (!(ORIGINS as readonly string[]).includes(parsed)) {
    throw new MaterialLibraryError('素材来源类型不受支持。');
  }
  return parsed as RawMaterialOrigin;
}

function kind(value: unknown, fallback: RawMaterialKind): RawMaterialKind {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = cleanRequiredText(value, '素材形式', MAX_SHORT_TEXT_BYTES);
  if (!(KINDS as readonly string[]).includes(parsed)) {
    throw new MaterialLibraryError('素材形式不受支持。');
  }
  return parsed as RawMaterialKind;
}

function suggestionEngine(value: unknown, fallback: RawMaterialSuggestionEngine): RawMaterialSuggestionEngine {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = cleanRequiredText(value, '归档建议来源', MAX_SHORT_TEXT_BYTES);
  if (!(SUGGESTION_ENGINES as readonly string[]).includes(parsed)) {
    throw new MaterialLibraryError('归档建议来源不受支持。');
  }
  return parsed as RawMaterialSuggestionEngine;
}

function isLikelyTextPath(path: string): boolean {
  return ['.md', '.txt', '.json', '.csv', '.html', '.htm', '.rtf'].includes(extname(path).toLowerCase());
}

function titleFromSource(input: {
  content?: string;
  sourcePath?: string;
  sourceUrl?: string;
  kind: RawMaterialKind;
}): string {
  if (input.content) {
    const firstLine = input.content.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (firstLine) return compactText(firstLine.replace(/^#{1,6}\s*/, ''), MAX_TITLE_BYTES);
  }
  if (input.sourcePath) {
    return basename(input.sourcePath).replace(/\.[A-Za-z0-9]+$/, '') || '未命名素材';
  }
  if (input.sourceUrl) {
    try {
      return new URL(input.sourceUrl).hostname || '外部参考链接';
    } catch {
      return '外部参考链接';
    }
  }
  return input.kind === 'production' ? '本期内容' : '未命名素材';
}

function fallbackOrigin(kindValue: RawMaterialKind): RawMaterialOrigin {
  if (kindValue === 'file') return 'manual_file';
  if (kindValue === 'link') return 'manual_link';
  return 'manual_text';
}

function summarizeText(input: { title: string; content?: string; sourcePath?: string; sourceUrl?: string }): string {
  if (input.content) return compactText(input.content, 220);
  if (input.sourceUrl) return `已保留外部参考链接：${input.sourceUrl}`;
  if (input.sourcePath) return '已保留本机文件，可在技术详情中查看来源。';
  return `已保存素材：${input.title}`;
}

function scoreCategory(source: string, categoryId: RawMaterialCategory): number {
  return CATEGORY_SIGNALS[categoryId].reduce((total, signal) => total + (source.includes(signal) ? 1 : 0), 0);
}

function legacyFolderSuggestion(path: string): Pick<RawMaterialSuggestion, 'category' | 'confidence' | 'reason' | 'engine'> | null {
  if (path.startsWith('materials/hit-library/')) {
    return { category: 'reference', confidence: 0.96, reason: '旧“爆款参考库”目录具有明确的对标与参考语义。', engine: 'legacy' };
  }
  if (path.startsWith('materials/formula-library/')) {
    return { category: 'insight', confidence: 0.94, reason: '旧“公式库”目录主要保存可复用表达与结构。', engine: 'legacy' };
  }
  if (path.startsWith('materials/cases/')) {
    return { category: 'case', confidence: 0.95, reason: '旧“案例素材库”目录具有明确的案例语义。', engine: 'legacy' };
  }
  if (path.startsWith('materials/knowledge/')) {
    return { category: 'insight', confidence: 0.84, reason: '旧“知识库”通常包含方法与洞察，仍建议人工确认。', engine: 'legacy' };
  }
  return null;
}

function heuristicSuggestion(input: {
  title: string;
  kind: RawMaterialKind;
  content?: string;
  sourcePath?: string;
  sourceUrl?: string;
  origin: RawMaterialOrigin;
}): RawMaterialSuggestion {
  const legacy = input.sourcePath ? legacyFolderSuggestion(input.sourcePath) : null;
  const source = [input.title, input.content || '', input.sourcePath || '', input.sourceUrl || ''].join('\n').toLowerCase();
  const scores = RAW_MATERIAL_CATEGORIES.map((id) => ({ id, score: scoreCategory(source, id) }));

  if (input.kind === 'link' || input.sourceUrl) {
    const reference = scores.find((item) => item.id === 'reference');
    if (reference) reference.score += 3;
  }
  if (input.origin === 'research_insight') {
    const reference = scores.find((item) => item.id === 'reference');
    if (reference) reference.score += 6;
  }
  if (input.origin === 'publication_performance') {
    const fact = scores.find((item) => item.id === 'fact');
    if (fact) fact.score += 6;
  }
  if (input.origin === 'confirmed_topic' || input.origin === 'final_content') {
    const insight = scores.find((item) => item.id === 'insight');
    if (insight) insight.score += 5;
  }

  scores.sort((left, right) => right.score - left.score || RAW_MATERIAL_CATEGORIES.indexOf(left.id) - RAW_MATERIAL_CATEGORIES.indexOf(right.id));
  const winner = scores[0];
  const runnerUp = scores[1];
  let confidence = 0.56;
  if (winner.score >= 2) confidence = 0.68;
  if (winner.score >= 4) confidence = 0.79;
  if (winner.score >= 6 && winner.score - runnerUp.score >= 3) confidence = 0.91;
  if (input.origin === 'research_insight' || input.origin === 'publication_performance' || input.origin === 'confirmed_topic' || input.origin === 'final_content') {
    confidence = Math.max(confidence, 0.94);
  }

  const selected = legacy || {
    category: winner.id,
    confidence,
    reason: winner.score > 0
      ? `这份素材更适合放在“${RAW_MATERIAL_CATEGORY_META.find((item) => item.id === winner.id)?.label || winner.id}”。`
      : '暂时看不出最合适的分类，请检查后再保存。',
    engine: 'heuristic' as const,
  };
  return {
    ...selected,
    summary: summarizeText(input),
    generatedAt: nowIso(),
  };
}

function parseSuggestion(value: unknown, fallback: RawMaterialSuggestion): RawMaterialSuggestion {
  if (value === undefined || value === null) return fallback;
  if (!isRecord(value)) throw new MaterialLibraryError('归档建议格式不正确。');
  const confidence = value.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new MaterialLibraryError('归档建议置信度必须是 0 到 1 之间的数字。');
  }
  return {
    category: category(value.category, '建议分类'),
    confidence: Math.round(confidence * 1000) / 1000,
    reason: cleanRequiredText(value.reason, '归档建议理由', MAX_REASON_BYTES),
    summary: cleanRequiredText(value.summary, '素材提炼摘要', MAX_SUMMARY_BYTES),
    engine: suggestionEngine(value.engine, 'ai'),
    generatedAt: cleanOptionalText(value.generatedAt, '归档建议时间', MAX_SHORT_TEXT_BYTES) || nowIso(),
  };
}

function parseLineage(value: unknown, fallback: {
  origin: RawMaterialOrigin;
  sourcePath?: string;
  sourceUrl?: string;
  runId?: string;
  platform?: string;
}): RawMaterialSourceLineage {
  const record = value === undefined || value === null ? {} : isRecord(value) ? value : null;
  if (record === null) throw new MaterialLibraryError('素材来源追溯格式不正确。');
  const importedAt = cleanOptionalText(record.importedAt, '素材导入时间', MAX_SHORT_TEXT_BYTES) || nowIso();
  return {
    origin: origin(record.origin, fallback.origin),
    importedAt,
    ...(sourcePath(record.sourcePath ?? fallback.sourcePath) ? { sourcePath: sourcePath(record.sourcePath ?? fallback.sourcePath) } : {}),
    ...(sourceUrl(record.sourceUrl ?? fallback.sourceUrl) ? { sourceUrl: sourceUrl(record.sourceUrl ?? fallback.sourceUrl) } : {}),
    ...(cleanOptionalText(record.sourceLabel, '素材来源说明', MAX_SOURCE_LABEL_BYTES)
      ? { sourceLabel: cleanOptionalText(record.sourceLabel, '素材来源说明', MAX_SOURCE_LABEL_BYTES) }
      : {}),
    ...(record.runId ?? fallback.runId ? { runId: cleanRunId(record.runId ?? fallback.runId) } : {}),
    ...(record.platform ?? fallback.platform
      ? { platform: cleanRequiredText(record.platform ?? fallback.platform, '素材来源平台', MAX_SHORT_TEXT_BYTES) }
      : {}),
  };
}

function parseRawMaterialInput(value: unknown): Omit<RawMaterialRecord, 'id' | 'category' | 'status' | 'archivedAt' | 'archiveMethod' | 'createdAt' | 'updatedAt'> {
  if (!isRecord(value)) throw new MaterialLibraryError('素材条目格式不正确。');
  const content = cleanOptionalText(value.content ?? value.text, '素材正文', MAX_CONTENT_BYTES);
  const suppliedLineage = isRecord(value.sourceLineage) ? value.sourceLineage : {};
  const suppliedPath = sourcePath(value.sourcePath ?? value.path ?? suppliedLineage.sourcePath);
  const suppliedUrl = sourceUrl(value.sourceUrl ?? value.url ?? suppliedLineage.sourceUrl);
  const inferredKind: RawMaterialKind = suppliedUrl ? 'link' : suppliedPath ? 'file' : 'text';
  const materialKind = kind(value.kind, inferredKind);
  const lineage = parseLineage(value.sourceLineage, {
    origin: origin(value.origin, fallbackOrigin(materialKind)),
    sourcePath: suppliedPath,
    sourceUrl: suppliedUrl,
    ...(value.runId ? { runId: cleanRunId(value.runId) } : {}),
    ...(value.platform ? { platform: cleanRequiredText(value.platform, '素材来源平台', MAX_SHORT_TEXT_BYTES) } : {}),
  });
  const title = cleanOptionalText(value.title, '素材标题', MAX_TITLE_BYTES)
    || titleFromSource({ content, sourcePath: lineage.sourcePath, sourceUrl: lineage.sourceUrl, kind: materialKind });
  const automaticSuggestion = heuristicSuggestion({
    title,
    kind: materialKind,
    content,
    sourcePath: lineage.sourcePath,
    sourceUrl: lineage.sourceUrl,
    origin: lineage.origin,
  });
  return {
    title,
    kind: materialKind,
    ...(content ? { content } : {}),
    suggestion: parseSuggestion(value.suggestion, automaticSuggestion),
    sourceLineage: lineage,
  };
}

function emptyIndex(): RawMaterialLibraryIndex {
  return {
    schema: RAW_MATERIAL_LIBRARY_SCHEMA,
    updatedAt: nowIso(),
    records: [],
    events: [],
  };
}

function storageAbsolutePath(): string {
  const path = safeResolve(PROJECT_DIR, STORAGE_PATH);
  if (!path) throw new MaterialLibraryError('个人库索引路径不合法。');
  return path;
}

function archiveMethod(value: unknown): RawMaterialArchiveMethod | undefined {
  return value === 'auto' || value === 'manual_confirmation' || value === 'reclassified' ? value : undefined;
}

function parseStoredRecord(value: unknown): RawMaterialRecord | null {
  if (!isRecord(value)) return null;
  try {
    const id = cleanRequiredText(value.id, '素材 ID', MAX_SHORT_TEXT_BYTES);
    const createdAt = cleanRequiredText(value.createdAt, '素材创建时间', MAX_SHORT_TEXT_BYTES);
    const updatedAt = cleanRequiredText(value.updatedAt, '素材更新时间', MAX_SHORT_TEXT_BYTES);
    const parsed = parseRawMaterialInput({
      title: value.title,
      kind: value.kind,
      content: value.content,
      sourceLineage: value.sourceLineage,
      suggestion: value.suggestion,
    });
    const status = value.status === 'archived' ? 'archived' : value.status === 'pending_confirmation' ? 'pending_confirmation' : null;
    if (!status) return null;
    const storedCategory = categoryOrNull(value.category);
    if (status === 'archived' && !storedCategory) return null;
    const storedArchiveMethod = archiveMethod(value.archiveMethod);
    if (status === 'archived' && !storedArchiveMethod) return null;
    const archivedAt = cleanOptionalText(value.archivedAt, '素材归档时间', MAX_SHORT_TEXT_BYTES);
    return {
      id,
      ...parsed,
      category: storedCategory,
      status,
      ...(archivedAt ? { archivedAt } : {}),
      ...(storedArchiveMethod ? { archiveMethod: storedArchiveMethod } : {}),
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function parseStoredEvent(value: unknown): RawMaterialArchiveEvent | null {
  if (!isRecord(value)) return null;
  if (!['auto_archived', 'confirmed', 'reclassified', 'auto_archive_undone'].includes(String(value.action))) return null;
  try {
    return {
      id: cleanRequiredText(value.id, '归档事件 ID', MAX_SHORT_TEXT_BYTES),
      materialId: cleanRequiredText(value.materialId, '归档事件素材 ID', MAX_SHORT_TEXT_BYTES),
      action: value.action as RawMaterialArchiveEvent['action'],
      fromCategory: categoryOrNull(value.fromCategory),
      toCategory: categoryOrNull(value.toCategory),
      occurredAt: cleanRequiredText(value.occurredAt, '归档事件时间', MAX_SHORT_TEXT_BYTES),
    };
  } catch {
    return null;
  }
}

function parseIndex(value: unknown): RawMaterialLibraryIndex {
  if (!isRecord(value)) throw new MaterialLibraryError('个人库索引格式不正确。');
  if (value.schema !== RAW_MATERIAL_LIBRARY_SCHEMA) {
    throw new MaterialLibraryError('个人库索引版本不受支持，已保留原文件未作修改。');
  }
  if (!Array.isArray(value.records) || !Array.isArray(value.events)) {
    throw new MaterialLibraryError('个人库索引缺少记录列表，已保留原文件未作修改。');
  }
  const records = value.records.map(parseStoredRecord);
  if (records.some((item) => item === null)) {
    throw new MaterialLibraryError('个人库索引包含无法读取的记录，已保留原文件未作修改。');
  }
  const events = value.events.map(parseStoredEvent);
  if (events.some((item) => item === null)) {
    throw new MaterialLibraryError('个人库索引包含无法读取的归档事件，已保留原文件未作修改。');
  }
  if (records.length > MAX_RECORDS || events.length > MAX_EVENTS) {
    throw new MaterialLibraryError('个人库索引记录过大，请先清理历史记录。');
  }
  return {
    schema: RAW_MATERIAL_LIBRARY_SCHEMA,
    updatedAt: cleanRequiredText(value.updatedAt, '个人库更新时间', MAX_SHORT_TEXT_BYTES),
    records: records as RawMaterialRecord[],
    events: events as RawMaterialArchiveEvent[],
  };
}

async function readIndex(): Promise<RawMaterialLibraryIndex> {
  const path = storageAbsolutePath();
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new MaterialLibraryError('个人库索引不能使用符号链接或目录。');
    }
    return parseIndex(JSON.parse(await readFile(path, 'utf-8')) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyIndex();
    throw error;
  }
}

async function writeIndex(index: RawMaterialLibraryIndex): Promise<void> {
  const path = storageAbsolutePath();
  await mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true, mode: 0o700 });
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) throw new MaterialLibraryError('个人库索引不能使用符号链接。');
  } catch (error) {
    if (error instanceof MaterialLibraryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const next = {
    ...index,
    updatedAt: nowIso(),
    records: index.records.slice(0, MAX_RECORDS),
    events: index.events.slice(0, MAX_EVENTS),
  };
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function toSummary(record: RawMaterialRecord): RawMaterialSummary {
  const summary = { ...record } as Partial<RawMaterialRecord>;
  delete summary.content;
  return { ...summary, sourceNature: materialSourceNature(record.content) } as RawMaterialSummary;
}

function totals(records: readonly RawMaterialRecord[]): RawMaterialListResult['totals'] {
  return {
    total: records.length,
    all: records.length,
    archived: records.filter((item) => item.status === 'archived').length,
    pendingConfirmation: records.filter((item) => item.status === 'pending_confirmation').length,
    autoArchived: records.filter((item) => item.archiveMethod === 'auto').length,
  };
}

function categoryCounts(records: readonly RawMaterialRecord[]): RawMaterialListResult['categories'] {
  return RAW_MATERIAL_CATEGORY_META.map((meta) => ({
    id: meta.id,
    label: meta.label,
    count: records.filter((record) => record.category === meta.id || (record.status === 'pending_confirmation' && record.suggestion.category === meta.id)).length,
  }));
}

function eventFor(input: {
  materialId: string;
  action: RawMaterialArchiveEvent['action'];
  fromCategory: RawMaterialCategory | null;
  toCategory: RawMaterialCategory | null;
}): RawMaterialArchiveEvent {
  return {
    id: `material-event_${randomUUID()}`,
    materialId: input.materialId,
    action: input.action,
    fromCategory: input.fromCategory,
    toCategory: input.toCategory,
    occurredAt: nowIso(),
  };
}

function materialFingerprint(record: Pick<RawMaterialRecord, 'title' | 'content' | 'sourceLineage'>): string {
  const lineage = record.sourceLineage;
  const identity = [
    lineage.origin,
    lineage.runId || '',
    lineage.sourcePath || '',
    lineage.sourceUrl || '',
    record.content ? createHash('sha256').update(record.content).digest('hex') : '',
    // A production input is the same source even after its display title changes.
    lineage.origin === 'production_input' && lineage.runId ? '' : record.title,
  ].join('|');
  return createHash('sha256').update(identity).digest('hex');
}

function applyArchiveDecision(input: {
  base: Omit<RawMaterialRecord, 'id' | 'category' | 'status' | 'archivedAt' | 'archiveMethod' | 'createdAt' | 'updatedAt'>;
  id?: string;
  createdAt?: string;
}): { record: RawMaterialRecord; autoArchiveEvent?: RawMaterialArchiveEvent } {
  const now = nowIso();
  const autoArchive = input.base.suggestion.confidence >= AUTO_ARCHIVE_CONFIDENCE;
  const record: RawMaterialRecord = {
    id: input.id || `material_${randomUUID()}`,
    ...input.base,
    category: autoArchive ? input.base.suggestion.category : null,
    status: autoArchive ? 'archived' : 'pending_confirmation',
    ...(autoArchive ? { archivedAt: now, archiveMethod: 'auto' as const } : {}),
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
  return {
    record,
    ...(autoArchive ? {
      autoArchiveEvent: eventFor({
        materialId: record.id,
        action: 'auto_archived',
        fromCategory: null,
        toCategory: record.category,
      }),
    } : {}),
  };
}

function assertIds(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length) throw new MaterialLibraryError('请至少选择一条素材。');
  if (value.length > MAX_INGEST_ITEMS) throw new MaterialLibraryError(`一次最多处理 ${MAX_INGEST_ITEMS} 条素材。`);
  return Array.from(new Set(value.map((item) => cleanRequiredText(item, '素材 ID', MAX_SHORT_TEXT_BYTES))));
}

function findRecord(index: RawMaterialLibraryIndex, id: string): RawMaterialRecord {
  const record = index.records.find((item) => item.id === id);
  if (!record) throw new MaterialLibraryError('指定素材不存在或已被移除。');
  return record;
}

export async function listRawMaterials(query: RawMaterialListQuery = {}): Promise<RawMaterialListResult> {
  const index = await readIndex();
  const status = query.status || 'all';
  if (status !== 'all' && status !== 'archived' && status !== 'pending_confirmation') {
    throw new MaterialLibraryError('素材状态筛选不受支持。');
  }
  const requestedCategory = query.category;
  if (requestedCategory) category(requestedCategory);
  const sort = query.sort || 'recent';
  if (sort !== 'recent' && sort !== 'priority') throw new MaterialLibraryError('素材排序方式不受支持。');
  const limit = query.limit === undefined ? 100 : query.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new MaterialLibraryError('素材列表数量必须在 1 到 200 之间。');

  const filtered = index.records.filter((record) => {
    if (status !== 'all' && record.status !== status) return false;
    if (requestedCategory && record.category !== requestedCategory && record.suggestion.category !== requestedCategory) return false;
    return true;
  });
  filtered.sort((left, right) => {
    if (sort === 'priority') {
      const leftPriority = left.status === 'pending_confirmation' ? 1 : 0;
      const rightPriority = right.status === 'pending_confirmation' ? 1 : 0;
      if (leftPriority !== rightPriority) return rightPriority - leftPriority;
      if (left.suggestion.confidence !== right.suggestion.confidence) return right.suggestion.confidence - left.suggestion.confidence;
    }
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
  return {
    categories: categoryCounts(index.records),
    totals: totals(index.records),
    items: filtered.slice(0, limit).map(toSummary),
  };
}

export async function getRawMaterialRecord(id: string): Promise<RawMaterialRecord | null> {
  const index = await readIndex();
  return index.records.find((record) => record.id === id) || null;
}

export async function getRawMaterialDashboard(): Promise<RawMaterialDashboard> {
  const index = await readIndex();
  const byId = new Map(index.records.map((record) => [record.id, record]));
  const pendingArchiveSuggestions = index.records
    .filter((record) => record.status === 'pending_confirmation')
    .sort((left, right) => right.suggestion.confidence - left.suggestion.confidence || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime())
    .slice(0, 8)
    .map(toSummary);
  const recentAutoArchives = index.events
    .filter((event) => event.action === 'auto_archived')
    .sort((left, right) => new Date(right.occurredAt).getTime() - new Date(left.occurredAt).getTime())
    .flatMap((event) => {
      const item = byId.get(event.materialId);
      return item?.archiveMethod === 'auto' ? [{ event, item: toSummary(item) }] : [];
    })
    .slice(0, 12);
  return {
    rawMaterials: {
      ...totals(index.records),
      categories: categoryCounts(index.records),
    },
    pendingArchiveSuggestions,
    recentAutoArchives,
  };
}

export async function ingestRawMaterials(input: IngestRawMaterialsInput): Promise<IngestRawMaterialsResult> {
  if (!Array.isArray(input.items) || !input.items.length) throw new MaterialLibraryError('请至少导入一条素材。');
  if (input.items.length > MAX_INGEST_ITEMS) throw new MaterialLibraryError(`一次最多导入 ${MAX_INGEST_ITEMS} 条素材。`);
  const parsed = input.items.map(parseRawMaterialInput);
  const index = await readIndex();
  if (index.records.length + parsed.length > MAX_RECORDS) throw new MaterialLibraryError('个人库已达到记录上限，请先清理不再使用的素材。');

  const existingFingerprints = new Map(index.records.map((record) => [materialFingerprint(record), record]));
  const returned: RawMaterialRecord[] = [];
  let created = 0;
  let existing = 0;
  let autoArchived = 0;
  for (const base of parsed) {
    const fingerprint = materialFingerprint(base);
    const matching = input.deduplicate ? existingFingerprints.get(fingerprint) : undefined;
    if (matching) {
      returned.push(matching);
      existing += 1;
      continue;
    }
    const result = applyArchiveDecision({ base });
    index.records.unshift(result.record);
    if (result.autoArchiveEvent) {
      index.events.unshift(result.autoArchiveEvent);
      autoArchived += 1;
    }
    existingFingerprints.set(fingerprint, result.record);
    returned.push(result.record);
    created += 1;
  }
  if (created) await writeIndex(index);
  return { records: returned.map(toSummary), created, existing, autoArchived };
}

export async function confirmRawMaterialArchive(input: {
  ids: unknown;
  categoryById?: unknown;
}): Promise<RawMaterialSummary[]> {
  const ids = assertIds(input.ids);
  const mapping = input.categoryById === undefined || input.categoryById === null
    ? {}
    : isRecord(input.categoryById)
      ? input.categoryById
      : (() => { throw new MaterialLibraryError('批量素材分类格式不正确。'); })();
  const index = await readIndex();
  const updated: RawMaterialRecord[] = [];
  for (const id of ids) {
    const record = findRecord(index, id);
    if (record.status !== 'pending_confirmation') {
      updated.push(record);
      continue;
    }
    const nextCategory = mapping[id] === undefined ? record.suggestion.category : category(mapping[id]);
    const oldCategory = record.category;
    const now = nowIso();
    record.category = nextCategory;
    record.status = 'archived';
    record.archivedAt = now;
    record.archiveMethod = 'manual_confirmation';
    record.updatedAt = now;
    index.events.unshift(eventFor({ materialId: record.id, action: 'confirmed', fromCategory: oldCategory, toCategory: nextCategory }));
    updated.push(record);
  }
  await writeIndex(index);
  return updated.map(toSummary);
}

export async function reclassifyRawMaterial(input: { id: unknown; category: unknown }): Promise<RawMaterialSummary> {
  const id = cleanRequiredText(input.id, '素材 ID', MAX_SHORT_TEXT_BYTES);
  const nextCategory = category(input.category);
  const index = await readIndex();
  const record = findRecord(index, id);
  const oldCategory = record.category;
  const now = nowIso();
  record.category = nextCategory;
  record.status = 'archived';
  record.archivedAt = now;
  record.archiveMethod = 'reclassified';
  record.updatedAt = now;
  index.events.unshift(eventFor({ materialId: record.id, action: 'reclassified', fromCategory: oldCategory, toCategory: nextCategory }));
  await writeIndex(index);
  return toSummary(record);
}

export async function undoAutoArchivedRawMaterial(idValue: unknown): Promise<RawMaterialSummary> {
  const id = cleanRequiredText(idValue, '素材 ID', MAX_SHORT_TEXT_BYTES);
  const index = await readIndex();
  const record = findRecord(index, id);
  if (record.archiveMethod !== 'auto') {
    throw new MaterialLibraryError('仅可撤销 AI 自动归档的素材。');
  }
  const oldCategory = record.category;
  const now = nowIso();
  record.category = null;
  record.status = 'pending_confirmation';
  delete record.archivedAt;
  delete record.archiveMethod;
  record.updatedAt = now;
  index.events.unshift(eventFor({ materialId: record.id, action: 'auto_archive_undone', fromCategory: oldCategory, toCategory: null }));
  await writeIndex(index);
  return toSummary(record);
}

function legacyCategoryForPath(path: string): RawMaterialCategory | null {
  if (path.startsWith('materials/hit-library/')) return 'reference';
  if (path.startsWith('materials/formula-library/')) return 'insight';
  if (path.startsWith('materials/cases/')) return 'case';
  if (path.startsWith('materials/knowledge/')) return 'insight';
  return null;
}

function shouldIgnoreLegacyPath(path: string): boolean {
  return path.includes('/.DS_Store')
    || path.startsWith('materials/library/')
    || path.startsWith('materials/extracted/')
    || path.startsWith('materials/pending/')
    || path.startsWith('materials/preference/')
    || path.startsWith('materials/publication/')
    || path.startsWith('materials/creative-enhancements/')
    || path.startsWith('materials/advisors/');
}

async function filesUnder(relativeRoot: string, limit: number): Promise<string[]> {
  const root = safeResolve(PROJECT_DIR, relativeRoot);
  if (!root) return [];
  const found: string[] = [];
  const walk = async (absolute: string): Promise<void> => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const child = `${absolute}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(child);
      } else if (entry.isFile()) {
        const source = relative(PROJECT_DIR, child).replace(/\\/g, '/');
        if (!source.includes('..')) found.push(source);
      }
    }
  };
  try {
    const info = await lstat(root);
    if (info.isDirectory() && !info.isSymbolicLink()) await walk(root);
  } catch {
    return [];
  }
  return found;
}

/**
 * Adds sidecar records for the old folder hierarchy without moving, renaming,
 * deleting, or rewriting any existing material file.
 */
export async function migrateLegacyRawMaterials(): Promise<{
  created: number;
  existing: number;
  skipped: number;
  records: RawMaterialSummary[];
}> {
  const paths = (await Promise.all([
    filesUnder('materials/hit-library', MAX_LEGACY_FILES),
    filesUnder('materials/formula-library', MAX_LEGACY_FILES),
    filesUnder('materials/knowledge', MAX_LEGACY_FILES),
    filesUnder('materials/cases', MAX_LEGACY_FILES),
  ])).flat().filter((path) => !shouldIgnoreLegacyPath(path)).slice(0, MAX_LEGACY_FILES);
  const items = paths.flatMap((path) => {
    const selectedCategory = legacyCategoryForPath(path);
    if (!selectedCategory) return [];
    const legacy = legacyFolderSuggestion(path);
    if (!legacy) return [];
    return [{
      title: basename(path).replace(/\.[A-Za-z0-9]+$/, ''),
      kind: 'file',
      sourcePath: path,
      origin: 'legacy_library',
      sourceLineage: {
        origin: 'legacy_library',
        sourcePath: path,
        sourceLabel: '从旧个人库安全迁移，仅创建索引，不移动原文件。',
      },
      suggestion: {
        category: selectedCategory,
        confidence: legacy.confidence,
        reason: legacy.reason,
        summary: `旧素材文件：${path}`,
        engine: 'legacy',
      },
    }];
  });
  if (!items.length) return { created: 0, existing: 0, skipped: 0, records: [] };
  const result = await ingestRawMaterials({ items, deduplicate: true });
  return {
    ...result,
    skipped: Math.max(0, paths.length - items.length),
  };
}

function isSafeRuntimeArtifactPath(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    return sourcePath(value) || null;
  } catch {
    return null;
  }
}

async function readJsonAt(relativePath: string): Promise<Record<string, unknown> | null> {
  const path = safeResolve(PROJECT_DIR, relativePath);
  if (!path) return null;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONTENT_BYTES) return null;
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readArtifactContent(relativePath: string): Promise<string | undefined> {
  if (!isLikelyTextPath(relativePath)) return undefined;
  const path = safeResolve(PROJECT_DIR, relativePath);
  if (!path) return undefined;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_CONTENT_BYTES) return undefined;
    const content = await readFile(path, 'utf-8');
    return content.trim() || undefined;
  } catch {
    return undefined;
  }
}

function extractStepPaths(value: unknown, matcher: RegExp): string[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => {
    if (!matcher.test(key)) return [];
    if (typeof item === 'string') return isSafeRuntimeArtifactPath(item) ? [item] : [];
    if (isRecord(item) && typeof item.latest === 'string') return isSafeRuntimeArtifactPath(item.latest) ? [item.latest] : [];
    return [];
  });
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

async function currentRunArtifactPaths(runId: string, run: Record<string, unknown>): Promise<{
  research: string[];
  finalContent: string[];
  performance: string[];
}> {
  const steps = isRecord(run.steps) ? run.steps : {};
  const research = [
    ...extractStepPaths(steps, /research|market|benchmark|tikomni/i),
    ...['snapshotPath', 'marketSnapshotPath', 'researchSnapshotPath', 'market_snapshot_path'].map((key) => isSafeRuntimeArtifactPath(run[key])),
  ];
  const finalContent = extractStepPaths(steps, /write|final|package|xhs|platform.?adapt/i);
  const performance = extractStepPaths(steps, /performance|metric|review/i);
  const latest = await readJsonAt('sessions/latest.json');
  if (!latest) return {
    research: uniqueStrings(research),
    finalContent: uniqueStrings(finalContent),
    performance: uniqueStrings(performance),
  };
  const latestFiles = latest.active_run_id === runId && isRecord(latest.latest_files)
    ? latest.latest_files
    : typeof run.slug === 'string' && isRecord(latest.latest_by_slug) && isRecord(latest.latest_by_slug[run.slug])
      ? latest.latest_by_slug[run.slug]
      : {};
  return {
    research: uniqueStrings([
      ...research,
      ...extractStepPaths(latestFiles, /research|market|benchmark|tikomni/i),
    ]),
    finalContent: uniqueStrings([
      ...finalContent,
      ...extractStepPaths(latestFiles, /write|final|package|xhs|platform.?adapt/i),
    ]),
    performance: uniqueStrings([
      ...performance,
      ...extractStepPaths(latestFiles, /performance|metric|review/i),
    ]),
  };
}

async function productionInputArtifacts(runId: string): Promise<ProductionArtifactInput[]> {
  const context = await readJsonAt(`sessions/material-analysis/${runId}.json`);
  const input = context && isRecord(context.input) ? context.input : null;
  if (!input) return [];
  const artifacts: ProductionArtifactInput[] = [];
  if (typeof input.rawMaterial === 'string' && input.rawMaterial.trim()) {
    artifacts.push({
      title: compactText(materialTitleSuggestion(input.rawMaterial) || input.rawMaterial.split(/\r?\n/).find((line) => line.trim() && !/^[【\[]/.test(line.trim())) || '本期输入素材', 180),
      kind: 'production',
      content: input.rawMaterial,
      origin: 'production_input',
      sourceLineage: { origin: 'production_input', runId, sourceLabel: '本期素材分析输入' },
    });
  }
  if (Array.isArray(input.files)) {
    for (const file of input.files) {
      if (!isRecord(file)) continue;
      const path = isSafeRuntimeArtifactPath(file.sourcePath ?? file.path);
      if (!path) continue;
      artifacts.push({
        title: typeof file.name === 'string' && file.name.trim() ? file.name : basename(path),
        kind: 'file',
        sourcePath: path,
        origin: 'production_input',
        sourceLineage: { origin: 'production_input', runId, sourcePath: path, sourceLabel: '本期上传素材' },
      });
    }
  }
  if (Array.isArray(input.links)) {
    for (const link of input.links) {
      if (!isRecord(link) || typeof link.url !== 'string') continue;
      const title = typeof link.title === 'string' ? link.title : '本期灵感参考链接';
      const content = typeof link.excerpt === 'string' ? link.excerpt : undefined;
      artifacts.push({
        title,
        kind: 'link',
        content,
        sourceUrl: link.url,
        origin: 'production_input',
        sourceLineage: { origin: 'production_input', runId, sourceUrl: link.url, sourceLabel: '本期灵感参考链接' },
      });
    }
  }
  return artifacts;
}

function systemSuggestion(categoryId: RawMaterialCategory, summary: string): RawMaterialSuggestion {
  const label = RAW_MATERIAL_CATEGORY_META.find((item) => item.id === categoryId)?.label || categoryId;
  return {
    category: categoryId,
    confidence: 0.94,
    reason: `这份素材来自已确认的制作步骤，已放在“${label}”。`,
    summary,
    engine: 'system',
    generatedAt: nowIso(),
  };
}

async function confirmedProductionTopic(runId: string, run: Record<string, unknown>): Promise<string | null> {
  const topic = typeof run.topic === 'string' ? run.topic.trim() : '';
  const steps = isRecord(run.steps) ? run.steps : {};
  const blueprint = isRecord(steps.blueprint) ? isSafeRuntimeArtifactPath(steps.blueprint.latest) : null;
  const approvals = isRecord(run.approvals) ? run.approvals : {};
  const savedApproval = isRecord(approvals.topic_template) ? approvals.topic_template
    : isRecord(approvals.blueprint) ? approvals.blueprint : null;
  if (!topic || run.run_id !== runId || !blueprint || !savedApproval) return null;

  // A run is allocated before the author chooses a topic. Its topic string can
  // still be an internal identifier; neither nonempty text nor a legacy boolean
  // is evidence of an approved topic. The runtime checks the current artifact
  // digest, invalidations, material corrections, and the chosen writing source.
  try {
    const approval = await getRuntimeProductionApproval('topic_template', blueprint, runId);
    if (approval.approved !== true || approval.run_id !== runId || approval.path !== blueprint) return null;
    if (run.research_mode !== 'author_material') {
      if (run.research_mode && run.research_mode !== 'platform') return null;
      const selection = isRecord(run.topic_selection) ? run.topic_selection : null;
      if (!selection || selection.method !== 'human_topic_selection' || selection.topic !== topic
          || !selection.selected_at || selection.market_snapshot_path !== savedApproval.market_snapshot_path
          || selection.market_snapshot_sha256 !== savedApproval.market_snapshot_sha256) return null;
    }
    // Do not attach the approval to a different topic if another page changed
    // this run while the authoritative check was in flight.
    const current = await readJsonAt(`runs/${runId}.json`);
    return current && JSON.stringify(current) === JSON.stringify(run) ? topic : null;
  } catch {
    // Saving the author's input does not require an available approval runtime.
    // Unverifiable topics are simply omitted instead of being called confirmed.
    return null;
  }
}

/**
 * Decomposes one run into independent local material records. It never moves
 * source files and is idempotent, so a repeated "one-click deposit" is safe.
 */
export async function ingestProductionMaterials(input: {
  runId: unknown;
  artifacts?: unknown;
}): Promise<IngestRawMaterialsResult> {
  const runId = cleanRunId(input.runId);
  const run = await readJsonAt(`runs/${runId}.json`);
  if (!run) throw new MaterialLibraryError('当前内容任务不存在或无法读取。');
  const generated: ProductionArtifactInput[] = await productionInputArtifacts(runId);
  const topic = await confirmedProductionTopic(runId, run);
  if (topic) {
    generated.push({
      title: `本期已确认选题 · ${compactText(topic, 160)}`,
      kind: 'production',
      content: topic,
      origin: 'confirmed_topic',
      sourceLineage: { origin: 'confirmed_topic', runId, sourceLabel: '本期已确认选题' },
      suggestion: systemSuggestion('insight', `本期已确认选题：${compactText(topic, 180)}`),
    });
  }
  const paths = await currentRunArtifactPaths(runId, run);
  const appendArtifacts = async (sourcePaths: string[], originValue: RawMaterialOrigin, categoryId: RawMaterialCategory, label: string) => {
    for (const path of sourcePaths) {
      const content = await readArtifactContent(path);
      generated.push({
        title: label,
        kind: 'production',
        ...(content ? { content } : {}),
        sourcePath: path,
        origin: originValue,
        sourceLineage: { origin: originValue, runId, sourcePath: path, sourceLabel: label },
        suggestion: systemSuggestion(categoryId, `${label}已保存到资料库。`),
      });
    }
  };
  await appendArtifacts(paths.research, 'research_insight', 'reference', '本期研究洞察');
  await appendArtifacts(paths.finalContent, 'final_content', 'insight', '本期最终内容');
  await appendArtifacts(paths.performance, 'publication_performance', 'fact', '本期发布表现');

  if (input.artifacts !== undefined && input.artifacts !== null) {
    if (!Array.isArray(input.artifacts)) throw new MaterialLibraryError('补充素材必须是列表。');
    generated.push(...input.artifacts as ProductionArtifactInput[]);
  }
  const limited = generated.slice(0, MAX_PRODUCTION_ARTIFACTS);
  if (!limited.length) throw new MaterialLibraryError('本期暂无可保存的素材。');
  return ingestRawMaterials({ items: limited, deduplicate: true });
}
