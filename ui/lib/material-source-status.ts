import { materialClauses, materialSentences, unquotedMaterialText } from './material-text';

// Shared with editorial requests so “保留虚构情景说明” and the source label
// describe the same class of material.
export const MATERIAL_SCENE_NOUN = '(?:情境|情景|场景|情节|故事|案例|例子|示例|素材|材料|体验|验收|练习|演练)';
const FICTIONAL_DECLARATION = new RegExp(`(?:虚构|模拟|假设)(?:的)?${MATERIAL_SCENE_NOUN}|(?:体验|测试|验收)(?:用|的)?模拟(?:(?:素材|材料)|(?=$|[，,；;。]))|(?:并非|不是|非)真实(?:客户|案例|经历|事件)`);
const FICTIONAL_HEADING = new RegExp(`^(?:虚构|模拟|假设)(?:的)?${MATERIAL_SCENE_NOUN}[：:]?$`);

export type MaterialReading = { id: string; label: string; text: string };
type SourceStatus = 'fictional' | 'unverified';
export type QualifiedMaterialSentence = {
  text: string;
  source: MaterialReading;
  status?: SourceStatus;
  declaration?: string;
};

function declaredStatus(value: string): SourceStatus | undefined {
  const visible = unquotedMaterialText(value);
  // A later “不要使用虚构数据” does not negate an earlier source label.
  const affirmative = materialClauses(visible).filter((clause) => !/(?:不是|并非|不要|不得|禁止|不能|不应)(?:任何|进行|使用)?(?:虚构|模拟|假设)/.test(clause));
  if (affirmative.some((clause) => FICTIONAL_DECLARATION.test(clause))) return 'fictional';
  if (/(?:待核实|待核验|尚未核实|尚未核验|未经核实|未经核验)/.test(visible)) return 'unverified';
}

/** Scope explicit source labels within one reading; never leak them to another file. */
export function qualifiedMaterialSentences(source: MaterialReading): QualifiedMaterialSentence[] {
  const result: QualifiedMaterialSentence[] = [];
  let status: SourceStatus | undefined;
  let declaration: string | undefined;
  for (const original of materialSentences(source.text)) {
    let text = original.trim();
    const heading = text.replace(/^#{1,6}\s+/, '');
    // Only an explicit section boundary ends a local example, not a random
    // assertion that something is true inside the story.
    if (/^(?:我的)?(?:真实经历|真实案例|已核实材料|已核验材料)[：:]?$/.test(heading)) {
      status = undefined; declaration = undefined; continue;
    }
    const marker = text.match(/^[【\[]([^】\]]+)[】\]]/);
    const markedStatus = marker && declaredStatus(marker[1]);
    const visible = unquotedMaterialText(heading);
    const isDeclaration = /^(?:以下|下面|本段|本节|本篇|全文|整份|这份|上述|这些|这是|此处|先举|举一个|以一个)/.test(visible)
      || FICTIONAL_HEADING.test(visible)
      || /^(?:待核实|待核验|尚未核实|尚未核验)(?:的)?(?:材料|信息|案例|线索)[：:]?$/.test(visible);
    const nextStatus = markedStatus || (isDeclaration ? declaredStatus(heading) : undefined);
    if (nextStatus) {
      status = nextStatus;
      const colon = visible.search(/[：:]/);
      const inlineDeclaration = !marker && colon >= 0 && declaredStatus(heading.slice(0, colon)) === nextStatus;
      declaration = marker ? marker[1] : inlineDeclaration ? heading.slice(0, colon) : heading;
      if (!marker && !inlineDeclaration) continue;
      text = marker ? text.slice(marker[0].length).trim() : heading.slice(colon + 1).trim();
      if (!text) continue;
    }
    const localHypothesis = /^(?:假设|假如|设想)(?:[，,：:]|我|我们|有|一个|客户|项目|团队)/.test(unquotedMaterialText(text));
    result.push({ text, source, status: localHypothesis ? 'fictional' : status,
      declaration: localHypothesis ? '本句以假设情境展开' : declaration });
  }
  return result;
}

export function materialQualificationLabel(sentence: QualifiedMaterialSentence): string {
  return `${sentence.status === 'fictional' ? '模拟或虚构情境' : '待核实描述'}（${sentence.source.label}）`;
}
