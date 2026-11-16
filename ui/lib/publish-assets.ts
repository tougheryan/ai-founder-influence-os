import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { lstat, readFile } from 'fs/promises';
import { promisify } from 'util';
import { basename } from 'path';
import { readNativeXhsCopy, readNativeField, nativePlatforms } from '@/electron/native-xhs-copy.cjs';
import { spokenScript } from './publication-text';
import { readOutputFile, writeOutputFile } from './output-files';
import { INSTALL_ROOT, PROJECT_DIR, runtimeJoin, safeResolve } from './project-root';
import { runtimePythonBinary } from './runtime-binary';
import { inspectGeneratedLanguage, type GeneratedLanguageFinding } from './product-voice';
import { KnownUserFacingError } from './user-facing-error';

const execFileAsync = promisify(execFile);
const DBS_WECHAT_HTML_SCRIPT = runtimeJoin(INSTALL_ROOT, 'skills', 'dbs-wechat-html', 'generate_preview.py');

const DBS_WECHAT_FALLBACK_STYLE = ['minimal', '极简黑白'] as const;

export type PublishAssetsInput = {
  slug?: string;
  topic?: string;
  packagePath?: string;
  writePath?: string;
  xhsPath?: string;
  visualPlanPath?: string;
};

export type AssetStatus = 'ready' | 'planned' | 'missing';

export type PublishVisualAsset = {
  label: string;
  path: string;
  status: AssetStatus;
  action: string;
  id?: string;
  role?: string;
  width?: number;
  height?: number;
};

export type WechatHtmlCandidate = {
  label: string;
  path: string;
  recommended: boolean;
};

export type WechatPublishDeliverable = {
  platform: 'wechat';
  label: string;
  recommendedTitle: string;
  alternativeTitles: string[];
  summary: string;
  markdownPath: string;
  htmlCandidates: WechatHtmlCandidate[];
  visualAssets: PublishVisualAsset[];
  coverOptions: PublishVisualAsset[];
  copyText: string;
  sharePosts: SharePostDeliverable[];
  shareCopyText: string;
  shareCopyPaths: string[];
  publishChecks: string[];
  qualityStatus: 'ready' | 'needs_review';
  qualityIssues: string[];
};

export type SharePage = {
  page: string;
  title: string;
  body: string;
  imagePrompt: string;
  visualHierarchy: string;
  layoutNote: string;
};

export type SharePostDeliverable = {
  index: number;
  label: string;
  title: string;
  coverText: string;
  coreViewpoint: string;
  copy: string;
  tags: string[];
  pages: SharePage[];
  platformAdaptations: Record<string, string>;
  publishForms: {
    wechat: SharePlatformPublishForm;
    moments: SharePlatformPublishForm;
    xiaohongshu: SharePlatformPublishForm;
  };
  publishCopies: Record<'wechat' | 'moments' | 'xiaohongshu', string>;
  publishPaths: Record<'wechat' | 'moments' | 'xiaohongshu', string>;
  commentGuide: string;
  visualAssets: PublishVisualAsset[];
  platformVisualAssets?: {
    xiaohongshu: PublishVisualAsset[];
    moments: PublishVisualAsset[];
  };
  primaryPath?: string;
};

export type SharePlatformPublishForm = {
  title: string;
  copy: string;
  tags: string[];
  imageOrder: string;
};

export type XhsPublishDeliverable = {
  platform: 'xiaohongshu';
  label: string;
  coverTitle: string;
  firstThreeLines: string[];
  cardPlan: string[];
  bodyCopy: string;
  tags: string[];
  commentGuide: string;
  posts: SharePostDeliverable[];
  videoScripts: VideoPublishScript[];
  videoCopyText: string;
  videoCopyPaths: string[];
  videoVisualAssets: PublishVisualAsset[];
  visualAssets: PublishVisualAsset[];
  copyText: string;
  publishChecks: string[];
  qualityStatus: 'ready' | 'needs_review';
  qualityIssues: string[];
};

export type MomentsPublishDeliverable = {
  platform: 'moments';
  label: string;
  posts: SharePostDeliverable[];
  visualAssets: PublishVisualAsset[];
  copyText: string;
  publishChecks: string[];
  qualityStatus: 'ready' | 'needs_review';
  qualityIssues: string[];
};

export type VideoPublishScript = {
  index: number;
  label: string;
  title: string;
  coverText: string;
  hook: string;
  duration: string;
  oralScript: string;
  teleprompterScript: string;
  shotList: string;
  subtitleHighlights: string[];
  bRollSuggestions: string[];
  publishCopy: string;
  tags: string[];
  platformNote: string;
  commentGuide: string;
  visualAssets: PublishVisualAsset[];
  primaryPath?: string;
};

type VideoPublishPlatform = 'shipinhao' | 'douyin' | 'xiaohongshu';

type VideoPublishBundle = {
  platform: VideoPublishPlatform;
  label: string;
  scripts: VideoPublishScript[];
  visualAssets: PublishVisualAsset[];
  copyText: string;
  publishChecks: string[];
  qualityStatus: 'ready' | 'needs_review';
  qualityIssues: string[];
};

export type VideoPublishDeliverable = VideoPublishBundle & {
  platform: 'shipinhao' | 'douyin';
};

export type PublishArchiveDeliverable = {
  reportPath: string;
  generatedPaths: string[];
  packagePath?: string;
  wechatHtmlOverview?: string;
  wechatShareCopyPaths?: string[];
  xhsCopyPaths?: string[];
  xhsVideoCopyPaths?: string[];
  momentsCopyPaths?: string[];
  shipinhaoCopyPaths?: string[];
  douyinCopyPaths?: string[];
  languageWarnings?: GeneratedLanguageFinding[];
};

export type PlatformDeliverables = {
  wechat?: WechatPublishDeliverable;
  xiaohongshu?: XhsPublishDeliverable;
  moments?: MomentsPublishDeliverable;
  shipinhao?: VideoPublishDeliverable;
  douyin?: VideoPublishDeliverable;
  archive: PublishArchiveDeliverable;
};

export type PublishAssetsResult = {
  slug: string;
  reportPath: string;
  markdown: string;
  generatedPaths: string[];
  wechatHtmlOverview?: string;
  platformDeliverables: PlatformDeliverables;
  languageWarnings: GeneratedLanguageFinding[];
};

type ParsedWechat = {
  title: string;
  titleOptions: string[];
  coverText: string;
  summary: string;
  layoutHint: string;
  imageSlots: string;
  body: string;
  commentGuide: string;
};

type ParsedVideo = {
  index: number;
  heading: string;
  title: string;
  coverText: string;
  hook: string;
  duration: string;
  oralScript: string;
  shotList: string;
  subtitles: string[];
  bRoll: string[];
  platformNotes: Record<string, string>;
  publishForms: Record<'shipinhao' | 'douyin' | 'xiaohongshu', ParsedVideoPublishForm>;
  commentGuide: string;
};

type ParsedVideoPublishForm = {
  title: string;
  copy: string;
  tags: string;
  cover: string;
};

type ParsedSharePost = {
  index: number;
  heading: string;
  title: string;
  coverText: string;
  coreViewpoint: string;
  copy: string;
  pages: SharePage[];
  platformAdaptations: Record<string, string>;
  publishForms: Record<'wechat' | 'moments' | 'xiaohongshu', ParsedSharePublishForm>;
  commentGuide: string;
};

type ParsedSharePublishForm = {
  title: string;
  copy: string;
  tags: string;
  imageOrder: string;
};

type ParsedPackage = {
  title: string;
  wechat: ParsedWechat;
  videos: ParsedVideo[];
  shares: ParsedSharePost[];
  native?: boolean;
  selectedPlatforms?: Array<'wechat' | 'xhs' | 'shipinhao'>;
};

type SelectedVisualAsset = {
  id: string;
  path: string;
  role: string;
  width?: number;
  height?: number;
};

type VisualLayoutOption = {
  style: string;
  path: string;
  selected: boolean;
};

type SelectedVisualBundle = {
  assets: SelectedVisualAsset[];
  layoutOptions: VisualLayoutOption[];
  sourceContentHash?: string;
};

function sanitizeSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'publish-assets';
}

function slugFromPath(path: string): string {
  const name = path.split('/').pop() || 'publish-assets';
  return sanitizeSlug(
    name
      .replace(/^\d{4}-\d{2}-\d{2}-\d{6}-\d+[-_]?/, '')
      .replace(/-(?:write|xhs|package|visual|publish-assets)\.md$/i, '')
      .replace(/\.(?:md|html)$/i, ''),
  );
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
}

function cleanMarkdown(markdown: string): string {
  return stripFrontmatter(markdown)
    .replace(/<!--\s*AIFIOS-[\s\S]*?-->/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

function limitText(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function headingTitle(line: string): { level: number; title: string } | null {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  return match ? { level: match[1].length, title: match[2].trim() } : null;
}

function headingSection(
  markdown: string,
  level: number,
  matcher: (title: string) => boolean,
): string {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = headingTitle(lines[index]);
    if (heading?.level === level && matcher(heading.title)) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return '';
  const output: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const heading = headingTitle(lines[index]);
    if (heading && heading.level <= level) break;
    output.push(lines[index]);
  }
  return output.join('\n').trim();
}

function headingBlocks(
  markdown: string,
  level: number,
  matcher: (title: string) => boolean,
): Array<{ heading: string; body: string }> {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Array<{ heading: string; body: string }> = [];
  let heading = '';
  let content: string[] = [];
  const flush = () => {
    if (heading && matcher(heading)) blocks.push({ heading, body: content.join('\n').trim() });
  };

  for (const line of lines) {
    const parsed = headingTitle(line);
    if (parsed && parsed.level < level) {
      flush();
      break;
    }
    if (parsed?.level === level) {
      flush();
      heading = parsed.title;
      content = [];
      continue;
    }
    if (heading) content.push(line);
  }
  flush();
  return blocks;
}

function field(section: string, labels: string[]): string {
  return readNativeField(section, labels);
}

function headingContent(section: string, title: string): string {
  return headingSection(section, 4, (candidate) => candidate.replace(/\s+/g, '') === title.replace(/\s+/g, ''));
}

function headingContentAny(section: string, titles: string[]): string {
  for (const title of titles) {
    const value = headingContent(section, title);
    if (value) return value;
  }
  return '';
}

function listItems(section: string): string[] {
  return section
    .split('\n')
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.trim() || '')
    .filter(Boolean)
    .map((line) => line.replace(/^(?:\*\*)?[^：:]{1,28}(?:\*\*)?[：:]\s*/, '').trim())
    .filter(Boolean);
}

function firstParagraph(section: string, fallback: string): string {
  const block = section
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .find((item) => item && !/^[-*]\s+/m.test(item) && !/^#{1,6}\s+/.test(item));
  return limitText((block || fallback).replace(/\n+/g, ' '), 160);
}

function extractTags(content: string, title: string, defaults: string[]): string[] {
  const found = content.match(/#[\u4e00-\u9fa5A-Za-z0-9_-]{2,}/g) || [];
  if (found.length) return Array.from(new Set(found)).slice(0, 12);
  const chinese = title.replace(/[^\u4e00-\u9fa5]/g, '').match(/.{2,4}/g) || [];
  return Array.from(new Set([...chinese.slice(0, 3).map((item) => `#${item}`), ...defaults])).slice(0, 8);
}

function parseTable(section: string): Array<Record<string, string>> {
  const rows = section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1)
    .filter((row) => !row.every((cell) => /^:?-{2,}:?$/.test(cell)))
    .filter((row) => row.length >= header.length)
    .map((row) => Object.fromEntries(header.map((key, index) => [key, row[index] || ''])));
}

function parseSharePages(block: string): SharePage[] {
  const table = parseTable(headingContent(block, '页卡脚本'));
  return table
    .filter((row) => /^P[1-9]$/i.test(row['页码'] || ''))
    .map((row) => ({
      page: row['页码'],
      title: row['页面标题'] || '',
      body: row['页面正文'] || '',
      imagePrompt: row['画面/配图建议'] || '',
      visualHierarchy: row['视觉层级'] || '',
      layoutNote: row['排版重点'] || '',
    }));
}

function parseNativeSharePages(block: string): SharePage[] {
  const table = parseTable(headingSection(block, 3, (title) => title === '图文卡片脚本'));
  const pages: SharePage[] = [];
  for (const row of table) {
    const pageValue = (row['页码'] || '').toUpperCase().replace(/\s+/g, '');
    const single = pageValue.match(/^P([1-8])$/);
    const range = pageValue.match(/^P([1-8])-P?([1-8])$/);
    const numbers = single
      ? [Number(single[1])]
      : range && Number(range[1]) <= Number(range[2])
        ? Array.from({ length: Number(range[2]) - Number(range[1]) + 1 }, (_, index) => Number(range[1]) + index)
        : [];
    for (const page of numbers) {
      pages.push({
        page: `P${page}`,
        title: row['页面标题'] || '',
        body: row['页面正文'] || '',
        imagePrompt: row['视觉提示'] || '',
        visualHierarchy: '',
        layoutNote: row['视觉提示'] || '',
      });
    }
  }
  return pages.sort((left, right) => Number(left.page.slice(1)) - Number(right.page.slice(1)));
}

function parseNativePackage(content: string, pageTitle: string): ParsedPackage {
  const shared = headingSection(content, 2, (title) => title === '0. 共享事实底稿');
  const selectedText = field(shared, ['本期平台']);
  const selectedPlatforms = nativePlatforms(selectedText);
  if (!selectedPlatforms.length) throw new Error('共享事实底稿缺少有效的本期平台。');

  const wechatSection = headingSection(content, 2, (title) => title === '1. 公众号原生长文');
  const articleBody = headingSection(wechatSection, 3, (title) => title === '正文');
  const wechat: ParsedWechat = {
    title: field(wechatSection, ['发布标题']),
    titleOptions: field(wechatSection, ['标题备选']).split(/[；;|]/).map((item) => item.trim()).filter(Boolean),
    coverText: field(wechatSection, ['头图文案']),
    summary: field(wechatSection, ['摘要']),
    layoutHint: field(wechatSection, ['排版提示']),
    imageSlots: field(wechatSection, ['排版提示']),
    body: articleBody,
    commentGuide: headingSection(wechatSection, 3, (title) => title === '评论区承接'),
  };
  if (selectedPlatforms.includes('wechat') && (!wechatSection || !wechat.title || !wechat.body)) {
    throw new Error('公众号原生长文缺少发布标题或正文。');
  }

  const xhsSection = headingSection(content, 2, (title) => title === '2. 小红书原生图文');
  const xhsCover = headingSection(xhsSection, 3, (title) => title === '封面三句话');
  const xhsCopy = selectedPlatforms.includes('xhs') ? readNativeXhsCopy(content) : null;
  const shares: ParsedSharePost[] = selectedPlatforms.includes('xhs') ? [{
    index: 1,
    heading: '小红书原生图文',
    title: xhsCopy!.title,
    coverText: [field(xhsCover, ['主句']), field(xhsCover, ['副句']), field(xhsCover, ['补充句'])].filter(Boolean).join(' / '),
    coreViewpoint: field(xhsCover, ['主句']),
    copy: xhsCopy!.body,
    pages: parseNativeSharePages(xhsSection),
    platformAdaptations: {},
    publishForms: {
      wechat: { title: '', copy: '', tags: '', imageOrder: '' },
      moments: { title: '', copy: '', tags: '', imageOrder: '' },
      xiaohongshu: {
        title: xhsCopy!.title,
        copy: xhsCopy!.publishingBody,
        tags: xhsCopy!.tags,
        imageOrder: 'P1-P8',
      },
    },
    commentGuide: xhsCopy!.question,
  }] : [];
  if (selectedPlatforms.includes('xhs') && (!xhsSection || !shares[0]?.title || !shares[0]?.copy || shares[0].pages.length !== 8)) {
    throw new Error('小红书原生图文必须包含发布标题、正文和 P1-P8 图文卡片。');
  }

  const videoSection = headingSection(content, 2, (title) => title === '3. 视频号原生口播');
  const videoPublish = headingSection(videoSection, 3, (title) => title === '发布文案');
  const videoTitle = field(videoSection, ['发布标题']);
  const videos: ParsedVideo[] = selectedPlatforms.includes('shipinhao') ? [{
    index: 1,
    heading: '视频号原生口播',
    title: videoTitle,
    coverText: videoTitle,
    hook: field(videoSection, ['3秒钩子', '3 秒钩子']),
    duration: field(videoSection, ['建议时长', '时长']),
    oralScript: headingSection(videoSection, 3, (title) => title === '逐句口播稿'),
    shotList: headingSection(videoSection, 3, (title) => title === '镜头清单'),
    subtitles: listItems(headingSection(videoSection, 3, (title) => title === '字幕重点')),
    bRoll: listItems(headingSection(videoSection, 3, (title) => title === 'B-roll 建议')),
    platformNotes: { shipinhao: field(videoPublish, ['简介']) },
    publishForms: {
      shipinhao: {
        title: videoTitle,
        copy: field(videoPublish, ['简介']),
        tags: field(videoPublish, ['话题']),
        cover: videoTitle,
      },
      douyin: { title: '', copy: '', tags: '', cover: '' },
      xiaohongshu: { title: '', copy: '', tags: '', cover: '' },
    },
    commentGuide: field(videoPublish, ['置顶评论']),
  }] : [];
  if (selectedPlatforms.includes('shipinhao') && (!videoSection || !videoTitle || !videos[0]?.oralScript || !videos[0]?.shotList || !videos[0]?.bRoll.length)) {
    throw new Error('视频号原生口播缺少标题、逐句口播稿、镜头清单或 B-roll 建议。');
  }
  if (selectedPlatforms.includes('shipinhao')) spokenScript(videos[0].oralScript);
  return { title: pageTitle, wechat, videos, shares, native: true, selectedPlatforms };
}

function parsePlatformAdaptations(block: string): Record<string, string> {
  const content = headingContentAny(block, ['平台适配', '发布适配', '平台发布适配']);
  return {
    wechat: field(content, ['公众号', '微信公众号']),
    moments: field(content, ['朋友圈', '微信朋友圈']),
    xiaohongshu: field(content, ['小红书']),
  };
}

function parseVideoPublishForms(block: string): Record<'shipinhao' | 'douyin' | 'xiaohongshu', ParsedVideoPublishForm> {
  const content = headingContentAny(block, ['平台发布表单', '平台发布稿', '发布字段']);
  const defaultCover = field(content, ['默认封面画面', '封面画面']);
  return {
    shipinhao: {
      title: field(content, ['视频号标题', '微信视频号标题']),
      copy: field(content, ['视频号发布文案', '视频号简介', '微信视频号发布文案']),
      tags: field(content, ['视频号话题', '视频号标签', '微信视频号话题']),
      cover: field(content, ['视频号封面画面', '视频号封面']) || defaultCover,
    },
    douyin: {
      title: field(content, ['抖音标题']),
      copy: field(content, ['抖音发布文案', '抖音描述']),
      tags: field(content, ['抖音话题', '抖音标签']),
      cover: field(content, ['抖音封面画面', '抖音封面']) || defaultCover,
    },
    xiaohongshu: {
      title: field(content, ['小红书视频标题', '小红书标题']),
      copy: field(content, ['小红书视频正文', '小红书视频文案', '小红书正文']),
      tags: field(content, ['小红书标签', '小红书视频标签']),
      cover: field(content, ['小红书视频封面', '小红书封面画面', '小红书封面']) || defaultCover,
    },
  };
}

function parseSharePublishForms(block: string): Record<'wechat' | 'moments' | 'xiaohongshu', ParsedSharePublishForm> {
  const content = headingContentAny(block, ['平台发布稿', '平台发布表单', '发布字段']);
  return {
    wechat: {
      title: field(content, ['公众号文内标题', '公众号标题']),
      copy: field(content, ['公众号配文', '公众号引导文案']),
      tags: '',
      imageOrder: '',
    },
    moments: {
      title: '',
      copy: field(content, ['朋友圈短文案', '朋友圈文案']),
      tags: '',
      imageOrder: field(content, ['朋友圈图序', '朋友圈选图']),
    },
    xiaohongshu: {
      title: field(content, ['小红书标题']),
      copy: field(content, ['小红书正文', '小红书图文正文']),
      tags: field(content, ['小红书标签']),
      imageOrder: '',
    },
  };
}

function parseCommentGuide(block: string): string {
  const content = headingContentAny(block, ['评论维护话术', '评论区引导']);
  return field(content, ['置顶评论', '置顶']) || listItems(content)[0] || '';
}

function parsePackage(markdown: string): ParsedPackage {
  const content = cleanMarkdown(markdown);
  const pageTitle = content.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || '内容发布包';
  if (/^##\s+0\.\s*共享事实底稿\s*$/m.test(content)) return parseNativePackage(content, pageTitle);
  const wechatSection = headingSection(content, 2, (title) => /^1\.\s*公众号(?:母稿|长文)/.test(title));
  const videoSection = headingSection(content, 2, (title) => /^2\.\s*短视频/.test(title));
  const shareSection = headingSection(content, 2, (title) => /^3\.\s*(?:分享观点(?:图文)?|图文内容)/.test(title));
  if (!wechatSection || !videoSection || !shareSection) {
    throw new Error('内容包必须包含“公众号母稿、短视频内容、分享观点图文”三个完整章节。');
  }

  const articleBody = headingSection(wechatSection, 3, (title) => title === '正文');
  const wechat: ParsedWechat = {
    title: field(wechatSection, ['发布标题']) || pageTitle.replace(/^最终内容\s*[·：:]?\s*/, ''),
    titleOptions: field(wechatSection, ['标题备选']).split(/[；;|]/).map((item) => item.trim()).filter(Boolean),
    coverText: field(wechatSection, ['封面字']) || '核心判断',
    summary: field(wechatSection, ['摘要']) || firstParagraph(articleBody, pageTitle),
    layoutHint: field(wechatSection, ['公众号排版提示', '排版提示', 'HTML 排版建议']),
    imageSlots: field(wechatSection, ['配图位建议', '配图建议', '图片需求']),
    body: articleBody,
    commentGuide: parseCommentGuide(wechatSection),
  };
  if (!wechat.title || !wechat.body) throw new Error('公众号母稿缺少发布标题或正文。');

  const videos = headingBlocks(videoSection, 3, (title) => /^短视频\s*[12]/.test(title))
    .map((entry, index) => {
      const source = entry.body;
      const segmented = headingContent(source, '分段口播稿');
      const parts = ['开场', '展开', '转折', '收口']
        .map((label) => field(segmented, [label]))
        .filter(Boolean);
      const platformNote = headingContentAny(source, ['发布备注', '发布说明', '发布建议', '平台发布备注', '平台适配']);
      return {
        index: index + 1,
        heading: entry.heading,
        title: field(source, ['发布标题']) || entry.heading,
        coverText: field(source, ['封面字']) || entry.heading,
        hook: field(source, ['3 秒钩子', '3秒钩子', '开场钩子']) || parts[0] || '',
        duration: field(source, ['时长', '视频时长']),
        oralScript: segmented || '',
        shotList: headingContentAny(source, ['镜头清单', '镜头表']),
        subtitles: listItems(headingContent(source, '字幕重点')),
        bRoll: listItems(headingContentAny(source, ['B-roll 素材建议', 'B-roll素材建议', 'B-roll', 'B-Roll'])),
        platformNotes: {
          shipinhao: field(platformNote, ['视频号', '微信视频号']),
          douyin: field(platformNote, ['抖音']),
          xiaohongshu: field(platformNote, ['小红书']),
        },
        publishForms: parseVideoPublishForms(source),
        commentGuide: parseCommentGuide(source),
      };
    });
  if (videos.length !== 2) throw new Error('内容包必须恰好包含 2 条短视频口播稿。');

  const shares = headingBlocks(shareSection, 3, (title) => /^(?:分享观点|图文)\s*\d+/.test(title))
    .map((entry, index) => {
      const source = entry.body;
      return {
        index: index + 1,
        heading: entry.heading,
        title: field(source, ['发布标题']) || entry.heading,
        coverText: field(source, ['封面字']) || entry.heading,
        coreViewpoint: field(source, ['核心观点', '核心判断']) || '',
        copy: field(source, ['分享文案', '正文文案', '文案']) || '',
        pages: parseSharePages(source),
        platformAdaptations: parsePlatformAdaptations(source),
        publishForms: parseSharePublishForms(source),
        commentGuide: parseCommentGuide(source),
      };
    });
  if (shares.length < 1) throw new Error('内容包必须至少包含 1 条分享观点图文。');
  return { title: pageTitle, wechat, videos, shares };
}

function parseLegacyPackage(input: { topic?: string; write?: string; xhs?: string }): ParsedPackage {
  const article = cleanMarkdown(input.write || '');
  if (!article) throw new Error('缺少内容包；请先完成“公众号母稿 -> 全平台内容包”步骤。');
  const title = article.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || input.topic || '内容发布包';
  const xhs = cleanMarkdown(input.xhs || '');
  const shares = [1, 2, 3].map((index) => ({
    index,
    heading: `图文 ${index}`,
    title: `${title} · 观点 ${index}`,
    coverText: limitText(title, 14),
    coreViewpoint: firstParagraph(article, title),
    copy: xhs || firstParagraph(article, title),
    pages: [],
    platformAdaptations: {},
    publishForms: {
      wechat: { title: '', copy: '', tags: '', imageOrder: '' },
      moments: { title: '', copy: '', tags: '', imageOrder: '' },
      xiaohongshu: { title: '', copy: '', tags: '', imageOrder: '' },
    },
    commentGuide: '',
  }));
  return {
    title,
    wechat: {
      title,
      titleOptions: [],
      coverText: limitText(title, 16),
      summary: firstParagraph(article, title),
      layoutHint: '',
      imageSlots: '',
      body: article,
      commentGuide: '',
    },
    videos: [],
    shares,
  };
}

function generatedDbsPaths(sourceRelPath: string, outputDir: string): string[] {
  const sourceBase = basename(sourceRelPath).replace(/\.md$/i, '');
  const [styleId, styleName] = DBS_WECHAT_FALLBACK_STYLE;
  return [`${outputDir}/${sourceBase}_${styleId}_${styleName}_微信公众号版.html`];
}

function isSelectedVisualPath(path: unknown, slug: string, revisionId: string): path is string {
  if (typeof path !== 'string' || path.includes('\\') || path.includes('..')) return false;
  return path.startsWith(`pipeline/visual/${slug}/publish/${revisionId}/`);
}

function visualAssetDigest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function selectedAssetManifest(slug: string): Promise<{
  assets: SelectedVisualAsset[];
  sourceContentHash: string;
  layoutRevisionId: string;
} | null> {
  try {
    const raw = JSON.parse(await readOutputFile(`pipeline/visual/${slug}/selected-assets.json`)) as {
      schema?: unknown;
      slug?: unknown;
      sourceContentHash?: unknown;
      selections?: unknown;
    };
    if (raw.schema !== 'aifios.visual-asset-manifest.v1' || raw.slug !== slug
      || typeof raw.sourceContentHash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sourceContentHash)
      || !raw.selections || typeof raw.selections !== 'object' || Array.isArray(raw.selections)) {
      return null;
    }
    const assets: SelectedVisualAsset[] = [];
    let layoutRevisionId = '';
    for (const value of Object.values(raw.selections as Record<string, unknown>)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const item = value as {
        assetId?: unknown;
        semanticRole?: unknown;
        revisionId?: unknown;
        path?: unknown;
        sha256?: unknown;
        width?: unknown;
        height?: unknown;
      };
      if (typeof item.assetId !== 'string' || typeof item.semanticRole !== 'string'
        || typeof item.revisionId !== 'string' || typeof item.path !== 'string'
        || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
        || !isSelectedVisualPath(item.path, slug, item.revisionId)) {
        return null;
      }
      const path = safeResolve(PROJECT_DIR, item.path);
      if (!path) return null;
      const file = await lstat(path);
      if (file.isSymbolicLink() || !file.isFile()) return null;
      if (visualAssetDigest(await readFile(path)) !== item.sha256) return null;
      assets.push({
        id: item.assetId,
        role: item.semanticRole,
        path: item.path,
        width: typeof item.width === 'number' ? item.width : undefined,
        height: typeof item.height === 'number' ? item.height : undefined,
      });
      if (item.assetId === 'wechat-html') layoutRevisionId = item.revisionId;
    }
    return { assets, sourceContentHash: raw.sourceContentHash, layoutRevisionId };
  } catch {
    return null;
  }
}

async function visualLayoutOptions(slug: string, revisionId: string): Promise<VisualLayoutOption[]> {
  if (!revisionId) return [];
  const manifestPath = `pipeline/visual/${slug}/publish/${revisionId}/platform-delivery.json`;
  try {
    const manifest = JSON.parse(await readOutputFile(manifestPath)) as {
      schema?: unknown;
      slug?: unknown;
      revision_id?: unknown;
      wechat?: { layout_options_path?: unknown };
    };
    const layoutOptionsPath = manifest.schema === 'aifios.platform-visual-delivery.v1'
      && manifest.slug === slug
      && manifest.revision_id === revisionId
      && isSelectedVisualPath(manifest.wechat?.layout_options_path, slug, revisionId)
      ? manifest.wechat.layout_options_path
      : '';
    if (!layoutOptionsPath) return [];
    const layoutPayload = JSON.parse(await readOutputFile(layoutOptionsPath)) as { options?: unknown };
    return Array.isArray(layoutPayload.options)
      ? layoutPayload.options.flatMap((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
        const option = item as { style?: unknown; path?: unknown; selected?: unknown };
        if (!isSelectedVisualPath(option.path, slug, revisionId)) return [];
        return [{
          style: typeof option.style === 'string' && option.style.trim() ? option.style.trim() : '排版备选',
          path: option.path,
          selected: option.selected === true,
        }];
      })
      : [];
  } catch {
    return [];
  }
}

async function selectedVisualAssets(slug: string): Promise<SelectedVisualBundle> {
  try {
    const manifestSelection = await selectedAssetManifest(slug);
    if (!manifestSelection) return { assets: [], layoutOptions: [] };
    return {
      assets: manifestSelection.assets,
      layoutOptions: await visualLayoutOptions(slug, manifestSelection.layoutRevisionId),
      sourceContentHash: manifestSelection.sourceContentHash,
    };
  } catch {
    return { assets: [], layoutOptions: [] };
  }
}

function visualMatches(
  assets: SelectedVisualAsset[],
  label: string,
  matcher: (asset: SelectedVisualAsset) => boolean,
  fallback: string,
  action: string,
): PublishVisualAsset[] {
  const matched = assets.filter(matcher);
  if (matched.length) {
    return matched.map((asset) => ({
      label,
      id: asset.id,
      path: asset.path,
      status: 'ready' as const,
      action,
      role: asset.role,
      width: asset.width,
      height: asset.height,
    }));
  }
  return [{ label, path: fallback, status: 'planned', action }];
}

function mergeVisualAssets(...groups: PublishVisualAsset[][]): PublishVisualAsset[] {
  const seen = new Set<string>();
  return groups.flat().filter((asset) => {
    const key = `${asset.label}:${asset.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function visualIdContains(asset: SelectedVisualAsset, value: string): boolean {
  return asset.id.toLowerCase().includes(value.toLowerCase());
}

function buildWechatCopy(wechat: ParsedWechat, htmlPath: string): string {
  return [
    `标题：${wechat.title}`,
    `摘要：${wechat.summary}`,
    `推荐 HTML：${htmlPath || '待选择排版'}`,
    '',
    wechat.body,
    '',
    '评论区引导：',
    wechat.commentGuide || '按正文中的问题继续收集读者场景。',
  ].join('\n');
}

function buildShareCopy(post: SharePostDeliverable, platform: 'wechat' | 'xiaohongshu' | 'moments'): string {
  const adaptation = post.platformAdaptations[platform] || '';
  const publishForm = post.publishForms?.[platform] || {
    title: post.title,
    copy: post.copy,
    tags: post.tags,
    imageOrder: '',
  };
  const title = publishForm.title || post.title;
  const copy = publishForm.copy || post.copy;
  const tags = publishForm.tags.length ? publishForm.tags : post.tags;
  const platformAssets = platform === 'moments'
    ? post.platformVisualAssets?.moments || post.visualAssets
    : platform === 'xiaohongshu'
      ? post.platformVisualAssets?.xiaohongshu || post.visualAssets
      : post.platformVisualAssets?.xiaohongshu || post.visualAssets;
  const visualRows = platformAssets
    .map((asset) => `- ${asset.label}：${asset.status === 'ready' ? asset.path : '待采用视觉版本后生成'}`)
    .join('\n');
  if (platform === 'wechat') {
    return [
      `# 公众号观点卡 ${post.index} · ${title}`,
      '',
      '## 文内标题',
      title,
      '',
      '## 文内观点卡 / 分享配文',
      copy,
      '',
      '## 图文结构',
      ...post.pages.map((page) => `- ${page.page}：${page.title} — ${page.body}`),
      '',
      '## 插入与排版',
      adaptation || '放在对应论点之后；正文只保留一个判断，图卡按需要作为摘要卡或分享卡使用。',
      '',
      '## 视觉文件',
      visualRows || '- 采用已选择的观点卡或分享图；没有视觉版本时先发布文字观点卡。',
      '',
      '## 评论区承接',
      post.commentGuide || '把你的具体场景留在评论区。',
    ].join('\n');
  }
  if (platform === 'moments') {
    return [
      `# 朋友圈分享图文 ${post.index} · ${title}`,
      '',
      '## 配文',
      copy,
      '',
      '## 配图顺序',
      'P1–P5，使用与小红书相同的完整图文套图。',
      '',
      '## 共享图文套图',
      visualRows || '- 缺少已采用的 P1–P5 图文套图。',
      '',
      '## 发布备注',
      adaptation || '使用短配文，只保留一个判断和一个可回答的问题。',
      '',
      '## 互动句',
      post.commentGuide || '你也遇到过这个场景吗？',
    ].join('\n');
  }
  return [
    `# 小红书图文 ${post.index} · ${title}`,
    '',
    '## 封面',
    post.coverText,
    '',
    '## 正文',
    copy,
    '',
    '## 标签',
    tags.join(' '),
    '',
    '## 页卡上传顺序',
    ...post.pages.map((page) => `- ${page.page}：${page.title} — ${page.body}`),
    visualRows || '- 采用选中视觉版本的 3:4 页卡。',
    '',
    '## 发布备注',
    adaptation || '封面、正文和标签保持同一组关键词。',
    '',
    '## 评论区承接',
    post.commentGuide || '把你的具体场景留在评论区。',
  ].join('\n');
}

function buildVideoCopy(script: VideoPublishScript, platform: 'shipinhao' | 'douyin' | 'xiaohongshu'): string {
  const platformLabel = platform === 'shipinhao' ? '视频号' : platform === 'douyin' ? '抖音' : '小红书视频';
  const visualRows = script.visualAssets
    .map((asset) => `- ${asset.label}：${asset.status === 'ready' ? asset.path : '待采用视觉版本后生成'}`)
    .join('\n');
  return [
    `# ${platformLabel}短视频 ${script.index} · ${script.title}`,
    '',
    `- 发布标题：${script.title}`,
    `- 封面：${script.coverText}`,
    `- 3 秒钩子：${script.hook}`,
    `- 时长：${script.duration}`,
    '',
    '## 提词器版',
    script.teleprompterScript,
    '',
    '## 分段口播稿',
    script.oralScript,
    '',
    '## 镜头清单',
    script.shotList,
    '',
    '## 字幕重点',
    ...script.subtitleHighlights.map((item) => `- ${item}`),
    '',
    '## B-roll 素材建议',
    ...script.bRollSuggestions.map((item) => `- ${item}`),
    '',
    '## 发布正文',
    script.publishCopy,
    '',
    '## 标签/话题',
    script.tags.join(' '),
    '',
    '## 封面与视觉文件',
    visualRows || '- 使用视频封面与字幕卡的选中视觉版本。',
    '',
    '## 评论区承接',
    script.commentGuide || '把你所在的具体场景留在评论区。',
  ].join('\n');
}

function buildTeleprompter(oralScript: string): string {
  const parts = ['开场', '展开', '转折', '收口']
    .map((label) => field(oralScript, [label]))
    .filter(Boolean);
  return parts.length ? parts.join('\n\n') : oralScript;
}

function buildWechatDeliverable(input: {
  wechat: ParsedWechat;
  packagePath: string;
  slug: string;
  selectedAssets: SelectedVisualAsset[];
  layoutOptions: VisualLayoutOption[];
  fallbackHtmlPaths: string[];
}): WechatPublishDeliverable {
  const selectedHtml = input.selectedAssets.find((asset) => visualIdContains(asset, 'wechat-html'));
  const primaryCoverAssets = visualMatches(
    input.selectedAssets,
    '公众号后台封面（主题首图）',
    (asset) => asset.id === 'wechat-cover',
    `pipeline/visual/${input.slug}/publish/（采用版本后）/wechat/wechat-cover-21x9.png`,
    '上传到公众号封面位；后台封面与正文首图分开使用。',
  );
  const alternativeCoverAssets = visualMatches(
    input.selectedAssets,
    '公众号后台封面（观点备选）',
    (asset) => asset.id === 'wechat-cover-alt-01',
    `pipeline/visual/${input.slug}/publish/（采用版本后）/wechat/wechat-cover-alt-01-21x9.png`,
    '作为另一种首图策略备选；只选一个上传到公众号后台封面位。',
  );
  const conceptualCoverAssets = visualMatches(
    input.selectedAssets,
    '公众号后台封面（概念备选）',
    (asset) => asset.id === 'wechat-cover-alt-02',
    `pipeline/visual/${input.slug}/publish/（采用版本后）/wechat/wechat-cover-alt-02-21x9.png`,
    '作为概念视觉方向的首图备选；只选一个上传到公众号后台封面位。',
  );
  const firstAssets = visualMatches(
    input.selectedAssets,
    '文章首个语义图',
    (asset) => asset.id === 'inline-01' || visualIdContains(asset, 'wechat-first') || visualIdContains(asset, 'first-image'),
    `pipeline/visual/${input.slug}/publish/（采用版本后）/inline/inline-01.png`,
    '插在导语后的第一个语义锚点，不与后台封面裁切复用。',
  );
  const inlineAssets = visualMatches(
    input.selectedAssets,
    '正文语义插图',
    (asset) => visualIdContains(asset, 'inline') || asset.role.includes('illustration'),
    `pipeline/visual/${input.slug}/publish/（采用版本后）/wechat/inline/`,
    '按插图锚点插入对应小节，保持段落与图解的语义一致。',
  );
  const shareAssets = visualMatches(
    input.selectedAssets,
    '公众号分享图',
    (asset) => visualIdContains(asset, 'wechat-share'),
    `pipeline/visual/${input.slug}/publish/（采用版本后）/wechat/wechat-share-1x1.png`,
    '用于文章分享卡或朋友圈预热，不替代文章后台封面。',
  );
  const visualHtmlCandidates: WechatHtmlCandidate[] = [
    ...input.layoutOptions.map((option) => ({
      label: option.selected ? `已采用排版：${option.style}` : `排版备选：${option.style}`,
      path: option.path,
      recommended: option.selected,
    })),
    ...(selectedHtml && !input.layoutOptions.some((option) => option.path === selectedHtml.path)
      ? [{ label: '已采用视觉排版', path: selectedHtml.path, recommended: true }]
      : []),
  ];
  const htmlCandidates: WechatHtmlCandidate[] = [
    ...visualHtmlCandidates,
    ...input.fallbackHtmlPaths
      .filter((path) => path.endsWith('.html'))
      .map((path, index) => ({
        label: index === 0 ? '基础排版回退' : basename(path).replace(/\.html$/i, ''),
        path,
        recommended: visualHtmlCandidates.length === 0 && index === 0,
      })),
  ].filter((candidate, index, candidates) => candidates.findIndex((item) => item.path === candidate.path) === index);
  const visualAssets = mergeVisualAssets(primaryCoverAssets, alternativeCoverAssets, conceptualCoverAssets, firstAssets, inlineAssets, shareAssets);
  const readyCoverCount = mergeVisualAssets(primaryCoverAssets, alternativeCoverAssets, conceptualCoverAssets)
    .filter((asset) => asset.status === 'ready').length;
  const readyInlineCount = inlineAssets.filter((asset) => asset.status === 'ready').length;
  const hasAutomaticImageSuite = readyCoverCount > 0 || readyInlineCount > 0;
  const qualityIssues = [
    input.wechat.body ? '' : '公众号正文为空',
    htmlCandidates.length ? '' : '缺少可复制的公众号 HTML',
  ].filter(Boolean);
  return {
    platform: 'wechat',
    label: '公众号成稿',
    recommendedTitle: input.wechat.title,
    alternativeTitles: input.wechat.titleOptions,
    summary: input.wechat.summary,
    markdownPath: input.packagePath,
    htmlCandidates,
    visualAssets,
    coverOptions: mergeVisualAssets(primaryCoverAssets, alternativeCoverAssets, conceptualCoverAssets),
    copyText: buildWechatCopy(input.wechat, htmlCandidates.find((item) => item.recommended)?.path || ''),
    sharePosts: [],
    shareCopyText: '',
    shareCopyPaths: [],
    publishChecks: [
      input.wechat.layoutHint || '使用已采用的公众号 HTML，不混用多个排版版本。',
      '复制到微信公众号后台后，先在手机预览中检查段落、字号、链接和留白。',
      hasAutomaticImageSuite
        ? `自动发布件包含 ${readyCoverCount} 张封面和 ${readyInlineCount} 张正文配图；确认图意、裁切与插入位置。`
        : '当前选择仅排版；只保留原文中的已授权图片，不新增封面或正文图。',
      hasAutomaticImageSuite
        ? '概念图只用于辅助理解，不得被当作事实证据、产品截图或研究数据。'
        : '公众号官方接口需要封面；未生成封面时将改用已登录的浏览器草稿编辑器。',
    ],
    qualityStatus: qualityIssues.length ? 'needs_review' : 'ready',
    qualityIssues,
  };
}

function buildSharePosts(input: {
  shares: ParsedSharePost[];
  slug: string;
  selectedAssets: SelectedVisualAsset[];
  assetDir: string;
}): SharePostDeliverable[] {
  return input.shares.map((share) => {
    const xhsAssets = visualMatches(
      input.selectedAssets,
      `小红书套图 ${share.index}`,
      (asset) => new RegExp(`^xhs-0?${share.index}-p[1-8]$`, 'i').test(asset.id),
      `pipeline/visual/${input.slug}/publish/（采用版本后）/xhs/post-${String(share.index).padStart(2, '0')}/`,
      '按内容包声明的页序上传到小红书。',
    );
    const momentsAssets = visualMatches(
      input.selectedAssets,
      `朋友圈方图 ${share.index}`,
      (asset) => new RegExp(`^moments-0?${share.index}-p(?:1|3|5)$`, 'i').test(asset.id),
      `pipeline/visual/${input.slug}/publish/（采用版本后）/moments/post-${String(share.index).padStart(2, '0')}/`,
      '按 P1、P3、P5 顺序上传 3 张 1:1 方图。',
    );
    const post: SharePostDeliverable = {
      index: share.index,
      label: share.heading,
      title: share.title,
      coverText: share.coverText,
      coreViewpoint: share.coreViewpoint,
      copy: share.copy,
      tags: extractTags(share.copy, share.title, ['#内容表达', '#观点分享']),
      pages: share.pages,
      platformAdaptations: share.platformAdaptations,
      publishForms: {
        wechat: {
          title: share.publishForms.wechat.title || share.title,
          copy: share.publishForms.wechat.copy || share.copy,
          tags: [],
          imageOrder: '',
        },
        moments: {
          title: share.title,
          copy: share.publishForms.moments.copy || share.copy,
          tags: [],
          imageOrder: 'P1、P3、P5',
        },
        xiaohongshu: {
          title: share.publishForms.xiaohongshu.title || share.title,
          copy: share.publishForms.xiaohongshu.copy || share.copy,
          tags: extractTags(
            share.publishForms.xiaohongshu.tags || share.copy,
            share.publishForms.xiaohongshu.title || share.title,
            ['#内容表达', '#观点分享'],
          ),
          imageOrder: '',
        },
      },
      publishCopies: { wechat: '', moments: '', xiaohongshu: '' },
      publishPaths: { wechat: '', moments: '', xiaohongshu: '' },
      commentGuide: share.commentGuide,
      visualAssets: mergeVisualAssets(xhsAssets, momentsAssets),
      platformVisualAssets: {
        xiaohongshu: xhsAssets,
        moments: momentsAssets,
      },
    };
    return post;
  });
}

function videoPlatformLabel(platform: VideoPublishPlatform): string {
  if (platform === 'shipinhao') return '视频号';
  if (platform === 'douyin') return '抖音';
  return '小红书';
}

function videoExecutionIssues(script: VideoPublishScript): string[] {
  return [
    script.title ? '' : `${script.label} 缺少发布标题`,
    script.coverText ? '' : `${script.label} 缺少封面文案或画面`,
    script.hook ? '' : `${script.label} 缺少 3 秒钩子`,
    script.duration ? '' : `${script.label} 缺少建议时长`,
    script.oralScript ? '' : `${script.label} 缺少分段口播稿`,
    script.shotList ? '' : `${script.label} 缺少镜头清单`,
    script.subtitleHighlights.length ? '' : `${script.label} 缺少字幕重点`,
    script.bRollSuggestions.length ? '' : `${script.label} 缺少 B-roll 素材建议`,
  ].filter(Boolean);
}

function videoPublishFormIssues(video: ParsedVideo, platform: VideoPublishPlatform): string[] {
  const form = video.publishForms[platform];
  const label = `${videoPlatformLabel(platform)}短视频 ${video.index}`;
  return [
    form.title ? '' : `${label} 缺少发布标题`,
    form.copy ? '' : `${label} 缺少发布正文`,
    form.tags ? '' : `${label} 缺少标签/话题`,
    form.cover ? '' : `${label} 缺少封面画面`,
  ].filter(Boolean);
}

function buildVideoDeliverable<TPlatform extends VideoPublishPlatform>(input: {
  platform: TPlatform;
  videos: ParsedVideo[];
  slug: string;
  selectedAssets: SelectedVisualAsset[];
}): (VideoPublishBundle & { platform: TPlatform }) | undefined {
  if (!input.videos.length) return undefined;
  const label = input.platform === 'shipinhao'
    ? '视频号发布成稿'
    : input.platform === 'douyin'
      ? '抖音发布成稿'
      : '小红书视频发布表单';
  const scripts = input.videos.map((video) => {
    // Short-video covers are a copy/shooting instruction only for now. The
    // visual pipeline deliberately does not generate or require cover files.
    const assets: PublishVisualAsset[] = [];
    const platformNote = video.platformNotes[input.platform] || '';
    const publishForm = video.publishForms[input.platform];
    const title = publishForm.title || video.title;
    const coverText = publishForm.cover || video.coverText;
    const publishCopy = publishForm.copy || platformNote || `${title}\n${video.hook}`;
    const tags = extractTags(
      publishForm.tags || publishCopy,
      title,
      input.platform === 'shipinhao'
        ? ['#视频号', '#内容表达']
        : input.platform === 'douyin'
          ? ['#抖音', '#口播']
          : ['#小红书', '#口播'],
    );
    return {
      index: video.index,
      label: video.heading,
      title,
      coverText,
      hook: video.hook,
      duration: video.duration,
      oralScript: video.oralScript,
      teleprompterScript: buildTeleprompter(video.oralScript),
      shotList: video.shotList,
      subtitleHighlights: video.subtitles,
      bRollSuggestions: video.bRoll,
      publishCopy,
      tags,
      platformNote,
      commentGuide: video.commentGuide,
      visualAssets: assets,
    };
  });
  const issues = [
    ...scripts.flatMap((script) => videoExecutionIssues(script)),
    ...input.videos.flatMap((video) => videoPublishFormIssues(video, input.platform)),
  ];
  return {
    platform: input.platform,
    label,
    scripts,
    visualAssets: scripts.flatMap((script) => script.visualAssets),
    copyText: scripts.map((script) => buildVideoCopy(script, input.platform)).join('\n\n---\n\n'),
    publishChecks: [
      '封面文案、前三秒钩子、第一句字幕必须是同一个判断，不用标题党替换口播承诺。',
      '拍摄前按镜头清单准备 B-roll；没有真实素材时不把概念图当事实证据。',
      input.platform === 'shipinhao'
        ? '视频号正文保持判断与场景，发布后用置顶评论承接读者的具体问题。'
        : input.platform === 'douyin'
          ? '抖音先检查前三秒节奏与字幕断句，标题和话题不承诺确定结果。'
          : '小红书视频的标题、正文、标签、封面和口播稿必须使用同一条判断，不以图文稿替代视频表单。',
    ],
    qualityStatus: issues.length ? 'needs_review' : 'ready',
    qualityIssues: issues,
  };
}

async function generateFallbackWechatHtml(
  assetDir: string,
  slug: string,
  wechat: ParsedWechat,
): Promise<string[]> {
  const sourceRelPath = `${assetDir}/wechat-source.md`;
  const source = [
    `# ${wechat.title}`,
    '',
    wechat.body,
  ].join('\n');
  await writeOutputFile(sourceRelPath, source);
  const sourceAbsPath = safeResolve(PROJECT_DIR, sourceRelPath);
  const outputDir = `${assetDir}/wechat-html`;
  const outputAbsPath = safeResolve(PROJECT_DIR, outputDir);
  if (!sourceAbsPath || !outputAbsPath) throw new Error('公众号排版输出路径非法');
  try {
    await execFileAsync(runtimePythonBinary(), [
      DBS_WECHAT_HTML_SCRIPT,
      '--input', sourceAbsPath,
      '--output-dir', outputAbsPath,
      '--style', DBS_WECHAT_FALLBACK_STYLE[0],
    ], {
      cwd: INSTALL_ROOT,
      maxBuffer: 1024 * 1024 * 4,
      timeout: 30_000,
    });
    return generatedDbsPaths(sourceRelPath, outputDir);
  } catch {
    return [];
  }
}

function buildPublishAssetsReport(input: {
  title: string;
  packagePath?: string;
  visualPlanPath?: string;
  generatedPaths: string[];
  platformDeliverables: PlatformDeliverables;
}): string {
  const { wechat, xiaohongshu, moments, shipinhao, douyin } = input.platformDeliverables;
  const assetRows = (assets: PublishVisualAsset[]) => assets
    .map((asset) => `- ${asset.label}：${asset.status === 'ready' ? asset.path : '选择配图方案后生成'}`)
    .join('\n');
  const sections = [
    wechat ? `## 1. 公众号
- 标题：${wechat.recommendedTitle}
- 摘要：${wechat.summary}
- 推荐排版：${wechat.htmlCandidates.find((item) => item.recommended)?.path || '待采用'}
- 视觉：\n${assetRows(wechat.visualAssets)}

### 文内观点卡 / 分享配文
${wechat.sharePosts.map((post, index) => `- 观点 ${post.index}：${post.publishForms.wechat.title || post.title}（${wechat.shareCopyPaths[index] || '待生成可复制稿'}）`).join('\n')}` : '',
    xiaohongshu ? `## 2. 小红书
${xiaohongshu.posts.map((post) => `- 图文 ${post.index}：${post.title}（${post.primaryPath || '待生成可复制稿'}）`).join('\n')}
- 配图：${xiaohongshu.visualAssets.filter((asset) => asset.status === 'ready').length ? '已使用所选方案' : '请先选择配图方案'}

### 小红书视频发布表单
${xiaohongshu.videoScripts.map((script, index) => `- 短视频 ${script.index}：标题「${script.title}」；封面「${script.coverText}」；标签 ${script.tags.join(' ')}；口播 ${script.oralScript ? '已附' : '缺失'}（${xiaohongshu.videoCopyPaths[index] || '待生成可复制稿'}）`).join('\n')}` : '',
    moments ? `## 3. 朋友圈
${moments.posts.map((post) => `- 分享 ${post.index}：${post.title}（${post.publishPaths.moments || '待生成可复制稿'}）`).join('\n')}
- 朋友圈方图：${moments.visualAssets.filter((asset) => asset.status === 'ready').length}/9 张已绑定；${moments.qualityStatus === 'ready' ? '可直接上传' : '需补齐后发布'}` : '',
    shipinhao ? `## 4. 视频号
${shipinhao.scripts.map((script) => `- 短视频 ${script.index}：${script.title}（${script.primaryPath || '待生成可复制稿'}）`).join('\n')}` : '',
    douyin ? `## 5. 抖音
${douyin.scripts.map((script) => `- 短视频 ${script.index}：${script.title}（${script.primaryPath || '待生成可复制稿'}）`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  return `# 平台发布成稿 · ${input.title}

## 0. 发布总览
本期只交付用户已选平台的原生成稿。各平台共享事实依据，但标题、结构和表达分别生产；复制、上传或排版前，只检查该平台需要的内容与视觉资产。

${sections}

## 6. 发布前检查
- 公众号：打开已采用的 HTML，复制到微信后台并在手机端预览；头图仅使用已授权素材。
- 小红书：按图文页序上传，封面三句话、正文、卡片和结尾标签保持同一判断。
- 视频号：按原生口播稿使用提词器、镜头和字幕重点；视觉阶段不额外生成视频封面或画面资产。
- 所有平台：硬数字、客户身份、截图和案例必须通过可信审核后再发布。

## 文件信息
- 全部内容文件：${input.packagePath || '兼容旧版输入'}
- 配图记录：${input.visualPlanPath || '还没有选择'}
- 已生成文件：
${input.generatedPaths.map((path) => `  - ${path}`).join('\n')}`;
}

async function generateNativePublishAssets(input: {
  request: PublishAssetsInput;
  parsed: ParsedPackage;
  packagePath: string;
  packageRaw: string;
  slug: string;
  assetDir: string;
  selectedVisual: SelectedVisualBundle;
  languageWarnings: GeneratedLanguageFinding[];
}): Promise<PublishAssetsResult> {
  const selected = new Set(input.parsed.selectedPlatforms || []);
  const selectedAssets = input.selectedVisual.assets;
  const generatedPaths: string[] = [];
  let wechat: WechatPublishDeliverable | undefined;
  let xiaohongshu: XhsPublishDeliverable | undefined;
  let shipinhao: VideoPublishDeliverable | undefined;

  if (selected.has('wechat')) {
    const hasSelectedWechatHtml = selectedAssets.some((asset) => (
      visualIdContains(asset, 'wechat-html') && /\.html?$/i.test(asset.path)
    ));
    const fallbackHtmlPaths = hasSelectedWechatHtml
      ? []
      : await generateFallbackWechatHtml(input.assetDir, input.slug, input.parsed.wechat);
    wechat = buildWechatDeliverable({
      wechat: input.parsed.wechat,
      packagePath: input.packagePath,
      slug: input.slug,
      selectedAssets,
      layoutOptions: input.selectedVisual.layoutOptions,
      fallbackHtmlPaths,
    });
    const copyPath = `${input.assetDir}/wechat-publish.md`;
    await writeOutputFile(copyPath, wechat.copyText);
    generatedPaths.push(...(fallbackHtmlPaths.length ? [`${input.assetDir}/wechat-source.md`, ...fallbackHtmlPaths] : []), copyPath);
  }

  const xhsCopyPaths: string[] = [];
  if (selected.has('xhs')) {
    const posts = buildSharePosts({ shares: input.parsed.shares, slug: input.slug, selectedAssets, assetDir: input.assetDir });
    const copies: string[] = [];
    for (const post of posts) {
      const original = input.parsed.shares.find((share) => share.index === post.index)!;
      post.publishForms.xiaohongshu.tags = original.publishForms.xiaohongshu.tags.trim().split(/\s+/).filter(Boolean);
      post.tags = post.publishForms.xiaohongshu.tags;
      post.publishForms.xiaohongshu.imageOrder = 'P1-P8';
      const copyPath = `${input.assetDir}/xiaohongshu-${String(post.index).padStart(2, '0')}.txt`;
      // This exact file is sent to the editor. Layout notes and paths stay in the separate report.
      const copy = `${post.publishForms.xiaohongshu.copy}\n\n${original.publishForms.xiaohongshu.tags}`;
      post.primaryPath = copyPath;
      post.publishPaths = { wechat: '', moments: '', xiaohongshu: copyPath };
      post.publishCopies = { wechat: '', moments: '', xiaohongshu: copy };
      await writeOutputFile(copyPath, copy);
      xhsCopyPaths.push(copyPath);
      generatedPaths.push(copyPath);
      copies.push(copy);
    }
    const visualAssets = posts.flatMap((post) => post.platformVisualAssets?.xiaohongshu || post.visualAssets);
    const issues = posts.flatMap((post) => {
      const ready = (post.platformVisualAssets?.xiaohongshu || post.visualAssets).filter((asset) => asset.status === 'ready');
      return [post.pages.length === 8 ? '' : `小红书图文 ${post.index} 缺少 P1-P8 卡片结构`, ready.length === 8 ? '' : `小红书图文 ${post.index} 缺少 P1-P8 完整套图`].filter(Boolean);
    });
    xiaohongshu = {
      platform: 'xiaohongshu',
      label: '小红书原生图文',
      coverTitle: posts[0]?.coverText || '',
      firstThreeLines: posts[0]?.coverText.split('/').map((line) => line.trim()).filter(Boolean).slice(0, 3) || [],
      cardPlan: posts.flatMap((post) => post.pages.map((page) => `${page.page}：${page.title}`)),
      bodyCopy: posts.map((post) => post.publishForms.xiaohongshu.copy).join('\n\n'),
      tags: Array.from(new Set(posts.flatMap((post) => post.publishForms.xiaohongshu.tags))).slice(0, 12),
      commentGuide: posts[0]?.commentGuide || '',
      posts,
      videoScripts: [],
      videoCopyText: '',
      videoCopyPaths: [],
      videoVisualAssets: [],
      visualAssets,
      copyText: copies.join('\n\n---\n\n'),
      publishChecks: ['按 P1-P8 核对页序与文字裁切。', '封面三句话、正文、卡片与结尾标签保持同一判断。'],
      qualityStatus: issues.length ? 'needs_review' : 'ready',
      qualityIssues: issues,
    };
  }

  const shipinhaoCopyPaths: string[] = [];
  if (selected.has('shipinhao')) {
    shipinhao = buildVideoDeliverable({ platform: 'shipinhao', videos: input.parsed.videos, slug: input.slug, selectedAssets });
    if (!shipinhao) throw new Error('视频号原生口播不存在，无法生成发布文件。');
    shipinhao.qualityIssues = shipinhao.qualityIssues.filter((issue) => !issue.includes('B-roll'));
    shipinhao.qualityStatus = shipinhao.qualityIssues.length ? 'needs_review' : 'ready';
    for (const script of shipinhao.scripts) {
      script.teleprompterScript = spokenScript(script.oralScript).text;
      const copyPath = `${input.assetDir}/shipinhao-native-${String(script.index).padStart(2, '0')}.md`;
      script.primaryPath = copyPath;
      await writeOutputFile(copyPath, buildVideoCopy(script, 'shipinhao'));
      shipinhaoCopyPaths.push(copyPath);
      generatedPaths.push(copyPath);
    }
  }

  const reportPath = `${input.assetDir.replace(/\/$/, '')}-publish-assets.md`;
  const deliverablesJsonPath = `${input.assetDir.replace(/\/$/, '')}-platform-deliverables.json`;
  const platformDeliverables: PlatformDeliverables = {
    ...(wechat ? { wechat } : {}),
    ...(xiaohongshu ? { xiaohongshu } : {}),
    ...(shipinhao ? { shipinhao } : {}),
    archive: {
      reportPath,
      generatedPaths: [],
      packagePath: input.packagePath,
      wechatHtmlOverview: wechat?.htmlCandidates.find((item) => item.recommended)?.path,
      xhsCopyPaths,
      shipinhaoCopyPaths,
      languageWarnings: input.languageWarnings,
    },
  };
  const markdown = buildPublishAssetsReport({
    title: input.request.topic?.trim() || input.parsed.title,
    packagePath: input.packagePath,
    visualPlanPath: input.request.visualPlanPath,
    generatedPaths,
    platformDeliverables,
  });
  await writeOutputFile(reportPath, markdown);
  generatedPaths.push(reportPath, deliverablesJsonPath);
  platformDeliverables.archive.generatedPaths = [...generatedPaths];
  await writeOutputFile(deliverablesJsonPath, JSON.stringify(platformDeliverables, null, 2));
  return {
    slug: input.slug,
    reportPath,
    markdown,
    generatedPaths,
    wechatHtmlOverview: platformDeliverables.archive.wechatHtmlOverview,
    platformDeliverables,
    languageWarnings: input.languageWarnings,
  };
}

export async function generatePublishAssets(input: PublishAssetsInput): Promise<PublishAssetsResult> {
  const packagePath = input.packagePath || '';
  const packageRaw = packagePath ? await readOutputFile(packagePath) : '';
  const legacyWrite = input.writePath ? await readOutputFile(input.writePath) : '';
  const legacyXhs = input.xhsPath ? await readOutputFile(input.xhsPath) : '';
  const parsed = packageRaw
    ? parsePackage(packageRaw)
    : parseLegacyPackage({ topic: input.topic, write: legacyWrite, xhs: legacyXhs });
  const sourceLanguage = inspectGeneratedLanguage(
    packageRaw || [legacyWrite, legacyXhs].filter(Boolean).join('\n\n'),
  );
  if (sourceLanguage.blocking.length) {
    throw new KnownUserFacingError({
      error: '发布内容里还有对话式说明或敏感信息，已停止生成。请重新生成全部内容。',
      code: 'generated_language_blocked',
      action: { label: '重新生成全部内容', href: '/production?stage=3' },
    }, { status: 409, detail: sourceLanguage.blocking });
  }
  const slug = sanitizeSlug(input.slug || slugFromPath(packagePath || input.writePath || input.xhsPath || 'publish-assets'));
  const assetDir = `pipeline/publish-assets/${slug}`;
  const selectedVisual = await selectedVisualAssets(slug);
  if (input.visualPlanPath && (!selectedVisual.sourceContentHash || selectedVisual.assets.length === 0)) {
    throw new Error('已确认的平台成品清单无法读取或校验失败。请重新确认公众号排版或小红书图文卡片。');
  }
  if (packageRaw && selectedVisual.sourceContentHash
    && visualAssetDigest(Buffer.from(packageRaw, 'utf-8')) !== selectedVisual.sourceContentHash) {
    throw new Error('已采用的视觉资产不再匹配当前内容包，请重新确认视觉资产。');
  }
  const selectedAssets = selectedVisual.assets;
  const generatedPaths: string[] = [];

  if (parsed.native) {
    return generateNativePublishAssets({
      request: input,
      parsed,
      packagePath,
      packageRaw,
      slug,
      assetDir,
      selectedVisual,
      languageWarnings: sourceLanguage.warnings,
    });
  }

  const fallbackHtmlPaths = await generateFallbackWechatHtml(assetDir, slug, parsed.wechat);
  const wechat = buildWechatDeliverable({
    wechat: parsed.wechat,
    packagePath: packagePath || input.writePath || '',
    slug,
    selectedAssets,
    layoutOptions: selectedVisual.layoutOptions,
    fallbackHtmlPaths,
  });
  const wechatCopyPath = `${assetDir}/wechat-publish.md`;
  await writeOutputFile(wechatCopyPath, wechat.copyText);
  generatedPaths.push(`${assetDir}/wechat-source.md`, ...fallbackHtmlPaths, wechatCopyPath);

  const sharePosts = buildSharePosts({
    shares: parsed.shares,
    slug,
    selectedAssets,
    assetDir,
  });
  const wechatShareCopyPaths: string[] = [];
  const xhsCopyPaths: string[] = [];
  const momentsCopyPaths: string[] = [];
  const wechatShareCopies: string[] = [];
  const xhsCopies: string[] = [];
  const momentsCopies: string[] = [];
  for (const post of sharePosts) {
    const wechatPath = `${assetDir}/wechat-share-${String(post.index).padStart(2, '0')}.md`;
    const xhsPath = `${assetDir}/xiaohongshu-${String(post.index).padStart(2, '0')}.md`;
    const momentsPath = `${assetDir}/moments-${String(post.index).padStart(2, '0')}.md`;
    const wechatShareCopy = buildShareCopy(post, 'wechat');
    const xhsCopy = buildShareCopy(post, 'xiaohongshu');
    const momentsCopy = buildShareCopy(post, 'moments');
    post.primaryPath = xhsPath;
    post.publishPaths = { wechat: wechatPath, xiaohongshu: xhsPath, moments: momentsPath };
    post.publishCopies = { wechat: wechatShareCopy, xiaohongshu: xhsCopy, moments: momentsCopy };
    await Promise.all([
      writeOutputFile(wechatPath, wechatShareCopy),
      writeOutputFile(xhsPath, xhsCopy),
      writeOutputFile(momentsPath, momentsCopy),
    ]);
    wechatShareCopyPaths.push(wechatPath);
    xhsCopyPaths.push(xhsPath);
    momentsCopyPaths.push(momentsPath);
    wechatShareCopies.push(wechatShareCopy);
    xhsCopies.push(xhsCopy);
    momentsCopies.push(momentsCopy);
    generatedPaths.push(wechatPath, xhsPath, momentsPath);
  }
  wechat.sharePosts = sharePosts;
  wechat.shareCopyPaths = wechatShareCopyPaths;
  wechat.shareCopyText = wechatShareCopies.join('\n\n---\n\n');
  const wechatShareIssues = parsed.shares.flatMap((share) => [
    share.publishForms.wechat.title ? '' : `观点图文 ${share.index} 缺少公众号文内标题`,
    share.publishForms.wechat.copy ? '' : `观点图文 ${share.index} 缺少公众号配文`,
  ]).filter(Boolean);
  if (wechatShareIssues.length) {
    wechat.qualityStatus = 'needs_review';
    wechat.qualityIssues.push(...wechatShareIssues);
  }
  const xhsVisualAssets = sharePosts.flatMap((post) => post.platformVisualAssets?.xiaohongshu || post.visualAssets);
  const momentsVisualAssets = sharePosts.flatMap((post) => post.platformVisualAssets?.moments || post.visualAssets);
  const momentsIssues = [
    ...parsed.shares.flatMap((share) => [
      share.publishForms.moments.copy ? '' : `观点图文 ${share.index} 缺少朋友圈短文案`,
      share.publishForms.moments.imageOrder ? '' : `观点图文 ${share.index} 缺少朋友圈图序`,
    ]),
    ...sharePosts.flatMap((post) => {
      const readyPages = (post.platformVisualAssets?.moments || post.visualAssets)
        .filter((asset) => asset.status === 'ready');
      return readyPages.length === 3
        ? []
        : [`观点图文 ${post.index} 缺少朋友圈 P1、P3、P5 三张方图`];
    }),
  ].filter(Boolean);

  const shipinhao = buildVideoDeliverable({ platform: 'shipinhao', videos: parsed.videos, slug, selectedAssets });
  const douyin = buildVideoDeliverable({ platform: 'douyin', videos: parsed.videos, slug, selectedAssets });
  const xhsVideo = buildVideoDeliverable({ platform: 'xiaohongshu', videos: parsed.videos, slug, selectedAssets });
  const shipinhaoCopyPaths: string[] = [];
  const douyinCopyPaths: string[] = [];
  const xhsVideoCopyPaths: string[] = [];
  for (const script of shipinhao?.scripts || []) {
    const path = `${assetDir}/shipinhao-short-${String(script.index).padStart(2, '0')}.md`;
    script.primaryPath = path;
    await writeOutputFile(path, buildVideoCopy(script, 'shipinhao'));
    shipinhaoCopyPaths.push(path);
    generatedPaths.push(path);
  }
  for (const script of douyin?.scripts || []) {
    const path = `${assetDir}/douyin-short-${String(script.index).padStart(2, '0')}.md`;
    script.primaryPath = path;
    await writeOutputFile(path, buildVideoCopy(script, 'douyin'));
    douyinCopyPaths.push(path);
    generatedPaths.push(path);
  }
  for (const script of xhsVideo?.scripts || []) {
    const path = `${assetDir}/xiaohongshu-video-short-${String(script.index).padStart(2, '0')}.md`;
    script.primaryPath = path;
    await writeOutputFile(path, buildVideoCopy(script, 'xiaohongshu'));
    xhsVideoCopyPaths.push(path);
    generatedPaths.push(path);
  }

  const xhsShareIssues = sharePosts.flatMap((post) => [
    post.pages.length < 5 ? `观点图文 ${post.index} 缺少完整页卡结构` : '',
    (post.platformVisualAssets?.xiaohongshu || post.visualAssets).filter((asset) => asset.status === 'ready').length !== 5
      ? `观点图文 ${post.index} 缺少小红书 P1–P5 完整套图`
      : '',
  ]).filter(Boolean);
  const xiaohongshu: XhsPublishDeliverable = {
    platform: 'xiaohongshu',
    label: '小红书发布成稿',
    coverTitle: sharePosts[0]?.coverText || parsed.wechat.coverText,
    firstThreeLines: [sharePosts[0]?.coverText || parsed.wechat.coverText, sharePosts[0]?.coreViewpoint || '', sharePosts[0]?.title || ''].filter(Boolean).slice(0, 3),
    cardPlan: sharePosts.flatMap((post) => post.pages.map((page) => `观点 ${post.index} ${page.page}：${page.title}`)),
    bodyCopy: sharePosts.map((post) => post.publishForms.xiaohongshu.copy || post.copy).join('\n\n'),
    tags: Array.from(new Set(sharePosts.flatMap((post) => post.publishForms.xiaohongshu.tags))).slice(0, 12),
    commentGuide: sharePosts[0]?.commentGuide || '',
    posts: sharePosts,
    videoScripts: xhsVideo?.scripts || [],
    videoCopyText: xhsVideo?.copyText || '',
    videoCopyPaths: xhsVideoCopyPaths,
    videoVisualAssets: xhsVideo?.visualAssets || [],
    visualAssets: xhsVisualAssets,
    copyText: [...xhsCopies, xhsVideo?.copyText || ''].filter(Boolean).join('\n\n---\n\n'),
    publishChecks: [
      '每条观点图文单独发布，首图、标题、正文、标签使用同一个判断。',
      '上传图片前按 P1-P5 核对文字裁切和页序。',
      '小红书视频必须使用独立的视频标题、正文、标签、封面和口播稿，不以图文发布稿替代。',
      '发布后使用对应的评论区承接，不把公众号长文整段照搬进笔记。',
    ],
    qualityStatus: xhsShareIssues.length || (xhsVideo?.qualityIssues.length || 0) ? 'needs_review' : 'ready',
    qualityIssues: [...xhsShareIssues, ...(xhsVideo?.qualityIssues || [])],
  };
  const moments: MomentsPublishDeliverable = {
    platform: 'moments',
    label: '朋友圈分享成稿',
    posts: sharePosts,
    visualAssets: momentsVisualAssets,
    copyText: momentsCopies.join('\n\n---\n\n'),
    publishChecks: [
      '每次选择一条观点作为主配文；不要把三条图文和长文同时堆进一条朋友圈。',
      '每条使用独立的 P1、P3、P5 三张 1:1 方图，按编号顺序上传。',
      '朋友圈不使用夸大 CTA，互动只收集可公开的具体场景。',
    ],
    qualityStatus: sharePosts.length === 3 && momentsIssues.length === 0 ? 'ready' : 'needs_review',
    qualityIssues: [
      ...(sharePosts.length === 3 ? [] : ['朋友圈缺少三条观点分享稿']),
      ...momentsIssues,
    ],
  };

  const reportPath = `pipeline/publish-assets/${slug}-publish-assets.md`;
  const deliverablesJsonPath = `pipeline/publish-assets/${slug}-platform-deliverables.json`;
  const platformDeliverables: PlatformDeliverables = {
    wechat,
    xiaohongshu,
    moments,
    ...(shipinhao ? { shipinhao } : {}),
    ...(douyin ? { douyin } : {}),
    archive: {
      reportPath,
      generatedPaths: [],
      packagePath: packagePath || input.writePath,
      wechatHtmlOverview: wechat.htmlCandidates.find((item) => item.recommended)?.path,
      wechatShareCopyPaths,
      xhsCopyPaths,
      xhsVideoCopyPaths,
      momentsCopyPaths,
      shipinhaoCopyPaths,
      douyinCopyPaths,
      languageWarnings: sourceLanguage.warnings,
    },
  };
  const markdown = buildPublishAssetsReport({
    title: input.topic?.trim() || parsed.wechat.title || parsed.title,
    packagePath: packagePath || input.writePath,
    visualPlanPath: input.visualPlanPath,
    generatedPaths,
    platformDeliverables,
  });
  await writeOutputFile(reportPath, markdown);
  generatedPaths.push(reportPath, deliverablesJsonPath);
  platformDeliverables.archive.generatedPaths = [...generatedPaths];
  await writeOutputFile(deliverablesJsonPath, JSON.stringify(platformDeliverables, null, 2));

  return {
    slug,
    reportPath,
    markdown,
    generatedPaths,
    wechatHtmlOverview: platformDeliverables.archive.wechatHtmlOverview,
    platformDeliverables,
    languageWarnings: sourceLanguage.warnings,
  };
}
