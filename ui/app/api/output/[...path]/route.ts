import { NextResponse } from 'next/server';
import { lstat, readFile, realpath, stat } from 'fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ensureProjectInitialized } from '@/lib/project-init';
import { BASE_DIR, safeResolve } from '@/lib/output-files';
import { getRuntimeStepByOutputPath } from '@/lib/pipeline-registry';
import { resolveRuntimeWriteTarget } from '@/lib/runtime-run-resolver';
import { getOutputDisclosure } from '@/lib/output-disclosure';
import { prepareOutputDownloadEvent } from '@/lib/output-download-events';
import { disclosureNotice, markExportText } from '@/lib/output-disclosure-format';
import { PUBLICATION_TEXT_FIELDS, PublicationTextError, publicationTextFromPackage, type PublicationTextField } from '@/lib/publication-text';
import { ReadableArticleError, readableArticleFromPackage, readableArticleText, readableArticleHtml, readableArticleFileName } from '@/lib/readable-article';
import { MAX_OUTPUT_DOWNLOAD_BYTES, OutputDownloadError, prepareOutputDownload } from '@/lib/output-export';
import { MAX_PORTABLE_IMAGE_BYTES, PortableArticleError, portableArticleRoot, preparePortableArticle } from '@/lib/portable-article';
import { validateRuntimeOutput, writeRuntimeOutput } from '@/lib/runtime-writer';
import { assertOptionalTextInput, assertTextInput, InputLimitError, MAX_SHORT_TEXT_BYTES, MAX_TEXT_ARTIFACT_BYTES } from '@/lib/input-limits';
import { redactLocalPaths } from '@/lib/project-root';
import { projectFileExists, readIdempotentResult, rememberIdempotentResult, withProjectWriteLock, writeFingerprint, WriteLockError } from '@/lib/write-guard';
import {
  expectedUserFacingErrorResponse,
  userFacingErrorPayload,
  userFacingErrorResponse,
} from '@/lib/user-facing-error';

// Operator-facing evidence remains local and read-only here. Publication
// proofs, performance snapshots, and weekly reports are intentionally scoped
// to their dedicated materials folders rather than exposing all materials.
const READABLE_ROOTS = [
  'pipeline/',
  'quality/',
  'materials/research/',
  'materials/publish-proof/',
  'materials/publish-evidence/',
  'materials/performance/',
  'materials/tikomni/raw/',
  'materials/weekly-review/',
  'runs/',
];

type OutputWriteCache = {
  path: string;
  runtimeSynced: boolean;
  runId: string;
  slug: string;
};

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.json',
  '.html',
  '.htm',
  '.css',
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.csv',
  '.xml',
  '.svg',
]);

const CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
};

const HTML_PREVIEW_POLICY = "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

function fileExtension(relativePath: string): string {
  const fileName = relativePath.split('/').pop() || '';
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

function isTextOutputPath(relativePath: string): boolean {
  return TEXT_EXTENSIONS.has(fileExtension(relativePath));
}

function contentTypeForPath(relativePath: string): string {
  const ext = fileExtension(relativePath);
  if (CONTENT_TYPES[ext]) return CONTENT_TYPES[ext];
  if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (TEXT_EXTENSIONS.has(ext)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function readBinaryOutput(safePath: string): Promise<{ buffer: Buffer; size: number }> {
  const [buffer, stats] = await Promise.all([readFile(safePath), stat(safePath)]);
  return { buffer, size: stats.size };
}

function isSafeOutputPath(relativePath: string, allowedRoots: string[]): boolean {
  if (relativePath.includes('\\')) return false;
  const segments = relativePath.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  return allowedRoots.some((root) => relativePath.startsWith(root));
}

async function verifiedOutputPath(relativePath: string): Promise<string | null> {
  const segments = relativePath.split('/');
  const safePath = safeResolve(BASE_DIR, relativePath);
  if (!safePath) return null;

  try {
    for (let index = 0; index < segments.length; index += 1) {
      const component = safeResolve(BASE_DIR, segments.slice(0, index + 1).join('/'));
      if (!component) return null;
      const info = await lstat(component);
      if (info.isSymbolicLink()) return null;
      if (index === segments.length - 1 ? !info.isFile() : !info.isDirectory()) return null;
    }

    const [physicalRoot, physicalPath] = await Promise.all([
      realpath(BASE_DIR),
      realpath(safePath),
    ]);
    const relation = relative(physicalRoot, physicalPath);
    if (isAbsolute(relation) || relation === '..' || relation.startsWith(`..${sep}`)) return null;
    return physicalPath;
  } catch {
    return null;
  }
}

function slugFromPath(relativePath: string): string {
  const name = relativePath.split('/').pop()?.replace(/\.md$/i, '') || 'human-edited';
  return name
    .replace(/^\d{4}-\d{2}-\d{2}(?:-\d{6}-\d{6})?-/, '')
    .replace(/-(?:intake|validate|blueprint|angle|breakdown|write|xhs|visual|prelaunch|compliance|audit|publish|review|archive|twin)$/i, '')
    .replace(/[^a-z0-9一-龥\s-]/gi, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'human-edited';
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    const { path } = await params;
    const relativePath = path.join('/');
    if (!isSafeOutputPath(relativePath, READABLE_ROOTS)) {
      return expectedUserFacingErrorResponse({
        error: '无法打开这个文件。',
        code: 'output_path_not_allowed',
        status: 400,
      });
    }
    const safePath = await verifiedOutputPath(relativePath);
    if (!safePath) {
      return expectedUserFacingErrorResponse({
        error: '无法打开这个文件。',
        code: 'output_path_not_allowed',
        status: 400,
      });
    }

    const url = new URL(req.url);
    const shouldDownload = url.searchParams.get('download') === '1';
    const shouldReturnRaw = url.searchParams.get('raw') === '1';
    const shouldValidate = url.searchParams.get('validate') === '1';
    const shouldPreview = url.searchParams.get('preview') === '1';
    const readable = url.searchParams.has('readable');
    if (url.searchParams.has('publicationText')) {
      const field = url.searchParams.get('publicationText') as PublicationTextField;
      const sha256 = url.searchParams.get('sha256') || '';
      if (!PUBLICATION_TEXT_FIELDS.includes(field) || !/^pipeline\/package\/[^/]+\.md$/i.test(relativePath)
        || !/^[a-f0-9]{64}$/.test(sha256) || readable || shouldDownload || shouldReturnRaw || shouldValidate || shouldPreview || url.searchParams.has('disclosure')) {
        throw new PublicationTextError('请从当前成品的复制入口重新操作。', 400);
      }
      if ((await stat(safePath)).size > MAX_TEXT_ARTIFACT_BYTES) throw new PublicationTextError('文案过大，请拆分后重试。', 413);
      const source = await readFile(safePath);
      if (source.length > MAX_TEXT_ARTIFACT_BYTES) throw new PublicationTextError('文案过大，请拆分后重试。', 413);
      if (createHash('sha256').update(source).digest('hex') !== sha256) throw new PublicationTextError('原稿已更新，请刷新成品后再复制。', 409);
      let text: string;
      try { text = publicationTextFromPackage(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(source), field); }
      catch (error) { throw error instanceof PublicationTextError ? error : new PublicationTextError(); }
      const limits = await getOutputDisclosure(relativePath);
      const current = await verifiedOutputPath(relativePath);
      if (!current || (await stat(current)).size > MAX_TEXT_ARTIFACT_BYTES || !source.equals(await readFile(current))) {
        throw new PublicationTextError('原稿已更新，请刷新成品后再复制。', 409);
      }
      return NextResponse.json({ field, sha256, text,
        previewText: markExportText(text, '.txt', limits), notice: disclosureNotice(limits), disclosureStatus: limits.status,
        reviewToken: createHash('sha256').update(JSON.stringify({ relativePath, sha256, limits })).digest('hex'),
      }, { headers: { 'Cache-Control': 'no-store' } });
    }
    let readableSource: Buffer | undefined;
    let article: ReturnType<typeof readableArticleFromPackage> | undefined;
    if (readable) {
      if (url.searchParams.get('readable') !== 'article' || !/^pipeline\/package\/[^/]+\.md$/i.test(relativePath)
        || shouldReturnRaw || shouldValidate || shouldPreview || url.searchParams.has('disclosure')) {
        throw new ReadableArticleError('这个文件暂不支持保存为可读文章。', 400);
      }
      const expectedHash = url.searchParams.get('sha256') || '';
      if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new ReadableArticleError('请重新读取文章，再复制或保存。', 400);
      if ((await stat(safePath)).size > MAX_TEXT_ARTIFACT_BYTES) throw new ReadableArticleError('文章过大，请先拆分后再保存可读稿。', 413);
      readableSource = await readFile(safePath);
      if (readableSource.length > MAX_TEXT_ARTIFACT_BYTES) throw new ReadableArticleError('文章过大，请先拆分后再保存可读稿。', 413);
      if (createHash('sha256').update(readableSource).digest('hex') !== expectedHash) throw new ReadableArticleError('文章已经更新。请重新读取文章，再复制或保存。', 409);
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(readableSource); }
      catch { throw new ReadableArticleError('这份文件的文字编码无法识别，请先核对原始文件。'); }
      article = readableArticleFromPackage(text);
    }
    const isTextFile = isTextOutputPath(relativePath);
    const isContentArtifact = relativePath.startsWith('pipeline/') || /^runs\/[^/]+\/content-attempts\//.test(relativePath);
    const disclosure = isContentArtifact && (readable || shouldDownload || shouldReturnRaw || url.searchParams.get('disclosure') === '1')
      ? await getOutputDisclosure(relativePath) : null;

    if (readableSource && article) {
      // Resolve current author limits first, then reject an article replaced during that lookup.
      const currentPath = await verifiedOutputPath(relativePath);
      if (!currentPath || (await stat(currentPath)).size > MAX_TEXT_ARTIFACT_BYTES
        || !readableSource.equals(await readFile(currentPath))) throw new ReadableArticleError('文章已经更新。请重新读取文章，再复制或保存。', 409);
      if (!shouldDownload) {
        const limits = disclosure || { status: 'unverified' as const, restrictions: [] };
        return NextResponse.json({
          text: markExportText(readableArticleText(article), '.txt', limits),
          notice: disclosureNotice(limits),
          sha256: createHash('sha256').update(readableSource).digest('hex'),
        }, { headers: { 'Cache-Control': 'no-store' } });
      }
    }

    if (url.searchParams.get('disclosure') === '1') {
      return NextResponse.json({ disclosure: disclosure || { status: 'unverified', restrictions: [] } }, { headers: { 'Cache-Control': 'no-store' } });
    }

    // Deliver a marked response copy. Source bytes remain the authority for
    // approvals, editing, queue hashes and later production work.
    if (shouldDownload) {
      if ((await stat(safePath)).size > MAX_OUTPUT_DOWNLOAD_BYTES) {
        return expectedUserFacingErrorResponse({ error: '单个导出文件超过 256MB，请拆分后重试。', code: 'output_download_too_large', status: 413 });
      }
      const source = readableSource || await readFile(safePath);
      // The file can grow after stat; enforce the bound on the bytes actually read.
      if (source.length > MAX_OUTPUT_DOWNLOAD_BYTES) throw new OutputDownloadError('单个导出文件超过 256MB，请拆分后重试。', 'file_too_large');
      const originalName = relativePath.split('/').pop() || 'output';
      let downloadSource = source;
      if (!article && portableArticleRoot(relativePath)) {
        const images = new Map<string, Buffer>();
        downloadSource = await preparePortableArticle(source, relativePath, async (imagePath) => {
          const verified = await verifiedOutputPath(imagePath);
          if (!verified) throw new PortableArticleError('文章的本地配图缺失或无法核对，请重新整理成品后下载。');
          if ((await stat(verified)).size > MAX_PORTABLE_IMAGE_BYTES) throw new PortableArticleError('单张文章配图超过 16MB，请压缩图片并重新整理成品后下载。', 413);
          const bytes = await readFile(verified);
          images.set(imagePath, bytes);
          return bytes;
        });
        // Do not export a mixture of revisions if the article or images change
        // while resolving them. The stored source remains untouched.
        for (const [path, bytes] of [[relativePath, source], ...images] as [string, Buffer][]) {
          const verified = await verifiedOutputPath(path);
          if (!verified || (await stat(verified)).size !== bytes.length || !bytes.equals(await readFile(verified))) {
            throw new PortableArticleError('文章或配图已经更新，请重新读取成品后再下载。', 409);
          }
        }
      }
      const output = article
        ? prepareOutputDownload(Buffer.from(readableArticleHtml(article), 'utf8'), readableArticleFileName(article.title), 'text/html; charset=utf-8', disclosure || { status: 'unverified', restrictions: [] })
        : disclosure ? prepareOutputDownload(downloadSource, originalName, contentTypeForPath(relativePath), disclosure)
        : { body: downloadSource, fileName: originalName, contentType: contentTypeForPath(relativePath) };
      let receipt: Awaited<ReturnType<typeof prepareOutputDownloadEvent>> = null;
      let recording = 'unattributed';
      try {
        receipt = await prepareOutputDownloadEvent({ path: relativePath, source, output: output.body, fileName: output.fileName,
          disclosure: disclosure || await getOutputDisclosure(relativePath) });
        if (receipt) recording = 'prepared';
      } catch { recording = 'unavailable'; }
      return new Response(new Uint8Array(output.body), { headers: {
        'Content-Type': output.contentType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(output.fileName)}`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Echo-Download-Bytes': String(output.body.length),
        'X-Echo-Download-Record': recording,
        ...(receipt ? { 'X-Echo-Download-Receipt': receipt.id, 'X-Echo-Download-Run-Id': encodeURIComponent(receipt.runId) } : {}),
        ...(output.contentType.startsWith('text/html') ? { 'Content-Security-Policy': HTML_PREVIEW_POLICY, 'Referrer-Policy': 'no-referrer' } : {}),
      } });
    }

    if (!isTextFile) {
      const { buffer, size } = await readBinaryOutput(safePath);
      const originalName = relativePath.split('/').pop() || 'aifios-output';
      const fileName = disclosure && disclosure.status !== 'no_whole_draft_limit'
        ? `${disclosure.status === 'internal_only' ? '仅内部预览' : '公开限制待核对'}-${originalName}` : originalName;
      const headers = new Headers({
        'Content-Type': contentTypeForPath(relativePath),
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      });

      if (shouldPreview) {
        return NextResponse.json({
          path: relativePath,
          bytes: size,
          contentType: contentTypeForPath(relativePath),
          preview: '二进制文件，请使用打开预览或下载',
          truncated: false,
        });
      }

      headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileName)}`);

      return new Response(new Uint8Array(buffer), { headers });
    }

    const content = await readFile(safePath, 'utf-8');

    if (shouldReturnRaw) {
      const headers = new Headers({
        'Content-Type': contentTypeForPath(relativePath),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      });

      if (['.html', '.htm'].includes(fileExtension(relativePath))) {
        headers.set(
          'Content-Security-Policy',
          HTML_PREVIEW_POLICY,
        );
        headers.set('Referrer-Policy', 'no-referrer');
      }



      return new Response(disclosure ? markExportText(content, fileExtension(relativePath), disclosure) : content, { headers });
    }

    if (shouldPreview) {
      const normalized = content.replace(/\s+/g, ' ').trim();
      const maxChars = 420;
      return NextResponse.json({
        path: relativePath,
        preview: normalized.slice(0, maxChars),
        chars: content.length,
        truncated: normalized.length > maxChars,
      });
    }

    let validation: Awaited<ReturnType<typeof validateRuntimeOutput>> | null = null;
    let validationWarning = '';
    let validationWarningCode = '';
    let validationWarningDebugId = '';
    const runtimeStep = shouldValidate ? getRuntimeStepByOutputPath(relativePath) : null;
    if (runtimeStep) {
      try {
        validation = await validateRuntimeOutput(runtimeStep, relativePath);
      } catch (error) {
        const failure = userFacingErrorPayload(error, {
          error: '内容检查暂时无法完成，请稍后重试。',
          code: 'output_validation_failed',
          context: 'output validation',
        });
        validationWarning = failure.error;
        validationWarningCode = failure.code;
        validationWarningDebugId = failure.debugId || '';
      }
    }

    return NextResponse.json({
      content,
      path: relativePath,
      validation: redactLocalPaths(validation),
      validationWarning,
      ...(validationWarningCode ? { validationWarningCode } : {}),
      ...(validationWarningDebugId ? { validationWarningDebugId } : {}),
    });
  } catch (error) {
    if (error instanceof PublicationTextError) return expectedUserFacingErrorResponse({ error: error.message, code: 'publication_text_unavailable', status: error.status });
    if (error instanceof PortableArticleError) return expectedUserFacingErrorResponse({ error: error.message, code: 'portable_article_unavailable', status: error.status });
    if (error instanceof ReadableArticleError) return expectedUserFacingErrorResponse({ error: error.message, code: 'readable_article_unavailable', status: error.status });
    if (error instanceof OutputDownloadError) return expectedUserFacingErrorResponse({ error: error.message, code: 'output_download_limit', status: 413 });
    return userFacingErrorResponse(error, {
      error: '暂时无法读取文件，请重试。',
      code: 'output_read_failed',
      status: 500,
    });
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ path: string[] }> }
) {
  try {
    await ensureProjectInitialized();
    const { path } = await params;
    const relativePath = path.join('/');
    if (!isSafeOutputPath(relativePath, ['pipeline/'])) {
      return expectedUserFacingErrorResponse({
        error: '这个文件不能在这里保存新版本。',
        code: 'output_version_not_allowed',
        status: 400,
      });
    }
    if (!await verifiedOutputPath(relativePath)) {
      return expectedUserFacingErrorResponse({
        error: '这个文件不能在这里保存新版本。',
        code: 'output_version_not_allowed',
        status: 400,
      });
    }

    const body = (await req.json()) as { content?: unknown; versionLabel?: unknown };
    const content = assertTextInput(body.content, '版本内容', MAX_TEXT_ARTIFACT_BYTES);
    if (!content.trim()) {
      return expectedUserFacingErrorResponse({
        error: '请填写要保存的内容。',
        code: 'output_content_required',
        status: 400,
      });
    }
    const versionLabel = assertOptionalTextInput(body.versionLabel, '版本标签', MAX_SHORT_TEXT_BYTES) || 'human-edited';

    const runtimeStep = getRuntimeStepByOutputPath(relativePath);
    if (!runtimeStep) {
      return expectedUserFacingErrorResponse({
        error: '这个文件不属于当前任务，不能保存。',
        code: 'output_task_mismatch',
        status: 400,
      });
    }
    const idempotencyKey = writeFingerprint('output-edit', { relativePath, content, versionLabel });
    const writeResult = await withProjectWriteLock(`output-edit:${relativePath}`, async () => {
      const cached = await readIdempotentResult<OutputWriteCache>(
        idempotencyKey,
        async (item) => Boolean(item.path && (await projectFileExists(item.path)))
      );
      if (cached) return { ...cached, idempotentReplay: true };

      let versionPath: string;
      let runtimeSynced = false;
      let runtimeRunId = '';
      let runtimeSlug = '';
      try {
        const target = await resolveRuntimeWriteTarget({
          fallbackSlug: slugFromPath(relativePath),
          sourcePaths: [{ path: relativePath, step: runtimeStep }],
        });
        runtimeRunId = target.runId;
        runtimeSlug = target.slug;
        versionPath = await writeRuntimeOutput(
          runtimeStep,
          target.slug,
          content,
          `ui-edit:${relativePath}`,
          target.runId || undefined,
        );
        runtimeSynced = true;
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown error';
        throw new Error(`runtime 写入失败，本次版本未保存：${detail}`);
      }
      const data = { path: versionPath, runtimeSynced, runId: runtimeRunId, slug: runtimeSlug };
      await rememberIdempotentResult(idempotencyKey, data);
      return { ...data, idempotentReplay: false };
    });

    let validation: Awaited<ReturnType<typeof validateRuntimeOutput>> | null = null;
    let validationWarning = '';
    let validationWarningCode = '';
    let validationWarningDebugId = '';
    if (runtimeStep) {
      try {
        validation = await validateRuntimeOutput(runtimeStep, writeResult.path);
      } catch (error) {
        const failure = userFacingErrorPayload(error, {
          error: '内容已保存，但暂时无法完成格式检查。请稍后重试检查。',
          code: 'output_validation_failed',
          context: 'saved output validation',
        });
        validationWarning = failure.error;
        validationWarningCode = failure.code;
        validationWarningDebugId = failure.debugId || '';
      }
    }

    return NextResponse.json(redactLocalPaths({
      path: writeResult.path,
      content,
      runtimeSynced: writeResult.runtimeSynced,
      runId: writeResult.runId,
      slug: writeResult.slug,
      idempotentReplay: writeResult.idempotentReplay,
      validation,
      validationWarning,
      ...(validationWarningCode ? { validationWarningCode } : {}),
      ...(validationWarningDebugId ? { validationWarningDebugId } : {}),
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : '保存版本失败';
    // A missing approved blueprint or frozen TikOmni snapshot is an expected
    // production prerequisite, not an internal server failure. Returning 424
    // lets the workbench keep the operator at the correct confirmation gate.
    const runtimePrerequisiteBlocked = message.startsWith('runtime 写入失败');
    const status = error instanceof InputLimitError
      ? 400
      : error instanceof WriteLockError
        ? 409
        : runtimePrerequisiteBlocked
          ? 424
          : 500;
    return userFacingErrorResponse(error, {
      error: runtimePrerequisiteBlocked
        ? '本次内容未保存。请先完成当前任务的必要确认，再重试。'
        : '本次内容未保存，请重试。',
      code: runtimePrerequisiteBlocked ? 'output_prerequisite_required' : 'output_save_failed',
      status,
    });
  }
}
