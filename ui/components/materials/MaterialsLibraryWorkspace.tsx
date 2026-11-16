'use client';

import { AlertCircle, Archive, BookOpenText, ChevronRight, FolderArchive, RefreshCw, Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { displayClientError, safeFileDisplayName, safeLinkDisplayName } from '@/lib/client-error-copy';
import { PRODUCT_COPY } from '@/lib/product-copy';
import { CreativeProfilePanel } from './CreativeProfilePanel';
import { ProposalReviewDialog } from './ProposalReviewDialog';
import { PublishedScriptsPanel } from './PublishedScriptsPanel';
import { RawMaterialsPanel, type ManualMaterialImport } from './RawMaterialsPanel';
import {
  MATERIAL_LIBRARY_TABS,
  RAW_MATERIAL_CATEGORIES,
  type CreativeProfile,
  type CreativeRules,
  type LibraryProposal,
  type MaterialLibraryDashboard,
  type MaterialLibraryTabId,
  type PublishedScript,
  type RawMaterial,
  type RawMaterialCategoryId,
} from './material-library-types';

type BackendCreativeProfileFields = {
  creatorName?: string;
  accountType?: string;
  identity?: string;
  targetAudience?: string;
  contentPillars?: string[];
  introduction?: string;
  writingStyle?: string;
  expressionPreferences?: string;
  visualPreferences?: string;
  topicBoundaries?: string;
  prohibitions?: string;
};

type BackendCreativeProfile = {
  initialized?: boolean;
  version?: number;
  updatedAt?: string;
  profile?: BackendCreativeProfileFields;
};

type BackendCreativeRule = {
  id?: string;
  title?: string;
  content?: string;
  category?: 'requirement' | 'prohibition' | 'style' | 'workflow';
  enabled?: boolean;
};

type BackendCreativeRules = {
  initialized?: boolean;
  version?: number;
  updatedAt?: string;
  items?: BackendCreativeRule[];
};

type BackendPublishedScript = {
  id?: string;
  title?: string;
  platform?: string;
  form?: string;
  publishedAt?: string;
  publicationUrl?: string;
  excerpt?: string;
  learnable?: boolean;
  performance?: { metrics?: Record<string, number> };
  content?: string;
};

type BackendCreativeProposal = {
  id?: string;
  target?: 'profile' | 'rules';
  reason?: string;
  patch?: unknown;
  createdAt?: string;
};

type CreativeLibraryPayload = {
  profile?: BackendCreativeProfile | null;
  rules?: BackendCreativeRules | null;
  pending?: { profile?: number; rules?: number; total?: number };
  publishedScripts?: { items?: BackendPublishedScript[]; total?: number };
};

type RawDashboardPayload = {
  rawMaterials?: {
    total?: number;
    all?: number;
    archived?: number;
    pendingConfirmation?: number;
    autoArchived?: number;
    categories?: MaterialLibraryDashboard['rawMaterials']['categories'];
  };
  pendingArchiveSuggestions?: Array<RawMaterial & { category?: RawMaterialCategoryId | null }>;
  recentAutoArchives?: Array<{
    item?: RawMaterial & { category?: RawMaterialCategoryId | null };
  }>;
};

type RawListPayload = {
  items?: Array<RawMaterial & { category?: RawMaterialCategoryId | null }>;
};

type Notice = { tone: 'success' | 'error'; message: string } | null;

const FILE_ACCEPT = '.csv,.doc,.docx,.aac,.flac,.heic,.htm,.html,.jpeg,.jpg,.json,.m4a,.md,.mp3,.pdf,.png,.ppt,.pptx,.rtf,.txt,.wav,.webp,.xls,.xlsx';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    cache: 'no-store',
    ...init,
  });
  const data = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(displayClientError(data, '请求没有完成。请稍后重试。'));
  }
  return data as T;
}

function toBody(payload: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function categoryFor(value: unknown): RawMaterialCategoryId {
  const category = typeof value === 'string' ? value : '';
  return RAW_MATERIAL_CATEGORIES.some((item) => item.id === category)
    ? category as RawMaterialCategoryId
    : 'insight';
}

function normalizeRawMaterial(value: RawMaterial & { category?: RawMaterialCategoryId | null }): RawMaterial {
  const suggestion: Record<string, unknown> = isRecord(value.suggestion) ? value.suggestion : {};
  return {
    ...value,
    title: typeof value.title === 'string' ? value.title : '未命名素材',
    kind: typeof value.kind === 'string' ? value.kind : 'text',
    category: categoryFor(value.category ?? suggestion.category),
    status: value.status === 'archived' ? 'archived' : 'pending_confirmation',
    suggestion: {
      category: categoryFor(suggestion.category),
      confidence: typeof suggestion.confidence === 'number' ? suggestion.confidence : 0,
      reason: typeof suggestion.reason === 'string' ? suggestion.reason : '等待分类建议。',
      summary: typeof suggestion.summary === 'string' ? suggestion.summary : '',
    },
  };
}

function normalizeDashboard(payload: RawDashboardPayload): MaterialLibraryDashboard {
  const source = payload.rawMaterials || { total: 0, pendingConfirmation: 0, autoArchived: 0, categories: [] };
  return {
    rawMaterials: {
      total: source.total ?? source.all ?? 0,
      archived: source.archived ?? 0,
      pendingConfirmation: source.pendingConfirmation ?? 0,
      autoArchived: source.autoArchived ?? 0,
      categories: Array.isArray(source.categories) ? source.categories : [],
    },
    pendingArchiveSuggestions: Array.isArray(payload.pendingArchiveSuggestions)
      ? payload.pendingArchiveSuggestions.map(normalizeRawMaterial)
      : [],
    recentAutoArchives: Array.isArray(payload.recentAutoArchives)
      ? payload.recentAutoArchives.flatMap((entry) => entry.item ? [normalizeRawMaterial(entry.item)] : [])
      : [],
  };
}

const PROFILE_FIELD_LABELS: Record<string, string> = {
  creatorName: '创作者名称',
  accountType: '账号类型',
  identity: '身份定位',
  targetAudience: '目标受众',
  contentPillars: '常写主题',
  introduction: '自我介绍',
  writingStyle: '语言风格',
  expressionPreferences: '历史表达偏好',
  visualPreferences: '视觉偏好',
  topicBoundaries: '热点边界',
  prohibitions: '表达禁忌与边界',
};

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeProfile(value?: BackendCreativeProfile | null): CreativeProfile {
  const source = value?.profile || {};
  return {
    initialized: value?.initialized === true,
    version: value?.version,
    updatedAt: value?.updatedAt,
    creatorName: text(source.creatorName),
    accountType: text(source.accountType),
    identity: text(source.identity),
    audience: text(source.targetAudience),
    pillars: Array.isArray(source.contentPillars) ? source.contentPillars.filter((item) => typeof item === 'string').join('、') : '',
    introduction: text(source.introduction),
    voice: text(source.writingStyle),
    expressionPreferences: text(source.expressionPreferences),
    visualStyle: text(source.visualPreferences),
    hotTopics: text(source.topicBoundaries),
    boundaries: text(source.prohibitions),
  };
}

function profileForApi(value: CreativeProfile): BackendCreativeProfileFields {
  return {
    creatorName: value.creatorName,
    accountType: value.accountType,
    identity: value.identity,
    targetAudience: value.audience,
    contentPillars: value.pillars.split(/[、,，\n]/).map((item) => item.trim()).filter(Boolean),
    introduction: value.introduction,
    writingStyle: value.voice,
    expressionPreferences: value.expressionPreferences || '',
    visualPreferences: value.visualStyle,
    topicBoundaries: value.hotTopics,
    prohibitions: value.boundaries,
  };
}

function normalizeRules(value?: BackendCreativeRules | null): CreativeRules {
  const items = Array.isArray(value?.items) ? value?.items || [] : [];
  const group = (category: BackendCreativeRule['category']) => items
    .filter((item) => item.category === category && item.enabled !== false)
    .map((item) => [text(item.title), text(item.content)].filter(Boolean).join('：'))
    .filter(Boolean)
    .join('\n');
  return {
    initialized: value?.initialized === true,
    version: value?.version,
    updatedAt: value?.updatedAt,
    fixedRequirements: group('requirement'),
    styleRules: group('style'),
    prohibitions: group('prohibition'),
    platformNotes: group('workflow'),
  };
}

function rulesForApi(value: CreativeRules): BackendCreativeRule[] {
  const fields: Array<[string, string, NonNullable<BackendCreativeRule['category']>]> = [
    ['每篇固定要求', value.fixedRequirements, 'requirement'],
    ['表达规则', value.styleRules, 'style'],
    ['不要写什么', value.prohibitions, 'prohibition'],
    ['各平台写法', value.platformNotes, 'workflow'],
  ];
  return fields
    .filter(([, content]) => Boolean(content.trim()))
    .map(([title, content, category]) => ({ title, content: content.trim(), category, enabled: true }));
}

function formLabel(value: string): string {
  const labels: Record<string, string> = {
    wechat_article: '公众号文章',
    xiaohongshu_post: '小红书图文',
    moments_post: '朋友圈内容',
    video_script: '视频口播稿',
  };
  return labels[value] || '内容';
}

function performanceSummary(value?: { metrics?: Record<string, number> }): string {
  const metrics = value?.metrics || {};
  const entries = Object.entries(metrics).filter(([, metric]) => typeof metric === 'number');
  return entries.length ? entries.slice(0, 3).map(([key, metric]) => `${key} ${metric}`).join(' · ') : '';
}

function normalizePublishedScript(value: BackendPublishedScript): PublishedScript {
  const body = text(value.content);
  const excerpt = text(value.excerpt);
  return {
    id: text(value.id),
    title: text(value.title) || '未命名发布内容',
    contentForm: formLabel(text(value.form)),
    platform: text(value.platform),
    publishedAt: text(value.publishedAt),
    performanceSummary: performanceSummary(value.performance),
    learningFeature: value.learnable === true
      ? (excerpt || '已确认发布，之后写内容时可以参考。')
      : '发布正文尚未完整同步，暂时不会作为写作参考。',
    ...(body ? { body } : {}),
    ...(text(value.publicationUrl) ? { sourceUrl: text(value.publicationUrl) } : {}),
    collected: true,
  };
}

function profileValueForProposal(profile: CreativeProfile | null, field: string): string {
  if (!profile) return '';
  const map: Record<string, string> = {
    creatorName: profile.creatorName,
    accountType: profile.accountType,
    identity: profile.identity,
    targetAudience: profile.audience,
    contentPillars: profile.pillars,
    introduction: profile.introduction,
    writingStyle: profile.voice,
    expressionPreferences: profile.expressionPreferences || '',
    visualPreferences: profile.visualStyle,
    topicBoundaries: profile.hotTopics,
    prohibitions: profile.boundaries,
  };
  return map[field] || '';
}

function formatPatchValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('、');
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function normalizeProposal(value: BackendCreativeProposal, profile: CreativeProfile | null, rules: CreativeRules | null): LibraryProposal | null {
  const id = text(value.id);
  const target = value.target;
  if (!id || (target !== 'profile' && target !== 'rules')) return null;
  const patch = isRecord(value.patch) ? value.patch : {};
  if (target === 'profile') {
    const entries = Object.entries(patch);
    if (!entries.length) return null;
    const [field, suggested] = entries[0];
    const single = entries.length === 1 && typeof suggested === 'string';
    return {
      id,
      target,
      field,
      label: entries.length === 1 ? (PROFILE_FIELD_LABELS[field] || '账号定位') : '账号定位修改',
      currentValue: entries.map(([key]) => `${PROFILE_FIELD_LABELS[key] || key}：${profileValueForProposal(profile, key) || '尚未填写'}`).join('\n'),
      suggestedValue: entries.map(([key, item]) => `${PROFILE_FIELD_LABELS[key] || key}：${formatPatchValue(item)}`).join('\n'),
      reason: text(value.reason),
      createdAt: text(value.createdAt),
      backendPatch: patch,
      ...(single ? { editField: field } : {}),
      editable: single,
    };
  }

  const upsert = Array.isArray(patch.upsert) ? patch.upsert.filter(isRecord) : [];
  const removeIds = Array.isArray(patch.removeIds) ? patch.removeIds.filter((item): item is string => typeof item === 'string') : [];
  if (upsert.length === 1 && removeIds.length === 0) {
    const rule = upsert[0];
    const title = text(rule.title) || '写作规则';
    const current = rules ? [rules.fixedRequirements, rules.styleRules, rules.prohibitions, rules.platformNotes].filter(Boolean).join('\n') : '';
    return {
      id,
      target,
      field: title,
      label: title,
      currentValue: current || '尚未设置相近规则',
      suggestedValue: text(rule.content),
      reason: text(value.reason),
      createdAt: text(value.createdAt),
      backendPatch: patch,
      editField: 'rule-upsert',
      editable: Boolean(text(rule.content)),
    };
  }
  return {
    id,
    target,
    field: '写作规则修改',
    label: '写作规则修改',
    currentValue: rules ? [rules.fixedRequirements, rules.styleRules, rules.prohibitions, rules.platformNotes].filter(Boolean).join('\n') || '尚未设置规则' : '尚未设置规则',
    suggestedValue: [
      ...upsert.map((rule) => `${text(rule.title) || '规则'}：${text(rule.content)}`),
      ...removeIds.map((ruleId) => `移除规则：${ruleId}`),
    ].join('\n') || '无可显示的规则变化',
    reason: text(value.reason),
    createdAt: text(value.createdAt),
    backendPatch: patch,
    editable: false,
  };
}

function normalizeCreative(payload: CreativeLibraryPayload) {
  const published = payload.publishedScripts?.items || [];
  const total = payload.publishedScripts?.total ?? published.length;
  return {
    profile: normalizeProfile(payload.profile),
    rules: normalizeRules(payload.rules),
    pending: {
      profile: payload.pending?.profile || 0,
      rules: payload.pending?.rules || 0,
      total: payload.pending?.total || ((payload.pending?.profile || 0) + (payload.pending?.rules || 0)),
    },
    scripts: published.map(normalizePublishedScript),
    scriptsTotal: total,
  };
}

function titleFromText(text: string): string {
  const firstLine = text.split(/\r?\n/).map((line) => line.replace(/^#{1,6}\s*/, '').trim()).find(Boolean);
  return firstLine?.slice(0, 44) || '手动粘贴素材';
}

function titleFromUrl(value: string): string {
  try {
    return new URL(value).hostname || '外部参考链接';
  } catch {
    return '外部参考链接';
  }
}

function normalizeReferenceUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http 或 https 链接。');
  }
  if (url.username || url.password) {
    throw new Error('链接不能包含账号或密码。');
  }
  return url.toString();
}

export function MaterialsLibraryWorkspace() {
  const [activeTab, setActiveTab] = useState<MaterialLibraryTabId>('materials');
  const [profile, setProfile] = useState<CreativeProfile | null>(null);
  const [rules, setRules] = useState<CreativeRules | null>(null);
  const [scripts, setScripts] = useState<PublishedScript[]>([]);
  const [scriptsTotal, setScriptsTotal] = useState(0);
  const [pendingProfile, setPendingProfile] = useState(0);
  const [pendingRules, setPendingRules] = useState(0);
  const [dashboard, setDashboard] = useState<MaterialLibraryDashboard | null>(null);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [activeCategory, setActiveCategory] = useState<RawMaterialCategoryId | 'all'>('all');
  const [sort, setSort] = useState<'recent' | 'priority'>('recent');
  const [loadingCreative, setLoadingCreative] = useState(true);
  const [loadingMaterials, setLoadingMaterials] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [proposalTarget, setProposalTarget] = useState<'profile' | 'rules' | null>(null);
  const [proposals, setProposals] = useState<LibraryProposal[]>([]);
  const [proposalLoading, setProposalLoading] = useState(false);

  const pendingArchiveCount = dashboard?.rawMaterials.pendingConfirmation || 0;
  const pendingUpdateCount = pendingProfile + pendingRules;

  const refreshCreative = useCallback(async () => {
    setLoadingCreative(true);
    try {
      const response = await requestJson<CreativeLibraryPayload>('/api/creative-library');
      const next = normalizeCreative(response);
      setProfile(next.profile);
      setRules(next.rules);
      setScripts(next.scripts);
      setScriptsTotal(next.scriptsTotal);
      setPendingProfile(next.pending.profile);
      setPendingRules(next.pending.rules);
    } catch (error) {
      setNotice({ tone: 'error', message: displayClientError(error, '创作资料没有读取成功。请刷新后重试。') });
    } finally {
      setLoadingCreative(false);
    }
  }, []);

  const refreshMaterials = useCallback(async () => {
    setLoadingMaterials(true);
    try {
      const search = new URLSearchParams({ view: 'materials', status: 'all', sort });
      if (activeCategory !== 'all') search.set('category', activeCategory);
      const [dashboardPayload, listPayload] = await Promise.all([
        requestJson<RawDashboardPayload>('/api/material-library?view=dashboard'),
        requestJson<RawListPayload>(`/api/material-library?${search.toString()}`),
      ]);
      setDashboard(normalizeDashboard(dashboardPayload));
      setMaterials((listPayload.items || []).map(normalizeRawMaterial));
    } catch (error) {
      setNotice({ tone: 'error', message: displayClientError(error, '素材没有读取成功。请刷新后重试。') });
    } finally {
      setLoadingMaterials(false);
    }
  }, [activeCategory, sort]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshCreative();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshCreative]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshMaterials();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshMaterials]);

  const withProcessing = async (action: () => Promise<void>) => {
    setProcessing(true);
    setNotice(null);
    try {
      await action();
    } catch (error) {
      const message = displayClientError(error, '这次操作没有完成。请稍后重试。');
      setNotice({ tone: 'error', message });
      throw new Error(message);
    } finally {
      setProcessing(false);
    }
  };

  const saveProfile = async (nextProfile: CreativeProfile) => {
    await withProcessing(async () => {
      const action = profile?.initialized ? 'update' : 'initialize';
      try {
        await requestJson('/api/creative-library/profile', toBody({ action, profile: profileForApi(nextProfile), expectedVersion: nextProfile.version ?? 0 }));
      } catch (error) {
        await refreshCreative();
        throw error;
      }
      setNotice({ tone: 'success', message: '写作设置已更新，之后写内容会参考这份设置。' });
      await refreshCreative();
    });
  };

  const saveRules = async (nextRules: CreativeRules) => {
    await withProcessing(async () => {
      const action = rules?.initialized ? 'update' : 'initialize';
      try {
        await requestJson('/api/creative-library/rules', toBody({ action, items: rulesForApi(nextRules), expectedVersion: nextRules.version ?? 0 }));
      } catch (error) {
        await refreshCreative();
        throw error;
      }
      setNotice({ tone: 'success', message: '账号定位和写作规则已更新。' });
      await refreshCreative();
    });
  };

  const openProposals = async (target: 'profile' | 'rules') => {
    setProposalTarget(target);
    setProposalLoading(true);
    setNotice(null);
    try {
      const response = await requestJson<{ items?: BackendCreativeProposal[] }>(`/api/creative-library/proposals?target=${target}&status=pending`);
      setProposals((response.items || [])
        .map((proposal) => normalizeProposal(proposal, profile, rules))
        .filter((proposal): proposal is LibraryProposal => Boolean(proposal)));
    } catch (error) {
      setProposalTarget(null);
      setNotice({ tone: 'error', message: displayClientError(error, '更新建议没有读取成功。请刷新后重试。') });
    } finally {
      setProposalLoading(false);
    }
  };

  const resolveProposal = async (proposalId: string, action: 'accept' | 'reject' | 'edit', value?: string) => {
    await withProcessing(async () => {
      const proposal = proposals.find((item) => item.id === proposalId);
      let patch: unknown;
      if (action === 'edit') {
        if (!proposal?.backendPatch || !proposal.editField || !value?.trim()) {
          throw new Error('这条建议无法在当前界面直接编辑，请先采用或拒绝。');
        }
        const source = isRecord(proposal.backendPatch) ? proposal.backendPatch : {};
        if (proposal.target === 'profile') {
          patch = { ...source, [proposal.editField]: value.trim() };
        } else if (proposal.editField === 'rule-upsert' && Array.isArray(source.upsert) && isRecord(source.upsert[0])) {
          patch = {
            ...source,
            upsert: [{ ...source.upsert[0], content: value.trim() }, ...source.upsert.slice(1)],
          };
        } else {
          throw new Error('这条建议无法在当前界面直接编辑，请先采用或拒绝。');
        }
      }
      await requestJson('/api/creative-library/proposals', toBody({
        action,
        proposalId,
        ...(action === 'edit' ? { patch } : {}),
      }));
      setProposals((current) => current.filter((item) => item.id !== proposalId));
      setNotice({ tone: 'success', message: action === 'reject' ? '已保留当前内容。' : '更新建议已处理。' });
      await refreshCreative();
    });
  };

  const collectScripts = async () => {
    setCollecting(true);
    setNotice(null);
    try {
      const result = await requestJson<{ created?: number; existing?: number }>('/api/creative-library/published-scripts', toBody({ action: 'collect-all' }));
      setNotice({ tone: 'success', message: `已同步 ${result.created ?? 0} 篇发布内容${result.existing ? `，${result.existing} 篇已在资料库中` : ''}。` });
      await refreshCreative();
    } catch (error) {
      setNotice({ tone: 'error', message: displayClientError(error, '已发布内容没有同步成功。请稍后重试。') });
    } finally {
      setCollecting(false);
    }
  };

  const importMaterials = async (payload: ManualMaterialImport) => {
    await withProcessing(async () => {
      const items: Array<Record<string, unknown>> = [];
      const warnings: string[] = [];

      if (payload.text) {
        items.push({
          title: titleFromText(payload.text),
          kind: 'text',
          content: payload.text,
          origin: 'manual_text',
          sourceLineage: { origin: 'manual_text', sourceLabel: '手动粘贴文本' },
        });
      }

      for (const link of payload.links) {
        try {
          const safeUrl = normalizeReferenceUrl(link);
          items.push({
            title: titleFromUrl(safeUrl),
            kind: 'link',
            sourceUrl: safeUrl,
            origin: 'manual_link',
            sourceLineage: { origin: 'manual_link', sourceUrl: safeUrl, sourceLabel: '手动添加链接' },
          });
        } catch (error) {
          const source = safeLinkDisplayName(link);
          const reason = displayClientError(error, '链接没有导入成功。请检查格式后重试。');
          warnings.push(`${source}：${reason}`);
        }
      }

      for (const file of payload.files) {
        try {
          const formData = new FormData();
          formData.append('path', 'materials/library/imports');
          formData.append('file', file);
          const uploaded = await requestJson<{ path?: string }>('/api/materials?action=upload', { method: 'POST', body: formData });
          if (!uploaded.path) throw new Error('文件上传后未返回路径。');

          let extractedContent = '';
          const displayFileName = safeFileDisplayName(file.name);
          let sourceLabel = displayFileName;
          try {
            const extracted = await requestJson<{ content?: string; extractionStatus?: string }>('/api/materials?action=extract', toBody({ path: uploaded.path }));
            extractedContent = typeof extracted.content === 'string' ? extracted.content : '';
            if (extracted.extractionStatus === 'needs_transcription') {
              sourceLabel = `${displayFileName}（待补充转写）`;
              warnings.push(`${displayFileName} 需要补充 OCR 或逐字稿，已保留原始文件。`);
            }
          } catch {
            warnings.push(`${displayFileName} 已保存，但暂未提取正文。`);
          }

          items.push({
            title: file.name.replace(/\.[A-Za-z0-9]+$/, '') || file.name,
            kind: 'file',
            ...(extractedContent ? { content: extractedContent } : {}),
            sourcePath: uploaded.path,
            origin: 'manual_file',
            sourceLineage: { origin: 'manual_file', sourcePath: uploaded.path, sourceLabel },
          });
        } catch (error) {
          const source = safeFileDisplayName(file.name);
          const reason = displayClientError(error, '这份文件没有导入成功。请换一个文件重试。');
          warnings.push(`${source}：${reason}`);
        }
      }

      if (items.length === 0) {
        throw new Error(warnings[0] || '没有可分类的素材。');
      }

      const result = await requestJson<{ created?: number; autoArchived?: number }>('/api/material-library', toBody({ action: 'ingest', items }));
      const detail = warnings.length
        ? ` ${warnings[0]}${warnings.length > 1 ? `另有 ${warnings.length - 1} 条素材需要处理。` : ''}`
        : '';
      setNotice({
        tone: 'success',
        message: `已导入 ${result.created ?? items.length} 条素材，其中 ${result.autoArchived ?? 0} 条已自动分类。${detail}`,
      });
      await refreshMaterials();
    });
  };

  const depositProduction = async () => {
    await withProcessing(async () => {
      const status = await requestJson<{ activeRun?: { run_id?: string }; latest?: { active_run_id?: string } }>('/api/status');
      const runId = status.activeRun?.run_id || status.latest?.active_run_id;
      if (!runId) throw new Error('当前还没有本期内容。请先添加素材并开始制作。');
      const result = await requestJson<{ created?: number; existing?: number }>('/api/material-library', toBody({ action: 'ingest-production', runId }));
      setNotice({ tone: 'success', message: `已从本期内容保存 ${result.created ?? 0} 条素材${result.existing ? `，${result.existing} 条已存在` : ''}。` });
      await refreshMaterials();
    });
  };

  const confirmArchive = async (ids: string[], categoryById?: Record<string, RawMaterialCategoryId>) => {
    await withProcessing(async () => {
      await requestJson('/api/material-library', toBody({ action: 'confirm', ids, categoryById }));
      setNotice({ tone: 'success', message: `已确认 ${ids.length} 条素材的分类。` });
      await refreshMaterials();
    });
  };

  const reclassify = async (id: string, category: RawMaterialCategoryId) => {
    await withProcessing(async () => {
      await requestJson('/api/material-library', toBody({ action: 'reclassify', id, category }));
      setNotice({ tone: 'success', message: '素材分类已更新。' });
      await refreshMaterials();
    });
  };

  const undoAutoArchive = async (id: string) => {
    await withProcessing(async () => {
      await requestJson('/api/material-library', toBody({ action: 'undo-auto-archive', id }));
      setNotice({ tone: 'success', message: '已撤销自动分类，素材已回到待确认列表。' });
      await refreshMaterials();
    });
  };

  const migrateLegacy = async () => {
    await withProcessing(async () => {
      const result = await requestJson<{ created?: number; existing?: number }>('/api/material-library', toBody({ action: 'migrate-legacy' }));
      setNotice({ tone: 'success', message: `已扫描历史文件：新增 ${result.created ?? 0} 条，已有 ${result.existing ?? 0} 条保留原记录。` });
      await refreshMaterials();
    });
  };

  const loadScript = async (id: string): Promise<PublishedScript> => {
    const result = await requestJson<{ item?: BackendPublishedScript }>(`/api/creative-library/published-scripts?id=${encodeURIComponent(id)}`);
    if (!result.item) throw new Error('已发布内容不存在。');
    return normalizePublishedScript(result.item);
  };

  let tabContent: React.ReactNode;
  if (activeTab === 'profile') {
    tabContent = (
      <CreativeProfilePanel
        profile={profile}
        rules={rules}
        pendingProfileCount={pendingProfile}
        pendingRulesCount={pendingRules}
        onSaveProfile={saveProfile}
        onSaveRules={saveRules}
        onOpenProposals={(target) => void openProposals(target)}
      />
    );
  } else if (activeTab === 'scripts') {
    tabContent = <PublishedScriptsPanel scripts={scripts} total={scriptsTotal} loading={loadingCreative} collecting={collecting} onCollect={collectScripts} onLoadScript={loadScript} />;
  } else {
    tabContent = (
      <RawMaterialsPanel
        dashboard={dashboard}
        materials={materials}
        loading={loadingMaterials}
        processing={processing}
        activeCategory={activeCategory}
        sort={sort}
        onCategoryChange={setActiveCategory}
        onSortChange={setSort}
        onRefresh={refreshMaterials}
        onImport={importMaterials}
        onDepositProduction={depositProduction}
        onConfirm={confirmArchive}
        onReclassify={reclassify}
        onUndoAutoArchive={undoAutoArchive}
        onMigrateLegacy={migrateLegacy}
        fileAccept={FILE_ACCEPT}
      />
    );
  }

  return (
    <div className="aifios-editorial-page mx-auto w-full max-w-[1480px] space-y-5 pb-6">
      <section className="flex flex-col gap-4 border-b border-[rgba(28,28,30,0.12)] pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center bg-[rgba(232,93,76,0.1)] text-[#E85D4C]">
            <FolderArchive size={20} strokeWidth={2.2} />
          </span>
          <div>
            <h1 className="text-[24px] font-bold leading-tight text-[#1A1A1A]">{PRODUCT_COPY.pages.materials.title}</h1>
            <p className="mt-1.5 text-[13px] leading-[1.65] text-[#6B6B6B]">集中管理账号定位、已发布内容和原始素材，写作时会自动参考。</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('materials')}
            className="inline-flex h-9 items-center gap-2 border border-[#F2D7A7] bg-[#FFF8E8] px-3 text-[12px] font-bold text-[#8D5A00] transition-colors hover:border-[#D99124]"
          >
            <Archive size={14} />
            待确认分类 {pendingArchiveCount}
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab('profile');
              if (pendingUpdateCount > 0) {
                void openProposals(pendingProfile > 0 ? 'profile' : 'rules');
              }
            }}
            className="inline-flex h-9 items-center gap-2 border border-[rgba(232,93,76,0.28)] bg-[#FFF9F7] px-3 text-[12px] font-bold text-[#C94A3B] transition-colors hover:border-[#E85D4C]"
          >
            <Sparkles size={14} />
            待确认建议 {pendingUpdateCount}
          </button>
          <button
            type="button"
            onClick={() => {
              void Promise.all([refreshCreative(), refreshMaterials()]);
            }}
            title={`刷新${PRODUCT_COPY.pages.materials.title}`}
            aria-label={`刷新${PRODUCT_COPY.pages.materials.title}`}
            className="inline-flex h-9 w-9 items-center justify-center border border-[rgba(28,28,30,0.12)] bg-white text-[#6B6B6B] transition-colors hover:border-[#E85D4C] hover:text-[#C94A3B]"
          >
            <RefreshCw size={15} className={loadingCreative || loadingMaterials ? 'animate-spin' : ''} />
          </button>
        </div>
      </section>

      {notice && (
        <div className={`flex items-start gap-2 border-l-[3px] px-4 py-3 text-[12px] leading-[1.65] ${notice.tone === 'error' ? 'border-[#B43C2E] bg-[#FFF5F3] text-[#9F2D22]' : 'border-[#16803C] bg-[#F2FBF4] text-[#176A35]'}`}>
          {notice.tone === 'error' ? <AlertCircle size={15} className="mt-0.5 shrink-0" /> : <Sparkles size={15} className="mt-0.5 shrink-0" />}
          <p>{notice.message}</p>
        </div>
      )}

      <nav aria-label={`${PRODUCT_COPY.pages.materials.title}分区`} className="grid grid-cols-3 border-b border-[rgba(28,28,30,0.1)] sm:flex">
        {MATERIAL_LIBRARY_TABS.map((tab) => {
          const active = activeTab === tab.id;
          const count = tab.id === 'materials'
            ? pendingArchiveCount
            : tab.id === 'profile'
              ? pendingUpdateCount
              : 0;
          const Icon = tab.id === 'profile' ? BookOpenText : tab.id === 'materials' ? FolderArchive : ChevronRight;
          return (
            <button
              key={tab.id}
              id={`materials-view-${tab.id}`}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              aria-pressed={active}
              aria-controls="materials-view-panel"
              className={`relative inline-flex min-h-12 min-w-0 items-center justify-center gap-1.5 px-2 py-2 text-center text-[13px] font-bold leading-[1.35] transition-colors sm:h-11 sm:min-h-0 sm:shrink-0 sm:justify-start sm:gap-2 sm:px-4 sm:py-0 sm:text-left ${active ? 'text-[#C94A3B]' : 'text-[#6B6B6B] hover:text-[#1A1A1A]'}`}
            >
              <Icon size={15} strokeWidth={active ? 2.3 : 2} />
              <span className="min-w-0">{tab.label}</span>
              {count > 0 && <span className={`min-w-5 px-1.5 py-0.5 text-[10px] ${active ? 'bg-[#E85D4C] text-white' : 'bg-[#FFF1D6] text-[#8D5A00]'}`}>{count}</span>}
              {active && <span className="absolute bottom-0 left-4 right-4 h-0.5 bg-[#E85D4C]" />}
            </button>
          );
        })}
      </nav>

      <div id="materials-view-panel" role="region" aria-labelledby={`materials-view-${activeTab}`}>
        {tabContent}
      </div>

      <ProposalReviewDialog
        open={Boolean(proposalTarget)}
        targetLabel={proposalTarget === 'rules' ? '写作规则' : '账号定位'}
        proposals={proposals}
        busy={processing || proposalLoading}
        onOpenChange={(open) => !open && setProposalTarget(null)}
        onResolve={resolveProposal}
      />
    </div>
  );
}
