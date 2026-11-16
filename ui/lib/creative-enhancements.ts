import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PROJECT_DIR, safeResolve } from './project-root';
import { listRuntimeRuns, runsForPipelinePath, type RuntimeRun } from './runtime-run-resolver';
import { inspectGeneratedLanguage, type GeneratedLanguageFinding } from './product-voice';
import { KnownUserFacingError } from './user-facing-error';

export const CREATIVE_ENHANCEMENT_TOOLS = [
  'dbs-diagnosis',
  'dbs-benchmark',
  'dbs-content',
  'dbs-chatroom',
  'dbs-action',
  'dbs-decision',
  'dbs-goal',
  'dbs-resonate',
  'dbs-spread',
  'dbs-slowisfast',
] as const;

export type CreativeEnhancementTool = (typeof CREATIVE_ENHANCEMENT_TOOLS)[number];
export type CreativeEnhancementStage = 'topic-template' | 'content-package';

export type AdoptedCreativeEnhancement = {
  id: string;
  runId: string;
  projectId: string;
  stage: CreativeEnhancementStage;
  tool: CreativeEnhancementTool;
  sourcePath: string;
  adoptedText: string;
  adoptedAt: string;
  languageWarnings?: GeneratedLanguageFinding[];
};

type CreativeEnhancementArchive = {
  schema: 'aifios.creative-enhancements.v1';
  runId: string;
  projectId: string;
  items: AdoptedCreativeEnhancement[];
  updatedAt: string;
};

const ROOT = 'materials/creative-enhancements';
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RUN_ID_RE = /^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/;
const SOURCE_RE = /^pipeline\/dbs-fusion\/[^\\/\s]+\.md$/;
const MAX_ADOPTED_TEXT_LENGTH = 12_000;
const MAX_ITEMS = 40;

export class CreativeEnhancementError extends Error {}

function cleanProjectId(value: string): string {
  const projectId = value.trim().toLowerCase();
  if (!PROJECT_ID_RE.test(projectId)) throw new CreativeEnhancementError('项目 ID 格式不正确。');
  return projectId;
}

function cleanRunId(value: string): string {
  const runId = value.trim();
  if (!RUN_ID_RE.test(runId)) throw new CreativeEnhancementError('run ID 格式不正确。');
  return runId;
}

function cleanTool(value: string): CreativeEnhancementTool {
  if (!(CREATIVE_ENHANCEMENT_TOOLS as readonly string[]).includes(value)) {
    throw new CreativeEnhancementError('该创作增强工具未启用。');
  }
  return value as CreativeEnhancementTool;
}

function cleanStage(value: string): CreativeEnhancementStage {
  if (value !== 'topic-template' && value !== 'content-package') {
    throw new CreativeEnhancementError('创作增强只能在选题或最终内容阶段采用。');
  }
  return value;
}

function cleanText(value: string): string {
  const text = value.trim();
  if (!text) throw new CreativeEnhancementError('请先生成并选择一条可采用的增强结论。');
  if (text.length > MAX_ADOPTED_TEXT_LENGTH) throw new CreativeEnhancementError('创作增强结论过长。');
  return text;
}

function archivePath(projectId: string, runId: string): string {
  return `${ROOT}/${projectId}/${runId}/adoptions.json`;
}

function emptyArchive(projectId: string, runId: string): CreativeEnhancementArchive {
  return {
    schema: 'aifios.creative-enhancements.v1',
    projectId,
    runId,
    items: [],
    updatedAt: new Date().toISOString(),
  };
}

function asArchive(value: unknown, projectId: string, runId: string): CreativeEnhancementArchive {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyArchive(projectId, runId);
  const record = value as Partial<CreativeEnhancementArchive>;
  if (record.schema !== 'aifios.creative-enhancements.v1' || record.projectId !== projectId || record.runId !== runId || !Array.isArray(record.items)) {
    return emptyArchive(projectId, runId);
  }
  return {
    ...emptyArchive(projectId, runId),
    items: record.items.filter((item): item is AdoptedCreativeEnhancement => (
      Boolean(item)
      && item.runId === runId
      && item.projectId === projectId
      && typeof item.adoptedText === 'string'
      && typeof item.sourcePath === 'string'
      && typeof item.adoptedAt === 'string'
      && (CREATIVE_ENHANCEMENT_TOOLS as readonly string[]).includes(item.tool)
      && (item.stage === 'topic-template' || item.stage === 'content-package')
    )).slice(-MAX_ITEMS),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
  };
}

async function currentRun(runId: string, projectId: string): Promise<RuntimeRun> {
  const run = (await listRuntimeRuns()).find((item) => item.run_id === runId);
  if (!run) throw new CreativeEnhancementError('当前 run 不存在或已不可读取。');
  if ((run.project_id || 'default') !== projectId) {
    throw new CreativeEnhancementError('创作增强结论不能跨项目写入当前内容任务。');
  }
  return run;
}

async function readArchive(projectId: string, runId: string): Promise<CreativeEnhancementArchive> {
  const relativePath = archivePath(projectId, runId);
  const path = safeResolve(PROJECT_DIR, relativePath);
  if (!path) throw new CreativeEnhancementError('创作增强存档路径不合法。');
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isFile()) return emptyArchive(projectId, runId);
    return asArchive(JSON.parse(await readFile(path, 'utf-8')), projectId, runId);
  } catch {
    return emptyArchive(projectId, runId);
  }
}

async function writeArchive(archive: CreativeEnhancementArchive): Promise<string> {
  const relativePath = archivePath(archive.projectId, archive.runId);
  const path = safeResolve(PROJECT_DIR, relativePath);
  if (!path) throw new CreativeEnhancementError('创作增强存档路径不合法。');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new CreativeEnhancementError('创作增强存档不能使用符号链接。');
  } catch (error) {
    if (error instanceof CreativeEnhancementError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(archive, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return relativePath;
}

export async function adoptCreativeEnhancement(input: {
  runId: string;
  projectId: string;
  stage: string;
  tool: string;
  sourcePath: string;
  adoptedText: string;
}): Promise<{ item: AdoptedCreativeEnhancement; archivePath: string }> {
  const runId = cleanRunId(input.runId);
  const projectId = cleanProjectId(input.projectId);
  const stage = cleanStage(input.stage);
  const tool = cleanTool(input.tool);
  const sourcePath = input.sourcePath.trim();
  if (!SOURCE_RE.test(sourcePath)) throw new CreativeEnhancementError('创作增强必须引用当前 run 的 DBS 输出。');
  const adoptedText = cleanText(input.adoptedText);
  const language = inspectGeneratedLanguage(adoptedText);
  if (language.blocking.length) {
    throw new KnownUserFacingError({
      error: '这条建议里还有对话式说明或敏感信息，暂时不能用于本期内容。请重新生成后再选择。',
      code: 'generated_language_blocked',
      action: { label: '重新生成', href: '/production' },
    }, { status: 409, detail: language.blocking });
  }
  await currentRun(runId, projectId);
  const sourceRuns = await runsForPipelinePath(sourcePath, 'dbs-fusion');
  if (!sourceRuns.some((run) => run.run_id === runId && (run.project_id || 'default') === projectId)) {
    throw new CreativeEnhancementError('DBS 输出不属于当前项目和当前内容任务。');
  }

  const archive = await readArchive(projectId, runId);
  const adoptedAt = new Date().toISOString();
  const item: AdoptedCreativeEnhancement = {
    id: `enhancement_${createHash('sha256').update(`${runId}:${tool}:${sourcePath}:${adoptedText}:${adoptedAt}`).digest('hex').slice(0, 20)}`,
    runId,
    projectId,
    stage,
    tool,
    sourcePath,
    adoptedText,
    adoptedAt,
    ...(language.warnings.length ? { languageWarnings: language.warnings } : {}),
  };
  const next: CreativeEnhancementArchive = {
    ...archive,
    items: [...archive.items, item].slice(-MAX_ITEMS),
    updatedAt: adoptedAt,
  };
  return { item, archivePath: await writeArchive(next) };
}

/** Returns only explicit, current-run conclusions for downstream generation. */
export async function creativeEnhancementContextForRun(runId: string): Promise<string> {
  const normalizedRunId = cleanRunId(runId);
  const run = (await listRuntimeRuns()).find((item) => item.run_id === normalizedRunId);
  if (!run) return '';
  const projectId = cleanProjectId(run.project_id || 'default');
  const archive = await readArchive(projectId, normalizedRunId);
  const items = archive.items.filter((item) => item.runId === normalizedRunId && item.projectId === projectId);
  if (!items.length) return '';
  return [
    '# 已确认使用的专项检查结论',
    '以下内容由用户明确选中，只用来调整表达、取舍和检查方式。不要把建议本身写成未经证实的事实、数据或账号分析结论。',
    ...items.map((item) => [
      `## ${item.tool} · ${item.stage}`,
      item.adoptedText,
      `来源：${item.sourcePath}`,
    ].join('\n')),
  ].join('\n\n');
}
