import { materialSentences, unquotedMaterialText, withoutLeadingMaterialUseNote } from './material-text';

const AUTHOR_WRITING_REQUEST = /(?:我(?:这次|本次|本期)?(?:想|打算|要)|(?:这次|本次|本期)(?:我)?(?:想|打算|要)?|请(?:帮我|为我)?|帮我|为我)写/;
const DIRECT_WRITING_REQUEST = /^(?:写给|写一(?:篇|条)|(?:(?:只|仅)(?:用|使用)(?:这些|上述|以上|本次|本期)材料[，,]\s*)?(?:请)?(?:按|按照)(?:这个|这一|上面(?:的)?|上述(?:的)?|以上(?:的)?)(?:题目|标题)(?:来)?写)/;
const AUTHOR_INTRODUCTION = /^我(?:们)?(?:是|在|经营|做|负责|从事|开了|开着)/;
const REPORTED_OR_EXAMPLE_CONTEXT = /原话|引用|转述|示例|例子|例如|比如|假设|如果|听说|据说|(?:客户|同事|朋友|受访者|嘉宾|对方|他|她|别人|有人|老板|用户)[^，,；;]*(?:说|提到|表示|告诉|留言|发来|回答|要求)/;

/** Read an assignment, not “标题用于…” or “标题请用什么…”. Context is checked by the caller. */
export function materialTitleAssignment(sentence: string): string | null {
  const prefix = /^(?:题目|标题)\s*(?:是|为|[：:]|(?:请|就|先)?(?:用|定为|设为|改为)(?=\s*(?:[：:]\s*)?[《“「"]))\s*[：:]?\s*/.exec(sentence);
  return prefix ? sentence.slice(prefix[0].length).trim() || null : null;
}

function authorWritingRequest(sentence: string) {
  let visible = unquotedMaterialText(sentence);
  const afterQuote = AUTHOR_WRITING_REQUEST.exec(visible);
  if (afterQuote && afterQuote.index > 0 && /[”」』"]\s*$/.test(sentence.slice(0, afterQuote.index))) {
    sentence = sentence.slice(afterQuote.index);
    visible = unquotedMaterialText(sentence);
  }
  const request = AUTHOR_WRITING_REQUEST.exec(visible);
  if (request?.index === 0) return { sentence, visible, requestLength: request[0].length };
  const direct = DIRECT_WRITING_REQUEST.exec(visible);
  if (direct) return { sentence, visible, requestLength: direct[0].length };

  // An author can introduce themselves before stating the request: “我经营…，想写…”.
  // Inherit that subject only across an explicit first-person introduction, never
  // from reported speech, a hypothetical example, or an arbitrary sentence prefix.
  if (!AUTHOR_INTRODUCTION.test(visible)) return null;
  for (const separator of visible.matchAll(/[，,；;]\s*/g)) {
    const start = separator.index + separator[0].length;
    if (REPORTED_OR_EXAMPLE_CONTEXT.test(visible.slice(0, start))) return null;
    const continuation = visible.slice(start);
    const explicit = AUTHOR_WRITING_REQUEST.exec(continuation);
    const continuedRequest = explicit?.index === 0 ? explicit : /^(?:想|打算|要|希望)写/.exec(continuation);
    if (continuedRequest) return { sentence: sentence.slice(start), visible: continuation, requestLength: continuedRequest[0].length };
  }
  return null;
}

/** Extract one explicit author title. Filling a form never confirms or generates content. */
export function materialTitleSuggestion(materialText: string): string | null {
  const titles = new Set<string>();
  let fence = '';
  let referenceSection = false;
  let authorRequestContext = false;
  let openingTitleBlock = true;
  const precedingTitles: string[] = [];
  const openQuotes: string[] = [];
  const quotePairs: Record<string, string> = { '“': '”', '「': '」', '『': '』', '"': '"' };

  for (const originalLine of materialText.split(/\r?\n/)) {
    const line = originalLine.trim();
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1][0];
      else if (fence === fenceMatch[1][0]) fence = '';
      continue;
    }
    if (fence || /^\s*>/.test(originalLine) || /^(?: {4}|\t)/.test(originalLine)) continue;

    // Do not offer titles from quoted examples, interviews, or reference sections.
    // Ambiguous pasted context is left for the author to enter manually.
    if (/^(?:#{1,6}\s*)?(?:参考|示例|例子|例如|举例|标题示例|客户(?:说|原话|留言)|访谈(?:原文|记录)|采访(?:原文|记录))[^。！？]*[：:]\s*$/.test(line)
      || /^(?:以下|下面|这是)[^。！？]*(?:引用|原话|示例|例子|参考|访谈)[^。！？]*[：:]\s*$/.test(line)
      || /^(?:客户|嘉宾|受访者|同事|朋友|他|她)[^。！？]*(?:说|提到|表示|留言|原话|发来|告诉|回答)[^。！？]*[：:]\s*$/.test(line)
      || /^#{1,6}\s*(?:参考|示例|例子|举例|客户原话|访谈|采访)/.test(line)) referenceSection = true;
    if (/^(?:#{1,6}\s*)?(?:我的创作要求|我的写作要求|本期写作要求|本次写作要求)[：:]?\s*$/.test(line)) referenceSection = false;

    const quoted = openQuotes.length > 0;
    for (const char of line) {
      if (char === openQuotes.at(-1)) openQuotes.pop();
      else if (quotePairs[char]) openQuotes.push(quotePairs[char]);
    }
    if (referenceSection || quoted) {
      authorRequestContext = false;
      openingTitleBlock = false;
      precedingTitles.length = 0;
      continue;
    }

    const authorLine = withoutLeadingMaterialUseNote(line);
    const values: string[] = [];
    // A title written as an opening field can precede the writing request.
    // Keep it tentative until an unquoted author request establishes intent.
    // Do not infer ownership for a title found later in an arbitrary story.
    const precedingTitle = openingTitleBlock ? materialTitleAssignment(authorLine) : null;
    if (precedingTitle) precedingTitles.push(precedingTitle);
    else if (authorLine) openingTitleBlock = false;
    const declaration = authorLine.match(/^(?:[-*]\s+)?(?:\*\*)?(?:已有|我的|本期|这期|我想写的)(题目|标题)(?:\*\*)?\s*(.+)$/);
    const declaredTitle = declaration ? materialTitleAssignment(declaration[1] + declaration[2]) : null;
    if (declaredTitle) values.push(declaredTitle);
    else for (const materialSentence of materialSentences(authorLine)) {
      const request = authorWritingRequest(materialSentence);
      if (!request) {
        // A separately stated title belongs to the author's preceding writing
        // request, never to a quoted story or a newly introduced reference.
        const separateTitle = materialTitleAssignment(materialSentence);
        if (authorRequestContext && separateTitle) values.push(separateTitle);
        else if (REPORTED_OR_EXAMPLE_CONTEXT.test(unquotedMaterialText(materialSentence))
          || /(?:读到|看到|参考|引文|原文)/.test(unquotedMaterialText(materialSentence))) authorRequestContext = false;
        continue;
      }
      authorRequestContext = true;
      values.push(...precedingTitles.splice(0));
      const { sentence, visible, requestLength } = request;
      // Find labels outside quotations, then use the same assignment grammar
      // as separate titles and the material's writing requirements.
      const named = Array.from(visible.matchAll(/(?:题目|标题)/g))
        .map((label) => materialTitleAssignment(sentence.slice(label.index)))
        .filter((value): value is string => value !== null);
      if (named.length) values.push(...named);
      else {
        const direct = sentence.slice(requestLength).match(/^\s*(《.+)$/);
        if (direct) values.push(direct[1]);
      }
    }
    for (const rawValue of values) {
      const value = rawValue.trim();
      if (/(?:不用|放弃|取消|废弃|不采用|别用|不要用)(?:这|此|原标题|题目|标题|了)/.test(value)) return null;
      const wrapped = value.match(/^(?:《([^《》]+)》|“([^“”]+)”|「([^「」]+)」|"([^"\n]+)")(?:[。；;，,\s]|$)/);
      const title = wrapped
        ? wrapped.slice(1).find(Boolean)?.trim()
        : /^[《“「"]/.test(value) ? undefined : value.replace(/[。；;].*$/, '').trim();
      // Match the title field's limit without silently truncating the author's words.
      if (!title || title.length > 240 || /[\u0000-\u001f\u007f]/.test(title)) return null;
      titles.add(title);
    }
  }

  return titles.size === 1 ? [...titles][0] : null;
}
