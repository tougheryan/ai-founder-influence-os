'use client';

import { LoaderCircle, PencilLine, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { displayClientError } from '@/lib/client-error-copy';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { CreativeProfile, CreativeRules } from './material-library-types';

type Props = {
  profile: CreativeProfile | null;
  rules: CreativeRules | null;
  pendingProfileCount: number;
  pendingRulesCount: number;
  onSaveProfile: (profile: CreativeProfile) => Promise<void>;
  onSaveRules: (rules: CreativeRules) => Promise<void>;
  onOpenProposals: (target: 'profile' | 'rules') => void;
};

const EMPTY_PROFILE: CreativeProfile = {
  initialized: false, creatorName: '', accountType: '', identity: '', audience: '', pillars: '',
  introduction: '', voice: '', expressionPreferences: '', visualStyle: '', hotTopics: '', boundaries: '',
};
const EMPTY_RULES: CreativeRules = {
  initialized: false, fixedRequirements: '', styleRules: '', prohibitions: '', platformNotes: '',
};
const PROFILE_FIELDS = ['creatorName', 'accountType', 'identity', 'audience', 'pillars', 'introduction', 'voice', 'expressionPreferences', 'visualStyle', 'hotTopics', 'boundaries'] as const;
const RULE_FIELDS = ['fixedRequirements', 'styleRules', 'prohibitions', 'platformNotes'] as const;

export function CreativeProfilePanel({ profile, rules, pendingProfileCount, pendingRulesCount, onSaveProfile, onSaveRules, onOpenProposals }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CreativeProfile>(profile || EMPTY_PROFILE);
  const [rulesDraft, setRulesDraft] = useState<CreativeRules>(rules || EMPTY_RULES);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // A successful first save must not be repeated if the second save fails.
  const [savedProfile, setSavedProfile] = useState<CreativeProfile | null>(null);
  const view = profile || EMPTY_PROFILE;
  const ruleView = rules || EMPTY_RULES;
  const openEditor = () => {
    setDraft(view); setRulesDraft(ruleView); setSavedProfile(null); setError(''); setOpen(true);
  };
  const hasContent = PROFILE_FIELDS.some((key) => draft[key]?.trim()) || RULE_FIELDS.some((key) => rulesDraft[key].trim());
  const save = async () => {
    setSaving(true); setError('');
    try {
      const baseline = savedProfile || view;
      const profileContent = PROFILE_FIELDS.some((key) => draft[key]?.trim());
      const profileChanged = PROFILE_FIELDS.some((key) => (draft[key] || '') !== (baseline[key] || ''));
      if (profileChanged || (!profile?.initialized && !savedProfile && profileContent)) {
        await onSaveProfile({ ...draft, initialized: true });
        const saved = { ...draft, initialized: true, version: (draft.version ?? 0) + 1 };
        setSavedProfile(saved); setDraft(saved);
      }
      if (RULE_FIELDS.some((key) => rulesDraft[key] !== ruleView[key])) {
        await onSaveRules({ ...rulesDraft, initialized: true });
      }
      setOpen(false);
    } catch (cause) {
      setError(displayClientError(cause, '设置没有全部保存。你的输入还在，请重试。'));
    } finally { setSaving(false); }
  };
  const profileField = (key: typeof PROFILE_FIELDS[number], label: string, placeholder: string, multiline = true) => (
    <FormField key={key} label={label} value={draft[key] || ''} onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))} placeholder={placeholder} multiline={multiline} />
  );
  const ruleField = (key: typeof RULE_FIELDS[number], label: string, placeholder: string) => (
    <FormField key={key} label={label} value={rulesDraft[key]} onChange={(value) => setRulesDraft((current) => ({ ...current, [key]: value }))} placeholder={placeholder} multiline />
  );

  return <div className="space-y-5">
    <section className="border border-[rgba(28,28,30,0.1)] bg-white shadow-[0_8px_22px_rgba(28,28,30,0.035)]">
      <div className="flex flex-wrap items-start justify-between gap-4 px-5 py-5">
        <div>
          <h2 className="text-[20px] font-bold text-[#1A1A1A]">{view.creatorName || '写作设置'}</h2>
          <p className="mt-2 max-w-[760px] text-[13px] leading-[1.7] text-[#6B6B6B]">先记住你写给谁、习惯怎样表达、哪些不要写。填一项也可以，其余需要时再补。</p>
        </div>
        <button type="button" onClick={openEditor} className="inline-flex h-9 items-center gap-2 bg-[#1C1C1E] px-3 text-[12px] font-bold text-white hover:bg-[#353535]"><PencilLine size={14} />编辑写作设置</button>
      </div>
      <div className="grid gap-5 border-t border-[rgba(28,28,30,0.08)] px-5 py-4 lg:grid-cols-3">
        <Setting label="写给谁" value={view.audience} />
        <Setting label="怎样表达" value={[view.voice, view.expressionPreferences, ruleView.styleRules].filter(Boolean).join('\n')} />
        <Setting label="不要写什么" value={[view.boundaries, ruleView.prohibitions].filter(Boolean).join('\n')} />
      </div>
      <details className="border-t border-[rgba(28,28,30,0.08)] px-5 py-4">
        <summary className="cursor-pointer text-[12px] font-bold text-[#6B6B6B]">查看其他账号资料和规则</summary>
        <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          <Setting label="账号类型" value={view.accountType} /><Setting label="身份与介绍" value={[view.identity, view.introduction].filter(Boolean).join('\n')} />
          <Setting label="常写主题" value={view.pillars} /><Setting label="视觉偏好" value={view.visualStyle} /><Setting label="热点边界" value={view.hotTopics} />
          <Setting label="每篇固定要求" value={ruleView.fixedRequirements} /><Setting label="各平台写法" value={ruleView.platformNotes} />
        </div>
      </details>
      {(pendingProfileCount > 0 || pendingRulesCount > 0) && <div className="flex flex-wrap gap-2 border-t border-[rgba(28,28,30,0.08)] px-5 py-4">
        {([['profile', pendingProfileCount, '账号资料'], ['rules', pendingRulesCount, '写作规则']] as const).map(([target, count, label]) => count > 0 && <button key={target} type="button" onClick={() => onOpenProposals(target)} className="inline-flex h-8 items-center gap-1.5 border border-[#F2D7A7] bg-[#FFF8E8] px-2.5 text-[11px] font-bold text-[#8D5A00]"><Sparkles size={13} />待确认{label}建议 {count}</button>)}
      </div>}
    </section>
    <p className="text-[12px] leading-[1.65] text-[#6B6B6B]">只有你保存的设置才会用于后续写作。本篇明确提出的要求优先；本篇字数、平台和临时限制不会自动成为长期偏好。</p>
    <Dialog open={open} onOpenChange={(value) => { if (!saving) setOpen(value); }}>
      <DialogContent className="grid max-h-[88dvh] w-[calc(100%-2rem)] max-w-[820px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-[18px] bg-white p-0 text-[#1A1A1A] sm:max-w-[820px]">
        <DialogHeader className="border-b border-[rgba(28,28,30,0.08)] px-6 py-5">
          <DialogTitle className="text-[20px] font-bold">写作设置</DialogTitle>
          <DialogDescription className="mt-1 text-[13px] text-[#6B6B6B]">先填写常用的三项，全部选填。只保存你愿意长期沿用的习惯。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-5 overflow-y-auto px-6 py-5">
          <div className="grid gap-4">
            {profileField('audience', '写给谁', '例如：需要带项目的小团队负责人')}
            {profileField('voice', '怎样表达', '例如：平实、用短句，先讲具体事情')}
            {profileField('boundaries', '不要写什么', '例如：不写营销口号，不编造经历')}
          </div>
          <details className="border-t border-[rgba(28,28,30,0.08)] pt-4">
            <summary className="cursor-pointer text-[13px] font-bold">其他账号资料与写作规则（选填）</summary>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              {profileField('creatorName', '创作者名称', '例如：小明说职场', false)}
              {profileField('accountType', '账号类型', '例如：工具与实验', false)}
              {profileField('identity', '身份与视角', '你以什么身份分享经历')}
              {profileField('pillars', '常写主题', '例如：职场沟通、项目复盘')}
              {profileField('introduction', '自我介绍', '一句话介绍自己')}
              {profileField('expressionPreferences', '补充表达习惯', '你已确认、想继续保留的表达习惯')}
              {profileField('visualStyle', '视觉偏好', '例如：留白、低饱和、少量重点色')}
              {profileField('hotTopics', '热点边界', '想谈和不谈的热点范围')}
              {ruleField('fixedRequirements', '每篇固定要求', '例如：观点后给一个真实案例')}
              {ruleField('styleRules', '补充表达规则', '已经记录的其他表达规则')}
              {ruleField('prohibitions', '补充禁写规则', '已经记录的其他禁写规则')}
              {ruleField('platformNotes', '各平台写法', '需要长期沿用的平台写法')}
            </div>
          </details>
          {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-[12px] text-red-800">{error} 如设置已在另一窗口更新，可先取消，再重新打开核对。</p>}
        </div>
        <DialogFooter className="m-0 border-t border-[rgba(28,28,30,0.08)] bg-[#F8FAF6] px-6 py-4 sm:justify-end">
          <button type="button" onClick={() => setOpen(false)} disabled={saving} className="h-10 border border-[rgba(28,28,30,0.12)] bg-white px-4 text-[12px] font-bold disabled:opacity-50">取消</button>
          <button type="button" onClick={() => void save()} disabled={saving || !hasContent} className="inline-flex h-10 items-center justify-center gap-2 bg-[#1C1C1E] px-4 text-[12px] font-bold text-white disabled:opacity-50">{saving && <LoaderCircle size={14} className="animate-spin" />}{saving ? '保存中' : '保存写作设置'}</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

function Setting({ label, value }: { label: string; value?: string }) {
  return <div><h3 className="text-[11px] font-bold text-[#8A8178]">{label}</h3><p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-[1.65] text-[#1A1A1A]">{value || '尚未设置'}</p></div>;
}
function FormField({ label, value, onChange, placeholder, multiline }: { label: string; value: string; onChange: (value: string) => void; placeholder: string; multiline: boolean }) {
  const styles = 'block w-full border border-[rgba(28,28,30,0.14)] bg-[#F8FAF6] px-3.5 py-3 text-[13px] leading-[1.65] text-[#1A1A1A] outline-none placeholder:text-[#929A91] focus:border-[#52790C] focus:ring-2 focus:ring-[#ADf13E]/20';
  return <label className="block"><span className="mb-2 block text-[12px] font-bold">{label}</span>{multiline ? <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={3} placeholder={placeholder} className={`${styles} resize-y`} /> : <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className={styles} />}</label>;
}
