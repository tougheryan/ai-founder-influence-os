'use client';

import {
  ArchiveRestore,
  Check,
  CheckSquare2,
  ChevronRight,
  FileText,
  FileUp,
  FolderArchive,
  Link2,
  LoaderCircle,
  RefreshCw,
  Search,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { TechnicalDetailList, TechnicalDetails } from '@/components/TechnicalDetails';
import { MaterialNatureLabels } from './MaterialNatureLabels';
import { materialNatureLabels } from '@/lib/material-source-nature';
import { MaterialTextEditor } from './MaterialTextEditor';
import { platformDisplayName } from '@/lib/product-copy';
import {
  categoryMeta,
  formatDate,
  RAW_MATERIAL_CATEGORIES,
  type MaterialLibraryDashboard,
  type RawMaterial,
  type RawMaterialCategoryId,
} from './material-library-types';

export type ManualMaterialImport = {
  text: string;
  links: string[];
  files: File[];
};

type Props = {
  dashboard: MaterialLibraryDashboard | null;
  materials: RawMaterial[];
  loading?: boolean;
  processing?: boolean;
  activeCategory: RawMaterialCategoryId | 'all';
  sort: 'recent' | 'priority';
  onCategoryChange: (category: RawMaterialCategoryId | 'all') => void;
  onSortChange: (sort: 'recent' | 'priority') => void;
  onRefresh: () => Promise<void>;
  onImport: (payload: ManualMaterialImport) => Promise<void>;
  onDepositProduction: () => Promise<void>;
  onConfirm: (ids: string[], categoryById?: Record<string, RawMaterialCategoryId>) => Promise<void>;
  onReclassify: (id: string, category: RawMaterialCategoryId) => Promise<void>;
  onUndoAutoArchive: (id: string) => Promise<void>;
  onMigrateLegacy?: () => Promise<void>;
  fileAccept?: string;
};

function MaterialKindIcon({ kind }: { kind: string }) {
  if (kind === 'link') return <Link2 size={16} />;
  if (kind === 'file') return <FileUp size={16} />;
  return <FileText size={16} />;
}

function ConfidenceBadge({ confidence }: { confidence: number }) {
  const percent = Math.round((confidence || 0) * 100);
  const colors = percent >= 90
    ? 'bg-[#EDF8F0] text-[#16803C]'
    : 'bg-[#FFF8E8] text-[#8D5A00]';
  return <span aria-label={`分类匹配度 ${percent}%，不表示真实性`} title="仅表示分类匹配度，不表示真实性" className={`shrink-0 px-1.5 py-0.5 text-xs font-bold ${colors}`}>{percent}%</span>;
}

export function RawMaterialsPanel({
  dashboard,
  materials,
  loading = false,
  processing = false,
  activeCategory,
  sort,
  onCategoryChange,
  onSortChange,
  onRefresh,
  onImport,
  onDepositProduction,
  onConfirm,
  onReclassify,
  onUndoAutoArchive,
  onMigrateLegacy,
  fileAccept,
}: Props) {
  const [search, setSearch] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [categoryById, setCategoryById] = useState<Record<string, RawMaterialCategoryId>>({});
  const [selectedMaterial, setSelectedMaterial] = useState<RawMaterial | null>(null);
  const [recentAutoOpen, setRecentAutoOpen] = useState(false);

  const filteredMaterials = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    if (!keyword) return materials;
    return materials.filter((item) => [
      item.title,
      item.suggestion.summary,
      item.suggestion.reason,
      item.sourceLineage?.sourceLabel,
      compactSource(item),
      item.sourceLineage?.sourcePath,
      item.sourceLineage?.sourceUrl,
      item.sourceLineage?.platform,
      ...materialNatureLabels(item.sourceNature),
    ]
      .join(' ').toLowerCase().includes(keyword));
  }, [materials, search]);

  const pendingItems = materials.filter((item) => item.status === 'pending_confirmation');
  const categoryCounts = new Map((dashboard?.rawMaterials.categories || []).map((item) => [item.id, item.count]));
  const allSelectedPending = pendingItems.length > 0 && pendingItems.every((item) => selectedIds.includes(item.id));

  const toggleSelection = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  };

  const toggleAllPending = () => {
    if (allSelectedPending) {
      setSelectedIds([]);
      setCategoryById({});
      return;
    }
    setSelectedIds(pendingItems.map((item) => item.id));
  };

  const confirmSelected = async () => {
    if (selectedIds.length === 0) return;
    try {
      await onConfirm(selectedIds, categoryById);
      setSelectedIds([]);
      setCategoryById({});
    } catch {
      // Keep the selection so the operator can retry after reading the inline error.
    }
  };

  const selectPendingCategory = (id: string, category: RawMaterialCategoryId) => {
    setCategoryById((current) => ({ ...current, [id]: category }));
    setSelectedIds((current) => current.includes(id) ? current : [...current, id]);
  };

  const reclassifyOne = async (id: string, category: RawMaterialCategoryId) => {
    await onReclassify(id, category);
    setSelectedIds((current) => current.filter((item) => item !== id));
  };

  return (
    <div className="space-y-5">
      <section className="grid items-stretch gap-3 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="border border-[rgba(28,28,30,0.1)] bg-white px-5 py-5 shadow-[0_8px_22px_rgba(28,28,30,0.035)]">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center bg-[rgba(232,93,76,0.1)] text-[#E85D4C]"><FolderArchive size={20} /></span>
              <div>
                <h2 className="text-[18px] font-bold text-[#1A1A1A]">素材整理</h2>
                <p className="mt-1 text-[12px] leading-[1.6] text-[#6B6B6B]">导入的文本、文件、链接和本期内容会自动整理到 5 类素材中。</p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2.5 self-start sm:self-auto">
              {onMigrateLegacy && (
                <button type="button" onClick={() => void onMigrateLegacy().catch(() => undefined)} disabled={processing} className="inline-flex h-10 items-center gap-2 whitespace-nowrap border border-[rgba(28,28,30,0.12)] bg-white px-3.5 text-[13px] font-bold text-[#4F4A45] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50">
                  <ArchiveRestore size={16} />导入历史素材
                </button>
              )}
              <button type="button" onClick={() => void onRefresh()} disabled={loading || processing} title="刷新素材" aria-label="刷新素材" className="inline-flex h-10 w-10 items-center justify-center border border-[rgba(28,28,30,0.12)] bg-white text-[#4F4A45] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50">
                <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>
          <dl className="mt-5 grid grid-cols-3 border-t border-[rgba(28,28,30,0.08)] pt-4">
            <Metric label="素材总数" value={dashboard?.rawMaterials.total || 0} />
            <Metric label="待人工确认" value={dashboard?.rawMaterials.pendingConfirmation || 0} tone="warning" />
            <Metric label="已分类" value={dashboard?.rawMaterials.archived || 0} tone="success" hint={`其中自动分类 ${dashboard?.rawMaterials.autoArchived || 0}`} />
          </dl>
        </div>

        <aside className="border border-[#F2D7A7] bg-[#FFF9EC] px-6 py-5">
          <div className="flex items-start gap-3.5">
            <Sparkles size={20} className="mt-0.5 shrink-0 text-[#A66300]" />
            <div>
              <p className="text-[15px] font-bold text-[#1A1A1A]">自动分类规则</p>
              <p className="mt-1.5 text-[13px] leading-[1.65] text-[#6B6B6B]">系统判断明确的素材会直接分类；不确定的留给你确认，也可以批量处理或修改分类。</p>
            </div>
          </div>
          <button type="button" onClick={() => setRecentAutoOpen((current) => !current)} className="mt-4 inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap border border-[#E9C985] bg-white px-3.5 text-[13px] font-bold text-[#8D5A00] hover:border-[#D99124]">
            <ArchiveRestore size={16} />查看最近自动分类 {dashboard?.recentAutoArchives.length || 0}
          </button>
        </aside>
      </section>

      {recentAutoOpen && (
        <section className="border border-[rgba(28,28,30,0.1)] bg-white shadow-[0_8px_22px_rgba(28,28,30,0.035)]">
          <div className="flex items-center justify-between border-b border-[rgba(28,28,30,0.08)] px-5 py-3.5">
            <p className="text-[13px] font-bold text-[#1A1A1A]">最近自动分类</p>
            <span className="text-[11px] text-[#8A8178]">可查看理由、改类或撤销</span>
          </div>
          <div className="divide-y divide-[rgba(28,28,30,0.07)]">
            {(dashboard?.recentAutoArchives || []).map((item) => (
              <div key={item.id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <button type="button" onClick={() => setSelectedMaterial(item)} className="min-w-0 text-left">
                  <p className="truncate text-[13px] font-bold text-[#1A1A1A]" title={displayMaterialTitle(item)}>{displayMaterialTitle(item)}</p>
                  <p className="mt-1 truncate text-[11px] text-[#6B6B6B]" title={item.suggestion.reason}>{item.suggestion.reason}</p>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <ConfidenceBadge confidence={item.suggestion.confidence} />
                  <button type="button" onClick={() => void onUndoAutoArchive(item.id).catch(() => undefined)} disabled={processing} className="inline-flex h-8 items-center gap-1.5 border border-[rgba(28,28,30,0.12)] bg-white px-2.5 text-[11px] font-bold text-[#6B6B6B] hover:border-[#B43C2E] hover:text-[#B43C2E] disabled:opacity-50"><ArchiveRestore size={13} />撤销</button>
                </div>
              </div>
            ))}
            {(dashboard?.recentAutoArchives.length || 0) === 0 && <p className="px-5 py-6 text-[12px] text-[#6B6B6B]">暂时没有自动分类记录。</p>}
          </div>
        </section>
      )}

      <section className="border border-[rgba(28,28,30,0.1)] bg-white shadow-[0_8px_22px_rgba(28,28,30,0.035)]">
        <div className="space-y-3 border-b border-[rgba(28,28,30,0.08)] px-5 py-4">
          <div className="space-y-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2.5">
              <span className="mr-1 text-[12px] font-bold text-[#8A8178]">素材分类</span>
              <CategoryButton label="全部素材" count={dashboard?.rawMaterials.total || 0} active={activeCategory === 'all'} onClick={() => onCategoryChange('all')} />
              {RAW_MATERIAL_CATEGORIES.map((category) => (
                <CategoryButton key={category.id} label={category.label} count={categoryCounts.get(category.id) || 0} active={activeCategory === category.id} onClick={() => onCategoryChange(category.id)} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2 border-t border-[rgba(28,28,30,0.06)] pt-3">
            <label className="relative min-w-[210px] flex-1 sm:max-w-[320px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#8A8178]" />
              <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索素材" placeholder="搜索标题、来源或性质" className="h-9 w-full border border-[rgba(28,28,30,0.12)] bg-[#FDF8F3] pl-8 pr-3 text-[12px] text-[#1A1A1A] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C]" />
            </label>
            <select value={sort} onChange={(event) => onSortChange(event.target.value as 'recent' | 'priority')} className="h-9 border border-[rgba(28,28,30,0.12)] bg-white px-2.5 text-[12px] font-semibold text-[#4F4A45] outline-none focus:border-[#E85D4C]">
              <option value="recent">最近加入</option>
              <option value="priority">本期优先</option>
            </select>
            <button type="button" onClick={() => setImportOpen(true)} disabled={processing} className="inline-flex h-9 items-center gap-2 bg-[#1C1C1E] px-3 text-[12px] font-bold text-white hover:bg-[#353535] disabled:opacity-50"><Upload size={14} />添加素材</button>
            <button type="button" onClick={() => void onDepositProduction().catch(() => undefined)} disabled={processing} className="inline-flex h-9 items-center gap-2 border border-[rgba(232,93,76,0.32)] bg-[#FFF9F7] px-3 text-[12px] font-bold text-[#C94A3B] hover:bg-[#FFF1EE] disabled:opacity-50"><Sparkles size={14} />保存本期内容到素材库</button>
            </div>
          </div>
        </div>

        {selectedIds.length > 0 && (
          <div className="flex flex-col gap-3 border-b border-[#F2D7A7] bg-[#FFF9EC] px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-[12px] font-bold text-[#8D5A00]">已选择 {selectedIds.length} 条待确认素材</p>
            <button type="button" onClick={() => void confirmSelected()} disabled={processing} className="inline-flex h-8 items-center gap-1.5 bg-[#1C1C1E] px-2.5 text-[11px] font-bold text-white hover:bg-[#353535] disabled:opacity-50">{processing ? <LoaderCircle size={13} className="animate-spin" /> : <CheckSquare2 size={13} />}确认分类</button>
          </div>
        )}

        {loading ? (
          <div className="space-y-2 p-5">{[1, 2, 3, 4, 5].map((item) => <div key={item} className="h-16 animate-pulse bg-[#F5EDE4]" />)}</div>
        ) : filteredMaterials.length > 0 ? (
          <div className="divide-y divide-[rgba(28,28,30,0.07)]">
            {pendingItems.length > 0 && filteredMaterials.some((item) => item.status === 'pending_confirmation') && (
              <div className="flex items-center gap-2 bg-[#FFFDF9] px-5 py-2.5 text-[11px] font-bold text-[#8D5A00]">
                <button type="button" aria-label="全选待确认素材" onClick={toggleAllPending} className={`flex h-5 w-5 items-center justify-center border ${allSelectedPending ? 'border-[#E85D4C] bg-[#E85D4C] text-white' : 'border-[rgba(28,28,30,0.18)] bg-white text-transparent'}`}><Check size={12} strokeWidth={3} /></button>
                待确认分类
              </div>
            )}
            <div className="hidden bg-[#FFFDF9] px-5 py-2 text-[10px] font-bold text-[#8A8178] md:grid md:grid-cols-[24px_36px_minmax(0,1.4fr)_112px_64px_118px_18px] md:items-center md:gap-3">
              <span />
              <span />
              <span>素材</span>
              <span>建议分类</span>
              <span>分类匹配度</span>
              <span>来源</span>
              <span />
            </div>
            {filteredMaterials.map((item) => (
              <RawMaterialRow key={item.id} item={item} selected={selectedIds.includes(item.id)} selectedCategory={categoryById[item.id]} processing={processing} onToggle={() => toggleSelection(item.id)} onOpen={() => setSelectedMaterial(item)} onSelectCategory={selectPendingCategory} />
            ))}
          </div>
        ) : (
          <div className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center">
            <span className="flex h-12 w-12 items-center justify-center bg-[rgba(232,93,76,0.1)] text-[#E85D4C]"><FolderArchive size={22} /></span>
            <h3 className="mt-4 text-[16px] font-bold text-[#1A1A1A]">{search.trim() ? '没有找到匹配的素材' : '这里还没有可用素材'}</h3>
            <p className="mt-2 max-w-[400px] text-[12px] leading-[1.65] text-[#6B6B6B]">{search.trim() ? '换个标题、来源或性质关键词试试。已有素材仍在库中。' : '添加文本、文件和链接，或把本期内容保存到素材库。'}</p>
          </div>
        )}
      </section>

      <MaterialImportDialog open={importOpen} processing={processing} onOpenChange={setImportOpen} onImport={onImport} fileAccept={fileAccept} />
      <RawMaterialDetailDialog onSaved={onRefresh} item={materials.find((item) => item.id === selectedMaterial?.id) || selectedMaterial} processing={processing} onOpenChange={(open) => !open && setSelectedMaterial(null)} onConfirm={onConfirm} onReclassify={reclassifyOne} onUndoAutoArchive={onUndoAutoArchive} />
    </div>
  );
}

function Metric({ label, value, tone = 'default', hint }: { label: string; value: number; tone?: 'default' | 'warning' | 'success'; hint?: string }) {
  const color = tone === 'warning' ? 'text-[#A66300]' : tone === 'success' ? 'text-[#16803C]' : 'text-[#1A1A1A]';
  return <div><dt className="text-[10px] font-bold text-[#8A8178]">{label}</dt><dd className={`mt-1 text-[18px] font-bold tabular-nums ${color}`}>{value}</dd>{hint && <p className="mt-1 text-[10px] text-[#8A8178]">{hint}</p>}</div>;
}

function CategoryButton({ label, count, active, onClick }: { label: string; count: number; active: boolean; onClick: () => void }) {
  return <button type="button" onClick={onClick} className={`inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap border px-3 text-[13px] font-bold transition-colors ${active ? 'border-[#E85D4C] bg-[#FFF8F5] text-[#C94A3B]' : 'border-[rgba(28,28,30,0.11)] bg-white text-[#6B6B6B] hover:border-[#E85D4C]'}`}>{label}<span className="font-mono text-[11px] opacity-70">{count}</span></button>;
}

function compactSource(item: RawMaterial): string {
  const lineage = item.sourceLineage;
  const recordedLabel = lineage?.sourceLabel;
  if (recordedLabel && recordedLabel !== '本期素材分析输入') return recordedLabel;
  if (lineage?.origin === 'production_input' || recordedLabel === '本期素材分析输入') return '写作时保存的素材';
  if (lineage?.sourcePath) {
    return lineage.sourceLabel || legacyPlatformLabel(item) || '本机文件';
  }

  if (lineage?.sourceUrl) {
    try {
      return new URL(lineage.sourceUrl).hostname;
    } catch {
      return lineage.sourceUrl;
    }
  }

  return lineage?.platform ? platformDisplayName(lineage.platform) : lineage?.origin === 'manual_text' ? '手动添加的文字' : '未记录来源';
}

function legacyPlatformLabel(item: RawMaterial): string | null {
  const path = item.sourceLineage?.sourcePath?.replace(/\\/g, '/').toLowerCase() || '';
  if (path.includes('/xhs/')) return '小红书';
  if (path.includes('/wechat/')) return '公众号';
  if (path.includes('/shipinhao/')) return '视频号';
  if (path.includes('/douyin/')) return '抖音';
  return null;
}

function displayMaterialTitle(item: RawMaterial): string {
  if (/^[a-f\d]{8,}$/i.test(item.title)) {
    const platform = legacyPlatformLabel(item) || '历史';
    return `${platform}历史参考`;
  }
  return item.title;
}

function safeSourceUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function displayMaterialSummary(item: RawMaterial): string {
  if (item.suggestion.summary.startsWith('旧素材文件：')) {
    return /^[a-f\d]{8,}$/i.test(item.title)
      ? '历史文件已加入资料库，等待生成内容摘要。'
      : '历史文件已建立索引，可在详情查看来源。';
  }
  return item.suggestion.summary || '等待生成内容摘要。';
}

function RawMaterialRow({ item, selected, selectedCategory, processing, onToggle, onOpen, onSelectCategory }: { item: RawMaterial; selected: boolean; selectedCategory?: RawMaterialCategoryId; processing: boolean; onToggle: () => void; onOpen: () => void; onSelectCategory: (id: string, category: RawMaterialCategoryId) => void }) {
  const pending = item.status === 'pending_confirmation';
  const category = categoryMeta(item.category);
  return (
    <div className="grid gap-3 px-5 py-4 transition-colors hover:bg-[#FFFCF9] md:grid-cols-[24px_36px_minmax(0,1.4fr)_112px_64px_118px_18px] md:items-center md:gap-3">
      <div>{pending && <button type="button" aria-label={`选择 ${displayMaterialTitle(item)}`} onClick={onToggle} className={`flex h-5 w-5 items-center justify-center border ${selected ? 'border-[#E85D4C] bg-[#E85D4C] text-white' : 'border-[rgba(28,28,30,0.18)] bg-white text-transparent'}`}><Check size={12} strokeWidth={3} /></button>}</div>
      <span className="flex h-9 w-9 items-center justify-center bg-[rgba(232,93,76,0.08)] text-[#E85D4C]"><MaterialKindIcon kind={item.kind} /></span>
      <button type="button" onClick={onOpen} className="min-w-0 text-left">
        <span className="flex flex-wrap items-center gap-2"><span className="truncate text-[13px] font-bold text-[#1A1A1A]" title={displayMaterialTitle(item)}>{displayMaterialTitle(item)}</span>{pending && <span className="bg-[#FFF8E8] px-1.5 py-0.5 text-[10px] font-bold text-[#8D5A00]">待确认</span>}</span>
        <span className="mt-1 block line-clamp-2 text-xs leading-5 text-[#625C56]" title={displayMaterialSummary(item)}>{displayMaterialSummary(item)}</span>
        <MaterialNatureLabels nature={item.sourceNature} />
      </button>
      {pending ? (
        <select value={selectedCategory || item.category} onChange={(event) => onSelectCategory(item.id, event.target.value as RawMaterialCategoryId)} disabled={processing} aria-label={`${item.title} 的建议分类`} className="h-8 min-w-0 border border-[rgba(28,28,30,0.12)] bg-white px-2 text-[11px] font-semibold text-[#4F4A45] outline-none focus:border-[#E85D4C] disabled:opacity-50">
          {RAW_MATERIAL_CATEGORIES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
        </select>
      ) : (
        <span className="inline-flex min-w-0 items-center justify-self-start border border-[rgba(28,28,30,0.1)] bg-[#FAF7F3] px-2 py-1 text-[10px] font-bold text-[#625C56]" title="打开详情可修改分类">{category?.label || '未分类'}</span>
      )}
      <ConfidenceBadge confidence={item.suggestion.confidence} />
      <span className="min-w-0 break-words text-xs leading-5 text-[#625C56]" title={compactSource(item)}>{compactSource(item)}<span className="mt-1 block text-xs">{formatDate(item.createdAt)} 保存</span></span>
      <ChevronRight size={16} className="hidden text-[#AAA39B] md:block" />
    </div>
  );
}

function MaterialImportDialog({ open, processing, onOpenChange, onImport, fileAccept }: { open: boolean; processing: boolean; onOpenChange: (open: boolean) => void; onImport: (payload: ManualMaterialImport) => Promise<void>; fileAccept?: string }) {
  const [text, setText] = useState('');
  const [links, setLinks] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const submit = async () => {
    const parsedLinks = links.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
    if (!text.trim() && parsedLinks.length === 0 && files.length === 0) return;
    try {
      await onImport({ text: text.trim(), links: parsedLinks, files });
      setText('');
      setLinks('');
      setFiles([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      onOpenChange(false);
    } catch {
      // Keep the form contents in place after a failed batch for an easy retry.
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88dvh] w-[calc(100%-2rem)] max-w-[760px] sm:max-w-[760px] overflow-y-auto rounded-[18px] border border-[rgba(28,28,30,0.1)] bg-white p-0 text-[#1A1A1A] shadow-[0_24px_60px_rgba(28,28,30,0.16)]">
        <DialogHeader className="border-b border-[rgba(28,28,30,0.08)] px-6 py-5 pr-12">
          <DialogTitle className="text-[20px] font-bold">添加素材</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-[#6B6B6B]">可以同时添加文本、文件和链接，系统会分析内容并给出建议分类。</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 px-6 py-5">
          <label className="block"><span className="mb-2 flex items-center gap-2 text-[12px] font-bold text-[#1A1A1A]"><FileText size={14} className="text-[#E85D4C]" />文本素材</span><textarea value={text} onChange={(event) => setText(event.target.value)} rows={7} placeholder="粘贴笔记、案例、事实、观点或原始材料" className="block w-full resize-y border border-[rgba(28,28,30,0.14)] bg-[#FDF8F3] px-3 py-3 text-[13px] leading-[1.7] text-[#1A1A1A] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C]" /></label>
          <label className="block"><span className="mb-2 flex items-center gap-2 text-[12px] font-bold text-[#1A1A1A]"><Link2 size={14} className="text-[#E85D4C]" />链接</span><textarea value={links} onChange={(event) => setLinks(event.target.value)} rows={3} placeholder="每行一条文章、视频或网页链接" className="block w-full resize-y border border-[rgba(28,28,30,0.14)] bg-[#FDF8F3] px-3 py-3 text-[13px] leading-[1.7] text-[#1A1A1A] outline-none placeholder:text-[#AAA39B] focus:border-[#E85D4C]" /></label>
          <section><div className="flex items-center justify-between gap-3"><div><p className="flex items-center gap-2 text-[12px] font-bold text-[#1A1A1A]"><FileUp size={14} className="text-[#E85D4C]" />文件</p><p className="mt-1 text-[11px] text-[#6B6B6B]">可与文本和链接同时添加，单个文件不超过 25MB。</p></div><input ref={fileInputRef} type="file" multiple accept={fileAccept} className="sr-only" onChange={(event) => setFiles(Array.from(event.target.files || []))} /><button type="button" onClick={() => fileInputRef.current?.click()} className="inline-flex h-8 items-center gap-1.5 border border-[rgba(28,28,30,0.14)] bg-white px-2.5 text-[11px] font-bold text-[#1A1A1A] hover:border-[#E85D4C] hover:text-[#C94A3B]"><FileUp size={13} />选择文件</button></div>{files.length > 0 && <div className="mt-3 divide-y divide-[rgba(28,28,30,0.08)] border-y border-[rgba(28,28,30,0.08)]">{files.map((file) => <div key={`${file.name}-${file.size}`} className="flex items-center justify-between gap-3 py-2 text-[11px]"><span className="truncate text-[#4F4A45]" title={file.name}>{file.name}</span><span className="shrink-0 text-[#8A8178]">{Math.round(file.size / 1024)} KB</span></div>)}</div>}</section>
        </div>
        <DialogFooter className="border-t border-[rgba(28,28,30,0.08)] bg-[#FDF8F3] px-6 py-4 sm:justify-end"><button type="button" onClick={() => onOpenChange(false)} disabled={processing} className="inline-flex h-9 items-center justify-center border border-[rgba(28,28,30,0.12)] bg-white px-3 text-[12px] font-bold text-[#1A1A1A] hover:border-[#E85D4C] hover:text-[#C94A3B] disabled:opacity-50">取消</button><button type="button" onClick={() => void submit()} disabled={processing || (!text.trim() && !links.trim() && files.length === 0)} className="inline-flex h-9 items-center gap-2 bg-[#1C1C1E] px-3 text-[12px] font-bold text-white hover:bg-[#353535] disabled:opacity-50">{processing ? <LoaderCircle size={14} className="animate-spin" /> : <Sparkles size={14} />}添加并分类</button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RawMaterialDetailDialog({ onSaved, item, processing, onOpenChange, onConfirm, onReclassify, onUndoAutoArchive }: { onSaved: () => Promise<void>; item: RawMaterial | null; processing: boolean; onOpenChange: (open: boolean) => void; onConfirm: (ids: string[], categoryById?: Record<string, RawMaterialCategoryId>) => Promise<void>; onReclassify: (id: string, category: RawMaterialCategoryId) => Promise<void>; onUndoAutoArchive: (id: string) => Promise<void> }) {
  return (
    <Dialog open={Boolean(item)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[84dvh] w-[calc(100%-2rem)] max-w-[760px] flex-col gap-0 sm:max-w-[760px] overflow-hidden rounded-[18px] border border-[rgba(28,28,30,0.1)] bg-white p-0 text-[#1A1A1A] shadow-[0_24px_60px_rgba(28,28,30,0.16)]">
        {item && <RawMaterialDetailContent onSaved={onSaved} key={item.id} item={item} processing={processing} onOpenChange={onOpenChange} onConfirm={onConfirm} onReclassify={onReclassify} onUndoAutoArchive={onUndoAutoArchive} />}
      </DialogContent>
    </Dialog>
  );
}

function RawMaterialDetailContent({ onSaved, item, processing, onOpenChange, onConfirm, onReclassify, onUndoAutoArchive }: { onSaved: () => Promise<void>; item: RawMaterial; processing: boolean; onOpenChange: (open: boolean) => void; onConfirm: (ids: string[], categoryById?: Record<string, RawMaterialCategoryId>) => Promise<void>; onReclassify: (id: string, category: RawMaterialCategoryId) => Promise<void>; onUndoAutoArchive: (id: string) => Promise<void> }) {
  const [pendingCategory, setPendingCategory] = useState<RawMaterialCategoryId>(item.category);
  const pending = item.status === 'pending_confirmation';
  const [editingText, setEditingText] = useState(false);

  const confirmPending = async () => {
    try {
      await onConfirm([item.id], { [item.id]: pendingCategory });
      onOpenChange(false);
    } catch {
      // Keep the dialog open so the operator can retry after reading the inline error.
    }
  };

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-[rgba(28,28,30,0.08)] px-6 py-5 pr-12 [@media(max-height:500px)]:py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <DialogTitle className="truncate text-[20px] font-bold" title={displayMaterialTitle(item)}>{displayMaterialTitle(item)}</DialogTitle>
            <DialogDescription className="mt-2 text-[12px] text-[#6B6B6B]">
              {pending ? '待确认分类' : categoryMeta(item.category)?.label} · {formatDate(item.createdAt)}
            </DialogDescription>
          </div>
          <ConfidenceBadge confidence={item.suggestion.confidence} />
        </div>
      </DialogHeader>
      <div className="min-h-0 overflow-y-auto space-y-5 px-6 py-5 [@media(max-height:500px)]:py-3">
        <MaterialTextEditor id={item.id} onSaved={onSaved} onEditingChange={setEditingText} />
        <p className="text-xs leading-5 text-[#6B6B6B]">分类匹配度只表示建议放在哪一类，不代表事实已核实；确认分类也不会改变素材原有的模拟、虚构或待核实性质。</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <DetailBlock label="分类理由" value={item.suggestion.reason || '暂无分类理由'} />
          <DetailBlock label="来源" value={[
            compactSource(item),
            item.sourceLineage?.platform
              ? platformDisplayName(item.sourceLineage.platform, item.sourceLineage.platform)
              : undefined,

          ].filter(Boolean).join('\n') || '未记录来源'} />
        </div>
        {(item.sourceLineage?.sourcePath || item.sourceLineage?.sourceUrl) ? (
          <TechnicalDetails>
            <TechnicalDetailList items={[
              ...(item.sourceLineage.sourcePath ? [{ label: '来源文件', value: item.sourceLineage.sourcePath }] : []),
              ...(safeSourceUrl(item.sourceLineage.sourceUrl) ? [{ label: '来源链接', value: safeSourceUrl(item.sourceLineage.sourceUrl) }] : []),
            ]} />
          </TechnicalDetails>
        ) : null}
      </div>
      <div className="shrink-0 space-y-3 border-t border-[rgba(28,28,30,0.08)] bg-white px-6 py-4 [@media(max-height:500px)]:py-3">
        {editingText && <p className="text-sm text-[#625C56]">先保存或取消文字编辑，再调整分类。</p>}
        {pending ? (
          <div className="flex flex-col gap-3 border border-[#F2D7A7] bg-[#FFF9EC] p-3 sm:flex-row sm:items-end sm:justify-between">
            <label className="block min-w-0 flex-1">
              <span className="mb-2 block text-[12px] font-bold text-[#1A1A1A]">确认分类为</span>
              <select value={pendingCategory} onChange={(event) => setPendingCategory(event.target.value as RawMaterialCategoryId)} disabled={processing || editingText} className="h-9 w-full border border-[rgba(28,28,30,0.12)] bg-white px-2.5 text-[12px] font-semibold text-[#4F4A45] outline-none focus:border-[#E85D4C] disabled:opacity-50">
                {RAW_MATERIAL_CATEGORIES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <button type="button" onClick={() => void confirmPending()} disabled={processing || editingText} className="inline-flex h-9 shrink-0 items-center gap-2 bg-[#1C1C1E] px-3 text-[12px] font-bold text-white hover:bg-[#353535] disabled:opacity-50">{processing ? <LoaderCircle size={14} className="animate-spin" /> : <CheckSquare2 size={14} />}确认分类</button>
          </div>
        ) : (
          <label className="block [@media(max-height:500px)]:flex [@media(max-height:500px)]:items-center [@media(max-height:500px)]:gap-3">
            <span className="mb-2 block shrink-0 text-[12px] font-bold text-[#1A1A1A] [@media(max-height:500px)]:mb-0">所属分类</span>
            <select value={item.category} onChange={(event) => void onReclassify(item.id, event.target.value as RawMaterialCategoryId).catch(() => undefined)} disabled={processing || editingText} className="h-9 min-w-0 w-full border border-[rgba(28,28,30,0.12)] bg-white px-2.5 text-[12px] font-semibold text-[#4F4A45] outline-none focus:border-[#E85D4C] disabled:opacity-50">
              {RAW_MATERIAL_CATEGORIES.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </select>
          </label>
        )}
        {item.archiveMethod === 'auto' && <button type="button" onClick={() => void onUndoAutoArchive(item.id).catch(() => undefined)} disabled={processing || editingText} className="inline-flex h-8 items-center gap-1.5 border border-[rgba(28,28,30,0.12)] bg-white px-2.5 text-[11px] font-bold text-[#6B6B6B] hover:border-[#B43C2E] hover:text-[#B43C2E] disabled:opacity-50"><ArchiveRestore size={13} />撤销自动分类</button>}
      </div>
    </>
  );
}

function DetailBlock({ label, value }: { label: string; value: string }) { return <div className="border border-[rgba(28,28,30,0.1)] bg-[#FDF8F3] px-3 py-3"><p className="text-[10px] font-bold text-[#8A8178]">{label}</p><p className="mt-1.5 whitespace-pre-wrap text-[12px] leading-[1.6] text-[#4F4A45]">{value}</p></div>; }
