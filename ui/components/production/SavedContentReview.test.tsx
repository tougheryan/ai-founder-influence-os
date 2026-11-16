import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SavedContentReview, WritingPlanComparisonDetails } from './SavedContentReview';

describe('viewing an article before re-confirming its plan', () => {
  it('offers reading and return navigation without any approval, generation or adoption controls', () => {
    const html = renderToStaticMarkup(<SavedContentReview runId="run-one" packagePath="pipeline/package/article.md" blueprintPath="pipeline/blueprint/current.md" requiredStageLabel="核对方案" onReturn={() => {}} />);
    expect(html).toContain('查看已有稿件');
    expect(html).toContain('返回待确认步骤');
    expect(html).toContain('对照这稿使用的方案与当前方案');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('重新生成');
    expect(html).not.toContain('采用修改');
    expect(html).not.toContain('修改内容');
  });
  it('labels only changed fields and distinguishes textual comparison from article compliance', () => {
    const brief = { audience: '小团队', point: '先记录', structure: '问题、做法', ending: '旧结尾' };
    const html = renderToStaticMarkup(<WritingPlanComparisonDetails comparison={{
      status: { status: 'outdated', package_path: '', blueprint_path: '', blueprint_sha256: '', reason: '方案已更新' },
      source: brief, current: { ...brief, ending: '新结尾' }, currentError: '', sourceError: '',
    }} />);
    expect(html.match(/有变化/g)).toHaveLength(1);
    expect(html.match(/文字相同/g)).toHaveLength(3);
    expect(html).toContain('旧结尾'); expect(html).toContain('新结尾');
    expect(html).toContain('仍需结合下方正文判断');
    expect(html).not.toContain('type="checkbox"');
  });
  it('does not label unknown old fields as changes or unchanged', () => {
    const html = renderToStaticMarkup(<WritingPlanComparisonDetails comparison={{
      status: { status: 'unknown', package_path: '', blueprint_path: '', blueprint_sha256: '', reason: '旧版本未核实' },
      source: null, current: { audience: '读者', point: '观点', structure: '结构', ending: '结尾' }, currentError: '', sourceError: '旧方案未核实',
    }} />);
    expect(html).toContain('版本未核实');
    expect(html).not.toContain('有变化'); expect(html).not.toContain('文字相同');
  });
});
