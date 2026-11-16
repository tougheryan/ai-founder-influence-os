import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ root: '' }));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', () => ({ get PROJECT_DIR() { return fixture.root; } }));

import { getOutputDisclosure, getRunDisclosure } from './output-disclosure';
import { markExportText } from './output-disclosure-format';
import { prepareOutputDownload } from './output-export';
import { prepareOutputCopy } from './output-copy';

type Run = {
  run_id: string;
  slug: string;
  steps: Record<string, { latest: string }>;
  history?: Array<{ step?: string; path?: string; event?: string }>;
  phase_artifacts?: Record<string, { path: string }>;
  material_correction?: { id: string; path: string; sha256: string };
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const INPUT = digest('local synthetic material');
const correctionId = (index = '1') => `correction_${index.repeat(32)}`;
async function write(path: string, value: unknown) {
  const target = join(fixture.root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, typeof value === 'string' ? value : JSON.stringify(value));
}
async function context(runId: string, risks: string[] = [], changes: Record<string, unknown> = {}) {
  await write(`sessions/material-analysis/${runId}.json`, {
    schema: 'aifios.material-analysis.v1', runId, analysisStatus: 'current',
    inputFingerprint: INPUT, analysisInputFingerprint: INPUT,
    input: { rawMaterial: 'Synthetic test only' }, analysis: { risks }, ...changes,
  });
}
async function run(runId: string, risks: string[] = [], changes: Partial<Run> = {}) {
  const value: Run = { run_id: runId, slug: runId, steps: { package: { latest: `pipeline/package/${runId}.md` } }, ...changes };
  await write(`runs/${runId}.json`, value);
  await write(`pipeline/package/${runId}.md`, '# Synthetic local test');
  await context(runId, risks);
  return value;
}
async function correct(value: Run, risks: string[], index = '1', changes: Record<string, unknown> = {}) {
  const id = correctionId(index);
  const path = `runs/${value.run_id}/material-corrections/${id}.json`;
  const body = JSON.stringify({ schema: 'echo.material-correction.v1', run_id: value.run_id, id,
    input_fingerprint: INPUT, analysis: { risks }, ...changes });
  await write(path, body);
  value.material_correction = { id, path, sha256: digest(body) };
  await write(`runs/${value.run_id}.json`, value);
  return path;
}

beforeEach(async () => { fixture.root = await mkdtemp(join(tmpdir(), 'echo-output-disclosure-')); });
afterEach(async () => { await rm(fixture.root, { recursive: true, force: true }); });

describe('current author restrictions from real project files', () => {
  const writingRule = '以上为作者观察和判断，尚未提供个人经历、具体行业案例或量化数据。请区分观点与待核验事实，不要编造作者身份、亲身经历、行业案例、数字或引用。';

  it('preserves source writing requirements without inserting a disclosure banner into preview, download or copy', async () => {
    await run('a', [writingRule]);
    const sourcePath = 'pipeline/visual/a/publish/r002/wechat/article.html';
    const html = '<html><body><h1>已确认的文章</h1><p>保留原文句号。</p><p><a href="https://example.com/source">引用</a></p></body></html>';
    await write(sourcePath, html);
    const materialPath = join(fixture.root, 'sessions/material-analysis/a.json');
    const before = await readFile(materialPath);
    const disclosure = await getOutputDisclosure(sourcePath);
    expect(disclosure).toMatchObject({ status: 'no_whole_draft_limit', restrictions: [] });
    expect(markExportText(html, '.html', disclosure)).toBe(html);
    expect(prepareOutputDownload(Buffer.from(html), 'article.html', 'text/html', disclosure)).toMatchObject({ body: Buffer.from(html), fileName: 'article.html' });
    const copy = await prepareOutputCopy(sourcePath, '保留原文句号。', async () => Response.json({ disclosure: await getOutputDisclosure(sourcePath) }));
    expect(copy).toEqual({ text: '保留原文句号。', notice: '' });
    expect(await readFile(materialPath)).toEqual(before);
    expect(await readFile(join(fixture.root, sourcePath), 'utf8')).toBe(html);
  });

  it.each([
    ['不要编造案例。客户姓名不可公开。', 'restricted_details'],
    ['不要编造数字；本期仅供内部使用。', 'internal_only'],
    ['请区分观点与待核验事实，需要先取得客户同意。', 'restricted_details'],
    ['不要编造案例；还有约定需要确认。', 'unverified'],
  ])('retains mixed or unresolved limits across preview, download and copy: %s', async (entry, status) => {
    await run('a', [entry]);
    const sourcePath = 'pipeline/visual/a/publish/r002/wechat/article.html';
    const html = '<html><body><p>待核对的正文。</p></body></html>';
    await write(sourcePath, html);
    const disclosure = await getOutputDisclosure(sourcePath);
    expect(disclosure).toMatchObject({ status, restrictions: [entry] });
    expect(markExportText(html, '.html', disclosure)).toContain(entry);
    expect(prepareOutputDownload(Buffer.from(html), 'article.html', 'text/html', disclosure).body.toString()).toContain(entry);
    const copy = await prepareOutputCopy(sourcePath, '待核对的正文。', async () => Response.json({ disclosure: await getOutputDisclosure(sourcePath) }));
    expect(copy.text).toContain(entry);
    expect(copy.notice).not.toBe('');
  });

  it('classifies explicit legacy writing instructions while retaining a later actual restriction', async () => {
    const value = await run('a');
    value.steps.intake = { latest: 'pipeline/intake/a.md' };
    await write('runs/a.json', value);
    await rm(join(fixture.root, 'sessions/material-analysis/a.json'));
    await write(value.steps.intake.latest, `## 7. 不可公开信息\n- 公开边界：${writingRule}\n`);
    expect(await getRunDisclosure('a')).toMatchObject({ status: 'no_whole_draft_limit', restrictions: [] });
    await write(value.steps.intake.latest, `## 7. 不可公开信息\n- 公开边界：${writingRule}\n- 公开边界：需要先取得授权\n`);
    expect(await getRunDisclosure('a')).toMatchObject({ status: 'restricted_details', restrictions: ['需要先取得授权'] });
  });

  it('keeps different drafts separate and ignores the active-window pointer', async () => {
    await run('a', ['本期仅供内部使用']);
    await run('b', ['客户姓名不可公开']);
    await write('runs/state.json', { active_run_id: 'a' });
    expect(await getOutputDisclosure('pipeline/package/b.md')).toMatchObject({ status: 'restricted_details', runId: 'b', restrictions: ['客户姓名不可公开'] });
    expect(await getOutputDisclosure('pipeline/package/a.md')).toMatchObject({ status: 'internal_only', runId: 'a' });
    expect(await getOutputDisclosure('pipeline/package/unknown.md')).toEqual({ status: 'unverified', restrictions: [] });
  });

  it('resolves exact latest, history and phase registrations using the current author limits', async () => {
    const value = await run('a', ['本期不对外发布'], {
      history: [{ step: 'package', path: 'pipeline/package/old.md' }, { event: 'resumed' }],
      phase_artifacts: { draft_information: { path: 'pipeline/publish-assets/registered.md' } },
    });
    for (const path of ['pipeline/package/old.md', 'pipeline/publish-assets/registered.md']) await write(path, '# old local output');
    for (const path of [value.steps.package.latest, 'pipeline/package/old.md', 'pipeline/publish-assets/registered.md']) {
      expect(await getOutputDisclosure(path)).toMatchObject({ status: 'internal_only', runId: 'a' });
    }
  });

  it.each([
    'pipeline/publish-assets/topic/shipinhao-short-01.md',
    'pipeline/visual/topic/publish/r001/wechat/article.html',
    'pipeline/publish-assets/topic-publish-assets.md',
    'pipeline/publish-assets/topic-platform-deliverables.json',
  ])('resolves the fixed derived path %s without an active run', async (path) => {
    await run('a', ['合同金额不可公开'], { slug: 'topic' });
    await write(path, 'local derived output');
    expect(await getOutputDisclosure(path)).toMatchObject({ status: 'restricted_details', runId: 'a' });
  });

  it('does not infer an owner from a neighboring slug prefix', async () => {
    await run('a', [], { slug: 'topic' });
    const path = 'pipeline/visual/topic-other/article.html';
    await write(path, 'local output');
    expect((await getOutputDisclosure(path)).status).toBe('unverified');
  });

  it('rejects competing exact registrations and repeated derived slugs', async () => {
    await run('a', [], { slug: 'same' });
    await run('b', ['本期仅供内部使用'], { slug: 'same', history: [{ path: 'pipeline/package/a.md' }] });
    await write('pipeline/visual/same/article.html', '<p>local</p>');
    expect((await getOutputDisclosure('pipeline/package/a.md')).status).toBe('unverified');
    expect((await getOutputDisclosure('pipeline/visual/same/article.html')).status).toBe('unverified');
    // Even an exact registration cannot override the second run's same slug.
    await write('runs/a.json', { run_id: 'a', slug: 'same', steps: { visual: { latest: 'pipeline/visual/same/article.html' } } });
    expect((await getOutputDisclosure('pipeline/visual/same/article.html')).status).toBe('unverified');
  });

  it('keeps a provable exact owner available despite an unrelated broken old run', async () => {
    await run('a', ['本期仅供内部使用']);
    await write('runs/broken-history.json', '{invalid');
    expect((await getOutputDisclosure('pipeline/package/a.md')).status).toBe('internal_only');
    await write('pipeline/visual/a/article.html', '<p>local</p>');
    expect((await getOutputDisclosure('pipeline/visual/a/article.html')).status).toBe('unverified');
  });

  it('rejects a damaged record that still claims the same path', async () => {
    await run('a');
    await write('runs/b.json', { run_id: 'wrong-name', history: [{ path: 'pipeline/package/a.md' }] });
    expect((await getOutputDisclosure('pipeline/package/a.md')).status).toBe('unverified');
    expect((await getRunDisclosure('b')).status).toBe('unverified');
  });

  it('reads the latest correction on every call and changes its fingerprint', async () => {
    const value = await run('a', ['客户姓名不可公开']);
    const first = await getRunDisclosure('a');
    expect(first).toMatchObject({ status: 'restricted_details', restrictions: ['客户姓名不可公开'] });
    await correct(value, ['本期仅供内部使用']);
    const second = await getOutputDisclosure('pipeline/package/a.md');
    expect(second).toMatchObject({ status: 'internal_only', restrictions: ['本期仅供内部使用'] });
    expect(second.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(second.fingerprint).not.toBe(first.fingerprint);
    await correct(value, [], '2');
    const third = await getRunDisclosure('a');
    expect(third).toMatchObject({ status: 'no_whole_draft_limit', restrictions: [] });
    expect(third.fingerprint).not.toBe(second.fingerprint);
  });

  it.each(['expired', 'tampered', 'missing', 'wrong-owner', 'wrong-path'] as const)('reports %s corrections as unverified', async (kind) => {
    const value = await run('a');
    const path = await correct(value, ['本期仅供内部使用'], '1', kind === 'expired' ? { input_fingerprint: digest('older input') }
      : kind === 'wrong-owner' ? { run_id: 'b' } : {});
    if (kind === 'tampered') await write(path, '{}');
    if (kind === 'missing') await rm(join(fixture.root, path));
    if (kind === 'wrong-path') {
      value.material_correction!.path = `runs/b/material-corrections/${correctionId()}.json`;
      await write('runs/a.json', value);
    }
    expect((await getRunDisclosure('a')).status).toBe('unverified');
  });

  it.each([
    { analysisStatus: 'stale' },
    { analysisInputFingerprint: digest('old input') },
    { runId: 'b' },
    { analysis: { risks: [null] } },
    { schema: 'not-the-material-context' },
  ])('does not treat malformed or stale material as unrestricted: %j', async (change) => {
    await run('a');
    await context('a', [], change);
    expect((await getRunDisclosure('a')).status).toBe('unverified');
  });

  it('uses only explicit legacy disclosure entries rather than examples and quoted material', async () => {
    const value = await run('a');
    value.steps.intake = { latest: 'pipeline/intake/a.md' };
    await write('runs/a.json', value);
    await rm(join(fixture.root, 'sessions/material-analysis/a.json'));
    await write(value.steps.intake.latest, '# 素材\n## 1. 摘录\n- 公开边界：本期仅供内部使用\n## 7. 不可公开信息\n- 使用限制：例如“本期不对外发布”时需要保留标记。\n- 公开边界：客户姓名不可公开\n## 9. 其他\n- 公开边界：本期不对外发布');
    expect(await getRunDisclosure('a')).toMatchObject({ status: 'restricted_details', restrictions: ['客户姓名不可公开'] });
    await write(value.steps.intake.latest, '# 素材\n## 7. 不可公开信息\n- 使用限制：例如“本期仅供内部使用”。\n');
    expect((await getRunDisclosure('a')).status).toBe('no_whole_draft_limit');
    await write(value.steps.intake.latest, '# 素材\n## 7. 不可公开信息\n- 公开边界：本期仅供内部使用\n');
    expect((await getRunDisclosure('a')).status).toBe('internal_only');
  });

  it('does not fall back to legacy material when the existing context is damaged', async () => {
    const value = await run('a');
    value.steps.intake = { latest: 'pipeline/intake/a.md' };
    await write('runs/a.json', value);
    await write(value.steps.intake.latest, '## 7. 不可公开信息\n- 公开边界：本期仅供内部使用');
    await write('sessions/material-analysis/a.json', '{}');
    expect((await getRunDisclosure('a')).status).toBe('unverified');
  });

  it('does not interpret a missing legacy disclosure section as clearance', async () => {
    const value = await run('a');
    value.steps.intake = { latest: 'pipeline/intake/a.md' };
    await write('runs/a.json', value);
    await rm(join(fixture.root, 'sessions/material-analysis/a.json'));
    await write(value.steps.intake.latest, '# A damaged intake without its disclosure section');
    expect((await getRunDisclosure('a')).status).toBe('unverified');
  });

  it('requires the scoped generation attempt to name its real run and record ID', async () => {
    await run('a', ['本期仅供内部使用']);
    await run('b');
    const id = `attempt_${'a'.repeat(32)}`;
    const path = `runs/a/content-attempts/${id}.json`;
    await write(path, { schema: 'echo.content-attempt.v1', runId: 'a', id, body: 'synthetic' });
    expect(await getOutputDisclosure(path)).toMatchObject({ status: 'internal_only', runId: 'a' });
    await write(path, { schema: 'echo.content-attempt.v1', runId: 'b', id });
    expect((await getOutputDisclosure(path)).status).toBe('unverified');
    await write(path, { schema: 'echo.content-attempt.v1', runId: 'a', id: 'wrong' });
    expect((await getOutputDisclosure(path)).status).toBe('unverified');
  });

  it.each(['', '../runs/a.json', '/pipeline/package/a.md', 'pipeline/../package/a.md', 'pipeline\\package\\a.md', 'pipeline//package/a.md', 'C:/pipeline/a.md', 'pipeline/package/a\u0000.md'])('rejects unsafe output path %j', async (path) => {
    await run('a');
    expect((await getOutputDisclosure(path)).status).toBe('unverified');
  });

  it('returns unverified for absent output, absent run and absent material records', async () => {
    const value = await run('a');
    expect((await getRunDisclosure('missing')).status).toBe('unverified');
    expect((await getRunDisclosure('../a')).status).toBe('unverified');
    await rm(join(fixture.root, value.steps.package.latest));
    expect((await getOutputDisclosure(value.steps.package.latest)).status).toBe('unverified');
    await rm(join(fixture.root, 'sessions/material-analysis/a.json'));
    expect((await getRunDisclosure('a')).status).toBe('unverified');
  });

  it.each(['output', 'output-parent', 'run', 'context', 'correction'] as const)('rejects %s symlinks using real filesystem checks', async (kind) => {
    const value = await run('a', ['本期仅供内部使用']);
    const correctionPath = await correct(value, ['本期不对外发布']);
    const path = kind === 'output' ? 'pipeline/package/a.md' : kind === 'output-parent' ? 'pipeline/package'
      : kind === 'run' ? 'runs/a.json' : kind === 'context' ? 'sessions/material-analysis/a.json' : correctionPath;
    const source = join(fixture.root, path);
    const moved = join(fixture.root, `synthetic-${kind}`);
    await rename(source, moved);
    await symlink(moved, source);
    expect((await getOutputDisclosure('pipeline/package/a.md')).status).toBe('unverified');
    if (kind !== 'output' && kind !== 'output-parent') expect((await getRunDisclosure('a')).status).toBe('unverified');
  });

  it.each(['run', 'material'] as const)('returns unverified when %s state keeps changing during an actual file read', async (kind) => {
    await run('a', ['本期仅供内部使用']);
    // A larger real context creates overlap without replacing the reader or fs.
    await context('a', ['本期仅供内部使用'], { localTestPadding: 'x'.repeat(4 * 1024 * 1024) });
    const changedPath = join(fixture.root, kind === 'run' ? 'runs/a.json' : 'sessions/material-analysis/a.json');
    const before = await readFile(changedPath, 'utf8');
    const value = JSON.parse(before) as Record<string, unknown>;
    let writing = true;
    let changes = 0;
    const writer = (async () => {
      while (writing) {
        const temporary = join(dirname(changedPath), '.changing.tmp');
        await writeFile(temporary, JSON.stringify({ ...value, updated_at: String(++changes) }));
        await rename(temporary, changedPath);
      }
    })();
    try {
      expect((await getRunDisclosure('a')).status).toBe('unverified');
    } finally { writing = false; await writer; }
    expect(changes).toBeGreaterThan(0);
    expect(await readFile(changedPath, 'utf8')).not.toBe(before);
  });
});
