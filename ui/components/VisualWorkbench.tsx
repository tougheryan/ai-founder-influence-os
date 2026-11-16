"use client";

import { OutputDownloadLink } from '@/components/OutputDownloadLink';
import { WechatLayoutCopyButton } from '@/components/WechatLayoutCopyButton';
import { useMemo, useState } from "react";
import Image from "next/image";
import {
  Check,
  CircleAlert,
  Eye,
  ExternalLink,
  FileDown,
  GalleryHorizontalEnd,
  ImageIcon,
  LoaderCircle,
  MessageSquareMore,
  PanelsTopLeft,
  Replace,
  Send,
} from "lucide-react";
import { PRODUCTION_STATUS_DISPLAY_NAMES } from "@/lib/product-copy";
import { outputHref as outputLink } from "@/lib/output-links";
import type { VisualWorkbenchAsset, VisualWorkbenchState } from "@/lib/visual-workbench";
import {
  buildVisualAssetSuites,
  type VisualAssetSuite,
  type VisualSuitePlatform,
} from "@/lib/visual-suite";

type Props = {
  state: VisualWorkbenchState;
  onRequestRevision: (request: string, assetIds: string[], baseRevisionId: string) => Promise<string | void>;
  onAdoptAsset?: (revisionId: string, assetId: string) => Promise<void>;
  onAdoptAllAssets?: (revisionId: string, assetIds: string[], reconfirm?: boolean) => Promise<void>;
  selectionNeedsReview?: boolean;
  onRegenerate?: () => void;
  onReviewCopy?: () => void;
  regenerationPending?: boolean;
};

type WorkbenchSuite = VisualAssetSuite<VisualWorkbenchAsset>;

function outputHref(path: string): string {
  return outputLink(path, "view");
}

function outputDownloadHref(path: string): string {
  return outputLink(path, "download");
}

function revisionLabel(status: string): string {
  if (status === "ready") return "已生成";
  if (status === "blocked") return "需要调整";
  if (status === "review_required") return PRODUCTION_STATUS_DISPLAY_NAMES.blocked;
  if (status === "rendering") return PRODUCTION_STATUS_DISPLAY_NAMES.running;
  return PRODUCTION_STATUS_DISPLAY_NAMES.failed;
}

function revisionClass(status: string): string {
  if (status === "ready" || status === "review_required" || status === "rendering") return "bg-[#FFF8E8] text-[#A66300]";
  return "bg-[#FFF1EE] text-[#D84F40]";
}

function qualityClass(quality: string): string {
  if (quality === "pass") return "bg-[#EDF8F0] text-[#16803C]";
  if (quality === "review_required" || quality === "not_checked") return "bg-[#FFF8E8] text-[#A66300]";
  return "bg-[#FFF1EE] text-[#D84F40]";
}

function qualityLabel(quality: string): string {
  if (quality === "pass") return "可以使用";
  if (quality === "review_required") return "请检查";
  if (quality === "not_checked") return "检查中";
  return "暂时不能用";
}

function isPreviewableImage(path: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(path);
}

function isHtmlLayout(path: string): boolean {
  return /\.html?$/i.test(path);
}

function platformLabel(platform: VisualSuitePlatform): string {
  return platform === "social" ? "小红书图文卡片" : "公众号排版";
}

function platformDescription(platform: VisualSuitePlatform): string {
  return platform === "social"
    ? "查看 P1-P8 八张图文卡片，确认后即可进入发布准备。"
    : "直接查看已经生成的公众号全文排版，确认后即可进入草稿准备。";
}

function assetRoleLabel(asset: VisualWorkbenchAsset): string {
  if (asset.id === "wechat-html" || isHtmlLayout(asset.path)) return "公众号正文排版";
  if (asset.role === "cover" || /(?:cover|-p1)$/i.test(asset.id)) return "封面";
  if (asset.role === "cta" || /-p8$/i.test(asset.id)) return "结尾图";
  return "正文配图";
}

const DEFAULT_VISUAL_REASON = "这组平台成品暂时不能使用，请重新生成。";

function containsInternalVisualTerm(text: string): boolean {
  return /schema|slug|revision|renderer|json|legacy|runtime|pipeline|hash|sha(?:-?256)?|cta|b[- ]?roll|asset|artifact|snapshot|queue|证据图|视觉资产/i.test(text)
    || /(?:^|[\s_.:/-])(?:id|run)(?:$|[\s_.:/-])/i.test(text)
    || /\/Users\/|\\|[a-f0-9]{32,64}/i.test(text);
}

function displaySuiteTitle(suite: WorkbenchSuite): string {
  const title = suite.title.trim();
  return title && !containsInternalVisualTerm(title) ? title : suite.label;
}

function reasonText(reason: unknown): string {
  if (typeof reason === "string") return reason.trim();
  if (reason instanceof Error) return reason.message.trim();
  return "";
}

/** Keep runtime diagnostics intact while exposing only a short, actionable explanation. */
export function displayVisualReason(reason: unknown): string {
  const text = reasonText(reason);
  if (!text) return DEFAULT_VISUAL_REASON;

  const density = /^xhs-\d+-p([1-8]) density [\d.]+% is below [\d.]+%$/.exec(text);
  if (density) return `小红书 P${density[1]} 留白较多。请检查这一页的内容，补充必要说明或调整排版。`;

  if (/等待.*(?:渲染|生成)|修订请求|rendering|queued|processing/i.test(text)) {
    return "平台成品还在生成。请稍后刷新查看。";
  }
  if (/截图来源|来源.*确认|人工.*(?:确认|复核)|文字.*确认|ocr|review_required/i.test(text)) {
    return "这项成品需要你检查。确认内容无误后再选择。";
  }
  if (/legacy|历史视觉|旧版/i.test(text)) {
    return "这组平台成品来自旧版本，暂时不能使用。请重新生成。";
  }
  if (/不存在|为空|符号链接|摘要|校验|sha(?:-?256)?|hash|路径|path/i.test(text)) {
    return "有成品文件缺失或已经变动，暂时不能使用。请重新生成。";
  }
  if (/质量|审美|没有通过|未通过|quality|aesthetic/i.test(text)) {
    return "这组平台成品没有通过检查，请修改后重新生成。";
  }
  if (/连接|密钥|授权|token|timeout|network|fetch|provider/i.test(text)) {
    return "平台排版生成失败，请重新生成。";
  }
  if (/配方|索引|交付清单|完整性|manifest|canonical|\{[\s\S]*\}|\[[\s\S]*\]/i.test(text) || containsInternalVisualTerm(text)) {
    return "这组平台成品的数据不完整，暂时不能使用。请重新生成。";
  }

  const firstSentence = text.split(/[。！？\n]/, 1)[0]
    ?.replace(/视觉资产|证据图/g, "配图")
    .replace(/CTA/gi, "结尾图")
    .replace(/B[- ]?roll/gi, "补充画面")
    .replace(/采用/g, "选择")
    .replace(/复核/g, "检查")
    .replace(/人工/g, "你")
    .trim();
  if (!firstSentence || /[A-Za-z]{3,}/i.test(firstSentence) || containsInternalVisualTerm(firstSentence)) {
    return DEFAULT_VISUAL_REASON;
  }
  return `${firstSentence}。请修改后重新生成。`;
}

function displayVisualIssues(reasons: string[]): string[] {
  const densityPages = new Map<string, Set<number>>();
  const otherIssues = new Set<string>();
  for (const reason of reasons) {
    const density = /^xhs-(\d+)-p([1-8]) density [\d.]+% is below [\d.]+%$/.exec(reason);
    if (!density) { otherIssues.add(displayVisualReason(reason)); continue; }
    const pages = densityPages.get(density[1]) || new Set<number>();
    pages.add(Number(density[2]));
    densityPages.set(density[1], pages);
  }
  return [
    ...[...densityPages].map(([group, pages]) => `小红书${densityPages.size > 1 ? `第 ${Number(group)} 组` : ''} ${[...pages].sort((a, b) => a - b).map((page) => `P${page}`).join('、')} 留白较多。请核对文字是否完整，再调整正文或排版。`),
    ...otherIssues,
  ];
}

function suitesForAssets(assets: VisualWorkbenchAsset[]): WorkbenchSuite[] {
  const wechat = assets.filter((asset) => asset.platform === "wechat" && isHtmlLayout(asset.path));
  const social = assets.filter((asset) => asset.platform === "xhs" || asset.platform === "moments");
  return [
    ...(wechat.length ? buildVisualAssetSuites("wechat", wechat) : []),
    ...(social.length ? buildVisualAssetSuites("social", social) : []),
  ];
}

function suiteIsStructurallyComplete(suite: WorkbenchSuite): boolean {
  if (suite.platform === "social") {
    const pages = suite.previewAssets.flatMap((asset) => asset.id.match(/-p([1-8])$/i)?.[1] || []);
    return new Set(pages).size === 8;
  }
  return suite.assets.some((asset) => asset.id === "wechat-html" && isHtmlLayout(asset.path));
}

function adoptedBundleHref(state: VisualWorkbenchState, suite: WorkbenchSuite): string | null {
  const selection = state.adoptedAssetManifest?.selectionSha256;
  const pages = suite.previewAssets;
  if (suite.id !== 'social-01' || !selection || pages.length !== 8 || new Set(pages.map((asset) => asset.revisionId)).size !== 1
    || pages.some((asset, index) => asset.id !== `xhs-01-p${index + 1}` || asset.quality !== 'pass' || !asset.nativeCopyVerified)) return null;
  return `/api/visual/download?${new URLSearchParams({ slug: state.slug, post: '1', selection })}`;
}

function WechatLayoutSummary({ asset }: { asset: VisualWorkbenchAsset }) {
  const layout = asset.wechatLayout;
  return <p className={`mt-2 text-[13px] leading-relaxed ${layout?.usedFallback ? 'text-[#9B5322]' : 'text-[#5D5852]'}`}>
    {!layout ? '这份旧成品没有记录实际排版样式，请打开全文核对。'
      : layout.usedFallback ? `当前是基础排版，原选样式 ${layout.requestedTheme} 未应用。`
        : layout.locallyRefined ? `md2wechat · ${layout.renderedTheme} · 已调整标题与间距`
          : layout.renderedTheme ? `实际样式：${layout.renderedTheme}`
          : `原选样式：${layout.requestedTheme}；实际样式未记录，请打开全文核对。`}
  </p>;
}

function WechatRestyle({ asset, pending, onGenerate, onCancel }: {
  asset: VisualWorkbenchAsset;
  pending: boolean;
  onGenerate: (theme: string) => void;
  onCancel: () => void;
}) {
  const [theme, setTheme] = useState('');
  const choices = asset.wechatLayout?.candidates.filter((candidate) => candidate !== asset.wechatLayout?.requestedTheme) || [];
  return <section aria-label="更换公众号排版样式" className="mt-3 rounded-lg border border-[#E7DCCD] bg-[#FFFBF5] p-3">
    <label className="block text-sm font-bold text-[#1A1A1A]">
      本期可换的样式
      <select value={theme} onChange={(event) => setTheme(event.target.value)} disabled={pending || !choices.length} className="mt-2 block min-h-[44px] w-full rounded-lg border border-[#CFC6BB] bg-white px-3 text-sm font-normal">
        <option value="">选择一种样式</option>
        {choices.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
      </select>
    </label>
    {!choices.length && <p className="mt-2 text-sm text-[#9B5322]">这份成品没有其他可换样式的记录，可以继续使用或查看原排版。</p>}
    <p className="mt-2 text-[13px] leading-relaxed text-[#5D5852]">只生成新的公众号排版，保留已确认的文章和当前成品。看过新旧对比后，再决定是否使用；也可以从成品版本中换回旧版。</p>
    <p className="mt-2 text-[13px] leading-relaxed text-[#795136]">生成会把本期文章发送给 md2wechat 排版服务，可能计费，不计入本期模型调用次数上限。失败请求是否扣费以服务方记录为准。</p>
    <div className="mt-3 flex flex-wrap gap-2">
      <button type="button" disabled={pending || !choices.includes(theme)} onClick={() => onGenerate(theme)} className="min-h-[44px] rounded-lg bg-[#1C1C1E] px-4 text-sm font-bold text-white disabled:opacity-40">{pending ? '正在生成新排版' : '生成这版排版'}</button>
      <button type="button" disabled={pending} onClick={onCancel} className="min-h-[44px] rounded-lg border border-[#CFC6BB] px-4 text-sm text-[#5D5852]">暂不更换</button>
    </div>
  </section>;
}

function WechatComparison({ suite, label }: { suite: WorkbenchSuite; label: string }) {
  const asset = suite.assets.find((item) => item.id === 'wechat-html');
  if (!asset) return null;
  return <section className="min-w-0 rounded-lg border border-[#DED8CF] bg-white p-2" aria-label={label}>
    <h5 className="text-sm font-bold text-[#1A1A1A]">{label}</h5>
    <WechatLayoutSummary asset={asset} />
    <a href={outputHref(asset.path)} target="_blank" rel="noreferrer" className="my-2 inline-flex min-h-[40px] items-center text-sm text-[#476D13] underline">打开{label}全文</a>
    <iframe title={`${label}全文预览`} src={outputHref(asset.path)} sandbox="allow-same-origin" loading="lazy" className="h-[420px] w-full rounded border-0 bg-white" />
  </section>;
}

function SuitePreview({
  suite,
  detailed = false,
  eager = false,
}: {
  suite: WorkbenchSuite;
  detailed?: boolean;
  eager?: boolean;
}) {
  const columns = suite.previewAssets.length === 8 ? "grid-cols-4 lg:grid-cols-8" : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-4";
  return (
    <div className={`grid ${columns} gap-[5px] rounded-[8px] bg-[#F3F0EB] p-[5px]`}>
      {suite.previewAssets.map((asset, index) => {
        const className = `group relative flex min-w-0 items-center justify-center overflow-hidden rounded-[5px] bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E85D4C] ${
          detailed && !isHtmlLayout(asset.path) ? "aspect-[3/4]" : "h-[112px]"
        }`;
        if (isHtmlLayout(asset.path)) {
          return (
            <div key={asset.id} className={className} aria-label="公众号排版已经生成">
              <span className="flex flex-col items-center gap-[7px] px-[12px] text-center text-[#568C13]">
                <PanelsTopLeft size={23} />
                <span className="text-[11px] font-bold">公众号全文排版已生成</span>
                <span className="text-[9px] font-medium text-[#8A8178]">点击下方“查看排版”</span>
              </span>
              <span className="absolute bottom-[5px] right-[5px] rounded-[4px] bg-[rgba(28,28,30,0.78)] px-[5px] py-[2px] text-[9px] text-white">
                公众号排版
              </span>
            </div>
          );
        }
        return (
          <div key={asset.id} className="min-w-0">
          <a
            href={outputHref(asset.path)}
            target="_blank"
            rel="noreferrer"
            aria-label={`查看${assetRoleLabel(asset)}`}
            className={className}
          >
            {isPreviewableImage(asset.path) ? (
            <Image
              src={outputHref(asset.path)}
              alt={assetRoleLabel(asset)}
              fill
              sizes={detailed ? "320px" : "180px"}
              loading={eager && index === 0 ? "eager" : "lazy"}
              unoptimized
              className="object-contain transition-transform duration-200 group-hover:scale-[1.02]"
            />
          ) : (
            <ImageIcon size={18} className="text-[#AAA39B]" />
          )}
          <span className="absolute bottom-[5px] right-[5px] rounded-[4px] bg-[rgba(28,28,30,0.78)] px-[5px] py-[2px] font-mono text-[9px] text-white">
            {assetRoleLabel(asset)}
          </span>
          </a>
          {asset.quality === 'pass' && <OutputDownloadLink href={outputDownloadHref(asset.path)} aria-label={`下载${assetRoleLabel(asset)}与使用说明`} title="下载包含原图和使用说明的 ZIP 文件" className="mt-1 inline-flex items-center gap-1 px-1 text-[10px] text-[#5D5852] underline underline-offset-2"><FileDown size={11} />下载图片与说明</OutputDownloadLink>}
          </div>
        );
      })}
    </div>
  );
}

const COMPARISON_ROLE_LABEL = {
  cover: "封面",
  evidence: "正文配图",
  cta: "结尾图",
} as const;

function ComparisonAsset({
  asset,
  label,
}: {
  asset?: VisualWorkbenchAsset;
  label: string;
}) {
  return (
    <div className="min-w-0 rounded-[8px] border border-[rgba(28,28,30,0.08)] bg-white p-[8px]">
      <p className="mb-[6px] text-[10px] font-bold text-[#6B6B6B]">{label}</p>
      {asset ? (
        <>
          <a
            href={outputHref(asset.path)}
            target="_blank"
            rel="noreferrer"
            className="relative flex aspect-[3/4] items-center justify-center overflow-hidden rounded-[6px] bg-[#F3F0EB] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#568C13]"
          >
            {isPreviewableImage(asset.path) ? (
              <Image src={outputHref(asset.path)} alt={assetRoleLabel(asset)} fill sizes="240px" unoptimized className="object-contain" />
            ) : (
              <ImageIcon size={18} className="text-[#AAA39B]" />
            )}
          </a>
          <p className={`mt-[4px] inline-flex rounded-[5px] px-[6px] py-[2px] text-[9px] font-bold ${qualityClass(asset.quality)}`}>
            {qualityLabel(asset.quality)}
          </p>
        </>
      ) : (
        <div className="flex aspect-[3/4] items-center justify-center rounded-[6px] border border-dashed border-[rgba(28,28,30,0.12)] bg-[#F8F6F2] text-[10px] text-[#8A8178]">这个方案没有对应图片</div>
      )}
    </div>
  );
}

function AdoptedSuiteManifest({
  state,
  adoptedSuites,
  expectedSuiteCount,
}: {
  state: VisualWorkbenchState;
  adoptedSuites: WorkbenchSuite[];
  expectedSuiteCount: number;
}) {
  const manifest = state.adoptedAssetManifest;
  if (!manifest) return null;
  const completeSuites = adoptedSuites.filter(suiteIsStructurallyComplete);
  return (
    <div className="rounded-[10px] border border-[rgba(22,128,60,0.2)] bg-[#F7FCF8] p-[11px]">
      <div className="flex items-center justify-between gap-[8px]">
        <div className="flex items-center gap-[7px]">
          <Check size={15} className="text-[#16803C]" />
          <h3 className="text-[13px] font-bold text-[#1A1A1A]">已选平台成品</h3>
        </div>
        <span className="text-[11px] font-bold tabular-nums text-[#16803C]">
          {completeSuites.length} / {expectedSuiteCount} 组
        </span>
      </div>
      <div className="mt-[8px] space-y-[6px]">
        {completeSuites.map((suite) => (
          <div key={suite.id} className="rounded-[7px] border border-[rgba(22,128,60,0.14)] bg-white px-[9px] py-[8px]">
            <div className="flex items-center justify-between gap-[8px]">
              <div className="min-w-0">
                <p className="truncate text-[11px] font-bold text-[#1A1A1A]">{displaySuiteTitle(suite)}</p>
                <p className="mt-[2px] text-[10px] text-[#6B6B6B]">
                  {suite.platform === "social" ? "小红书 P1-P8" : suite.label}
                </p>
              </div>
              <span className="shrink-0 text-[10px] font-bold text-[#16803C]">
                {suite.platform === "wechat" ? "HTML" : `${suite.previewAssets.length} 张`}
              </span>
            </div>
            {adoptedBundleHref(state, suite) && <><OutputDownloadLink href={adoptedBundleHref(state, suite)!}
              className="mt-2 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-lg bg-[#1C1C1E] px-3 text-[13px] font-bold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#568C13]"
              title="一次下载八张图片、发布文案和使用说明">
              <FileDown size={14} />下载整套图文
            </OutputDownloadLink><p className="mt-1 text-[11px] leading-relaxed text-[#5D5852]">含八张图片、完整文案和使用说明</p></>}
          </div>
        ))}
        {!completeSuites.length && <p className="py-[8px] text-center text-[11px] text-[#8A8178]">还没有选好平台成品</p>}
      </div>
    </div>
  );
}

export function VisualWorkbench(props: Props) {
  return <VisualWorkbenchContent key={props.state.slug} {...props} />;
}

function VisualWorkbenchContent({
  state,
  onRequestRevision,
  onAdoptAsset,
  onAdoptAllAssets,
  selectionNeedsReview = false,
  onRegenerate,
  onReviewCopy,
  regenerationPending = false,
}: Props) {
  const [request, setRequest] = useState("");
  const [revisionTarget, setRevisionTarget] = useState<WorkbenchSuite | null>(null);
  const [revisionAssetTarget, setRevisionAssetTarget] = useState<VisualWorkbenchAsset | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [adoptingSuite, setAdoptingSuite] = useState("");
  const [adoptingAsset, setAdoptingAsset] = useState("");
  const [actionError, setActionError] = useState("");
  const [detailSuiteId, setDetailSuiteId] = useState("");
  const [comparisonSuiteId, setComparisonSuiteId] = useState("");
  const [restyleSuiteKey, setRestyleSuiteKey] = useState("");
  const [requestedPreviewRevisionId, setRequestedPreviewRevisionId] = useState<string | null>(null);
  const restoredPreviewRevisionId = state.hasExplicitAssetSelection
    ? state.assets.find((asset) => asset.id === 'wechat-html')?.revisionId || state.selectedRevisionId
    : state.selectedRevisionId;
  const [followLatestRevision, setFollowLatestRevision] = useState(false);
  const previewRevisionId = followLatestRevision
    ? state.revisions[0]?.revisionId || restoredPreviewRevisionId
    : requestedPreviewRevisionId || restoredPreviewRevisionId;
  const setPreviewRevisionId = (revisionId: string) => {
    setFollowLatestRevision(false);
    setRequestedPreviewRevisionId(revisionId);
  };

  const selected = state.revisions.find((revision) => revision.revisionId === previewRevisionId);
  const issues = displayVisualIssues(selected?.issues || []);
  const adoptedAssetKeys = useMemo(() => new Set(
    state.selectedAssetKeys || (state.hasExplicitSelection ? state.assets.map((asset) => `${asset.revisionId}:${asset.id}`) : []),
  ), [state.assets, state.selectedAssetKeys, state.hasExplicitSelection]);
  const previewAssets = useMemo(() => (
    (state.assetCandidates || state.assets)
      .filter((asset) => asset.revisionId === previewRevisionId && asset.platform !== "video")
  ), [previewRevisionId, state.assetCandidates, state.assets]);
  const candidateSuites = useMemo(() => suitesForAssets(previewAssets), [previewAssets]);
  const adoptedSuites = useMemo(() => state.hasExplicitAssetSelection || state.hasExplicitSelection
    ? suitesForAssets(state.assets.filter((asset) => asset.platform !== "video")) : [], [state.assets, state.hasExplicitAssetSelection, state.hasExplicitSelection]);
  const groups = useMemo(() => (["wechat", "social"] as const).map((platform) => ({
    platform,
    suites: candidateSuites.filter((suite) => suite.platform === platform),
  })).filter((group) => group.suites.length), [candidateSuites]);
  const expectedSuiteCount = (candidateSuites.some((suite) => suite.platform === "wechat") ? 1 : 0)
    + candidateSuites.filter((suite) => suite.platform === "social").length;
  const selectedRevisionIsExplicit = state.hasExplicitSelection;
  const visibleComparison = useMemo(() => state.comparison.filter((item) => {
    const asset = item.right || item.left;
    return asset?.platform !== "wechat";
  }), [state.comparison]);
  const mainStatus = state.hasCompleteAssetSelection
    ? PRODUCTION_STATUS_DISPLAY_NAMES.completed
    : adoptedAssetKeys.size || selectedRevisionIsExplicit
      ? PRODUCTION_STATUS_DISPLAY_NAMES.running
      : '待选择';

  const currentSuiteFor = (suite: WorkbenchSuite): WorkbenchSuite | undefined => {
    if (suite.platform === "wechat") return adoptedSuites.find((item) => item.platform === "wechat");
    return adoptedSuites.find((item) => item.id === suite.id);
  };

  const submitRequest = async () => {
    const value = request.trim();
    const targetIds = revisionAssetTarget
      ? [revisionAssetTarget.id]
      : revisionTarget?.previewAssets.map((asset) => asset.id) || [];
    const baseRevisionId = revisionAssetTarget?.revisionId
      || revisionTarget?.assets[0]?.revisionId
      || "";
    if (!value || targetIds.length === 0 || !baseRevisionId || submitting) return;
    setSubmitting(true);
    setActionError("");
    try {
      const revisionId = await onRequestRevision(value, targetIds, baseRevisionId);
      if (revisionId) setPreviewRevisionId(revisionId);
      setRequest("");
      setRevisionTarget(null);
      setRevisionAssetTarget(null);
    } catch {
      setActionError("排版没有修改成功。请检查提示后重试。");
    } finally {
      setSubmitting(false);
    }
  };

  const changeWechatLayout = async (asset: VisualWorkbenchAsset, theme: string, suiteId: string) => {
    if (submitting) return;
    setSubmitting(true);
    setActionError('');
    try {
      const revisionId = await onRequestRevision(`将公众号排版主题改为 ${theme}，保持文章正文不变。`, [asset.id], asset.revisionId);
      if (revisionId) {
        setPreviewRevisionId(revisionId);
        setDetailSuiteId(`${revisionId}:${suiteId}`);
        setComparisonSuiteId(`${revisionId}:${suiteId}`);
      }
      setRestyleSuiteKey('');
    } catch {
      setActionError('所选样式没有生成成功，原排版仍保留。请检查排版服务后重试；本次请求是否扣费以服务方记录为准。');
    } finally {
      setSubmitting(false);
    }
  };

  const adoptComparisonAsset = async (asset: VisualWorkbenchAsset) => {
    if (!onAdoptAsset || adoptingAsset || asset.status !== "generated" || asset.quality !== "pass") return;
    const key = `${asset.revisionId}:${asset.id}`;
    setAdoptingAsset(key);
    setActionError("");
    try {
      await onAdoptAsset(asset.revisionId, asset.id);
    } catch {
      setActionError("这张配图没有保存成功。请重试。");
    } finally {
      setAdoptingAsset("");
    }
  };

  const adoptSuite = async (suite: WorkbenchSuite) => {
    if (!onAdoptAllAssets || adoptingSuite) return;
    const ids = suite.assets
      .filter((asset) => asset.status === "generated" && asset.quality === "pass")
      .filter((asset) => selectionNeedsReview || !adoptedAssetKeys.has(`${asset.revisionId}:${asset.id}`))
      .map((asset) => asset.id);
    if (!ids.length) return;
    setAdoptingSuite(suite.id);
    setActionError("");
    try {
      const reconfirm = selectionNeedsReview && suite.assets.every((asset) => adoptedAssetKeys.has(`${asset.revisionId}:${asset.id}`));
      await onAdoptAllAssets(suite.assets[0]?.revisionId || previewRevisionId, ids, reconfirm);
    } catch (error) {
      setActionError(error instanceof Error ? displayVisualReason(error) : '这套成品没有保存成功，请重新读取后核对。');
    } finally {
      setAdoptingSuite("");
    }
  };

  return (
    <section data-testid="visual-workbench" className="rounded-[14px] border border-[rgba(28,28,30,0.08)] bg-white p-[16px] shadow-[0_8px_22px_rgba(28,28,30,0.035)]">
      <div className="flex flex-col gap-[10px] md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-[8px]">
            <PanelsTopLeft size={17} className="text-[#568C13]" />
            <h2 className="text-[18px] font-bold tracking-[-0.02em] text-[#1A1A1A]">平台完整发布件</h2>
          </div>
          <p className="mt-[6px] max-w-[680px] text-[14px] leading-[1.65] text-[#5D5852]">
            查看本期已生成的排版与图文，确认无误后继续。
          </p>
          <div className="mt-[8px] flex flex-wrap items-center gap-[6px] text-[13px] text-[#5D5852]">
            <span>{mainStatus}</span>
            {selected && <span className={`rounded-[6px] px-[7px] py-[2px] text-[11px] font-bold ${revisionClass(selected.status)}`}>{revisionLabel(selected.status)}</span>}
          </div>
        </div>
        {selected?.reason && !issues.length && (
          <div data-testid="visual-user-reason" className="flex max-w-[420px] items-start gap-[7px] rounded-[8px] bg-[#FFF8E8] px-[9px] py-[8px] text-[12px] leading-[1.55] text-[#A66300]">
            <CircleAlert size={14} className="mt-[2px] shrink-0" />
            <span>{displayVisualReason(selected.reason)}</span>
          </div>
        )}
      </div>

      {selected?.status === 'blocked' && <section aria-label="需要处理的排版问题" className="mt-4 rounded-lg border border-[#E9D8AD] bg-[#FFF8E8] p-4 text-sm text-[#76572C]">
        <p className="font-semibold">{previewAssets.length ? '这版还不能采用，下面的图片可用于检查。' : '这版排版暂时无法预览，请根据提示处理后重新生成。'}</p>
        {issues.length > 0 && <ul className="mt-2 space-y-2">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
        <div className="mt-3 flex flex-wrap gap-2">
          {onReviewCopy && <button type="button" disabled={regenerationPending} onClick={onReviewCopy} className="min-h-10 rounded-lg border border-[#CDBE9C] bg-white px-3 font-semibold disabled:opacity-50">返回正文调整</button>}
          {onRegenerate && <button type="button" disabled={regenerationPending} onClick={() => { setFollowLatestRevision(true); onRegenerate(); }} className="min-h-10 rounded-lg bg-[#1C1C1E] px-3 font-semibold text-white disabled:opacity-50">{regenerationPending ? '正在重新排版…' : '重新生成排版'}</button>}
        </div>
        <p className="mt-2 text-xs">重新排版会保留旧版本。内容过少或过长时，请先调整正文再生成。</p>
      </section>}

      {actionError && (
        <div role="alert" data-testid="visual-action-error" className="mt-[10px] flex items-start gap-[7px] rounded-[8px] bg-[#FFF1EE] px-[10px] py-[9px] text-[12px] leading-[1.55] text-[#B83F32]">
          <CircleAlert size={14} className="mt-[2px] shrink-0" />
          <span>{actionError}</span>
        </div>
      )}

      <div className="mt-[14px] grid grid-cols-1 gap-[12px] xl:grid-cols-[minmax(0,1fr)_270px]">
        <div className="order-2 min-w-0 space-y-[14px] xl:order-1">
          {visibleComparison.length > 0 && (
            <section data-testid="visual-version-comparison" className="overflow-hidden rounded-[13px] border border-[rgba(28,28,30,0.09)] bg-[#F8F6F2]">
              <div className="border-b border-[rgba(28,28,30,0.07)] bg-white px-[13px] py-[12px]">
                <div className="flex flex-wrap items-center justify-between gap-[8px]">
                  <div>
                    <h3 className="text-[15px] font-bold text-[#1A1A1A]">重点图片对比</h3>
                    <p className="mt-[4px] text-[13px] leading-[1.6] text-[#69635D]">封面、正文配图和结尾图可以分别比较、修改和选择；选择其中一张不会影响其他已选图片。</p>
                  </div>
                  <span className="rounded-[6px] bg-[#F1EEE9] px-[7px] py-[3px] text-[10px] font-bold text-[#6B6B6B]">
                    {selectedRevisionIsExplicit ? "当前方案已选" : "请先选一个方案"}
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-[9px] p-[11px] 2xl:grid-cols-3">
                {visibleComparison.map((item) => {
                  const candidate = item.right;
                  const candidateKey = candidate ? `${candidate.revisionId}:${candidate.id}` : "";
                  const adopted = Boolean(candidateKey && adoptedAssetKeys.has(candidateKey));
                  const canAdopt = Boolean(candidate && candidate.status === "generated" && candidate.quality === "pass" && !adopted);
                  return (
                    <article key={item.role} data-testid={`visual-comparison-${item.role}`} className="rounded-[10px] border border-[rgba(28,28,30,0.08)] bg-white p-[9px]">
                      <div className="mb-[8px] flex items-center justify-between gap-[8px]">
                        <h4 className="text-[12px] font-bold text-[#1A1A1A]">{COMPARISON_ROLE_LABEL[item.role]}</h4>
                      </div>
                      <div className="grid grid-cols-2 gap-[7px]">
                        <ComparisonAsset asset={item.left} label={item.leftLabel === "previous" ? "上一个方案" : "当前已选"} />
                        <ComparisonAsset asset={item.right} label={item.rightLabel === "candidate" ? "新方案" : "当前方案"} />
                      </div>
                      <div className="mt-[8px] grid grid-cols-2 gap-[6px]">
                        <button
                          type="button"
                          disabled={!candidate}
                          onClick={() => {
                            if (!candidate) return;
                            setRevisionTarget(null);
                            setRevisionAssetTarget(candidate);
                          }}
                          className="inline-flex min-h-[40px] items-center justify-center gap-[6px] rounded-[8px] border border-[rgba(28,28,30,0.11)] bg-white px-[9px] text-[13px] font-bold text-[#5D5852] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-40"
                        >
                          <MessageSquareMore size={12} />
                          修改这张
                        </button>
                        <button
                          type="button"
                          disabled={!onAdoptAsset || !canAdopt || Boolean(adoptingAsset)}
                          onClick={() => candidate && void adoptComparisonAsset(candidate)}
                          className="inline-flex min-h-[40px] items-center justify-center gap-[6px] rounded-[8px] bg-[#1C1C1E] px-[9px] text-[13px] font-bold text-white hover:bg-[#353535] disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
                        >
                          {adoptingAsset === candidateKey ? <LoaderCircle size={12} className="animate-spin" /> : adopted ? <Check size={12} /> : <Replace size={12} />}
                          选择这张
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          )}

          {groups.length ? groups.map((group, groupIndex) => (
            <section key={group.platform} data-testid={`visual-platform-${group.platform}`} className="overflow-hidden rounded-[13px] border border-[rgba(28,28,30,0.09)] bg-[#F8F6F2]">
              <div className="border-b border-[rgba(28,28,30,0.07)] bg-white px-[13px] py-[12px]">
                <div className="flex items-center gap-[8px]">
                  <span className="flex h-[28px] w-[28px] items-center justify-center rounded-[7px] bg-[#EFF7E5] text-[#568C13]">
                    <GalleryHorizontalEnd size={15} />
                  </span>
                  <h3 className="text-[15px] font-bold text-[#1A1A1A]">{platformLabel(group.platform)}</h3>
                  <span className="rounded-[5px] bg-[#F1EEE9] px-[6px] py-[2px] text-[10px] font-bold text-[#8A8178]">{group.suites.length} 套</span>
                </div>
                <p className="mt-[5px] pl-[36px] text-[13px] leading-[1.6] text-[#69635D]">{platformDescription(group.platform)}</p>
              </div>

              <div className={`grid grid-cols-1 gap-[10px] p-[11px] ${group.suites.length > 1 ? "2xl:grid-cols-3" : ""}`}>
                {group.suites.map((suite, suiteIndex) => {
                  const suiteKey = `${previewRevisionId}:${suite.id}`;
                  const blockedCount = suite.assets.filter((asset) => asset.status !== "generated" || asset.quality !== "pass").length;
                  const selectedCount = suite.assets.filter((asset) => adoptedAssetKeys.has(`${asset.revisionId}:${asset.id}`)).length;
                  const complete = selectedCount === suite.assets.length && suite.assets.length > 0;
                  const currentSuite = currentSuiteFor(suite);
                  const hasComparison = Boolean(currentSuite) && !complete;
                  const detailOpen = detailSuiteId === suiteKey;
                  const comparisonOpen = comparisonSuiteId === suiteKey;
                  const htmlAsset = suite.assets.find((asset) => isHtmlLayout(asset.path));
                  const unitLabel = suite.platform === "wechat" ? "项成品" : "张卡片";
                  const actionLabel = blockedCount
                    ? `处理 ${blockedCount} ${unitLabel}`
                    : complete && selectionNeedsReview ? '核对并沿用这套图文'
                    : suite.platform === 'wechat' ? '使用这版排版'
                    : currentSuite && !complete
                      ? "替换这套成品"
                      : "选择这套成品";
                  return (
                    <article key={suite.id} data-testid={`visual-suite-${suite.id}`} className={`flex min-w-0 flex-col rounded-[10px] border bg-white p-[10px] transition-colors ${complete ? "border-[rgba(22,128,60,0.28)]" : "border-[rgba(28,28,30,0.08)]"}`}>
                      <div className="flex min-h-[42px] items-start justify-between gap-[8px]">
                        <div className="min-w-0">
                          <p className="text-[10px] font-bold tracking-[0.08em] text-[#568C13]">{suite.label}</p>
                          <h4 className="mt-[3px] line-clamp-2 text-[13px] font-bold leading-[1.4] text-[#1A1A1A]">{displaySuiteTitle(suite)}</h4>
                        </div>
                        {complete && <span className="flex h-[24px] w-[24px] shrink-0 items-center justify-center rounded-full bg-[#EDF8F0] text-[#16803C]"><Check size={14} /></span>}
                      </div>

                      <div className="mt-[9px]">
                        <SuitePreview suite={suite} eager={groupIndex === 0 && suiteIndex === 0} />
                      </div>
                      {htmlAsset && <WechatLayoutSummary asset={htmlAsset} />}
                      <div className="mt-[8px] flex items-center justify-between gap-[8px] text-[10px] text-[#8A8178]">
                        <span>{suite.platform === "wechat" ? "可查看全文排版" : `${suite.previewAssets.length} 张卡片`}</span>
                        <span className={blockedCount ? "font-bold text-[#A66300]" : "font-bold text-[#16803C]"}>{blockedCount ? `${blockedCount} ${unitLabel}需处理` : "全部可用"}</span>
                      </div>

                      <div className="mt-[9px] grid grid-cols-2 gap-[6px]">
                        <button
                          type="button"
                          onClick={() => setDetailSuiteId(detailOpen ? "" : suiteKey)}
                          aria-expanded={detailOpen}
                          className="inline-flex min-h-[40px] items-center justify-center gap-[6px] rounded-[8px] border border-[rgba(28,28,30,0.11)] bg-white px-[9px] text-[13px] font-bold text-[#5D5852] transition-colors hover:border-[#568C13] hover:text-[#568C13] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#568C13] active:translate-y-px"
                        >
                          <Eye size={12} />
                          {suite.platform === "wechat"
                            ? detailOpen ? "收起排版" : "查看排版"
                            : detailOpen ? "收起图片" : "查看图片"}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            if (suite.platform === 'wechat') {
                              setRestyleSuiteKey(restyleSuiteKey === suiteKey ? '' : suiteKey);
                              return;
                            }
                            setRevisionAssetTarget(null);
                            setRevisionTarget(suite);
                          }}
                          aria-pressed={suite.platform === 'wechat' ? restyleSuiteKey === suiteKey : revisionTarget?.id === suite.id}
                          className={`inline-flex min-h-[40px] items-center justify-center gap-[6px] rounded-[8px] border px-[9px] text-[13px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E85D4C] active:translate-y-px ${revisionTarget?.id === suite.id ? "border-[#E85D4C] bg-[#FFF4F1] text-[#C94A3B]" : "border-[rgba(28,28,30,0.11)] bg-white text-[#5D5852] hover:border-[#E85D4C] hover:text-[#C94A3B]"}`}
                        >
                          <MessageSquareMore size={12} />
                          {suite.platform === 'wechat' ? '换排版样式' : '修改这套'}
                        </button>
                      </div>

                      {restyleSuiteKey === suiteKey && htmlAsset && <WechatRestyle
                        key={suiteKey}
                        asset={htmlAsset}
                        pending={submitting}
                        onGenerate={(theme) => void changeWechatLayout(htmlAsset, theme, suite.id)}
                        onCancel={() => setRestyleSuiteKey('')}
                      />}

                      {hasComparison && (
                        <button
                          type="button"
                          onClick={() => setComparisonSuiteId(comparisonOpen ? "" : suiteKey)}
                          aria-expanded={comparisonOpen}
                          className="mt-[7px] inline-flex min-h-[40px] items-center justify-center gap-[6px] rounded-[8px] bg-[#F3F0EB] px-[9px] text-[13px] font-bold text-[#5D5852] transition-colors hover:text-[#568C13] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#568C13]"
                        >
                          <Replace size={12} />
                          {comparisonOpen ? "收起对比" : "对比成品方案"}
                        </button>
                      )}

                      <button
                        type="button"
                        onClick={() => void adoptSuite(suite)}
                        disabled={!onAdoptAllAssets || Boolean(adoptingSuite) || regenerationPending || blockedCount > 0 || (complete && !selectionNeedsReview)}
                        className={`mt-[8px] inline-flex min-h-[44px] w-full items-center justify-center gap-[7px] rounded-[9px] px-[11px] text-[13px] font-bold transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1C1C1E] active:translate-y-px disabled:cursor-not-allowed ${complete ? "bg-[#EDF8F0] text-[#16803C]" : blockedCount ? "bg-[#FFF8E8] text-[#A66300]" : "bg-[#1C1C1E] text-white hover:bg-[#353535] disabled:opacity-50"}`}
                      >
                        {adoptingSuite === suite.id ? <LoaderCircle size={13} className="animate-spin" /> : complete ? <Check size={13} /> : currentSuite ? <Replace size={13} /> : <GalleryHorizontalEnd size={13} />}
                        {actionLabel}
                      </button>

                      {detailOpen && (
                        <div className="mt-[10px] border-t border-[rgba(28,28,30,0.08)] pt-[10px]">
                          {suite.platform === "wechat" && htmlAsset ? (
                            <div className="overflow-hidden rounded-[9px] border border-[rgba(28,28,30,0.1)] bg-[#F3F0EB]">
                              <div className="flex flex-wrap items-center justify-between gap-[8px] bg-white px-[12px] py-[10px]">
                                <p className="text-[11px] font-bold text-[#1A1A1A]">公众号全文排版</p>
                                <div className="flex flex-wrap items-center gap-[6px]">
                                  <span className="text-[12px] text-[#6B6B6B]">可在下方滚动查看</span>
                                  <a
                                    href={outputHref(htmlAsset.path)}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex min-h-[36px] items-center gap-[5px] rounded-[7px] bg-[#EFF7E5] px-[10px] text-[12px] font-bold text-[#568C13] transition-colors hover:bg-[#E5F2D5] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#568C13]"
                                  >
                                    <ExternalLink size={13} />
                                    打开排版预览
                                  </a>
                                  <WechatLayoutCopyButton asset={htmlAsset} />
                                  {htmlAsset.quality === 'pass' && <OutputDownloadLink
                                    href={outputDownloadHref(htmlAsset.path)}
                                    className="inline-flex min-h-[36px] items-center gap-[5px] rounded-[7px] border border-[rgba(28,28,30,0.12)] bg-white px-[10px] text-[12px] font-bold text-[#4F4B46] transition-colors hover:border-[#568C13] hover:text-[#568C13] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#568C13]"
                                  >
                                    <FileDown size={13} />
                                    下载排版文件
                                  </OutputDownloadLink>}
                                </div>
                              </div>
                              <iframe
                                src={outputHref(htmlAsset.path)}
                                title="公众号全文排版预览"
                                loading="lazy"
                                sandbox="allow-same-origin"
                                className="hidden h-[620px] w-full bg-white sm:block"
                              />
                              <div className="flex min-h-[150px] flex-col items-center justify-center gap-[10px] px-[16px] text-center sm:hidden">
                                <p className="text-[14px] leading-[1.6] text-[#5D5852]">当前窗口较窄，可以打开排版预览查看全文。</p>
                                <a
                                  href={outputHref(htmlAsset.path)}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="inline-flex min-h-[44px] items-center gap-[7px] rounded-[9px] bg-[#1C1C1E] px-[14px] text-[14px] font-bold text-white"
                                >
                                  <ExternalLink size={15} />
                                  打开完整排版
                                </a>
                              </div>
                            </div>
                          ) : (
                            <>
                              <SuitePreview suite={suite} detailed />
                              <div className="mt-[7px] flex flex-wrap gap-[5px]">
                                {suite.previewAssets.map((asset) => (
                                  <span key={asset.id} className={`rounded-[5px] px-[6px] py-[2px] text-[9px] font-bold ${qualityClass(asset.quality)}`}>{assetRoleLabel(asset)} · {qualityLabel(asset.quality)}</span>
                                ))}
                              </div>
                            </>
                          )}
                        </div>
                      )}

                      {comparisonOpen && currentSuite && !complete && (
                        <div className={`mt-[10px] grid grid-cols-1 gap-[8px] border-t border-[rgba(28,28,30,0.08)] pt-[10px] ${suite.platform === 'wechat' ? '' : 'lg:grid-cols-2 2xl:grid-cols-1'}`}>
                          {suite.platform === 'wechat' ? <>
                            <WechatComparison suite={currentSuite} label="已选排版" />
                            <WechatComparison suite={suite} label="待选排版" />
                          </> : <><div>
                            <p className="mb-[5px] text-[10px] font-bold text-[#6B6B6B]">已选方案</p>
                            <SuitePreview suite={currentSuite} />
                          </div>
                          <div>
                            <p className="mb-[5px] text-[10px] font-bold text-[#568C13]">新方案</p>
                            <SuitePreview suite={suite} />
                          </div>
                          </>}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            </section>
          )) : (
            <div className="flex min-h-[180px] items-center justify-center rounded-[10px] border border-dashed border-[rgba(28,28,30,0.14)] bg-[#F8F6F2] text-[13px] text-[#8A8178]">
              还没有可以查看的平台成品
            </div>
          )}
        </div>

        <aside className="order-1 space-y-[12px] xl:order-2 xl:sticky xl:top-[76px] xl:self-start">
          <AdoptedSuiteManifest state={state} adoptedSuites={adoptedSuites} expectedSuiteCount={expectedSuiteCount} />

          {(candidateSuites.some((suite) => suite.platform === 'social') || revisionAssetTarget) && <div className="rounded-[10px] border border-[rgba(28,28,30,0.08)] bg-[#F8F6F2] p-[11px]">
            <div className="flex items-center gap-[7px]">
              <MessageSquareMore size={15} className="text-[#E85D4C]" />
              <h3 className="text-[13px] font-bold text-[#1A1A1A]">修改排版与图文</h3>
            </div>
            {revisionTarget || revisionAssetTarget ? (
              <div className="mt-[8px] rounded-[7px] border border-[rgba(232,93,76,0.18)] bg-[#FFF4F1] px-[8px] py-[7px]">
                <p className="text-[10px] font-bold text-[#C94A3B]">当前修改目标</p>
                <p className="mt-[2px] line-clamp-2 text-[11px] font-bold text-[#1A1A1A]">{revisionAssetTarget ? assetRoleLabel(revisionAssetTarget) : revisionTarget ? displaySuiteTitle(revisionTarget) : ""}</p>
                <p className="mt-[2px] text-[10px] text-[#8A8178]">{revisionAssetTarget ? "只重新生成这一项" : revisionTarget?.platform === "wechat" ? "只重新生成公众号排版" : `这套包含 ${revisionTarget?.previewAssets.length || 0} 张卡片`}</p>
              </div>
            ) : (
              <p className="mt-[8px] rounded-[7px] bg-white px-[9px] py-[9px] text-[13px] leading-[1.6] text-[#69635D]">先在平台成品中点击“修改这套”或“修改这张”。</p>
            )}
            <textarea
              data-testid="visual-revision-input"
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              maxLength={600}
              rows={5}
              disabled={!revisionTarget && !revisionAssetTarget}
              placeholder={revisionAssetTarget ? "说说这一项要怎么改" : revisionTarget ? "说说这套排版或图文要怎么改" : "请先选择一套平台成品"}
              className="mt-[8px] w-full resize-none rounded-[6px] border border-[rgba(28,28,30,0.12)] bg-white px-[9px] py-[8px] text-[13px] leading-[1.55] text-[#1A1A1A] outline-none focus:border-[#E85D4C] disabled:cursor-not-allowed disabled:bg-[#F1EEE9]"
            />
            <button
              type="button"
              onClick={() => void submitRequest()}
              disabled={(!revisionTarget && !revisionAssetTarget) || !request.trim() || submitting}
              className="mt-[8px] inline-flex min-h-[44px] w-full items-center justify-center gap-[7px] rounded-[9px] bg-[#1C1C1E] px-[11px] text-[14px] font-bold text-white transition hover:bg-[#353535] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1C1C1E] active:translate-y-px disabled:cursor-not-allowed disabled:bg-[#AAA39B]"
            >
              {submitting ? <LoaderCircle size={14} className="animate-spin" /> : <Send size={14} />}
              {revisionAssetTarget ? "修改这张" : "修改这套"}
            </button>
          </div>}

          <div className="rounded-[10px] border border-[rgba(28,28,30,0.08)] bg-white p-[11px]">
            <h3 className="text-[13px] font-bold text-[#1A1A1A]">成品版本</h3>
            <p className="mt-[4px] text-[13px] leading-[1.55] text-[#69635D]">切换版本只会更换预览。要换回旧排版，先查看旧版，再点击“使用这版排版”。</p>
            <div className="mt-[8px] space-y-[7px]">
              {state.revisions.map((revision) => (
                <div key={revision.revisionId} className="rounded-[7px] border border-[rgba(28,28,30,0.08)] bg-[#F8F6F2] px-[8px] py-[8px]">
                  <div className="flex items-center justify-between gap-[7px]">
                    <div className="min-w-0">
                      <span className="text-[12px] font-bold text-[#1A1A1A]">版本 {Number(revision.revisionId.slice(1)) || '历史'}</span>
                      {revision.parentRevisionId && <p className="mt-[2px] text-[10px] text-[#9A9A9A]">根据上一个方案修改</p>}
                    </div>
                    <span className={`shrink-0 rounded-[5px] px-[6px] py-[2px] text-[10px] font-bold ${revisionClass(revision.status)}`}>{revisionLabel(revision.status)}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setPreviewRevisionId(revision.revisionId)}
                    aria-label={`查看版本 ${Number(revision.revisionId.slice(1)) || '历史'}`}
                    aria-pressed={previewRevisionId === revision.revisionId}
                    className={`mt-[7px] inline-flex min-h-[40px] w-full items-center justify-center gap-[6px] rounded-[8px] border px-[9px] text-[13px] font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#E85D4C] ${previewRevisionId === revision.revisionId ? "border-[#E85D4C] bg-[#FFF4F1] text-[#C94A3B]" : "border-[rgba(28,28,30,0.12)] bg-white text-[#5D5852] hover:border-[#E85D4C] hover:text-[#C94A3B]"}`}
                  >
                    查看这个方案
                  </button>
                  {revision.reason && <p className="mt-[5px] text-[10px] leading-[1.45] text-[#8A8178]">{displayVisualReason(revision.reason)}</p>}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
