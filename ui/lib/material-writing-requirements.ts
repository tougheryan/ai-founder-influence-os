import { materialClauses, materialSentences, unquotedMaterialText, withoutLeadingMaterialUseNote } from './material-text';
import { materialTitleAssignment } from './material-title-suggestion';
import { MATERIAL_SCENE_NOUN } from './material-source-status';

const SOURCE_LABEL_REQUIREMENT = new RegExp(`^(?:请)?保留(?:原文的?)?(?:虚构|模拟|假设|待核实|待核验)${MATERIAL_SCENE_NOUN}?的?(?:标识|标记|说明|性质)(?:[，,；;：:]|$)`);

function normalizedSentence(value: string): string {
  return value.replace(/^\s*(?:[-*]\s*|\d+[、)]\s*|\d+\.(?!\d)\s*)/, '').trim();
}

function requirementItems(value: string): string[] {
  const items: string[] = [];
  for (const clause of materialClauses(value)) {
    const independent = isDirectRequirement(clause)
      || /^(?:用(?:第一|第二|第三)人称|平实|口语|自然|简洁|直接|克制|保留|不写|不要|不引导)/.test(clause);
    if (!items.length || independent) items.push(clause);
    else items[items.length - 1] += `，${clause}`;
  }
  return items;
}

function isExplicitWritingExclusion(sentence: string): boolean {
  if (!sentence.startsWith('不写')) return false;
  const firstClause = materialClauses(sentence)[0] || '';
  const visible = unquotedMaterialText(firstClause).trim();
  // A quoted ban is an instruction only when no reporting clause follows it.
  // “不写‘广告’是客户当时的要求” remains source material.
  return (/^不写[“「『"']/.test(firstClause) && /^不写(?:\s*(?:和|或|、)\s*)*$/.test(visible))
    || /^不写成(?:第一|第二|第三)人称(?:叙述|表达|口吻|文章|文案|故事|经历|客户见证)?$/.test(visible);
}

function isDirectRequirement(sentence: string): boolean {
  const visible = unquotedMaterialText(sentence);
  const editorialSubject = /文章|短文|文案|正文|标题|结尾|段落|笔记|语气|文风|字数|读者|写给|口播|公众号|小红书|视频号|原话|原句|引文|人称/.test(visible);
  return isExplicitWritingExclusion(sentence)
    || /^(?:目标读者|目标受众|写作要求|内容目标|商业目标|读者行动|结尾|希望读者|请读者|本期要求|作者要求|要求[：:]|篇幅|字数|语气|文风|写给|面向的读者)/.test(visible)
    || materialTitleAssignment(sentence) !== null
    || /^(?:我|我们)?(?:这次|本次|本期)?(?:想|希望|打算|要)写给/.test(visible)
    || /^(?:这篇(?:文章)?的?|本文的?|本期的?)?(?:读者|受众)(?:是|为|[：:])/.test(visible)
    || /^(?:这次|本次|本期)(?:请|要|就)?写(?:一篇|一条|一段|[0-9一二三四五六七八九十])/u.test(visible)
    || /^(?:我|我们)?希望读者/.test(visible)
    || /^(?:请|帮我|麻烦|希望|我想|我要)(?:写|改写|写成)(?:一(?:篇|条|段)|这(?:篇|条|段))/.test(visible)
    || (editorialSubject && /^(?:这次|本次|本期|本文).*(?:希望|想要|只想|打算|目标|不要|不得)/.test(visible))
    || (editorialSubject && /^(?:请|帮我|麻烦|希望|我想|我要|只)(?:把[^。！？\n]{0,100})?(?:写|整理|改写|改成|写成|做成|保留)/.test(visible))
    || /^(?:全文|正文|文章|标题|开头|收尾|摘要|篇幅|字数|语气|文风)(?:[：:]|控制|保持|要|不要|只|用|在|不超过|不低于)/.test(visible)
    || /^(?:请)?用(?:第一|第二|第三)人称(?:[，,；;：:]|写|叙述|表达|$)/.test(visible)
    || /^(?:请)?(?:用|采用|保持)[^。！？，,；;\n]{1,24}(?:语气|文风|口吻|表达方式)(?:来)?(?:写作?|表达|叙述)?(?:[，,；;：:]|$)/.test(visible)
    || SOURCE_LABEL_REQUIREMENT.test(visible)
    || /^不(?:编造|杜撰|补写)(?:效果|事实|数据|数字|客户|金额|成交|收入|收益|对白|对话|案例)/.test(visible)
    || /^(?:不要|不得|禁止|不能|不需要|不做|不加|不引导).*(?:编造|虚构|杜撰|补写|私信|购买|预约|咨询|销售|营销|获客|转化|引流|广告|CTA)/i.test(visible)
    || /^(?:不要|不得|禁止|不能)(?:使用|出现|加入|写成|写|用)?[“「『"']/.test(sentence)
    || (/^(?:不要|不得|禁止|不能)(?:使用|出现|加入|写成|写|用)/.test(visible)
      && (editorialSubject || /姓名|名字|隐私|联系方式|客户名|公司名|合同|报价|营收|数据|聊天记录|截图|病史|未经授权|未公开|保密|口号|套话|词语|形容词|说法|表达/.test(visible)))
    || /^(?:(?:这次|本次|本期)(?:只|仅)?|只|仅)(?:做|写|发|输出|制作)(?:公众号|小红书|视频号)(?:[，,；;：:]|$)/.test(visible)
    || /^(?:写|控制在)?(?:\d+(?:\.\d+)?|[一二三四五六七八九十百千两]+)(?:(?:至|到|[—–~～-])(?:\d+(?:\.\d+)?|[一二三四五六七八九十百千两]+))?字(?:[，,；;：:]|以内|左右|$)/.test(visible)
    || /^(?:我|我们)?(?:这次|本次|本期)?(?:想|希望|打算|要)(?:写|改写|整理|做成)[^。！？\n]*(?:文章|短文|文案|图文|口播稿|公众号|小红书|视频号)/.test(visible);
}

/** Only the author's current directions; reported customer requests stay source material. */
function editorialPart(value: string): { requirement: string; evidencePrefix?: string } | null {
  const sentence = normalizedSentence(value);
  if (isDirectRequirement(sentence)) return { requirement: sentence };
  const clauses = materialClauses(sentence);
  // A compound self-introduction can carry a writing purpose after a comma.
  // Do not search arbitrary customer stories or quotations for command words.
  if (!/^(?:我|我们)(?:是|经营|创办|从事|负责|有|在)/.test(clauses[0] || '')) return null;
  let offset = 0;
  for (const clause of clauses) {
    const start = sentence.indexOf(clause, offset);
    offset = start + clause.length;
    if (start === 0 || !/^(?:我|我们)?(?:这次|本次|本期)?(?:想|希望|打算|要)(?:写|改写|整理|做成)/.test(clause)) continue;
    const requirement = sentence.slice(start);
    if (isDirectRequirement(requirement)) return {
      requirement,
      evidencePrefix: sentence.slice(0, start).replace(/[，,；;]\s*$/, '').trim(),
    };
  }
  return null;
}

export function isMaterialWritingRequirement(value: string): boolean {
  return editorialPart(value) !== null;
}

/** Retain a self-introduction, without treating its attached writing purpose as fact. */
export function materialEvidencePrefix(value: string): string {
  const part = editorialPart(value);
  return part ? part.evidencePrefix || '' : value;
}

/** Extract explicit editorial requests, not business keywords or link content. */
export function materialWritingRequirements(text: string): string[] {
  const requirements = Array.from(new Set(materialSentences(text.split(/\r?\n/).map((line) => withoutLeadingMaterialUseNote(line.trim())).join('\n'))
    .flatMap((value) => {
      const part = editorialPart(value);
      // Split only after recognising an author direction. A quoted customer
      // instruction, decimal number, or comma inside an exact quote stays intact.
      return part ? requirementItems(part.requirement) : [];
    })));
  // Preserve the end of a compound request (often a prohibition) when the
  // editable list reaches its row limit, instead of silently dropping it.
  return (requirements.length > 12
    ? [...requirements.slice(0, 11), requirements.slice(11).join('，')]
    : requirements).map((value) => value.slice(0, 600));
}

export function materialAuthorAudience(requirements: readonly string[]): string | undefined {
  for (const requirement of requirements) {
    for (const clause of materialClauses(requirement)) {
      const visible = unquotedMaterialText(clause);
      if (/(?:^|[：:])\s*(?:不要|不应|不想|并非|不是)/.test(visible)) continue;
      const label = visible.match(/^(?:这篇(?:文章)?的?|本文的?|本期的?)?(?:目标读者|目标受众|读者|受众)(?:[：:]|是|为)\s*(.+)$/);
      const writingTo = visible.match(/(?:写给|讲给|分享给|面向(?:的读者)?(?:[：:]|是)?)(.+)$/)
        || (/(?:写|改写|整理|做成).*(?:文章|短文|文案|图文|口播稿|公众号|小红书|视频号)/.test(visible)
          ? visible.match(/(?:文章|短文|文案|图文|口播稿|公众号|小红书|视频号)给(.+)$/) : null);
      const match = label || writingTo;
      if (match?.[1]?.trim()) {
        const start = (match.index || 0) + match[0].length - match[1].length;
        return clause.slice(start).trim();
      }
    }
  }
  return undefined;
}

export function requestsSalesAction(requirements: readonly string[]): boolean {
  const clauses = requirements.flatMap((value) => value.split(/[；;，,]/));
  // An explicit exclusion is never turned into a positive keyword match. A
  // neutral structure also leaves room for a narrower, permitted reader action.
  if (requirements.some((value) => /(?:不要|不得|禁止|不需要|不做|不加|不引导)[^。！？\n]*(?:私信|购买|预约|咨询|销售|营销|获客|转化|引流|广告|CTA)/i.test(value))) return false;
  return clauses.some((value) => /(?:希望|请|想要|目标[：:是为]?|用于|引导|邀请)[^。！？\n]*(?:私信|购买|预约|咨询|下单|报名|获客|转化)/.test(value));
}
