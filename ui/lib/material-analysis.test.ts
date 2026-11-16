import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMaterialInputFingerprint } from './material-input-fingerprint';
import { buildMaterialIntakeReport } from './material-intake-report';
import { qualifiedMaterialSentences } from './material-source-status';

const mocks = vi.hoisted(() => ({
  projectDir: `/tmp/aifios-material-analysis-${process.pid}`,
  runs: [
    { run_id: 'run-a', slug: 'run-a', status: 'active' },
    { run_id: 'run-b', slug: 'run-b', status: 'active' },
  ] as Array<{ run_id: string; slug: string; status: string }>,
}));

vi.mock('./project-root', async () => {
  const pathModule = await import('node:path');
  return {
    PROJECT_DIR: mocks.projectDir,
    safeResolve: (base: string, relativePath: string) => {
      const normalizedBase = pathModule.resolve(base);
      const resolved = pathModule.resolve(normalizedBase, relativePath);
      return resolved === normalizedBase || resolved.startsWith(`${normalizedBase}${pathModule.sep}`)
        ? resolved
        : null;
    },
  };
});

vi.mock('./runtime-run-resolver', () => ({
  listRuntimeRuns: async () => mocks.runs,
}));

import {
  clearMaterialAnalysisContext,
  assertMaterialReadyForResearch,
  createSourceBackedMaterialAnalysis,
  getMaterialAnalysisContext,
  getMaterialWritingRequirements,
  getMaterialReadiness,
  MaterialAnalysisInputError,
  MaterialAnalysisStaleError,
  MaterialReadinessError,
  assertMaterialAnalysisCurrent,
  extractInspirationPageContent,
  resolveInspirationLinks,
  isMaterialAnalysisCurrent,
  materialInputFingerprint,
  returnPinnedLookupAddress,
  saveMaterialAnalysisContext,
  toMaterialAnalysisPromptContext,
} from './material-analysis';

describe('per-run material analysis context', () => {
  it('carries standalone wording and impersonation bans into the writing context, never facts', async () => {
    const input = {
      rawMaterial: '客户增加了一次修改。\n不写“赋能、闭环、颠覆、降本增效”；不编造客户、收入、节省时间、行业统计或引语；保留“本地测试、手写虚构验收稿”的事实边界。\n不写成第一人称客户见证，不替作者宣称亲身经历。',
      files: [], links: [],
    };
    const analysis = await createSourceBackedMaterialAnalysis(input);
    const context = await saveMaterialAnalysisContext('run-a', { ...input, analysis, analysisSource: 'heuristic' });
    const prompt = toMaterialAnalysisPromptContext(context);
    for (const request of ['不写“赋能、闭环、颠覆、降本增效”', '不编造客户、收入、节省时间、行业统计或引语', '保留“本地测试、手写虚构验收稿”的事实边界', '不写成第一人称客户见证，不替作者宣称亲身经历']) {
      expect(getMaterialWritingRequirements(context)).toContain(request);
      expect(prompt).toContain(`- 作者要求：${request}`);
      expect(buildMaterialIntakeReport(context)).toContain(request);
    }
    expect(analysis.facts).toEqual(['客户增加了一次修改']);
    expect(analysis.cases.join('\n')).not.toContain('不写成第一人称');
  });

  it('keeps source qualifiers and disclosure while excluding a reused assignment from a new topic', async () => {
    const original = '【付费体验模拟，非真实客户经历】\n题目：客户问为什么这么贵。\n以下是虚构练习：一位为小团队做品牌咨询的顾问，遇到客户拿另一家更低的报价来比较。\n写给独立顾问，公众号，800字以内，语气平实。不引导私信。结尾给一段回复客户的话。\n原始访谈仅供内部使用，不对外发布。';
    await mkdir(path.join(mocks.projectDir, 'materials/library/reuse'), { recursive: true });
    const filePath = 'materials/library/reuse/source.md';
    await writeFile(path.join(mocks.projectDir, filePath), `# 原素材\n> 来源：访谈记录\n> 原始链接：https://example.test/source\n> 素材保存时间：2026-10-05\n\n## 原文\n\n${original}`);
    const file = { name: '原素材.md', path: filePath, sourcePath: filePath, writingRequirements: 'reference_only' as const };
    const input = { rawMaterial: '题目：怎样确认新增需求', files: [file], links: [] };
    const analysis = await createSourceBackedMaterialAnalysis(input);
    expect(analysis.authorRequirements?.join('\n')).toContain('怎样确认新增需求');
    expect(analysis.authorRequirements?.join('\n')).not.toMatch(/800字|回复客户|语气平实|为什么这么贵/);
    expect(analysis.facts).toEqual([]);
    expect(analysis.cases).toEqual([]);
    expect(analysis.illustrations?.join('\n')).toContain('客户拿另一家更低的报价');
    expect(analysis.risks.join('\n')).toMatch(/仅供内部使用/);
    await saveMaterialAnalysisContext('run-a', { ...input, analysis, analysisSource: 'heuristic' });
    const readBack = (await getMaterialAnalysisContext('run-a'))!;
    expect(readBack.input.files[0].writingRequirements).toBe('reference_only');
    expect(getMaterialWritingRequirements(readBack).join('\n')).not.toMatch(/800字|回复客户|语气平实|为什么这么贵/);
    expect(toMaterialAnalysisPromptContext(readBack)).toContain('原文中的旧题目');
    expect(buildMaterialIntakeReport(readBack)).toContain('另写新题目');
    expect(buildMaterialIntakeReport(readBack)).toContain('仅供内部使用');
    const originalFile = { name: file.name, path: file.path, sourcePath: file.sourcePath };
    const same = await createSourceBackedMaterialAnalysis({ rawMaterial: '', files: [originalFile], links: [] });
    expect(same.authorRequirements?.join('\n')).toMatch(/800字/);
    expect(same.authorRequirements?.join('\n')).toMatch(/回复客户/);
    expect(materialInputFingerprint(input)).not.toBe(materialInputFingerprint({ ...input, files: [originalFile] }));
    expect(await createMaterialInputFingerprint(input)).toBe(materialInputFingerprint(input));
    expect(await readFile(path.join(mocks.projectDir, filePath), 'utf8')).toContain(original);
  });

  it('keeps a paid-use simulation label out of facts and preserves the submitted instructions', async () => {
    const rawMaterial = '【付费体验模拟，非真实客户经历】\n题目：报价之后，客户问“为什么这么贵”，怎么回答。\n以下是虚构练习：一位为小团队做品牌咨询的顾问，遇到客户拿另一家更低的报价来比较。他没有马上降价，而是把访谈次数、交付文件和修改次数列出来。这里没有成交结果，也没有增长数据。\n写给独立顾问，公众号，800字以内，语气平实。不要把模拟写成亲身案例，不编造数字，不引导私信。结尾给一段可以直接回复客户的话。只用这些材料，按这个题目写。';
    await saveMaterialAnalysisContext('run-a', { rawMaterial });
    const restored = (await getMaterialAnalysisContext('run-a'))!;
    expect(restored.input.rawMaterial).toBe(rawMaterial);
    expect(restored.analysis.facts).toEqual([]);
    expect(restored.analysis.cases).toEqual([]);
    expect(restored.analysis.illustrations).toHaveLength(3);
    expect(restored.analysis.illustrations?.join('\n')).toContain('模拟或虚构情境');
    for (const text of ['800字以内', '不编造数字', '不引导私信', '结尾给一段可以直接回复客户的话']) {
      expect(restored.analysis.authorRequirements).toContain(text);
      expect(toMaterialAnalysisPromptContext(restored)).toContain(text);
      expect(buildMaterialIntakeReport(restored)).toContain(text);
    }
  });
  it.each(['付费体验模拟，非真实客户经历', '体验模拟', '并非真实案例', '非真实客户经历'])('retains the nature of %s without turning the label into content', (label) => {
    const result = qualifiedMaterialSentences({ id: 'one', label: '笔记', text: `【${label}】\n客户增加一页。\n真实经历：\n我完成了原定交付。` });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ text: '客户增加一页', status: 'fictional', declaration: label });
    expect(result[1]).toMatchObject({ text: '我完成了原定交付', status: undefined });
  });
  it('preserves the current paid-user scenario and all directions through saved intake', async () => {
    const rawMaterial = '【虚构情景，仅供产品体验，不能冒充我的亲身经历】一位独立顾问原定周五交付方案，客户临时要求加两页内容。他把新增内容、原定交付时间和可调整范围写进一张清单，请客户选择减少其他内容，或者另约交付时间。没有成交、收入或效果数据。\n\n请写一篇公众号文章，600字左右，写给第一次独立接项目的顾问。标题请用《客户临时加需求，怎么把话说清楚》。语气像给朋友讲一件事，不用“赋能”“闭环”，不引导私信。保留虚构情景说明，结尾给一句能直接回复客户的话。';
    await saveMaterialAnalysisContext('run-a', { rawMaterial });
    const restored = (await getMaterialAnalysisContext('run-a'))!;
    expect(restored.input.rawMaterial).toBe(rawMaterial);
    expect(restored.analysis.facts).toEqual([]);
    expect(restored.analysis.cases).toEqual([]);
    expect(restored.analysis.illustrations).toHaveLength(3);
    expect(restored.analysis.illustrations?.join('\n')).toContain('模拟或虚构情境（粘贴文字）：他把新增内容');
    expect(restored.analysis.illustrations?.join('\n')).not.toMatch(/标题请用|结尾给|保留虚构/);
    for (const direction of ['600字左右', '写给第一次独立接项目的顾问', '标题请用《客户临时加需求，怎么把话说清楚》', '语气像给朋友讲一件事，不用“赋能”“闭环”', '不引导私信', '保留虚构情景说明', '结尾给一句能直接回复客户的话']) {
      expect(restored.analysis.authorRequirements).toContain(direction);
      expect(toMaterialAnalysisPromptContext(restored)).toContain(direction);
      expect(buildMaterialIntakeReport(restored)).toContain(direction);
    }
    expect(restored.analysis.recommendedStructureId).toBe('customer-question-method');
  });

  it.each(['虚构情景', '模拟情景', '假设场景', '虚构故事', '模拟示例'])('keeps a declared %s local to its source and stops at a real section', async (label) => {
    const rawMaterial = `【${label}，请勿把它当作亲身经历】客户追加两页方案。原来计划周五交付。\n真实经历：\n我已经完成一个客户项目。\n请写一篇文章。保留${label}说明，结尾给一句回复的话。`;
    const result = await createSourceBackedMaterialAnalysis({ rawMaterial, files: [], links: [] });
    expect(result.facts).toContain('我已经完成一个客户项目');
    expect(result.facts.join('\n')).not.toContain('客户追加两页方案');
    expect(result.illustrations).toContain('模拟或虚构情境（粘贴文字）：客户追加两页方案');
    expect(result.authorRequirements).toContain(`保留${label}说明`);
    expect(result.authorRequirements).toContain('结尾给一句回复的话');
  });

  it('retains text after a source declaration and does not cancel that declaration with a later prohibition', () => {
    const read = (text: string) => qualifiedMaterialSentences({ id: 'one', label: '笔记', text });
    const result = read('以下是虚构情景：客户追加两页方案。原来计划周五交付。');
    expect(result.map((item) => item.text)).toEqual(['客户追加两页方案', '原来计划周五交付']);
    expect(result.every((item) => item.status === 'fictional')).toBe(true);
    expect(read('【虚构情景，不要使用虚构数据】客户追加两页方案。')[0].status).toBe('fictional');
    for (const prefix of ['这不是虚构情景。', '不要使用虚构情景。', '客户说：“以下是虚构情景。”']) {
      expect(read(prefix + '我已经完成客户项目。').every((item) => !item.status)).toBe(true);
    }
  });

  it('understands the paid-user signup-page material and preserves its qualifications throughout the saved intake', async () => {
    const input = { files: [], links: [], rawMaterial: [
      '以下是虚构的体验素材，不是真实客户案例。',
      '我经营一家三人设计工作室。上周交付页面初稿后，客户发来一句：“顺便帮我再做一页活动报名页吧，应该很快。”我没有马上答应。',
      '我先请他补充这页的用途、上线时间和需要收集的信息，再说明这不在原先约定的页面范围内，需要另行确认安排。客户还没回复，目前没有成交结果。',
      '我的观点：遇到追加需求，先把范围和安排说清楚，比带着情绪拒绝更有用。',
      '我想写一篇公众号文章，题目是《客户说“顺便加一页”时，我先确认三件事》。读者是经常接项目的小团队负责人。',
      '请保留客户的那句原话，写600到800字，用第一人称，口语一点，不要写“赋能”“闭环”，不要编造客户评价、收入或合作结果。结尾只留一句可执行建议，不引导关注、评论或私信。',
    ].join('\n') };
    const result = await createSourceBackedMaterialAnalysis(input);
    expect(result.recommendedTypeId).toBe('business-growth');
    expect(result.recommendedStructureId).toBe('customer-question-method');
    expect(result.summary).not.toMatch(/访谈|演讲|现场片段/);
    expect(result.facts).toEqual([]);
    expect(result.cases).toEqual([]);
    expect(result.illustrations?.join('\n')).toContain('“顺便帮我再做一页活动报名页吧，应该很快。”');
    expect(result.illustrations?.join('\n')).toContain('客户还没回复，目前没有成交结果');
    expect(result.illustrations?.join('\n')).not.toContain('读者是');
    expect(result.authorRequirements).toEqual(expect.arrayContaining(['读者是经常接项目的小团队负责人', '写600到800字', '用第一人称', '不要编造客户评价、收入或合作结果']));
    await saveMaterialAnalysisContext('run-a', { ...input, analysis: result });
    const reopened = (await getMaterialAnalysisContext('run-a'))!;
    expect(reopened.analysis.illustrations).toEqual(result.illustrations);
    for (const downstream of [buildMaterialIntakeReport(reopened), toMaterialAnalysisPromptContext(reopened)]) {
      expect(downstream).toContain('模拟或虚构情境（粘贴文字）');
      expect(downstream).toContain('顺便帮我再做一页活动报名页吧');
      expect(downstream).toContain('经常接项目的小团队负责人');
      expect(downstream).toContain('写600到800字');
    }
    expect(buildMaterialIntakeReport(reopened)).toContain('- 主受众：经常接项目的小团队负责人');
  });

  it.each([
    ['客户要求新增活动页，项目需要重新确认交付范围。', 'business-growth'],
    ['客户现场与我对话，讨论报价和服务范围。', 'business-growth'],
    ['这是一份访谈逐字稿，嘉宾在圆桌上分享了工作经验。', 'interview-event'],
    ['我的观点：客户需要先说明产品需求。不要写成访谈或演讲。', 'business-growth'],
  ])('classifies the actual subject, not a generic event word: %s', async (rawMaterial, type) => {
    const result = await createSourceBackedMaterialAnalysis({ rawMaterial, files: [{ name: '演讲嘉宾访谈.txt' }], links: [] });
    expect(result.recommendedTypeId).toBe(type);
  });

  it('keeps fictional and unverified source scopes separate from another file and author directions', async () => {
    const file = path.join(mocks.projectDir, 'materials/intake/real.txt');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '我负责一个客户项目，已经完成首页交付。');
    const result = await createSourceBackedMaterialAnalysis({ rawMaterial: '以下是虚构情境。客户临时追加了报名页。用第一人称写。',
      files: [{ name: '亲历笔记.txt', path: 'materials/intake/real.txt', extractionStatus: 'text_extracted' }],
      links: [{ url: 'https://example.com/source', title: '外部参考', status: 'parsed', excerpt: '以下是待核实信息。项目成本增加了30%。' }] });
    expect(result.facts).toContain('我负责一个客户项目，已经完成首页交付');
    expect(result.facts.join('\n')).not.toMatch(/报名页|30%/);
    expect(result.illustrations).toEqual(expect.arrayContaining([
      '模拟或虚构情境（粘贴文字）：客户临时追加了报名页', '待核实描述（外部参考）：项目成本增加了30%',
    ]));
    expect(result.illustrations?.join('\n')).not.toContain('第一人称');
  });

  it('does not scope quoted or negated declarations, and lets explicit real sections end an example', () => {
    const read = (text: string) => qualifiedMaterialSentences({ id: 'one', label: '笔记', text });
    expect(read('客户说：“以下是虚构情境。”我已经交付页面。').every((item) => !item.status)).toBe(true);
    expect(read('这不是虚构案例。我已经交付页面。').every((item) => !item.status)).toBe(true);
    const scoped = read('以下是虚构情境。客户追加页面。\n真实经历：\n我已经完成一个客户项目。');
    expect(scoped.find((item) => item.text === '客户追加页面')?.status).toBe('fictional');
    expect(scoped.find((item) => item.text === '我已经完成一个客户项目')?.status).toBeUndefined();
    const local = read('假设客户临时加一页。我的项目已经交付。');
    expect(local[0].status).toBe('fictional');
    expect(local[1].status).toBeUndefined();
  });
  it('keeps the September 30 exercise fictional through saved analysis, prompts and intake', async () => {
    const rawMaterial = '【虚构练习，仅用于产品体验】我是一名独立设计顾问，想写给小团队负责人。题目是“项目来不及交付，怎样提前跟客户说”。设定：还有三天交稿，客户的资料仍不齐。我发了一张清单，标出缺的资料、最晚提供时间和对应的延期影响。请写600字左右的公众号文章，语气直接温和，不编造客户反应或收入。不要把这个虚构情境写成我的真实经历。结尾给一段可以复制使用的沟通示例，不引导加微信。';
    const saved = await saveMaterialAnalysisContext('run-a', { rawMaterial });
    const restored = (await getMaterialAnalysisContext('run-a'))!;
    expect(restored.input.rawMaterial).toBe(rawMaterial);
    expect(restored.analysis.facts).toEqual([]);
    expect(restored.analysis.cases).toEqual([]);
    expect(restored.analysis.illustrations?.join('\n')).toContain('模拟或虚构情境（粘贴文字）：设定：还有三天交稿，客户的资料仍不齐');
    expect(restored.analysis.illustrations?.join('\n')).not.toContain('题目是');
    expect(restored.analysis.authorRequirements).toContain('题目是“项目来不及交付，怎样提前跟客户说”');
    expect(restored.analysis.authorRequirements).toContain('想写给小团队负责人');
    expect(restored.analysis.risks.join('\n')).toContain('虚构练习，仅用于产品体验');
    for (const downstream of [toMaterialAnalysisPromptContext(restored), buildMaterialIntakeReport(saved)]) {
      expect(downstream).toContain('模拟或虚构情境');
      expect(downstream).toContain('虚构练习，仅用于产品体验');
      expect(downstream).not.toMatch(/可用事实：[^\n]*(?:题目是|三天交稿)/);
    }
  });

  it('keeps the paid-customer tone and prohibitions as author directions through saving and downstream contexts', async () => {
    const rawMaterial = '【以下是体验用的虚构案例，不得写成我的亲身经历】一位独立顾问接到客户临时增加两页方案的要求。原约定周五交付，他把新增范围和时间影响写在同一份清单中，让客户选择减少原有内容，或另约交付时间。没有成交或收入数据。\n我想写给第一次独立接项目的顾问，公众号600字左右，标题用《客户临时加需求，我该怎么说》。用平实的语气，保留虚构案例标识，不编造效果、不引导私信。结尾给一句可直接使用的话。';
    await saveMaterialAnalysisContext('run-a', { rawMaterial });
    const restored = (await getMaterialAnalysisContext('run-a'))!;
    expect(restored.input.rawMaterial).toBe(rawMaterial);
    expect(restored.analysis.facts).toEqual([]);
    expect(restored.analysis.cases).toEqual([]);
    expect(restored.analysis.illustrations?.join('\n')).toContain('模拟或虚构情境（粘贴文字）：原约定周五交付');
    expect(restored.analysis.illustrations?.join('\n')).not.toContain('用平实的语气');
    for (const direction of ['标题用《客户临时加需求，我该怎么说》', '用平实的语气', '保留虚构案例标识', '不编造效果、不引导私信', '结尾给一句可直接使用的话']) {
      expect(restored.analysis.authorRequirements).toContain(direction);
      expect(toMaterialAnalysisPromptContext(restored)).toContain(direction);
      expect(buildMaterialIntakeReport(restored)).toContain(direction);
    }
    expect(restored.analysis.recommendedStructureId).not.toBe('customer-solution-case-cta');
  });

  it.each(['虚构练习', '模拟练习', '假设练习', '虚构演练'])('recognizes exercise labels without leaking across real sections: %s', (label) => {
    const result = qualifiedMaterialSentences({ id: 'one', label: '练习', text: `【${label}】客户增加了一页。\n真实经历：\n我完成了首页。` });
    expect(result.find((item) => item.text === '客户增加了一页')?.status).toBe('fictional');
    expect(result.find((item) => item.text === '我完成了首页')?.status).toBeUndefined();
  });

  it.each(['这不是虚构练习。', '不要使用虚构练习。', '客户说：“以下是虚构练习。”'])('does not label real material from a negated or quoted exercise: %s', (prefix) => {
    expect(qualifiedMaterialSentences({ id: 'one', label: '笔记', text: `${prefix}我已经交付首页。` }).every((item) => !item.status)).toBe(true);
  });
  it('uses author-edited requirements in prompts and intake while preserving the original input', async () => {
    const original = await saveMaterialAnalysisContext('run-a', { rawMaterial: '要求：写一千字。结尾引导读者私信。我的观点：先确认范围。' });
    const revised = await saveMaterialAnalysisContext('run-a', {
      analysis: { ...original.analysis, authorRequirements: ['要求：写七百字', '结尾不要引导私信'] }, analysisSource: 'manual',
    });
    expect(revised.input).toEqual(original.input);
    expect(getMaterialWritingRequirements(revised)).toEqual(['要求：写七百字', '结尾不要引导私信']);
    expect(toMaterialAnalysisPromptContext(revised)).toContain('要求：写七百字');
    expect(toMaterialAnalysisPromptContext(revised)).not.toContain('作者要求：要求：写一千字');
    expect(buildMaterialIntakeReport(revised)).toContain('要求：写七百字');
    const cleared = await saveMaterialAnalysisContext('run-a', { analysis: { ...revised.analysis, authorRequirements: [] }, analysisSource: 'manual' });
    expect(getMaterialWritingRequirements(cleared)).toEqual([]);
    expect(toMaterialAnalysisPromptContext(cleared)).toContain('未明确提出销售引导');
    expect((await getMaterialAnalysisContext('run-a'))?.input).toEqual(original.input);
  });
  beforeEach(async () => {
    mocks.runs = [
      { run_id: 'run-a', slug: 'run-a', status: 'active' },
      { run_id: 'run-b', slug: 'run-b', status: 'active' },
    ];
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(mocks.projectDir, { recursive: true, force: true });
  });

  it('stores only current-run material input and preserves it while the operator chooses a direction', async () => {
    const initial = await saveMaterialAnalysisContext('run-a', {
      rawMaterial: '2026 年我们为一位客户完成了产品定位复盘，客户的问题是获客成本过高。',
      files: [{
        name: '客户访谈.txt',
        size: 120,
        sourcePath: 'materials/intake/customer-interview.txt',
        path: 'materials/extracted/customer-interview-extract.md',
        extractionStatus: 'text_extracted',
      }],
      links: ['https://example.com/article'],
    });

    expect(initial.analysis_source).toBe('heuristic');
    expect(initial.analysis.recommendedTypeId).toBe('business-growth');
    expect(initial.selection).toBeNull();
    expect(initial.input.links[0]).toMatchObject({ url: 'https://example.com/article', status: 'pending' });

    const selected = await saveMaterialAnalysisContext('run-a', {
      selection: {
        materialTypeId: 'business-growth',
        structureId: 'growth-mistake-mechanism-list',
      },
    });
    expect(selected.selection).toEqual({
      materialTypeId: 'business-growth',
      structureId: 'growth-mistake-mechanism-list',
    });
    expect(selected.input.rawMaterial).toContain('获客成本');
    expect(selected.input.files[0]).toMatchObject({
      sourcePath: 'materials/intake/customer-interview.txt',
      path: 'materials/extracted/customer-interview-extract.md',
      extractionStatus: 'text_extracted',
    });

    const stored = JSON.parse(await readFile(path.join(mocks.projectDir, 'sessions/material-analysis/run-a.json'), 'utf-8'));
    expect(stored).toMatchObject({ schema: 'aifios.material-analysis.v1', runId: 'run-a' });
    expect(await getMaterialAnalysisContext('run-b')).toBeNull();
  });

  it('does not treat customer vocabulary or a reference call to action as the author sales intent', async () => {
    const result = await createSourceBackedMaterialAnalysis({
      rawMaterial: '目标读者是服务型小团队负责人。我的观点：客户的问题值得写成方法文章。结尾只留一个记录问题的动作，不要引导私信、购买或预约咨询。',
      files: [],
      links: [{ url: 'https://example.com/reference', status: 'parsed', excerpt: '本期目标：引导读者购买产品并预约咨询。' }],
    });
    expect(result.recommendedTypeId).toBe('business-growth');
    expect(result.recommendedStructureId).toBe('customer-question-method');
    expect(result.summary).not.toMatch(/引流获客|案例与 CTA/);
    expect(result.authorRequirements?.join('\n')).toContain('不要引导私信、购买');
    expect(result.authorRequirements?.join('\n')).not.toContain('本期目标：引导读者购买产品');
  });

  it('uses a conversion structure only when the operator requests a sales action', async () => {
    const analyze = (rawMaterial: string) => createSourceBackedMaterialAnalysis({ rawMaterial, files: [], links: [] });
    expect((await analyze('客户正在比较产品和服务，希望减少获客成本。')).recommendedStructureId).toBe('customer-question-method');
    expect((await analyze('客户正在比较产品和服务。内容目标：引导读者预约产品演示。')).recommendedStructureId).toBe('customer-solution-case-cta');
    expect((await analyze('客户正在比较产品和服务。内容目标：介绍产品，不要引导读者购买。')).recommendedStructureId).toBe('customer-question-method');
  });

  it('keeps the paid-user review material in its actual editorial categories through the saved intake', async () => {
    const opinion = '我的观点：客户说“顺便改一下”时，不急着答应，也不要马上拒绝，先把改动写清楚';
    const method = '我的做法：记录这次修改影响哪项交付、增加多少工作、是否改变原定时间；能在原约定内完成就照做，超出时列明可选方案，请对方确认后再开始';
    const goal = '这次只想把我处理需求变更的方法写给其他小团队负责人，做一篇公众号短文';
    const request = '要求：700到1000字，平实直接';
    const input = { rawMaterial: [
      '【产品体验用模拟素材，不是真实客户案例，不得对外当作经营成果】',
      goal, opinion, method, '我希望读者记住：把变化讲清楚，双方才能知道下一步做什么', request,
      '不能编造客户对白、成交额、节省比例或成功案例', '不要“赋能、闭环、破局”',
      '结尾只写“下次遇到顺便改一下，先把改动写清楚”', '不引导私信、购买或预约',
    ].join('。\n'), files: [], links: [] };
    const result = await createSourceBackedMaterialAnalysis(input);
    expect(result.opinions).toEqual([opinion, method]);
    expect(result.facts).not.toContain(goal);
    expect(result.facts).not.toContain(method);
    expect(result.risks.join('\n')).not.toContain(opinion);
    expect(result.risks.join('\n')).toContain('不得对外当作经营成果');
    expect(result.authorRequirements).toEqual(expect.arrayContaining([goal, '要求：700到1000字', '平实直接', '我希望读者记住：把变化讲清楚，双方才能知道下一步做什么', '不能编造客户对白、成交额、节省比例或成功案例']));
    await saveMaterialAnalysisContext('run-a', { ...input, analysis: result, analysisSource: 'heuristic' });
    const saved = (await getMaterialAnalysisContext('run-a'))!;
    for (const downstream of [toMaterialAnalysisPromptContext(saved), buildMaterialIntakeReport(saved)]) {
      expect(downstream).toContain('要求：700到1000字');
      expect(downstream).toContain('平实直接');
      expect(downstream).toContain(opinion);
      expect(downstream).not.toContain(`公开边界：${opinion}`);
      expect(downstream).not.toContain(`可用事实：${goal}`);
    }
  });

  it('retains actual disclosure restrictions without turning ordinary negative advice into privacy limits', async () => {
    const result = await createSourceBackedMaterialAnalysis({ rawMaterial: [
      '我的建议：不要为了成交马上答应客户',
      '不要公开客户的姓名和聊天记录',
      '没有授权公开客户营收数据',
      '这些合同仅供内部讨论',
      '不能编造客户结果',
    ].join('。'), files: [], links: [] });
    expect(result.opinions).toContain('我的建议：不要为了成交马上答应客户');
    expect(result.risks).toEqual(expect.arrayContaining(['公开边界：不要公开客户的姓名和聊天记录', '公开边界：没有授权公开客户营收数据', '公开边界：这些合同仅供内部讨论']));
    expect(result.risks.join('\n')).not.toContain('公开边界：我的建议');
    expect(result.facts).not.toContain('不能编造客户结果');
  });

  it('preserves natural compound requirements, method and author identity through save and downstream intake', async () => {
    const identity = '我经营一家小型设计工作室';
    const purpose = '想写一篇公众号文章给经常遇到临时加需求的小团队负责人';
    const method = '我想分享一个具体做法：每次变更都先写下“增加什么、会推迟什么、谁来确认”，再决定做不做';
    const requirement = '只做公众号，700至900字，平实一点，不写营销口号、不引导私信或购买，结尾只保留一句行动建议';
    const rawMaterial = [
      '【模拟体验素材，不是真实客户案例】',
      `${identity}，${purpose}。`,
      '上周的一次模拟项目里，需求从改首页扩展到增加会员页和三封通知邮件。团队当时没有把新增工作写下来，先答应了，后来才发现上线时间不够。我认为问题不在于客户难沟通，而是双方没有共同确认新增工作的范围。',
      `${method}。不要把它包装成万能方法，也不要虚构营收、客户评价和成功率。`,
      `已有题目：《临时加需求，先把这三件事写清楚》。${requirement}。`,
      '本次仅供内部体验，不对外发布。不要出现客户姓名。',
    ].join('\n');
    const input = { rawMaterial, files: [], links: [] };
    const result = await createSourceBackedMaterialAnalysis(input);
    expect(result.authorRequirements).toEqual(expect.arrayContaining([purpose, '只做公众号', '700至900字', '平实一点', '不写营销口号、不引导私信或购买', '结尾只保留一句行动建议', '不要出现客户姓名']));
    expect(result.opinions).toContain(method);
    expect(result.facts).not.toContain(identity);
    expect(result.illustrations?.join('\n')).toContain(`模拟或虚构情境（粘贴文字）：${identity}`);
    expect(result.facts.join('\n')).not.toContain(purpose);
    expect(result.facts).not.toContain(method);
    expect(result.risks).toContain('公开边界：本次仅供内部体验，不对外发布');
    await saveMaterialAnalysisContext('run-a', { ...input, analysis: result, analysisSource: 'heuristic' });
    const reopened = (await getMaterialAnalysisContext('run-a'))!;
    expect(reopened.input.rawMaterial).toBe(rawMaterial);
    for (const downstream of [toMaterialAnalysisPromptContext(reopened), buildMaterialIntakeReport(reopened)]) {
      for (const clause of ['只做公众号', '700至900字', '平实一点', '不写营销口号、不引导私信或购买', '结尾只保留一句行动建议']) expect(downstream).toContain(clause);
      expect(downstream).toContain(method);
    }
    expect(buildMaterialIntakeReport(reopened)).toContain('- 主受众：经常遇到临时加需求的小团队负责人');
  });

  it.each([
    '我想分享一个具体做法：每次变更先写下增加什么，再共同确认',
    '我们希望介绍一种实际的方法：先记录影响，再决定是否接受',
    '我打算说明自己的经验：记录变化后再与客户核对范围',
  ])('recognizes the author method without making it a proven case: %s', async (method) => {
    const result = await createSourceBackedMaterialAnalysis({ rawMaterial: method + '。', files: [], links: [] });
    expect(result.opinions).toEqual([method]);
    expect(result.facts).toEqual([]);
    expect(result.cases).toEqual([]);
    expect(result.authorRequirements).toEqual([]);
  });

  it('keeps quoted customer methods and their nested instructions as attributed source text', async () => {
    const quotation = '客户说：“我想分享一个具体做法：先确认范围。只做公众号，700至900字。结尾引导购买。”';
    const fact = '2026年9月我们完成项目，实际报价1,200.50元';
    const result = await createSourceBackedMaterialAnalysis({ rawMaterial: `${quotation}\n${fact}。`, files: [], links: [] });
    expect(result.opinions).toEqual([]);
    expect(result.authorRequirements).toEqual([]);
    expect(result.facts).toContain(fact);
    expect(result.facts).not.toContain('只做公众号，700至900字');
  });

  it.each([
    '不对外发布', '暂不公开', '不公开', '仅内部使用', '只用于内部讨论',
    '使用边界：这份客户资料不对外发布', '# 仅供内部',
    '【模拟验收材料，不是真实客户案例，不对外发布】我想写给服务型小团队负责人',
  ])('keeps the disclosure restriction %s even when it is short or metadata', async (restriction) => {
    const result = await createSourceBackedMaterialAnalysis({
      rawMaterial: `${restriction}。我的观点：先记录具体改动，再确认影响。`, files: [], links: [],
    });
    expect(result.risks.join('\n')).toContain(restriction.replace(/^# /, ''));
    expect(result.facts).not.toContain(restriction);
    expect(result.cases).not.toContain(restriction);
    expect(result.opinions).toContain('我的观点：先记录具体改动，再确认影响');
  });

  it('retains a long restriction from a reused file through save, reopen and downstream contexts', async () => {
    await mkdir(path.join(mocks.projectDir, 'materials/extracted'), { recursive: true });
    const restriction = `使用边界：${'以下是内部讨论的过程，'.repeat(28)}未经确认的客户报价不对外发布`;
    await writeFile(path.join(mocks.projectDir, 'materials/extracted/private-notes.md'),
      '# 复用素材\n> 来源：方法笔记\n> 素材保存时间：2026-09-18T09:00:00Z\n\n## 原文\n\n'
      + '我的观点：先记录改动再核对交付。\n' + '普通背景。'.repeat(300) + '\n' + restriction);
    const input = { rawMaterial: '', files: [{ name: 'private-notes.md', path: 'materials/extracted/private-notes.md', extractionStatus: 'existing_extraction' as const }], links: [] };
    const result = await createSourceBackedMaterialAnalysis(input);
    expect(result.sources?.[0].excerpt).not.toContain('不对外发布');
    expect(result.risks).toContain(`公开边界：${restriction}`);
    await saveMaterialAnalysisContext('run-a', { ...input, analysis: result, analysisSource: 'heuristic' });
    const reopened = (await getMaterialAnalysisContext('run-a'))!;
    expect(reopened.analysis.risks).toEqual(result.risks);
    expect(toMaterialAnalysisPromptContext(reopened)).toContain(restriction);
    expect(buildMaterialIntakeReport(reopened)).toContain(restriction);
  });

  it('does not silently replace an existing review when restriction detection changes', async () => {
    const input = { rawMaterial: '不对外发布。我的观点：先记录改动再核对交付。', files: [], links: [] };
    const initial = await createSourceBackedMaterialAnalysis(input);
    await saveMaterialAnalysisContext('run-a', { ...input, analysis: { ...initial, risks: [] }, analysisSource: 'manual' });
    expect((await getMaterialAnalysisContext('run-a'))?.analysis.risks).toEqual([]);
    expect(initial.risks.join('\n')).toContain('不对外发布');
  });

  it('keeps a late restriction in an oversized paragraph and makes the excerpt explicit', async () => {
    const rawMaterial = '我们逐项讨论需要修改的地方，'.repeat(250) + '这份客户材料不对外发布';
    const result = await createSourceBackedMaterialAnalysis({ rawMaterial, files: [], links: [] });
    expect(result.risks.join('\n')).toContain('这份客户材料不对外发布');
    expect(result.risks.join('\n')).toContain('请核对原文中的完整限制');
    await expect(saveMaterialAnalysisContext('run-a', { rawMaterial, analysis: result })).resolves.toBeDefined();
  });

  it('keeps end-of-file author requirements through persistence and downstream intake instead of truncating them to the excerpt', async () => {
    await mkdir(path.join(mocks.projectDir, 'materials/extracted'), { recursive: true });
    const ending = '结尾只保留一句：先记下今天被问到的那个问题。';
    await writeFile(path.join(mocks.projectDir, 'materials/extracted/notes.md'),
      '# 复用素材\n> 来源：方法笔记\n> 素材保存时间：2026-09-15T09:00:00Z\n\n## 原文\n\n【模拟素材，不是真实客户案例】\n目标读者是没有专职编辑的团队负责人。\n'
      + '客户问题与服务方法。'.repeat(200) + '\n' + ending + '\n不要引导私信、购买或预约咨询。');
    const input = { rawMaterial: '', files: [{ name: 'notes.md', path: 'materials/extracted/notes.md', extractionStatus: 'existing_extraction' as const }], links: [] };
    const result = await createSourceBackedMaterialAnalysis(input);
    expect(result.sources?.[0].excerpt).not.toContain('结尾只保留');
    expect(result.sources?.[0].excerpt).not.toContain('素材保存时间');
    expect(result.facts.join('\n')).not.toContain('2026-09-15');
    expect(result.authorRequirements).toContain(ending.slice(0, -1));
    await saveMaterialAnalysisContext('run-a', { ...input, analysis: result, analysisSource: 'heuristic' });
    const stored = (await getMaterialAnalysisContext('run-a'))!;
    expect(toMaterialAnalysisPromptContext(stored)).toContain(ending.slice(0, -1));
    const report = buildMaterialIntakeReport(stored);
    expect(report).toContain('- 主受众：没有专职编辑的团队负责人');
    expect(report).toContain(ending.slice(0, -1));
    expect(report).not.toContain('案例与 CTA');
    expect(report).not.toContain('对内容生产低效的清醒感');
  });

  it('enforces one valid primary type and a structure belonging to that type', async () => {
    await expect(saveMaterialAnalysisContext('run-a', {
      rawMaterial: '一段可分析的素材。',
      selection: {
        materialTypeId: 'personal-growth',
        structureId: 'customer-solution-case-cta',
      },
    })).rejects.toBeInstanceOf(MaterialAnalysisInputError);

    await expect(saveMaterialAnalysisContext('run-a', {
      rawMaterial: '一段可分析的素材。',
      links: Array.from({ length: 6 }, (_, index) => `https://example.com/${index}`),
    })).rejects.toThrow('最多添加 5 条');
  });

  it('keeps individual link failures nonblocking and persists compact extracted text only', async () => {
    const links = await resolveInspirationLinks([
      'https://example.com/article',
      'https://example.com/unavailable',
      'not-a-url',
    ], async (url) => {
      if (url.pathname === '/unavailable') throw new Error('temporary unavailable');
      return {
        title: '一篇可参考的文章',
        excerpt: '客户案例表明，这条观点可以帮助本期内容更清楚地说明问题与方法。',
      };
    });

    expect(links[0]).toMatchObject({ status: 'parsed', title: '一篇可参考的文章' });
    expect(links[1]).toMatchObject({ status: 'failed', error: '这条链接暂时没有读到可用内容，其他素材不受影响。请检查链接后重试。' });
    expect(links[2]).toMatchObject({ status: 'failed' });

    const context = await saveMaterialAnalysisContext('run-a', {
      rawMaterial: '这里是本期素材。',
      links,
    });
    expect(context.analysis.facts.join(' ')).toContain('客户案例');
    expect(toMaterialAnalysisPromptContext(context)).toContain('一篇可参考的文章');
    expect(toMaterialAnalysisPromptContext(context)).not.toContain('temporary unavailable');
  });

  it('prefers an approved platform reader and preserves its TikOmni provenance', async () => {
    const genericReader = vi.fn(async () => ({ title: '不应读取', excerpt: '不应读取' }));
    const platformReader = vi.fn(async () => ({
      title: '公开视频标题',
      excerpt: '这是 TikOmni 返回的公开字幕或正文。',
      reader: 'tikomni' as const,
    }));

    const links = await resolveInspirationLinks(
      ['https://channels.weixin.qq.com/finder-preview/pages/sph?id=fixture'],
      genericReader,
      platformReader,
    );

    expect(genericReader).not.toHaveBeenCalled();
    expect(platformReader).toHaveBeenCalledTimes(1);
    expect(links).toEqual([{
      url: 'https://channels.weixin.qq.com/finder-preview/pages/sph?id=fixture',
      status: 'parsed',
      title: '公开视频标题',
      excerpt: '这是 TikOmni 返回的公开字幕或正文。',
      reader: 'tikomni',
    }]);

    const analysis = await createSourceBackedMaterialAnalysis({
      rawMaterial: '',
      files: [],
      links,
    });
    expect(analysis.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'link',
        status: 'read',
        detail: '已通过 TikOmni 读取公开内容，仅作本期内部参考。',
      }),
    ]));
  });

  it('does not fall back to the generic reader when a platform reader fails', async () => {
    const genericReader = vi.fn(async () => ({ title: '不应读取', excerpt: '不应读取' }));
    const links = await resolveInspirationLinks(
      ['https://mp.weixin.qq.com/s/fixture'],
      genericReader,
      async () => { throw new Error('TikOmni 未返回可读取的文章正文。'); },
    );

    expect(genericReader).not.toHaveBeenCalled();
    expect(links).toEqual([{
      url: 'https://mp.weixin.qq.com/s/fixture',
      status: 'failed',
      error: '这条链接暂时没有读到可用内容，其他素材不受影响。请检查链接后重试。',
    }]);
  });

  it('falls back to the generic reader when a platform reader declines a normal webpage', async () => {
    const genericReader = vi.fn(async () => ({ title: '普通网页', excerpt: '公开网页正文。' }));
    const links = await resolveInspirationLinks(
      ['https://example.com/article'],
      genericReader,
      async () => null,
    );

    expect(genericReader).toHaveBeenCalledTimes(1);
    expect(links[0]).toMatchObject({ status: 'parsed', title: '普通网页', excerpt: '公开网页正文。' });
  });

  it('never sends a private-network inspiration URL to a resolver', async () => {
    let resolverCalled = false;
    const links = await resolveInspirationLinks(['http://127.0.0.1/private', 'http://[::ffff:7f00:1]/private'], async () => {
      resolverCalled = true;
      return { title: 'should not load', excerpt: 'should not load' };
    });

    expect(resolverCalled).toBe(false);
    expect(links).toHaveLength(2);
    expect(links.every((link) => link.status === 'failed')).toBe(true);
    expect(links.every((link) => link.error === '这条链接暂时没有读到可用内容，其他素材不受影响。请检查链接后重试。')).toBe(true);
  });

  it('blocks unsafe formal analysis before writing and persists safe warnings', async () => {
    const unsafe = saveMaterialAnalysisContext('run-a', {
      rawMaterial: '客户在发布前需要整理素材。',
      analysis: {
        summary: '作为 AI，我读取了 /Users/customer/private.txt，api_key=sk-super-secret-token-value',
        facts: [],
        cases: [],
        risks: [],
        recommendedTypeId: 'business-growth',
        recommendedStructureId: 'customer-solution-case-cta',
      },
      analysisSource: 'llm',
    });
    await expect(unsafe).rejects.toThrow('不适合展示');
    await expect(readFile(path.join(mocks.projectDir, 'sessions/material-analysis/run-a.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });

    const warned = await saveMaterialAnalysisContext('run-a', {
      rawMaterial: '客户在发布前需要整理素材。',
      analysis: {
        summary: '综上所述，先核对客户授权，再整理可公开的事实。',
        facts: ['客户已经提供书面素材。'],
        cases: [],
        risks: ['发布前确认公开边界。'],
        recommendedTypeId: 'business-growth',
        recommendedStructureId: 'customer-solution-case-cta',
      },
      analysisSource: 'llm',
    });
    expect(warned.qualityWarnings).toContain('结尾像模板总结，建议直接保留结论。');
    expect(JSON.parse(await readFile(path.join(mocks.projectDir, 'sessions/material-analysis/run-a.json'), 'utf-8')).qualityWarnings).toEqual(warned.qualityWarnings);
  });

  it('returns the pinned address as a list when Node asks a custom lookup for all candidates', () => {
    const selected = { address: '203.0.113.42', family: 4 };
    const allCallback = vi.fn();
    returnPinnedLookupAddress({ all: true }, allCallback, selected);
    expect(allCallback).toHaveBeenCalledWith(null, [selected]);

    const singleCallback = vi.fn();
    returnPinnedLookupAddress({}, singleCallback, selected);
    expect(singleCallback).toHaveBeenCalledWith(null, '203.0.113.42', 4);
  });

  it('rejects a Video Channel JavaScript shell instead of treating its title as readable content', () => {
    const shell = [
      '<!doctype html>',
      '<html><head><title>视频号</title></head>',
      '<body><script>window.boot()</script><div id="app"></div></body></html>',
    ].join('');

    expect(() => extractInspirationPageContent(
      new URL('https://channels.weixin.qq.com/finder-preview/pages/sph?id=AFWzl8ujto'),
      shell,
    )).toThrow('该视频号页面未公开可读取字幕或正文，请补充字幕、逐字稿或其他文字素材。');
  });

  it('does not keep a session context after it is explicitly cleared', async () => {
    await saveMaterialAnalysisContext('run-a', { rawMaterial: '需要临时保存的内容。' });
    await clearMaterialAnalysisContext('run-a');
    await expect(getMaterialAnalysisContext('run-a')).resolves.toBeNull();
  });

  it('marks an edited material snapshot stale and prevents its old direction from being reused', async () => {
    const initial = await saveMaterialAnalysisContext('run-a', {
      rawMaterial: '第一版素材：客户增长诊断与产品定位复盘。',
      files: [],
      links: [],
      selection: {
        materialTypeId: 'business-growth',
        structureId: 'growth-mistake-mechanism-list',
      },
    });
    expect(isMaterialAnalysisCurrent(initial)).toBe(true);
    expect(initial.inputFingerprint).toBe(materialInputFingerprint(initial.input));

    const stale = await saveMaterialAnalysisContext('run-a', {
      rawMaterial: '第二版素材：客户增长诊断与产品定位复盘，补充了新的失败原因。',
      files: [],
      links: [],
      invalidateAnalysis: true,
    });

    expect(stale.analysisStatus).toBe('stale');
    expect(stale.selection).toBeNull();
    expect(stale.inputFingerprint).not.toBe(initial.inputFingerprint);
    expect(stale.analysisInputFingerprint).toBe(initial.inputFingerprint);
    expect(isMaterialAnalysisCurrent(stale)).toBe(false);
    expect(() => assertMaterialAnalysisCurrent(stale)).toThrow(MaterialAnalysisStaleError);
    await expect(saveMaterialAnalysisContext('run-a', {
      selection: {
        materialTypeId: 'business-growth',
        structureId: 'growth-mistake-mechanism-list',
      },
    })).rejects.toBeInstanceOf(MaterialAnalysisStaleError);
  });

  it('keeps the fingerprint stable when the server enriches a reference link', async () => {
    const pending = await saveMaterialAnalysisContext('run-a', {
      rawMaterial: '本期素材。',
      files: [],
      links: ['https://example.com/reference'],
    });
    const enriched = await saveMaterialAnalysisContext('run-a', {
      links: [{
        url: 'https://example.com/reference',
        status: 'parsed',
        title: '参考文章',
        excerpt: '这段解析由服务端补充。',
      }],
    });

    expect(enriched.inputFingerprint).toBe(pending.inputFingerprint);
  });

  it('preserves a confirmed direction when an identical input snapshot is autosaved again', async () => {
    const input = {
      rawMaterial: '本期素材：客户增长诊断与产品定位复盘。',
      files: [{
        name: '客户访谈.txt',
        size: 120,
        sourcePath: 'materials/intake/customer-interview.txt',
        path: 'materials/extracted/customer-interview-extract.md',
        extractionStatus: 'text_extracted' as const,
      }],
      links: ['https://example.com/reference'],
    };
    await saveMaterialAnalysisContext('run-a', input);
    const selected = await saveMaterialAnalysisContext('run-a', {
      selection: {
        materialTypeId: 'business-growth',
        structureId: 'growth-mistake-mechanism-list',
      },
    });

    const autosaved = await saveMaterialAnalysisContext('run-a', input);

    expect(autosaved.inputFingerprint).toBe(selected.inputFingerprint);
    expect(autosaved.selection).toEqual(selected.selection);
    expect(isMaterialAnalysisCurrent(autosaved)).toBe(true);
  });

  it('matches the browser fingerprint for the same editable input', async () => {
    const input = {
      rawMaterial: '  本期素材。  ',
      files: [{ name: '访谈.txt', size: 32, path: 'materials/intake/interview.txt' }],
      links: [' https://example.com/reference ', 'https://example.com/reference'],
    };

    expect(await createMaterialInputFingerprint(input)).toBe(materialInputFingerprint({
      rawMaterial: input.rawMaterial,
      files: input.files,
      links: input.links.map((url) => ({ url, status: 'pending' as const })),
    }));
  });

  it('reads extracted file text before recommending a direction and records its provenance', async () => {
    const extractedPath = path.join(mocks.projectDir, 'materials/extracted/customer-growth.md');
    await mkdir(path.dirname(extractedPath), { recursive: true });
    await writeFile(extractedPath, [
      '# 素材解析资产',
      '',
      '## 2. 可读取正文',
      '2026 年我们为一个客户完成增长诊断，发现获客成本上升了 38%。',
      '通过重做产品定位和销售转化路径，项目在 8 周内恢复了有效线索。',
      '',
      '## 3. 证据台账',
      '- E01：客户增长诊断。',
    ].join('\n'));

    const analysis = await createSourceBackedMaterialAnalysis({
      rawMaterial: '',
      files: [{
        name: '客户增长诊断.md',
        sourcePath: 'materials/intake/customer-growth.md',
        path: 'materials/extracted/customer-growth.md',
        extractionStatus: 'text_extracted',
      }],
      links: [],
    });

    expect(analysis.recommendedTypeId).toBe('business-growth');
    expect(analysis.facts.join(' ')).toContain('38%');
    expect(analysis.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'file', label: '客户增长诊断.md', status: 'read' }),
    ]));
  });

  it('keeps goals and publication prohibitions out of facts and turns explicit boundaries into risks', async () => {
    const analysis = await createSourceBackedMaterialAnalysis({
      rawMaterial: [
        '我曾经历过一次严重健康挑战，如今正在重新开始内容创作。',
        '商业目标是邀请更多创业者加入后续活动。',
        '不得公开具体诊断、机构名称，也不作任何疗效承诺。',
        '恢复期间，我完成了三次公开分享，并记录了现场反馈。',
      ].join('\n'),
      files: [],
      links: [],
    });

    expect(analysis.facts.join(' ')).toContain('健康挑战');
    expect(analysis.facts.join(' ')).not.toContain('商业目标');
    expect(analysis.facts.join(' ')).not.toContain('不得公开');
    expect(analysis.cases.join(' ')).toContain('三次公开分享');
    expect(analysis.risks).toEqual(expect.arrayContaining([
      expect.stringContaining('公开边界：不得公开具体诊断'),
      expect.stringContaining('健康或病史信息'),
      expect.stringContaining('第三方争议或身份信息'),
    ]));
  });

  it('does not turn a publishing opinion, desired output or test scenario into a real case', async () => {
    const analysis = await createSourceBackedMaterialAnalysis({
      rawMaterial: [
        '这是客户体验测试素材，不是真实客户案例。',
        '观点：一篇内容是否完成，要看作者是否愿意署名发布，而不是模型是否输出了文字。',
        '已知事实：当前产品可选公众号、小红书、视频号；公开发布由操作者完成。',
        '期望交付一篇公众号文章，讲清发布前需要检查事实、表达和排版。',
        '没有客户收入、涨粉和省时数据，不得编造。',
      ].join('\n'), files: [], links: [],
    });
    expect(analysis.cases).toEqual([]);
    expect(analysis.facts).toEqual([]);
    expect(analysis.illustrations).toContain('模拟或虚构情境（粘贴文字）：已知事实：当前产品可选公众号、小红书、视频号；公开发布由操作者完成');
    expect(analysis.risks.join(' ')).toContain('不得编造');
  });

  it('separates first-person opinions and missing consent from usable customer facts', async () => {
    const analysis = await createSourceBackedMaterialAnalysis({
      rawMaterial: [
        '我的观点：写内容之前，先收集客户反复问的问题。',
        '我们的判断：客户应该先说明自己的需求。',
        '我建议先复盘客户反馈，再决定下一次发布内容。',
        '没有授权公开真实客户姓名和聊天记录。',
        '尚未获得公开授权的客户数据需保留在内部。',
        '客户不同意公开这次项目的具体报价。',
        '2026年9月我们完成了一次产品访谈，记录了客户提出的三个问题。',
      ].join('\n'), files: [], links: [],
    });
    expect(analysis.facts).toEqual(['2026年9月我们完成了一次产品访谈，记录了客户提出的三个问题']);
    expect(analysis.cases).toEqual(analysis.facts);
    expect(analysis.opinions).toEqual([
      '我的观点：写内容之前，先收集客户反复问的问题',
      '我们的判断：客户应该先说明自己的需求',
      '我建议先复盘客户反馈，再决定下一次发布内容',
    ]);
    expect(analysis.risks).toEqual(expect.arrayContaining([
      expect.stringContaining('公开边界：没有授权公开真实客户姓名'),
      expect.stringContaining('公开边界：尚未获得公开授权'),
      expect.stringContaining('公开边界：客户不同意公开'),
    ]));
  });

  it('requires every retained attachment to become readable before TikOmni research', async () => {
    const input = {
      rawMaterial: '这里有一段可用文字，但附件尚未完成 OCR。',
      files: [{
        name: '会议截图.png',
        sourcePath: 'materials/intake/meeting.png',
        path: 'materials/extracted/meeting-extract.md',
        extractionStatus: 'needs_transcription' as const,
      }],
      links: [],
    };

    await expect(getMaterialReadiness(input)).resolves.toMatchObject({
      ready: false,
      readableSourceCount: 1,
      blockedFileCount: 1,
    });
    await expect(assertMaterialReadyForResearch(input)).rejects.toBeInstanceOf(MaterialReadinessError);
  });
});
