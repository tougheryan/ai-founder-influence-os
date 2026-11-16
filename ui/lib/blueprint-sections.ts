/** Prose edits are addressed inside one digest-bound blueprint, never metadata. */
export type BlueprintSection = { id: string; title: string; text: string; editable: boolean; start: number; end: number };
export type BlueprintSectionEdit = { id: string; text: string };
export type BlueprintScope = { scope_status: string; scope_matches: boolean; legacy_contract_validated?: boolean; issues: string[]; expected?: string[] };

export function canConfirmBlueprintScope(scope?: BlueprintScope): boolean {
  return scope?.scope_matches === true || (scope?.scope_status === 'legacy' && scope.legacy_contract_validated === true);
}

const protectedText = /(?:作者素材(?:快照| SHA-256)|写作依据：|TikOmni.*(?:快照|SHA)|研究快照|SHA-256|echo-writing-brief:|<!--|^---\s*$|^(?:run_id|source|step|slug|schema|approved_at):)/m;
const protectedHeading = /^##\s+(?:0[.．、]\s*|.*(?:上游约束|人工确认|确认记录))/m;

export function blueprintSections(raw: string): BlueprintSection[] {
  const frontmatter = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/)?.[0].length || 0;
  const headings: Array<{ start: number; title: string }> = [];
  let fence = ''; let comment = false;
  for (const match of raw.slice(frontmatter).matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0].replace(/\r?\n$/, '');
    if (!line && !match[0]) continue;
    if (comment) { if (line.includes('-->')) comment = false; continue; }
    if (line.includes('<!--')) { comment = !line.includes('-->'); continue; }
    if (fence) { if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = ''; continue; }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (opening) { fence = opening[1]; continue; }
    const heading = line.match(/^ {0,3}##[ \t]+(.+?)\s*$/);
    if (heading) headings.push({ start: frontmatter + match.index!, title: heading[1] });
  }
  const points = [{ start: frontmatter, title: '方案说明' }, ...headings.filter((h) => h.start > frontmatter)];
  return points.map((point, index) => {
    const end = points[index + 1]?.start ?? raw.length;
    const text = raw.slice(point.start, end);
    return { id: `section-${index}`, ...point, end, text, editable: /^ {0,3}##\s/.test(text) && !protectedText.test(text) && !protectedHeading.test(text) };
  }).filter((section) => section.text.trim());
}

export function applyBlueprintSectionEdits(raw: string, input: unknown): string {
  if (input === undefined) return raw;
  if (!Array.isArray(input) || input.length > 40) throw new Error('方案修改项目不正确。');
  const sections = blueprintSections(raw);
  const seen = new Set<string>();
  const patches = input.map((value) => {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || typeof value.text !== 'string') throw new Error('请提交章节文字。');
    const section = sections.find((item) => item.id === value.id);
    if (!section?.editable || seen.has(value.id)) throw new Error('只能修改可编辑的方案章节；来源和确认记录由系统保留。');
    seen.add(value.id);
    if (value.text.length > 60000 || protectedText.test(value.text) || protectedHeading.test(value.text)) throw new Error('方案文字不能包含来源摘要、任务身份或确认记录。');
    if (value.text.trim() && !/^ {0,3}##[ \t]+\S/.test(value.text)) throw new Error('请保留章节标题；移除章节时可清空该章节。');
    return { ...section, replacement: value.text.trim() ? value.text : '' };
  });
  return patches.sort((a, b) => b.start - a.start).reduce((text, patch) => {
    const tail = text.slice(patch.end);
    // Textarea edits need not retain the newline before the next chapter.
    const boundary = patch.replacement && tail && !patch.replacement.endsWith('\n')
      ? (raw.includes('\r\n') ? '\r\n\r\n' : '\n\n') : '';
    return text.slice(0, patch.start) + patch.replacement + boundary + tail;
  }, raw);
}
