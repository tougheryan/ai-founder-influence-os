import { describe, expect, it } from 'vitest';
import { materialNatureLabels, materialSourceNature } from './material-source-nature';

describe('source declarations, independent of category', () => {
  it('retains fictional and unverified sections without claiming the whole source is verified', () => {
    const text = '【付费体验模拟，非真实客户经历】\n一位顾问给客户报价。\n待核实材料：\n可能有三次修改。\n真实经历：\n作者说自己参加过访谈。';
    expect(materialSourceNature(text)).toEqual({ textAvailable: true, declarations: ['fictional', 'unverified', 'self_reported'] });
    expect(materialNatureLabels(materialSourceNature(text))).toEqual(['含虚构或模拟', '含待核实内容', '原文称真实，未核验']);
  });

  it.each(['不要使用虚构案例。不编造数字。', '客户说：“以下是虚构练习：试试另一种报价。”', '题目：虚构案例为什么有说服力。', '这不是虚构案例。'])('does not treat an instruction, quote, title or negation as a declaration: %s', (text) => {
    expect(materialSourceNature(text).declarations).toEqual([]);
  });

  it('distinguishes unread text from text whose nature has not been declared', () => {
    expect(materialNatureLabels(materialSourceNature())).toEqual(['尚未读取性质']);
    expect(materialNatureLabels(materialSourceNature('某客户增加了一次修改。'))).toEqual(['原文未明确标注性质']);
    expect(materialNatureLabels(materialSourceNature('【真实经历】'))).toEqual(['原文称真实，未核验']);
    expect(materialNatureLabels(materialSourceNature('【虚构示例】'))).toEqual(['含虚构或模拟']);
  });
});
