'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { LLMConfig } from '@/lib/types';

export function modelSetupMessage(config: LLMConfig | null): string | null {
  if (!config) return '尚未读到生成服务设置，请刷新检查。';
  if (config.connectionMode === 'hosted' || config.provider === 'aifios-hosted') {
    return config.gatewayConnected ? null : '请先在设置中连接生成服务。';
  }
  if (!config.hasEnvKey && !config.hasSavedKey && !config.apiKey?.trim()) {
    return '尚未配置模型密钥，请先保存模型设置并测试连接。';
  }
  if (!config.model?.trim()) return '尚未选择用于写作的模型。';
  return null;
}

export function ProductionSetupChecklist({ config, onRefresh, writingMode }: {
  writingMode?: 'platform' | 'author_material';
  config: LLMConfig | null;
  onRefresh: () => Promise<void>;
}) {
  const [research, setResearch] = useState<'loading' | 'configured' | 'missing' | 'error'>('loading');
  const [revision, setRevision] = useState(0);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/settings/tikomni', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('settings unavailable');
        const data = await response.json();
        if (!controller.signal.aborted) setResearch(data.setup?.status === 'ready_to_test' ? 'configured' : 'missing');
      })
      .catch(() => { if (!controller.signal.aborted) setResearch('error'); });
    return () => controller.abort();
  }, [revision]);
  const modelMessage = modelSetupMessage(config);
  return (
    <details className="rounded-xl border border-[rgba(28,28,30,0.12)] bg-white px-4 py-2">
      <summary className="cursor-pointer text-xs text-[#6B6B6B]">连接与费用说明</summary>
      <section aria-label="开始前检查" className="pb-2 pt-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-bold">连接与使用条件</h2>
        <button type="button" disabled={checking} className="text-sm underline disabled:opacity-50" onClick={async () => {
          setChecking(true);
          try { await onRefresh(); } finally {
            setResearch('loading');
            setRevision((value) => value + 1);
            setChecking(false);
          }
        }}>{checking ? '正在检查' : '重新检查配置'}</button>
      </div>
      <p className="mt-2 text-sm text-[#6B6B6B]">第一次建议只做一个平台。先整理素材，再核对事实、表达和发布成品；最后由你公开发布。</p>
      <ul className="mt-3 space-y-2 text-sm" aria-live="polite">
        <li>生成服务：{modelMessage || '已填写配置，连接与额度请在设置中测试。'}{' '}
          <Link className="underline" href="/settings#model-connection">检查模型连接</Link>
        </li>
        {writingMode === 'author_material' ? <li>按自己的题目写：不需要平台数据服务；素材核对后即可准备写作方案。</li> : <li>平台研究：{research === 'loading' ? '正在读取配置。' : research === 'configured' ? '已配置；本期实时采集成功后才有选题依据。' : research === 'error' ? '设置读取失败，请重新检查。' : '尚未配置完整，开始选题前请完成设置。'}{' '}
          <Link className="underline" href="/settings#tikomni-research">检查平台研究</Link>
        </li>}
      </ul>
      <p className="mt-3 text-xs leading-relaxed text-[#6B6B6B]">可以先在本机整理文字素材。生成内容和平台研究可能产生所选服务的费用；配置存在不代表账号连接、余额或内容质量已经验收。<Link href="/settings#service-costs" className="underline">查看费用与调用说明</Link>。发布连接不可用时，可使用成品中的文章、图片或脚本手动发布。</p>
      </section>
    </details>
  );
}
