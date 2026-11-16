'use client';

import { OutputDownloadLink } from '@/components/OutputDownloadLink';
import Image from 'next/image';
import {
  Check,
  Clipboard,
  ExternalLink,
  FileDown,
  FileText,
  Images,
  LoaderCircle,
  Mic2,
  RefreshCw,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  groupProductionDeliverables,
  type FinalDeliverableGroupId,
  type ProductionDraftJob,
  type ProductionDraftQueue,
} from '@/lib/production-flow';
import { displayClientError } from '@/lib/client-error-copy';
import { outputHref } from '@/lib/output-links';
import { copyOutput } from '@/lib/output-copy';
import { XHS_COPY_MISMATCH } from '@/electron/native-xhs-copy.cjs';
import { spokenScript } from '@/lib/publication-text';
import { PublicationTextActions } from './PublicationTextActions';
import {
  parseContentPackageReview,
  type ContentPackageReviewArticle,
  type ContentPackageReviewOpinion,
  type ContentPackageReviewVideo,
  type ParsedContentPackageReview,
} from './ContentPackageReview';

type Props = {
  packagePath?: string | null;
  queue: ProductionDraftQueue;
  onReviewReadyChange?: (ready: boolean) => void;
};

type LoadState = {
  requestKey: string;
  status: 'loading' | 'ready' | 'error';
  content: ParsedContentPackageReview | null;
  error: string;
};

const GROUP_ICONS = {
  article: FileText,
  'social-cards': Images,
  'video-scripts': Mic2,
} satisfies Record<FinalDeliverableGroupId, typeof FileText>;

const GROUP_DISPLAY_COPY: Record<FinalDeliverableGroupId, { label: string; targets: string[] }> = {
  article: { label: '公众号文章', targets: ['公众号'] },
  'social-cards': { label: '小红书图文', targets: ['小红书'] },
  'video-scripts': { label: '视频号口播稿', targets: ['视频号'] },
};

export function hasReviewedEveryDeliverableGroup(
  reviewed: Iterable<FinalDeliverableGroupId>,
  required: Iterable<FinalDeliverableGroupId>,
): boolean {
  const reviewedSet = new Set(reviewed);
  const requiredGroups = [...required];
  return requiredGroups.length > 0 && requiredGroups.every((group) => reviewedSet.has(group));
}

function imagePath(path: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|avif)$/i.test(path);
}

export function displayDeliverableError(error: unknown): string {
  return displayClientError(error, '发布成品没有读取成功。请重新生成后再试。')
    .replace(/三类成品/g, '发布成品')
    .replace(/资产/g, '配图');
}

type DisplayAsset = { id?: string; role?: string; path: string };

function uniqueAssets(jobs: ProductionDraftJob[]): DisplayAsset[] {
  const assets: DisplayAsset[] = jobs.flatMap((job) => [
    ...(job.selected_asset_hashes || []).map((asset) => ({
      id: asset.id,
      role: asset.role,
      path: asset.path,
    })),
    ...(job.payload.asset_paths || []).map((path): DisplayAsset => ({ path })),
  ]).filter((asset) => imagePath(asset.path));
  const selected = new Map<string, DisplayAsset>();
  for (const asset of assets) {
    const current = selected.get(asset.path);
    if (!current || (!current.id && asset.id) || (!current.role && asset.role)) selected.set(asset.path, asset);
  }
  return [...selected.values()];
}

function uniqueAssetPaths(jobs: ProductionDraftJob[]): string[] {
  return uniqueAssets(jobs).map((asset) => asset.path);
}

function itemIndex(job: ProductionDraftJob): number {
  const match = job.item_id.match(/(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function jobsForItem(jobs: ProductionDraftJob[], index: number): ProductionDraftJob[] {
  return jobs.filter((job) => itemIndex(job) === index);
}

function cleanScript(value: string): string {
  return value
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/^([^：:\n]{1,12})[：:]\s*/, '$1：').trim())
    .filter(Boolean)
    .join('\n\n');
}

type CopyButtonProps = { value: string; sourcePath: string; label?: string };

export function CopyButton(props: CopyButtonProps) {
  // A different source or text starts a fresh control, including pending and manual-copy state.
  return <CopyButtonControl key={JSON.stringify([props.sourcePath, props.value])} {...props} />;
}

function CopyButtonControl({ value, sourcePath, label = '复制' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [copying, setCopying] = useState(false);
  const [prepared, setPrepared] = useState({ text: '', notice: '' });
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; }, []);
  return (
    <span className="inline-flex flex-col items-start gap-2">
    <button
      type="button"
      disabled={copying}
      onClick={async () => {
        setCopying(true);
        setCopied(false);
        setCopyFailed(false);
        const request = ++generation.current;
        const current = await copyOutput(sourcePath, value, {
          isCurrent: () => request === generation.current,
          writeText: (text) => navigator.clipboard.writeText(text),
        });
        if (current.status === 'cancelled') return;
        setPrepared(current);
        setCopying(false);
        setCopied(current.status === 'copied');
        setCopyFailed(current.status === 'manual');
        if (current.status === 'copied') window.setTimeout(() => {
          if (request === generation.current) setCopied(false);
        }, 1600);
      }}
      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[rgba(28,28,30,0.14)] bg-white px-2.5 text-[11px] font-bold text-[#4F4A45] transition-colors hover:border-[#E85D4C] hover:text-[#C94A3B] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E85D4C]"
    >
      {copying ? <LoaderCircle size={13} className="animate-spin" /> : copied ? <Check size={13} /> : <Clipboard size={13} />}
      {copying ? '核对使用说明…' : copied ? '已复制' : label}
    </button>
    {prepared.notice && !copying && <span role="status" className="max-w-72 text-xs text-[#8D5A00]">{prepared.notice.split('\n')[0]}；使用说明已附在文字前。</span>}
    {copyFailed && (
      <span className="block w-full min-w-64">
        <span role="status" className="block text-xs text-[#8D5A00]">自动复制不可用。点击下方文字全选后手动复制，成品仍然保留。</span>
        <textarea aria-label={`${label}：手动复制`} readOnly value={prepared.text} onFocus={(event) => event.currentTarget.select()} className="mt-2 block w-full rounded border p-2 text-xs" rows={5} />
      </span>
    )}
    </span>
  );
}

function AssetImage({ path, alt, shape = 'wide' }: { path: string; alt: string; shape?: 'wide' | 'portrait' | 'square' }) {
  return (
    <div className="min-w-0">
    <div className={`relative overflow-hidden rounded-lg bg-[#F1ECE6] ${shape === 'portrait' ? 'aspect-[3/4]' : shape === 'square' ? 'aspect-square' : 'aspect-[16/9]'}`}>
      <Image
        src={outputHref(path, 'view')}
        alt={alt}
        fill
        sizes={shape === 'wide' ? '(max-width: 768px) 100vw, 720px' : '(max-width: 768px) 46vw, 180px'}
        className="object-contain"
        unoptimized
      />
    </div>
    <OutputDownloadLink href={outputHref(path, 'download')} aria-label={`下载${alt}与使用说明`} title="下载包含原图和使用说明的 ZIP 文件" className="mt-1 inline-flex items-center gap-1 text-xs text-[#4F4A45] underline underline-offset-2"><FileDown size={12} />下载图片与使用说明</OutputDownloadLink>
    </div>
  );
}

function articleBlocks(body: string): string[] {
  return body.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
}

function ArticleBody({ article, images }: { article: ContentPackageReviewArticle; images: string[] }) {
  const blocks = articleBlocks(article.body);
  const insertionPoints = new Map<number, string[]>();
  images.forEach((path, index) => {
    const point = Math.min(blocks.length - 1, Math.max(0, Math.floor(((index + 1) * blocks.length) / (images.length + 1))));
    insertionPoints.set(point, [...(insertionPoints.get(point) || []), path]);
  });
  return (
    <div className="mx-auto max-w-[720px] text-[15px] leading-[1.9] text-[#303030]">
      {blocks.map((block, index) => {
        const isHeading = /^####\s+/.test(block);
        const isQuote = block.startsWith('>');
        return (
          <Fragment key={`${block.slice(0, 24)}-${index}`}>
            {isHeading ? (
              <h4 className="mb-2 mt-7 text-[19px] font-bold tracking-[-0.02em] text-[#1A1A1A]">{block.replace(/^####\s+/, '')}</h4>
            ) : isQuote ? (
              <blockquote className="my-5 border-l-[3px] border-[#E85D4C] bg-[#FFF7F3] px-4 py-3 font-semibold text-[#4F4A45]">{block.replace(/^>\s?/, '')}</blockquote>
            ) : (
              <p className="my-4 whitespace-pre-wrap">{block}</p>
            )}
            {(insertionPoints.get(index) || []).map((path, imageIndex) => (
              <figure key={path} className="my-6">
                <AssetImage path={path} alt={`公众号正文配图 ${imageIndex + 1}`} />
              </figure>
            ))}
          </Fragment>
        );
      })}
    </div>
  );
}

function ArticleDeliverable({ article, jobs, sourcePath }: { article: ContentPackageReviewArticle; jobs: ProductionDraftJob[]; sourcePath: string }) {
  const assets = uniqueAssets(jobs);
  const coverAsset = assets.find((asset) => (
    /wechat[_-]?cover/i.test(asset.role || '')
    || /wechat[_-]?cover/i.test(asset.id || '')
    || /wechat-cover/i.test(asset.path)
  ));
  const inlineAssets = assets.filter((asset) => (
    /^inline-/i.test(asset.role || '')
    || /^inline-/i.test(asset.id || '')
    || /\/inline\//i.test(asset.path)
  ));
  const cover = coverAsset?.path;
  const inline = inlineAssets.map((asset) => asset.path).slice(0, 6);
  const htmlPath = jobs.map((job) => job.payload.html_path).find(Boolean);
  return (
    <article>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[rgba(28,28,30,0.08)] pb-4">
        <div>
          <p className="text-[11px] font-bold text-[#C94A3B]">公众号文章 · {htmlPath ? '微信 HTML 已生成' : '缺少微信 HTML'}</p>
          <h3 className="mt-1.5 text-[22px] font-bold tracking-[-0.025em] text-[#1A1A1A]">{article.title}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton sourcePath={sourcePath} value={`${article.title}\n\n${article.body}`} label="复制文章" />
          {htmlPath && (
            <a href={outputHref(htmlPath, 'view')} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#1C1C1E] px-2.5 text-[11px] font-bold text-white hover:bg-[#353535] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E85D4C]">
              <ExternalLink size={13} />打开排版后的文章
            </a>
          )}
          {htmlPath && <OutputDownloadLink href={outputHref(htmlPath, 'download')} className="inline-flex h-8 items-center gap-1 text-xs text-[#4F4A45] underline underline-offset-2"><FileDown size={13} />下载排版文章</OutputDownloadLink>}
        </div>
      </div>
      {!htmlPath && (
        <div className="mt-5 rounded-lg border border-[#E9B7AF] bg-[#FFF4F1] px-4 py-3 text-[13px] font-semibold text-[#8F3329]">
          还没有生成可复制的微信 HTML，暂时不能确认。请点击“重新整理成品”。
        </div>
      )}
      {cover && <div className="mx-auto mt-5 max-w-[860px]"><AssetImage path={cover} alt="公众号文章封面" /></div>}
      {article.summary && <p className="mx-auto mt-5 max-w-[720px] border-y border-[rgba(28,28,30,0.08)] py-4 text-[13px] leading-[1.7] text-[#6B6B6B]">{article.summary}</p>}
      <ArticleBody article={article} images={inline} />
    </article>
  );
}

function MissingCardImages({ platform }: { platform: '小红书' | '朋友圈' }) {
  return (
    <div className="rounded-lg border border-[#E9B7AF] bg-[#FFF4F1] px-3 py-3 text-[12px] font-semibold text-[#8F3329]">
      {platform}图片还没有准备好。请重新整理成品后再检查。
    </div>
  );
}

function SocialCardsDeliverable({ opinions, jobs, native, sourcePath, sha256 }: { opinions: ContentPackageReviewOpinion[]; jobs: ProductionDraftJob[]; native: boolean; sourcePath: string; sha256: string }) {
  return (
    <div className="space-y-6">
      {opinions.map((opinion) => {
        const itemJobs = jobsForItem(jobs, opinion.index);
        const expectedXhsPages = native ? 8 : 5;
        const xhsAssets = uniqueAssetPaths(itemJobs.filter((job) => job.platform === 'xiaohongshu')).slice(0, expectedXhsPages);
        const momentsAssets = uniqueAssetPaths(itemJobs.filter((job) => job.platform === 'moments')).slice(0, 3);
        const xhs = opinion.platformForms.xiaohongshu;
        const moments = opinion.platformForms.moments;
        const copyValue = native
          ? [xhs.title || opinion.title, xhs.copy || opinion.copy, xhs.tags].filter(Boolean).join('\n\n')
          : [xhs.title || opinion.title, xhs.copy || opinion.copy, xhs.tags, '', '朋友圈：', moments.copy || opinion.copy].filter(Boolean).join('\n');
        return (
          <article key={opinion.index} className="rounded-xl bg-[#FDF8F3] p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-bold text-[#C94A3B]">小红书原生图文 {opinion.index} · P1-P{expectedXhsPages}</p>
                <h3 className="mt-1.5 text-[18px] font-bold tracking-[-0.02em] text-[#1A1A1A]">{opinion.title}</h3>
                {!native && opinion.coreViewpoint && <p className="mt-2 max-w-[680px] text-[13px] leading-[1.65] text-[#4F4A45]">{opinion.coreViewpoint}</p>}
              </div>
              {native ? <PublicationTextActions sourcePath={sourcePath} sha256={sha256} label="小红书文案复制"
                fields={[{ field: 'xhs-title', label: '标题' }, { field: 'xhs-body', label: '正文与标签' }]} />
                : <CopyButton sourcePath={sourcePath} value={copyValue} label="复制配文" />}
            </div>
            <div className={`mt-4 grid gap-4 ${native ? '' : 'xl:grid-cols-[5fr_3fr]'}`}>
              <div>
                <p className="mb-2 text-[11px] font-bold text-[#8A8178]">小红书 · 第 1 至 {expectedXhsPages} 张竖图</p>
                {xhsAssets.length === expectedXhsPages ? (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {xhsAssets.map((path, index) => <AssetImage key={path} path={path} alt={`图文卡片 ${opinion.index} 的小红书图片 ${index + 1}`} shape="portrait" />)}
                </div>
                ) : <MissingCardImages platform="小红书" />}
              </div>
              {!native && <div>
                <p className="mb-2 text-[11px] font-bold text-[#8A8178]">朋友圈 · 第 1、3、5 张方图</p>
                {momentsAssets.length === 3 ? (
                  <div className="grid grid-cols-3 gap-2">
                    {momentsAssets.map((path, index) => <AssetImage key={path} path={path} alt={`图文卡片 ${opinion.index} 的朋友圈图片 ${index + 1}`} shape="square" />)}
                  </div>
                ) : <MissingCardImages platform="朋友圈" />}
              </div>}
            </div>
            <div className={`mt-4 grid gap-3 ${native ? '' : 'md:grid-cols-2'}`}>
              {!native && <div className="rounded-lg bg-white px-3 py-3">
                <p className="text-[11px] font-bold text-[#8A8178]">小红书配文</p>
                <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-[1.65] text-[#303030]">{xhs.copy || opinion.copy}</p>
              </div>}
              <div className="rounded-lg bg-white px-3 py-3">
                <p className="text-[11px] font-bold text-[#8A8178]">{native ? '小红书发布正文与标签' : '朋友圈配文'}</p>
                <p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-[1.65] text-[#303030]">
                  {native
                    ? [xhs.copy || opinion.copy, xhs.tags].filter(Boolean).join('\n\n')
                    : moments.copy || opinion.copy}
                </p>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function VideoScriptsDeliverable({ videos, jobs, sourcePath, sha256, native }: { videos: ContentPackageReviewVideo[]; jobs: ProductionDraftJob[]; sourcePath: string; sha256: string; native: boolean }) {
  return (
    <div className={`grid gap-4 ${native ? '' : 'xl:grid-cols-2'}`}>
      {videos.map((video) => {
        const itemJobs = jobsForItem(jobs, video.index);
        const path = itemJobs.map((job) => job.payload.execution_package_path || job.payload.copy_path).find(Boolean);
        let script = cleanScript(video.oralScript || video.lineScript);
        let segments: ReturnType<typeof spokenScript>['segments'] = [];
        if (native) {
          try { const spoken = spokenScript(video.lineScript || video.oralScript); script = spoken.text; segments = spoken.segments; }
          catch { return <p key={video.index} role="alert" className="text-sm text-[#943D30]">口播文案还无法完整识别，请返回正文核对后重新整理成品。</p>; }
        }
        return (
          <article key={video.index} className="rounded-xl bg-[#FDF8F3] p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-bold text-[#C94A3B]">视频稿 {video.index} · {video.duration || '短视频'}</p>
                <h3 className="mt-1.5 text-[18px] font-bold tracking-[-0.02em] text-[#1A1A1A]">{video.title}</h3>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {!native && <CopyButton sourcePath={sourcePath} value={script} label="复制视频稿" />}
                {path && <a href={outputHref(path, 'view')} target="_blank" rel="noreferrer" aria-label={`打开口播稿 ${video.index}`} className="flex h-8 w-8 items-center justify-center rounded-md border border-[rgba(28,28,30,0.14)] bg-white text-[#4F4A45] hover:border-[#E85D4C] hover:text-[#C94A3B]"><ExternalLink size={13} /></a>}
                {path && <OutputDownloadLink href={outputHref(path, 'download')} className="inline-flex h-8 items-center gap-1 text-xs text-[#4F4A45] underline underline-offset-2"><FileDown size={13} />{native ? '下载口播稿与拍摄说明' : '下载口播稿'}</OutputDownloadLink>}
              </div>
            </div>
            {native && <div className="mt-4"><PublicationTextActions sourcePath={sourcePath} sha256={sha256} label="视频号文案复制"
              fields={[{ field: 'video-title', label: '标题' }, { field: 'video-spoken', label: '口播文案' }]} /></div>}
            {!native && video.hook && <p className="mt-4 border-l-[3px] border-[#E85D4C] bg-white px-3 py-2.5 text-[13px] font-semibold leading-[1.6] text-[#4F4A45]">{video.hook}</p>}
            <div aria-label={native ? '可直接朗读的口播文案' : undefined} className={`mt-4 whitespace-pre-wrap ${native ? 'text-[16px]' : 'text-[14px]'} leading-[1.85] text-[#303030]`}>{script}</div>
            {native && <details className="mt-5 border-t border-[#DED7D0] pt-3 text-sm text-[#5B5148]">
              <summary className="cursor-pointer font-semibold">查看分段时间、字幕与画面</summary>
              {video.hook && <p className="mt-3 leading-6">开场提示：{video.hook}</p>}
              {segments.map((segment, index) => <div key={index} className="mt-3 rounded-md bg-white p-3">
                <p className="font-semibold">{segment.time || `第 ${index + 1} 段`}</p>
                <p className="mt-2 whitespace-pre-wrap leading-6">{segment.words}</p>
                {segment.subtitle && <p className="mt-2 text-xs leading-6">字幕：{segment.subtitle}</p>}
                {segment.picture && <p className="text-xs leading-6">画面：{segment.picture}</p>}
              </div>)}
              {video.bRoll.length > 0 && <div className="mt-3"><p className="font-semibold">补充画面</p><ul className="mt-1 list-disc pl-5 leading-6">{video.bRoll.map((line, index) => <li key={index}>{line}</li>)}</ul></div>}
            </details>}
          </article>
        );
      })}
    </div>
  );
}

export function FinalDeliverablesReview({ packagePath, queue, onReviewReadyChange }: Props) {
  const [reload, setReload] = useState(0);
  const [load, setLoad] = useState<LoadState>({ requestKey: '', status: 'loading', content: null, error: '' });
  const path = packagePath?.trim() || queue.package_path;
  const groups = useMemo(() => groupProductionDeliverables(queue), [queue]);
  const firstGroup = groups[0]?.id || 'article';
  const xhs = queue.target_platforms?.includes('xiaohongshu') ? queue.jobs.find((job) => job.platform === 'xiaohongshu') : undefined;
  const copyReviewUrl = xhs ? `/api/publish/drafts?${new URLSearchParams({
    queuePath: `materials/publication/drafts/${queue.run_slug}/draft-queue.json`, review: '1',
    source: queue.package_sha256 || '', copy: xhs.content_hash || '', payload: xhs.payload_hash || '',
  })}` : '';
  const reviewKey = JSON.stringify([path, queue.package_sha256, copyReviewUrl,
    queue.jobs.map((job) => [job.job_id, job.payload_hash, job.content_hash])]);
  const [reviewState, setReviewState] = useState<{
    path: string;
    active: FinalDeliverableGroupId;
    reviewed: Set<FinalDeliverableGroupId>;
  }>(() => ({ path: reviewKey, active: firstGroup, reviewed: new Set([firstGroup]) }));
  const requestKey = `${reviewKey}:${reload}`;
  const status = load.requestKey === requestKey ? load.status : 'loading';
  const active = reviewState.path === reviewKey ? reviewState.active : firstGroup;
  const reviewed = useMemo(
    () => reviewState.path === reviewKey ? reviewState.reviewed : new Set<FinalDeliverableGroupId>([firstGroup]),
    [firstGroup, reviewKey, reviewState],
  );

  useEffect(() => {
    onReviewReadyChange?.(status === 'ready' && hasReviewedEveryDeliverableGroup(
      reviewed,
      groups.map((group) => group.id),
    ));
  }, [groups, onReviewReadyChange, reviewed, status]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(outputHref(path), { cache: 'no-store', signal: controller.signal });
        const payload = await response.json() as { content?: unknown; error?: unknown };
        if (!response.ok || typeof payload.content !== 'string') {
          throw new Error(typeof payload.error === 'string' ? payload.error : '发布成品读取失败。');
        }
        if (queue.package_sha256) {
          const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload.content));
          const sourceHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
          if (sourceHash !== queue.package_sha256) throw new Error('原稿已更新，请重新整理成品后再核对。');
        }
        if (copyReviewUrl) {
          const verification = await fetch(copyReviewUrl, { cache: 'no-store', signal: controller.signal });
          if (!verification.ok) throw new Error(XHS_COPY_MISMATCH);
        }
        const parsed = parseContentPackageReview(payload.content);
        if (!parsed.package || parsed.errors.length) throw new Error(parsed.errors[0] || '发布成品暂时无法读取。');
        if (controller.signal.aborted) return;
        setLoad({ requestKey, status: 'ready', content: parsed.package, error: '' });
      } catch (error) {
        if (controller.signal.aborted || error instanceof DOMException && error.name === 'AbortError') return;
        setLoad({ requestKey, status: 'error', content: null, error: displayDeliverableError(error) });
      }
    })();
    return () => controller.abort();
  }, [path, requestKey, copyReviewUrl, queue.package_sha256]);

  if (status === 'loading') {
    return <div className="flex items-center gap-2 rounded-xl bg-[#FDF8F3] px-4 py-6 text-[13px] text-[#6B6B6B]"><LoaderCircle size={16} className="animate-spin text-[#E85D4C]" />正在整理发布成品…</div>;
  }
  if (status === 'error' || !load.content) {
    return (
      <div role="alert" className="rounded-xl bg-[#FFF4F1] px-4 py-4 text-[13px] text-[#8F3329]">
        <p>{displayDeliverableError(load.error || '发布成品读取失败。')}</p>
        <button type="button" onClick={() => setReload((value) => value + 1)} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-[rgba(143,51,41,0.3)] bg-white px-2.5 text-[11px] font-bold"><RefreshCw size={13} />重新读取</button>
      </div>
    );
  }

  const activeGroup = groups.find((group) => group.id === active) || groups[0];
  const reviewedCount = groups.filter((group) => reviewed.has(group.id)).length;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#6B6B6B]">
        <p>依次查看本期已选平台的成品，最后统一确认。</p>
        <span className="font-bold text-[#1A1A1A]">已查看 {reviewedCount}/{groups.length}</span>
      </div>
      <div className="grid gap-2 md:grid-cols-3" role="tablist" aria-label="本期发布成品">
        {groups.map((group) => {
          const Icon = GROUP_ICONS[group.id];
          const display = GROUP_DISPLAY_COPY[group.id];
          const selected = active === group.id;
          return (
            <button
              key={group.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                setReviewState((current) => ({
                  path: reviewKey,
                  active: group.id,
                  reviewed: new Set<FinalDeliverableGroupId>(
                    current.path === reviewKey ? current.reviewed : [firstGroup],
                  ).add(group.id),
                }));
              }}
              className={`flex min-h-[84px] items-start gap-3 rounded-xl px-4 py-3 text-left transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E85D4C] ${selected ? 'bg-[#1C1C1E] text-white shadow-[0_8px_24px_rgba(42,30,22,0.14)]' : 'bg-[#F4EFE9] text-[#1A1A1A] hover:bg-[#ECE5DD]'}`}
            >
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-[#E85D4C] text-white' : 'bg-white text-[#C94A3B]'}`}><Icon size={16} /></span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[13px] font-bold">
                  {reviewed.has(group.id) && <Check size={13} aria-label="已查看" />}
                  {display.label} · {group.countLabel}
                </span>
                <span className={`mt-1 block text-[11px] leading-[1.45] ${selected ? 'text-[#D8D2CC]' : 'text-[#6B6B6B]'}`}>{group.targetLabels.join('、')}</span>
              </span>
            </button>
          );
        })}
      </div>
      <section className="mt-4 rounded-xl border border-[rgba(28,28,30,0.1)] bg-white p-4 sm:p-6" role="tabpanel">
        {activeGroup.id === 'article' && <ArticleDeliverable article={load.content.article} jobs={activeGroup.jobs} sourcePath={path} />}
        {activeGroup.id === 'social-cards' && <SocialCardsDeliverable opinions={load.content.opinions} jobs={activeGroup.jobs} native={Boolean(queue.target_platforms)} sourcePath={path} sha256={queue.package_sha256 || ''} />}
        {activeGroup.id === 'video-scripts' && <VideoScriptsDeliverable videos={load.content.videos} jobs={activeGroup.jobs} native={Boolean(queue.target_platforms)} sourcePath={path} sha256={queue.package_sha256 || ''} />}
      </section>
    </div>
  );
}
