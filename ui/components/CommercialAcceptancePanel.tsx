"use client";

import { Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CommercialAcceptanceStatus, CommercialServiceStatus } from '@/lib/commercial-acceptance-status';

type Gate = { id: string; label: string; state: 'pass' | 'blocked' | 'pending'; detail: string };
type Readiness = { status: string; checkedAt: string; commercialAcceptance?: CommercialAcceptanceStatus };

export function CommercialAcceptancePanel({ readiness, services, loading, onRefresh }: {
  readiness: Readiness | null;
  services: CommercialServiceStatus | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const candidate = readiness?.commercialAcceptance;
  const acceptance = !loading && readiness?.status !== 'fail'
    && candidate?.schema === 'echo-founder.commercial-acceptance-status.v2'
    && candidate.eligibility?.contractStatus === 'pending_independent_review'
    && candidate.record?.signatureVerification === 'not_performed'
    ? candidate : null;
  const unknown = loading ? '正在读取，尚未验证' : readiness?.status === 'fail' ? '读取失败，尚未验证' : '尚未读取有效状态';
  const sourceReady = acceptance?.source?.available === true && acceptance.source.dirty === false;
  const qaReady = acceptance?.qaTrust?.ready === true;
  const candidateReady = acceptance?.frozenCandidate?.ready === true;
  const state = (ready: boolean, enabled: boolean): Gate['state'] => !acceptance ? 'pending' : ready ? 'pass' : enabled ? 'blocked' : 'pending';
  const eligibilityLabels = {
    legacy_read_only: '历史记录，只读',
    internal_only: '内部自验，不授予商业资格',
    pending_contract_review: '正式验收契约待独立评审',
    invalid: '记录无效，尚未验证',
  };
  const recordLabel = !acceptance ? unknown
    : acceptance.record.readState === 'missing' ? '尚无验收记录'
    : acceptance.record.readState === 'unreadable' ? '记录读取失败，尚未验证'
    : eligibilityLabels[acceptance.eligibility.status] || '当前资格未验证';
  const gates: Gate[] = [
    { id: 'source', label: '1 · 干净源码基线', state: state(sourceReady, acceptance?.source?.available === true),
      detail: !acceptance ? unknown : !acceptance.source.available ? '本机无法读取 Git 状态，尚未验证源码基线'
        : sourceReady ? `源码无未提交修改：${acceptance.source.currentSha.slice(0, 10)}` : `${acceptance.source.dirtyEntryCount ?? '未知数量'} 项修改尚未收口` },
    { id: 'qa', label: '2 · 独立 QA 登记', state: state(qaReady, sourceReady),
      detail: !acceptance ? unknown : qaReady ? `已登记 ${acceptance.qaTrust.keyCount} 个公钥；仍需独立 QA 复核证据` : '尚未登记独立 QA 公钥' },
    { id: 'candidate', label: '3 · 冻结候选文件', state: state(candidateReady, sourceReady && qaReady),
      detail: !acceptance ? unknown : candidateReady ? '候选文件齐全，仍需核验源码与产物绑定'
        : acceptance.frozenCandidate.exactArtifactsPresent ? '产物版本或源码状态不符合冻结条件' : `缺少 ${acceptance.frozenCandidate.expectedArtifact}` },
    { id: 'contract', label: '4 · 当前正式验收契约', state: acceptance ? 'blocked' : 'pending',
      detail: acceptance ? '固定排版流程的正式契约尚待独立评审；现有记录均不能认证当前版本' : unknown },
    { id: 'production', label: '5 · 真实账号与内容验收', state: 'pending',
      detail: acceptance ? '当前契约尚未生效；生成、作者采用、草稿与恢复仍需真人观察。内部记录不能替代正式验收' : unknown },
    { id: 'attestation', label: '6 · 正式资格与签名核验', state: 'pending',
      detail: !acceptance ? unknown : acceptance.record.signaturePresent ? '记录含签名字段；本页未验签，当前正式资格未通过' : '尚无已验证的正式验收签名' },
  ];
  const completed = gates.filter(gate => gate.state === 'pass').length;
  const checkedAt = acceptance && readiness?.checkedAt && Number.isFinite(Date.parse(readiness.checkedAt))
    ? new Date(readiness.checkedAt).toLocaleString('zh-CN', { hour12: false }) : '尚未读取';

  return (
    <section aria-label="商业验收记录" className="rounded-[18px] border border-[rgba(28,28,30,0.08)] bg-white p-[16px] shadow-[0_8px_24px_rgba(28,28,30,0.035)]">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-start gap-[11px]">
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-xl bg-[#FFF3DA]"><ShieldCheck size={19} className="text-[#A35E00]" /></span>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-bold text-[#1A1A1A]">商业验收记录</h2>
              <span className="rounded-full bg-[#FFF3DA] px-[9px] py-1 text-xs font-bold text-[#A35E00]">尚未完成正式验收</span>
            </div>
            <p className="mt-1 text-[13px] leading-7 text-[#6B6B6B]">当前固定排版流程的正式验收契约待独立评审。历史验收、内部自验和自动化测试均不能认证当前版本。</p>
            <p className="mt-2 text-[13px] leading-6 text-[#6B6B6B]">核对版本：{acceptance?.productVersion || '未记录'} · 状态读取于：{checkedAt}。读取时间不是验收通过时间。</p>
          </div>
        </div>
        <button type="button" onClick={onRefresh} disabled={loading} className="inline-flex h-[38px] shrink-0 items-center justify-center gap-[7px] rounded-full border border-[rgba(28,28,30,0.1)] px-[13px] text-[13px] font-semibold disabled:cursor-not-allowed disabled:text-[#9A9A9A]">
          {loading ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}刷新验收状态
        </button>
      </div>
      <div className="mt-4 rounded-xl bg-[#F7F5F2] p-3 text-[13px] leading-6 text-[#6B6B6B]">
        <p className="font-semibold text-[#1A1A1A]">{recordLabel}</p>
        {acceptance?.record.exists && <p className="break-all">记录版本：{acceptance.record.schema || '无法识别'} · 原始自报状态：{acceptance.record.reportedStatus || '未记录'}。此处只读展示，不代表验证结果。</p>}
        {!!acceptance?.record.structureIssues.length && <p>{acceptance.record.structureIssues.join('；')}。不会记为通过。</p>}
      </div>
      <p className="mt-3 text-xs text-[#6B6B6B]">{completed}/{gates.length} 项准备就绪；准备项不等于正式验收通过。</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
        {gates.map(gate => <article key={gate.id} data-gate={gate.id} data-state={gate.state} className="min-w-0 rounded-xl bg-[#FDF8F3] p-3">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-xs font-bold text-[#1A1A1A]">{gate.label}</h3>
            <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] ${gate.state === 'pass' ? 'bg-[#EAF8EF] text-[#16803C]' : 'bg-[#FFF3DA] text-[#A35E00]'}`}>{gate.state === 'pass' ? '就绪' : gate.state === 'blocked' ? '待补齐' : '未验证'}</span>
          </div>
          <p className="mt-2 text-xs leading-6 text-[#6B6B6B]">{gate.detail}</p>
        </article>)}
      </div>
      <p className="mt-3 border-l-[3px] border-[#52790C] bg-[#F7FAF4] px-3 py-2 text-[13px] leading-6 text-[#1A1A1A]">{acceptance ? '下一步：独立评审当前流程的正式验收契约，并保留干净源码、冻结候选、真实账号观察和独立 QA 要求。内部试用可按九项观察表记录，不能转为正式通过。' : '请刷新状态；读取完成前，各项保持未验证。'}</p>
      {!loading && services?.tikomniWeeklySnapshotComplete && <p className="mt-2 text-xs leading-6 text-[#6B6B6B]">已有三平台周度样本存档；不代表当前连接、人工校准或正式验收已通过。</p>}
      {!loading && !!services?.errors.length && <p className="mt-2 text-xs text-[#A35E00]">{services.errors.join('；')}。未知状态不会记为通过。</p>}
    </section>
  );
}
