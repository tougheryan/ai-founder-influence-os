'use client';

import {
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Eye,
  EyeOff,
  ImageIcon,
  KeyRound,
  Loader2,
  Save,
  ShieldCheck,
  Trash2,
  WalletCards,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  defaultImageAccountPolicy,
  IMAGE_ACCOUNT_PRESETS,
  IMAGE_PROVIDER_ACCOUNTS,
  normalizeImageAccountPolicy,
  type ImageAccountPolicy,
  type ImageAccountPreset,
  type ImageCredentialId,
} from '@/lib/image-account-policy';

type ImageBenchmark = {
  benchmarkId: string;
  status: string;
  updatedAt: string;
  primary: string | null;
  backup: string | null;
  eligible: boolean;
  routes: Array<{ routeId: string; provider: string; modelId: string; score: number | null; rank: number | null }>;
};

type ImageProviderRuntimeStatus = {
  accountCount: number;
  activeAccountCount: number;
  activeProviders: ImageCredentialId[];
  runtimeImageReady: boolean;
  runtimeBackupReady: boolean;
  runtimeRouteReady: boolean;
  runtimeRouteSource?: 'internal_benchmark' | 'bundled_catalog' | null;
  internalBenchmarkReady: boolean;
  aiDefaultEligible: boolean;
  firstPaidCallConfirmed: boolean;
  releaseDefault: 'ai_enhanced' | 'stable';
};

type ImageProviderPayload = {
  policy?: ImageAccountPolicy;
  status?: ImageProviderRuntimeStatus;
  benchmark?: ImageBenchmark | null;
  error?: string;
};

const PROVIDERS = IMAGE_PROVIDER_ACCOUNTS.map((provider) => ({
  ...provider,
  placeholder: provider.id === 'image_replicate'
    ? 'Replicate API Token'
    : `${provider.name} API Key`,
}));

type Provider = typeof PROVIDERS[number];
type RoleKey = 'primary_provider' | 'backup_provider' | 'advanced_provider';

const ROLE_COPY: Record<RoleKey, { eyebrow: string; title: string; detail: string }> = {
  primary_provider: { eyebrow: '01', title: '主账户', detail: '承担日常生图；一个账户即可启用 AI 基础模式。' },
  backup_provider: { eyebrow: '02', title: '备用账户', detail: '建议选择不同服务商；主服务明确失败时才自动切换。' },
  advanced_provider: { eyebrow: '03', title: '高级账户（可选）', detail: '仅用于特殊模型或风格，不参与普通主备切换。' },
};

function presetPolicy(policy: ImageAccountPolicy, preset: Exclude<ImageAccountPreset, 'custom'>): ImageAccountPolicy {
  const definition = IMAGE_ACCOUNT_PRESETS.find((item) => item.id === preset)!;
  return {
    ...policy,
    preset,
    primary_provider: definition.order[0],
    backup_provider: definition.order[1],
    advanced_provider: null,
    first_paid_call_confirmed: false,
  };
}

function materializeSuggestedRoles(policy: ImageAccountPolicy): ImageAccountPolicy {
  if (policy.primary_provider || policy.backup_provider || policy.advanced_provider || policy.preset === 'custom') return policy;
  return presetPolicy(policy, policy.preset);
}

export function ImageProviderSettings() {
  const [statuses, setStatuses] = useState<AifiosCredentialStatus[]>([]);
  const [values, setValues] = useState<Partial<Record<ImageCredentialId, string>>>({});
  const [visible, setVisible] = useState<Partial<Record<ImageCredentialId, boolean>>>({});
  const [dashscopeWorkspaceId, setDashscopeWorkspaceId] = useState('');
  const [dashscopeRegion, setDashscopeRegion] = useState<'cn-beijing' | 'ap-southeast-1'>('cn-beijing');
  const [busy, setBusy] = useState<ImageCredentialId | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policy, setPolicy] = useState<ImageAccountPolicy>(() => materializeSuggestedRoles(defaultImageAccountPolicy()));
  const [runtimeStatus, setRuntimeStatus] = useState<ImageProviderRuntimeStatus | null>(null);
  const [benchmark, setBenchmark] = useState<ImageBenchmark | null>(null);
  const bridge = typeof window !== 'undefined' ? window.aifiosCredentials : undefined;

  const statusById = useMemo(
    () => Object.fromEntries(statuses.map((item) => [item.id, item])) as Partial<Record<ImageCredentialId, AifiosCredentialStatus>>,
    [statuses],
  );
  const configuredCount = PROVIDERS.filter((provider) => statusById[provider.id]?.configured).length;

  const applyPayload = useCallback((payload: ImageProviderPayload) => {
    if (payload.policy) setPolicy(materializeSuggestedRoles(normalizeImageAccountPolicy(payload.policy)));
    if (payload.status) setRuntimeStatus(payload.status);
    setBenchmark(payload.benchmark || null);
  }, []);

  const refreshServerStatus = useCallback(async () => {
    const response = await fetch('/api/settings/image-providers', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({})) as ImageProviderPayload;
    if (!response.ok) throw new Error(payload.error || '读取生图账户状态失败');
    applyPayload(payload);
    return payload;
  }, [applyPayload]);

  useEffect(() => {
    let active = true;
    if (bridge) {
      bridge.status()
        .then((next) => {
          if (active) setStatuses(next.filter((item) => String(item.id).startsWith('image_')));
        })
        .catch(() => toast.error('暂时无法读取生图服务密钥状态。'));
    }
    const statusTimer = window.setTimeout(() => {
      void refreshServerStatus().catch(() => undefined);
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(statusTimer);
    };
  }, [bridge, refreshServerStatus]);

  const persistPolicy = useCallback(async (next: ImageAccountPolicy, quiet = false) => {
    setPolicyBusy(true);
    try {
      const response = await fetch('/api/settings/image-providers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ policy: next }),
      });
      const payload = await response.json().catch(() => ({})) as ImageProviderPayload;
      if (!response.ok) throw new Error(payload.error || '保存生图账户策略失败');
      applyPayload(payload);
      if (!quiet) toast.success('生图账户与预算策略已保存。');
      return payload;
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '生图账户策略没有保存成功。');
      throw error;
    } finally {
      setPolicyBusy(false);
    }
  }, [applyPayload]);

  const saveCredential = async (id: ImageCredentialId) => {
    const apiKey = String(values[id] || '').trim();
    if (!bridge) return toast.error('请在 Echo Founder 桌面 App 中配置生图服务。');
    if (!apiKey) return toast.error('请先填写 API Key。');
    setBusy(id);
    try {
      if (id === 'image_dashscope' && !/^[A-Za-z0-9_-]{3,128}$/.test(dashscopeWorkspaceId.trim())) {
        return toast.error('请填写百炼业务空间 Workspace ID。');
      }
      const result = await bridge.save(id, JSON.stringify({
        apiKey,
        ...(id === 'image_dashscope' ? { workspaceId: dashscopeWorkspaceId.trim(), region: dashscopeRegion } : {}),
      }));
      setStatuses((current) => [...current.filter((item) => item.id !== id), result]);
      setValues((current) => ({ ...current, [id]: '' }));
      await persistPolicy(policy, true);
      toast.success('账户已保存到 macOS 钥匙串。');
    } catch {
      toast.error('账户没有保存成功，请检查格式后重试。');
    } finally {
      setBusy(null);
    }
  };

  const removeCredential = async (id: ImageCredentialId) => {
    if (!bridge) return;
    setBusy(id);
    try {
      const result = await bridge.delete(id);
      setStatuses((current) => [...current.filter((item) => item.id !== id), result]);
      setValues((current) => ({ ...current, [id]: '' }));
      const next = normalizeImageAccountPolicy({
        ...policy,
        primary_provider: policy.primary_provider === id ? null : policy.primary_provider,
        backup_provider: policy.backup_provider === id ? null : policy.backup_provider,
        advanced_provider: policy.advanced_provider === id ? null : policy.advanced_provider,
        first_paid_call_confirmed: false,
      });
      await persistPolicy(next, true);
      toast.success('生图账户已移除。');
    } catch {
      toast.error('账户没有移除成功，请重试。');
    } finally {
      setBusy(null);
    }
  };

  const changeRole = async (role: RoleKey, id: ImageCredentialId | null) => {
    const next = normalizeImageAccountPolicy({
      ...policy,
      preset: 'custom',
      primary_provider: id && role !== 'primary_provider' && policy.primary_provider === id ? null : policy.primary_provider,
      backup_provider: id && role !== 'backup_provider' && policy.backup_provider === id ? null : policy.backup_provider,
      advanced_provider: id && role !== 'advanced_provider' && policy.advanced_provider === id ? null : policy.advanced_provider,
      [role]: id,
      first_paid_call_confirmed: false,
    });
    setPolicy(next);
    await persistPolicy(next, true).catch(() => undefined);
  };

  const choosePreset = async (preset: Exclude<ImageAccountPreset, 'custom'>) => {
    const next = presetPolicy(policy, preset);
    setPolicy(next);
    await persistPolicy(next, true).catch(() => undefined);
  };

  const updateBudget = (key: keyof ImageAccountPolicy['budgets_cny'], value: string) => {
    const amount = Number(value);
    setPolicy((current) => ({
      ...current,
      first_paid_call_confirmed: false,
      budgets_cny: { ...current.budgets_cny, [key]: Number.isFinite(amount) ? amount : 0 },
    }));
  };

  const accountBadge = configuredCount >= 2
    ? { label: `${configuredCount} 个账户 · 主备可用`, className: 'bg-[#EEF6E6] text-[#52790C]' }
    : configuredCount === 1
      ? { label: '1 个账户 · AI 基础模式', className: 'bg-[#EDF4FF] text-[#2F64A3]' }
      : { label: '0 个账户 · 稳定排版可用', className: 'bg-[#F2F0ED] text-[#6B625A]' };

  const providerForm = (provider: Provider, compact = false) => {
    const configured = Boolean(statusById[provider.id]?.configured);
    const isBusy = busy === provider.id;
    return (
      <div className={compact ? 'mt-3' : 'mt-4'}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] leading-5 text-[#6B6B6B]">
            {configured
              ? `已连接 · ${statusById[provider.id]?.updatedAt ? new Date(statusById[provider.id]!.updatedAt!).toLocaleString('zh-CN') : '更新时间未记录'}`
              : `${provider.routeSummary} · 尚未配置`}
          </p>
          {configured ? (
            <button type="button" disabled={isBusy} onClick={() => removeCredential(provider.id)} className="inline-flex h-7 shrink-0 items-center gap-1 px-1 text-[10px] font-bold text-[#B43C2E] disabled:opacity-50">
              <Trash2 size={12} />移除
            </button>
          ) : null}
        </div>
        <div className="mt-2 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <input
              type={visible[provider.id] ? 'text' : 'password'}
              value={values[provider.id] || ''}
              onChange={(event) => setValues((current) => ({ ...current, [provider.id]: event.target.value }))}
              placeholder={configured ? '输入新密钥以替换' : provider.placeholder}
              disabled={!bridge || isBusy}
              className="h-10 w-full rounded-[11px] border border-[rgba(28,28,30,0.12)] bg-white px-3 pr-10 text-[12px] outline-none focus:border-[#52790C] disabled:opacity-60"
            />
            <button type="button" aria-label={visible[provider.id] ? '隐藏密钥' : '显示密钥'} onClick={() => setVisible((current) => ({ ...current, [provider.id]: !current[provider.id] }))} className="absolute right-1 top-1 inline-flex h-8 w-8 items-center justify-center text-[#6B6B6B]">
              {visible[provider.id] ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button type="button" disabled={!bridge || isBusy || !String(values[provider.id] || '').trim()} onClick={() => saveCredential(provider.id)} className="inline-flex h-10 items-center gap-1.5 rounded-[11px] bg-[#1A1A1A] px-3 text-[12px] font-bold text-white disabled:opacity-40">
            {isBusy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}保存
          </button>
        </div>
        {'workspaceRequired' in provider && provider.workspaceRequired ? (
          <div className="mt-2 grid grid-cols-[minmax(0,1fr)_132px] gap-2">
            <input value={dashscopeWorkspaceId} onChange={(event) => setDashscopeWorkspaceId(event.target.value)} placeholder="Workspace ID" disabled={!bridge || isBusy} className="h-9 rounded-[10px] border border-[rgba(28,28,30,0.12)] bg-white px-3 text-[11px] outline-none focus:border-[#52790C] disabled:opacity-60" />
            <select value={dashscopeRegion} onChange={(event) => setDashscopeRegion(event.target.value as 'cn-beijing' | 'ap-southeast-1')} disabled={!bridge || isBusy} className="h-9 rounded-[10px] border border-[rgba(28,28,30,0.12)] bg-white px-2 text-[11px] outline-none focus:border-[#52790C] disabled:opacity-60">
              <option value="cn-beijing">北京</option>
              <option value="ap-southeast-1">新加坡</option>
            </select>
          </div>
        ) : null}
      </div>
    );
  };

  const roleCard = (role: RoleKey) => {
    const selectedId = policy[role] || (role === 'advanced_provider'
      ? null
      : IMAGE_ACCOUNT_PRESETS[0].order[role === 'primary_provider' ? 0 : 1]);
    const provider = PROVIDERS.find((item) => item.id === selectedId);
    const copy = ROLE_COPY[role];
    const configured = Boolean(provider && statusById[provider.id]?.configured);
    return (
      <div className="rounded-[15px] border border-[rgba(28,28,30,0.08)] bg-[#FDF8F3] p-4">
        <div className="flex items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-white font-mono text-[11px] font-bold text-[#7A716A]">{copy.eyebrow}</span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[13px] font-bold text-[#1A1A1A]">{copy.title}</p>
              <span className={`rounded-full px-2 py-0.5 text-[9px] font-bold ${configured ? 'bg-[#E7F3DC] text-[#52790C]' : 'bg-[#EFECE8] text-[#756B62]'}`}>{configured ? '已连接' : '待配置'}</span>
            </div>
            <p className="mt-1 text-[11px] leading-5 text-[#6B6B6B]">{copy.detail}</p>
          </div>
        </div>
        <label className="mt-3 block text-[10px] font-bold text-[#7A716A]">服务商</label>
        <select value={provider?.id || ''} onChange={(event) => changeRole(role, event.target.value ? event.target.value as ImageCredentialId : null)} disabled={!bridge || policyBusy} className="mt-1 h-10 w-full rounded-[11px] border border-[rgba(28,28,30,0.12)] bg-white px-3 text-[12px] font-bold text-[#1A1A1A] outline-none focus:border-[#52790C] disabled:opacity-60">
          {role === 'advanced_provider' ? <option value="">暂不启用第三账户</option> : null}
          {PROVIDERS.map((option) => <option key={option.id} value={option.id}>{option.name} · {option.routeSummary}</option>)}
        </select>
        {provider ? providerForm(provider) : null}
      </div>
    );
  };

  return (
    <section id="image-providers" className="aifios-settings-section rounded-[18px] border border-[rgba(28,28,30,0.08)] bg-white p-[16px] shadow-[0_8px_24px_rgba(28,28,30,0.035)]">
      <div className="flex flex-col gap-3 border-b border-[rgba(28,28,30,0.08)] pb-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-[#F2F7ED] text-[#52790C]"><ImageIcon size={18} /></span>
          <div>
            <h2 className="text-[16px] font-bold text-[#1A1A1A]">AI 生图账户</h2>
            <p className="mt-1 max-w-2xl text-[12px] leading-5 text-[#6B6B6B]">零账户仍可完成稳定排版；一个账户即可使用 AI 基础模式；两个不同服务商账户可形成推荐的主备保障。</p>
          </div>
        </div>
        <span className={`inline-flex h-8 items-center rounded-full px-3 text-[12px] font-bold ${accountBadge.className}`}>{accountBadge.label}</span>
      </div>

      {!bridge ? <p className="mt-4 rounded-xl bg-[#FFF4E5] px-4 py-3 text-[12px] text-[#7A4B00]">生图服务密钥只能在 Echo Founder 桌面 App 中配置。</p> : null}

      <div className="mt-4">
        <p className="text-[11px] font-bold text-[#6B625A]">推荐方案</p>
        <div className="mt-2 grid gap-2 md:grid-cols-2">
          {IMAGE_ACCOUNT_PRESETS.map((preset) => {
            const selected = policy.preset === preset.id;
            return (
              <button key={preset.id} type="button" onClick={() => choosePreset(preset.id)} disabled={!bridge || policyBusy} className={`rounded-[13px] border px-4 py-3 text-left transition-colors disabled:opacity-60 ${selected ? 'border-[#52790C] bg-[#F2F7ED]' : 'border-[rgba(28,28,30,0.09)] bg-white hover:border-[rgba(82,121,12,0.45)]'}`}>
                <span className="block text-[12px] font-bold text-[#1A1A1A]">{preset.label}</span>
                <span className="mt-1 block text-[10px] leading-5 text-[#6B6B6B]">{preset.detail}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {roleCard('primary_provider')}
        {roleCard('backup_provider')}
      </div>

      <details className="mt-3 rounded-[14px] border border-[rgba(28,28,30,0.08)] bg-[#FAF9F7]">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[12px] font-bold text-[#1A1A1A]">
          高级账户与预算
          <ChevronDown size={15} className="text-[#776E66]" />
        </summary>
        <div className="border-t border-[rgba(28,28,30,0.08)] p-4">
          {roleCard('advanced_provider')}
          <div className="mt-3 rounded-[15px] border border-[rgba(28,28,30,0.08)] bg-white p-4">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-[#F5F1EA] text-[#705C46]"><WalletCards size={16} /></span>
              <div>
                <p className="text-[13px] font-bold text-[#1A1A1A]">付费预算保护</p>
                <p className="mt-1 text-[10px] leading-5 text-[#6B6B6B]">每次调用前显示服务商、模型、数量和预估费用；超过单次或单任务上限时停止新调用并保留已有资产。</p>
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              {([
                ['per_call_limit', '单次上限'],
                ['per_task_limit', '单任务上限'],
                ['monthly_reminder', '月度提醒'],
              ] as const).map(([key, label]) => (
                <label key={key} className="text-[10px] font-bold text-[#6B625A]">
                  {label}（元）
                  <input type="number" min={key === 'monthly_reminder' ? 1 : 0.1} max={key === 'per_call_limit' ? 40 : key === 'per_task_limit' ? 100 : 10000} step="0.1" value={policy.budgets_cny[key]} onChange={(event) => updateBudget(key, event.target.value)} className="mt-1 h-9 w-full rounded-[10px] border border-[rgba(28,28,30,0.12)] bg-white px-3 text-[12px] outline-none focus:border-[#52790C]" />
                </label>
              ))}
            </div>
            <button type="button" disabled={!bridge || policyBusy} onClick={() => persistPolicy(policy)} className="mt-3 inline-flex h-9 items-center gap-2 rounded-[10px] bg-[#1A1A1A] px-3 text-[11px] font-bold text-white disabled:opacity-40">
              {policyBusy ? <Loader2 size={13} className="animate-spin" /> : <ShieldCheck size={13} />}保存预算保护
            </button>
          </div>
        </div>
      </details>

      <div className="mt-4 flex items-start gap-2 rounded-[13px] border border-[#E7DDCE] bg-[#FFF9F0] px-4 py-3 text-[11px] leading-5 text-[#735B38]">
        <CircleAlert size={15} className="mt-0.5 shrink-0" />
        <span>{runtimeStatus?.runtimeRouteReady ? '已配置账户存在可直接运行的正式模型。首次选择 AI 增强时仍会单独确认本任务预算；内部验收只决定发布默认值。' : '账户已保存，但该服务暂时没有可直接运行的正式模型；内部验收不再阻止普通用户主动启用已支持的路由。'}</span>
      </div>

      <details className="mt-3 rounded-[14px] border border-dashed border-[rgba(28,28,30,0.14)] bg-white">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-[11px] font-bold text-[#665D55]">
          内部路由实验室 · 六账户 / 十路由验收
          <ChevronDown size={14} />
        </summary>
        <div className="border-t border-dashed border-[rgba(28,28,30,0.12)] p-4">
          <p className="text-[10px] leading-5 text-[#7A716A]">仅用于 Echo Founder 内部“10 进 3”付费盲测，不是普通用户启用 AI 的前置条件。这里可继续配置全部六个验收账户。</p>
          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            {PROVIDERS.map((provider) => (
              <div key={provider.id} className="rounded-[12px] border border-[rgba(28,28,30,0.08)] bg-[#F8F7F5] p-3">
                <div className="flex items-center gap-2 text-[11px] font-bold text-[#1A1A1A]">
                  {statusById[provider.id]?.configured ? <CheckCircle2 size={14} className="text-[#52790C]" /> : <KeyRound size={14} className="text-[#9A8F84]" />}
                  {provider.name}
                </div>
                {providerForm(provider, true)}
              </div>
            ))}
          </div>
          <div className="mt-3 rounded-[12px] bg-[#F3F1EE] px-3 py-3 text-[10px] leading-5 text-[#655D56]">
            <p className="font-bold text-[#1A1A1A]">内部 benchmark：{benchmark ? `${benchmark.benchmarkId} · ${benchmark.status}` : '尚未冻结'}</p>
            <p className="mt-1">{benchmark?.eligible ? `主路由 ${benchmark.primary}；备用路由 ${benchmark.backup}。` : '六账户、十路由、盲评和真实服务验收未全部通过。'}</p>
          </div>
        </div>
      </details>
    </section>
  );
}
