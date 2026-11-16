export type WritingBrief = { audience: string; point: string; structure: string; ending: string };

/** Surface overlapping ending instructions; do not claim to infer semantic conflict. */
export function writingBriefEndingProposal(brief: WritingBrief): { previous: string[]; structure: string } | null {
  if (!brief.ending.trim()) return null;
  const previous: string[] = [];
  const reference = '结尾按下方“最后怎样收尾”执行';
  const pieces: string[] = [];
  const quoteEnds: string[] = [];
  const pairs: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"' };
  let start = 0;
  for (let index = 0; index < brief.structure.length; index += 1) {
    const char = brief.structure[index];
    if (quoteEnds.at(-1) === char) quoteEnds.pop();
    else if (pairs[char]) quoteEnds.push(pairs[char]);
    else if (!quoteEnds.length && /[；;。\n]/.test(char)) {
      pieces.push(brief.structure.slice(start, index + 1)); start = index + 1;
    }
  }
  // An unfinished quote is ambiguous: leave the text for the author to edit.
  if (quoteEnds.length) return null;
  pieces.push(brief.structure.slice(start));
  const structure = pieces.map((piece) => {
    const separator = /[；;。\n]$/.test(piece) ? piece.slice(-1) : '';
    const clause = separator ? piece.slice(0, -1) : piece;
    const prefix = clause.match(/^([ \t]*)(?:结尾|收尾|最后一段)/);
    if (!prefix || clause.trim() === reference) return piece;
    previous.push(clause.trim());
    return `${prefix[1]}${reference}${separator}`;
  }).join('');
  return previous.length ? { previous, structure } : null;
}
export const WRITING_BRIEF_FIELDS = [
  { key: 'audience', label: '写给谁', rows: 2 },
  { key: 'point', label: '想让读者记住什么', rows: 3 },
  { key: 'structure', label: '准备怎样展开', rows: 5 },
  { key: 'ending', label: '最后怎样收尾', rows: 3 },
] as const;
const storedBrief = /<!-- echo-writing-brief:start -->\s*## 我的写作方案\s*```json\s*([\s\S]*?)\s*```\s*<!-- echo-writing-brief:end -->/;

export function validateWritingBrief(value: unknown): WritingBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请填写写作方案。');
  const brief = value as Record<string, unknown>;
  return Object.fromEntries(WRITING_BRIEF_FIELDS.map(({ key, label }) => {
    const text = brief[key];
    if (typeof text !== 'string' || !text.trim() || text.length > 6000) throw new Error(`${label}需要填写，且不能超过 6000 字。`);
    if (text.includes('echo-writing-brief:') || text.includes('```')) throw new Error(`${label}请使用普通文字填写。`);
    return [key, text.trim()];
  })) as WritingBrief;
}

export function writingBriefFromBlueprint(body: string): WritingBrief {
  const stored = body.match(storedBrief);
  if (stored) return validateWritingBrief(JSON.parse(stored[1]));
  const lineValue = (labels: string[]) => body.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*-\s*([^：:]+)[：:]\s*(.*)$/);
    return match && labels.some((label) => match[1].includes(label)) ? [match[2].trim()] : [];
  }).join('\n\n');
  const structure = lineValue(['准备怎样展开']) || lineValue(['长文结构', '卡片结构', '口播结构', '内容结构', '叙事结构']);
  const ending = lineValue(['最后怎样收尾']) || lineValue(['排版、评论和商业收口', '评论和商业收口', '结尾', '收尾', '商业收口']);
  return {
    audience: lineValue(['写给谁']) || lineValue(['目标受众']),
    point: lineValue(['想让读者记住什么']) || lineValue(['核心观点', '核心判断']),
    structure,
    ending: ending || structure.match(/结尾[^。\n]*(?:。|$)/)?.[0] || '',
  };
}

export function applyWritingBrief(body: string, value: WritingBrief): string {
  const brief = validateWritingBrief(value);
  const block = `<!-- echo-writing-brief:start -->\n## 我的写作方案\n\n\`\`\`json\n${JSON.stringify(brief, null, 2)}\n\`\`\`\n<!-- echo-writing-brief:end -->`;
  const content = body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, '').trim();
  return storedBrief.test(content) ? content.replace(storedBrief, block) : `${block}\n\n${content}`;
}

export function confirmedWritingBriefContext(body: string): string {
  if (!storedBrief.test(body)) return '';
  const brief = writingBriefFromBlueprint(body);
  return ['# 作者核对后的写作方案', '以下四项优先于蓝图中的初始建议。结尾以“最后怎样收尾”为准，替代结构中的旧收尾建议。仍须遵守原素材的事实、授权与隐私边界；不要把方案说明或禁写要求当成读者正文。', ...WRITING_BRIEF_FIELDS.map(({ key, label }) => `${label}：${brief[key]}`)].join('\n\n');
}
