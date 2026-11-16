import { qualifiedMaterialSentences } from './material-source-status';
import { materialSentences, unquotedMaterialText } from './material-text';

export type MaterialSourceNature = {
  textAvailable: boolean;
  declarations: Array<'fictional' | 'unverified' | 'self_reported'>;
};

/** Describes declarations in the source, never verifies whether a claim is true. */
export function materialSourceNature(text?: string): MaterialSourceNature {
  if (!text?.trim()) return { textAvailable: false, declarations: [] };
  const qualified = qualifiedMaterialSentences({ id: 'library', label: '原文', text });
  const declarations = new Set<MaterialSourceNature['declarations'][number]>();
  for (const sentence of qualified) if (sentence.status) declarations.add(sentence.status);
  // A label can stand alone, before any extractable sentence. Read only explicit
  // labels/headings here; quoted examples, titles and classification are not evidence.
  for (const sentence of materialSentences(text)) {
    const visible = unquotedMaterialText(sentence).trim().replace(/^#{1,6}\s+/, '');
    const label = visible.match(/^[【\[]([^】\]]+)[】\]]/)?.[1]
      || visible.replace(/[：:]$/, '');
    if (/^(?:虚构|模拟|假设)(?:的)?(?:情境|情景|场景|故事|案例|示例|素材|练习|演练)$/.test(label)) declarations.add('fictional');
    if (/^(?:待核实|待核验|尚未核实|尚未核验)(?:的)?(?:材料|信息|案例|线索)?$/.test(label)) declarations.add('unverified');
    if (/^(?:我的)?真实(?:经历|案例)$/.test(label) || /^这是我的真实经历[：:，,]/.test(visible)) declarations.add('self_reported');
  }
  return { textAvailable: true, declarations: (['fictional', 'unverified', 'self_reported'] as const).filter((kind) => declarations.has(kind)) };
}

export function materialNatureLabels(nature?: MaterialSourceNature): string[] {
  if (!nature?.textAvailable) return ['尚未读取性质'];
  const labels = { fictional: '含虚构或模拟', unverified: '含待核实内容', self_reported: '原文称真实，未核验' };
  return nature.declarations.length ? nature.declarations.map((kind) => labels[kind]) : ['原文未明确标注性质'];
}
