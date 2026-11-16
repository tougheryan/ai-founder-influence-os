import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, relative, sep } from 'node:path';
import { PROJECT_DIR, safeResolve } from './project-root';
import {
  PUBLICATION_LEDGER_ROOT,
  isPublicationLedgerPath,
  readPublicationLedger,
  type PublicationLedger,
  type PublicationRecord,
} from './publish/publication-ledger';
import { readDraftQueue, type DraftJob, type DraftQueue, type PublicationPlatform } from './publish/draft-queue';
import { inspectGeneratedLanguage, type GeneratedLanguageFinding } from './product-voice';

/**
 * The creative library is deliberately small and local. It keeps the operator's
 * approved identity/rules separate from source material and only learns from
 * explicitly collected, human-confirmed publication records.
 */
export const CREATIVE_LIBRARY_ROOT = 'brain/creative-library';
export const CREATIVE_PROFILE_SCHEMA = 'aifios.creative-profile.v1';
export const CREATIVE_RULES_SCHEMA = 'aifios.creative-rules.v1';
export const CREATIVE_PROPOSALS_SCHEMA = 'aifios.creative-proposals.v1';
export const PUBLISHED_SCRIPT_LIBRARY_SCHEMA = 'aifios.published-script-library.v1';

const PROFILE_PATH = `${CREATIVE_LIBRARY_ROOT}/profile.json`;
const RULES_PATH = `${CREATIVE_LIBRARY_ROOT}/rules.json`;
const PROPOSALS_PATH = `${CREATIVE_LIBRARY_ROOT}/proposals.json`;
const PUBLISHED_SCRIPTS_PATH = `${CREATIVE_LIBRARY_ROOT}/published-scripts.json`;
const STORAGE_PATHS = new Set([PROFILE_PATH, RULES_PATH, PROPOSALS_PATH, PUBLISHED_SCRIPTS_PATH]);

const MAX_PROFILE_FIELD_BYTES = 8 * 1024;
const MAX_PROFILE_PILLARS = 12;
const MAX_RULES = 80;
const MAX_RULE_TEXT_BYTES = 12 * 1024;
const MAX_PROPOSALS = 240;
const MAX_SCRIPT_CONTENT_BYTES = 512 * 1024;
const MAX_PUBLISHED_SCRIPTS = 800;
const MAX_PROPOSAL_SOURCE_SCRIPTS = 20;
const SCRIPT_TEXT_EXTENSIONS = new Set(['.html', '.htm', '.json', '.md', '.rtf', '.txt']);

export type CreativeProfileFields = {
  creatorName: string;
  accountType: string;
  identity: string;
  targetAudience: string;
  contentPillars: string[];
  introduction: string;
  writingStyle: string;
  expressionPreferences: string;
  visualPreferences: string;
  topicBoundaries: string;
  prohibitions: string;
};

export type CreativeProfile = {
  schema: typeof CREATIVE_PROFILE_SCHEMA;
  scope: 'global';
  initialized: boolean;
  version: number;
  profile: CreativeProfileFields;
  updatedAt?: string;
  previous?: {
    version: number;
    profile: CreativeProfileFields;
    updatedAt?: string;
  };
};

export type CreativeRuleCategory = 'requirement' | 'prohibition' | 'style' | 'workflow';

export type CreativeRule = {
  id: string;
  title: string;
  content: string;
  category: CreativeRuleCategory;
  enabled: boolean;
};

export type CreativeRules = {
  schema: typeof CREATIVE_RULES_SCHEMA;
  scope: 'global';
  initialized: boolean;
  version: number;
  items: CreativeRule[];
  updatedAt?: string;
  previous?: {
    version: number;
    items: CreativeRule[];
    updatedAt?: string;
  };
};

export type CreativeProfilePatch = Partial<CreativeProfileFields>;

export type CreativeRulesPatch = {
  upsert?: Array<Partial<CreativeRule> & Pick<CreativeRule, 'title' | 'content'>>;
  removeIds?: string[];
};

export type CreativeProposalTarget = 'profile' | 'rules';
export type CreativeProposalStatus = 'pending' | 'accepted' | 'rejected';
export type CreativeProposalSource = {
  kind: 'published_scripts' | 'weekly_review' | 'manual';
  scriptIds: string[];
  note?: string;
};

export type CreativeUpdateProposal = {
  id: string;
  target: CreativeProposalTarget;
  status: CreativeProposalStatus;
  reason: string;
  source: CreativeProposalSource;
  baseVersion: number;
  patch: CreativeProfilePatch | CreativeRulesPatch;
  createdAt: string;
  resolvedAt?: string;
  resolution?: 'accepted' | 'rejected' | 'edited';
  appliedPatch?: CreativeProfilePatch | CreativeRulesPatch;
  languageWarnings?: GeneratedLanguageFinding[];
};

export type CreativeProposals = {
  schema: typeof CREATIVE_PROPOSALS_SCHEMA;
  items: CreativeUpdateProposal[];
  updatedAt?: string;
};

export type PublishedScriptForm = 'wechat_article' | 'xiaohongshu_post' | 'moments_post' | 'video_script' | 'unknown';

export type PublishedScriptPerformance = {
  metrics: Record<string, number>;
  updatedAt?: string;
};

export type PublishedScript = {
  id: string;
  sourceRecordId: string;
  sourceLedgerPath: string;
  sourceQueuePath: string;
  runId: string;
  jobId: string;
  title: string;
  platform: PublicationPlatform;
  form: PublishedScriptForm;
  publishedAt: string;
  publicationUrl?: string;
  hasLocalProof: boolean;
  sourceContentPath?: string;
  contentHash: string;
  content: string;
  excerpt: string;
  learnable: boolean;
  performance: PublishedScriptPerformance;
  collectedAt: string;
};

export type PublishedScriptSummary = Omit<PublishedScript, 'content'>;

export type PublishedScriptLibrary = {
  schema: typeof PUBLISHED_SCRIPT_LIBRARY_SCHEMA;
  items: PublishedScript[];
  updatedAt?: string;
};

export type PublishedScriptCandidate = {
  sourceRecordId: string;
  sourceLedgerPath: string;
  sourceQueuePath: string;
  runId: string;
  jobId: string;
  title: string;
  platform: PublicationPlatform;
  form: PublishedScriptForm;
  publishedAt: string;
  publicationUrl?: string;
  hasLocalProof: boolean;
  sourceContentPath?: string;
  contentAvailable: boolean;
  collected: boolean;
  scriptId?: string;
};

export type CreativeLibraryPendingCounts = {
  profile: number;
  rules: number;
  total: number;
};

export type CreativeLibraryOverview = {
  profile: CreativeProfile;
  rules: CreativeRules;
  pending: CreativeLibraryPendingCounts;
  publishedScripts: {
    items: PublishedScriptSummary[];
    total: number;
    candidatesTotal: number;
  };
};

export class CreativeLibraryError extends Error {}
export class CreativeLibraryConflictError extends CreativeLibraryError {}

export function assertCreativeVersion(expected: unknown, actual: number): void {
  if (!Number.isSafeInteger(expected) || Number(expected) < 0 || expected !== actual) {
    throw new CreativeLibraryConflictError('写作设置已更新，请重新读取后核对，避免覆盖另一窗口的修改。');
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function textBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function cleanText(value: unknown, label: string, maxBytes: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new CreativeLibraryError(`${label}不能为空。`);
    return '';
  }
  if (typeof value !== 'string') throw new CreativeLibraryError(`${label}必须是文本。`);
  const text = value.trim();
  if (textBytes(text) > maxBytes) throw new CreativeLibraryError(`${label}过长。`);
  if (required && !text) throw new CreativeLibraryError(`${label}不能为空。`);
  return text;
}

function cleanIdentifier(value: unknown, label: string, pattern: RegExp): string {
  const id = cleanText(value, label, 160, true);
  if (!pattern.test(id)) throw new CreativeLibraryError(`${label}格式无效。`);
  return id;
}

function profileDefaults(): CreativeProfileFields {
  return {
    creatorName: '',
    accountType: '',
    identity: '',
    targetAudience: '',
    contentPillars: [],
    introduction: '',
    writingStyle: '',
    expressionPreferences: '',
    visualPreferences: '',
    topicBoundaries: '',
    prohibitions: '',
  };
}

function emptyProfile(): CreativeProfile {
  return {
    schema: CREATIVE_PROFILE_SCHEMA,
    scope: 'global',
    initialized: false,
    version: 0,
    profile: profileDefaults(),
  };
}

function emptyRules(): CreativeRules {
  return {
    schema: CREATIVE_RULES_SCHEMA,
    scope: 'global',
    initialized: false,
    version: 0,
    items: [],
  };
}

function emptyProposals(): CreativeProposals {
  return { schema: CREATIVE_PROPOSALS_SCHEMA, items: [] };
}

function emptyPublishedScripts(): PublishedScriptLibrary {
  return { schema: PUBLISHED_SCRIPT_LIBRARY_SCHEMA, items: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertStoragePath(relativePath: string): void {
  if (!STORAGE_PATHS.has(relativePath)) throw new CreativeLibraryError('创作资产存储路径不受支持。');
}

async function safeStorageTarget(relativePath: string): Promise<string> {
  assertStoragePath(relativePath);
  const projectRoot = safeResolve(PROJECT_DIR, '.');
  const target = safeResolve(PROJECT_DIR, relativePath);
  if (!projectRoot || !target) throw new CreativeLibraryError('创作资产路径不在当前项目内。');
  await mkdir(projectRoot, { recursive: true, mode: 0o700 });
  const parent = dirname(target);
  const parentRelation = relative(projectRoot, parent);
  if (parentRelation === '..' || parentRelation.startsWith(`..${sep}`)) {
    throw new CreativeLibraryError('创作资产路径不在当前项目内。');
  }

  let current = projectRoot;
  for (const segment of parentRelation.split(sep)) {
    if (!segment || segment === '.') continue;
    current = `${current}${sep}${segment}`;
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new CreativeLibraryError('创作资产目录不能使用符号链接。');
      }
    } catch (error) {
      if (error instanceof CreativeLibraryError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try {
        await mkdir(current, { recursive: false, mode: 0o700 });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new CreativeLibraryError('创作资产目录不能使用符号链接。');
      }
    }
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new CreativeLibraryError('创作资产不能写入符号链接。');
  } catch (error) {
    if (error instanceof CreativeLibraryError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}

async function readStoredJson(relativePath: string): Promise<unknown | null> {
  const target = await safeStorageTarget(relativePath);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new CreativeLibraryError('创作资产必须是本地普通 JSON 文件。');
    return JSON.parse(await readFile(target, 'utf-8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (error instanceof CreativeLibraryError) throw error;
    throw new CreativeLibraryError('创作资产 JSON 无法读取。');
  }
}

async function writeStoredJson(relativePath: string, value: unknown): Promise<void> {
  const target = await safeStorageTarget(relativePath);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function normalizePillars(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PROFILE_PILLARS) {
    throw new CreativeLibraryError('内容支柱必须是不超过 12 项的列表。');
  }
  const seen = new Set<string>();
  const pillars: string[] = [];
  for (const item of value) {
    const text = cleanText(item, '内容支柱', 600, true);
    if (!seen.has(text)) {
      seen.add(text);
      pillars.push(text);
    }
  }
  return pillars;
}

const PROFILE_TEXT_FIELDS = [
  'creatorName',
  'accountType',
  'identity',
  'targetAudience',
  'introduction',
  'writingStyle',
  'expressionPreferences',
  'visualPreferences',
  'topicBoundaries',
  'prohibitions',
] as const;

function normalizeProfilePatch(value: unknown): CreativeProfilePatch {
  if (!isRecord(value)) throw new CreativeLibraryError('创作名片必须是对象。');
  const allowed = new Set([...PROFILE_TEXT_FIELDS, 'contentPillars']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new CreativeLibraryError(`创作名片不支持字段：${key}`);
  }
  const patch: CreativeProfilePatch = {};
  for (const key of PROFILE_TEXT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      patch[key] = cleanText(value[key], key, MAX_PROFILE_FIELD_BYTES);
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, 'contentPillars')) {
    patch.contentPillars = normalizePillars(value.contentPillars);
  }
  if (Object.keys(patch).length === 0) throw new CreativeLibraryError('请至少填写一项创作名片内容。');
  return patch;
}

function mergeProfile(profile: CreativeProfileFields, patch: CreativeProfilePatch): CreativeProfileFields {
  return { ...profile, ...patch, contentPillars: patch.contentPillars ? [...patch.contentPillars] : [...profile.contentPillars] };
}

function profileHasContent(profile: CreativeProfileFields): boolean {
  return Boolean(profile.contentPillars.length || PROFILE_TEXT_FIELDS.some((key) => Boolean(profile[key])));
}

function parseProfile(value: unknown): CreativeProfile {
  if (!isRecord(value) || value.schema !== CREATIVE_PROFILE_SCHEMA || value.scope !== 'global') return emptyProfile();
  const initialized = value.initialized === true;
  const version = typeof value.version === 'number' && Number.isInteger(value.version) && value.version >= 0 ? value.version : 0;
  let profile = profileDefaults();
  try {
    profile = mergeProfile(profile, normalizeProfilePatch(value.profile || {}));
  } catch {
    return emptyProfile();
  }
  const result: CreativeProfile = {
    schema: CREATIVE_PROFILE_SCHEMA,
    scope: 'global',
    initialized: initialized && profileHasContent(profile),
    version,
    profile,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  };
  if (isRecord(value.previous)) {
    try {
      const previousProfile = mergeProfile(profileDefaults(), normalizeProfilePatch(value.previous.profile || {}));
      const previousVersion = typeof value.previous.version === 'number' && Number.isInteger(value.previous.version)
        ? value.previous.version
        : Math.max(0, version - 1);
      result.previous = {
        version: previousVersion,
        profile: previousProfile,
        ...(typeof value.previous.updatedAt === 'string' ? { updatedAt: value.previous.updatedAt } : {}),
      };
    } catch {
      // A corrupt old snapshot should not block the current approved profile.
    }
  }
  return result;
}

function stableRuleId(title: string, content: string): string {
  return `rule_${createHash('sha256').update(`${title}\u0000${content}`).digest('hex').slice(0, 20)}`;
}

function normalizeRule(value: unknown, existingId?: string): CreativeRule {
  if (!isRecord(value)) throw new CreativeLibraryError('创作规则必须是对象。');
  const allowed = new Set(['id', 'title', 'content', 'category', 'enabled']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new CreativeLibraryError(`创作规则不支持字段：${key}`);
  }
  const title = cleanText(value.title, '规则标题', 600, true);
  const content = cleanText(value.content, '规则内容', MAX_RULE_TEXT_BYTES, true);
  const candidateId = value.id === undefined || value.id === null || value.id === '' ? existingId || stableRuleId(title, content) : value.id;
  const id = cleanIdentifier(candidateId, '规则 ID', /^rule_[A-Za-z0-9_-]{6,100}$/);
  const category = value.category === undefined || value.category === '' ? 'requirement' : value.category;
  if (category !== 'requirement' && category !== 'prohibition' && category !== 'style' && category !== 'workflow') {
    throw new CreativeLibraryError('规则分类不受支持。');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new CreativeLibraryError('规则启用状态必须是布尔值。');
  }
  return { id, title, content, category, enabled: value.enabled !== false };
}

function normalizeRules(value: unknown): CreativeRule[] {
  if (!Array.isArray(value) || value.length > MAX_RULES) {
    throw new CreativeLibraryError('创作规则必须是不超过 80 项的列表。');
  }
  const ids = new Set<string>();
  return value.map((item) => {
    const rule = normalizeRule(item);
    if (ids.has(rule.id)) throw new CreativeLibraryError('创作规则 ID 不能重复。');
    ids.add(rule.id);
    return rule;
  });
}

function parseRules(value: unknown): CreativeRules {
  if (!isRecord(value) || value.schema !== CREATIVE_RULES_SCHEMA || value.scope !== 'global') return emptyRules();
  const version = typeof value.version === 'number' && Number.isInteger(value.version) && value.version >= 0 ? value.version : 0;
  let items: CreativeRule[];
  try {
    items = normalizeRules(value.items || []);
  } catch {
    return emptyRules();
  }
  const result: CreativeRules = {
    schema: CREATIVE_RULES_SCHEMA,
    scope: 'global',
    initialized: value.initialized === true,
    version,
    items,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  };
  if (isRecord(value.previous)) {
    try {
      result.previous = {
        version: typeof value.previous.version === 'number' && Number.isInteger(value.previous.version)
          ? value.previous.version
          : Math.max(0, version - 1),
        items: normalizeRules(value.previous.items || []),
        ...(typeof value.previous.updatedAt === 'string' ? { updatedAt: value.previous.updatedAt } : {}),
      };
    } catch {
      // Retain the current rule set even if an older snapshot is malformed.
    }
  }
  return result;
}

function normalizeRulesPatch(value: unknown): CreativeRulesPatch {
  if (!isRecord(value)) throw new CreativeLibraryError('创作规则建议必须是对象。');
  for (const key of Object.keys(value)) {
    if (key !== 'upsert' && key !== 'removeIds') throw new CreativeLibraryError(`创作规则建议不支持字段：${key}`);
  }
  const patch: CreativeRulesPatch = {};
  if (value.upsert !== undefined) {
    if (!Array.isArray(value.upsert) || value.upsert.length > MAX_RULES) {
      throw new CreativeLibraryError('规则建议的新增项数量无效。');
    }
    patch.upsert = value.upsert.map((item) => normalizeRule(item));
  }
  if (value.removeIds !== undefined) {
    if (!Array.isArray(value.removeIds) || value.removeIds.length > MAX_RULES) {
      throw new CreativeLibraryError('规则建议的移除项数量无效。');
    }
    patch.removeIds = Array.from(new Set(value.removeIds.map((id) => cleanIdentifier(id, '规则 ID', /^rule_[A-Za-z0-9_-]{6,100}$/))));
  }
  if (!patch.upsert?.length && !patch.removeIds?.length) throw new CreativeLibraryError('规则建议不能是空的。');
  return patch;
}

function mergeRulesPatch(items: CreativeRule[], patch: CreativeRulesPatch): CreativeRule[] {
  const next = new Map(items.map((item) => [item.id, clone(item)]));
  for (const id of patch.removeIds || []) next.delete(id);
  for (const input of patch.upsert || []) {
    const requestedId = typeof input.id === 'string' && input.id ? input.id : undefined;
    const existing = requestedId ? next.get(requestedId) : undefined;
    const candidate = {
      ...(existing || {}),
      ...input,
      ...(requestedId ? { id: requestedId } : {}),
    };
    const rule = normalizeRule(candidate, requestedId);
    next.set(rule.id, rule);
  }
  if (next.size > MAX_RULES) throw new CreativeLibraryError('创作规则数量不能超过 80 项。');
  return [...next.values()];
}

function normalizeProposalSource(value: unknown): CreativeProposalSource {
  if (value === undefined || value === null) return { kind: 'manual', scriptIds: [] };
  if (!isRecord(value)) throw new CreativeLibraryError('建议来源必须是对象。');
  const kind = value.kind === undefined ? 'manual' : value.kind;
  if (kind !== 'published_scripts' && kind !== 'weekly_review' && kind !== 'manual') {
    throw new CreativeLibraryError('建议来源类型不受支持。');
  }
  const rawIds = value.scriptIds === undefined ? [] : value.scriptIds;
  if (!Array.isArray(rawIds) || rawIds.length > MAX_PROPOSAL_SOURCE_SCRIPTS) {
    throw new CreativeLibraryError('建议来源脚本数量无效。');
  }
  const scriptIds = Array.from(new Set(rawIds.map((id) => cleanIdentifier(id, '脚本 ID', /^script_[a-f0-9]{20}$/))));
  const note = value.note === undefined ? '' : cleanText(value.note, '建议来源说明', 2 * 1024);
  return { kind, scriptIds, ...(note ? { note } : {}) };
}

function normalizeProposalPatch(target: CreativeProposalTarget, value: unknown): CreativeProfilePatch | CreativeRulesPatch {
  return target === 'profile' ? normalizeProfilePatch(value) : normalizeRulesPatch(value);
}

function proposalPatchLanguage(target: CreativeProposalTarget, patch: CreativeProfilePatch | CreativeRulesPatch): string {
  if (target === 'profile') {
    const profile = patch as CreativeProfilePatch;
    return Object.values(profile)
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is string => typeof value === 'string')
      .join('\n');
  }
  return ((patch as CreativeRulesPatch).upsert || [])
    .flatMap((rule) => [rule.title, rule.content])
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
}

function inspectProposalLanguage(target: CreativeProposalTarget, patch: CreativeProfilePatch | CreativeRulesPatch, reason = '') {
  const review = inspectGeneratedLanguage([reason, proposalPatchLanguage(target, patch)].filter(Boolean).join('\n'));
  if (review.blocking.length) {
    throw new CreativeLibraryError('这条建议里还有对话式说明或敏感信息，暂时不能保存为写作参考。请重新生成。');
  }
  return review;
}

function parseProposal(value: unknown): CreativeUpdateProposal | null {
  if (!isRecord(value)) return null;
  try {
    const id = cleanIdentifier(value.id, '建议 ID', /^proposal_[A-Za-z0-9_-]{8,100}$/);
    const target = value.target;
    if (target !== 'profile' && target !== 'rules') return null;
    const status = value.status;
    if (status !== 'pending' && status !== 'accepted' && status !== 'rejected') return null;
    const baseVersion = typeof value.baseVersion === 'number' && Number.isInteger(value.baseVersion) && value.baseVersion >= 0
      ? value.baseVersion
      : 0;
    const createdAt = cleanText(value.createdAt, '建议创建时间', 120, true);
    const result: CreativeUpdateProposal = {
      id,
      target,
      status,
      reason: cleanText(value.reason, '建议原因', 8 * 1024, true),
      source: normalizeProposalSource(value.source),
      baseVersion,
      patch: normalizeProposalPatch(target, value.patch),
      createdAt,
    };
    if (typeof value.resolvedAt === 'string') result.resolvedAt = cleanText(value.resolvedAt, '建议处理时间', 120, true);
    if (value.resolution === 'accepted' || value.resolution === 'rejected' || value.resolution === 'edited') {
      result.resolution = value.resolution;
    }
    if (value.appliedPatch !== undefined) result.appliedPatch = normalizeProposalPatch(target, value.appliedPatch);
    if (Array.isArray(value.languageWarnings)) {
      result.languageWarnings = value.languageWarnings.filter((item): item is GeneratedLanguageFinding => (
        isRecord(item) && typeof item.code === 'string' && typeof item.message === 'string'
      ));
    }
    return result;
  } catch {
    return null;
  }
}

function parseProposals(value: unknown): CreativeProposals {
  if (!isRecord(value) || value.schema !== CREATIVE_PROPOSALS_SCHEMA || !Array.isArray(value.items)) return emptyProposals();
  const ids = new Set<string>();
  const items = value.items
    .map(parseProposal)
    .filter((item): item is CreativeUpdateProposal => Boolean(item))
    .filter((item) => {
      if (ids.has(item.id)) return false;
      ids.add(item.id);
      return true;
    })
    .slice(-MAX_PROPOSALS);
  return {
    schema: CREATIVE_PROPOSALS_SCHEMA,
    items,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  };
}

function cleanPublishedScript(value: unknown): PublishedScript | null {
  if (!isRecord(value)) return null;
  try {
    const id = cleanIdentifier(value.id, '脚本 ID', /^script_[a-f0-9]{20}$/);
    const sourceRecordId = cleanIdentifier(value.sourceRecordId, '发布记录 ID', /^publication_[a-f0-9]{20}$/);
    const platform = value.platform;
    if (platform !== 'wechat' && platform !== 'xiaohongshu' && platform !== 'moments' && platform !== 'shipinhao' && platform !== 'douyin') {
      return null;
    }
    const form = value.form;
    if (form !== 'wechat_article' && form !== 'xiaohongshu_post' && form !== 'moments_post' && form !== 'video_script' && form !== 'unknown') {
      return null;
    }
    if (!isRecord(value.performance) || !isRecord(value.performance.metrics)) return null;
    const metrics: Record<string, number> = {};
    for (const [key, metric] of Object.entries(value.performance.metrics)) {
      if (!/^[a-z_]{2,40}$/.test(key) || typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0) continue;
      metrics[key] = metric;
    }
    const content = cleanText(value.content, '脚本文本', MAX_SCRIPT_CONTENT_BYTES, true);
    const contentHash = cleanIdentifier(value.contentHash, '脚本哈希', /^[a-f0-9]{64}$/);
    if (contentHash !== createHash('sha256').update(content).digest('hex')) return null;
    const sourceLedgerPath = cleanText(value.sourceLedgerPath, '发布台账路径', 2 * 1024, true);
    const sourceQueuePath = cleanText(value.sourceQueuePath, '发布队列路径', 2 * 1024, true);
    const sourceContentPath = value.sourceContentPath === undefined ? '' : cleanText(value.sourceContentPath, '脚本来源路径', 2 * 1024);
    const publicationUrl = value.publicationUrl === undefined ? '' : cleanText(value.publicationUrl, '发布链接', 2 * 1024);
    return {
      id,
      sourceRecordId,
      sourceLedgerPath,
      sourceQueuePath,
      runId: cleanText(value.runId, 'run ID', 200, true),
      jobId: cleanIdentifier(value.jobId, '发布任务 ID', /^draft_[a-f0-9]{20}$/),
      title: cleanText(value.title, '脚本标题', 2 * 1024, true),
      platform,
      form,
      publishedAt: cleanText(value.publishedAt, '发布时间', 120, true),
      ...(publicationUrl ? { publicationUrl } : {}),
      hasLocalProof: value.hasLocalProof === true,
      ...(sourceContentPath ? { sourceContentPath } : {}),
      contentHash,
      content,
      excerpt: cleanText(value.excerpt, '脚本摘要', 2 * 1024, true),
      learnable: value.learnable === true,
      performance: {
        metrics,
        ...(typeof value.performance.updatedAt === 'string' ? { updatedAt: value.performance.updatedAt } : {}),
      },
      collectedAt: cleanText(value.collectedAt, '收录时间', 120, true),
    };
  } catch {
    return null;
  }
}

function parsePublishedScripts(value: unknown): PublishedScriptLibrary {
  if (!isRecord(value) || value.schema !== PUBLISHED_SCRIPT_LIBRARY_SCHEMA || !Array.isArray(value.items)) {
    return emptyPublishedScripts();
  }
  const records = new Set<string>();
  const items = value.items
    .map(cleanPublishedScript)
    .filter((item): item is PublishedScript => Boolean(item))
    .filter((item) => {
      if (records.has(item.sourceRecordId)) return false;
      records.add(item.sourceRecordId);
      return true;
    })
    .slice(-MAX_PUBLISHED_SCRIPTS);
  return {
    schema: PUBLISHED_SCRIPT_LIBRARY_SCHEMA,
    items,
    ...(typeof value.updatedAt === 'string' ? { updatedAt: value.updatedAt } : {}),
  };
}

export async function readCreativeProfile(): Promise<CreativeProfile> {
  return parseProfile(await readStoredJson(PROFILE_PATH));
}

export async function readCreativeRules(): Promise<CreativeRules> {
  return parseRules(await readStoredJson(RULES_PATH));
}

export async function readCreativeProposals(): Promise<CreativeProposals> {
  return parseProposals(await readStoredJson(PROPOSALS_PATH));
}

export async function readPublishedScriptLibrary(): Promise<PublishedScriptLibrary> {
  return parsePublishedScripts(await readStoredJson(PUBLISHED_SCRIPTS_PATH));
}

export async function saveCreativeProfile(input: {
  action: 'initialize' | 'update';
  profile: unknown;
  expectedVersion?: number;
}): Promise<CreativeProfile> {
  const current = await readCreativeProfile();
  if (input.expectedVersion !== undefined) assertCreativeVersion(input.expectedVersion, current.version);
  if (input.action === 'initialize' && current.initialized) {
    throw new CreativeLibraryError('创作名片已经初始化，请使用更新操作。');
  }
  if (input.action === 'update' && !current.initialized) {
    throw new CreativeLibraryError('请先手动初始化创作名片。');
  }
  const nextProfile = mergeProfile(current.profile, normalizeProfilePatch(input.profile));
  if (!profileHasContent(nextProfile)) throw new CreativeLibraryError('创作名片至少需要填写一项内容。');
  const now = new Date().toISOString();
  const next: CreativeProfile = {
    schema: CREATIVE_PROFILE_SCHEMA,
    scope: 'global',
    initialized: true,
    version: current.version + 1,
    profile: nextProfile,
    updatedAt: now,
    ...(current.initialized ? {
      previous: {
        version: current.version,
        profile: clone(current.profile),
        ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
      },
    } : {}),
  };
  await writeStoredJson(PROFILE_PATH, next);
  return next;
}

export async function saveCreativeRules(input: {
  action: 'initialize' | 'update';
  items: unknown;
  expectedVersion?: number;
}): Promise<CreativeRules> {
  const current = await readCreativeRules();
  if (input.expectedVersion !== undefined) assertCreativeVersion(input.expectedVersion, current.version);
  if (input.action === 'initialize' && current.initialized) {
    throw new CreativeLibraryError('创作规则已经初始化，请使用更新操作。');
  }
  if (input.action === 'update' && !current.initialized) {
    throw new CreativeLibraryError('请先初始化创作规则。');
  }
  const items = normalizeRules(input.items);
  const now = new Date().toISOString();
  const next: CreativeRules = {
    schema: CREATIVE_RULES_SCHEMA,
    scope: 'global',
    initialized: true,
    version: current.version + 1,
    items,
    updatedAt: now,
    ...(current.initialized ? {
      previous: {
        version: current.version,
        items: clone(current.items),
        ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
      },
    } : {}),
  };
  await writeStoredJson(RULES_PATH, next);
  return next;
}

async function applyProfilePatch(patch: CreativeProfilePatch): Promise<CreativeProfile> {
  const current = await readCreativeProfile();
  if (!current.initialized) throw new CreativeLibraryError('请先手动初始化创作名片，AI 建议才可以生效。');
  const nextProfile = mergeProfile(current.profile, patch);
  if (!profileHasContent(nextProfile)) throw new CreativeLibraryError('创作名片至少需要填写一项内容。');
  const now = new Date().toISOString();
  const next: CreativeProfile = {
    schema: CREATIVE_PROFILE_SCHEMA,
    scope: 'global',
    initialized: true,
    version: current.version + 1,
    profile: nextProfile,
    updatedAt: now,
    previous: {
      version: current.version,
      profile: clone(current.profile),
      ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
    },
  };
  await writeStoredJson(PROFILE_PATH, next);
  return next;
}

async function applyCreativeRulesPatch(patch: CreativeRulesPatch): Promise<CreativeRules> {
  const current = await readCreativeRules();
  if (!current.initialized) throw new CreativeLibraryError('请先初始化创作规则，AI 建议才可以生效。');
  const now = new Date().toISOString();
  const next: CreativeRules = {
    schema: CREATIVE_RULES_SCHEMA,
    scope: 'global',
    initialized: true,
    version: current.version + 1,
    items: mergeRulesPatch(current.items, patch),
    updatedAt: now,
    previous: {
      version: current.version,
      items: clone(current.items),
      ...(current.updatedAt ? { updatedAt: current.updatedAt } : {}),
    },
  };
  await writeStoredJson(RULES_PATH, next);
  return next;
}

export async function createCreativeProposal(input: {
  target: CreativeProposalTarget;
  reason: unknown;
  source?: unknown;
  patch: unknown;
}): Promise<CreativeUpdateProposal> {
  if (input.target !== 'profile' && input.target !== 'rules') throw new CreativeLibraryError('建议目标不受支持。');
  const [proposals, profile, rules] = await Promise.all([
    readCreativeProposals(),
    readCreativeProfile(),
    readCreativeRules(),
  ]);
  if (proposals.items.length >= MAX_PROPOSALS) throw new CreativeLibraryError('待存建议过多，请先处理历史建议。');
  const now = new Date().toISOString();
  const reason = cleanText(input.reason, '建议原因', 8 * 1024, true);
  const patch = normalizeProposalPatch(input.target, input.patch);
  const language = inspectProposalLanguage(input.target, patch, reason);
  const proposal: CreativeUpdateProposal = {
    id: `proposal_${randomUUID().replace(/-/g, '')}`,
    target: input.target,
    status: 'pending',
    reason,
    source: normalizeProposalSource(input.source),
    baseVersion: input.target === 'profile' ? profile.version : rules.version,
    patch,
    createdAt: now,
    ...(language.warnings.length ? { languageWarnings: language.warnings } : {}),
  };
  const next: CreativeProposals = {
    schema: CREATIVE_PROPOSALS_SCHEMA,
    items: [...proposals.items, proposal].slice(-MAX_PROPOSALS),
    updatedAt: now,
  };
  await writeStoredJson(PROPOSALS_PATH, next);
  return proposal;
}

export async function resolveCreativeProposal(input: {
  action: 'accept' | 'reject' | 'edit';
  proposalId: unknown;
  patch?: unknown;
}): Promise<{
  proposal: CreativeUpdateProposal;
  profile?: CreativeProfile;
  rules?: CreativeRules;
  pending: CreativeLibraryPendingCounts;
}> {
  const proposalId = cleanIdentifier(input.proposalId, '建议 ID', /^proposal_[A-Za-z0-9_-]{8,100}$/);
  const proposals = await readCreativeProposals();
  const index = proposals.items.findIndex((item) => item.id === proposalId);
  if (index < 0) throw new CreativeLibraryError('创作建议不存在。');
  const current = proposals.items[index];
  if (current.status !== 'pending') throw new CreativeLibraryError('这条创作建议已经处理过。');
  const now = new Date().toISOString();
  let profile: CreativeProfile | undefined;
  let rules: CreativeRules | undefined;
  let resolved: CreativeUpdateProposal;

  if (input.action === 'reject') {
    resolved = { ...current, status: 'rejected', resolution: 'rejected', resolvedAt: now };
  } else {
    const latest = current.target === 'profile' ? await readCreativeProfile() : await readCreativeRules();
    assertCreativeVersion(current.baseVersion, latest.version);
    const appliedPatch = input.action === 'edit'
      ? normalizeProposalPatch(current.target, input.patch)
      : current.patch;
    inspectProposalLanguage(current.target, appliedPatch);
    if (current.target === 'profile') {
      profile = await applyProfilePatch(appliedPatch as CreativeProfilePatch);
    } else {
      rules = await applyCreativeRulesPatch(appliedPatch as CreativeRulesPatch);
    }
    resolved = {
      ...current,
      status: 'accepted',
      resolution: input.action === 'edit' ? 'edited' : 'accepted',
      resolvedAt: now,
      appliedPatch,
    };
  }
  const items = [...proposals.items];
  items[index] = resolved;
  const next: CreativeProposals = {
    schema: CREATIVE_PROPOSALS_SCHEMA,
    items,
    updatedAt: now,
  };
  await writeStoredJson(PROPOSALS_PATH, next);
  return { proposal: resolved, ...(profile ? { profile } : {}), ...(rules ? { rules } : {}), pending: proposalPendingCounts(next) };
}

export function proposalPendingCounts(proposals: CreativeProposals): CreativeLibraryPendingCounts {
  const profile = proposals.items.filter((item) => item.status === 'pending' && item.target === 'profile').length;
  const rules = proposals.items.filter((item) => item.status === 'pending' && item.target === 'rules').length;
  return { profile, rules, total: profile + rules };
}

export async function listCreativeProposals(options: {
  target?: CreativeProposalTarget;
  status?: CreativeProposalStatus;
} = {}): Promise<{ items: CreativeUpdateProposal[]; pending: CreativeLibraryPendingCounts }> {
  const proposals = await readCreativeProposals();
  const items = proposals.items
    .filter((item) => !options.target || item.target === options.target)
    .filter((item) => !options.status || item.status === options.status)
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  return { items, pending: proposalPendingCounts(proposals) };
}

function formForJob(job: DraftJob): PublishedScriptForm {
  if (job.platform === 'wechat') return 'wechat_article';
  if (job.platform === 'xiaohongshu') return 'xiaohongshu_post';
  if (job.platform === 'moments') return 'moments_post';
  if (job.platform === 'shipinhao' || job.platform === 'douyin') return 'video_script';
  return 'unknown';
}

function candidateTitle(record: PublicationRecord, job?: DraftJob): string {
  return (job?.payload.title || job?.item_label || record.item_id || '未命名发布内容').trim().slice(0, 300);
}

function scriptSourcePaths(job: DraftJob | undefined): string[] {
  if (!job) return [];
  return [job.payload.copy_path, job.payload.html_path, job.payload.execution_package_path]
    .filter((path): path is string => typeof path === 'string' && Boolean(path.trim()))
    .map((path) => path.replace(/\\/g, '/').replace(/^\/+/, ''))
    .filter((path, index, all) => all.indexOf(path) === index)
    .filter((path) => !path.includes('\0') && !path.split('/').some((part) => !part || part === '.' || part === '..'));
}

async function readableScriptSource(job: DraftJob | undefined): Promise<{ path?: string; content?: string }> {
  for (const relativePath of scriptSourcePaths(job)) {
    if (!SCRIPT_TEXT_EXTENSIONS.has(extname(relativePath).toLowerCase())) continue;
    const target = safeResolve(PROJECT_DIR, relativePath);
    if (!target) continue;
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > MAX_SCRIPT_CONTENT_BYTES) continue;
      const content = await readFile(target, 'utf-8');
      if (!content.trim() || textBytes(content) > MAX_SCRIPT_CONTENT_BYTES) continue;
      return { path: relativePath, content: content.trim() };
    } catch {
      // An unavailable old delivery must not make the rest of the library unreadable.
    }
  }
  return {};
}

type LedgerRecordSource = {
  ledgerPath: string;
  ledger: PublicationLedger;
  record: PublicationRecord;
  queue?: DraftQueue;
  job?: DraftJob;
};

async function publicationLedgerPaths(): Promise<string[]> {
  const root = safeResolve(PROJECT_DIR, PUBLICATION_LEDGER_ROOT);
  if (!root) return [];
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) return [];
    const entries = await readdir(root, { withFileTypes: true });
    const paths: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = `${root}${sep}${entry.name}`;
      const directoryInfo = await lstat(directory).catch(() => null);
      if (!directoryInfo || directoryInfo.isSymbolicLink()) continue;
      const relativePath = `${PUBLICATION_LEDGER_ROOT}/${entry.name}/publication-ledger.json`;
      if (!isPublicationLedgerPath(relativePath)) continue;
      const file = safeResolve(PROJECT_DIR, relativePath);
      if (!file) continue;
      const fileInfo = await lstat(file).catch(() => null);
      if (!fileInfo || fileInfo.isSymbolicLink() || !fileInfo.isFile()) continue;
      paths.push(relativePath);
    }
    return paths.sort();
  } catch {
    return [];
  }
}

async function confirmedPublicationSources(): Promise<LedgerRecordSource[]> {
  const paths = await publicationLedgerPaths();
  const sources: LedgerRecordSource[] = [];
  for (const ledgerPath of paths) {
    let ledger: PublicationLedger;
    try {
      ledger = await readPublicationLedger(ledgerPath);
    } catch {
      continue;
    }
    let queue: DraftQueue | undefined;
    try {
      queue = await readDraftQueue(ledger.queue_path);
      if (queue.run_id !== ledger.run_id || queue.queue_id !== ledger.queue_id) queue = undefined;
    } catch {
      queue = undefined;
    }
    for (const record of ledger.records) {
      if (record.human_confirmed !== true) continue;
      const job = queue?.jobs.find((item) => item.job_id === record.job_id);
      sources.push({ ledgerPath, ledger, record, ...(queue ? { queue } : {}), ...(job ? { job } : {}) });
    }
  }
  return sources.sort((left, right) => (
    new Date(right.record.published_at).getTime() - new Date(left.record.published_at).getTime()
    || right.record.record_id.localeCompare(left.record.record_id)
  ));
}

function scriptExcerpt(content: string): string {
  return content.replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function candidateFromSource(source: LedgerRecordSource, collectedByRecord: Map<string, PublishedScript>): Promise<PublishedScriptCandidate> {
  const sourceFile = await readableScriptSource(source.job);
  const existing = collectedByRecord.get(source.record.record_id);
  return {
    sourceRecordId: source.record.record_id,
    sourceLedgerPath: source.ledgerPath,
    sourceQueuePath: source.ledger.queue_path,
    runId: source.ledger.run_id,
    jobId: source.record.job_id,
    title: candidateTitle(source.record, source.job),
    platform: source.record.platform,
    form: source.job ? formForJob(source.job) : 'unknown',
    publishedAt: source.record.published_at,
    ...(source.record.published_url ? { publicationUrl: source.record.published_url } : {}),
    hasLocalProof: Boolean(source.record.proof_path && source.record.proof_sha256),
    ...(sourceFile.path ? { sourceContentPath: sourceFile.path } : {}),
    contentAvailable: Boolean(sourceFile.content),
    collected: Boolean(existing),
    ...(existing ? { scriptId: existing.id } : {}),
  };
}

export async function listPublishedScriptCandidates(): Promise<PublishedScriptCandidate[]> {
  const [library, sources] = await Promise.all([readPublishedScriptLibrary(), confirmedPublicationSources()]);
  const collected = new Map(library.items.map((item) => [item.sourceRecordId, item]));
  return Promise.all(sources.map((source) => candidateFromSource(source, collected)));
}

function scriptSummary(item: PublishedScript): PublishedScriptSummary {
  const summary = clone(item) as Partial<PublishedScript>;
  delete summary.content;
  return summary as PublishedScriptSummary;
}

export async function listPublishedScripts(options: { offset?: number; limit?: number } = {}): Promise<{
  items: PublishedScriptSummary[];
  total: number;
  offset: number;
  limit: number;
}> {
  const library = await readPublishedScriptLibrary();
  const sorted = [...library.items].sort((left, right) => (
    new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime()
    || new Date(right.collectedAt).getTime() - new Date(left.collectedAt).getTime()
  ));
  const offset = Math.max(0, Math.floor(options.offset || 0));
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit || 50)));
  return { items: sorted.slice(offset, offset + limit).map(scriptSummary), total: sorted.length, offset, limit };
}

export async function getPublishedScript(id: unknown): Promise<PublishedScript> {
  const scriptId = cleanIdentifier(id, '脚本 ID', /^script_[a-f0-9]{20}$/);
  const library = await readPublishedScriptLibrary();
  const item = library.items.find((candidate) => candidate.id === scriptId);
  if (!item) throw new CreativeLibraryError('已发布脚本不存在。');
  return clone(item);
}

export async function collectPublishedScript(sourceRecordIdInput: unknown): Promise<{
  item: PublishedScript;
  idempotent: boolean;
}> {
  const sourceRecordId = cleanIdentifier(sourceRecordIdInput, '发布记录 ID', /^publication_[a-f0-9]{20}$/);
  const library = await readPublishedScriptLibrary();
  const existing = library.items.find((item) => item.sourceRecordId === sourceRecordId);
  if (existing) return { item: clone(existing), idempotent: true };

  const source = (await confirmedPublicationSources()).find((candidate) => candidate.record.record_id === sourceRecordId);
  if (!source) throw new CreativeLibraryError('找不到已人工确认的发布记录。');
  const now = new Date().toISOString();
  const item = await publishedScriptFromSource(source, now);
  const next: PublishedScriptLibrary = {
    schema: PUBLISHED_SCRIPT_LIBRARY_SCHEMA,
    items: [...library.items, item].slice(-MAX_PUBLISHED_SCRIPTS),
    updatedAt: now,
  };
  await writeStoredJson(PUBLISHED_SCRIPTS_PATH, next);
  return { item, idempotent: false };
}

async function publishedScriptFromSource(source: LedgerRecordSource, collectedAt: string): Promise<PublishedScript> {
  const sourceFile = await readableScriptSource(source.job);
  const fallbackContent = [source.job?.payload.title || source.job?.item_label || source.record.item_id, source.job?.payload.summary || '']
    .filter(Boolean)
    .join('\n\n')
    .trim();
  const content = sourceFile.content || fallbackContent;
  if (!content) throw new CreativeLibraryError('该发布记录没有可收录的内容文本。');
  const contentHash = createHash('sha256').update(content).digest('hex');
  return {
    id: `script_${createHash('sha256').update(source.record.record_id).digest('hex').slice(0, 20)}`,
    sourceRecordId: source.record.record_id,
    sourceLedgerPath: source.ledgerPath,
    sourceQueuePath: source.ledger.queue_path,
    runId: source.ledger.run_id,
    jobId: source.record.job_id,
    title: candidateTitle(source.record, source.job),
    platform: source.record.platform,
    form: source.job ? formForJob(source.job) : 'unknown',
    publishedAt: source.record.published_at,
    ...(source.record.published_url ? { publicationUrl: source.record.published_url } : {}),
    hasLocalProof: Boolean(source.record.proof_path && source.record.proof_sha256),
    ...(sourceFile.path ? { sourceContentPath: sourceFile.path } : {}),
    contentHash,
    content,
    excerpt: scriptExcerpt(content),
    learnable: Boolean(sourceFile.content),
    performance: { metrics: {} },
    collectedAt,
  };
}

/**
 * Collects every currently readable human-confirmed publication in one local
 * transaction. Existing source records are left untouched, making repeated
 * clicks safe for the desktop UI.
 */
export async function collectAllPublishedScripts(): Promise<{
  created: number;
  existing: number;
  items: PublishedScriptSummary[];
}> {
  const [library, sources] = await Promise.all([readPublishedScriptLibrary(), confirmedPublicationSources()]);
  const existingByRecord = new Map(library.items.map((item) => [item.sourceRecordId, item]));
  const seenRecordIds = new Set<string>();
  const createdItems: PublishedScript[] = [];
  const processed: PublishedScript[] = [];
  let existing = 0;
  const now = new Date().toISOString();

  for (const source of sources) {
    if (seenRecordIds.has(source.record.record_id)) continue;
    seenRecordIds.add(source.record.record_id);
    const current = existingByRecord.get(source.record.record_id);
    if (current) {
      existing += 1;
      processed.push(current);
      continue;
    }
    const item = await publishedScriptFromSource(source, now);
    createdItems.push(item);
    processed.push(item);
  }

  if (createdItems.length) {
    const next: PublishedScriptLibrary = {
      schema: PUBLISHED_SCRIPT_LIBRARY_SCHEMA,
      items: [...library.items, ...createdItems].slice(-MAX_PUBLISHED_SCRIPTS),
      updatedAt: now,
    };
    await writeStoredJson(PUBLISHED_SCRIPTS_PATH, next);
  }
  return {
    created: createdItems.length,
    existing,
    items: processed.map(scriptSummary),
  };
}

/**
 * Compact approved context for future content-generation wiring. Pending AI
 * proposals are deliberately excluded: only the manual/accepted current state
 * can constrain a production run.
 */
export async function creativeLibraryContext(): Promise<string> {
  const [profile, rules] = await Promise.all([readCreativeProfile(), readCreativeRules()]);
  const blocks: string[] = [];
  if (profile.initialized) {
    const fields = profile.profile;
    const values: Array<[string, string]> = ([
      ['创作者', fields.creatorName],
      ['账号类型', fields.accountType],
      ['身份定位', fields.identity],
      ['目标受众', fields.targetAudience],
      ['自我介绍', fields.introduction],
      ['行文风格', fields.writingStyle],
      ['表达偏好', fields.expressionPreferences],
      ['视觉偏好', fields.visualPreferences],
      ['热点边界', fields.topicBoundaries],
      ['禁忌', fields.prohibitions],
    ] as Array<[string, string]>).filter(([, value]) => Boolean(value));
    if (fields.contentPillars.length) values.splice(4, 0, ['内容支柱', fields.contentPillars.join('、')]);
    if (values.length) blocks.push(['# 已确认的创作名片', ...values.map(([label, value]) => `- ${label}：${value}`)].join('\n'));
  }
  const activeRules = rules.initialized ? rules.items.filter((rule) => rule.enabled) : [];
  if (activeRules.length) {
    blocks.push(['# 已确认的创作规则', ...activeRules.map((rule) => `- [${rule.category}] ${rule.title}：${rule.content}`)].join('\n'));
  }
  return blocks.length ? ['以下是作者确认的长期默认设置；本篇明确提出的要求优先，不能用默认设置覆盖本篇选择。', ...blocks].join('\n\n') : '';
}

export async function getCreativeLibraryOverview(options: { scriptsLimit?: number } = {}): Promise<CreativeLibraryOverview> {
  const [profile, rules, proposals, scripts, candidates] = await Promise.all([
    readCreativeProfile(),
    readCreativeRules(),
    readCreativeProposals(),
    listPublishedScripts({ limit: options.scriptsLimit || 20 }),
    listPublishedScriptCandidates(),
  ]);
  return {
    profile,
    rules,
    pending: proposalPendingCounts(proposals),
    publishedScripts: {
      items: scripts.items,
      total: scripts.total,
      candidatesTotal: candidates.filter((item) => !item.collected).length,
    },
  };
}
