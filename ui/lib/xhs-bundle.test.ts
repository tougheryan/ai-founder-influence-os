import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ root: `/tmp/echo-xhs-bundle-${process.pid}`, disclosure: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('./project-root', async () => {
  const p = await import('node:path');
  return { PROJECT_DIR: mocks.root, runtimeJoin: (...parts: string[]) => p.join(...parts),
    safeResolve: (base: string, relative: string) => { const target = p.resolve(base, relative); return target.startsWith(`${base}/`) ? target : null; } };
});
vi.mock('./output-disclosure', () => ({ getOutputDisclosure: mocks.disclosure }));
import { prepareXhsBundle, xhsBundleCopy } from './xhs-bundle';
import { prepareOutputBundle } from './output-export';

const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const root = 'pipeline/visual/demo';
const selectionPath = `${root}/selected-assets.json`;
const indexPath = `${root}/revisions/r001.index.json`;
const recipePath = `${root}/recipes/r001.visual-recipe.json`;
const packagePath = 'pipeline/package/demo.md';
const ids = Array.from({ length: 8 }, (_, index) => `xhs-01-p${index + 1}`);
const imagePath = (index: number) => `${root}/publish/r001/xhs/post-01/${index + 1}.png`;
const markdown = `# 手写虚构测试\n## 0. 共享事实底稿\n内部信息不进入文案\n## 2. 小红书原生图文
### 封面三句话
- 主句：封面第一句
- 副句：封面第二句
- 补充句：虚构练习
### 图文卡片脚本
| 页码 | 页面标题 | 页面正文 | 视觉提示 |
| --- | --- | --- | --- |
${ids.map((_, index) => `| P${index + 1} | 第${index + 1}张 | 完整文字${index + 1} | 内部画图提示 |`).join('\n')}
### 发布正文
- 标题：虚构测试标题
- 正文：第一段。

第二段，不能遗漏。

第三段，完整保留。
- 结尾问题：你怎么看？
### 结尾标签
#虚构练习 #完整交付
## 3. 视频号原生口播
### 发布文案
- 简介：视频内容不能混进小红书
`;

async function write(relative: string, value: string | Buffer) {
  await mkdir(path.dirname(path.join(mocks.root, relative)), { recursive: true });
  await writeFile(path.join(mocks.root, relative), value);
}
async function json(relative: string, value: unknown) { await write(relative, JSON.stringify(value)); }
async function mutate(relative: string, change: (value: Record<string, any>) => void) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const value = JSON.parse(await readFile(path.join(mocks.root, relative), 'utf8')); change(value); await json(relative, value);
}
async function input() { return { slug: 'demo', post: '1', selection: hash(await readFile(path.join(mocks.root, selectionPath))) }; }
function extract(bytes: Buffer): Record<string, string> {
  return JSON.parse(execFileSync('python3', ['-c', 'import zipfile,io,json,sys,base64; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps({n:base64.b64encode(z.read(n)).decode() for n in z.namelist()}))'], { input: bytes }).toString());
}
beforeEach(async () => {
  await rm(mocks.root, { recursive: true, force: true });
  mocks.disclosure.mockReset().mockResolvedValue({ status: 'restricted_details', restrictions: ['测试限制：不要公开客户姓名'], runId: 'run-demo', fingerprint: 'b'.repeat(64) });
  await write(packagePath, markdown);
  await json('runs/run-demo.json', { slug: 'demo', steps: { package: { latest: packagePath } } });
  await json(recipePath, { schema: 'aifios.visual-recipe.v2', slug: 'demo', revision_id: 'r001', source_package: packagePath, assets: ids.map((id) => ({ id, platform: 'xhs' })) });
  const copy = xhsBundleCopy(markdown);
  const outputs = [];
  const selections: Record<string, unknown> = {};
  for (let index = 0; index < 8; index++) {
    const bytes = Buffer.from(`unit fixture image ${index}`);
    await write(imagePath(index), bytes);
    outputs.push({ id: ids[index], renderer: 'local', status: 'generated', quality: 'pass', revision_id: 'r001', recipe_path: recipePath,
      output: imagePath(index), source: packagePath, sha256: hash(bytes), size: bytes.length, expected_text: copy.expectedCopy[index], copy_fidelity: { status: 'pass' } });
    selections[ids[index]] = { assetId: ids[index], semanticRole: ids[index], revisionId: 'r001', path: imagePath(index), sha256: hash(bytes), platformBindings: ['xiaohongshu'] };
  }
  await json(selectionPath, { schema: 'aifios.visual-asset-manifest.v1', slug: 'demo', sourceContentHash: hash(markdown), requiredRoles: ids, selections });
  await json(indexPath, { schema: 'aifios.visual-publish.v1', slug: 'demo', revision_id: 'r001', status: 'generated', legacy: false, source_package: packagePath,
    recipe_path: recipePath, revision_index_path: indexPath, quality_summary: { status: 'pass', errors: [] }, outputs,
    platform_delivery_manifest: `${root}/publish/r001/platform-delivery.json` });
  await json(`${root}/publish/r001/platform-delivery.json`, { schema: 'echo-founder.platform-visual-delivery.v2', slug: 'demo', revision_id: 'r001', source_package: packagePath });
});
afterAll(async () => { await rm(mocks.root, { recursive: true, force: true }); });

describe('adopted Xiaohongshu bundle', () => {
  it('makes one valid ZIP with eight ordered original files, full publishing copy and separate restrictions', async () => {
    const result = await prepareXhsBundle(await input());
    const entries = extract(result.body);
    expect(Object.keys(entries)).toEqual([...ids.map((_, index) => `P${index + 1}.png`), '发布文案.txt', '使用说明.txt']);
    for (let index = 0; index < 8; index++) expect(Buffer.from(entries[`P${index + 1}.png`], 'base64')).toEqual(await readFile(path.join(mocks.root, imagePath(index))));
    const copy = Buffer.from(entries['发布文案.txt'], 'base64').toString();
    expect(copy).toContain('第一段。\n\n第二段，不能遗漏。\n\n第三段，完整保留。');
    expect(copy).toContain('你怎么看？'); expect(copy).toContain('#虚构练习');
    expect(copy).not.toMatch(/内部信息|内部画图提示|视频内容|测试限制/);
    expect(copy).toContain('含局部公开限制');
    expect(Buffer.from(entries['使用说明.txt'], 'base64').toString()).toContain('测试限制：不要公开客户姓名');
    expect(result.fileName).toContain('含局部公开限制');
    expect(await readFile(path.join(mocks.root, packagePath), 'utf8')).toBe(markdown);
    await result.assertUnchanged();
  });

  it.each(['missing', 'changed', 'symlink'] as const)('refuses a %s page', async (mode) => {
    if (mode === 'changed') await write(imagePath(4), 'changed');
    else { await rm(path.join(mocks.root, imagePath(4))); if (mode === 'symlink') await symlink(path.join(mocks.root, imagePath(3)), path.join(mocks.root, imagePath(4))); }
    await expect(prepareXhsBundle(await input())).rejects.toThrow('检查未通过');
  });
  it('refuses an old browser selection after adoption changes', async () => {
    const before = await input(); await mutate(selectionPath, (value) => { value.updatedAt = 'changed'; });
    await expect(prepareXhsBundle(before)).rejects.toThrow('发生变化');
  });
  it('refuses mixed revisions', async () => {
    await mutate(selectionPath, (value) => { value.selections[ids[3]].revisionId = 'r002'; });
    await expect(prepareXhsBundle(await input())).rejects.toThrow('多个排版版本');
  });
  it.each(['path', 'sha256', 'missing'] as const)('refuses a selection with wrong %s', async (field) => {
    await mutate(selectionPath, (value) => { if (field === 'missing') delete value.selections[ids[3]]; else value.selections[ids[3]][field] = field === 'path' ? 'pipeline/visual/another/x.png' : 'a'.repeat(64); });
    await expect(prepareXhsBundle(await input())).rejects.toThrow();
  });
  it('refuses a changed source even when its filename stays the same', async () => {
    await write(packagePath, markdown + '\n正文变了');
    await expect(prepareXhsBundle(await input())).rejects.toThrow('发生变化');
  });
  it('refuses an old package after the run switches to a newer one', async () => {
    await mutate('runs/run-demo.json', (value) => { value.steps.package.latest = 'pipeline/package/new.md'; });
    await expect(prepareXhsBundle(await input())).rejects.toThrow('发生变化');
  });
  it('refuses selected images whose text no longer matches even if someone updates the source hash', async () => {
    const text = markdown.replace('完整文字4', '改写后的正文4'); await write(packagePath, text);
    await mutate(selectionPath, (value) => { value.sourceContentHash = hash(text); });
    await expect(prepareXhsBundle(await input())).rejects.toThrow('P4');
  });
  it('refuses blocked quality and legacy unverified text', async () => {
    await mutate(indexPath, (value) => { value.quality_summary.status = 'blocked'; });
    await expect(prepareXhsBundle(await input())).rejects.toThrow('检查未通过');
    await mutate(indexPath, (value) => { value.quality_summary.status = 'pass'; delete value.outputs[0].copy_fidelity; });
    await expect(prepareXhsBundle(await input())).rejects.toThrow('P1');
  });
  it('keeps internal-only restrictions on both the archive and the publishing text', async () => {
    mocks.disclosure.mockResolvedValue({ status: 'internal_only', restrictions: ['整期只供内部'], runId: 'run-demo', fingerprint: 'b'.repeat(64) });
    const result = await prepareXhsBundle(await input()); expect(result.fileName).toContain('仅供内部预览');
    expect(Buffer.from(extract(result.body)['发布文案.txt'], 'base64').toString()).toContain('仅供内部预览');
  });
  it('stops if ownership or restrictions cannot be verified', async () => {
    mocks.disclosure.mockResolvedValue({ status: 'unverified', restrictions: [] });
    await expect(prepareXhsBundle(await input())).rejects.toThrow('暂时无法核对');
  });
  it.each(['image', 'package', 'selection', 'index', 'restriction'] as const)('rechecks %s before handing the archive to the browser', async (field) => {
    const result = await prepareXhsBundle(await input());
    if (field === 'restriction') mocks.disclosure.mockResolvedValue({ ...result.disclosure, fingerprint: 'c'.repeat(64) });
    else await write(field === 'image' ? imagePath(7) : field === 'package' ? packagePath : field === 'index' ? indexPath : selectionPath, 'changed');
    await expect(result.assertUnchanged()).rejects.toThrow('发生变化');
  });
  it('rejects traversal and unsupported legacy post indices', async () => {
    for (const changes of [{ slug: '../demo' }, { post: '2' }, { selection: 'bad' }]) await expect(prepareXhsBundle({ ...await input(), ...changes })).rejects.toThrow('参数不正确');
  });
});

describe('complete publishing fields', () => {
  it.each([markdown.replace('P8 |', 'P7 |'), markdown + '\n## 2. 小红书原生图文\n### 发布正文\n- 标题：重复\n- 正文：另一段', markdown.replace('### 结尾标签', '### 非标签')])('refuses ambiguous or incomplete copy', (text) => {
    expect(() => xhsBundleCopy(text)).toThrow('不完整');
  });
  it('never treats comment headings as publishing copy', () => {
    expect(xhsBundleCopy('<!--\n## 2. 小红书原生图文\n### 发布正文\n- 正文：隐藏\n-->\n' + markdown).text).not.toContain('隐藏');
  });
  it('bounds archive totals, including ZIP overhead, before allocation', () => {
    const bytes = { length: 256 * 1024 * 1024 } as Buffer;
    expect(() => prepareOutputBundle([{ name: 'P1.png', bytes }], '测试.zip', { status: 'no_whole_draft_limit', restrictions: [] }, '')).toThrow('超过 256MB');
  });
});
