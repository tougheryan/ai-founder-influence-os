'use client';

import { Check, ChevronDown, CircleAlert, ExternalLink, FileText, ImageIcon, LoaderCircle, RefreshCw, Video } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TechnicalDetailList, TechnicalDetails } from '@/components/TechnicalDetails';
import { displayClientError } from '@/lib/client-error-copy';
import { outputHref } from '@/lib/output-links';
import { readableArticleFromPackage } from '@/lib/readable-article';
import { contentSections, inspectPublishingSections, type ContentSection, type ContentSelectionRequest, type PublishingEditRequest, type PublishingIssue } from '@/lib/content-editing';
import { PublishingCopyNotice } from './PublishingCopyNotice';
import { ReadableArticleActions } from './ReadableArticleActions';
import { SelectableArticleBody } from './SelectableArticleBody';
import { readerFieldBinding, readerTableRows, uniqueReaderSection, type ContentReaderBinding } from '@/lib/content-reader-bindings';
import { readNativeXhsCopy, readNativeField, nativePlatforms as parseNativePlatforms, type NativeXhsCopy } from '@/electron/native-xhs-copy.cjs';
import { spokenScript } from '@/lib/publication-text';

const UNIT_DEFINITIONS = [
  { id: 'article', label: '公众号文章', detail: '标题、摘要、正文和排版' },
  { id: 'video-1', label: '视频稿 1', detail: '口播、镜头、字幕和补充画面' },
  { id: 'video-2', label: '视频稿 2', detail: '口播、镜头、字幕和补充画面' },
  { id: 'opinion-1', label: '图文卡片 1', detail: '5 张卡片和各平台配文' },
  { id: 'opinion-2', label: '图文卡片 2', detail: '5 张卡片和各平台配文' },
  { id: 'opinion-3', label: '图文卡片 3', detail: '5 张卡片和各平台配文' },
] as const;

export type ContentPackageReviewUnit = 'article' | 'video-1' | 'video-2' | `opinion-${number}`;
export type ContentPackageReviewChecks = Partial<Record<ContentPackageReviewUnit, boolean>>;
const EMPTY_CHECKS: ContentPackageReviewChecks = {};
export type ContentPackageReviewLoadStatus = 'idle' | 'loading' | 'ready' | 'invalid' | 'error';

export type ContentPackageReviewProps = {
  /** The runtime-owned package artifact, for example pipeline/package/topic.md. */
  packagePath?: string | null;
  /** Controlled, per-deliverable human review checks, scoped to packagePath by the parent. */
  checked: ContentPackageReviewChecks;
  onChange: (unit: ContentPackageReviewUnit, checked: boolean) => void;
  /** True only after a structurally complete package has all six checks. */
  onReadyChange?: (ready: boolean) => void;
  onEdit?: () => void;
  onEditIssue?: (request: PublishingEditRequest) => void;
  onEditSelection?: (request: ContentSelectionRequest, container?: HTMLElement) => void;
  editDisabled?: boolean;
  readerEditing?: boolean;
  readOnly?: boolean;
};

type TableRow = Record<string, string>;

export type ContentPackageReviewPage = {
  page: string;
  title: string;
  body: string;
  imagePrompt: string;
  visualHierarchy: string;
  layoutNote: string;
};

export type ContentPackageReviewArticle = {
  title: string;
  titleOptions: string[];
  coverText: string;
  summary: string;
  layoutHint: string;
  imageSlots: string;
  body: string;
  commentGuide: string;
};

export type ContentPackageReviewVideo = {
  index: number;
  heading: string;
  title: string;
  coverText: string;
  hook: string;
  duration: string;
  oralScript: string;
  lineScript: string;
  shotList: string;
  subtitles: string[];
  bRoll: string[];
  platformForms: Record<'shipinhao' | 'douyin' | 'xiaohongshu', ContentPackageReviewPlatformForm>;
};

export type ContentPackageReviewOpinion = {
  index: number;
  heading: string;
  title: string;
  coverText: string;
  coreViewpoint: string;
  copy: string;
  pages: ContentPackageReviewPage[];
  platformForms: Record<'wechat' | 'moments' | 'xiaohongshu', ContentPackageReviewPlatformForm>;
};

export type ContentPackageReviewPlatformForm = {
  title: string;
  copy: string;
  tags: string;
  imageOrder: string;
};

export type ParsedContentPackageReview = {
  title: string;
  article: ContentPackageReviewArticle;
  videos: ContentPackageReviewVideo[];
  opinions: ContentPackageReviewOpinion[];
  nativePlatforms?: Array<'wechat' | 'xhs' | 'shipinhao'>;
};

export type ContentPackageReviewParseResult = {
  package: ParsedContentPackageReview | null;
  errors: string[];
};

type PackageLoadState = {
  requestKey: string;
  status: ContentPackageReviewLoadStatus;
  package: ParsedContentPackageReview | null;
  errors: string[];
  publishingIssues?: PublishingIssue[];
  sha256?: string;
  articleSection?: ContentSection;
  readerSections?: ContentSection[];
};

type NativeReaderProps = {
  path: string; sha256: string; readerSections?: ContentSection[];
  onEditSelection?: ContentPackageReviewProps['onEditSelection']; editDisabled?: boolean;
};

function NativeReaderText({ binding, value, label, path, sha256, onEditSelection, editDisabled, readOnly }: NativeReaderProps & {
  binding?: ContentReaderBinding; value: string; label: string; readOnly?: boolean;
}) {
  return !readOnly && binding && sha256 && onEditSelection
    ? <SelectableArticleBody {...binding} path={path} sha256={sha256} label={label} compact disabled={editDisabled} onEdit={onEditSelection} />
    : <p className="whitespace-pre-wrap text-sm leading-7 text-[#303030]">{value}</p>;
}

export function displayReviewError(error: unknown): string {
  return displayClientError(error, '本期内容没有读取成功。请重新生成后再试。')
    .replace(/短视频口播稿/g, '视频稿')
    .replace(/分享观点图文|观点图文/g, '图文卡片')
    .replace(/补充画面素材建议/g, '补充画面建议')
    .replace(/三平台发布表单/g, '各平台发布内容')
    .replace(/P1-P5 页卡脚本/g, '5 张卡片内容')
    .replace(/发布字段/g, '发布内容');
}

function cleanMarkdown(markdown: string): string {
  return markdown
    .replace(/^---\n[\s\S]*?\n---\n?/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
    .trim();
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
  const lines = markdown.split('\n');
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const heading = headingTitle(lines[index]);
    if (heading?.level === level && matcher(heading.title)) {
      start = index + 1;
      break;
    }
  }
  if (start < 0) return '';
  const section: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const heading = headingTitle(lines[index]);
    if (heading && heading.level <= level) break;
    section.push(lines[index]);
  }
  return section.join('\n').trim();
}

function headingBlocks(
  markdown: string,
  level: number,
  matcher: (title: string) => boolean,
): Array<{ heading: string; body: string }> {
  const lines = markdown.split('\n');
  const blocks: Array<{ heading: string; body: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = headingTitle(lines[index]);
    if (!heading || heading.level !== level || !matcher(heading.title)) continue;
    const content: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const nextHeading = headingTitle(lines[cursor]);
      if (nextHeading && nextHeading.level <= level) break;
      content.push(lines[cursor]);
    }
    blocks.push({ heading: heading.title, body: content.join('\n').trim() });
  }
  return blocks;
}

function field(section: string, labels: string[]): string {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = section.match(new RegExp(
      `^\\s*[-*]\\s*(?:\\*\\*)?${escaped}(?:\\*\\*)?\\s*[：:]\\s*(.+?)\\s*$`,
      'mi',
    ));
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function normalizeHeading(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase();
}

function headingContent(section: string, title: string): string {
  const normalizedTitle = normalizeHeading(title);
  return headingSection(section, 4, (candidate) => normalizeHeading(candidate) === normalizedTitle);
}

function headingContentAny(section: string, titles: string[]): string {
  for (const title of titles) {
    const content = headingContent(section, title);
    if (content) return content;
  }
  return '';
}

function listItems(section: string): string[] {
  return section
    .split('\n')
    .map((line) => line.match(/^\s*[-*]\s+(.+?)\s*$/)?.[1]?.trim() || '')
    .filter(Boolean);
}

function parseTable(section: string): TableRow[] {
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

function parseSharePages(section: string): ContentPackageReviewPage[] {
  return parseTable(headingContent(section, '页卡脚本'))
    .filter((row) => /^P[1-5]$/i.test(row['页码'] || ''))
    .map((row) => ({
      page: (row['页码'] || '').toUpperCase(),
      title: row['页面标题'] || '',
      body: row['页面正文'] || '',
      imagePrompt: row['画面/配图建议'] || '',
      visualHierarchy: row['视觉层级'] || '',
      layoutNote: row['排版重点'] || '',
    }));
}

function parseVideoPublishForms(section: string): ContentPackageReviewVideo['platformForms'] {
  const content = headingContentAny(section, ['平台发布表单', '平台发布稿', '发布字段']);
  const defaultCover = field(content, ['默认封面画面', '封面画面']);
  return {
    shipinhao: {
      title: field(content, ['视频号标题', '微信视频号标题']),
      copy: field(content, ['视频号发布文案', '视频号简介', '微信视频号发布文案']),
      tags: field(content, ['视频号话题', '视频号标签', '微信视频号话题']),
      imageOrder: field(content, ['视频号封面画面', '视频号封面']) || defaultCover,
    },
    douyin: {
      title: field(content, ['抖音标题']),
      copy: field(content, ['抖音发布文案', '抖音描述']),
      tags: field(content, ['抖音话题', '抖音标签']),
      imageOrder: field(content, ['抖音封面画面', '抖音封面']) || defaultCover,
    },
    xiaohongshu: {
      title: field(content, ['小红书视频标题', '小红书标题']),
      copy: field(content, ['小红书视频正文', '小红书视频文案', '小红书正文']),
      tags: field(content, ['小红书标签', '小红书视频标签']),
      imageOrder: field(content, ['小红书视频封面', '小红书封面画面', '小红书封面']) || defaultCover,
    },
  };
}

function parseOpinionPublishForms(section: string): ContentPackageReviewOpinion['platformForms'] {
  const content = headingContentAny(section, ['平台发布稿', '平台发布表单', '发布字段']);
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

function parseCommentGuide(section: string): string {
  const content = headingSection(section, 3, (heading) => heading === '评论区引导')
    || headingContentAny(section, ['评论维护话术', '评论区引导']);
  return field(content, ['置顶评论', '置顶']) || listItems(content)[0] || '';
}

function requiredPagesPresent(pages: ContentPackageReviewPage[]): boolean {
  const pageIds = new Set(pages.map((page) => page.page));
  return ['P1', 'P2', 'P3', 'P4', 'P5'].every((page) => pageIds.has(page));
}

function parseNativeXhsPages(section: string): ContentPackageReviewPage[] {
  const rows = parseTable(headingSection(section, 3, (heading) => heading === '图文卡片脚本'));
  return rows
    .filter((row) => /^P[1-8]$/i.test((row['页码'] || '').trim()))
    .map((row) => ({
      page: (row['页码'] || '').trim().toUpperCase(),
      title: row['页面标题'] || '',
      body: row['页面正文'] || '',
      imagePrompt: row['视觉提示'] || '',
      visualHierarchy: row['页面任务'] || '',
      layoutNote: '',
    }));
}

function nativeXhsPagesAreComplete(pages: ContentPackageReviewPage[]): boolean {
  const ids = pages.map((page) => page.page);
  const expected = Array.from({ length: 8 }, (_, index) => `P${index + 1}`);
  return pages.length === 8
    && new Set(ids).size === 8
    && expected.every((page) => ids.includes(page))
    && pages.every((page) => Boolean(page.title && page.body && page.imagePrompt));
}

function hasVideoPlatformForms(forms: ContentPackageReviewVideo['platformForms']): boolean {
  return Object.values(forms).every((form) => Boolean(form.title && form.copy && form.tags));
}

function hasOpinionPlatformForms(forms: ContentPackageReviewOpinion['platformForms']): boolean {
  return Boolean(
    forms.wechat.title
    && forms.wechat.copy
    && forms.moments.copy
    && forms.moments.imageOrder
    && forms.xiaohongshu.title
    && forms.xiaohongshu.copy
    && forms.xiaohongshu.tags,
  );
}

/**
 * A presentation parser for the runtime's fixed package contract. It mirrors
 * the accepted package headings without using Markdown as a hidden API.
 */
export function parseContentPackageReview(markdown: string): ContentPackageReviewParseResult {
  const content = cleanMarkdown(markdown);
  if (!content) return { package: null, errors: ['内容包为空，无法审阅。'] };

  if (content.includes('## 0. 共享事实底稿')) {
    const errors: string[] = [];
    const field = (section: string, labels: string[]): string => {
      try { return readNativeField(section, labels); }
      catch (error) { errors.push(error instanceof Error ? error.message : '字段重复或不明确，请核对。'); return ''; }
    };
    for (const title of ['0. 共享事实底稿', '1. 公众号原生长文', '2. 小红书原生图文', '3. 视频号原生口播']) {
      if (headingBlocks(content, 2, (heading) => heading === title).length > 1) errors.push(`“${title}”重复，请保留一个明确章节。`);
    }
    const title = content.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || '平台原生内容';
    const sharedSection = headingSection(content, 2, (heading) => heading === '0. 共享事实底稿');
    const articleSection = headingSection(content, 2, (heading) => heading === '1. 公众号原生长文');
    const xhsSection = headingSection(content, 2, (heading) => heading === '2. 小红书原生图文');
    const videoSection = headingSection(content, 2, (heading) => heading === '3. 视频号原生口播');
    const selectedText = field(sharedSection, ['本期平台']);
    let declaredPlatforms: Array<'wechat' | 'xhs' | 'shipinhao'> = [];
    try { declaredPlatforms = parseNativePlatforms(selectedText); }
    catch (error) { errors.push(error instanceof Error ? error.message : '本期平台无法识别，请核对。'); }
    const actualPlatforms: Array<'wechat' | 'xhs' | 'shipinhao'> = [
      ...(articleSection ? ['wechat' as const] : []),
      ...(xhsSection ? ['xhs' as const] : []),
      ...(videoSection ? ['shipinhao' as const] : []),
    ];
    const nativePlatforms = declaredPlatforms.length ? declaredPlatforms : actualPlatforms;
    if (declaredPlatforms.length === 0) errors.push('共享事实底稿必须声明至少一个本期平台。');
    const platformLabels = { wechat: '公众号', xhs: '小红书', shipinhao: '视频号' } as const;
    nativePlatforms.forEach((platform) => {
      if (!actualPlatforms.includes(platform)) errors.push(`${platformLabels[platform]}已被选择，但缺少对应的原生内容。`);
    });
    actualPlatforms.forEach((platform) => {
      if (!nativePlatforms.includes(platform)) errors.push(`${platformLabels[platform]}未被选择，不应生成对应内容。`);
    });
    const article: ContentPackageReviewArticle = {
      title: field(articleSection, ['发布标题']),
      titleOptions: field(articleSection, ['标题备选']).split(/[；;|]/).map((item) => item.trim()).filter(Boolean),
      coverText: field(articleSection, ['头图文案', '封面字']),
      summary: field(articleSection, ['摘要']),
      layoutHint: field(articleSection, ['排版提示']),
      imageSlots: field(articleSection, ['正文插图位置', '插图位置', '配图位建议']),
      body: headingSection(articleSection, 3, (heading) => heading === '正文'),
      commentGuide: headingSection(articleSection, 3, (heading) => heading === '评论区承接'),
    };
    if (articleSection && (!article.title || !article.summary || !article.coverText || !article.imageSlots || !article.body || !article.commentGuide)) {
      errors.push('公众号原生长文必须包含发布标题、摘要、头图文案、插图位置、完整正文和评论区承接。');
    }

    const xhsPages = parseNativeXhsPages(xhsSection);
    const xhsCover = headingSection(xhsSection, 3, (heading) => heading === '封面三句话');
    const xhsCoverLines = [field(xhsCover, ['主句']), field(xhsCover, ['副句']), field(xhsCover, ['补充句'])];
    const xhsPublish = headingSection(xhsSection, 3, (heading) => heading === '发布正文');
    const xhsTags = headingSection(xhsSection, 3, (heading) => heading === '结尾标签').trim();
    let xhsPublic: NativeXhsCopy | null = null;
    if (xhsSection) {
      try { xhsPublic = readNativeXhsCopy(content); }
      catch { errors.push('小红书发布正文的标题、正文、结尾问题或标签不完整或重复，请核对。'); }
    }
    const opinions: ContentPackageReviewOpinion[] = xhsSection ? [{
      index: 1,
      heading: '小红书原生图文',
      title: xhsPublic?.title || field(xhsPublish, ['标题']) || '小红书原生图文',
      coverText: xhsCoverLines.filter(Boolean).join('\n'),
      coreViewpoint: xhsPublic?.question || field(xhsPublish, ['结尾问题']) || field(xhsSection, ['主句']),
      copy: xhsPublic?.body || '',
      pages: xhsPages,
      platformForms: {
        wechat: { title: '', copy: '', tags: '', imageOrder: '' },
        moments: { title: '', copy: '', tags: '', imageOrder: '' },
        xiaohongshu: {
          title: xhsPublic?.title || field(xhsPublish, ['标题']),
          copy: xhsPublic?.publishingBody || '',
          tags: xhsPublic?.tags || xhsTags,
          imageOrder: '',
        },
      },
    }] : [];
    if (xhsSection && (
      xhsCoverLines.some((line) => !line)
      || !opinions[0]?.title
      || !opinions[0]?.copy
      || !opinions[0]?.coreViewpoint
      || !xhsTags
      || !nativeXhsPagesAreComplete(xhsPages)
    )) errors.push('小红书原生图文必须包含封面三句话、逐页 P1–P8、发布标题与正文、结尾问题和标签。');

    const videoPublish = headingSection(videoSection, 3, (heading) => heading === '发布文案');
    const videos: ContentPackageReviewVideo[] = videoSection ? [{
      index: 1,
      heading: '视频号原生口播',
      title: field(videoSection, ['发布标题']) || '视频号原生口播',
      coverText: '',
      hook: field(videoSection, ['3秒钩子', '3 秒钩子']),
      duration: field(videoSection, ['建议时长', '时长']),
      oralScript: headingSection(videoSection, 3, (heading) => heading === '逐句口播稿'),
      lineScript: headingSection(videoSection, 3, (heading) => heading === '逐句口播稿'),
      shotList: headingSection(videoSection, 3, (heading) => heading === '镜头清单'),
      subtitles: listItems(headingSection(videoSection, 3, (heading) => heading === '字幕重点')),
      bRoll: listItems(headingSection(videoSection, 3, (heading) => heading === 'B-roll 建议')),
      platformForms: {
        shipinhao: {
          title: field(videoSection, ['发布标题']),
          copy: field(videoPublish, ['简介']),
          tags: field(videoPublish, ['话题']),
          imageOrder: '',
        },
        douyin: { title: '', copy: '', tags: '', imageOrder: '' },
        xiaohongshu: { title: '', copy: '', tags: '', imageOrder: '' },
      },
    }] : [];
    if (videoSection && videos[0]?.lineScript) {
      try { spokenScript(videos[0].lineScript); }
      catch { errors.push('视频号口播文案无法完整识别，请核对逐句口播稿后再确认。'); }
    }
    if (videoSection && (
      !videos[0]?.title
      || !videos[0]?.hook
      || !videos[0]?.lineScript
      || !videos[0]?.shotList
      || !videos[0]?.subtitles.length
      || !videos[0]?.bRoll.length
      || !videos[0]?.platformForms.shipinhao.copy
      || !videos[0]?.platformForms.shipinhao.tags
    )) errors.push('视频号原生口播必须包含标题、开场钩子、逐句稿、镜头、字幕、B-roll 和发布文案。');
    return { package: { title, article, videos, opinions, nativePlatforms }, errors };
  }

  const title = content.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || '最终内容';
  const articleSection = headingSection(content, 2, (heading) => /^1\.\s*公众号(?:母稿|长文)/.test(heading));
  const videoSection = headingSection(content, 2, (heading) => /^2\.\s*短视频/.test(heading));
  const opinionSection = headingSection(content, 2, (heading) => /^3\.\s*(?:分享观点(?:图文)?|图文内容)/.test(heading));
  const errors: string[] = [];

  if (!articleSection) errors.push('缺少“1. 公众号母稿”章节。');
  if (!videoSection) errors.push('缺少“2. 短视频内容”章节。');
  if (!opinionSection) errors.push('缺少“3. 图文内容”章节。');

  const article: ContentPackageReviewArticle = {
    title: field(articleSection, ['发布标题']),
    titleOptions: field(articleSection, ['标题备选']).split(/[；;|]/).map((item) => item.trim()).filter(Boolean),
    coverText: field(articleSection, ['封面字']),
    summary: field(articleSection, ['摘要']),
    layoutHint: field(articleSection, ['公众号排版提示', '排版提示', 'HTML 排版建议']),
    imageSlots: field(articleSection, ['配图位建议', '配图建议', '图片需求']),
    body: headingSection(articleSection, 3, (heading) => heading === '正文'),
    commentGuide: parseCommentGuide(articleSection),
  };
  if (articleSection && (!article.title || !article.body)) {
    errors.push('公众号母稿缺少发布标题或正文。');
  }

  const videos = headingBlocks(videoSection, 3, (heading) => /^短视频\s*[12](?:\s*[：:].*)?$/.test(heading))
    .map((entry, index) => {
      const oralScript = headingContent(entry.body, '分段口播稿');
      const lineScript = headingContent(entry.body, '逐句口播稿');
      return {
        index: index + 1,
        heading: entry.heading,
        title: field(entry.body, ['发布标题']) || entry.heading,
        coverText: field(entry.body, ['封面字']),
        hook: field(entry.body, ['3 秒钩子', '3秒钩子', '开场钩子']),
        duration: field(entry.body, ['时长', '视频时长']),
        oralScript,
        lineScript,
        shotList: headingContentAny(entry.body, ['镜头清单', '镜头表']),
        subtitles: listItems(headingContent(entry.body, '字幕重点')),
        bRoll: listItems(headingContentAny(entry.body, ['B-roll 素材建议', 'B-roll素材建议', 'B-roll', 'B-Roll'])),
        platformForms: parseVideoPublishForms(entry.body),
      };
    });
  if (videoSection && videos.length !== 2) {
    errors.push(`短视频口播稿必须恰好为 2 条，当前为 ${videos.length} 条。`);
  }
  videos.forEach((video) => {
    const missing = [
      !video.oralScript && '分段口播稿',
      !video.lineScript && '逐句口播稿',
      !video.shotList && '镜头清单',
      video.subtitles.length === 0 && '字幕重点',
      video.bRoll.length === 0 && 'B-roll 素材建议',
      !hasVideoPlatformForms(video.platformForms) && '三平台发布表单',
    ].filter(Boolean);
    if (missing.length > 0) errors.push(`短视频 ${video.index} 缺少：${missing.join('、')}。`);
  });

  const opinions = headingBlocks(opinionSection, 3, (heading) => /^(?:分享观点|图文)\s*\d+(?:\s*[：:].*)?$/.test(heading))
    .map((entry, index) => ({
      index: index + 1,
      heading: entry.heading,
      title: field(entry.body, ['发布标题']) || entry.heading,
      coverText: field(entry.body, ['封面字']),
      coreViewpoint: field(entry.body, ['核心观点', '核心判断']),
      copy: field(entry.body, ['分享文案', '正文文案', '文案']),
      pages: parseSharePages(entry.body),
      platformForms: parseOpinionPublishForms(entry.body),
    }));
  if (opinionSection && opinions.length < 1) {
    errors.push(`分享观点图文至少需要 1 条，当前为 ${opinions.length} 条。`);
  }
  opinions.forEach((opinion) => {
    const missing = [
      !opinion.coreViewpoint && '核心观点',
      !opinion.copy && '分享文案',
      !requiredPagesPresent(opinion.pages) && 'P1-P5 页卡脚本',
      !hasOpinionPlatformForms(opinion.platformForms) && '公众号、朋友圈、小红书发布字段',
    ].filter(Boolean);
    if (missing.length > 0) errors.push(`观点图文 ${opinion.index} 缺少：${missing.join('、')}。`);
  });

  const parsed: ParsedContentPackageReview = { title, article, videos, opinions };
  return { package: parsed, errors };
}

export function isContentPackageReviewReady(
  status: ContentPackageReviewLoadStatus,
  checked: ContentPackageReviewChecks,
  opinionCount: number,
): boolean {
  if (status !== 'ready') return false;
  const required: ContentPackageReviewUnit[] = ['article', 'video-1', 'video-2'];
  for (let index = 1; index <= opinionCount; index += 1) required.push(`opinion-${index}`);
  return required.every((unit) => checked[unit] === true);
}

function TextBlock({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <div>
      <p className="mb-1 text-[11px] font-bold text-[#6B6B6B]">{label}</p>
      <div className="whitespace-pre-wrap break-words text-[13px] leading-[1.7] text-[#303030]">{value}</div>
    </div>
  );
}

function ArticleBody({ body }: { body: string }) {
  const paragraphs = body.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  return (
    <div className="space-y-3 text-[14px] leading-[1.8] text-[#303030]">
      {paragraphs.map((paragraph, index) => {
        if (/^####\s+/.test(paragraph)) {
          const [heading, ...rest] = paragraph.split('\n');
          return (
            <div key={`${heading}-${index}`}>
              <h4 className="mb-1.5 text-[15px] font-bold text-[#1A1A1A]">{heading.replace(/^####\s+/, '')}</h4>
              {rest.length > 0 && <p className="whitespace-pre-wrap">{rest.join('\n')}</p>}
            </div>
          );
        }
        if (paragraph.startsWith('>')) {
          return <blockquote key={`${paragraph.slice(0, 16)}-${index}`} className="rounded-lg border-l-[3px] border-[#E85D4C] bg-[#FFF8F5] px-3 py-2.5 font-medium text-[#4F4A45]">{paragraph.replace(/^>\s?/, '')}</blockquote>;
        }
        return <p key={`${paragraph.slice(0, 16)}-${index}`} className="whitespace-pre-wrap">{paragraph}</p>;
      })}
    </div>
  );
}

function ReviewCheck({
  unit,
  checked,
  onChange,
}: {
  unit: { id: ContentPackageReviewUnit; label: string; detail: string };
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 border-t border-[rgba(28,28,30,0.08)] pt-3 text-[12px] leading-[1.55] text-[#4F4A45]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-[#E85D4C]"
        aria-label={`确认已检查${unit.label}`}
      />
      <span>
        <span className="font-bold text-[#1A1A1A]">我已确认{unit.label}可以进入排版</span>
        <span className="ml-1 text-[#6B6B6B]">{unit.detail}</span>
        <span className="mt-1 block text-[10px] leading-[1.55] text-[#8A8178]">事实有依据、观点有信息量、表达自然，并且不是由其他平台稿直接改写。</span>
      </span>
    </label>
  );
}

function FormFields({
  forms,
  platformLabels,
}: {
  forms: Record<string, ContentPackageReviewPlatformForm>;
  platformLabels: Record<string, string>;
}) {
  return (
    <div className="grid gap-2 lg:grid-cols-3">
      {Object.entries(forms).map(([platform, form]) => (
        <div key={platform} className="rounded-lg border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] px-3 py-2.5">
          <p className="text-[12px] font-bold text-[#1A1A1A]">{platformLabels[platform] || platform}</p>
          <dl className="mt-2 space-y-1.5 text-[11px] leading-[1.55]">
            {form.title && <div><dt className="text-[#8A8178]">标题</dt><dd className="mt-0.5 break-words text-[#303030]">{form.title}</dd></div>}
            {form.copy && <div><dt className="text-[#8A8178]">发布文案</dt><dd className="mt-0.5 whitespace-pre-wrap break-words text-[#303030]">{form.copy}</dd></div>}
            {form.tags && <div><dt className="text-[#8A8178]">话题和标签</dt><dd className="mt-0.5 break-words text-[#303030]">{form.tags}</dd></div>}
            {form.imageOrder && <div><dt className="text-[#8A8178]">封面或图片顺序</dt><dd className="mt-0.5 break-words text-[#303030]">{form.imageOrder}</dd></div>}
          </dl>
        </div>
      ))}
    </div>
  );
}

function ArticleReview({ article, checked, expanded, onChange, onToggle, total, position, readOnly, path, sha256, onRefresh, articleSection, onEditSelection, editDisabled, readerEditing }: {
  article: ContentPackageReviewArticle;
  checked: boolean;
  expanded: boolean;
  onChange: (checked: boolean) => void;
  onToggle: () => void;
  total: number;
  position: number;
  readOnly?: boolean;
  path: string;
  sha256: string;
  onRefresh: () => void;
  articleSection?: ContentSection;
  onEditSelection?: (request: ContentSelectionRequest, container?: HTMLElement) => void;
  editDisabled?: boolean;
  readerEditing?: boolean;
}) {
  const unit = UNIT_DEFINITIONS[0];
  return (
    <section id="content-package-section-article" className="scroll-mt-24 border-t-2 border-[#1C1C1E] pt-2" aria-labelledby="content-package-article">
      <button type="button" onClick={onToggle} disabled={readerEditing} aria-expanded={expanded} aria-controls="content-package-article-body" className="flex w-full flex-col gap-3 rounded-lg px-2 py-2 text-left hover:bg-[#FDF8F3] sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[#E85D4C]"><FileText size={17} /><span className="text-[12px] font-bold">{position} / {total}</span></div>
          <h2 id="content-package-article" className="mt-2 text-[18px] font-bold text-[#1A1A1A]">{article.title || unit.label}</h2>
          {article.summary && <p className="mt-2 max-w-[780px] text-[13px] leading-[1.65] text-[#6B6B6B]">{article.summary}</p>}
        </div>
        <span className="flex shrink-0 items-center gap-2 self-start"><span className="inline-flex h-7 items-center rounded-md bg-[#FDF8F3] px-2 text-[11px] font-bold text-[#6B6B6B]">{checked ? '已检查' : '公众号'}</span><ChevronDown size={17} className={`text-[#8A8178] transition-transform ${expanded ? 'rotate-180' : ''}`} /></span>
      </button>
      {expanded && <div id="content-package-article-body" className="px-2 pb-2">
      <ReadableArticleActions path={path} sha256={sha256} onRefresh={onRefresh} refreshDisabled={readerEditing} />
      {article.body && <div className="mt-4"><p className="mb-2 text-[12px] font-bold text-[#6B6B6B]">正文</p>{!readOnly && onEditSelection && articleSection && sha256
        ? <SelectableArticleBody path={path} sha256={sha256} section={articleSection} disabled={editDisabled} onEdit={onEditSelection} />
        : <ArticleBody body={article.body} />}</div>}
      <details className="mt-4">
        <summary className="cursor-pointer text-sm text-[#6B6B6B]">封面、备选标题与排版说明</summary>
      <dl className="mt-4 grid gap-3 border-y border-[rgba(28,28,30,0.08)] py-3 text-[12px] sm:grid-cols-2 xl:grid-cols-4">
        {article.coverText && <div><dt className="text-[#8A8178]">封面字</dt><dd className="mt-1 font-bold text-[#1A1A1A]">{article.coverText}</dd></div>}
        {article.titleOptions.length > 0 && <div><dt className="text-[#8A8178]">标题备选</dt><dd className="mt-1 leading-[1.55] text-[#303030]">{article.titleOptions.join('；')}</dd></div>}
        {article.layoutHint && <div><dt className="text-[#8A8178]">排版提示</dt><dd className="mt-1 leading-[1.55] text-[#303030]">{article.layoutHint}</dd></div>}
        {article.imageSlots && <div><dt className="text-[#8A8178]">配图位置</dt><dd className="mt-1 leading-[1.55] text-[#303030]">{article.imageSlots}</dd></div>}
      </dl>
      </details>
      {article.commentGuide && <div className="mt-4 rounded-lg border-l-[3px] border-[#E4A43B] bg-[#FFF8E8] px-3 py-2.5 text-[12px] leading-[1.6] text-[#4F4A45]"><span className="font-bold text-[#1A1A1A]">评论区引导：</span>{article.commentGuide}</div>}
      {!readOnly && <div className="mt-4"><ReviewCheck unit={unit} checked={checked} onChange={onChange} /></div>}
      </div>}
    </section>
  );
}

export function VideoReview({ video, checked, expanded, onChange, onToggle, total, position, readOnly, readerEditing, native, ...reader }: {
  video: ContentPackageReviewVideo;
  checked: boolean;
  expanded: boolean;
  onChange: (checked: boolean) => void;
  onToggle: () => void;
  total: number;
  position: number;
  readOnly?: boolean;
  readerEditing?: boolean;
  native: boolean;
} & NativeReaderProps) {
  const unit = UNIT_DEFINITIONS[video.index];
  const script = native ? uniqueReaderSection(reader.readerSections || [], 'shipinhao:逐句口播稿') : undefined;
  const scriptRows = readerTableRows(script);
  const spokenRows = scriptRows.length && scriptRows.every((row) => row['口播文案']?.text) ? scriptRows : [];
  const plainBinding = script && script.text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim() === video.lineScript ? { section: script } : undefined;
  return (
    <section id={`content-package-section-video-${video.index}`} className="scroll-mt-24 border-t border-[rgba(28,28,30,0.16)] pt-2" aria-labelledby={`content-package-video-${video.index}`}>
      <button type="button" onClick={onToggle} disabled={readerEditing} aria-expanded={expanded} aria-controls={`content-package-video-${video.index}-body`} className="flex w-full flex-col gap-3 rounded-lg px-2 py-2 text-left hover:bg-[#FDF8F3] sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[#E85D4C]"><Video size={17} /><span className="text-[12px] font-bold">{position} / {total}</span></div>
          <h2 id={`content-package-video-${video.index}`} className="mt-2 text-[17px] font-bold text-[#1A1A1A]">{video.title}</h2>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-bold">
          {checked && <span className="rounded-md bg-[#EDF8F0] px-2 py-1 text-[#16803C]">已检查</span>}
          {video.duration && <span className="rounded-md bg-[#FDF8F3] px-2 py-1 text-[#6B6B6B]">{video.duration}</span>}
          {video.coverText && <span className="rounded-md bg-[#FFF4F1] px-2 py-1 text-[#C94A3B]">封面字：{video.coverText}</span>}
          <ChevronDown size={17} className={`text-[#8A8178] transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
      </button>
      {expanded && <div id={`content-package-video-${video.index}-body`} className="px-2 pb-2">
      {video.hook && <div className="mt-3 rounded-lg border-l-[3px] border-[#E85D4C] bg-[#FFF8F5] px-3 py-2.5 text-[13px] leading-[1.6] text-[#4F4A45]"><span className="font-bold text-[#1A1A1A]">开场 3 秒：</span>{video.hook}</div>}
      {native && <section aria-label="视频号逐句口播稿" className="mt-4 space-y-3">
        <h3 className="text-sm font-bold">逐句口播稿</h3>
        {!readOnly && reader.onEditSelection && <p className="text-xs text-[#6B6B6B]">选中一句话，或点“修改这段”。先核对预览，再决定是否采用。</p>}
        {spokenRows.length ? spokenRows.map((row, index) => <div key={index} className="rounded-lg border border-[#E5DDD6] p-3">
          <p className="mb-2 text-xs font-semibold text-[#6B6B6B]">{row['时间段']?.text || `第 ${index + 1} 段`}</p>
          <NativeReaderText {...reader} readOnly={readOnly} binding={row['口播文案'].binding} value={row['口播文案'].text} label={`第 ${index + 1} 段口播`} />
          {row['屏幕字幕']?.text && <p className="mt-2 text-xs text-[#6B6B6B]">字幕：{row['屏幕字幕'].text}</p>}
          {row['对应画面']?.text && <p className="mt-1 text-xs text-[#6B6B6B]">画面：{row['对应画面'].text}</p>}
        </div>) : <NativeReaderText {...reader} readOnly={readOnly} binding={video.lineScript.trimStart().startsWith('|') ? undefined : plainBinding} value={video.lineScript} label="视频号口播稿" />}
      </section>}
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {!native && <><TextBlock label="分段口播稿" value={video.oralScript} /><TextBlock label="逐句口播稿" value={video.lineScript} /></>}
        <TextBlock label="镜头清单" value={video.shotList} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="mb-1 text-[11px] font-bold text-[#6B6B6B]">字幕重点</p>
            <ul className="space-y-1 text-[13px] leading-[1.65] text-[#303030]">{video.subtitles.map((item) => <li key={item} className="flex gap-2"><span className="text-[#E85D4C]">-</span><span>{item}</span></li>)}</ul>
          </div>
          <div>
            <p className="mb-1 text-[11px] font-bold text-[#6B6B6B]">补充画面</p>
            <ul className="space-y-1 text-[13px] leading-[1.65] text-[#303030]">{video.bRoll.map((item) => <li key={item} className="flex gap-2"><span className="text-[#E85D4C]">-</span><span>{item}</span></li>)}</ul>
          </div>
        </div>
      </div>
      <div className="mt-4"><p className="mb-2 text-[12px] font-bold text-[#6B6B6B]">{native ? '视频号发布内容' : '各平台发布内容'}</p><FormFields forms={native ? { shipinhao: video.platformForms.shipinhao } : video.platformForms} platformLabels={{ shipinhao: '视频号', douyin: '抖音', xiaohongshu: '小红书' }} /></div>
      {!readOnly && <div className="mt-4"><ReviewCheck unit={unit} checked={checked} onChange={onChange} /></div>}
      </div>}
    </section>
  );
}

export function OpinionReview({ opinion, checked, expanded, onChange, onToggle, total, position, native, readOnly, readerEditing, ...reader }: {
  opinion: ContentPackageReviewOpinion;
  checked: boolean;
  expanded: boolean;
  onChange: (checked: boolean) => void;
  onToggle: () => void;
  total: number;
  position: number;
  native: boolean;
  readOnly?: boolean;
  readerEditing?: boolean;
} & NativeReaderProps) {
  const cardEditor = useRef<HTMLDivElement>(null);
  const cards = native ? readerTableRows(uniqueReaderSection(reader.readerSections || [], 'xhs:图文卡片脚本')) : [];
  const copyBinding = native ? readerFieldBinding(uniqueReaderSection(reader.readerSections || [], 'xhs:发布正文'), '正文', opinion.copy) : undefined;
  const unit = {
    id: `opinion-${opinion.index}`,
    label: native ? '小红书原生图文' : `图文卡片 ${opinion.index}`,
    detail: native ? '封面三句话、P1–P8、发布正文和结尾标签' : '5 张卡片和各平台配文',
  } as { id: ContentPackageReviewUnit; label: string; detail: string };
  return (
    <section id={`content-package-section-opinion-${opinion.index}`} className="scroll-mt-24 border-t border-[rgba(28,28,30,0.16)] pt-2" aria-labelledby={`content-package-opinion-${opinion.index}`}>
      <button type="button" onClick={onToggle} disabled={readerEditing} aria-expanded={expanded} aria-controls={`content-package-opinion-${opinion.index}-body`} className="flex w-full flex-col gap-3 rounded-lg px-2 py-2 text-left hover:bg-[#FDF8F3] sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[#E85D4C]"><ImageIcon size={17} /><span className="text-[12px] font-bold">{position} / {total}</span></div>
          <h2 id={`content-package-opinion-${opinion.index}`} className="mt-2 text-[17px] font-bold text-[#1A1A1A]">{opinion.title}</h2>
        </div>
        <span className="flex shrink-0 items-center gap-2 self-start">{checked && <span className="inline-flex h-7 items-center rounded-md bg-[#EDF8F0] px-2 text-[11px] font-bold text-[#16803C]">已检查</span>}{opinion.coverText && <span className="inline-flex h-7 items-center rounded-md bg-[#FFF4F1] px-2 text-[11px] font-bold text-[#C94A3B]">封面字：{opinion.coverText}</span>}<ChevronDown size={17} className={`text-[#8A8178] transition-transform ${expanded ? 'rotate-180' : ''}`} /></span>
      </button>
      {expanded && <div id={`content-package-opinion-${opinion.index}-body`} className="px-2 pb-2">
      <div className="mt-3 grid gap-3 border-y border-[rgba(28,28,30,0.08)] py-3 md:grid-cols-2">
        <TextBlock label="核心观点" value={opinion.coreViewpoint} />
        {!native && <TextBlock label="分享文案" value={opinion.copy} />}
      </div>
      {native && <section aria-label="小红书发布正文" className="mt-4"><h3 className="mb-2 text-sm font-bold">发布正文</h3><NativeReaderText {...reader} readOnly={readOnly} binding={copyBinding} value={opinion.copy} label="小红书发布正文" /></section>}
      <div className="mt-4">
        <p className="mb-2 text-[12px] font-bold text-[#6B6B6B]">{native ? 'P1–P8 图文卡片' : '5 张卡片'}</p>
        <div className={`grid overflow-hidden rounded-lg border border-[rgba(28,28,30,0.1)] bg-[rgba(28,28,30,0.1)] ${native ? 'sm:grid-cols-2 lg:grid-cols-4' : 'md:grid-cols-5'}`}>
          {opinion.pages.map((page) => {
            const matches = cards.filter((row) => row['页码']?.text.toUpperCase() === page.page);
            const cell = matches.length === 1 && matches[0]['页面正文']?.text === page.body ? matches[0]['页面正文'] : undefined;
            return (
            <div key={page.page} className="min-w-0 bg-white px-3 py-3">
              <p className="text-[11px] font-bold text-[#E85D4C]">第 {Number(page.page.replace(/^P/i, '')) || 1} 张</p>
              <p className="mt-1 text-[13px] font-bold text-[#1A1A1A]">{page.title}</p>
              {native ? <div className="mt-1.5"><NativeReaderText {...reader} readOnly={readOnly} binding={cell?.binding} value={page.body} label={`${page.page} 正文`} onEditSelection={reader.onEditSelection ? (request) => reader.onEditSelection?.(request, cardEditor.current || undefined) : undefined} /></div> : <p className="mt-1.5 text-[12px] leading-[1.55] text-[#4F4A45]">{page.body}</p>}
              {page.imagePrompt && <p className="mt-2 text-[11px] leading-[1.5] text-[#6B6B6B]">画面：{page.imagePrompt}</p>}
              {page.visualHierarchy && <p className="mt-1 text-[11px] leading-[1.5] text-[#6B6B6B]">文字层次：{page.visualHierarchy}</p>}
              {page.layoutNote && <p className="mt-1 text-[11px] leading-[1.5] text-[#6B6B6B]">排版：{page.layoutNote}</p>}
            </div>
          ); })}
        </div>
        <div ref={cardEditor} />
      </div>
      <div className="mt-4"><p className="mb-2 text-[12px] font-bold text-[#6B6B6B]">{native ? '小红书标题与标签' : '各平台配文'}</p><FormFields forms={native ? { xiaohongshu: { ...opinion.platformForms.xiaohongshu, copy: '' } } : opinion.platformForms} platformLabels={{ wechat: '公众号', moments: '朋友圈', xiaohongshu: '小红书' }} /></div>
      {!readOnly && <div className="mt-4"><ReviewCheck unit={unit} checked={checked} onChange={onChange} /></div>}
      </div>}
    </section>
  );
}

export function ContentPackageReview({ packagePath, checked: suppliedChecks, onChange, onReadyChange, onEdit, onEditIssue, onEditSelection, editDisabled, readerEditing, readOnly = false }: ContentPackageReviewProps) {
  const checked = readOnly ? EMPTY_CHECKS : suppliedChecks;
  const [refreshToken, setRefreshToken] = useState(0);
  const [expandedUnit, setExpandedUnit] = useState<ContentPackageReviewUnit | null>('article');
  const [load, setLoad] = useState<PackageLoadState>({ requestKey: '', status: 'idle', package: null, errors: [] });
  const path = packagePath?.trim() || '';
  const requestKey = `${path}:${refreshToken}`;
  const status = path && load.requestKey !== requestKey ? 'loading' : path ? load.status : 'idle';

  useEffect(() => {
    if (!path) return;

    const controller = new AbortController();
    let current = true;
    void (async () => {
      try {
        const response = await fetch(outputHref(path), { signal: controller.signal, cache: 'no-store' });
        const payload = await response.json() as { content?: unknown; error?: unknown };
        if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : '内容包读取失败。');
        if (typeof payload.content !== 'string') throw new Error('内容包响应缺少可读取的正文。');
        const parsed = parseContentPackageReview(payload.content);
        // Show the same article fields that the server extracts for reader exports.
        try { if (parsed.package) Object.assign(parsed.package.article, readableArticleFromPackage(payload.content)); }
        catch { /* Incomplete packages remain inspectable; export reports the missing structure. */ }
        const publishingIssues = inspectPublishingSections(payload.content);
        const readerSections = contentSections(payload.content);
        const bodies = readerSections.filter((section) => section.id === 'wechat:正文');
        const articleSection = bodies.length === 1 && bodies[0].text.replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').trim() === parsed.package?.article.body
          ? bodies[0] : undefined;
        // Bind reader findings to the full file read by the editor. If hashing
        // is unavailable, reading and the regular editor remain available.
        let sha256 = '';
        try { sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload.content)))].map((byte) => byte.toString(16).padStart(2, '0')).join(''); } catch { /* Reading remains available without snapshot-bound actions. */ }
        if (!current) return;
        setLoad({
          requestKey,
          status: parsed.errors.length > 0 ? 'invalid' : 'ready',
          package: parsed.package,
          errors: parsed.errors,
          publishingIssues, sha256, articleSection, readerSections,
        });
      } catch (error) {
        if (!current || (error instanceof DOMException && error.name === 'AbortError')) return;
        setLoad({
          requestKey,
          status: 'error',
          package: null,
          errors: [displayReviewError(error)],
        });
      }
    })();
    return () => {
      current = false;
      controller.abort();
    };
  }, [path, requestKey]);

  const opinionCount = load.package?.opinions.length ?? 0;
  const requiredUnitIds = useMemo<ContentPackageReviewUnit[]>(() => load.package?.nativePlatforms
    ? [
      ...(load.package.nativePlatforms.includes('wechat') ? ['article' as const] : []),
      ...(load.package.nativePlatforms.includes('shipinhao') ? ['video-1' as const] : []),
      ...(load.package.nativePlatforms.includes('xhs') ? ['opinion-1' as const] : []),
    ]
    : [
      'article',
      'video-1',
      'video-2',
      ...(load.package?.opinions ?? []).map((opinion) => `opinion-${opinion.index}` as ContentPackageReviewUnit),
    ], [load.package]);
  const checkedCount = requiredUnitIds.filter((id) => checked[id] === true).length;
  const totalUnits = requiredUnitIds.length;
  const visibleUnit = expandedUnit && (requiredUnitIds.includes(expandedUnit) ? expandedUnit : requiredUnitIds[0]);
  const nativePackage = Boolean(load.package?.nativePlatforms);
  const displayedUnits = useMemo<Array<{ id: ContentPackageReviewUnit; label: string; detail: string }>>(() => requiredUnitIds.map((id) => {
    const base: { id: ContentPackageReviewUnit; label: string; detail: string } = UNIT_DEFINITIONS.find((unit) => unit.id === id)
      || { id, label: `图文卡片 ${id.replace('opinion-', '')}`, detail: '卡片和各平台配文' };
    if (!nativePackage) return base;
    if (id === 'article') return { ...base, detail: '完整长文、头图文案、正文插图位置和评论承接' };
    if (id === 'video-1') return { ...base, label: '视频号原生口播', detail: '钩子、口播、镜头、字幕和发布文案' };
    if (id === 'opinion-1') return { ...base, label: '小红书原生图文', detail: '封面三句话、P1–P8、正文和标签' };
    return base;
  }), [nativePackage, requiredUnitIds]);
  const ready = useMemo(() => !readOnly && status === 'ready' && requiredUnitIds.length > 0 && requiredUnitIds.every((unit) => checked[unit] === true), [checked, requiredUnitIds, status, readOnly]);

  useEffect(() => {
    onReadyChange?.(ready);
  }, [onReadyChange, ready]);

  if (!path) {
    return (
      <div className="rounded-lg border border-dashed border-[rgba(28,28,30,0.18)] bg-[#FDF8F3] px-4 py-5 text-[13px] leading-[1.6] text-[#6B6B6B]">
        内容生成后，这里只展示本期已选平台的原生成稿，供你逐项确认。
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] px-4 py-5 text-[13px] text-[#6B6B6B]" aria-live="polite">
        <LoaderCircle size={16} className="animate-spin text-[#E85D4C]" />正在读取本期内容…
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="rounded-lg border border-[#E85D4C] bg-[#FFF4F1] px-4 py-4" role="alert">
        <div className="flex items-start gap-2 text-[13px] leading-[1.6] text-[#8F3329]"><CircleAlert size={16} className="mt-0.5 shrink-0" />{displayReviewError(load.errors[0] || '内容读取失败。')}</div>
        <button type="button" onClick={() => setRefreshToken((value) => value + 1)} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-full border border-[rgba(143,51,41,0.35)] bg-white px-2.5 text-[11px] font-bold text-[#8F3329] hover:bg-[#FFF8F5]"><RefreshCw size={13} />重新读取</button>
      </div>
    );
  }

  const contentPackage = load.package;
  if (!contentPackage) return null;

  return (
    <div className="space-y-7">
      <div className="flex flex-col gap-3 rounded-lg border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] px-3 py-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-[12px] font-bold text-[#1A1A1A]">本期全部内容</p>
          <p className="mt-1 text-[11px] text-[#6B6B6B]">{load.package?.nativePlatforms ? `${totalUnits} 条已选平台原生内容` : `1 篇文章、2 条视频稿和 ${opinionCount} 组图文卡片`}{readOnly ? ' · 只读' : ` · 已检查 ${checkedCount}/${totalUnits}`}</p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {!readOnly && onEdit && <button type="button" onClick={onEdit} className="inline-flex h-8 items-center rounded-md bg-[#1C1C1E] px-3 text-xs font-bold text-white">修改内容</button>}
          <span className={`inline-flex h-7 items-center rounded-md px-2 text-[11px] font-bold ${ready ? 'bg-[#EDF8F0] text-[#16803C]' : 'bg-[#FFF8E8] text-[#A66300]'}`}>
            {readOnly ? '查看旧稿' : ready ? '已完成' : '待你确认'}
          </span>
          <a href={outputHref(path, 'view')} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center gap-1.5 rounded-md border border-[rgba(28,28,30,0.14)] bg-white px-2 text-[11px] font-bold text-[#2763A6] hover:border-[#2763A6]"><ExternalLink size={13} />查看原始文件</a>
        </div>
      </div>

      {readerEditing && <p role="status" className="text-sm leading-6 text-[#4F4A45]">正在修改一段文字。请先完成或取消这段修改，再折叠、切换或重新读取文章；也可以点“修改内容”保留输入并打开完整编辑器。</p>}
      <PublishingCopyNotice issues={load.publishingIssues || []} path={path} sha256={load.sha256 || ''} onEdit={readOnly ? undefined : onEditIssue} disabled={editDisabled} />

      {totalUnits > 1 && <nav aria-label="内容审阅进度" className="sticky top-3 z-10 -mx-1 flex gap-2 overflow-x-auto rounded-lg border border-[rgba(28,28,30,0.12)] bg-white/95 p-2 shadow-sm backdrop-blur">
        {displayedUnits.map((unit, index) => {
          const isChecked = checked[unit.id] === true;
          const isExpanded = visibleUnit === unit.id;
          return (
            <button
              key={unit.id}
              type="button"
              aria-pressed={isExpanded}
              disabled={readerEditing}
              onClick={() => {
                setExpandedUnit(unit.id);
                window.requestAnimationFrame(() => document.getElementById(`content-package-section-${unit.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
              }}
              className={`inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-bold transition-colors ${isExpanded ? 'border-[#E85D4C] bg-[#FFF4F1] text-[#C94A3B]' : isChecked ? 'border-[#B7DCC2] bg-[#EDF8F0] text-[#16803C]' : 'border-[rgba(28,28,30,0.12)] bg-white text-[#6B6B6B] hover:border-[#E85D4C]'}`}
            >
              {isChecked ? <Check size={13} /> : <span className="font-mono text-[10px]">{index + 1}</span>}
              {unit.label}
            </button>
          );
        })}
      </nav>}

      {status === 'invalid' && (
        <div className="rounded-lg border-l-[3px] border-[#E85D4C] bg-[#FFF4F1] px-3 py-3" role="alert">
          <p className="text-[12px] font-bold text-[#8F3329]">内容还不完整，暂时不能确认。</p>
          <ul className="mt-2 space-y-1 text-[12px] leading-[1.55] text-[#8F3329]">{load.errors.map((error) => <li key={error}>- {displayReviewError(error)}</li>)}</ul>
        </div>
      )}

      {requiredUnitIds.includes('article') && <ArticleReview readerEditing={readerEditing} path={path} sha256={load.sha256 || ''} articleSection={load.articleSection} onEditSelection={onEditSelection} editDisabled={editDisabled} onRefresh={() => setRefreshToken((value) => value + 1)} readOnly={readOnly} article={contentPackage.article} checked={checked.article === true} expanded={visibleUnit === 'article'} onToggle={() => setExpandedUnit(visibleUnit === 'article' ? null : 'article')} onChange={(value) => onChange('article', value)} total={totalUnits} position={requiredUnitIds.indexOf('article') + 1} />}
      {contentPackage.videos.map((video) => {
        const unit = `video-${video.index}` as ContentPackageReviewUnit;
        return <VideoReview native={nativePackage} path={path} sha256={load.sha256 || ''} readerSections={load.readerSections} onEditSelection={onEditSelection} editDisabled={editDisabled} readerEditing={readerEditing} readOnly={readOnly} key={video.index} video={video} checked={checked[unit] === true} expanded={visibleUnit === unit} onToggle={() => setExpandedUnit(visibleUnit === unit ? null : unit)} onChange={(value) => onChange(unit, value)} total={totalUnits} position={requiredUnitIds.indexOf(unit) + 1} />;
      })}
      {contentPackage.opinions.map((opinion) => {
        const unit = `opinion-${opinion.index}` as ContentPackageReviewUnit;
        return <OpinionReview path={path} sha256={load.sha256 || ''} readerSections={load.readerSections} onEditSelection={onEditSelection} editDisabled={editDisabled} readerEditing={readerEditing} readOnly={readOnly} key={opinion.index} opinion={opinion} checked={checked[unit] === true} expanded={visibleUnit === unit} onToggle={() => setExpandedUnit(visibleUnit === unit ? null : unit)} onChange={(value) => onChange(unit, value)} total={totalUnits} position={requiredUnitIds.indexOf(unit) + 1} native={nativePackage} />;
      })}

      {nativePackage && (
        <details>
          <summary className="cursor-pointer text-sm text-[#6B6B6B]">内容质量标准</summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4" aria-label="内容质量标准">
          {[
            ['事实可信', '事实、数字、案例和引用都能回到本期素材或公开来源。'],
            ['有信息量', '不是正确的废话；每一段或每一页都推进一个判断。'],
            ['平台原生', '标题、开头、结构和互动符合当前平台，而非跨平台改写。'],
            ['表达自然', '像真人在写或说，删除套话、重复结论和模型自述。'],
          ].map(([label, detail]) => (
            <div key={label} className="rounded-lg border border-[rgba(28,28,30,0.1)] bg-white px-3 py-2.5">
              <p className="text-[11px] font-bold text-[#1A1A1A]">{label}</p>
              <p className="mt-1 text-[10px] leading-[1.55] text-[#6B6B6B]">{detail}</p>
            </div>
          ))}
        </div>
        </details>
      )}

      <TechnicalDetails>
        <TechnicalDetailList items={[{ label: '内容文件', value: path }]} />
      </TechnicalDetails>

      {status === 'ready' && !readOnly && (
        <div className={`flex items-start gap-2 rounded-lg border-l-[3px] px-3 py-3 text-[12px] leading-[1.6] ${ready ? 'border-[#16803C] bg-[#EDF8F0] text-[#176936]' : 'border-[#E4A43B] bg-[#FFF8E8] text-[#6B5543]'}`}>
          {ready ? <Check size={16} className="mt-0.5 shrink-0" /> : <CircleAlert size={16} className="mt-0.5 shrink-0" />}
          <span>{ready ? '全部平台内容已通过你的质量确认，可以进入智能排版。' : '请按事实、信息量、平台原生和表达自然逐项确认。全部确认后才能进入智能排版。'}</span>
        </div>
      )}
    </div>
  );
}
