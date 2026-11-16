import { NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { KnownUserFacingError, userFacingErrorResponse } from '@/lib/user-facing-error';
import { readOutputFile } from '@/lib/output-files';
import { assertGeneratedResearchLanguage, buildRepairedValidateMarkdown } from '@/lib/public-research';
import { resolveRuntimeWriteTarget, runsForPipelinePath } from '@/lib/runtime-run-resolver';
import { validateRuntimeOutput, writeRuntimeOutput } from '@/lib/runtime-writer';
import { assertMarketSnapshotBoundToIntake } from '@/lib/tikomni-market-gate';
import { assertJsonInputSize, assertOptionalTextInput, assertTextInput, InputLimitError, MAX_AGENT_PAYLOAD_BYTES, MAX_SHORT_TEXT_BYTES } from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';

function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9一-龥\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'low-evidence-repair';
}

function assertReadablePath(path: string, label: string, prefixes: string[]): void {
  if (!prefixes.some((prefix) => path.startsWith(prefix))) {
    throw new InputLimitError(`${label}路径不在允许范围内`);
  }
  if (path.includes('..') || path.includes('\\')) {
    throw new InputLimitError(`${label}路径非法`);
  }
}

function assertOptionalReadablePath(path: string | undefined, label: string, prefixes: string[]): void {
  if (!path) return;
  assertReadablePath(path, label, prefixes);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean);
}

export async function POST(req: Request) {
  try {
    await ensureProjectInitialized();
    const body = await req.json() as {
      sourcePath?: unknown;
      passagePlanPath?: unknown;
      marketSignalPath?: unknown;
      researchReportPath?: unknown;
      explorationReportPath?: unknown;
      slug?: unknown;
      topic?: unknown;
      platforms?: unknown;
    };
    assertJsonInputSize(body, '低证据立项修复参数', MAX_AGENT_PAYLOAD_BYTES);

    const sourcePath = assertTextInput(body.sourcePath, '素材理解报告路径', MAX_SHORT_TEXT_BYTES).trim();
    const passagePlanPath = assertTextInput(body.passagePlanPath, '低证据通行方案路径', MAX_SHORT_TEXT_BYTES).trim();
    const marketSignalPath = assertTextInput(body.marketSignalPath, '爆款抓取与对标报告路径', MAX_SHORT_TEXT_BYTES).trim();
    const researchReportPath = assertOptionalTextInput(body.researchReportPath, '公开补证报告路径', MAX_SHORT_TEXT_BYTES)?.trim();
    const explorationReportPath = assertOptionalTextInput(body.explorationReportPath, '预研角度报告路径', MAX_SHORT_TEXT_BYTES)?.trim();
    assertReadablePath(sourcePath, '素材理解报告', ['pipeline/intake/']);
    assertReadablePath(passagePlanPath, '低证据通行方案', ['materials/research/']);
    assertReadablePath(marketSignalPath, '爆款抓取与对标报告', ['materials/research/']);
    if (!marketSignalPath.endsWith('-market-signal.md')) {
      throw new InputLimitError('爆款抓取与对标报告必须是 market-signal 报告');
    }
    assertOptionalReadablePath(researchReportPath, '公开补证报告', ['materials/research/']);
    assertOptionalReadablePath(explorationReportPath, '预研角度报告', ['materials/research/']);

    const slug = sanitizeSlug(assertOptionalTextInput(body.slug, 'slug', MAX_SHORT_TEXT_BYTES)?.trim() || 'low-evidence-repair');
    const topic = assertOptionalTextInput(body.topic, '选题', MAX_SHORT_TEXT_BYTES)?.trim();
    const platforms = stringArray(body.platforms);
    const [sourceRuns, sourceContent, passagePlanContent, marketSignalContent] = await Promise.all([
      runsForPipelinePath(sourcePath, 'intake'),
      readOutputFile(sourcePath),
      readOutputFile(passagePlanPath),
      readOutputFile(marketSignalPath),
    ]);
    const sourceRun = sourceRuns.find((run) => run.run_id && run.steps?.intake?.latest === sourcePath);
    if (!sourceRun?.run_id) {
      throw new InputLimitError('低证据立项修复必须绑定当前 runtime run 的最新 intake 素材，不能跨任务复用');
    }
    try {
      await assertMarketSnapshotBoundToIntake(
        marketSignalContent,
        sourcePath,
        sourceRun.run_id,
        '爆款抓取与对标报告',
      );
    } catch (error) {
      throw new InputLimitError(error instanceof Error ? error.message : 'TikOmni 研究快照校验失败');
    }
    const repaired = buildRepairedValidateMarkdown({
      sourcePath,
      sourceContent,
      passagePlanPath,
      passagePlanContent,
      marketSignalPath,
      marketSignalContent,
      researchReportPath,
      explorationReportPath,
      topic,
      platforms,
    });
    const languageWarnings = assertGeneratedResearchLanguage(repaired.markdown, {
      label: '重新检查选题',
      href: '/production?stage=2',
    });

    const target = await resolveRuntimeWriteTarget({
      fallbackSlug: slug,
      sourcePaths: [{ path: sourcePath, step: 'intake' }],
    });
    if (target.runId !== sourceRun.run_id) {
      throw new InputLimitError('低证据立项修复的写入目标与当前素材 runtime run 不一致');
    }
    const path = await writeRuntimeOutput(
      'validate',
      target.slug || slug,
      repaired.markdown,
      `ui-repair:${passagePlanPath}`,
      sourceRun.run_id,
    );
    const validation = await validateRuntimeOutput('validate', path);

    return NextResponse.json(redactLocalPaths({
      ok: validation.valid,
      path,
      validation,
      title: repaired.title,
      route: repaired.route,
      platform: repaired.platform,
      languageWarnings,
    }));
  } catch (error) {
    const status = error instanceof InputLimitError ? 400 : 500;
    const detail = error instanceof Error ? error.message : '';
    const cause = error instanceof InputLimitError && /TikOmni|研究快照|平台样本|对标报告/i.test(detail)
      ? new KnownUserFacingError({
        error: '平台数据不完整或已经变化，请重新获取后再继续。',
        code: 'platform_data_refresh_required',
        action: { label: '重新获取平台数据', href: '/production' },
      }, { status: 400, detail: error })
      : error instanceof InputLimitError && /runtime run|当前素材|跨任务|写入目标/i.test(detail)
        ? new KnownUserFacingError({
          error: '当前任务已经变化，请刷新后重试。',
          code: 'task_changed',
        }, { status: 400, detail: error })
        : error;
    return userFacingErrorResponse(cause, {
      error: '暂时无法修改主题检查结果，请重试。',
      code: 'research_validation_repair_failed',
      status,
    });
  }
}
