'use client';

import { FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { displayClientError } from '@/lib/client-error-copy';
import { MACOS_KEYCHAIN_EXPLANATION } from '@/lib/product-copy';

type CredentialId = 'wechat_official_api' | 'wechat_browser_bridge' | 'xiaohongshu_browser_bridge';
type CredentialStatus = { id: CredentialId; configured: boolean; updatedAt: string | null };

const DEFAULT_WECHAT_EDITOR = 'https://mp.weixin.qq.com/';
const DEFAULT_XHS_EDITOR = 'https://creator.xiaohongshu.com/publish/publish';

function statusById(items: CredentialStatus[]): Record<CredentialId, CredentialStatus | undefined> {
  return Object.fromEntries(items.map((item) => [item.id, item])) as Record<CredentialId, CredentialStatus | undefined>;
}

export function PublicationBridgeSettings() {
  const [desktop, setDesktop] = useState(false);
  const [statuses, setStatuses] = useState<CredentialStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<CredentialId | null>(null);
  const [wechatAppId, setWechatAppId] = useState('');
  const [wechatAppSecret, setWechatAppSecret] = useState('');
  const [wechatAuthor, setWechatAuthor] = useState('');
  const [wechatEditorUrl, setWechatEditorUrl] = useState(DEFAULT_WECHAT_EDITOR);
  const [xhsEditorUrl, setXhsEditorUrl] = useState(DEFAULT_XHS_EDITOR);

  const refresh = useCallback(async () => {
    if (typeof window === 'undefined' || !window.aifiosPublication) {
      setDesktop(false);
      setStatuses([]);
      return;
    }
    setDesktop(true);
    setLoading(true);
    try {
      const [credentials, bridges] = await Promise.all([
        window.aifiosCredentials
          ? window.aifiosCredentials.status().then((items) => items.filter((item) => (
            item.id === 'wechat_official_api'
            || item.id === 'wechat_browser_bridge'
            || item.id === 'xiaohongshu_browser_bridge'
          )))
          : window.aifiosPublication.credentialStatus(),
        window.aifiosPublication.bridgeStatus(),
      ]);
      const bridgeConfigured = new Map(bridges.map((item) => [item.id, item.configured]));
      setStatuses((credentials as CredentialStatus[]).map((item) => ({
        ...item,
        configured: bridgeConfigured.get(item.id) === true,
      })));
    } catch (error) {
      toast.error(displayClientError(error, '发布账号连接没有读取成功。请刷新后重试。'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refresh();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  const status = useMemo(() => statusById(statuses), [statuses]);

  const save = async (id: CredentialId, value: Record<string, string>) => {
    if (!window.aifiosPublication) return;
    setSaving(id);
    try {
      if (window.aifiosCredentials) {
        await window.aifiosCredentials.save(id, JSON.stringify(value));
      } else {
        await window.aifiosPublication.saveCredential(id, JSON.stringify(value));
      }
      if (id === 'wechat_official_api') {
        setWechatAppSecret('');
      }
      await refresh();
      toast.success('发布账号连接已保存');
    } catch (error) {
      toast.error(displayClientError(error, '发布账号连接没有保存成功。请检查填写内容后重试。'));
    } finally {
      setSaving(null);
    }
  };

  const remove = async (id: CredentialId) => {
    if (!window.aifiosPublication) return;
    setSaving(id);
    try {
      if (window.aifiosCredentials) {
        await window.aifiosCredentials.delete(id);
      } else {
        await window.aifiosPublication.deleteCredential(id);
      }
      await refresh();
      toast.success('发布账号连接已移除');
    } catch (error) {
      toast.error(displayClientError(error, '发布账号连接没有移除成功。请刷新后重试。'));
    } finally {
      setSaving(null);
    }
  };

  const openEditor = async (platform: 'wechat' | 'xiaohongshu') => {
    if (!window.aifiosPublication) return;
    try {
      await window.aifiosPublication.openEditor(platform);
    } catch (error) {
      toast.error(displayClientError(error, '平台编辑器没有打开。请检查账号连接后重试。'));
    }
  };

  const submitWechatApi = (event: FormEvent) => {
    event.preventDefault();
    if (!wechatAppId.trim() || !wechatAppSecret.trim()) {
      toast.error('请填写公众号 AppID 与 AppSecret');
      return;
    }
    void save('wechat_official_api', {
      appId: wechatAppId.trim(),
      appSecret: wechatAppSecret.trim(),
      ...(wechatAuthor.trim() ? { author: wechatAuthor.trim() } : {}),
    });
  };

  if (!desktop) {
    return (
      <section className="aifios-settings-section border border-[rgba(28,28,30,0.1)] bg-white p-4">
        <div className="flex items-center gap-2 text-[13px] text-[#6B6B6B]">
          <KeyRound size={16} className="text-[#8A8178]" />
          <span>发布账号连接仅在 Echo Founder 桌面端设置。</span>
        </div>
      </section>
    );
  }

  const connection = (id: CredentialId) => Boolean(status[id]?.configured);
  const actionClass = 'inline-flex h-10 shrink-0 items-center justify-center gap-2 border border-[rgba(28,28,30,0.14)] bg-white px-3.5 text-[12px] font-bold text-[#1A1A1A] transition hover:border-[#52790C] hover:bg-[#F7FAF4] hover:text-[#3B5E06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#52790C]/25 disabled:cursor-not-allowed disabled:opacity-50';
  const inputClass = 'h-11 w-full border border-[rgba(28,28,30,0.14)] bg-white px-3.5 text-[13px] text-[#1A1A1A] outline-none placeholder:text-[#8D968D] focus:border-[#52790C] focus:ring-2 focus:ring-[#ADF13E]/20';

  return (
    <section className="aifios-settings-section border border-[rgba(28,28,30,0.1)] bg-white">
      <div className="aifios-settings-section__header flex flex-col gap-4 border-b border-[rgba(28,28,30,0.08)] px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <KeyRound size={17} className="text-[#E85D4C]" />
          <div>
            <h2 className="text-[17px] font-bold text-[#1A1A1A]">发布账号连接</h2>
            <p className="mt-1 text-[12px] text-[#6B6B6B]">连接后可把内容填入平台草稿，系统不会自动发布。</p>
            <p className="mt-1 max-w-[760px] text-[11px] leading-[1.55] text-[#7A716A]">{MACOS_KEYCHAIN_EXPLANATION}</p>
          </div>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading || saving !== null} title="刷新发布账号连接" className="flex h-10 w-10 shrink-0 items-center justify-center border border-[rgba(28,28,30,0.14)] text-[#6B6B6B] transition hover:border-[#52790C] hover:bg-[#F7FAF4] hover:text-[#3B5E06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#52790C]/25 disabled:opacity-50">
          {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        </button>
      </div>

      <div className="aifios-settings-grid grid gap-4 bg-[#F7F9F5] p-5 xl:grid-cols-2">
        <form onSubmit={submitWechatApi} className="aifios-settings-card flex h-full flex-col gap-3 bg-white p-5 shadow-[0_12px_32px_rgba(31,61,37,0.04)]">
          <ConnectionHeader title="公众号发布接口" connected={connection('wechat_official_api')} onRemove={() => void remove('wechat_official_api')} removing={saving === 'wechat_official_api'} />
          <div className="grid gap-2 sm:grid-cols-2">
            <label><span className="mb-1 block text-[11px] font-bold text-[#6B6B6B]">AppID</span><input value={wechatAppId} onChange={(event) => setWechatAppId(event.target.value)} className={inputClass} autoComplete="off" /></label>
            <label><span className="mb-1 block text-[11px] font-bold text-[#6B6B6B]">AppSecret</span><input value={wechatAppSecret} onChange={(event) => setWechatAppSecret(event.target.value)} type="password" className={inputClass} autoComplete="new-password" /></label>
          </div>
          <label><span className="mb-1 block text-[11px] font-bold text-[#6B6B6B]">作者（可选）</span><input value={wechatAuthor} onChange={(event) => setWechatAuthor(event.target.value)} className={inputClass} autoComplete="off" /></label>
          <div className="mt-auto pt-1"><button type="submit" disabled={saving !== null} className={actionClass}>{saving === 'wechat_official_api' ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}保存接口</button></div>
        </form>

        <form onSubmit={(event) => { event.preventDefault(); void save('wechat_browser_bridge', { editorUrl: wechatEditorUrl.trim() }); }} className="aifios-settings-card flex h-full flex-col gap-3 bg-white p-5 shadow-[0_12px_32px_rgba(31,61,37,0.04)]">
          <ConnectionHeader title="公众号 · 本机已登录浏览器" connected={connection('wechat_browser_bridge')} onRemove={() => void remove('wechat_browser_bridge')} removing={saving === 'wechat_browser_bridge'} />
          <label><span className="mb-1 block text-[11px] font-bold text-[#6B6B6B]">编辑器地址</span><input value={wechatEditorUrl} onChange={(event) => setWechatEditorUrl(event.target.value)} className={inputClass} /></label>
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={saving !== null} className={actionClass}>{saving === 'wechat_browser_bridge' ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}保存连接</button>
            <button type="button" onClick={() => void openEditor('wechat')} disabled={!connection('wechat_browser_bridge') || saving !== null} className={actionClass}><ExternalLink size={13} />打开登录</button>
          </div>
        </form>

        <form onSubmit={(event) => { event.preventDefault(); void save('xiaohongshu_browser_bridge', { editorUrl: xhsEditorUrl.trim() }); }} className="aifios-settings-card flex h-full flex-col gap-3 bg-white p-5 shadow-[0_12px_32px_rgba(31,61,37,0.04)]">
          <ConnectionHeader title="小红书 · 本机已登录浏览器" connected={connection('xiaohongshu_browser_bridge')} onRemove={() => void remove('xiaohongshu_browser_bridge')} removing={saving === 'xiaohongshu_browser_bridge'} />
          <label><span className="mb-1 block text-[11px] font-bold text-[#6B6B6B]">编辑器地址</span><input value={xhsEditorUrl} onChange={(event) => setXhsEditorUrl(event.target.value)} className={inputClass} /></label>
          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <button type="submit" disabled={saving !== null} className={actionClass}>{saving === 'xiaohongshu_browser_bridge' ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}保存连接</button>
            <button type="button" onClick={() => void openEditor('xiaohongshu')} disabled={!connection('xiaohongshu_browser_bridge') || saving !== null} className={actionClass}><ExternalLink size={13} />打开登录</button>
          </div>
        </form>

        <div className="aifios-settings-card flex h-full flex-col gap-3 bg-white p-5 shadow-[0_12px_32px_rgba(31,61,37,0.04)]">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-bold text-[#1A1A1A]">视频号 · 人工草稿承接</span>
            <span className="inline-flex h-5 items-center bg-[#F3F1ED] px-1.5 text-[10px] font-bold text-[#6B625B]">无需连接</span>
          </div>
          <p className="text-[12px] leading-[1.7] text-[#6B6B6B]">Echo Founder 生成开场钩子、口播、镜头、字幕重点和发布文案，不创建静态视觉或自动发布。请在已授权的视频号后台人工填入并保存草稿。</p>
          <p className="mt-auto text-[11px] font-semibold text-[#8A8178]">真实账号验收会记录草稿凭证；验证码、风控和设备确认始终由操作者处理。</p>
        </div>
      </div>
    </section>
  );
}

function ConnectionHeader({
  title,
  connected,
  onRemove,
  removing,
  icon,
}: {
  title: string;
  connected: boolean;
  onRemove: () => void;
  removing: boolean;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <span className="text-[13px] font-bold text-[#1A1A1A]">{title}</span>
        <span className={`inline-flex h-5 items-center px-1.5 text-[10px] font-bold ${connected ? 'bg-[#EDF8F0] text-[#16803C]' : 'bg-[#F5EDE4] text-[#6B5543]'}`}>{connected ? '已完成' : '未开始'}</span>
      </div>
      {connected && <button type="button" onClick={onRemove} disabled={removing} title="移除发布账号连接" aria-label={`移除${title}`} className="flex h-9 w-9 items-center justify-center bg-[#FFF9F7] text-[#934A39] transition hover:bg-[#FFF2EE] hover:text-[#7E3728] disabled:opacity-50">{removing ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}</button>}
    </div>
  );
}
