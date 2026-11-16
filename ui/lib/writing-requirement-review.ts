import { publicationTextFromPackage } from './publication-text';

export type WritingRequirementFinding = { kind: 'length' | 'ending' | 'first-person' | 'banned-word' | 'unreadable'; message: string; quote?: string };
export type WritingRequirementReview = {
  requirements: string[]; applicable: boolean; characterCount: number | null; ending: string;
  range?: { min: number; max: number }; findings: WritingRequirementFinding[];
};

/** Only explicit requirements of this piece apply; this never certifies facts or authorship. */
export function inspectWritingRequirements(markdown: string, requirements: string[]): WritingRequirementReview {
  const report: WritingRequirementReview = { requirements, applicable: /^##\s+3\.\s*视频号原生口播\s*$/m.test(markdown), characterCount: null, ending: '', findings: [] };
  if (!report.applicable) return report;
  let spoken: string;
  try { spoken = publicationTextFromPackage(markdown, 'video-spoken'); }
  catch { report.findings.push({ kind: 'unreadable', message: '口播文字暂时无法完整识别，请先核对口播表格。' }); return report; }
  report.characterCount = Array.from(spoken.replace(/\s/g, '')).length;
  const sentences = spoken.match(/[^。！？?\n]+[。！？?]?/g)?.map((sentence) => sentence.trim()).filter(Boolean) ?? [];
  report.ending = sentences.at(-1) || '';
  const ranges = requirements.flatMap((requirement) => [...requirement.matchAll(/(?:口播|朗读)[^。；\n]{0,35}?(\d{1,5})\s*(?:至|到|[-–—~～])\s*(\d{1,5})\s*(?:个)?(?:非空白)?(?:字符|字)/g)]
    .map((match) => ({ min: Number(match[1]), max: Number(match[2]) })));
  if (ranges.length && ranges.every((range) => range.min === ranges[0].min && range.max === ranges[0].max) && ranges[0].min <= ranges[0].max) {
    report.range = ranges[0];
    if (report.characterCount < report.range.min || report.characterCount > report.range.max) {
      report.findings.push({ kind: 'length', message: `口播为 ${report.characterCount} 个非空白字符，本篇要求 ${report.range.min}–${report.range.max} 字。统计包含标点与数字，不计字幕和镜头。` });
    }
  }
  const asksQuestion = requirements.some((requirement) => /(?:结尾|最后)[^。；\n]{0,30}(?:问|问题|问句)/.test(requirement)
    && !/(?:不|避免|无需|禁止)[^。；\n]{0,8}(?:问|问题|问句)/.test(requirement));
  if (asksQuestion && (!/[？?]$/.test(report.ending) || (report.ending.match(/[？?]/g)?.length ?? 0) !== 1)) {
    report.findings.push({ kind: 'ending', message: '本篇要求以一个具体问题收尾，当前末句不是问句；问题是否具体仍需作者核对。', quote: report.ending });
  }
  const avoidFirstPerson = requirements.some((requirement) => /(?:不(?:用|使用|写成|要|写)|避免)[^。；\n]{0,16}第一人称/.test(requirement));
  if (avoidFirstPerson) for (const sentence of sentences) {
    if (/(?:我们|咱们|(?<![自忘无你他])我)(?!们)/.test(sentence)) report.findings.push({ kind: 'first-person', message: '本篇要求避免第一人称，这句含第一人称表达，请对照素材修改。', quote: sentence });
  }
  const banned = new Set(requirements.flatMap((requirement) => [...requirement.matchAll(/(?:不写|不用|禁用|避免使用)[\s：:]*[“"「『]([^”"」』]+)[”"」』]/g)]
    .flatMap((match) => match[1].split(/[、，,；;]+/).map((word) => word.trim()).filter(Boolean))));
  for (const word of banned) for (const sentence of sentences) {
    if (sentence.includes(word)) report.findings.push({ kind: 'banned-word', message: `口播含本篇明确禁用的“${word}”，请修改。`, quote: sentence });
  }
  return report;
}
