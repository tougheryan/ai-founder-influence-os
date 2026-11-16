import { materialClauses, materialSentences, unquotedMaterialText } from './material-text';
import { materialAuthorAudience } from './material-writing-requirements';

export type DraftPreferenceField = 'targetAudience' | 'writingStyle' | 'prohibitions';
export type DraftPreferenceCandidate = { id: string; field: DraftPreferenceField; label: string; value: string; source: string };
export type DraftPreferenceChoice = { id: string; value: string };

// A reusable preference must survive removal of this article's assignment.
// Keep this conservative: omission is preferable to permanently saving a test,
// a customer's instruction, or a private fact as the author's identity.
const TEMPORARY_SCOPE = /本(?:篇|次|期|文|条|轮|周|月)|这(?:一|个)?(?:篇|次|期|条|回|轮|份|版|月)|此次|当(?:次|期|篇)|当前(?:稿|文)|今(?:天|日)|明(?:天|日)|昨天|仅(?:用于|限|供|此)|只(?:用于|供|限)|临时|暂(?:时|且|不)|一次性/;
const TEMPORARY = /本(?:篇|次|期|文)|这(?:篇|次|期)|此次|仅供|内部|测试|演示|验收|不要发布|不公开|保密|报价|合同|客户名|姓名|电话|邮箱|地址|https?:|\d.{0,8}(?:字|分钟|张)|[一二三四五六七八九十百千两]+字|公众号|小红书|视频号|抖音|结尾|开头|段落|标题|篇幅|字数|平台|这位|该客户|客户说|受访者|示例|例如|引用/;
const LABELS: Record<DraftPreferenceField, string> = { targetAudience: '写给谁', writingStyle: '怎样表达', prohibitions: '不要写什么' };

export function reusablePreferenceText(value: string): boolean {
  return value.trim().length > 0 && value.length <= 600 && !TEMPORARY_SCOPE.test(value) && !TEMPORARY.test(value) && !/[\r\n]/.test(value);
}

export function draftPreferenceCandidates(requirements: readonly string[]): DraftPreferenceCandidate[] {
  const result: DraftPreferenceCandidate[] = [];
  const add = (field: DraftPreferenceField, value: string, source: string) => {
    value = value.replace(/[。；;]+$/, '').trim();
    if (!reusablePreferenceText(value) || result.some((item) => item.field === field && item.value === value)) return;
    result.push({ id: `${field}-${result.filter((item) => item.field === field).length}`, field, label: LABELS[field], value, source });
  };
  for (const requirement of requirements) {
    for (const sentence of materialSentences(requirement)) {
      // An explicit one-off qualifier applies to the whole sentence, including
      // clauses after a comma. Never silently drop the qualifier then promote.
      const visibleSentence = unquotedMaterialText(sentence);
      if (TEMPORARY_SCOPE.test(visibleSentence) || /内部|测试|演示|验收|客户说|受访者|示例|例如|引用/.test(visibleSentence)) continue;
      for (const clause of materialClauses(sentence)) {
        const visible = unquotedMaterialText(clause).trim();
        if (!visible || /[“「『"']/.test(clause) || /(?:例如|客户|受访者).*(?:说|要求|希望)/.test(visible)) continue;
        const stripped = visible.replace(/^(?:写作要求|作者要求|要求)[：:]\s*/, '');
        const audience = materialAuthorAudience([stripped]);
        if (audience) add('targetAudience', audience, clause);
        if (/^(?:(?:语气|文风|语言风格|表达方式|表达习惯)[：:是]?\s*)?(?:平实|朴实|口语|自然|克制|简洁|简练|直白|温和|严谨|短句|少空话|少形容词|少套话|不用术语|不堆术语)/.test(stripped)) {
          add('writingStyle', stripped.replace(/^(?:语气|文风|语言风格|表达方式|表达习惯)[：:是]?\s*/, ''), clause);
        }
        if (/^(?:不要|不写|不加|不引导|不得|禁止|不能|避免)/.test(stripped) && /营销|口号|套话|夸大|承诺|焦虑|编造|虚构|杜撰|引导|私信|购买|广告|销售/.test(stripped)) add('prohibitions', stripped, clause);
      }
    }
  }
  return result.slice(0, 12);
}

export function appendPreferenceText(current: string, additions: readonly string[]): string {
  const lines = current.split('\n').map((line) => line.trim()).filter(Boolean);
  const fresh = additions.filter((value, index) => !lines.includes(value.trim()) && additions.indexOf(value) === index);
  return [current.trim(), ...fresh].filter(Boolean).join('\n');
}
