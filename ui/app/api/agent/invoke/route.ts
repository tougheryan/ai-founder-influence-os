import { recordRunModelCall } from '@/lib/service-call-records';
import { beginContentAttempt, checkpointContentAttempt, finishContentAttempt, type ContentAttempt } from '@/lib/content-attempts';
import { materialAnalysisFingerprint } from '@/lib/material-analysis-version';
import { withProjectWriteLock } from '@/lib/write-guard';
import { createHash } from 'node:crypto';
import { attachContentPlan, type ContentPlanBinding } from '@/lib/content-plan';
import { NextRequest } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { loadSkill, buildUserMessage } from '@/lib/skill-loader';
import { creativeLibraryContext } from '@/lib/creative-library';
import { readOutputFile } from '@/lib/output-files';
import { createLLMTextStream, validateLLMConfig } from '@/lib/llm-client';
import { getRuntimeStepBySkill } from '@/lib/pipeline-registry';
import { listRuntimeRuns, resolveRuntimeWriteTarget, runsForPipelinePath, type RuntimeRun, type RuntimeSourcePath } from '@/lib/runtime-run-resolver';
import { getRuntimeBlueprintApproval, validateRuntimeOutput, writeRuntimeOutput, verifyRuntimeAuthorSource, type AuthorSourceBinding } from '@/lib/runtime-writer';
import { attachAuthorSourceBinding, authorSourceInstructions, sameAuthorSource } from '@/lib/author-source';
import {
  assertMarketSnapshotBoundToIntake,
  marketSignalEvidenceFromReport,
  marketSnapshotBindingFromReport,
  type MarketSignalEvidence,
  type MarketSnapshotBinding,
} from '@/lib/tikomni-market-gate';
import { runContentReleaseGate } from '@/lib/content-release-gate';
import { inspectWritingRequirements } from '@/lib/writing-requirement-review';
import { verifiedMarketResearchContext } from '@/lib/market-research-context';
import { confirmedWritingBriefContext } from '@/lib/writing-brief';
import { benchmarkAdvisorContextForRun } from '@/lib/benchmark-advisor';
import { creativeEnhancementContextForRun } from '@/lib/creative-enhancements';
import {
  assertMaterialAnalysisCurrent,
  assertMaterialReadyForResearch,
  getMaterialAnalysisContext,
  getMaterialWritingRequirements,
  MaterialReadinessError,
  toMaterialAnalysisPromptContext,
  type MaterialAnalysisContext,
} from '@/lib/material-analysis';
import { materialDirectionFor } from '@/lib/material-direction';
import { resolveServerLLMConfig } from '@/lib/server-config';
import { assertActiveSkill, SkillNotActiveError } from '@/lib/skill-files';
import { redactLocalPaths } from '@/lib/project-root';
import { assertJsonInputSize, assertOptionalTextInput, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { inspectGeneratedLanguage, productVoiceInstructionForSkill } from '@/lib/product-voice';
import {
  expectedUserFacingErrorResponse,
  KnownUserFacingError,
  userFacingErrorPayload,
} from '@/lib/user-facing-error';
import type { SkillParamMap, SkillParamValue } from '@/lib/skill-loader';
import type { LLMConfig } from '@/lib/types';

class InvocationValidationError extends Error {}

function safeInvocationError(error: InvocationValidationError): KnownUserFacingError {
  const detail = error.message;
  let definition: ConstructorParameters<typeof KnownUserFacingError>[0];

  if (/安装清单|未启用|not active/i.test(detail)) {
    definition = {
      error: '这个功能当前不可用。',
      code: 'feature_not_available',
    };
  } else if (/内容完整性检查|发布前检查|全部内容.*不完整/i.test(detail)) {
    definition = {
      error: '全部内容还不完整，已停止保存。请重新生成。',
      code: 'content_release_blocked',
      action: { label: '重新生成全部内容', href: '/production?stage=3' },
    };
  } else if (/已停止保存|对话式说明|敏感信息|语言质量/i.test(detail)) {
    definition = {
      error: '内容里还残留对话式说明或敏感信息，已停止保存。请重新生成。',
      code: 'generated_language_blocked',
      action: { label: '重新生成', href: '/production' },
    };
  } else if (/素材输入已经变更|素材快照|素材判断.*变化|表达方向.*变化|解析文件.*不可读取|没有可用的本期素材分析/i.test(detail)) {
    definition = {
      error: '素材已经更新，请回到素材输入重新分析。',
      code: 'material_analysis_stale',
      action: { label: '重新分析素材', href: '/production' },
    };
  } else if (/素材判断|主类型|行文结构|内容结构/i.test(detail)) {
    definition = {
      error: '系统没有完成素材判断，请重新整理素材后再继续。',
      code: 'material_direction_required',
      action: { label: '重新整理素材', href: '/production' },
    };
  } else if (/不能跨任务保存|写入目标.*不一致|上游.*生成期间.*变化|当前 run 已归档|不能跨项目写入/i.test(detail)) {
    definition = {
      error: '当前任务已经变化，已停止保存。请刷新后重试。',
      code: 'task_changed',
    };
  } else if (/(?:思想母版蓝图|蓝图|立项报告).*(?:必须绑定|未绑定|快照|同一|原样写入)/i.test(detail)) {
    definition = {
      error: '提纲缺少当前选题数据，已停止保存。请重新生成提纲。',
      code: 'outline_data_missing',
      action: { label: '重新生成提纲', href: '/production' },
    };
  } else if (/TikOmni|三平台|研究快照|平台样本|爆款抓取|对标报告/i.test(detail)) {
    definition = {
      error: '平台数据不完整或已经变化，请重新获取后再继续。',
      code: 'platform_data_refresh_required',
      action: { label: '重新获取平台数据', href: '/production' },
    };
  } else if (/不存在|不可读取|必须是当前|必须绑定|未绑定/i.test(detail)) {
    definition = {
      error: '所需内容已变化或无法读取，请刷新后重试。',
      code: 'content_reference_unavailable',
    };
  } else {
    definition = {
      error: '填写内容不符合要求，请检查后重试。',
      code: 'invalid_request',
    };
  }

  return new KnownUserFacingError(definition, { status: 400, detail: error });
}

async function assertInvocableSkill(skill: string): Promise<void> {
  try {
    await assertActiveSkill(skill);
  } catch (error) {
    if (error instanceof SkillNotActiveError) {
      throw new InvocationValidationError(error.message);
    }
    throw error;
  }
}

type InvocationGate = {
  runId?: string;
  authorSourceBinding?: AuthorSourceBinding;
  writingBriefContext?: string;
  contentPlan?: ContentPlanBinding;
  marketSnapshotBinding?: MarketSnapshotBinding;
  marketEvidence?: MarketSignalEvidence & { reportPath: string };
};

async function verifiedAuthorSource(runId: string, blueprintPath?: string): Promise<AuthorSourceBinding> {
  try { return await verifyRuntimeAuthorSource(runId, blueprintPath); }
  catch {
    throw new KnownUserFacingError({
      error: '本期素材依据暂时无法核对。请回到素材页重新读取并确认，已有稿件保留。',
      code: 'author_source_unavailable',
      action: { label: '核对本期素材', href: '/production?stage=1' },
    }, { status: 409 });
  }
}

const MATERIAL_TEXT_REFERENCE_EXTENSIONS = new Set([
  '.csv',
  '.htm',
  '.html',
  '.json',
  '.md',
  '.rtf',
  '.txt',
]);
// Content intake runs before a concise runtime artifact exists.  Without a
// separate source budget, a 2 MB paste plus every extracted attachment can
// make the very first model call slow or impossible to complete.  We budget
// CJK text pessimistically at roughly one character per token.
const CONTENT_INTAKE_SOURCE_CHAR_BUDGET = 48_000;
const CONTENT_INTAKE_ANALYSIS_BRIEF_CHAR_BUDGET = 8_000;
const CONTENT_INTAKE_FILE_LABEL_CHAR_BUDGET = 220;
const CONTENT_INTAKE_FILE_PATH_CHAR_BUDGET = 360;
const RUNTIME_STEP_OVERRIDES_BY_SKILL: Record<string, string[]> = {
  'xhs-card': ['xhs', 'visual'],
  // DBS helpers are optional research/advisory providers. Their raw output is
  // kept in the run's fusion trail and only influences content after the
  // operator explicitly adopts a conclusion.
  'dbs-action': ['dbs-fusion'],
  'dbs-benchmark': ['dbs-fusion'],
  'dbs-chatroom': ['dbs-fusion'],
  'dbs-content': ['dbs-fusion'],
  'dbs-decision': ['dbs-fusion'],
  'dbs-deconstruct': ['dbs-fusion'],
  'dbs-diagnosis': ['dbs-fusion'],
  'dbs-goal': ['dbs-fusion'],
  'dbs-learning': ['dbs-fusion'],
  'dbs-resonate': ['dbs-fusion'],
  'dbs-slowisfast': ['dbs-fusion'],
  'dbs-spread': ['dbs-fusion'],
};
const DBS_ENHANCEMENT_SKILLS = new Set(Object.keys(RUNTIME_STEP_OVERRIDES_BY_SKILL).filter((skill) => skill.startsWith('dbs-')));
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9一-龥\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'untitled';
}

function encodeSystemEvent(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(redactLocalPaths(payload))}\n\n`;
}

function allowedRuntimeStepsForSkill(skill: string): string[] {
  return Array.from(new Set([
    getRuntimeStepBySkill(skill),
    ...(RUNTIME_STEP_OVERRIDES_BY_SKILL[skill] || []),
  ]));
}

function resolveRuntimeStepForSkill(skill: string, requestedRuntimeStep?: string): string {
  const runtimeStep = requestedRuntimeStep?.trim() || getRuntimeStepBySkill(skill);
  const allowedSteps = allowedRuntimeStepsForSkill(skill);
  if (!allowedSteps.includes(runtimeStep)) {
    throw new InvocationValidationError(
      `Runtime step 与 skill 不匹配：${skill} 不能写入 ${runtimeStep}。允许写入：${allowedSteps.join('、')}`
    );
  }
  return runtimeStep;
}

function replaceOrAppendSourceField(
  source: string,
  labelPattern: string,
  canonicalLabel: string,
  value: string,
): string {
  const fieldPattern = new RegExp(
    `^\\s*[-*]\\s*(?:\\*\\*)?(?:${labelPattern})(?:\\*\\*)?\\s*[：:].*$`,
    'gmi',
  );
  let replaced = false;
  const normalized = source.replace(fieldPattern, () => {
    if (replaced) return '';
    replaced = true;
    return `- ${canonicalLabel}：${value}`;
  });
  if (replaced) return normalized;
  return `${normalized.trimEnd()}\n- ${canonicalLabel}：${value}\n`;
}

function bindValidateMarketEvidence(
  content: string,
  marketEvidence: InvocationGate['marketEvidence'],
): string {
  if (!marketEvidence) return content;
  const sourceSection = /^##\s+0\.\s+素材来源\s*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/m;
  const match = sourceSection.exec(content);
  if (!match) return content;

  let source = match[1];
  source = replaceOrAppendSourceField(
    source,
    '公开样本(?:对标)?报告(?:路径)?|爆款抓取与(?:公开)?对标报告(?:路径)?',
    '公开样本对标报告',
    `\`${marketEvidence.reportPath}\``,
  );
  source = replaceOrAppendSourceField(
    source,
    '公开样本(?:对标)?状态|样本状态',
    '公开样本状态',
    '已完成',
  );
  source = replaceOrAppendSourceField(
    source,
    '可验证(?:公开)?样本数|公开(?:可验证)?样本数|样本数量',
    '可验证样本数',
    String(marketEvidence.sampleCount),
  );

  return `${content.slice(0, match.index)}## 0. 素材来源\n${source}${content.slice((match.index || 0) + match[0].length)}`;
}

type ValidateDecision = '通过' | '有条件通过' | '不通过';

function validateDecisionFromMarkdown(content: string): ValidateDecision | null {
  const decisionSection = /^##\s+1\.\s+立项决策\s*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/m.exec(content)?.[1] || '';
  const decision = /^\s*[-*]\s*(?:\*\*)?决策(?:\*\*)?\s*[：:]\s*(有条件通过|不通过|通过)/mi.exec(decisionSection)?.[1];
  return decision === '通过' || decision === '有条件通过' || decision === '不通过' ? decision : null;
}

/**
 * The strict research gate runs before this normalization. This function only
 * keeps the downstream legacy decision vocabulary deterministic.
 */
function forceValidateCreationPass(content: string): string {
  const decisionSection = /^##\s+1\.\s+立项决策\s*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/m.exec(content);
  if (!decisionSection || decisionSection.index === undefined) return content;

  let body = decisionSection[1];
  const decisionLine = /^(\s*[-*]\s*(?:\*\*)?决策(?:\*\*)?\s*[：:]\s*)(?:有条件通过|不通过|通过)[^\r\n]*$/mi;
  body = decisionLine.test(body)
    ? body.replace(decisionLine, '$1通过')
    : `- 决策：通过\n${body}`;

  const allowNextLine = /^(\s*[-*]\s*(?:\*\*)?(?:是否允许进入下一步|允许进入下一步)(?:\*\*)?\s*[：:]\s*).*$/mi;
  body = allowNextLine.test(body)
    ? body.replace(allowNextLine, '$1是（研究证据已通过）')
    : `${body.trimEnd()}\n- 是否允许进入下一步：是（研究证据已通过）\n`;

  const sectionEnd = decisionSection.index + decisionSection[0].length;
  return `${content.slice(0, decisionSection.index)}## 1. 立项决策\n${body}${content.slice(sectionEnd)}`;
}

/**
 * The decision is model-authored, but the next-step instruction is a fixed
 * workflow contract after the strict market evidence gate has passed.
 */
function ensureValidateNextStepMatchesDecision(content: string): string {
  const decision = validateDecisionFromMarkdown(content);
  if (!decision) return content;

  const nextSection = /^##\s+7\.\s+下一步\s*\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/m.exec(content);
  if (!nextSection || nextSection.index === undefined) return content;

  const body = nextSection[1];
  const hasRequiredDirection = /\/content-blueprint|content-blueprint|进入/.test(body);
  if (hasRequiredDirection) return content;

  const recoveryInstruction = decision === '通过'
    ? '- 进入 `/content-blueprint` 生成思想母版蓝图。'
    : '- 进入 `/content-blueprint` 生成低证据创作蓝图；保留素材补充清单与风险边界，不将缺失信息写成事实或结果承诺。';
  const sectionEnd = nextSection.index + nextSection[0].length;

  return `${content.slice(0, sectionEnd).trimEnd()}\n${recoveryInstruction}\n${content.slice(sectionEnd).trimStart()}`.trimEnd();
}

function normalizeValidateMarkdown(content: string, marketEvidence?: InvocationGate['marketEvidence']): string {
  const requiredHeadings = [
    '0. 素材来源',
    '1. 立项决策',
    '2. HKR 质检',
    '3. 商业成立性判断',
    '4. 平台首发策略',
    '5. 素材补充清单',
    '6. 风险提示',
    '7. 下一步',
  ];
  const escapedHeadings = requiredHeadings.map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const requiredHeadingRe = new RegExp(`^#{2,6}\\s*(${escapedHeadings.join('|')})\\s*$`, 'u');

  const normalized = content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const titleMatch = line.match(/^#{2,6}\s*(选题立项(?:报告|决策)?(?:\s*·.*)?)\s*$/u);
      if (titleMatch) return `# ${titleMatch[1]}`;

      const headingMatch = line.match(requiredHeadingRe);
      if (headingMatch) return `## ${headingMatch[1]}`;

      return line;
    })
    .join('\n');

  return ensureValidateNextStepMatchesDecision(
    forceValidateCreationPass(bindValidateMarketEvidence(normalized, marketEvidence)),
  );
}

function normalizeIntakeMarkdown(content: string): string {
  const requiredHeadings = [
    '0. 素材场景',
    '0.1 内容策略画像',
    '1. 人物',
    '2. 场景',
    '3. 观点',
    '4. 情绪',
    '5. 案例',
    '6. 商业意图',
    '7. 不可公开信息',
    '9. 素材质量判断',
  ];
  const escapedHeadings = requiredHeadings.map((heading) => heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const requiredHeadingRe = new RegExp(`^#{2,6}\\s*(${escapedHeadings.join('|')})\\s*$`, 'u');

  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const titleMatch = line.match(/^#{2,6}\s*(素材理解(?:报告)?(?:\s*·.*)?)\s*$/u);
      if (titleMatch) return `# ${titleMatch[1]}`;

      const headingMatch = line.match(requiredHeadingRe);
      if (headingMatch) return `## ${headingMatch[1]}`;

      return line;
    })
    .join('\n');
}

function normalizeRuntimeMarkdown(
  skill: string,
  runtimeStep: string,
  content: string,
  marketEvidence?: InvocationGate['marketEvidence'],
): string {
  if (skill === 'content-validate' || runtimeStep === 'validate') {
    return normalizeValidateMarkdown(content, marketEvidence);
  }
  if (skill === 'content-intake' || runtimeStep === 'intake') {
    return normalizeIntakeMarkdown(content);
  }
  return content;
}

async function saveWithRuntime(
  skill: string,
  slug: string,
  content: string,
  runtimeStepForWrite: string,
  params: Record<string, unknown> = {},
  expectedRunId?: string,
  marketEvidence?: InvocationGate['marketEvidence'],
  expected?: { path: string; sha256: string },
  attemptId?: string,
): Promise<string> {
  const normalizedContent = normalizeRuntimeMarkdown(skill, runtimeStepForWrite, content, marketEvidence);
  const target = await resolveRuntimeWriteTarget({
    fallbackSlug: slug,
    sourcePaths: runtimeSourcePathsForSkill(skill, params),
    preferredRunId: expectedRunId,
  });
  if (expectedRunId && target.runId !== expectedRunId) {
    throw new InvocationValidationError('runtime 写入目标与已校验的上游任务不一致，不能跨任务保存内容');
  }

  return writeRuntimeOutput(
    runtimeStepForWrite,
    target.slug,
    normalizedContent,
    `ui-agent:${skill}${attemptId ? `:${attemptId}` : ''}`,
    expectedRunId || target.runId || undefined,
    expected,
  );
}

function isReadableReference(value: string): boolean {
  return (
    value.startsWith('pipeline/') ||
    value.startsWith('materials/') ||
    value.startsWith('brain/')
  );
}

function isTextReadableReference(value: string): boolean {
  if (!isReadableReference(value)) return false;
  if (!value.startsWith('materials/')) return true;

  const normalized = value.split(/[?#]/, 1)[0].toLowerCase();
  return Array.from(MATERIAL_TEXT_REFERENCE_EXTENSIONS).some((ext) => normalized.endsWith(ext));
}

function extractReadableReferences(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const paths: string[] = [];

  for (const item of values) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (isTextReadableReference(trimmed)) paths.push(trimmed);

    const embedded = trimmed.match(/\b(?:pipeline|materials|brain)\/[^\s`'")，。；；,]+/g) || [];
    for (const rawPath of embedded) {
      const cleanPath = rawPath.replace(/[.,;:，。；：）\]]+$/g, '');
      if (isTextReadableReference(cleanPath)) paths.push(cleanPath);
    }
  }

  return paths;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  return typeof value === 'string' ? value.trim() : '';
}

function draftSourcePath(path: string): RuntimeSourcePath[] {
  if (!path) return [];
  if (path.startsWith('pipeline/write/')) return [{ path, step: 'write' }];
  if (path.startsWith('pipeline/final/')) return [{ path, step: 'write' }];
  if (path.startsWith('pipeline/xhs/')) return [{ path, step: 'xhs' }];
  if (path.startsWith('pipeline/package/')) return [{ path, step: 'package' }];
  return [{ path }];
}

function runtimeSourcePathsForSkill(skill: string, params: Record<string, unknown>): RuntimeSourcePath[] {
  switch (skill) {
    case 'content-validate':
      return [{ path: stringParam(params, 'source'), step: 'intake' }].filter((item) => item.path);
    case 'content-blueprint':
      return [
        { path: stringParam(params, 'validateReportPath'), step: 'validate' },
        { path: stringParam(params, 'intakeReportPath'), step: 'intake' },
        { path: stringParam(params, 'marketSignalPath') },
        { path: stringParam(params, 'researchReportPath') },
      ].filter((item) => item.path);
    case 'content-angle':
      return [
        { path: stringParam(params, 'validateReportPath'), step: 'validate' },
        { path: stringParam(params, 'intakeReportPath'), step: 'intake' },
      ].filter((item) => item.path);
    case 'content-breakdown':
      return [
        { path: stringParam(params, 'angleReportPath'), step: 'angle' },
        { path: stringParam(params, 'intakeReportPath'), step: 'intake' },
      ].filter((item) => item.path);
    case 'wechat-writer':
      return [
        { path: stringParam(params, 'blueprintPath'), step: 'blueprint' },
        { path: stringParam(params, 'breakdownPath'), step: 'breakdown' },
        { path: stringParam(params, 'angleReportPath'), step: 'angle' },
        { path: stringParam(params, 'intakeReportPath'), step: 'intake' },
      ].filter((item) => item.path);
    case 'content-package':
      return [
        ...draftSourcePath(stringParam(params, 'parentDraftPath')),
        ...draftSourcePath(stringParam(params, 'xhsDraftPath')),
      ].filter((item) => item.path);
    case 'xhs-card':
      return [{ path: stringParam(params, 'sourceContentPath'), step: 'breakdown' }].filter((item) => item.path);
    case 'content-review':
      return [
        { path: stringParam(params, 'publishRecordPath'), step: 'publish' },
        ...draftSourcePath(stringParam(params, 'originalArticlePath')),
      ].filter((item) => item.path);
    case 'self-archive':
      return [
        ...draftSourcePath(stringParam(params, 'draftPath')),
        { path: stringParam(params, 'reviewReportPath'), step: 'review' },
      ].filter((item) => item.path);
    case 'content-twin':
      return draftSourcePath(stringParam(params, 'publishedContentPath'));
    case 'content-prelaunch':
    case 'content-compliance':
    case 'content-audit':
      return draftSourcePath(stringParam(params, 'draftPath'));
    case 'content-visual':
      return [
        ...draftSourcePath(stringParam(params, 'draftPath')),
        ...draftSourcePath(stringParam(params, 'sourceContentPath')),
        ...draftSourcePath(stringParam(params, 'markdownPath')),
      ].filter((item) => item.path);
    case 'content-repurpose':
      return draftSourcePath(stringParam(params, 'sourceContentPath'));
    default:
      return [];
  }
}

function isSkillParamValue(value: unknown): value is SkillParamValue {
  return (
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  );
}

function normalizeSkillParams(params: Record<string, unknown>): SkillParamMap {
  return Object.fromEntries(
    Object.entries(params).filter(([, value]) => isSkillParamValue(value))
  ) as SkillParamMap;
}

function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function sameRuntimeRun(left: RuntimeRun, right: RuntimeRun): boolean {
  if (left.run_id && right.run_id) return left.run_id === right.run_id;
  return Boolean(left.slug && right.slug && left.slug === right.slug);
}

async function readRequiredReference(path: string, label: string): Promise<string> {
  try {
    return await readOutputFile(path);
  } catch {
    throw new InvocationValidationError(`${label}不存在或不可读取：${path}`);
  }
}

async function assertCurrentRuntimeBinding(path: string, step: string, label: string): Promise<RuntimeRun> {
  const runs = await runsForPipelinePath(path, step);
  const current = runs.find((run) => run.steps?.[step]?.latest === path);
  if (!current) {
    throw new InvocationValidationError(`${label}必须是当前 runtime run 的最新 ${step} 产物：${path}`);
  }
  return current;
}

async function assertEnhancementRunBinding(params: Record<string, unknown>): Promise<string> {
  const runId = stringParam(params, 'runId');
  const projectId = stringParam(params, 'projectId').toLowerCase();
  if (!runId || !projectId || !PROJECT_ID_RE.test(projectId)) {
    throw new InvocationValidationError('DBS 创作增强必须绑定当前 run 与项目 ID。');
  }
  const run = (await listRuntimeRuns()).find((candidate) => candidate.run_id === runId);
  if (!run || (run.project_id || 'default') !== projectId) {
    throw new InvocationValidationError('DBS 创作增强不能跨项目写入内容任务。');
  }
  return runId;
}

function hasCreatableValidateDecision(content: string): boolean {
  return /^\s*(?:[-*]\s*)?(?:\*\*)?决策(?:\*\*)?\s*[：:]\s*(?:有条件通过|不通过|通过)\s*[。.;；]?\s*$/mi.test(content);
}

function marketSignalBindsIntake(content: string, intakePath: string): boolean {
  const escapedPath = intakePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`上游素材\\s*[：:]\\s*${escapedPath}(?:\\s|$)`, 'm').test(content);
}

async function assertVerifiedMarketSnapshotBinding(
  marketContent: string,
  intakePath: string,
  runId: string,
  label: string,
): Promise<MarketSnapshotBinding> {
  try {
    return await assertMarketSnapshotBoundToIntake(marketContent, intakePath, runId, label);
  } catch (error) {
    throw new InvocationValidationError(
      error instanceof Error ? error.message : `${label}的 TikOmni 研究快照校验失败`,
    );
  }
}

function blueprintBindsMarketSnapshot(content: string, binding: MarketSnapshotBinding): boolean {
  try {
    const outputBinding = marketSnapshotBindingFromReport(content, '思想母版蓝图');
    return outputBinding.snapshotPath === binding.snapshotPath
      && outputBinding.snapshotSha256 === binding.snapshotSha256;
  } catch {
    return false;
  }
}

function marketSnapshotOutputInstructions(binding: MarketSnapshotBinding | undefined): string {
  if (!binding) return '';
  return [
    '# 已验证的 TikOmni 研究快照（必须原样写入蓝图）',
    '在 `## 0. 上游约束` 中原样保留以下两行。它们用于负责人确认选题与模板后冻结本期研究证据；不得改写、缩写或省略。',
    `- TikOmni 研究快照：${binding.snapshotPath}`,
    `- TikOmni 快照 SHA-256：${binding.snapshotSha256}`,
  ].join('\n');
}

function marketEvidenceOutputInstructions(evidence: InvocationGate['marketEvidence']): string {
  if (!evidence) return '';
  return [
    '# 已验证的 TikOmni 公开样本事实（必须逐字使用）',
    '以下三项来自已校验的本期平台实时研究报告，不是模型可判断或改写的内容。必须原样保留，不能用历史样本、本地缓存或模型推断替换。',
    `- 公开样本对标报告：${evidence.reportPath}`,
    '- 公开样本状态：已完成',
    `- 可验证样本数：${evidence.sampleCount}`,
  ].join('\n');
}

async function assertSafeSkillInvocation(
  skill: string,
  params: Record<string, unknown>,
): Promise<InvocationGate> {
  if (DBS_ENHANCEMENT_SKILLS.has(skill)) {
    return { runId: await assertEnhancementRunBinding(params) };
  }
  if (skill === 'content-intake') {
    const runId = stringParam(params, 'runId');
    if (!runId) {
      throw new InvocationValidationError('素材理解必须绑定本期素材入口创建的任务。请先完成素材整理。');
    }
    const run = (await listRuntimeRuns()).find((item) => item.run_id === runId);
    if (!run) throw new InvocationValidationError('素材理解必须绑定当前素材入口创建的 runtime run。');
    if (run.status === 'archived') throw new InvocationValidationError('当前 run 已归档，不能继续进行素材理解。');
    return { runId };
  }
  if (skill === 'content-validate') {
    const sourcePath = stringParam(params, 'source');
    const marketSignalPath = stringParam(params, 'marketSignalPath');
    if (!sourcePath.startsWith('pipeline/intake/')) {
      throw new InvocationValidationError('选题立项必须绑定当前 pipeline/intake 素材理解报告');
    }
    if (!/^materials\/research\/[^\\/\s]+-market-signal\.md$/.test(marketSignalPath)) {
      throw new InvocationValidationError('选题立项必须绑定 materials/research/{slug}-market-signal.md 公开样本对标报告');
    }
    const [sourceRun, marketContent] = await Promise.all([
      assertCurrentRuntimeBinding(sourcePath, 'intake', '素材理解报告'),
      readRequiredReference(marketSignalPath, '爆款抓取与对标报告'),
    ]);
    if (!sourceRun.run_id) {
      throw new InvocationValidationError('素材理解报告未绑定 runtime run，不能进入选题立项');
    }
    const marketSnapshotBinding = await assertVerifiedMarketSnapshotBinding(marketContent, sourcePath, sourceRun.run_id, '爆款抓取与对标报告');
    let marketEvidence: ReturnType<typeof marketSignalEvidenceFromReport>;
    try {
      marketEvidence = marketSignalEvidenceFromReport(marketContent, '爆款抓取与对标报告');
    } catch (error) {
      throw new InvocationValidationError(
        error instanceof Error ? error.message : '爆款抓取与对标报告的已选平台样本不足',
      );
    }
    return {
      runId: sourceRun.run_id,
      marketSnapshotBinding,
      marketEvidence: {
        ...marketEvidence,
        reportPath: marketSignalPath,
      },
    };
  }
  if (skill === 'content-blueprint') {
    const validateReportPath = stringParam(params, 'validateReportPath');
    const intakeReportPath = stringParam(params, 'intakeReportPath');
    const marketSignalPath = stringParam(params, 'marketSignalPath');
    if (intakeReportPath.startsWith('pipeline/intake/')) {
      const authorRun = await assertCurrentRuntimeBinding(intakeReportPath, 'intake', '素材理解报告');
      if (authorRun.research_mode === 'author_material' && authorRun.run_id) {
        if (validateReportPath || marketSignalPath) throw new InvocationValidationError('作者素材写作不应携带旧立项或平台研究，请重新读取当前选择。');
        const authorSourceBinding = await verifiedAuthorSource(authorRun.run_id);
        if (authorSourceBinding.source_path !== intakeReportPath
            || (stringParam(params, 'topic') && stringParam(params, 'topic') !== authorSourceBinding.topic)) {
          throw new InvocationValidationError('作者素材或题目已经变化，请重新核对。');
        }
        return { runId: authorRun.run_id, authorSourceBinding };
      }
    }
    if (!validateReportPath.startsWith('pipeline/validate/')) {
      throw new InvocationValidationError('思想母版蓝图必须绑定当前 pipeline/validate 立项报告');
    }
    if (!intakeReportPath.startsWith('pipeline/intake/')) {
      throw new InvocationValidationError('思想母版蓝图必须绑定 pipeline/intake 素材理解报告');
    }
    if (!/^materials\/research\/[^\\/\s]+-market-signal\.md$/.test(marketSignalPath)) {
      throw new InvocationValidationError('思想母版蓝图必须绑定 materials/research/{slug}-market-signal.md 爆款抓取与对标报告');
    }

    const [validateContent, marketContent, validateRun, intakeRun, validateCheck] = await Promise.all([
      readRequiredReference(validateReportPath, '立项报告'),
      readRequiredReference(marketSignalPath, '爆款抓取与对标报告'),
      assertCurrentRuntimeBinding(validateReportPath, 'validate', '立项报告'),
      assertCurrentRuntimeBinding(intakeReportPath, 'intake', '素材理解报告'),
      validateRuntimeOutput('validate', validateReportPath),
    ]);
    if (!hasCreatableValidateDecision(validateContent)) {
      throw new InvocationValidationError('思想母版蓝图需要一份包含明确立项决策的报告（通过、有条件通过或不通过）。');
    }
    if (!validateCheck.valid) {
      // Creator mode accepts a structurally incomplete report once it carries
      // an explicit editorial decision. The blueprint still receives the
      // original material and frozen research binding, so it cannot invent
      // missing evidence as a way around the report's gaps.
      console.warn('Proceeding from a runtime-review-required validate report in creator mode', validateReportPath);
    }
    if (!sameRuntimeRun(validateRun, intakeRun)) {
      throw new InvocationValidationError('思想母版蓝图的立项报告与素材理解报告必须属于同一 runtime run');
    }
    if (!marketSignalBindsIntake(marketContent, intakeReportPath)) {
      throw new InvocationValidationError('爆款抓取与对标报告必须绑定当前素材理解报告，不能跨任务复用');
    }
    if (!intakeRun.run_id) {
      throw new InvocationValidationError('素材理解报告未绑定 runtime run，不能生成思想母版蓝图');
    }
    const marketSnapshotBinding = await assertVerifiedMarketSnapshotBinding(
      marketContent,
      intakeReportPath,
      intakeRun.run_id,
      '爆款抓取与对标报告',
    );
    return { runId: intakeRun.run_id, marketSnapshotBinding };
  }
  if (skill === 'wechat-writer') {
    const blueprintPath = stringParam(params, 'blueprintPath');
    if (!blueprintPath.startsWith('pipeline/blueprint/')) {
      throw new InvocationValidationError('公众号母稿必须绑定当前 pipeline/blueprint 思想母版蓝图');
    }
    const blueprintRun = await assertCurrentRuntimeBinding(blueprintPath, 'blueprint', '思想母版蓝图');
    if (!blueprintRun.run_id) {
      throw new InvocationValidationError('思想母版蓝图未绑定 runtime run，不能进入公众号写作');
    }
    return { runId: blueprintRun.run_id };
  }
  if (skill === 'content-package') {
    const blueprintPath = stringParam(params, 'blueprintPath');
    if (!blueprintPath.startsWith('pipeline/blueprint/')) {
      throw new InvocationValidationError('平台原生内容必须绑定当前已确认蓝图。');
    }
    const blueprintRun = await assertCurrentRuntimeBinding(blueprintPath, 'blueprint', '平台内容蓝图');
    if (!blueprintRun.run_id) {
      throw new InvocationValidationError('平台内容蓝图未绑定 runtime run，不能生成原生内容。');
    }
    const blueprintContent = await readRequiredReference(blueprintPath, '平台内容蓝图');
    const approval = await getRuntimeBlueprintApproval(blueprintPath, blueprintRun.run_id);
    if (!approval.approved) throw new KnownUserFacingError({ error: '请先核对并确认写作方案，再生成正文。', code: 'writing_brief_review_required' }, { status: 409 });
    const intakePath = blueprintRun.steps?.intake?.latest;
    if (!intakePath) throw new InvocationValidationError('平台内容蓝图缺少当前素材绑定，不能读取研究证据。');
    if (blueprintRun.research_mode === 'author_material') {
      const authorSourceBinding = await verifiedAuthorSource(blueprintRun.run_id, blueprintPath);
      if (stringParam(params, 'topic') && stringParam(params, 'topic') !== authorSourceBinding.topic) {
        throw new InvocationValidationError('作者题目已经变化，请重新核对。');
      }
      return { runId: blueprintRun.run_id, authorSourceBinding,
        writingBriefContext: confirmedWritingBriefContext(blueprintContent),
        contentPlan: { path: blueprintPath, sha256: createHash('sha256').update(blueprintContent).digest('hex') } };
    }
    const marketSnapshotBinding = await assertVerifiedMarketSnapshotBinding(blueprintContent, intakePath, blueprintRun.run_id, '平台内容蓝图');
    return { runId: blueprintRun.run_id, marketSnapshotBinding, writingBriefContext: confirmedWritingBriefContext(blueprintContent), contentPlan: { path: blueprintPath, sha256: createHash('sha256').update(blueprintContent).digest('hex') } };
  }
  if (skill !== 'content-twin') return {};

  const publishedContentPath = typeof params.publishedContentPath === 'string' ? params.publishedContentPath : '';
  const flags = asStringList(params.flags);
  const readonly = flags.includes('readonly');

  if (
    publishedContentPath &&
    !publishedContentPath.startsWith('pipeline/final/') &&
    !publishedContentPath.startsWith('pipeline/xhs/') &&
    !publishedContentPath.startsWith('pipeline/package/')
  ) {
    throw new InvocationValidationError('数字孪生只能观察 pipeline/final、pipeline/xhs 或 pipeline/package 下的最终发布版');
  }

  if (!publishedContentPath && !readonly) {
    throw new InvocationValidationError('数字孪生写入记忆前必须选择最终发布版；粘贴文本只能用于只读观察');
  }
  return {};
}

function compactReferencedContent(skill: string, path: string, content: string): string {
  const cleaned = content
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/```[\s\S]{2000,}?```/g, '```text\n（长篇原始正文已省略；请以上方结构化提取、证据台账和风险边界为准。）\n```')
    .trim();

  if (!['content-validate', 'content-blueprint', 'content-angle'].includes(skill)) {
    return [
      cleaned.slice(0, 30000),
      cleaned.length > 30000 ? '\n\n（文件较长，已截取前 30000 字符）' : '',
    ].join('');
  }

  const maxChars = path.startsWith('pipeline/intake/') ? 12000 : 9000;
  // Research headings differ from intake headings. The previous generic
  // selector retained only the title, silently dropping platform evidence.
  // Exact counts and source links additionally come from the verified archive.
  if (/^materials\/research\/.*-market-signal\.md$/.test(path)) {
    return cleaned.length > maxChars
      ? `${cleaned.slice(0, maxChars)}\n\n（报告详情已截取；各平台完整数量与参考来源见本期研究证据。）`
      : cleaned;
  }
  const preferredHeadings = [
    '素材场景',
    '素材来源',
    '事实边界',
    '人物',
    '场景',
    '观点',
    '案例',
    '商业意图',
    '素材质量判断',
    '立项决策',
    'HKR',
    '商业成立性',
    '平台首发策略',
    '风险提示',
    '下一步',
  ];
  const lines = cleaned.split(/\r?\n/);
  const selected: string[] = [];
  let include = false;
  let collectedChars = 0;

  for (const line of lines) {
    const heading = line.match(/^#{1,4}\s+(.+)$/)?.[1] || '';
    if (heading) {
      include = preferredHeadings.some((item) => heading.includes(item));
    }
    if (!include && selected.length === 0 && line.trim()) include = true;
    if (!include) continue;

    selected.push(line);
    collectedChars += line.length + 1;
    if (collectedChars >= maxChars) break;
  }

  const compact = selected.join('\n').trim() || cleaned.slice(0, maxChars);
  return [
    compact,
    cleaned.length > compact.length ? '\n\n（已为立项/角度步骤压缩长素材上下文；完整文件仍按路径可追溯。）' : '',
  ].join('');
}

type PromptExcerpt = {
  text: string;
  originalChars: number;
  retainedSourceChars: number;
  truncated: boolean;
};

type ContentIntakePromptInputs = {
  rawMaterial: PromptExcerpt;
  fileContext: string;
  analysisContext: string;
};

type ContentIntakeFileContext = {
  id: string;
  name: string;
  path: string;
  content: string;
  originalChars: number;
};

function compactPromptLabel(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  if (maxChars < 12) return normalized.slice(0, maxChars);
  return `${normalized.slice(0, maxChars - 10)}…（已省略）`;
}

/**
 * Keep a deterministic head-and-tail excerpt so a long transcript retains
 * both its opening context and its closing conclusion. The marker is part of
 * the actual prompt: the model must know it did not receive the full source.
 */
function excerptForPrompt(value: string, maxChars: number, label: string): PromptExcerpt {
  const source = value.trim();
  const originalChars = source.length;
  if (!source || maxChars <= 0) {
    return { text: '', originalChars, retainedSourceChars: 0, truncated: originalChars > 0 };
  }
  if (originalChars <= maxChars) {
    return { text: source, originalChars, retainedSourceChars: originalChars, truncated: false };
  }

  const safeLabel = compactPromptLabel(label, 80);
  let retainedSourceChars = Math.max(0, maxChars - 160);
  let marker = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const omittedChars = Math.max(0, originalChars - retainedSourceChars);
    marker = `\n\n[${safeLabel}已按上下文预算截取：原始 ${originalChars.toLocaleString()} 字符，本次保留 ${retainedSourceChars.toLocaleString()} 字符，省略 ${omittedChars.toLocaleString()} 字符。完整内容仍保留在本期素材快照中。]\n\n`;
    const nextRetainedChars = Math.max(0, maxChars - marker.length);
    if (nextRetainedChars === retainedSourceChars) break;
    retainedSourceChars = nextRetainedChars;
  }

  if (retainedSourceChars <= 0) {
    const fallback = `[${safeLabel}未注入正文：本期上下文预算不足。完整内容仍保留在本期素材快照中。]`;
    return {
      text: fallback.slice(0, maxChars),
      originalChars,
      retainedSourceChars: 0,
      truncated: true,
    };
  }

  const prefixChars = Math.ceil(retainedSourceChars * 0.72);
  const suffixChars = retainedSourceChars - prefixChars;
  const text = [
    source.slice(0, prefixChars),
    marker,
    suffixChars ? source.slice(-suffixChars) : '',
  ].filter(Boolean).join('');
  return {
    text: text.slice(0, maxChars),
    originalChars,
    retainedSourceChars,
    truncated: true,
  };
}

function distributePromptBudget(lengths: number[], totalChars: number): number[] {
  const allocations = lengths.map(() => 0);
  let remainingChars = Math.max(0, totalChars);
  let pending = lengths
    .map((length, index) => ({ length, index }))
    .filter(({ length }) => length > 0);

  while (remainingChars > 0 && pending.length > 0) {
    const perSource = Math.max(1, Math.floor(remainingChars / pending.length));
    const nextPending: typeof pending = [];
    for (const source of pending) {
      const available = Math.max(0, source.length - allocations[source.index]);
      const granted = Math.min(available, perSource, remainingChars);
      allocations[source.index] += granted;
      remainingChars -= granted;
      if (available > granted) nextPending.push(source);
      if (remainingChars <= 0) break;
    }
    if (nextPending.length === pending.length && nextPending.every((source) => allocations[source.index] === 0)) break;
    pending = nextPending;
  }
  return allocations;
}

async function readContentIntakeFileContexts(context: MaterialAnalysisContext): Promise<ContentIntakeFileContext[]> {
  const seenPaths = new Set<string>();
  const files = context.input.files.flatMap((file, index) => {
    const path = file.path?.trim();
    if (!path || seenPaths.has(path)) return [];
    seenPaths.add(path);
    return [{
      id: `S${String(index + 2).padStart(2, '0')}`,
      name: compactPromptLabel(file.name || path, CONTENT_INTAKE_FILE_LABEL_CHAR_BUDGET),
      path: compactPromptLabel(path, CONTENT_INTAKE_FILE_PATH_CHAR_BUDGET),
      readPath: path,
    }];
  });

  return Promise.all(files.map(async (file) => {
    try {
      const original = await readOutputFile(file.readPath);
      const content = compactReferencedContent('content-intake', file.readPath, original);
      if (!content.trim()) throw new Error('解析文本为空');
      return {
        id: file.id,
        name: file.name,
        path: file.path,
        content,
        originalChars: original.length,
      };
    } catch {
      // Readiness was checked immediately before this step. If an extracted
      // file disappears afterwards, fail closed instead of producing an
      // intake report that looks complete while silently omitting a source.
      throw new InvocationValidationError(`本期解析文件在生成前不可读取：${file.readPath}。请回到素材输入重新分析。`);
    }
  }));
}

function buildContentIntakeFileContext(
  files: ContentIntakeFileContext[],
  rawMaterial: PromptExcerpt,
): string {
  if (files.length === 0) return '';

  const sourceBudget = Math.max(0, CONTENT_INTAKE_SOURCE_CHAR_BUDGET - rawMaterial.text.length);
  const preface = [
    '# 本期自动读取的文件正文（受控注入）',
    `原始文字与下列文件正文合计最多注入 ${CONTENT_INTAKE_SOURCE_CHAR_BUDGET.toLocaleString()} 字符（按 CJK 一字符约一 token 保守估算）。`,
    '每个文件保留原始解析路径；若被截取，模型必须将未读取部分视为待回看原件，不能补写为事实。',
  ].join('\n');
  const blockOverhead = files.map((file) => [
    `## ${file.id}｜${file.name}`,
    `- 解析路径：${file.path}`,
    `- 正文注入：`,
    '',
  ].join('\n').length + 180);

  let payloadBudget = Math.max(0, sourceBudget - preface.length - blockOverhead.reduce((total, value) => total + value, 0));
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const allocations = distributePromptBudget(files.map((file) => file.content.length), payloadBudget);
    const blocks = files.map((file, index) => {
      const excerpt = excerptForPrompt(file.content, allocations[index], `${file.id} 文件正文`);
      const injectionStatus = excerpt.truncated
        ? `已注入 ${excerpt.retainedSourceChars.toLocaleString()} / ${file.originalChars.toLocaleString()} 字符，未注入部分需回看原件。`
        : `已注入完整解析正文 ${file.originalChars.toLocaleString()} 字符。`;
      return [
        `## ${file.id}｜${file.name}`,
        `- 解析路径：${file.path}`,
        `- 正文注入：${injectionStatus}`,
        '',
        excerpt.text || '（本文件正文未注入；完整解析资产仍可按上方路径回看。）',
      ].join('\n');
    });
    const context = [preface, ...blocks].join('\n\n');
    if (context.length <= sourceBudget) return context;
    payloadBudget = Math.max(0, payloadBudget - (context.length - sourceBudget));
  }

  // This is a defensive last resort for unusually long filenames/paths. The
  // preface still tells the model that the source list was budgeted.
  return excerptForPrompt(
    [preface, ...files.map((file) => `- ${file.id}：${file.name}（${file.path}）`)].join('\n'),
    sourceBudget,
    '自动读取的文件正文与来源索引',
  ).text;
}

async function buildContentIntakePromptInputs(context: MaterialAnalysisContext): Promise<ContentIntakePromptInputs> {
  const rawMaterial = excerptForPrompt(
    context.input.rawMaterial,
    context.input.files.length ? Math.floor(CONTENT_INTAKE_SOURCE_CHAR_BUDGET * 0.55) : CONTENT_INTAKE_SOURCE_CHAR_BUDGET,
    '原始文字素材',
  );
  const files = await readContentIntakeFileContexts(context);
  const fileContext = buildContentIntakeFileContext(files, rawMaterial);
  const analysisContext = excerptForPrompt(
    toMaterialAnalysisPromptContext(context),
    CONTENT_INTAKE_ANALYSIS_BRIEF_CHAR_BUDGET,
    '本期素材分析与灵感参考摘要',
  ).text;
  return { rawMaterial, fileContext, analysisContext };
}

async function requireCurrentContentIntakeMaterial(runId: string): Promise<MaterialAnalysisContext> {
  const materialAnalysis = await getMaterialAnalysisContext(runId);
  if (!materialAnalysis) {
    throw new InvocationValidationError('当前 run 没有可用的本期素材分析，请回到素材输入重新分析。');
  }
  try {
    assertMaterialAnalysisCurrent(materialAnalysis);
    const recommendation = materialAnalysis.analysis;
    const selection = materialAnalysis.selection || (recommendation ? {
      materialTypeId: recommendation.recommendedTypeId,
      structureId: recommendation.recommendedStructureId,
    } : null);
    if (!selection || !materialDirectionFor(selection.materialTypeId, selection.structureId)) {
      throw new InvocationValidationError('系统没有得到可用的素材判断，请重新整理素材。');
    }
    await assertMaterialReadyForResearch(materialAnalysis.input);
  } catch (error) {
    if (error instanceof MaterialReadinessError || error instanceof Error) {
      throw new InvocationValidationError(error.message);
    }
    throw error;
  }
  return materialAnalysis;
}

function invocationTimeoutMs(skill: string, runtimeStep: string, requested: unknown): number {
  const parsed = Number(requested);
  if (Number.isFinite(parsed) && parsed >= 30_000 && parsed <= 600_000) return parsed;
  if (
    skill === 'content-validate'
    || skill === 'content-blueprint'
    || skill === 'content-angle'
    || runtimeStep === 'validate'
    || runtimeStep === 'blueprint'
    || runtimeStep === 'angle'
  ) {
    return 300_000;
  }
  if (skill === 'wechat-writer' || runtimeStep === 'write') return 180_000;
  if (skill === 'content-package' || runtimeStep === 'package') return 180_000;
  return 120_000;
}

function compactWorkflowOutputInstruction(skill: string, runtimeStep: string): string {
  if (skill === 'content-validate' || runtimeStep === 'validate') {
    return [
      '# 本次运行的篇幅约束',
      '这是内部立项判断，不是要交付给读者的长文。保留全部必需二级标题和决策字段，但总正文控制在约 1,400 个中文字符内；每一节最多 2 条短要点。不要复述素材、研究样本或规则原文。',
    ].join('\n');
  }
  if (skill === 'content-blueprint' || runtimeStep === 'blueprint') {
    return [
      '# 本次运行的篇幅约束',
      '这是“共享事实底稿 + 已选平台独立蓝图”，不是文章正文。保留研究快照两行、共享层、各已选平台蓝图、平台差异检查和人工确认清单；每个平台使用短要点，不要提前写成稿。',
      '增加一个“## 写作方向”小节，用四条简短要点供作者编辑：- 写给谁：…；- 想让读者记住什么：…；- 准备怎样展开：…；- 最后怎样收尾：…。每条独占一行，多平台的结构注明对应平台。只提出方案，不声称作者已确认；作者确认以系统单独保存的操作记录为准。',
    ].join('\n');
  }
  if (skill === 'wechat-writer' || runtimeStep === 'write') {
    return [
      '# 本次运行的篇幅与交付约束',
      '这是可直接使用的公众号母稿，正文控制在 1,600-2,200 个中文字符内，不要输出 Markdown 代码围栏，也不要复述蓝图或内部规则。隐藏 `AIFIOS-WRITE-CHECK` 必须逐行且只出现一次，`母稿字数` 写为 `1600-2200 字`；`标题决策来源` 只能写 `blueprint 标题假设：工作标题《...》`；`排版交接卡` 必须分别含封面、摘要、HTML/排版和至少一项配图、引用、CTA 或评论区。',
    ].join('\n');
  }
  if (skill === 'content-package' || runtimeStep === 'package') {
    return [
      '# 本次运行的内容质量与篇幅约束',
      '这是已选平台的原生内容包。只保留本期已选平台章节；公众号正文优先服从本篇已确认的作者篇幅要求，未指定时才参考1,600-2,200字，不为默认篇幅凑字。小红书必须逐页写出 P1-P8 八张卡片，视频号只生成一条 45-90 秒完整执行稿。',
      '先在内部完成初稿、平台审稿和局部修订，只输出最终稿。三个平台分别判断标题、开头、信息密度、内容节奏和互动承接；任何一条看起来像另一平台的摘要、拆条或朗读稿，都必须在输出前重写。不要输出审稿过程或 Markdown 代码围栏。',
    ].join('\n');
  }
  return '';
}

function invocationMaxTokens(skill: string, runtimeStep: string, configured: unknown): number {
  const requested = Number(configured);
  const fallback = 8_000;
  const value = Number.isFinite(requested) && requested > 0 ? requested : fallback;

  if (skill === 'content-intake' || runtimeStep === 'intake') return Math.min(value, 2_400);
  // Reasoning models can spend a material part of the generation budget before
  // emitting the eight required report sections. 2,400 tokens allowed them to
  // save a report that stopped after "素材来源", which then failed only when the
  // next blueprint step tried to read its decision. Keep the report concise in
  // the prompt, but reserve enough completion budget to finish its contract.
  if (skill === 'content-validate' || runtimeStep === 'validate') return Math.min(value, 8_000);
  if (skill === 'content-blueprint' || runtimeStep === 'blueprint') return Math.min(value, 8_000);
  if (skill === 'wechat-writer' || runtimeStep === 'write') return Math.min(value, 7_000);
  // A three-platform native package contains a full WeChat article, eight XHS
  // cards and one complete video script. Seven thousand tokens can end the
  // stream midway through the first platform while still looking like a
  // successful provider response, so reserve enough room for the full
  // contract and let the structural release gate make the final decision.
  if (skill === 'content-package' || runtimeStep === 'package') return Math.min(value, 12_000);
  return Math.min(value, 8_000);
}

async function buildReferencedFileContext(skill: string, params: Record<string, unknown>): Promise<string> {
  const paths = Object.values(params)
    .flatMap((value) => extractReadableReferences(value))
    .filter((value, index, all) => all.indexOf(value) === index);

  if (paths.length === 0) return '';

  const blocks = await Promise.all(
    paths.map(async (path) => {
      try {
        const content = await readOutputFile(path);
        return [
          `## ${path}`,
          '',
          compactReferencedContent(skill, path, content),
        ].join('\n');
      } catch {
        return '';
      }
    })
  );

  return blocks.filter(Boolean).join('\n\n---\n\n');
}

export async function POST(req: NextRequest) {
  let attempt: ContentAttempt | undefined;
  let buffer = "";
  try {
    await ensureProjectInitialized();
    const { skill, params, config, runtimeStep, timeoutMs }: { skill: unknown; params: unknown; config: LLMConfig; runtimeStep?: unknown; timeoutMs?: unknown } =
      await req.json();

    if (!skill) {
      return expectedUserFacingErrorResponse({
        error: '请选择要生成的内容。',
        code: 'generation_type_required',
        status: 400,
      });
    }
    const skillName = assertTextInput(skill, 'Skill 名称', MAX_SHORT_TEXT_BYTES);
    await assertInvocableSkill(skillName);
    const safeRuntimeStep = assertOptionalTextInput(runtimeStep, 'Runtime step', MAX_SHORT_TEXT_BYTES);
    const safeParams = params && typeof params === 'object' && !Array.isArray(params)
      ? params as Record<string, unknown>
      : {};
    assertJsonInputSize(safeParams, 'Agent 参数', MAX_AGENT_PAYLOAD_BYTES);

    const resolvedConfig = await resolveServerLLMConfig(config || {});
    const configIssues = validateLLMConfig(resolvedConfig);
    if (configIssues.length > 0) {
      return expectedUserFacingErrorResponse({
        error: '模型设置不完整。请到系统设置检查后重试。',
        code: 'model_settings_invalid',
        status: 400,
        action: { label: '打开系统设置', href: '/settings' },
      });
    }

    const invocationGate = await assertSafeSkillInvocation(skillName, safeParams);
    const runtimeStepForWrite = resolveRuntimeStepForSkill(skillName, safeRuntimeStep);

    const skillDef = await loadSkill(skillName);
    const creatorContext = await creativeLibraryContext();
    const skillParams = normalizeSkillParams(safeParams);

    const systemPrompt = [
      skillDef.systemPrompt,
      compactWorkflowOutputInstruction(skillName, runtimeStepForWrite),
      productVoiceInstructionForSkill(skillName),
      '',
      '---',
      '',
      '# 当前客户创作身份（项目真源）',
      creatorContext || [
        '创作名片尚未配置。',
        '禁止代入任何预置作者、品牌、履历、第一人称经历或署名；只能使用当前 run 的已授权素材和已确认蓝图。',
        '涉及作者身份、账号名称、履历或署名的位置必须留空或标记“待用户确认”，不得猜测。',
      ].join('\n'),
      '',
      '# 身份优先级',
      '当前客户创作身份与已确认创作规则高于 skill 中的示例、历史兼容内容和风格样本。未在项目真源中确认的个人事实一律不可写入。',
      invocationGate.authorSourceBinding ? authorSourceInstructions(invocationGate.authorSourceBinding) : '',
    ].join('\n');

    const usesMaterialAnalysis = Boolean(invocationGate.runId) && [
      'content-intake', 'content-validate', 'content-blueprint', 'content-package', 'wechat-writer',
    ].includes(skillName);
    const materialAnalysis = usesMaterialAnalysis && invocationGate.runId
      ? skillName === 'content-intake'
        ? await requireCurrentContentIntakeMaterial(invocationGate.runId)
        : await getMaterialAnalysisContext(invocationGate.runId)
      : null;
    if (materialAnalysis) {
      try { assertMaterialAnalysisCurrent(materialAnalysis); }
      catch { throw new InvocationValidationError('素材输入已经变更，请重新整理后再继续写作。'); }
    }
    const materialVersion = materialAnalysisFingerprint(materialAnalysis);
    const materialPlan = invocationGate.contentPlan ? { ...invocationGate.contentPlan, material_correction_id: materialAnalysis?.correctionId || '' } : undefined;
    const contentIntakePromptInputs = materialAnalysis && skillName === 'content-intake'
      ? await buildContentIntakePromptInputs(materialAnalysis)
      : null;
    // A run-scoped material snapshot is the only source of truth for Stage 1.
    // Do not let a stale browser field, or a `materials/...` string embedded in
    // arbitrary request params, turn into an untracked model context injection.
    const promptSkillParams = contentIntakePromptInputs
      ? { ...skillParams, rawMaterial: contentIntakePromptInputs.rawMaterial.text }
      : skillParams;
    const baseUserMessage = buildUserMessage(skillName, promptSkillParams);
    const referencedFileContext = contentIntakePromptInputs
      ? contentIntakePromptInputs.fileContext
      : await buildReferencedFileContext(skillName, safeParams);
    const materialAnalysisContext = contentIntakePromptInputs
      ? contentIntakePromptInputs.analysisContext
      : toMaterialAnalysisPromptContext(materialAnalysis);
    const benchmarkAdvisorContext = !invocationGate.authorSourceBinding && invocationGate.runId && (skillName === 'content-blueprint' || skillName === 'wechat-writer')
      ? await benchmarkAdvisorContextForRun(invocationGate.runId)
      : '';
    const creativeEnhancementContext = !invocationGate.authorSourceBinding && invocationGate.runId && [
      'content-validate',
      'content-blueprint',
      'wechat-writer',
      'content-package',
    ].includes(skillName)
      ? await creativeEnhancementContextForRun(invocationGate.runId)
      : '';
    let marketResearchContext = '';
    if (invocationGate.runId && invocationGate.marketSnapshotBinding) {
      try {
        marketResearchContext = await verifiedMarketResearchContext(invocationGate.marketSnapshotBinding, invocationGate.runId);
      } catch (error) {
        throw new InvocationValidationError(error instanceof Error ? error.message : '本期平台研究证据不可读取');
      }
    }
    const userMessage = [
      baseUserMessage,
      referencedFileContext
        ? [
            '# 自动接力读取到的上游文件内容',
            referencedFileContext,
        ].join('\n\n')
        : '',
      benchmarkAdvisorContext,
      creativeEnhancementContext,
      materialAnalysisContext,
      invocationGate.authorSourceBinding ? authorSourceInstructions(invocationGate.authorSourceBinding) : '',
      invocationGate.writingBriefContext,
      marketResearchContext,
      skillName === 'content-validate'
        ? marketEvidenceOutputInstructions(invocationGate.marketEvidence)
        : '',
      skillName === 'content-blueprint' ? marketSnapshotOutputInstructions(invocationGate.marketSnapshotBinding) : '',
    ].filter(Boolean).join('\n\n---\n\n');

    if (skillName === 'content-package' && runtimeStepForWrite === 'package' && invocationGate.runId && invocationGate.contentPlan) {
      attempt = await beginContentAttempt(invocationGate.runId, materialPlan!, resolvedConfig.provider, resolvedConfig.model);
    }

    const response = await createLLMTextStream(
      resolvedConfig,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      {
        temperature: resolvedConfig.temperature ?? 0.7,
        maxTokens: invocationMaxTokens(skillName, runtimeStepForWrite, resolvedConfig.maxTokens),
        timeoutMs: invocationTimeoutMs(skillName, runtimeStepForWrite, timeoutMs),
        ...(attempt ? { maxRetries: 0 } : {}),
        ...(invocationGate.runId ? { recordRequest: recordRunModelCall(invocationGate.runId, skillName) } : {}),
      }
    );

    const encoder = new TextEncoder();
    const rawSlug = safeParams.slug || safeParams.topic;
    const slug = typeof rawSlug === 'string' && rawSlug.trim() ? rawSlug : 'untitled';

    const stream = new ReadableStream({
      async start(controller) {
        let lastCheckpoint = 0;
        let checkpointLength = 0;
        let generationIssues: string[] = [];
        // Closing the browser must not discard the server-owned generation.
        const enqueue = (data: Uint8Array) => { try { controller.enqueue(data); } catch { /* Client left; keep saving the result. */ } };
        const close = () => { try { controller.close(); } catch { /* Already disconnected. */ } };
        try {
          for await (const chunk of response) {
            buffer += chunk;
            if (attempt && (Date.now() - lastCheckpoint >= 750 || buffer.length - checkpointLength >= 2_000)) {
              await checkpointContentAttempt(attempt, buffer);
              lastCheckpoint = Date.now(); checkpointLength = buffer.length;
            }
            const data = JSON.stringify({ type: 'text', content: chunk });
            enqueue(encoder.encode(`data: ${data}\n\n`));
          }

          if (attempt) await checkpointContentAttempt(attempt, buffer);

          if (!buffer.trim()) {
            throw new Error('模型没有返回可保存内容，本次执行未写入 runtime。');
          }

          try {
            const currentInvocationGate = await assertSafeSkillInvocation(skillName, safeParams);
            if (!sameAuthorSource(invocationGate.authorSourceBinding, currentInvocationGate.authorSourceBinding)) {
              throw new KnownUserFacingError({ error: '本期写作依据在生成期间已变化，请核对后重新生成。', code: 'writing_source_changed' }, { status: 409 });
            }
            const currentMaterialAnalysis = usesMaterialAnalysis && invocationGate.runId
              ? skillName === 'content-intake'
                ? await requireCurrentContentIntakeMaterial(invocationGate.runId)
                : await getMaterialAnalysisContext(invocationGate.runId)
              : null;
            if (materialAnalysis && skillName === 'content-intake' && invocationGate.runId) {
              if (
                !currentMaterialAnalysis
                || currentMaterialAnalysis.inputFingerprint !== materialAnalysis.inputFingerprint
                || currentMaterialAnalysis.analysisInputFingerprint !== materialAnalysis.analysisInputFingerprint
                || currentMaterialAnalysis.selection?.materialTypeId !== materialAnalysis.selection?.materialTypeId
                || currentMaterialAnalysis.selection?.structureId !== materialAnalysis.selection?.structureId
              ) {
                throw new InvocationValidationError('本期素材快照或素材判断在生成期间已变化，请重新整理素材后再生成素材理解报告。');
              }
            }
            if (usesMaterialAnalysis && materialAnalysisFingerprint(currentMaterialAnalysis) !== materialVersion) {
              throw new KnownUserFacingError({
                error: '本期素材整理结果在生成期间已变化，已有稿件不变。请核对最新要求后重新生成。',
                code: 'material_analysis_changed',
              }, { status: 409 });
            }
            const marketSnapshotBinding = invocationGate.marketSnapshotBinding;
            const currentMarketSnapshotBinding = currentInvocationGate.marketSnapshotBinding;
            if (
              marketSnapshotBinding
              && (
                !currentMarketSnapshotBinding
                || currentMarketSnapshotBinding.snapshotPath !== marketSnapshotBinding.snapshotPath
                || currentMarketSnapshotBinding.snapshotSha256 !== marketSnapshotBinding.snapshotSha256
              )
            ) {
              throw new InvocationValidationError('TikOmni 研究快照在生成期间已变化，请重新开始选题与模板流程');
            }
            if (invocationGate.runId && currentInvocationGate.runId !== invocationGate.runId) {
              throw new InvocationValidationError('上游 runtime run 在生成期间已变化，请重新开始本期内容生产');
            }
            if (invocationGate.contentPlan && (
              currentInvocationGate.contentPlan?.path !== invocationGate.contentPlan.path
              || currentInvocationGate.contentPlan?.sha256 !== invocationGate.contentPlan.sha256
            )) throw new InvocationValidationError('写作方案在生成期间已变化，本次正文不能当作新方案的结果。');
            let contentForSave = skillName === 'content-blueprint' && invocationGate.authorSourceBinding
              ? attachAuthorSourceBinding(buffer, invocationGate.authorSourceBinding) : buffer;
            let releaseGate: Awaited<ReturnType<typeof runContentReleaseGate>> | undefined;
            if (skillName === 'content-package' && runtimeStepForWrite === 'package') {
              releaseGate = await runContentReleaseGate(buffer);
              generationIssues = releaseGate.blocking_issues;
              if (releaseGate.status === 'blocked') {
                throw new KnownUserFacingError({
                  error: '已选平台的内容没有完整生成。已生成的文字会保留在第 3 步，可查看缺项后补写；通过检查前不会进入配图。',
                  code: 'content_release_blocked',
                }, { status: 409 });
              }
              contentForSave = releaseGate.repairedBody;
              const requirements = inspectWritingRequirements(contentForSave, materialAnalysis ? getMaterialWritingRequirements(materialAnalysis) : []);
              if (requirements.findings.length) {
                generationIssues = requirements.findings.map((item) => item.message);
                throw new KnownUserFacingError({ error: '已有文字已保留，但还未满足本篇写作要求。请逐项核对并修改，不必重新生成整篇。', code: 'content_requirements_unmet' }, { status: 409 });
              }
            }
            const languageReview = inspectGeneratedLanguage(contentForSave);
            if (languageReview.blocking.length > 0) {
              generationIssues = languageReview.blocking.map((issue) => issue.message);
              throw new InvocationValidationError('内容里还残留对话式说明或敏感信息，已停止保存。请重新生成。');
            }
            if (
              skillName === 'content-blueprint'
              && marketSnapshotBinding
              && !blueprintBindsMarketSnapshot(contentForSave, marketSnapshotBinding)
            ) {
              throw new InvocationValidationError('思想母版蓝图必须原样写入已验证的 TikOmni 研究快照路径与 SHA-256，不能保存未绑定快照的版本');
            }
            const persist = async () => {
              if (invocationGate.authorSourceBinding && invocationGate.runId) {
                const latestSource = await verifiedAuthorSource(invocationGate.runId,
                  skillName === 'content-package' ? invocationGate.contentPlan?.path : undefined);
                if (!sameAuthorSource(invocationGate.authorSourceBinding, latestSource)) {
                  throw new KnownUserFacingError({ error: '保存前写作依据已变化，请重新核对。', code: 'writing_source_changed' }, { status: 409 });
                }
              }
              return saveWithRuntime(
              skillName,
              sanitizeSlug(slug),
              materialPlan ? attachContentPlan(contentForSave, materialPlan) : contentForSave,
              runtimeStepForWrite,
              safeParams,
              invocationGate.runId,
              invocationGate.marketEvidence,
              attempt?.baseline,
              attempt?.id,
              );
            };
            const savedPath = usesMaterialAnalysis && invocationGate.runId
              ? await withProjectWriteLock(`material-analysis:${invocationGate.runId}`, async () => {
                // Keep the final version check and runtime write under the
                // same lock used by editorial saves; validation can take time.
                const latest = await getMaterialAnalysisContext(invocationGate.runId!);
                if (materialAnalysisFingerprint(latest) !== materialVersion) {
                  throw new KnownUserFacingError({ error: '本期素材整理结果已经更新，这次生成不能覆盖现有稿件。请核对后重新生成。', code: 'material_analysis_changed' }, { status: 409 });
                }
                return persist();
              })
              : await persist();
            if (attempt) {
              try { await finishContentAttempt(attempt, buffer, { savedPath }); }
              catch { enqueue(encoder.encode(encodeSystemEvent({ type: 'warning', content: '正文已保存，生成记录未能及时更新。重新打开后会核对已保存的正文，不会自动重新生成。' }))); }
            }
            enqueue(encoder.encode(encodeSystemEvent({ type: 'saved', path: savedPath })));

            if (languageReview.warnings.length > 0) {
              enqueue(encoder.encode(encodeSystemEvent({
                type: 'language_quality',
                status: 'review_required',
                message: '内容已经保存，但有几处表达偏模板化，发布前建议再检查一次。',
                issues: languageReview.warnings,
              })));
            }

            if (releaseGate) {
              enqueue(encoder.encode(encodeSystemEvent({
                type: 'release_gate',
                status: releaseGate.status,
                repaired: releaseGate.repaired,
                message: releaseGate.status === 'review_required'
                  ? '全部内容已经保存，但有几处需要你在发布前确认。'
                  : '全部内容已经通过发布前检查。',
                units: releaseGate.units.map((unit) => ({
                  id: unit.id,
                  status: unit.status,
                  blockingIssueCount: unit.blocking_issues?.length || 0,
                  reviewIssueCount: unit.review_issues?.length || 0,
                })),
                reviewIssueCount: releaseGate.review_issues.length,
              })));
            }

            try {
              const validation = await validateRuntimeOutput(runtimeStepForWrite, savedPath, invocationGate.runId);
              const validationEvent = encodeSystemEvent({
                type: 'validation',
                path: savedPath,
                valid: validation.valid,
                result: validation.result,
              });
              enqueue(encoder.encode(validationEvent));
              if (!validation.valid) {
                const warnEvent = encodeSystemEvent({
                  type: 'warning',
                  content: '内容已经保存，但结构不完整。请按检查结果补齐后再继续。',
                });
                enqueue(encoder.encode(warnEvent));
              }
            } catch (validationError) {
              const failure = userFacingErrorPayload(validationError, {
                error: '内容已经保存，但完整性检查没有完成。请稍后重新检查。',
                code: 'output_validation_unavailable',
                context: 'agent output validation',
              });
              const warnEvent = encodeSystemEvent({
                type: 'warning',
                content: failure.error,
                code: failure.code,
                debugId: failure.debugId,
              });
              enqueue(encoder.encode(warnEvent));
            }
          } catch (writeError) {
            if (writeError instanceof InvocationValidationError
              || writeError instanceof KnownUserFacingError
              || writeError instanceof InputLimitError) {
              throw writeError;
            }
            throw new KnownUserFacingError({
              error: '内容已经生成，但保存失败。请重试。',
              code: 'generated_content_save_failed',
            }, { status: 500, detail: writeError });
          }

          enqueue(encoder.encode('data: [DONE]\n\n'));
          close();
        } catch (error) {
          const cause = error instanceof InvocationValidationError ? safeInvocationError(error) : error;
          const failure = userFacingErrorPayload(cause, {
            error: '生成中断，请重试。',
            code: 'content_generation_failed',
            context: 'agent stream',
          });
          if (attempt && attempt.status !== 'saved') {
            try {
              await finishContentAttempt(attempt, buffer, { reason: failure.error, code: failure.code, issues: generationIssues });
              enqueue(encoder.encode(encodeSystemEvent({ type: 'partial', attemptId: attempt.id, savedCharacters: buffer.length })));
            } catch {
              failure.error += ' 最近收到的文字未能全部保存，请先检查本机存储；此前保存的部分仍可在第 3 步查看。';
            }
          }
          enqueue(encoder.encode(encodeSystemEvent({
            type: 'error',
            content: failure.error,
            code: failure.code,
            debugId: failure.debugId,
            ...(failure.action ? { action: failure.action } : {}),
          })));
          close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    const status = error instanceof KnownUserFacingError ? error.status : error instanceof InvocationValidationError || error instanceof InputLimitError ? 400 : 500;
    const cause = error instanceof InvocationValidationError ? safeInvocationError(error) : error;
    const failure = userFacingErrorPayload(cause, {
      error: '暂时无法开始生成，请重试。',
      code: 'content_generation_start_failed',
      context: 'agent invocation',
    });
    if (attempt && attempt.status !== 'saved') {
      try { await finishContentAttempt(attempt, buffer, { reason: failure.error, code: failure.code }); }
      catch { failure.error += ' 生成记录未能保存，请先检查本机存储。'; }
    }
    return Response.json(failure, { status });
  }
}
