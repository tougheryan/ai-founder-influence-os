import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutputDisclosure } from '@/lib/output-disclosure';
import { createHash } from 'node:crypto';

const mocks = vi.hoisted(() => ({
  files: new Map<string, Buffer>(),
  missingPaths: new Set<string>(),
  fileChanges: new Map<string, Buffer>(),
  fileReads: new Map<string, number>(),
  textReads: [] as string[],
  binaryReads: [] as string[],
  runtimeStep: null as string | null,
  runtimeWriteError: '',
  symlinkPaths: new Set<string>(),
  realPaths: new Map<string, string>(),
  disclosure: { status: 'no_whole_draft_limit', restrictions: [] } as OutputDisclosure,
  disclosurePaths: [] as string[],
  fileSize: 11,
  prepareCalls: [] as Array<Record<string, unknown>>,
  prepareFailure: false,
  receipt: null as { id: string; runId: string } | null,
  source: null as Buffer | null,
  secondSource: null as Buffer | null,
}));

vi.mock('fs/promises', () => ({
  lstat: async (path: string) => {
    if (mocks.missingPaths.has(path)) throw new Error('missing');
    return {
      isSymbolicLink: () => mocks.symlinkPaths.has(path),
      isDirectory: () => true,
      isFile: () => true,
    };
  },
  realpath: async (path: string) => mocks.realPaths.get(path) || path,
  readFile: async (path: string, encoding?: string) => {
    if (mocks.files.has(path)) {
      const count = (mocks.fileReads.get(path) || 0) + 1; mocks.fileReads.set(path, count);
      const bytes = count > 1 && mocks.fileChanges.has(path) ? mocks.fileChanges.get(path)! : mocks.files.get(path)!;
      return encoding ? bytes.toString('utf8') : bytes;
    }
    if (encoding) {
      mocks.textReads.push(path);
      return mocks.source?.toString('utf8') ?? `local:${path}`;
    }
    mocks.binaryReads.push(path);
    return mocks.binaryReads.length > 1 && mocks.secondSource ? mocks.secondSource : mocks.source ?? Buffer.from('local-proof');
  },
  stat: async (path: string) => ({ size: mocks.files.get(path)?.length ?? mocks.fileSize }),
}));

vi.mock('@/lib/output-disclosure', () => ({
  getOutputDisclosure: async (path: string) => {
    mocks.disclosurePaths.push(path);
    return mocks.disclosure;
  },
}));

vi.mock('@/lib/output-download-events', () => ({
  prepareOutputDownloadEvent: async (input: Record<string, unknown>) => {
    mocks.prepareCalls.push(input);
    if (mocks.prepareFailure) throw new Error('record storage failed');
    return mocks.receipt;
  },
}));

vi.mock('@/lib/project-init', () => ({
  ensureProjectInitialized: async () => undefined,
}));

vi.mock('@/lib/output-files', () => ({
  BASE_DIR: '/tmp/aifios-output',
  safeResolve: (base: string, target: string) => `${base}/${target}`,
}));

vi.mock('@/lib/pipeline-registry', () => ({
  getRuntimeStepByOutputPath: () => mocks.runtimeStep,
}));

vi.mock('@/lib/runtime-run-resolver', () => ({
  resolveRuntimeWriteTarget: async () => ({ runId: '', slug: '' }),
}));

vi.mock('@/lib/runtime-writer', () => ({
  validateRuntimeOutput: async () => null,
  writeRuntimeOutput: async () => {
    if (mocks.runtimeWriteError) throw new Error(mocks.runtimeWriteError);
    return '';
  },
}));

vi.mock('@/lib/input-limits', () => ({
  InputLimitError: class InputLimitError extends Error {},
  MAX_SHORT_TEXT_BYTES: 400,
  MAX_TEXT_ARTIFACT_BYTES: 1_000_000,
  assertOptionalTextInput: (value: unknown) => typeof value === 'string' ? value : '',
  assertTextInput: (value: unknown) => typeof value === 'string' ? value : '',
}));

vi.mock('@/lib/project-root', () => ({
  redactLocalPaths: <T>(value: T) => value,
}));

vi.mock('@/lib/write-guard', () => ({
  WriteLockError: class WriteLockError extends Error {},
  projectFileExists: async () => false,
  readIdempotentResult: async () => null,
  rememberIdempotentResult: async () => undefined,
  withProjectWriteLock: async <T>(_key: string, callback: () => Promise<T>) => callback(),
  writeFingerprint: () => 'fingerprint',
}));

import { GET, POST } from './route';

function request(path: string): Request {
  return new Request(`http://localhost/api/output/${path}`);
}

function params(path: string) {
  return { params: Promise.resolve({ path: path.split('/') }) };
}

describe('GET /api/output/[...path]', () => {
  beforeEach(() => {
    mocks.files = new Map(); mocks.fileChanges = new Map(); mocks.fileReads = new Map(); mocks.missingPaths = new Set();
    mocks.textReads = [];
    mocks.binaryReads = [];
    mocks.runtimeStep = null;
    mocks.runtimeWriteError = '';
    mocks.symlinkPaths = new Set();
    mocks.realPaths = new Map();
    mocks.disclosure = { status: 'no_whole_draft_limit', restrictions: [] };
    mocks.disclosurePaths = [];
    mocks.fileSize = 11;
    mocks.prepareCalls = []; mocks.prepareFailure = false; mocks.receipt = null;
    mocks.source = null; mocks.secondSource = null;
  });

  it('serves only the narrow local roots needed for weekly publication traceability', async () => {
    const proof = await GET(request('materials/publish-proof/moments-proof.png'), params('materials/publish-proof/moments-proof.png'));
    const evidence = await GET(request('materials/publish-evidence/moments-evidence.pdf'), params('materials/publish-evidence/moments-evidence.pdf'));
    const performance = await GET(request('materials/performance/2026-W30.json'), params('materials/performance/2026-W30.json'));
    const tikomni = await GET(request('materials/tikomni/raw/weekly-post.json'), params('materials/tikomni/raw/weekly-post.json'));
    const report = await GET(request('materials/weekly-review/2026-W30/weekly-review.md'), params('materials/weekly-review/2026-W30/weekly-review.md'));

    expect(proof.status).toBe(200);
    expect(proof.headers.get('content-type')).toContain('image/png');
    expect(evidence.status).toBe(200);
    expect(evidence.headers.get('content-type')).toContain('application/pdf');
    expect(performance.status).toBe(200);
    expect(tikomni.status).toBe(200);
    expect(report.status).toBe(200);
    expect(mocks.binaryReads).toEqual([
      '/tmp/aifios-output/materials/publish-proof/moments-proof.png',
      '/tmp/aifios-output/materials/publish-evidence/moments-evidence.pdf',
    ]);
    expect(mocks.textReads).toEqual([
      '/tmp/aifios-output/materials/performance/2026-W30.json',
      '/tmp/aifios-output/materials/tikomni/raw/weekly-post.json',
      '/tmp/aifios-output/materials/weekly-review/2026-W30/weekly-review.md',
    ]);
  });

  it('returns raw HTML with the browser content type', async () => {
    const relativePath = 'pipeline/visual/demo/publish/r001/wechat/wechat-article.html';
    const response = await GET(
      new Request(`http://localhost/api/output/${relativePath}?raw=1`),
      params(relativePath),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('content-security-policy')).not.toContain("script-src 'unsafe-inline'");
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).toBe(`local:/tmp/aifios-output/${relativePath}`);
  });

  it('rejects a symbolic link anywhere below the output root', async () => {
    const relativePath = 'pipeline/visual/demo/link/wechat-article.html';
    mocks.symlinkPaths.add('/tmp/aifios-output/pipeline/visual/demo/link');

    const response = await GET(request(relativePath), params(relativePath));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'output_path_not_allowed' });
    expect(mocks.textReads).toEqual([]);
  });

  it('marks raw HTML visibly while retaining the restrictive preview policy', async () => {
    mocks.disclosure = { status: 'internal_only', restrictions: ['只给内部 <script>review()</script> 看'] };
    const path = 'pipeline/visual/demo/article.html';
    const response = await GET(request(`${path}?raw=1`), params(path));
    const body = await response.text();
    expect(body).toContain('仅供内部预览');
    expect(body).toContain('&lt;script&gt;review()&lt;/script&gt;');
    expect(body).not.toContain('<script>review()');
    expect(body.endsWith(`local:/tmp/aifios-output/${path}`)).toBe(true);
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  describe('portable WeChat downloads', () => {
    const articlePath = 'pipeline/visual/demo/publish/r001/wechat/wechat-article.html';
    const imagePath = '/tmp/aifios-output/pipeline/visual/demo/publish/r001/inline/a.png';
    const absoluteArticle = `/tmp/aifios-output/${articlePath}`;
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jVxkAAAAASUVORK5CYII=', 'base64');
    const source = Buffer.from('<html><head><style>p{color:#123456}</style></head><body><p>虚构文章</p><img src="../inline/a.png"></body></html>');
    beforeEach(() => {
      mocks.files.set(absoluteArticle, source);
      mocks.files.set(imagePath, png);
    });
    it('embeds the image only in the exported copy, keeps restrictions and binds the receipt to original source bytes', async () => {
      mocks.disclosure = { status: 'internal_only', restrictions: ['不要对外发布测试内容'] };
      const response = await GET(request(`${articlePath}?download=1`), params(articlePath));
      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.toString()).toContain(`data:image/png;base64,${png.toString('base64')}`);
      expect(body.toString()).toContain('不要对外发布测试内容');
      expect(body.toString()).toContain('Content-Security-Policy');
      expect(response.headers.get('x-echo-download-bytes')).toBe(String(body.length));
      expect(mocks.prepareCalls[0]).toMatchObject({ source, output: body });
      expect(mocks.files.get(absoluteArticle)).toEqual(source);
      const raw = await GET(request(`${articlePath}?raw=1`), params(articlePath));
      expect(await raw.text()).toContain('../inline/a.png');
    });
    it.each(['missing', 'symlink', 'outside'] as const)('refuses %s image before preparing a download record', async (problem) => {
      if (problem === 'missing') mocks.missingPaths.add(imagePath);
      if (problem === 'symlink') mocks.symlinkPaths.add(imagePath);
      if (problem === 'outside') mocks.realPaths.set(imagePath, '/tmp/private/a.png');
      const response = await GET(request(`${articlePath}?download=1`), params(articlePath));
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: 'portable_article_unavailable' });
      expect(mocks.prepareCalls).toEqual([]);
      expect(response.headers.get('content-disposition')).toBeNull();
    });
    it.each(['article', 'image'])('refuses %s changed during assembly, keeping the failed download retryable', async (changed) => {
      const name = changed === 'article' ? absoluteArticle : imagePath;
      const replaced = Buffer.from(mocks.files.get(name)!); replaced[replaced.length - 1] ^= 1;
      mocks.fileChanges.set(name, replaced);
      const response = await GET(request(`${articlePath}?download=1`), params(articlePath));
      expect(response.status).toBe(409);
      expect(mocks.prepareCalls).toEqual([]);
    });
  });

  it('marks a downloaded copy without changing the default JSON editor response', async () => {
    mocks.disclosure = { status: 'internal_only', restrictions: ['本期仅内部使用'] };
    const path = 'pipeline/package/article.md';
    const read = await GET(request(path), params(path));
    expect((await read.json()).content).toBe(`local:/tmp/aifios-output/${path}`);
    expect(mocks.disclosurePaths).toEqual([]);
    const download = await GET(request(`${path}?download=1`), params(path));
    expect(await download.text()).toContain('仅供内部预览');
    expect(decodeURIComponent(download.headers.get('content-disposition') || '')).toContain('仅供内部预览');
    expect(download.headers.get('cache-control')).toBe('no-store');
    const reread = await GET(request(path), params(path));
    expect((await reread.json()).content).toBe(`local:/tmp/aifios-output/${path}`);
  });

  it('rechecks metadata for each copy lookup without reading the article into the response', async () => {
    const path = 'pipeline/package/article.md';
    const first = await GET(request(`${path}?disclosure=1`), params(path));
    expect((await first.json()).disclosure.status).toBe('no_whole_draft_limit');
    mocks.disclosure = { status: 'internal_only', restrictions: ['仅内部使用'] };
    const next = await GET(request(`${path}?disclosure=1`), params(path));
    expect((await next.json()).disclosure).toEqual(mocks.disclosure);
    expect(mocks.textReads).toEqual([]);
    expect(mocks.binaryReads).toEqual([]);
    expect(mocks.disclosurePaths).toEqual([path, path]);
    expect(next.headers.get('cache-control')).toBe('no-store');
  });

  it('keeps an unverified export local and includes the warning with binary bytes', async () => {
    mocks.disclosure = { status: 'unverified', restrictions: [] };
    const path = 'pipeline/visual/demo/卡片.png';
    const response = await GET(request(`${path}?download=1`), params(path));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    const archive = Buffer.from(await response.arrayBuffer());
    expect(archive.includes(Buffer.from('local-proof'))).toBe(true);
    expect(archive.includes(Buffer.from('公开限制待核对'))).toBe(true);
    expect(archive.includes(Buffer.from('使用说明.txt'))).toBe(true);
    expect(decodeURIComponent(response.headers.get('content-disposition') || '')).toContain('.zip');
  });

  it('rejects oversized downloads before allocating the file bytes', async () => {
    mocks.fileSize = 256 * 1024 * 1024 + 1;
    const path = 'pipeline/visual/demo/large.png';
    const response = await GET(request(`${path}?download=1`), params(path));
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('output_download_too_large');
    expect(mocks.binaryReads).toEqual([]);
  });

  it('rejects a target whose physical path resolves outside the output root', async () => {
    const relativePath = 'pipeline/visual/demo/wechat-article.html';
    mocks.realPaths.set(
      `/tmp/aifios-output/${relativePath}`,
      '/tmp/private/wechat-article.html',
    );

    const response = await GET(request(relativePath), params(relativePath));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'output_path_not_allowed' });
    expect(mocks.textReads).toEqual([]);
  });

  it('keeps neighboring materials folders and traversal attempts unreadable', async () => {
    const neighboringRoot = await GET(request('materials/publish-proof-archive/proof.png'), params('materials/publish-proof-archive/proof.png'));
    const traversal = await GET(request('materials/publish-proof/../publication-ledger.json'), params('materials/publish-proof/../publication-ledger.json'));

    expect(neighboringRoot.status).toBe(400);
    expect(traversal.status).toBe(400);
    expect(mocks.binaryReads).toEqual([]);
    expect(mocks.textReads).toEqual([]);
  });

  it('reports a missing topic-template prerequisite as a dependency block', async () => {
    mocks.runtimeStep = 'write';
    mocks.runtimeWriteError = '当前 runtime run 缺少思想母版蓝图，不能继续下游内容生产';

    const response = await POST(new Request('http://localhost/api/output/pipeline/final/topic.md', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '# 测试稿', versionLabel: 'test' }),
    }), params('pipeline/final/topic.md'));

    expect(response.status).toBe(424);
    expect(await response.json()).toMatchObject({ code: 'output_prerequisite_required' });
  });
  it('records only prepared download responses, never raw/editor/preview/disclosure reads', async () => {
    const path = 'pipeline/package/article.md';
    for (const query of ['', '?raw=1', '?preview=1', '?disclosure=1']) await GET(request(`${path}${query}`), params(path));
    expect(mocks.prepareCalls).toEqual([]);
    mocks.receipt = { id: '11111111-1111-4111-8111-111111111111', runId: '中文任务' };
    const response = await GET(request(`${path}?download=1`), params(path));
    expect(mocks.prepareCalls).toHaveLength(1);
    expect(mocks.prepareCalls[0].source).toEqual(Buffer.from('local-proof'));
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(mocks.prepareCalls[0].output).toEqual(bytes);
    expect(response.headers.get('x-echo-download-receipt')).toBe(mocks.receipt.id);
    expect(decodeURIComponent(response.headers.get('x-echo-download-run-id')!)).toBe('中文任务');
    expect(response.headers.get('x-echo-download-record')).toBe('prepared');
    expect(response.headers.get('x-echo-download-bytes')).toBe(String(bytes.length));
  });
  it('keeps the complete file available when recording fails or ownership is unavailable', async () => {
    const path = 'pipeline/package/article.md';
    mocks.prepareFailure = true;
    const failedRecord = await GET(request(`${path}?download=1`), params(path));
    expect(failedRecord.status).toBe(200);
    expect(await failedRecord.text()).toBe('local-proof');
    expect(failedRecord.headers.get('x-echo-download-record')).toBe('unavailable');
    expect(failedRecord.headers.get('x-echo-download-receipt')).toBeNull();
    mocks.prepareFailure = false;
    const unowned = await GET(request(`${path}?download=1`), params(path));
    expect(unowned.headers.get('x-echo-download-record')).toBe('unattributed');
    expect(await unowned.text()).toBe('local-proof');
  });
  it('does not prepare a receipt for rejected file responses', async () => {
    mocks.fileSize = 256 * 1024 * 1024 + 1;
    const path = 'pipeline/package/article.md';
    expect((await GET(request(`${path}?download=1`), params(path))).status).toBe(413);
    expect(mocks.prepareCalls).toEqual([]);
  });

  describe('separate publication fields', () => {
    const path = 'pipeline/package/native.md';
    const content = '## 2. 小红书原生图文\n### 发布正文\n- 标题：图文标题\n- 正文：第一段。\n\n第二段。\n- 结尾问题：你怎么看？\n### 结尾标签\n#原标签\n## 3. 视频号原生口播\n- 发布标题：视频标题\n### 逐句口播稿\n| 时间段 | 口播文案 | 屏幕字幕 | 对应画面 |\n|---|---|---|---|\n| 0-10秒 | 只复制要念的原话。 | 大字字幕 | 对照清单 |';
    const hash = createHash('sha256').update(content).digest('hex');
    const url = (field = 'xhs-body', suffix = '') => `${path}?publicationText=${field}&sha256=${hash}${suffix}`;
    beforeEach(() => { mocks.source = Buffer.from(content); mocks.fileSize = mocks.source.length; });

    it.each([
      ['xhs-title', '图文标题'], ['xhs-body', '第一段。\n\n第二段。\n\n你怎么看？\n\n#原标签'],
      ['video-title', '视频标题'], ['video-spoken', '只复制要念的原话。'],
    ])('extracts %s without instructions, preserving the source and keeping notices separate', async (field, expected) => {
      mocks.disclosure = { status: 'restricted_details', restrictions: ['客户代号：私密样本'] };
      const response = await GET(request(url(field)), params(path)); const result = await response.json();
      expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
      expect(result.text).toBe(expected); expect(result.text).not.toContain('私密样本');
      expect(result.notice).toContain('私密样本'); expect(result.previewText).toContain('私密样本');
      expect(result.sha256).toBe(hash); expect(result.field).toBe(field);
      expect(mocks.source?.toString()).toBe(content); expect(mocks.prepareCalls).toEqual([]);
    });
    it('changes the review token when author restrictions change, but not when selecting another field', async () => {
      const first = await (await GET(request(url()), params(path))).json();
      const title = await (await GET(request(url('xhs-title')), params(path))).json();
      expect(title.reviewToken).toBe(first.reviewToken);
      mocks.disclosure = { status: 'internal_only', restrictions: ['仅内部使用'] };
      const changed = await (await GET(request(url()), params(path))).json();
      expect(changed.reviewToken).not.toBe(first.reviewToken); expect(changed.disclosureStatus).toBe('internal_only');
    });
    it('rejects a stale source and a source replaced while resolving restrictions', async () => {
      expect((await GET(request(url().replace(hash, '0'.repeat(64))), params(path))).status).toBe(409);
      mocks.binaryReads = []; mocks.secondSource = Buffer.from(content + '\n变化');
      expect((await GET(request(url()), params(path))).status).toBe(409);
    });
    it.each(['&download=1', '&raw=1', '&readable=article', '&disclosure=1', '&preview=1'])('rejects conflicting export modes (%s)', async (suffix) => {
      expect((await GET(request(url('xhs-body', suffix)), params(path))).status).toBe(400);
    });
    it('rejects malformed spoken tables and unknown field names', async () => {
      expect((await GET(request(url('other')), params(path))).status).toBe(400);
      mocks.source = Buffer.from(content.replace('| 口播文案 |', '| 未知 |'));
      const current = createHash('sha256').update(mocks.source).digest('hex');
      expect((await GET(request(url('video-spoken').replace(hash, current)), params(path))).status).toBe(422);
    });
  });

  describe('reader article copies', () => {
    const path = 'pipeline/package/article.md';
    const content = '---\nslug: internal-value\n---\n## 0. 共享事实底稿\n- 本期平台：公众号\n## 1. 公众号原生长文\n- 发布标题：文章标题\n- 摘要：文章摘要\n- 排版提示：内部排版要求\n### 正文\n#### 小标题\n真正的正文。\n\n最后一段。\n### 评论区承接\n不要导出这个字段';
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const href = (suffix = '') => `${path}?readable=article&sha256=${hash(mocks.source!)}${suffix}`;
    beforeEach(() => { mocks.source = Buffer.from(content); mocks.fileSize = mocks.source.length; });

    it.each(['no_whole_draft_limit', 'internal_only', 'restricted_details', 'unverified'] as const)('copies extracted text with current %s disclosure and no download receipt', async (status) => {
      mocks.disclosure = { status, restrictions: status === 'no_whole_draft_limit' ? [] : ['不能公开客户姓名'] };
      const response = await GET(request(href()), params(path));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.sha256).toBe(hash(mocks.source!));
      expect(body.text).toContain('文章标题\n\n摘要\n文章摘要\n\n小标题\n真正的正文。\n\n最后一段。');
      expect(body.text).toContain('文章草稿');
      expect(body.text).not.toMatch(/slug|internal-value|共享事实|内部排版要求|不要导出这个字段/);
      if (status !== 'no_whole_draft_limit') expect(body.text).toContain('不能公开客户姓名');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(mocks.prepareCalls).toEqual([]);
      expect((await (await GET(request(path), params(path))).json()).content).toBe(content);
    });

    it('downloads readable HTML bound to original source bytes, not the extracted copy', async () => {
      mocks.disclosure = { status: 'internal_only', restrictions: ['本期仅内部使用 <script>alert(1)</script>'] };
      mocks.receipt = { id: '11111111-1111-4111-8111-111111111111', runId: 'run-a' };
      const response = await GET(request(href('&download=1')), params(path));
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/html');
      expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect(decodeURIComponent(response.headers.get('content-disposition')!)).toContain('文章标题-草稿（仅供内部预览）.html');
      expect(bytes.toString()).toContain('<h1>文章标题</h1>');
      expect(bytes.toString()).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(bytes.toString()).not.toMatch(/<script>|slug|共享事实|不要导出/);
      expect(mocks.prepareCalls[0]).toMatchObject({ source: Buffer.from(content), output: bytes, path });
      expect(response.headers.get('x-echo-download-bytes')).toBe(String(bytes.length));
    });

    it('fails on a stale page or a source replaced during the current restriction lookup', async () => {
      const stale = await GET(request(`${path}?readable=article&sha256=${'0'.repeat(64)}`), params(path));
      expect(stale.status).toBe(409);
      expect(mocks.disclosurePaths).toEqual([]);
      mocks.binaryReads = [];
      mocks.secondSource = Buffer.from(content.replace('最后一段', '已修改的一段'));
      expect((await GET(request(href('&download=1')), params(path))).status).toBe(409);
      expect(mocks.prepareCalls).toEqual([]);
    });

    it.each(['readable=unknown', 'readable=article', `readable=article&sha256=${'a'.repeat(64)}&raw=1`, `readable=article&sha256=${'a'.repeat(64)}&disclosure=1`])('rejects unsupported or incomplete queries: %s', async (query) => {
      expect((await GET(request(`${path}?${query}`), params(path))).status).toBe(400);
      expect(mocks.binaryReads).toEqual([]);
    });

    it('refuses non-package files and retains path protections', async () => {
      const other = 'quality/audit.md';
      expect((await GET(request(`${other}?readable=article&sha256=${hash(mocks.source!)}`), params(other))).status).toBe(400);
      mocks.symlinkPaths.add('/tmp/aifios-output/pipeline/package');
      expect((await GET(request(href()), params(path))).status).toBe(400);
      expect(mocks.binaryReads).toEqual([]);
    });

    it.each(['oversized', 'growth', 'encoding', 'missing-body', 'duplicate-body'] as const)('does not return raw content when the source is %s', async (scenario) => {
      if (scenario === 'oversized') mocks.fileSize = 1_000_001;
      if (scenario === 'growth') mocks.source = Buffer.alloc(1_000_001, 97);
      if (scenario === 'encoding') mocks.source = Buffer.from([0xff, 0xfe]);
      if (scenario === 'missing-body') mocks.source = Buffer.from('内部信息，缺少正文');
      if (scenario === 'duplicate-body') mocks.source = Buffer.from(content.replace('### 评论区承接', '### 正文'));
      const response = await GET(request(href('&download=1')), params(path));
      expect(response.status).toBe(['oversized', 'growth'].includes(scenario) ? 413 : 422);
      expect(response.headers.get('content-disposition')).toBeNull();
      expect((await response.json()).code).toBe('readable_article_unavailable');
      expect(mocks.prepareCalls).toEqual([]);
    });
  });

});
