const LEGACY_ANALYSIS_COPY: Array<[RegExp, string]> = [
  [/TikOmni\s+公开样本/gi, '平台数据中的参考内容'],
  [/TikOmni/gi, '平台数据'],
  [/对标增长顾问/g, '账号分析'],
  [/对标账号/g, '参考账号'],
  [/对标/g, '参考'],
  [/公开样本/g, '参考内容'],
  [/研究快照/g, '已保存的平台数据'],
  [/快照/g, '已保存的数据'],
  [/内容资产/g, '现有素材'],
  [/内容蓝图/g, '文章提纲'],
  [/蓝图/g, '文章提纲'],
  [/母稿/g, '公众号文章'],
  [/CTA/gi, '结尾引导'],
  [/机制蒸馏/g, '常用方法'],
  [/机制/g, '做法'],
  [/沉淀/g, '保存'],
  [/赋能/g, '帮助'],
  [/采集/g, '收集'],
  [/归档/g, '保存'],
  [/顾问/g, '分析'],
];

// Old local analyses remain readable without rewriting the stored records.
// Call this only for system-generated copy, never for source text or user notes.
export function advisorGeneratedDisplayText(value: string): string {
  return LEGACY_ANALYSIS_COPY
    .reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
    .replace(/([\u3400-\u9fff])[ \t]+(?=[\u3400-\u9fff])/g, '$1');
}

export function advisorGeneratedDisplayList(values: string[]): string[] {
  return values.map(advisorGeneratedDisplayText);
}
