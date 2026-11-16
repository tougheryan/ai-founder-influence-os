const QUOTE_END: Readonly<Record<string, string>> = { '“': '”', '‘': '’', '「': '」', '『': '』', '《': '》', '"': '"', "'": "'" };

/** Keep quoted source text together, including a quotation spanning lines. */
function outsideQuotes(text: string): boolean[] {
  const ends: string[] = [];
  const characters = Array.from(text);
  let backslashes = 0;
  return characters.map((character, index) => {
    const quoted = ends.length > 0;
    const escaped = backslashes % 2;
    backslashes = character === '\\' ? backslashes + 1 : 0;
    if (escaped || (character === "'" && /[a-z0-9]/i.test(characters[index - 1] || '') && /[a-z0-9]/i.test(characters[index + 1] || ''))) return !quoted;
    if (ends.at(-1) === character) ends.pop();
    else if (QUOTE_END[character]) ends.push(QUOTE_END[character]);
    return !quoted && !QUOTE_END[character];
  });
}

export function unquotedMaterialText(text: string): string {
  const outside = outsideQuotes(text);
  return Array.from(text, (character, index) => outside[index] ? character : ' '.repeat(character.length)).join('');
}

function splitOutsideQuotes(text: string, separators: RegExp): string[] {
  const outside = outsideQuotes(text);
  const characters = Array.from(text);
  const parts: string[] = [];
  let part = '';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const numericComma = character === ',' && /\d/.test(characters[index - 1] || '') && /\d/.test(characters[index + 1] || '');
    if (outside[index] && separators.test(character) && !numericComma) {
      if (part.trim()) parts.push(part.trim());
      part = '';
    } else part += character;
  }
  if (part.trim()) parts.push(part.trim());
  return parts;
}

export function materialSentences(text: string): string[] {
  return splitOutsideQuotes(text, /[。！？!?\n]/);
}

export function materialClauses(text: string): string[] {
  return splitOutsideQuotes(text, /[，,；;]/);
}

export function withoutLeadingMaterialUseNote(line: string): string {
  const note = /^(?:【([^【】]+)】|\[([^\[\]]+)\])\s*/.exec(line);
  if (!note) return line;
  const clauses = (note[1] ?? note[2]).split(/[，,；;]/).map((part) => part.trim());
  // Ignore a narrowly identified usage note when reading author directions. Keep the
  // original material intact, including its disclosure and fictional boundaries.
  // Reference labels and quoted examples must never become author instructions.
  const exerciseForProduct = /^(?:虚构|模拟|假设)(?:练习|演练)$/.test(clauses[0])
    && clauses.length === 2 && /^仅用于产品(?:体验|测试)$/.test(clauses[1]);
  if (exerciseForProduct) return line.slice(note[0].length);
  if (!/^(?:付费体验(?:测试|模拟)|体验模拟|本(?:次|轮|期)(?:体验|测试)|内部体验|仅供内部(?:使用)?)$/.test(clauses[0])) return line;
  if (!clauses.slice(1).every((part) => /^(?:(?:以下|下面)(?:均|都)?(?:是|为)(?:模拟|虚构)(?:场景|素材|案例)|(?:非|不是|并非)真实(?:客户)?(?:经历|案例)|不对外(?:公开|发布))$/.test(part))) return line;
  return line.slice(note[0].length);
}
