// Pure contract shared by the workbench and the desktop publication boundary.
// This recognises explicit whole-draft limits, not arbitrary natural language
// or permission to publish. Detail-specific limits still require human review.
const LIMIT = "(?:(?:不|暂不|不得|禁止|不可|不要|不能)(?:对外)?(?:公开|发布|分享|展示|外传|转载|披露)|(?:仅供|仅限|仅用于|仅作|仅|只供|只限|只用于|只在)内部(?:使用|预览|讨论|传阅|测试|验收|参考)?)";
const WHOLE = "(?:本期(?:内容|稿件|文章)?|本文|本篇(?:文章|内容)?|整篇(?:文章|内容|稿件)?|整份(?:内容|材料|素材)?|全文|本次(?:内容|文章|稿件)|这篇(?:文章|内容|稿件)|这期(?:内容|文章)|这些?内容|全部内容)";
const WHOLE_LIMIT = new RegExp(`^(?:${WHOLE}(?:暂时|当前|先|目前|都)?(?:：|:)?\\s*)?${LIMIT}(?:使用|传播)?$`);
const EXPLICIT_WHOLE_LIMIT = new RegExp(`^${WHOLE}`);
const DETAIL_SUBJECT = /姓名|名字|电话|联系方式|聊天记录|报价|合同|参考|附件|这一段|这段|片段/;

function internalOnlyRestrictions(entries) {
  return [...new Set((Array.isArray(entries) ? entries : []).filter((entry) => {
    if (typeof entry !== "string") return false;
    const value = entry.replace(/^\s*(?:[-*]\s*)?(?:公开边界|使用边界|来源与边界)[：:]\s*/, "");
    return value.split(/[\n。！？!?【】\[\]]/).some((sentence) => {
      const clauses = sentence.split(/[，,；;]/).map((clause) => clause.trim());
      return clauses.some((clause, index) => WHOLE_LIMIT.test(clause)
        && (EXPLICIT_WHOLE_LIMIT.test(clause) || index === 0 || !DETAIL_SUBJECT.test(clauses[index - 1])));
    });
  }))];
}

function intakeDisclosureEntries(body) {
  // Never classify the report's explanatory prose (which quotes restrictions
  // as examples) or facts and third-party reference excerpts as author limits.
  const section = String(body).match(/^## 7\. 不可公开信息\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1] || "";
  return section.split(/\r?\n/).filter((line) => /^\s*-\s*公开边界[：:]/.test(line));
}

// Recognise complete, narrow writing instructions only. A recognised phrase
// inside a longer unknown or restricted entry never clears that entry.
const WRITING_ITEM = "(?:作者身份|个人经历|亲身经历|具体行业案例|行业案例|具体案例|案例|量化数据|数据|数字|收入|引用|事实)";
const WRITING_ITEMS = `${WRITING_ITEM}(?:\\s*[、和与及或]\\s*${WRITING_ITEM})*`;
const WRITING_CLAUSES = [
  /^(?:以上|这些内容|本段内容)(?:为|属于)作者(?:的)?(?:观察|判断|观点)(?:[、和与及](?:观察|判断|观点))*$/,
  new RegExp(`^(?:尚未|暂未|未)(?:提供|给出)${WRITING_ITEMS}$`),
  /^(?:请)?(?:区分|分清)(?:作者)?观点[和与](?:待核验|已核验)?事实$/,
  new RegExp(`^(?:请)?(?:不要|不得|不能|禁止)(?:编造|虚构|杜撰)${WRITING_ITEMS}$`),
  /^(?:未经|未)(?:核验|核实|证实)的(?:数据|数字|观点|判断|案例)(?:不可|不能|不得)(?:作为|写成|当作)事实$/,
];
const EXPLICIT_PUBLICATION_LIMIT = new RegExp(
  `${LIMIT}|(?:需要|需|须|必须|应当)(?:先)?(?:取得|获得|征得)(?:[^，。；;\\n]{0,20})?(?:授权|同意)|(?:授权|同意)后(?:才|方)(?:可|能)|(?:请|需要|须|必须)(?:先)?(?:隐去|隐藏|匿名化|脱敏)|(?:涉及|包含|含有)(?:[^，。；;\\n]{0,20})?(?:隐私|机密|保密信息)`
);

function classifyDisclosureEntries(entries) {
  const writingRequirements = [];
  const restrictions = [];
  const unresolved = [];
  for (const entry of [...new Set(entries.map((value) => value
    .replace(/^\s*(?:[-*]\s*)?(?:公开边界|使用边界|来源与边界)[：:]\s*/, "").trim()).filter(Boolean))]) {
    if (internalOnlyRestrictions([entry]).length || EXPLICIT_PUBLICATION_LIMIT.test(entry)) {
      // Keep the whole original entry, including conditions and mixed clauses.
      restrictions.push(entry);
      continue;
    }
    const clauses = entry.split(/[，,。！？!?；;\n]/).map((part) => part.trim()).filter(Boolean);
    if (clauses.length && clauses.every((clause) => WRITING_CLAUSES.some((pattern) => pattern.test(clause)))) {
      writingRequirements.push(entry);
    } else {
      unresolved.push(entry);
    }
  }
  return { writingRequirements, restrictions, unresolved };
}

const INTERNAL_ONLY_MESSAGE = "本期注明仅供内部使用，不能填入外部平台草稿。可以继续写作、预览和下载；用途变化时，请先修改素材中的公开限制，再重新核对后续内容。";
module.exports = { internalOnlyRestrictions, intakeDisclosureEntries, classifyDisclosureEntries, INTERNAL_ONLY_MESSAGE };
