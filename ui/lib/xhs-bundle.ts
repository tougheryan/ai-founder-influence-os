import 'server-only';
import { secureReadProjectFile } from '@/electron/publication-authority.cjs';
import { PROJECT_DIR } from './project-root';
import { contentSections } from './content-editing';
import { readerFieldText, readerTableRows, uniqueReaderSection } from './content-reader-bindings';
import { getOutputDisclosure } from './output-disclosure';
import { markExportText } from './output-disclosure-format';
import { MAX_OUTPUT_DOWNLOAD_BYTES, prepareOutputBundle } from './output-export';
import { validateVisualRevisionArtifacts } from './visual-workbench';

const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_COPY_BYTES = 8 * 1024 * 1024;
const changedMessage = '原稿或已选成品发生变化，请刷新并重新核对后下载。';
export class XhsBundleError extends Error {
  constructor(message: string, readonly status = 409) { super(message); this.name = 'XhsBundleError'; }
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(object) : []; }
const clean = (value: string) => value.replace(/\s+/g, ' ').trim();

/** Use the same full-field reader as the editor, including all body paragraphs. */
export function xhsBundleCopy(markdown: string) {
  const visible = markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  if (/^[ \t]*(`{3,}|~{3,})/m.test(visible)) throw new XhsBundleError('发布文案含有无法确定用途的代码块，请先核对正文。');
  const sections = contentSections(visible);
  const section = (name: string) => uniqueReaderSection(sections, `xhs:${name}`);
  const publish = section('发布正文')?.text || '';
  const title = readerFieldText(publish, '标题');
  const body = readerFieldText(publish, '正文');
  const question = readerFieldText(publish, '结尾问题');
  const tags = section('结尾标签')?.text || '';
  const cover = ['主句', '副句', '补充句'].map((field) => readerFieldText(section('封面三句话')?.text || '', field));
  const pages = readerTableRows(section('图文卡片脚本'));
  if (!title || !body || !tags || cover.some((value) => !value) || pages.length !== 8
    || pages.some((row, index) => row['页码']?.text !== `P${index + 1}` || !row['页面标题']?.text || !row['页面正文']?.text)) {
    throw new XhsBundleError('这份原稿的发布文案或八张卡片不完整，请返回正文核对后重新生成排版。');
  }
  return {
    title,
    text: `标题\n${title}\n\n正文\n${body}${question ? `\n\n结尾问题\n${question}` : ''}\n\n标签\n${tags}\n`,
    expectedCopy: pages.map((row, index) => [...(index === 0 ? cover : []), row['页面标题'].text, row['页面正文'].text].map(clean).join(' ')),
  };
}

/** Download only the exact adopted native set the user saw, with its current source. */
export async function prepareXhsBundle(input: { slug: string; post: string; selection: string }) {
  if (!/^[a-z0-9\u4e00-\u9fff-]{1,50}$/i.test(input.slug) || input.post !== '1' || !HASH.test(input.selection)) {
    throw new XhsBundleError('整套下载参数不正确，请从已选成品重新打开。', 400);
  }
  const root = `pipeline/visual/${input.slug}`;
  const snapshots = new Map<string, { sha256: string; maxBytes: number }>();
  async function read(path: string, maxBytes = MAX_RECORD_BYTES) {
    try {
      const file = await secureReadProjectFile(PROJECT_DIR, path, { maxBytes });
      const previous = snapshots.get(path);
      if (previous && previous.sha256 !== file.sha256) throw new XhsBundleError(changedMessage);
      snapshots.set(path, { sha256: file.sha256, maxBytes });
      return file;
    } catch (error) {
      if (error instanceof XhsBundleError) throw error;
      throw new XhsBundleError('有成品文件缺失、过大或已经变动，请重新生成排版后下载。');
    }
  }
  async function json(path: string) {
    const file = await read(path);
    try { return object(JSON.parse(file.buffer.toString('utf8'))); }
    catch { throw new XhsBundleError('成品记录无法读取，请重新生成排版后下载。'); }
  }
  const selectionPath = `${root}/selected-assets.json`;
  const selection = await json(selectionPath);
  const source = (await read(selectionPath)).buffer;
  if (snapshots.get(selectionPath)?.sha256 !== input.selection) throw new XhsBundleError(changedMessage);
  if (selection.schema !== 'aifios.visual-asset-manifest.v1' || selection.slug !== input.slug
    || typeof selection.sourceContentHash !== 'string' || !HASH.test(selection.sourceContentHash)) throw new XhsBundleError(changedMessage);
  const ids = Array.from({ length: 8 }, (_, index) => `xhs-01-p${index + 1}`);
  const selections = object(selection.selections);
  const adopted = ids.map((id) => object(selections[id]));
  if (adopted.some((asset, index) => asset.assetId !== ids[index] || asset.semanticRole !== ids[index]
    || !Array.isArray(asset.platformBindings) || !asset.platformBindings.includes('xiaohongshu')
    || typeof asset.sha256 !== 'string' || !HASH.test(asset.sha256))) {
    throw new XhsBundleError('尚未选齐八张卡片，请先选择一整套成品。');
  }
  const revision = adopted[0].revisionId;
  if (typeof revision !== 'string' || !/^r\d{3,}$/.test(revision) || adopted.some((asset) => asset.revisionId !== revision)) {
    throw new XhsBundleError('已选卡片来自多个排版版本，请先选择一整套成品再下载。');
  }
  const recipePath = `${root}/recipes/${revision}.visual-recipe.json`;
  const indexPath = `${root}/revisions/${revision}.index.json`;
  const recipe = await json(recipePath);
  const index = await json(indexPath);
  if (typeof recipe.source_package !== 'string' || !/^pipeline\/package\/[^/\\]+\.md$/.test(recipe.source_package)
    || index.source_package !== recipe.source_package) throw new XhsBundleError(changedMessage);
  if (index.platform_delivery_manifest !== `${root}/publish/${revision}/platform-delivery.json`) throw new XhsBundleError(changedMessage);
  const delivery = await json(index.platform_delivery_manifest as string);
  if (delivery.source_package !== recipe.source_package) throw new XhsBundleError(changedMessage);
  const validation = await validateVisualRevisionArtifacts(input.slug, revision);
  if (!validation.valid) throw new XhsBundleError('这套成品的文件或版面检查未通过，请重新生成排版后下载。');
  const original = await read(recipe.source_package, MAX_COPY_BYTES);
  if (original.sha256 !== selection.sourceContentHash) throw new XhsBundleError(changedMessage);
  const disclosure = await getOutputDisclosure(selectionPath);
  if (disclosure.status === 'unverified' || !disclosure.runId || !disclosure.fingerprint) {
    throw new XhsBundleError('暂时无法核对这套成品所属的原稿和使用限制，请刷新后重试。');
  }
  const run = await json(`runs/${disclosure.runId}.json`);
  if (run.slug !== input.slug || object(object(run.steps).package).latest !== recipe.source_package) throw new XhsBundleError(changedMessage);
  const copy = xhsBundleCopy(original.buffer.toString('utf8'));
  const entries: { name: string; bytes: Buffer }[] = [];
  let totalBytes = 0;
  const outputs = rows(index.outputs);
  for (let page = 0; page < 8; page++) {
    const matches = outputs.filter((output) => output.id === ids[page]);
    const output = matches[0] || {};
    if (matches.length !== 1 || output.output !== adopted[page].path || output.sha256 !== adopted[page].sha256
      || typeof output.output !== 'string' || !output.output.startsWith(`${root}/publish/${revision}/xhs/post-01/`)
      || !/\.png$/i.test(output.output) || output.source !== recipe.source_package
      || object(output.copy_fidelity).status !== 'pass' || output.expected_text !== copy.expectedCopy[page]) {
      throw new XhsBundleError(`P${page + 1} 与这份原稿的文字或已选记录不一致，请重新生成并选择整套成品。`);
    }
    const image = await read(output.output, MAX_OUTPUT_DOWNLOAD_BYTES - totalBytes);
    if (image.sha256 !== output.sha256 || image.buffer.length !== output.size) throw new XhsBundleError(changedMessage);
    totalBytes += image.buffer.length;
    if (totalBytes >= MAX_OUTPUT_DOWNLOAD_BYTES) throw new XhsBundleError('整套图片超过 256MB，请分别下载。', 413);
    entries.push({ name: `P${page + 1}.png`, bytes: image.buffer });
  }
  // The copy carries the use status, but confidential restriction quotes stay in the separate readme.
  entries.push({ name: '发布文案.txt', bytes: Buffer.from(markExportText(copy.text, '.txt', { ...disclosure, restrictions: [] })) });
  const result = prepareOutputBundle(entries, `${copy.title}-小红书图文.zip`, disclosure,
    '文件顺序：P1.png 为封面，P2.png 至 P8.png 按页码排列。\n发布文案.txt 包含同一原稿的标题、完整正文、结尾问题和标签。\n解压后按 P1 至 P8 选择图片，核对文字与图片，再决定是否发布。下载不会发布内容，也不会调用模型或排版服务。');
  async function assertUnchanged() {
    for (const [path, snapshot] of snapshots) await read(path, snapshot.maxBytes);
    const current = await getOutputDisclosure(selectionPath);
    if (current.status !== disclosure.status || current.runId !== disclosure.runId || current.fingerprint !== disclosure.fingerprint) throw new XhsBundleError(changedMessage);
  }
  await assertUnchanged();
  return { ...result, path: selectionPath, source, disclosure, assertUnchanged };
}
