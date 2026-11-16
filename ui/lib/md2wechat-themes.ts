import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { LayoutCallWriteError, startThemePreviewCall } from './layout-call-records';
import {
  DEFAULT_BRAND_TEMPLATE,
  isMd2WechatThemeId,
  parseBrandTemplates,
  type BrandTemplate,
  type Md2WechatThemeType,
} from './brand-templates';

const execFileAsync = promisify(execFile);
const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_PREVIEW_BYTES = 1024 * 1024;

const THEME_PREVIEW_MARKDOWN = `# Echo Founder 排版预览

这是一篇用于比较公众号主题的示例文章。预览只展示排版效果，不会上传图片或创建草稿。

## 先看结论

好排版不是增加装饰，而是让读者更快看清标题、观点与证据之间的关系。

> 内容负责建立信任，排版负责降低阅读阻力。

## 阅读层次

- 标题要能快速定位主题
- 正文要保持舒服的行距与留白
- 重点信息要醒目，但不能抢走内容本身

### 一个关键判断

同一篇文章使用不同主题时，文字不会改变，变化的是颜色、层级、间距和强调方式。

**请根据自己的内容气质选择主题。**
`;

type RawTheme = {
  name?: unknown;
  type?: unknown;
  description?: unknown;
  version?: unknown;
  selectable?: unknown;
};

export type Md2WechatThemeCatalog = {
  templates: BrandTemplate[];
  source: 'md2wechat' | 'echo-basic-fallback';
  rendererAvailable: boolean;
  totalCount: number;
  directlyUsableCount: number;
  aiThemeCount: number;
  note: string;
};

export type Md2WechatThemePreview = {
  themeId: string;
  html: string;
  renderer: 'md2wechat';
  exact: true;
};

export class Md2WechatThemePreviewError extends Error {}

function md2wechatBinary(): string {
  return process.env.MD2WECHAT_BINARY?.trim() || 'md2wechat';
}

function themeType(value: unknown, selectable: boolean): Md2WechatThemeType {
  if (value === 'api') return 'api';
  if (value === 'ai') return 'ai';
  return selectable ? 'api' : 'catalog';
}

export function parseMd2WechatThemeCatalog(payload: unknown): Md2WechatThemeCatalog {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : {};
  const rawThemes = Array.isArray(data.themes) ? data.themes : [];
  const templates = rawThemes.flatMap((value): BrandTemplate[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const raw = value as RawTheme;
    const name = typeof raw.name === 'string' ? raw.name.trim().toLowerCase() : '';
    if (!isMd2WechatThemeId(name)) return [];
    const selectable = raw.selectable === true;
    const type = themeType(raw.type, selectable);
    const directlyUsable = selectable && type === 'api';
    return [{
      id: name,
      label: name,
      detail: typeof raw.description === 'string' && raw.description.trim()
        ? raw.description.trim().slice(0, 240)
        : 'md2wechat 主题',
      layoutStyle: name,
      enabled: directlyUsable,
      selectable,
      themeType: type,
      version: typeof raw.version === 'string' ? raw.version.trim().slice(0, 32) : undefined,
      source: 'md2wechat',
    }];
  });
  const parsed = parseBrandTemplates(templates);
  const directlyUsableCount = parsed.filter((template) => template.enabled).length;
  const aiThemeCount = parsed.filter((template) => template.themeType === 'ai').length;
  return {
    templates: parsed,
    source: 'md2wechat',
    rendererAvailable: true,
    totalCount: parsed.length,
    directlyUsableCount,
    aiThemeCount,
    note: `本机 md2wechat 返回 ${parsed.length} 个主题，其中 ${directlyUsableCount} 个 API 主题可直接用于确定性排版。`,
  };
}

export async function readMd2WechatThemeCatalog(): Promise<Md2WechatThemeCatalog> {
  const binary = md2wechatBinary();
  try {
    const { stdout } = await execFileAsync(binary, ['themes', 'list', '--json'], {
      timeout: 8_000,
      maxBuffer: MAX_CATALOG_BYTES,
      encoding: 'utf8',
      env: process.env,
    });
    return parseMd2WechatThemeCatalog(JSON.parse(stdout));
  } catch {
    return {
      templates: [{ ...DEFAULT_BRAND_TEMPLATE }],
      source: 'echo-basic-fallback',
      rendererAvailable: false,
      totalCount: 1,
      directlyUsableCount: 1,
      aiThemeCount: 0,
      note: '未检测到可用的 md2wechat CLI；当前只提供一个基础排版以保障交付。',
    };
  }
}

function previewDocument(rendered: string): string {
  if (/<html[\s>]/i.test(rendered)) return rendered;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    html { background: #f3f1ed; }
    body { margin: 0; padding: 28px 14px 64px; background: #f3f1ed; }
    body > section { background: #fff; box-shadow: 0 18px 48px rgba(34, 31, 27, 0.09); }
  </style>
</head>
<body>${rendered}</body>
</html>`;
}

function assertSafePreviewHtml(rendered: string): void {
  const size = Buffer.byteLength(rendered, 'utf8');
  if (size === 0 || size > MAX_PREVIEW_BYTES) {
    throw new Md2WechatThemePreviewError('md2wechat 返回的预览文件大小不正确。');
  }
  if (/<(?:script|iframe|object|embed)\b|javascript\s*:|\son[a-z]+\s*=/i.test(rendered)) {
    throw new Md2WechatThemePreviewError('md2wechat 返回的预览包含不受支持的活动内容。');
  }
}

export async function readMd2WechatThemePreview(themeId: string): Promise<Md2WechatThemePreview> {
  const normalizedThemeId = themeId.trim().toLowerCase();
  if (!isMd2WechatThemeId(normalizedThemeId)) {
    throw new Md2WechatThemePreviewError('md2wechat 主题标识格式不正确。');
  }

  const catalog = await readMd2WechatThemeCatalog();
  const theme = catalog.templates.find((candidate) => (
    candidate.id === normalizedThemeId
    && candidate.enabled
    && candidate.themeType === 'api'
    && candidate.source === 'md2wechat'
  ));
  if (!theme) {
    throw new Md2WechatThemePreviewError('这个主题当前不能由 md2wechat 直接预览。');
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'echo-founder-md2wechat-preview-'));
  const sourcePath = join(temporaryDirectory, 'theme-preview.md');
  const outputPath = join(temporaryDirectory, 'theme-preview.html');
  let call: Awaited<ReturnType<typeof startThemePreviewCall>> | undefined;
  try {
    await writeFile(sourcePath, THEME_PREVIEW_MARKDOWN, 'utf8');
    call = await startThemePreviewCall(normalizedThemeId);
    await execFileAsync(
      md2wechatBinary(),
      [
        'preview',
        sourcePath,
        '--mode',
        'api',
        '--theme',
        normalizedThemeId,
        '--output',
        outputPath,
        '--json',
      ],
      {
        timeout: 45_000,
        maxBuffer: MAX_CATALOG_BYTES,
        encoding: 'utf8',
        env: process.env,
      },
    );
    const rendered = await readFile(outputPath, 'utf8');
    assertSafePreviewHtml(rendered);
    await call.finish('completed');
    return {
      themeId: normalizedThemeId,
      html: previewDocument(rendered),
      renderer: 'md2wechat',
      exact: true,
    };
  } catch (error) {
    if (error instanceof LayoutCallWriteError) throw new Md2WechatThemePreviewError(error.message);
    if (call) {
      try { await call.finish('failed'); }
      catch (recordError) {
        if (recordError instanceof LayoutCallWriteError) throw new Md2WechatThemePreviewError(recordError.message);
        throw recordError;
      }
    }
    if (error instanceof Md2WechatThemePreviewError) throw error;
    throw new Md2WechatThemePreviewError('md2wechat 暂时无法生成这个主题的预览，请检查本机配置后重试。');
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
