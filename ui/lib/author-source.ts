import type { AuthorSourceBinding } from './runtime-writer';

export function authorSourceInstructions(source: AuthorSourceBinding): string {
  return [
    '# 本期已明确选择：按作者素材写作',
    `作者题目：${source.topic}`,
    `已选平台：${source.target_platforms.join('、')}`,
    '仅以当前作者素材、已确认写作要求和写作方案为依据。本期未进行平台研究，没有样本数量、热度排名或市场验证结论；不得编造这些信息，也不要求补做研究才能成稿。',
    '这一选择不豁免事实、授权和人工确认。素材不支持的事实或经历不要补造；缺项在方案中说明，发布正文不夹带这些工作说明。',
    '生成方案时保留共享事实与各已选平台的独立结构。上游立项与平台样本字段如需出现，明确写“本期未执行”；不得写成已通过研究。',
    '作者随后仍需核对受众、观点、结构和结尾，确认后才进入正文。作者题目与本期要求优先于外部风格示例。',
  ].join('\n');
}

/** Bind machine authority after generation, instead of asking an LLM to copy hashes. */
export function attachAuthorSourceBinding(body: string, source: AuthorSourceBinding): string {
  const clean = body.replace(/^- (?:写作依据|作者素材快照|作者素材 SHA-256)：[^\r\n]*\r?\n?/gm, '').trim();
  return `${clean}\n\n- 写作依据：作者素材（未进行平台研究）\n- 作者素材快照：${source.author_evidence_path}\n- 作者素材 SHA-256：${source.author_evidence_sha256}\n`;
}

export function sameAuthorSource(left?: AuthorSourceBinding, right?: AuthorSourceBinding): boolean {
  if (!left || !right) return left === right;
  return left.run_id === right.run_id && left.author_evidence_path === right.author_evidence_path
    && left.author_evidence_sha256 === right.author_evidence_sha256 && left.material_sha256 === right.material_sha256;
}
