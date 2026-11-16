import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { applyWritingBrief, confirmedWritingBriefContext, validateWritingBrief, writingBriefFromBlueprint, writingBriefEndingProposal } from './writing-brief';

const fixture = vi.hoisted(() => ({ files: {} as Record<string, string>, latest: 'pipeline/blueprint/original.md', writes: 0, approved: true, correctionId: '' }));
vi.mock('@/lib/project-init', () => ({ ensureProjectInitialized: async () => {} }));
vi.mock('@/lib/output-files', () => ({ readOutputFile: async (path: string) => fixture.files[path] }));
vi.mock('@/lib/runtime-run-resolver', () => ({ runtimeRunById: async (id: string) => id === 'run-a' ? { run_id: id, slug: 'topic', steps: { blueprint: { latest: fixture.latest } }, ...(fixture.correctionId ? { material_correction: { id: fixture.correctionId } } : {}) } : null }));
vi.mock('@/lib/material-analysis', () => ({ getMaterialAnalysisContext: async () => ({ correctionId: fixture.correctionId, analysis: { summary: '修正后的要求', authorRequirements: ['不引导私信'] } }), assertMaterialAnalysisCurrent: () => {} }));
vi.mock('@/lib/write-guard', () => ({ withProjectWriteLock: async (_key: string, fn: () => unknown) => fn(), WriteLockError: class extends Error {} }));
vi.mock('@/lib/runtime-writer', () => ({ validateRuntimeOutput: async () => ({ valid: true, result: { platform_scope: { scope_status: 'matched', scope_matches: true, issues: [] } } }), writeRuntimeOutput: async (_step: string, _slug: string, body: string, source: string, _runId: string, expected: { path: string; sha256: string }) => {
  if (expected.path !== fixture.latest || expected.sha256 !== hash(fixture.files[fixture.latest])) throw new Error('stale');
  fixture.latest = `pipeline/blueprint/version-${++fixture.writes}.md`;
  fixture.files[fixture.latest] = `---\nsource: ${source}\n---\n\n${body}\n`;
  fixture.approved = false;
  return fixture.latest;
} }));
import { GET, POST } from '@/app/api/production/writing-brief/route';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const original = '# 蓝图\n\n## 0. 上游约束\n- 研究快照：runs/run-a/market-research/a/snapshot.json\n\n## 1. 共享事实底稿\n- 核心观点：客户问题能写成文章。\n- 目标受众与业务目标：服务型小团队负责人。\n\n## 2. 公众号独立蓝图\n- 长文结构与证据分配：记录—筛选—展开；结尾给出一个行动。\n- 排版、评论和商业收口：不引导私信。';
const brief = { audience: '服务型小团队负责人', point: '记录客户反复问的问题', structure: '先记录，再筛选，最后展开', ending: '先记下今天被问到的那个问题。' };
const post = (body: unknown) => POST(new NextRequest('http://localhost/api/production/writing-brief', { method: 'POST', body: JSON.stringify(body) }));
beforeEach(() => { fixture.latest = 'pipeline/blueprint/original.md'; fixture.files = { [fixture.latest]: original }; fixture.writes = 0; fixture.approved = true; fixture.correctionId = ''; });

describe('author-reviewed writing brief', () => {
  it('saves a selected chapter as a new version, preserves evidence, and rejects a concurrent edit', async () => {
    const before = await (await GET(new NextRequest('http://localhost/api/production/writing-brief?runId=run-a'))).json();
    const chapter = before.sections.find((section: { title: string }) => section.title.includes('公众号'));
    const sectionEdits = [{ id: chapter.id, text: chapter.text.replace('记录—筛选—展开', '先描述本地测试，再说明修改和验证') }];
    const input = { runId: 'run-a', basePath: before.path, baseSha256: before.sha256, brief, sectionEdits };
    const saved = await post(input);
    expect(saved.status).toBe(200);
    const current = await saved.json();
    expect(current.sections.find((section: { title: string }) => section.title.includes('公众号'))?.text).toContain('先描述本地测试');
    expect(fixture.files[before.path]).toBe(original);
    expect(fixture.files[current.path]).toContain('研究快照：runs/run-a/market-research/a/snapshot.json');
    expect(fixture.approved).toBe(false);
    expect((await post(input)).status).toBe(200);
    expect(fixture.writes).toBe(1);
    expect((await post({ ...input, sectionEdits: [{ id: chapter.id, text: '' }] })).status).toBe(400);
    expect(fixture.writes).toBe(1);
  });
  it('does not let the chapter editor overwrite upstream evidence', async () => {
    const before = await (await GET(new NextRequest('http://localhost/api/production/writing-brief?runId=run-a'))).json();
    const upstream = before.sections.find((section: { title: string }) => section.title.includes('上游'));
    const response = await post({ runId: 'run-a', basePath: before.path, baseSha256: before.sha256, brief, sectionEdits: [{ id: upstream.id, text: '' }] });
    expect(response.status).toBe(400);
    expect(fixture.writes).toBe(0);
  });
  it('reloads a plan with separate editable chapters after full replacements and a repeated save', async () => {
    fixture.files[fixture.latest] = original + '\n\n## 3. 小红书独立蓝图\n本节未生成。\n\n## 4. 人工确认清单\n等待作者核对。\n';
    const initial = fixture.files[fixture.latest];
    const read = async () => (await GET(new NextRequest('http://localhost/api/production/writing-brief?runId=run-a'))).json();
    const before = await read();
    const sectionEdits = before.sections.filter((section: { editable: boolean }) => section.editable).map((section: { id: string; title: string }) => ({
      id: section.id,
      text: section.title.includes('小红书') ? '' : `## ${section.title}\n仅为作者观点，等待核对。`,
    }));
    const input = { runId: 'run-a', basePath: before.path, baseSha256: before.sha256, brief, sectionEdits };
    expect((await post(input)).status).toBe(200);
    const saved = await read();
    expect(saved.sections.filter((section: { editable: boolean }) => section.editable).map((section: { title: string }) => section.title)).toEqual(['1. 共享事实底稿', '2. 公众号独立蓝图']);
    expect(saved.sections.find((section: { title: string }) => section.title.includes('人工确认'))?.editable).toBe(false);
    expect(saved.sections.some((section: { title: string }) => section.title.includes('小红书'))).toBe(false);
    expect(fixture.files[before.path]).toBe(initial);
    expect(fixture.approved).toBe(false);
    const revised = saved.sections.find((section: { title: string }) => section.title.includes('公众号'));
    expect((await post({ runId: 'run-a', basePath: saved.path, baseSha256: saved.sha256, brief, sectionEdits: [{ id: revised.id, text: '## 2. 公众号独立蓝图\n再次修改后仍可编辑。' }] })).status).toBe(200);
    const reloaded = await read();
    expect(reloaded.sections.find((section: { title: string }) => section.title.includes('公众号'))?.editable).toBe(true);
    expect(reloaded.sections.find((section: { title: string }) => section.title.includes('人工确认'))?.text).toBe(before.sections.find((section: { title: string }) => section.title.includes('人工确认'))?.text);
    expect((await post(input)).status).toBe(400);
    expect(fixture.writes).toBe(2);
  });
  it('shows corrections and rejects a save from a browser that reviewed an older material version', async () => {
    const old = await (await GET(new NextRequest('http://localhost/api/production/writing-brief?runId=run-a'))).json();
    fixture.correctionId = 'correction_' + 'a'.repeat(32);
    const rejected = await post({ runId: 'run-a', basePath: old.path, baseSha256: old.sha256, brief });
    expect(rejected.status).toBe(400);
    expect(fixture.writes).toBe(0);
    const current = await (await GET(new NextRequest('http://localhost/api/production/writing-brief?runId=run-a'))).json();
    expect(current.correctedAnalysis.authorRequirements).toEqual(['不引导私信']);
    const accepted = await post({ runId: 'run-a', basePath: current.path, baseSha256: current.sha256, materialCorrectionId: current.materialCorrectionId, brief });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).materialCorrectionId).toBe(fixture.correctionId);
  });

  it('previews a single ending authority while preserving the body outline and other fields', () => {
    const source = { ...brief, structure: '开头不编造客户故事；主体先记录，再筛选；结尾引导读者回想“最近被问得最多的问题是什么”。' };
    const proposal = writingBriefEndingProposal(source)!;
    expect(proposal.previous).toEqual(['结尾引导读者回想“最近被问得最多的问题是什么”']);
    expect(proposal.structure).toBe('开头不编造客户故事；主体先记录，再筛选；结尾按下方“最后怎样收尾”执行。');
    expect(source.structure).toContain('结尾引导读者回想');
    expect(writingBriefEndingProposal({ ...source, structure: proposal.structure })).toBeNull();
    expect(writingBriefEndingProposal({ ...source, ending: '' })).toBeNull();
    expect(writingBriefEndingProposal({ ...brief, structure: '主体对比不同结尾的效果；介绍一个方法。' })).toBeNull();
    expect(writingBriefEndingProposal({ ...brief, structure: '开头提问；结尾保留“先记录。再核对；不要急。”；其余保持平实。' })?.structure)
      .toBe('开头提问；结尾按下方“最后怎样收尾”执行；其余保持平实。');
    expect(writingBriefEndingProposal({ ...brief, structure: '结尾写“尚未说完。下一部分怎么写' })).toBeNull();
  });
  it('persists the reviewed ending proposal as a new plan with the old plan and evidence intact', async () => {
    const proposal = writingBriefEndingProposal(writingBriefFromBlueprint(original))!;
    const response = await post({ runId: 'run-a', basePath: fixture.latest, baseSha256: hash(original), brief: { ...brief, structure: proposal.structure } });
    expect(response.status).toBe(200);
    expect(fixture.files['pipeline/blueprint/original.md']).toBe(original);
    expect(fixture.files[fixture.latest]).toContain('研究快照：runs/run-a/market-research/a/snapshot.json');
    expect(confirmedWritingBriefContext(fixture.files[fixture.latest])).toContain('结尾按下方“最后怎样收尾”执行');
    expect(confirmedWritingBriefContext(fixture.files[fixture.latest])).toContain(brief.ending);
    expect(fixture.approved).toBe(false);
  });
  it('reads actual legacy plan fields without inventing missing details', () => {
    expect(writingBriefFromBlueprint(original)).toEqual({ audience: '服务型小团队负责人。', point: '客户问题能写成文章。', structure: '记录—筛选—展开；结尾给出一个行动。', ending: '不引导私信。' });
    expect(writingBriefFromBlueprint('# 无方案')).toEqual({ audience: '', point: '', structure: '', ending: '' });
  });
  it('preserves the original evidence and round-trips author edits without duplicating the block', () => {
    const first = applyWritingBrief(original, brief);
    expect(first).toContain(original);
    expect(writingBriefFromBlueprint(first)).toEqual(brief);
    expect(applyWritingBrief(first, brief)).toBe(first);
    expect(confirmedWritingBriefContext(first)).toContain('最后怎样收尾：先记下今天被问到的那个问题。');
    expect(confirmedWritingBriefContext(original)).toBe('');
    expect(() => validateWritingBrief({ ...brief, ending: '' })).toThrow('最后怎样收尾');
  });
  it('saves a new version without approving or regenerating and recovers repeated requests', async () => {
    const before = await (await GET(new NextRequest('http://localhost/api/production/writing-brief?runId=run-a'))).json();
    const request = { runId: 'run-a', basePath: before.path, baseSha256: before.sha256, brief };
    const response = await post(request);
    expect(response.status).toBe(200);
    expect(fixture.approved).toBe(false);
    expect(fixture.files[before.path]).toBe(original);
    expect((await response.json()).brief).toEqual(brief);
    expect((await post(request)).status).toBe(200);
    expect(fixture.writes).toBe(1);
    const refreshed = await (await GET(new NextRequest('http://localhost/api/production/writing-brief?runId=run-a'))).json();
    expect(refreshed.path).toBe(fixture.latest);
    expect(refreshed.brief).toEqual(brief);
  });
  it('rejects stale versions, other runs and incomplete fields without writes', async () => {
    const request = { runId: 'run-a', basePath: fixture.latest, baseSha256: hash(original), brief };
    for (const input of [null, { ...request, runId: 'run-b' }, { ...request, baseSha256: 'a'.repeat(64) }, { ...request, brief: { ...brief, ending: '' } }]) expect((await post(input)).status).toBe(400);
    expect(fixture.writes).toBe(0);
  });
});
