import { getMaterialAnalysisContext, assertMaterialAnalysisCurrent } from '@/lib/material-analysis';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { ensureProjectInitialized } from '@/lib/project-init';
import { readOutputFile } from '@/lib/output-files';
import { runtimeRunById } from '@/lib/runtime-run-resolver';
import { verifyRuntimeAuthorSource, writeRuntimeOutput, validateRuntimeOutput } from '@/lib/runtime-writer';
import { blueprintSections, applyBlueprintSectionEdits } from '@/lib/blueprint-sections';
import { applyWritingBrief, validateWritingBrief, writingBriefFromBlueprint } from '@/lib/writing-brief';
import { assertJsonInputSize, InputLimitError, MAX_TEXT_ARTIFACT_BYTES } from '@/lib/input-limits';
import { expectedUserFacingErrorResponse, userFacingErrorResponse } from '@/lib/user-facing-error';
import { withProjectWriteLock, WriteLockError } from '@/lib/write-guard';

export const runtime = 'nodejs';
class BriefInputError extends Error {}
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

async function source(runId: unknown) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId)) throw new BriefInputError('内容编号不正确。');
  const run = await runtimeRunById(runId);
  const path = run?.steps?.blueprint?.latest;
  if (!run?.slug || run.status === 'archived' || !path || !/^pipeline\/blueprint\/[^/\\]+\.md$/.test(path)) throw new BriefInputError('这期内容还没有可编辑的方案。');
  if (run.research_mode === 'author_material') {
    try { await verifyRuntimeAuthorSource(runId, path); }
    catch { throw new BriefInputError('现有方案还没有对应当前素材与题目。请完成本期方案生成，再核对确认；旧稿仍保留。'); }
  }
  const raw = await readOutputFile(path);
  const context = await getMaterialAnalysisContext(runId);
  if (context) assertMaterialAnalysisCurrent(context);
  const validation = await validateRuntimeOutput('blueprint', path, runId);
  const material = { sections: blueprintSections(raw), platformScope: validation.result.platform_scope || { scope_status: 'unverified', scope_matches: false, issues: ['平台范围尚未核对，请重新读取方案。'] }, sourceMaterial: context?.input?.rawMaterial || (run.steps?.intake?.latest ? await readOutputFile(run.steps.intake.latest) : ''), researchMode: run.research_mode === 'author_material' ? 'author_material' : 'platform', materialCorrectionId: context?.correctionId || '', correctedAnalysis: context?.analysis || null };
  return { run, path, raw, sha256: hash(raw), brief: writingBriefFromBlueprint(raw), material };
}
function failure(error: unknown) {
  if (error instanceof BriefInputError || error instanceof InputLimitError) return expectedUserFacingErrorResponse({ error: error.message, code: 'writing_brief_input', status: 400 });
  return userFacingErrorResponse(error, { error: '方案未能保存。填写的内容还在，请重试。', code: 'writing_brief_failed', status: error instanceof WriteLockError ? 409 : 500 });
}
export async function GET(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const current = await source(req.nextUrl.searchParams.get('runId'));
    return NextResponse.json({ path: current.path, sha256: current.sha256, brief: current.brief, ...current.material });
  } catch (error) { return failure(error); }
}
export async function POST(req: NextRequest) {
  try {
    await ensureProjectInitialized();
    const input = await req.json();
    assertJsonInputSize(input, '写作方案', MAX_TEXT_ARTIFACT_BYTES);
    if (!input || typeof input !== 'object') throw new BriefInputError('请提交写作方案。');
    let brief;
    try { brief = validateWritingBrief(input.brief); } catch (error) { throw new BriefInputError((error as Error).message); }
    if (typeof input.basePath !== 'string' || !/^[a-f0-9]{64}$/.test(input.baseSha256)) throw new BriefInputError('方案版本不正确，请重新读取。');
    const initial = await source(input.runId);
    return await withProjectWriteLock(`writing-brief:${initial.run.run_id}`, async () => withProjectWriteLock(`material-analysis:${initial.run.run_id}`, async () => {
      const current = await source(input.runId);
      if ((input.materialCorrectionId || '') !== current.material.materialCorrectionId) throw new BriefInputError('素材整理结果已修正，请重新读取方案，核对修正内容后再保存。');
      const marker = `ui-writing-brief:${input.baseSha256}:${hash(JSON.stringify({ brief, sectionEdits: input.sectionEdits || [] }))}`;
      // Recover a committed write whose response was lost, without another version.
      if (current.raw.includes(`source: ${marker}\n`) && JSON.stringify(current.brief) === JSON.stringify(brief)) {
        return NextResponse.json({ path: current.path, sha256: current.sha256, brief, ...current.material });
      }
      if (current.path !== input.basePath || current.sha256 !== input.baseSha256) throw new BriefInputError('方案已在其他页面更新，请重新读取后再保存。');
      let edited;
      try { edited = applyBlueprintSectionEdits(current.raw, input.sectionEdits); } catch (error) { throw new BriefInputError((error as Error).message); }
      const body = applyWritingBrief(edited, brief);
      const plain = current.raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '').trim();
      if (body === plain) return NextResponse.json({ path: current.path, sha256: current.sha256, brief, ...current.material });
      const path = await writeRuntimeOutput('blueprint', current.run.slug!, body, marker, current.run.run_id, { path: current.path, sha256: current.sha256 });
      const saved = await source(input.runId);
      return NextResponse.json({ path, sha256: saved.sha256, brief: saved.brief, ...saved.material });
    }));
  } catch (error) { return failure(error); }
}
