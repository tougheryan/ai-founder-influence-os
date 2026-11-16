import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMaterialIntakeReport } from './material-intake-report';
import { createSourceBackedMaterialAnalysis, materialInputFingerprint, type MaterialAnalysisContext } from './material-analysis';

const context: MaterialAnalysisContext = {
  schema: 'aifios.material-analysis.v1',
  runId: 'run-a',
  createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:00.000Z',
  inputFingerprint: 'a'.repeat(64),
  analysisInputFingerprint: 'a'.repeat(64),
  analysisStatus: 'current',
  analysis_source: 'heuristic',
  input: {
    rawMaterial: '一次客户访谈发现，团队把内容当作发布任务，没有沉淀客户问题和服务流程。',
    files: [],
    links: [],
  },
  analysis: {
    summary: '已读取本期客户访谈观察，建议以内容获客流程展开。',
    facts: ['团队没有沉淀客户常问问题、真实案例和服务流程。'],
    cases: ['一次客户访谈中的业务观察。'],
    risks: [],
    recommendedTypeId: 'business-growth',
    recommendedStructureId: 'customer-solution-case-cta',
    sources: [{
      id: 'text:raw-material',
      kind: 'text',
      label: '粘贴文字',
      status: 'read',
      detail: '已读取粘贴的本期文字素材。',
    }],
  },
  selection: {
    materialTypeId: 'business-growth',
    structureId: 'customer-solution-case-cta',
  },
};

describe('buildMaterialIntakeReport', () => {
  it('carries the paid-user nonpublication limit into the verified author snapshot and invalidates it on change', async () => {
    const input = { rawMaterial: '【模拟验收材料，不是真实客户案例，不对外发布】我想写给服务型小团队负责人。客户说：“顺便加一页。”我的观点：客户说顺便改一下时，先记录具体改动，再确认对交付、工作量和时间的影响。我的方法：把原约定和新增要求写成两列，能在约定内完成就做，超出时给出可选方案，由双方确认后开始。这次写一篇700到1000字公众号文章，语气平实，不编造客户故事、收入和效果数据，不增加私信、购买或预约引导。结尾只提醒读者：先把这次改动写清楚。', files: [], links: [] };
    const analysis = await createSourceBackedMaterialAnalysis(input);
    const fingerprint = materialInputFingerprint(input);
    const reviewed = { ...context, runId: 'private-author', input, analysis, selection: null,
      inputFingerprint: fingerprint, analysisInputFingerprint: fingerprint };
    const report = buildMaterialIntakeReport(reviewed);
    const scripts = fileURLToPath(new URL('../../skills/content-runtime/scripts/', import.meta.url));
    const checked = spawnSync('python3', ['-c', [
      'import json,sys,tempfile,uuid',
      'sys.path.insert(0,sys.argv[1])',
      'from content_runtime import ContentRuntime',
      'from author_evidence import verified_record',
      'payload=json.load(sys.stdin)',
      'with tempfile.TemporaryDirectory(prefix="echo-private-author-") as project:',
      ' rt=ContentRuntime(project); rt.init()',
      ' run=rt.create_run(run_id="private-author",topic="客户临时改需求",platforms="公众号")',
      ' rt.write("intake",run["slug"],payload["report"],"restriction-contract",run["run_id"],require_valid=True)',
      ' path=rt.project/"sessions/material-analysis/private-author.json"',
      ' path.parent.mkdir(parents=True,exist_ok=True)',
      ' path.write_text(json.dumps(payload["context"],ensure_ascii=False))',
      ' source=rt.author_source_context(run["run_id"])',
      ' binding=rt.select_author_source({"run_id":run["run_id"],"id":"author_"+uuid.uuid4().hex,"topic":run["topic"],**{k:source[k] for k in ("intake_path","intake_sha256","material_sha256","source_revision")}})',
      ' state=rt.run_state(run_id=run["run_id"])',
      ' verified_record(rt.project,state)',
      ' frozen=json.loads((rt.project/binding["author_evidence_path"]).read_text())',
      ' assert frozen["material"]["analysis"]["risks"] == payload["context"]["analysis"]["risks"]',
      ' assert "不对外发布" in str(frozen["material"]["analysis"]["risks"])',
      ' assert frozen["material"]["analysis"]["illustrations"] == payload["context"]["analysis"]["illustrations"]',
      ' assert "模拟或虚构情境" in str(frozen["material"]["analysis"]["illustrations"])',
      ' examples=payload["context"]["analysis"]["illustrations"]',
      ' payload["context"]["analysis"]["illustrations"]=[]',
      ' path.write_text(json.dumps(payload["context"],ensure_ascii=False))',
      ' try: verified_record(rt.project,state)',
      ' except ValueError: pass',
      ' else: raise AssertionError("changed qualified examples accepted under old binding")',
      ' payload["context"]["analysis"]["illustrations"]=examples',
      ' payload["context"]["analysis"]["risks"]=[]',
      ' path.write_text(json.dumps(payload["context"],ensure_ascii=False))',
      ' try: verified_record(rt.project,state)',
      ' except ValueError: pass',
      ' else: raise AssertionError("removed restriction accepted under old binding")',
      ' print(json.dumps({"restrictions":frozen["material"]["analysis"]["risks"],"changed_restriction_rejected":True},ensure_ascii=False))',
    ].join('\n'), scripts], { input: JSON.stringify({ context: reviewed, report }), encoding: 'utf8', timeout: 30_000 });
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({ changed_restriction_rejected: true });
    expect(report).toContain('不对外发布');
    expect(report).toContain('继续写作不代表授权公开');
  });
  it('saves the real 330-character opinion-only input through the Python runtime quality gate', async () => {
    const rawMaterial = [
      '【产品体验用模拟素材，不是真实客户案例，不得对外当作经营成果】',
      '我经营一个三人的服务团队，没有专职编辑。这次只想把我处理需求变更的方法写给其他小团队负责人，做一篇公众号短文。',
      '我的观点：客户说“顺便改一下”时，不急着答应，也不要马上拒绝，先把改动写清楚。',
      '我的做法：记录这次修改影响哪项交付、增加多少工作、是否改变原定时间；能在原约定内完成就照做，超出时列明可选方案，请对方确认后再开始。没有实际核算时，不给出具体加价。',
      '我希望读者记住：把变化讲清楚，双方才能知道下一步做什么。',
      '要求：700到1000字，平实直接。不能编造客户对白、成交额、节省比例或成功案例。不要“赋能、闭环、破局”。结尾只写“下次遇到顺便改一下，先把改动写清楚”。不引导私信、购买或预约。',
    ].join('\n');
    const input = { rawMaterial, files: [], links: [] };
    const analysis = await createSourceBackedMaterialAnalysis(input);
    const report = buildMaterialIntakeReport({ ...context, input, analysis, selection: null });
    const scripts = fileURLToPath(new URL('../../skills/content-runtime/scripts/', import.meta.url));
    const checked = spawnSync('python3', ['-c', [
      'import json,sys,tempfile',
      'sys.path.insert(0,sys.argv[1])',
      'from content_runtime import ContentRuntime',
      'with tempfile.TemporaryDirectory(prefix="echo-intake-contract-") as project:',
      ' rt=ContentRuntime(project)',
      ' rt.init()',
      ' run=rt.create_run(run_id="opinion-only")',
      ' result=rt.write("intake",run["slug"],sys.stdin.read(),"contract-test",run["run_id"],require_valid=True)',
      ' print(json.dumps(result["validation"],ensure_ascii=False))',
    ].join('\n'), scripts], { input: report, encoding: 'utf8', timeout: 30_000 });
    expect(checked.status, checked.stderr).toBe(0);
    const validation = JSON.parse(checked.stdout);
    expect(validation.valid, JSON.stringify(validation)).toBe(true);
    expect(report).toContain('可以围绕作者提出的「我的观点：客户说');
    expect(report).toContain('700到1000字');
    expect(report).toContain('可继续写观点或方法');
    expect(report).toContain('未提供案例');
  });
  it('creates the complete intake quality boundary from the source-backed analysis', () => {
    const report = buildMaterialIntakeReport(context);

    expect(report).toContain('## 0. 素材场景');
    expect(report).toContain('## 0.1 内容策略画像');
    expect(report).toContain('## 9. 素材质量判断');
    expect(report).toContain('客户问题 -> 解决方案 -> 案例与 CTA');
    expect(report).toContain('证据位置');
    expect(report).toContain('处理建议');
    expect(report).toContain('可直接立项');
    expect(report).toContain('素材分类不证明经历或效果真实');
    expect(report).not.toContain('对内容生产低效的清醒感');
  });

  it('does not pretend a missing case is complete evidence', () => {
    const report = buildMaterialIntakeReport({
      ...context,
      analysis: { ...context.analysis, cases: [] },
    });

    expect(report).toContain('当前无可追溯核心案例');
    expect(report).toContain('需要补素材');
  });

  it('uses the system recommendation when no manual direction exists', () => {
    const report = buildMaterialIntakeReport({ ...context, selection: null });

    expect(report).toContain('素材理解报告 · 业务经验 / 产品与服务');
    expect(report).toContain('客户问题 -> 解决方案 -> 案例与 CTA');
  });

  it('preserves an opinion-only source instead of researching the generated summary', () => {
    const opinion = '我的观点：写内容之前，先收集客户反复问的问题';
    const report = buildMaterialIntakeReport({
      ...context,
      input: { ...context.input, rawMaterial: opinion },
      analysis: { ...context.analysis, facts: [], cases: [], opinions: [opinion] },
    });
    expect(report).toContain(`- 明确观点：${opinion}`);
    expect(report).toContain(`- 核心判断句：${opinion}`);
    expect(report).not.toContain(`- 核心判断句：${context.analysis.summary}`);
    expect(report).toContain('可继续写观点或方法');
    expect(report).not.toContain(`- 可用事实：${opinion}`);
  });

  it('preserves the author audience and closing request without inventing a sales funnel', () => {
    const report = buildMaterialIntakeReport({
      ...context,
      input: { ...context.input, rawMaterial: '目标读者是没有专职编辑的小团队负责人。结尾请读者回想最近被问得最多的问题。写作要求：语气直接，少用口号。' },
    });
    expect(report).toContain('- 主受众：没有专职编辑的小团队负责人');
    expect(report).toContain('- 转化路径：按作者原文执行：结尾请读者回想最近被问得最多的问题');
    expect(report).toContain('作者原文：写作要求：语气直接，少用口号');
    expect(report).not.toContain('进入低压力咨询或诊断');
    expect(buildMaterialIntakeReport(context)).toContain('本期尚未明确读者行动，待作者确认');
  });

  it('uses a natural writing audience and preserves the complete compound closing request', async () => {
    const requirement = '只做公众号，700至900字，平实一点，不引导私信或购买，结尾只保留一句行动建议';
    const input = { rawMaterial: `我经营一家设计工作室，想写一篇公众号文章给经常遇到临时加需求的小团队负责人。${requirement}。我想分享一个具体做法：记录变更再确认。`, files: [], links: [] };
    const analysis = await createSourceBackedMaterialAnalysis(input);
    const report = buildMaterialIntakeReport({ ...context, input, analysis, selection: null });
    expect(report).toContain('- 主受众：经常遇到临时加需求的小团队负责人');
    for (const clause of ['只做公众号', '700至900字', '平实一点', '不引导私信或购买', '结尾只保留一句行动建议']) expect(report).toContain(`作者原文：${clause}`);
    expect(report).toContain('按作者原文执行：结尾只保留一句行动建议');
    expect(report).toContain('我想分享一个具体做法：记录变更再确认');
    expect(report).not.toContain('- 主受众：系统建议，待作者确认：');
  });

  it('does not infer the audience from a quoted customer instruction or override a manually cleared requirement', async () => {
    const input = { rawMaterial: '客户说：“写给新来的经理。结尾引导购买。”', files: [], links: [] };
    const analysis = await createSourceBackedMaterialAnalysis(input);
    expect(buildMaterialIntakeReport({ ...context, input, analysis, selection: null })).not.toContain('- 主受众：新来的经理');
    const manual = { ...context, analysis_source: 'manual' as const, input: { ...input, rawMaterial: '写给新来的经理。' }, analysis: { ...analysis, authorRequirements: [] }, selection: null };
    expect(buildMaterialIntakeReport(manual)).not.toContain('- 主受众：新来的经理');
  });
});
