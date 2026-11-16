import { describe, expect, it } from 'vitest';
import { materialTitleSuggestion } from './material-title-suggestion';

describe('natural title assignments', () => {
  it.each([
    '【付费体验模拟，非真实客户经历】\n题目：报价之后，客户问“为什么这么贵”，怎么回答。\n以下是虚构练习：客户拿另一家报价比较。\n写给独立顾问，公众号，800字以内。只用这些材料，按这个题目写。',
    '标题：《先把范围说明白》\n请写一篇给独立顾问的文章。',
    '题目：先把范围说明白\n只用这些材料，按这个题目写。',
  ])('connects an opening title to a later author request: %s', (input) => {
    expect(materialTitleSuggestion(input)).toBe(input.includes('为什么这么贵') ? '报价之后，客户问“为什么这么贵”，怎么回答' : '先把范围说明白');
  });
  it.each([
    '题目：《未说明用途》',
    '我读到一篇文章。\n题目：《他人的题目》\n请写一篇评论。',
    '客户原话：\n题目：《客户的题目》\n写给独立顾问。',
    '【示例】题目：《示例题目》\n请写一篇文章。',
    '标题：《第一篇》\n题目：《第二篇》\n请写一篇文章。',
    '标题：《原题》，不要用了。\n请写一篇文章。',
  ])('does not adopt an unowned, quoted, cancelled or ambiguous opening title: %s', (input) => {
    expect(materialTitleSuggestion(input)).toBeNull();
  });
  it('finds an assignment after a mention of titles, and does not choose between two assignments in one sentence', () => {
    expect(materialTitleSuggestion('我想写一篇讨论标题的公众号文章，标题请用《写清楚客户的问题》。')).toBe('写清楚客户的问题');
    expect(materialTitleSuggestion('请写一篇文章，标题请用《第一篇》，题目设为《第二篇》。')).toBeNull();
  });
  it.each(['请用', '就用', '先用', '定为', '设为', '改为', '请定为'])('recognizes %s consistently across explicit author contexts', (assignment) => {
    for (const source of [
      `请写一篇公众号文章。标题${assignment}《先确认范围》。`,
      `我想写一篇文章，题目${assignment}《先确认范围》。`,
      `本期标题${assignment}《先确认范围》`,
    ]) expect(materialTitleSuggestion(source)).toBe('先确认范围');
  });
  it.each([
    '我想写一篇文章。客户说：“标题请用《客户要求》。”',
    '我想写一篇文章。标题请用什么比较好？',
    '我想写一篇文章。标题用于《写作课》的说明。',
    '我想写一篇文章。标题请用《第一篇》。题目设为《第二篇》。',
    '标题请用《未确定作者上下文》。',
  ])('leaves quoted, nonassignment or ambiguous text unselected: %s', (source) => {
    expect(materialTitleSuggestion(source)).toBeNull();
  });
});

describe('explicit author title suggestions', () => {
  it.each(['标题用', '标题就用', '题目用'])('recognizes a chosen title after a writing request: %s', (declaration) => {
    expect(materialTitleSuggestion(`我想写给第一次独立接项目的顾问，公众号600字左右，${declaration}《客户临时加需求，我该怎么说》。`))
      .toBe('客户临时加需求，我该怎么说');
    expect(materialTitleSuggestion(`我想写一篇文章。${declaration}《客户临时加需求，我该怎么说》。`))
      .toBe('客户临时加需求，我该怎么说');
    expect(materialTitleSuggestion(`我的${declaration}《客户临时加需求，我该怎么说》。`))
      .toBe('客户临时加需求，我该怎么说');
  });

  it.each([
    '标题用《没有作者上下文》。',
    '我想写一篇文章。客户说：“标题用《客户的标题》。”',
    '我想写一篇文章，引用“标题用《别人的标题》”这句话。',
    '我想写一篇文章。标题用于《写作课》的示范。',
    '我想写一篇文章。标题用什么比较好？',
    '我想写一篇文章。标题用《第一篇》。标题就用《第二篇》。',
    '我想写一篇文章。标题用《旧标题》，不要用了。',
  ])('does not choose quoted, ambiguous or nonassignment uses: %s', (source) => {
    expect(materialTitleSuggestion(source)).toBeNull();
  });

  it.each([
    '【虚构练习，仅用于产品体验】我是一名独立设计顾问，想写给小团队负责人。题目是“项目来不及交付，怎样提前跟客户说”。设定：还有三天交稿，客户的资料仍不齐。我发了一张清单，标出缺的资料、最晚提供时间和对应的延期影响。请写600字左右的公众号文章，语气直接温和，不编造客户反应或收入。不要把这个虚构情境写成我的真实经历。结尾给一段可以复制使用的沟通示例，不引导加微信。',
    '我想写一篇公众号文章。题目是“项目来不及交付，怎样提前跟客户说”。',
    '我想写一篇公众号文章。\n标题为《项目来不及交付，怎样提前跟客户说》。',
  ])('retains a separately stated title after an author request: %s', (text) => {
    expect(materialTitleSuggestion(text)).toBe('项目来不及交付，怎样提前跟客户说');
  });

  it.each([
    '我读到一篇文章。题目是《参考文章》。',
    '我想写一篇文章。客户说：题目是《客户要求》。',
    '我想写一篇文章。下面是一个例子。题目是《例子标题》。',
    '我想写一篇文章。\n## 参考文章\n题目是《参考标题》。',
    '我想写一篇文章。\n客户原话：\n题目是《客户要求》。',
    '我想写一篇文章。题目是《第一篇》。题目是《第二篇》。',
    '【虚构练习，仅用于产品体验，客户原话】我想写一篇文章。题目是《别人的标题》。',
  ])('does not inherit an author request into reference or ambiguous titles: %s', (text) => {
    expect(materialTitleSuggestion(text)).toBeNull();
  });

  it('retains the author title after the usage note from the September 27 paid-user audit', () => {
    const text = '【付费体验测试，以下均为模拟场景】我经营一个独立设计工作室，想写一篇公众号文章，题目是“客户临时加需求，怎么把费用谈清楚”。读者是第一次独立接单的设计师。原计划做首页和两个内页，草图确认后，客户又想加报名页。我的办法是先问报名页要解决什么问题，再给两种选择：原预算内替换一个内页，或者增加预算和工期保留全部页面。请写800字左右，语气像同事聊天，不要夸张，不编造成交数据，也不要引导加微信。结尾给一段可以直接发给客户的话。';
    expect(materialTitleSuggestion(text)).toBe('客户临时加需求，怎么把费用谈清楚');
  });

  it.each([
    '【仅供内部，不对外发布】本期题目：《先确认范围》',
    '[本次体验, 以下均为模拟案例]请写一篇文章，题目是《先确认范围》。',
    '【本轮测试】我经营工作室，想写《先确认范围》。',
  ])('recognizes a title without removing a usage boundary from the material: %s', (text) => {
    expect(materialTitleSuggestion(text)).toBe('先确认范围');
  });

  it.each([
    '【客户原话】我想写《别人的题目》。',
    '【示例】请写《示例标题》。',
    '【以下均为模拟场景】我想写《人物说的话》。',
    '【本次测试，客户原话】我想写《别人的题目》。',
    '【本次测试】客户说：我想写《别人的题目》。',
    '【本次测试】我经营工作室，比如，想写《假设标题》。',
    '> 【本次测试】我想写《引文标题》。',
    '## 参考示例\n【本次测试】我想写《示例标题》。',
    '【本次测试】我想写《第一篇》。我想写《第二篇》。',
  ])('does not promote source or ambiguous titles after a bracketed prefix: %s', (text) => {
    expect(materialTitleSuggestion(text)).toBeNull();
  });

  it('recognizes the complete failed paid-user input with an introductory clause', () => {
    const text = '我经营一家做网站的小工作室，想写一篇公众号文章，题目是“客户加需求时，怎样开口谈费用”。读者是第一次独立接单的设计师。下面是我为这次体验编写的模拟案例，不是真实客户记录：项目原先只包含首页和两个内页，确认草图后，对方又想加一个报名页面。我不想直接回一句“这个得加钱”，也不想免费吞下去。我的办法是先问清楚这项需求要解决什么问题，再列出两种选择：按原预算替换掉一个内页，或者增加预算和工期保留全部页面。想表达的观点：谈费用前先让双方看见范围的变化，给对方选择。请写800字左右，朴素、具体，不要鸡汤；不能编造成交数据、收益或客户评价；结尾给一段能直接发给客户的话，不引导加微信。';
    expect(materialTitleSuggestion(text)).toBe('客户加需求时，怎样开口谈费用');
  });

  it('extracts the paid-user material title without following writing instructions', () => {
    const text = '我经营设计工作室。\n已有题目：《临时加需求，先把这三件事写清楚》。只做公众号，700至900字。\n本次仅供内部体验。';
    expect(materialTitleSuggestion(text)).toBe('临时加需求，先把这三件事写清楚');
  });

  it.each([
    ['本期题目：怎么确认范围？', '怎么确认范围？'],
    ['我的标题：“从一次变更说起”。语气平实。', '从一次变更说起'],
    ['我想写的题目: "先写下来"', '先写下来'],
    ['- 已有题目：《先写下来》', '先写下来'],
    ['**已有题目**：《先写下来》', '先写下来'],
    ['我的看法：先说清楚。我的客户说：“一页应该很快吧？”我想写一篇公众号文章，题目是《客户说只加一页时，我先问三个问题》。写给团队负责人。', '客户说只加一页时，我先问三个问题'],
    ['我想写《客户说“很快吧？”时怎么回答》。', '客户说“很快吧？”时怎么回答'],
    ['这次想写一篇文章，标题为《先确认，再开工》。', '先确认，再开工'],
    ['请写公众号文章，题目是《客户临时加需求，先问清这三件事》。读者是接项目的小团队负责人。', '客户临时加需求，先问清这三件事'],
    ['请帮我写一篇公众号文章，题目是《先确认范围》。', '先确认范围'],
    ['帮我写《先确认，再开工》。', '先确认，再开工'],
    ['请为我写一篇文章，标题为《先确认，再开工》。', '先确认，再开工'],
    ['客户说：“能不能再加一页？”请写一篇文章，题目是《先问清楚》。', '先问清楚'],
    ['我是一名设计师，想写《先确认范围》。', '先确认范围'],
    ['我是一名小说作者，想写一篇文章，题目是《写作时间怎样安排》。', '写作时间怎样安排'],
    ['我负责产品说明书，想写《说明怎样写得更清楚》。', '说明怎样写得更清楚'],
    ['我经营一家工作室, 打算写一篇文章，标题为“先确认，再开工”。', '先确认，再开工'],
    ['我负责项目交付，最近在接外包，希望写《范围怎样说清楚》。', '范围怎样说清楚'],
    ['我们做网站，这次想写一篇文章，题目是《先问清楚》。', '先问清楚'],
    ['我在帮客户做网站，想写《为什么先确认范围？》。', '为什么先确认范围？'],
    ['我经营一家工作室，想写一篇文章，题目是“客户说‘一页很快吧？’时怎么回答”。', '客户说‘一页很快吧？’时怎么回答'],
    ['我经营一家工作室，想写《先确认范围》，语气朴素。', '先确认范围'],
  ])('recognizes %s', (text, expected) => {
    expect(materialTitleSuggestion(text)).toBe(expected);
  });

  it.each([
    '客户说：已有题目：《别人的文章》',
    '比如已有题目：《示例文章》',
    '示例标题：《示例文章》',
    '> 已有题目：《引文标题》',
    '    已有题目：《代码示例》',
    '```text\n已有题目：《代码示例》\n```',
    '~~~\n已有题目：《代码示例》\n~~~',
    '客户说：\n已有题目：《客户的文章》',
    '客户告诉我：\n已有题目：《客户的文章》',
    '以下是客户原话：\n已有题目：《客户的文章》',
    '例如：\n已有题目：《示例文章》',
    '示例：\n\n已有题目：《示例文章》',
    '## 参考文章\n已有题目：《参考文章》',
    '客户说：“\n已有题目：《客户的文章》\n”',
    '原文："\n已有题目：《客户的文章》\n"',
    '标题：《身份不明的标题》',
    '已有题目：《没有闭合',
    '已有题目：《旧题目》。这个题目不用了。',
    '已有题目：《超过字段限制' + '长'.repeat(240) + '》',
    '客户说：“我想写一篇文章，题目是《客户的要求》。”',
    '我读到一篇文章，题目是《参考文章》。',
    '请引用“我想写《不要选择这个》”这句话。',
    '客户说：“请写公众号文章，题目是《客户的要求》。”',
    '客户说：请写一篇文章，题目是《客户的要求》。',
    '例如，请帮我写《只是一条例子》。',
    '> 请写公众号文章，题目是《引文中的题目》。',
    '## 参考示例\n请写公众号文章，题目是《示例标题》。',
    '我经营一家工作室，客户想写一篇文章，题目是《客户的要求》。',
    '我经营一家工作室，客户说，想写一篇文章，题目是《客户的要求》。',
    '我经营一家工作室，同事提到，想写《别人的文章》。',
    '我经营一家工作室，转述客户的要求，想写《客户的文章》。',
    '我经营一家工作室，比如，想写《只是示例》。',
    '我经营一家工作室，客户说：“想写一篇文章，题目是《客户的要求》。”',
    '我经营一家工作室，并不想写《不使用的题目》。',
    '我经营一家工作室，如果想写《假设的题目》，应该先准备什么？',
    '客户经营一家工作室，想写《别人的题目》。',
    '> 我经营一家工作室，想写《引用的题目》。',
    '## 参考示例\n我经营一家工作室，想写《示例标题》。',
  ])('does not turn source text into an author title: %s', (text) => {
    expect(materialTitleSuggestion(text)).toBeNull();
  });

  it('does not choose between multiple distinct titles', () => {
    expect(materialTitleSuggestion('已有题目：《第一篇》\n本期题目：《另一篇》')).toBeNull();
    expect(materialTitleSuggestion('我想写《第一篇》。我想写《第二篇》。')).toBeNull();
    expect(materialTitleSuggestion('我经营一家工作室，想写《第一篇》。我负责交付，想写《第二篇》。')).toBeNull();
    expect(materialTitleSuggestion('已有题目：《同一篇》\n本期题目：《同一篇》')).toBe('同一篇');
  });

  it('resumes only after an explicit author writing requirements heading', () => {
    expect(materialTitleSuggestion('## 参考示例\n已有题目：《示例》\n## 我的写作要求\n已有题目：《我自己的文章》')).toBe('我自己的文章');
  });

});
