const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const test = require('node:test');
const { internalOnlyRestrictions, intakeDisclosureEntries, classifyDisclosureEntries } = require('./material-disclosure.cjs');
const { readPublicationRestrictions, sha256 } = require('./publication-authority.cjs');

for (const value of ['不对外发布', '仅内部使用', '公开边界：【模拟验收材料，不是真实客户案例，不对外发布】我想写给服务型小团队负责人', '本期内容仅供内部预览', '这篇文章暂不发布', '整份内容不得公开']) {
  test(`retains explicit whole-draft limit: ${value}`, () => assert.deepEqual(internalOnlyRestrictions([value]), [value]));
}
for (const value of ['客户姓名不对外发布', '不要公开客户姓名和聊天记录', '客户姓名和聊天记录，仅供内部使用', '参考材料，仅供内部参考', '这些合同仅供内部讨论', '参考资料已通过 TikOmni 读取公开内容，仅作本期内部参考。', '未经核验的数据不可作为事实', '不要把“不对外发布”写进正文', '本期内容可以发布', '本期无需限制公开', '不编造收入，结尾不增加私信引导']) {
  test(`does not infer a whole-draft ban: ${value}`, () => assert.deepEqual(internalOnlyRestrictions([value]), []));
}

test('legacy intake reads restrictions without treating generic instructional examples as author limits', () => {
  const report = '## 7. 不可公开信息\n- 公开边界：不对外发布\n- 使用限制：继续写作不代表授权公开；整份内容标为仅供内部或不对外发布时，仅供内部预览。\n\n## 9. 素材质量判断\n- 仅内部使用\n';
  assert.deepEqual(internalOnlyRestrictions(intakeDisclosureEntries(report)), ['- 公开边界：不对外发布']);
});

for (const value of [
  '以上为作者观察和判断，尚未提供个人经历、具体行业案例或量化数据。请区分观点与待核验事实，不要编造作者身份、亲身经历、行业案例、数字或引用。',
  '请不要虚构案例和数字。未经核验的数据不可作为事实。',
  '不要编造引用；请区分作者观点与事实。',
]) {
  test(`keeps writing-only guidance separate from disclosure: ${value}`, () => {
    const input = Object.freeze([value]);
    assert.deepEqual(classifyDisclosureEntries(input), { writingRequirements: [value], restrictions: [], unresolved: [] });
    assert.deepEqual(input, [value]);
  });
}

for (const value of [
  '客户姓名不能公开', '需要先取得授权', '请先隐去客户姓名',
  '不要编造案例。客户姓名不可公开。',
  '不要编造数字；本期仅供内部使用。',
  '请区分观点与待核验事实，需要先取得客户同意。',
  '不要编造引用，未经授权不得发布。',
]) {
  test(`retains real and mixed disclosure conditions verbatim: ${value}`, () => {
    assert.deepEqual(classifyDisclosureEntries([value]), { writingRequirements: [], restrictions: [value], unresolved: [] });
  });
}

for (const value of [
  '请注意使用范围', '需要先和相关人员确认',
  '不要编造案例之外的部分另有约定',
  '以上为作者观察和判断，不要编造案例；This draft is confidential.',
  '不要把“不对外发布”写进正文',
]) {
  test(`never clears ambiguous text because it contains a writing phrase: ${value}`, () => {
    const classified = classifyDisclosureEntries([value]);
    assert.deepEqual(classified.writingRequirements, []);
    assert.deepEqual([...classified.restrictions, ...classified.unresolved], [value]);
  });
}

test('reads the current author correction, validates ownership and digest, and refuses stale source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'echo-disclosure-'));
  const write = async (path, data) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), typeof data === 'string' ? data : JSON.stringify(data)); };
  try {
    const context = { schema: 'aifios.material-analysis.v1', runId: 'run-a', analysisStatus: 'current', inputFingerprint: 'a'.repeat(64), analysisInputFingerprint: 'a'.repeat(64), analysis: { risks: ['不对外发布'] } };
    const run = { run_id: 'run-a', steps: { intake: { latest: 'pipeline/intake/a.md' } } };
    await write('sessions/material-analysis/run-a.json', context);
    const initial = await readPublicationRestrictions(root, run);
    assert.equal(initial.restrictions.length, 1);
    const id = `correction_${'c'.repeat(32)}`;
    const path = `runs/run-a/material-corrections/${id}.json`;
    const record = { schema: 'echo.material-correction.v1', run_id: 'run-a', id, input_fingerprint: context.inputFingerprint, analysis: { risks: ['客户姓名不对外发布'] } };
    const raw = JSON.stringify(record);
    await write(path, raw);
    run.material_correction = { id, path, sha256: sha256(raw) };
    const changed = await readPublicationRestrictions(root, run);
    assert.deepEqual(changed.restrictions, []);
    assert.equal(changed.correctionId, id);
    assert.notEqual(changed.sha256, initial.sha256);
    await write(path, JSON.stringify({ ...record, run_id: 'run-b' }));
    await assert.rejects(readPublicationRestrictions(root, run), (error) => error.code === 'material_disclosure_unavailable');
    await write(path, raw);
    await write('sessions/material-analysis/run-a.json', { ...context, analysisStatus: 'stale' });
    await assert.rejects(readPublicationRestrictions(root, run), (error) => error.code === 'material_disclosure_unavailable');
    await write('sessions/material-analysis/run-a.json', { ...context, runId: 'run-b' });
    await assert.rejects(readPublicationRestrictions(root, run), (error) => error.code === 'material_disclosure_unavailable');
    await write('sessions/material-analysis/run-a.json', '{broken');
    await assert.rejects(readPublicationRestrictions(root, run), (error) => error.code === 'material_disclosure_unavailable');
    await rm(join(root, 'sessions/material-analysis/run-a.json'));
    await assert.rejects(readPublicationRestrictions(root, run), (error) => error.code === 'material_disclosure_unavailable');
    delete run.material_correction;
    await write('pipeline/intake/a.md', '## 7. 不可公开信息\n- 公开边界：仅内部使用\n\n## 9. 素材质量判断\n');
    assert.equal((await readPublicationRestrictions(root, run)).restrictions.length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
