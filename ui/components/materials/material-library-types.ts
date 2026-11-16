import type { MaterialSourceNature } from '@/lib/material-source-nature';

export const MATERIAL_LIBRARY_TABS = [
  { id: 'profile', label: '账号与写作设置' },
  { id: 'scripts', label: '已发布内容' },
  { id: 'materials', label: '原始素材' },
] as const;

export type MaterialLibraryTabId = (typeof MATERIAL_LIBRARY_TABS)[number]['id'];

export const RAW_MATERIAL_CATEGORIES = [
  { id: 'insight', label: '观点与洞察', description: '笔记、访谈判断与灵感片段' },
  { id: 'case', label: '案例与经历', description: '客户、项目、个人经历与复盘' },
  { id: 'fact', label: '事实与数据', description: '数据、截图、报告与可核验信息' },
  { id: 'reference', label: '对标与参考', description: '文章、视频、链接及其拆解' },
  { id: 'brand', label: '品牌与产品资料', description: '产品、服务、用户与商业资料' },
] as const;

export type RawMaterialCategoryId = (typeof RAW_MATERIAL_CATEGORIES)[number]['id'];

export type CreativeProfile = {
  initialized: boolean;
  version?: number;
  updatedAt?: string;
  creatorName: string;
  accountType: string;
  identity: string;
  audience: string;
  pillars: string;
  introduction: string;
  voice: string;
  expressionPreferences?: string;
  visualStyle: string;
  hotTopics: string;
  boundaries: string;
  learningSummary?: string;
};

export type CreativeRules = {
  initialized: boolean;
  version?: number;
  updatedAt?: string;
  fixedRequirements: string;
  styleRules: string;
  prohibitions: string;
  platformNotes: string;
};

export type LibraryProposal = {
  id: string;
  target: 'profile' | 'rules';
  field: string;
  label?: string;
  currentValue: string;
  suggestedValue: string;
  reason: string;
  createdAt?: string;
  backendPatch?: unknown;
  editField?: string;
  editable?: boolean;
};

export type PublishedScript = {
  id: string;
  title: string;
  contentForm: string;
  platform: string;
  publishedAt?: string;
  performanceSummary?: string;
  learningFeature?: string;
  body?: string;
  sourceUrl?: string;
  collected?: boolean;
};

export type RawMaterialSuggestion = {
  category: RawMaterialCategoryId;
  confidence: number;
  reason: string;
  summary: string;
};

export type RawMaterial = {
  id: string;
  sourceNature?: MaterialSourceNature;
  title: string;
  kind: 'text' | 'link' | 'file' | string;
  category: RawMaterialCategoryId;
  status: 'archived' | 'pending_confirmation';
  suggestion: RawMaterialSuggestion;
  sourceLineage?: {
    origin?: string;
    sourceType?: string;
    sourceLabel?: string;
    sourcePath?: string;
    sourceUrl?: string;
    runId?: string;
    platform?: string;
  };
  createdAt?: string;
  updatedAt?: string;
  archiveMethod?: 'auto' | 'manual_confirmation' | 'reclassified';
};

export type MaterialLibraryDashboard = {
  rawMaterials: {
    total: number;
    archived?: number;
    pendingConfirmation: number;
    autoArchived: number;
    categories: Array<{ id: RawMaterialCategoryId; label: string; count: number }>;
  };
  pendingArchiveSuggestions: RawMaterial[];
  recentAutoArchives: RawMaterial[];
};

export function categoryMeta(id: string) {
  return RAW_MATERIAL_CATEGORIES.find((item) => item.id === id);
}

export function formatDate(value?: string): string {
  if (!value) return '未记录时间';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}
