import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ root: `/private/tmp/echo-material-corrections-${process.pid}` }));
vi.mock('./project-root', async (original) => {
  const actual = await original<typeof import('./project-root')>();
  return { ...actual, PROJECT_DIR: fixture.root, projectPath: (...parts: string[]) => join(fixture.root, ...parts) };
});
import { saveMaterialCorrection } from './material-corrections';
import { getMaterialAnalysisContext, saveMaterialAnalysisContext, toMaterialAnalysisPromptContext } from './material-analysis';
import { materialAnalysisFingerprint } from './material-analysis-version';
import { runtimeRunById } from './runtime-run-resolver';

const id = () => `correction_${randomUUID().replaceAll('-', '')}`;
const basePath = () => join(fixture.root, 'sessions/material-analysis/run-a.json');
async function request() {
  const context = (await getMaterialAnalysisContext('run-a'))!;
  return { runId: 'run-a', id: id(), expectedFingerprint: materialAnalysisFingerprint(context), changes: { ...context.analysis, summary: '修正后：先讲清交付边界。', opinions: ['先记录改动再确认'], facts: [], cases: [], authorRequirements: ['结尾只写一句，不引导购买'], risks: ['案例尚未核实'] } };
}
beforeEach(async () => {
  await rm(fixture.root, { recursive: true, force: true });
  await mkdir(join(fixture.root, 'runs'), { recursive: true });
  for (const runId of ['run-a', 'run-b']) await writeFile(join(fixture.root, 'runs', `${runId}.json`), JSON.stringify({
    run_id: runId, slug: runId, status: 'active', steps: { blueprint: { latest: 'pipeline/blueprint/old.md' }, package: { latest: 'pipeline/package/old.md' } },
    topic_selection: { topic: '保留的题目', market_snapshot_path: '已有参考' }, history: [],
    approvals: { topic_template: { approved_at: 'previous' }, content_package: { approved_at: 'previous' }, blueprint: { approved_at: 'legacy' } },
  }));
  await saveMaterialAnalysisContext('run-a', { rawMaterial: '我的观点：先写清楚客户改动。要求：结尾引导购买。' });
});
afterEach(async () => { await rm(fixture.root, { recursive: true, force: true }); });

describe('author corrections through the real runtime', () => {
  it('saves one requirement without changing the raw material, other requirements or analysis fields', async () => {
    await saveMaterialAnalysisContext('run-a', { rawMaterial: '【虚构案例】顾问先确认交付范围。请写一篇500字左右的公众号文章。读者是独立顾问。不要引导购买。' });
    const before = (await getMaterialAnalysisContext('run-a'))!;
    const requirements = before.analysis.authorRequirements!;
    expect(requirements.length).toBeGreaterThan(1);
    const index = requirements.findIndex((item) => item.includes('500字'));
    expect(index).toBeGreaterThanOrEqual(0);
    const authorRequirements = requirements.map((item, i) => i === index ? '请写400至600字。' : item);
    const saved = await saveMaterialCorrection({ runId: 'run-a', id: id(), expectedFingerprint: materialAnalysisFingerprint(before), changes: { ...before.analysis, opinions: before.analysis.opinions || [], authorRequirements } });
    expect(saved.context.input).toEqual(before.input);
    expect(saved.context.analysis).toEqual({ ...before.analysis, authorRequirements });
    expect((await getMaterialAnalysisContext('run-a'))!.analysis).toEqual(saved.context.analysis);
    const prompt = toMaterialAnalysisPromptContext(saved.context);
    expect(prompt).toContain('请写400至600字');
    expect(prompt).toContain('不要引导购买');
    const run = JSON.parse(await readFile(join(fixture.root, 'runs/run-a.json'), 'utf8'));
    expect(run.approvals?.content_package?.invalidation_reason).toBe('material_corrected');
    expect(run.steps.package.latest).toBe('pipeline/package/old.md');
  });
  it('rejects a single requirement save when another editor changed a different group', async () => {
    const initial = (await getMaterialAnalysisContext('run-a'))!;
    const expectedFingerprint = materialAnalysisFingerprint(initial);
    const common = { ...initial.analysis, opinions: initial.analysis.opinions || [], authorRequirements: initial.analysis.authorRequirements || [] };
    await saveMaterialCorrection({ runId: 'run-a', id: id(), expectedFingerprint, changes: { ...common, opinions: ['新确认的观点'] } });
    await expect(saveMaterialCorrection({ runId: 'run-a', id: id(), expectedFingerprint, changes: { ...common, authorRequirements: ['只写一句，不推销'] } })).rejects.toThrow('已更新');
    const latest = (await getMaterialAnalysisContext('run-a'))!;
    expect(latest.analysis.opinions).toEqual(['新确认的观点']);
    expect(latest.analysis.authorRequirements).toEqual(common.authorRequirements);
  });
  it('commits corrections with invalidation, reopens them, and preserves source, old work and research', async () => {
    const before = await readFile(basePath(), 'utf8');
    const other = await readFile(join(fixture.root, 'runs/run-b.json'), 'utf8');
    const input = await request();
    const result = await saveMaterialCorrection(input);
    expect(result.context.correctionId).toBe(input.id);
    expect(result.context.analysis.authorRequirements).toEqual(input.changes.authorRequirements);
    expect(await readFile(basePath(), 'utf8')).toBe(before);
    expect(await readFile(join(fixture.root, 'runs/run-b.json'), 'utf8')).toBe(other);
    const run = JSON.parse(await readFile(join(fixture.root, 'runs/run-a.json'), 'utf8'));
    expect(run.steps.package.latest).toBe('pipeline/package/old.md');
    expect(run.topic_selection.market_snapshot_path).toBe('已有参考');
    for (const key of ['topic_template', 'content_package', 'blueprint']) expect(run.approvals[key].invalidation_reason).toBe('material_corrected');
    const reopened = (await getMaterialAnalysisContext('run-a'))!;
    expect(reopened.analysis).toEqual(result.context.analysis);
    expect(toMaterialAnalysisPromptContext(reopened)).toContain('作者逐条修正');
    expect(toMaterialAnalysisPromptContext(reopened)).toContain('结尾只写一句，不引导购买');
    // Selection/autosave cannot silently replace the author's correction.
    const selected = await saveMaterialAnalysisContext('run-a', { selection: { materialTypeId: reopened.analysis.recommendedTypeId, structureId: reopened.analysis.recommendedStructureId } });
    expect(selected.analysis).toEqual(reopened.analysis);
  });
  it('retries the same operation without duplicate history and rejects changed request reuse', async () => {
    const input = await request();
    await saveMaterialCorrection(input);
    expect((await saveMaterialCorrection(input)).context.correctionId).toBe(input.id);
    const run = JSON.parse(await readFile(join(fixture.root, 'runs/run-a.json'), 'utf8'));
    expect(run.history.filter((entry: { event: string }) => entry.event === 'material_corrected')).toHaveLength(1);
    await expect(saveMaterialCorrection({ ...input, changes: { ...input.changes, facts: ['换了一个事实'] } })).rejects.toThrow('同一次保存');
  });
  it('rejects a stale editor and never resurrects a superseded correction', async () => {
    const first = await request();
    const stale = await request();
    await saveMaterialCorrection(first);
    await expect(saveMaterialCorrection(stale)).rejects.toThrow('已更新');
    const second = await request();
    await saveMaterialCorrection({ ...second, changes: { ...second.changes, opinions: ['第二次修正'] } });
    await expect(saveMaterialCorrection(first)).rejects.toThrow('未能确认');
    expect((await getMaterialAnalysisContext('run-a'))?.analysis.opinions).toEqual(['第二次修正']);
  });
  it('allows explicit empty groups, preserves sources and ignores submitted routing overrides', async () => {
    const input = await request();
    const result = await saveMaterialCorrection({ ...input, changes: { ...input.changes, authorRequirements: [], opinions: [], sources: [], recommendedTypeId: 'fake' } });
    expect(result.context.analysis.authorRequirements).toEqual([]);
    expect(result.context.analysis.opinions).toEqual([]);
    expect(result.context.analysis.recommendedTypeId).not.toBe('fake');
  });
  it('does not overlay an old correction on new source material', async () => {
    await saveMaterialCorrection(await request());
    const fresh = await saveMaterialAnalysisContext('run-a', { rawMaterial: '新的材料：这次写个人经历，结尾只说谢谢。' });
    expect(fresh.correctionId).toBeUndefined();
    expect(fresh.analysis_source).toBe('heuristic');
  });
  it('fails closed if a correction record changes after saving', async () => {
    await saveMaterialCorrection(await request());
    const run = (await runtimeRunById('run-a'))!;
    await writeFile(join(fixture.root, run.material_correction!.path), '{}');
    await expect(getMaterialAnalysisContext('run-a')).rejects.toThrow('无法核对');
  });
  it('rejects symbolic link storage and leaves approvals unchanged', async () => {
    const input = await request();
    const runBefore = await readFile(join(fixture.root, 'runs/run-a.json'), 'utf8');
    await mkdir(join(fixture.root, 'runs/run-a'), { recursive: true });
    await mkdir(join(fixture.root, 'elsewhere'));
    await symlink(join(fixture.root, 'elsewhere'), join(fixture.root, 'runs/run-a/material-corrections'));
    await expect(saveMaterialCorrection(input)).rejects.toThrow('符号链接');
    expect(await readFile(join(fixture.root, 'runs/run-a.json'), 'utf8')).toBe(runBefore);
  });
  it('serializes two editors so only one correction can win', async () => {
    const first = await request();
    const second = await request();
    const result = await Promise.allSettled([saveMaterialCorrection(first), saveMaterialCorrection(second)]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(result.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});
