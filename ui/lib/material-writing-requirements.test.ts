import { describe, expect, it } from 'vitest';
import { materialAuthorAudience, materialWritingRequirements } from './material-writing-requirements';
import { materialClauses, materialSentences } from './material-text';

describe('ordinary editorial requests', () => {
  it('keeps standalone 不写 prohibitions and their following source boundaries', () => {
    const request = '不写“赋能、闭环、颠覆、降本增效”；不编造客户、收入、节省时间、行业统计或引语；保留“本地测试、手写虚构验收稿”的事实边界。';
    expect(materialWritingRequirements(request)).toEqual([
      '不写“赋能、闭环、颠覆、降本增效”',
      '不编造客户、收入、节省时间、行业统计或引语',
      '保留“本地测试、手写虚构验收稿”的事实边界',
    ]);
    expect(materialWritingRequirements('不写成第一人称客户见证，不替作者宣称亲身经历。')).toEqual([
      '不写成第一人称客户见证，不替作者宣称亲身经历',
    ]);
  });

  it.each([
    '客户说：“不写这句标题，不编造客户。”',
    '不写代码也能完成这次项目',
    '不写成第一人称是那篇旧稿的特点',
    '不写“广告”是客户当时的要求',
  ])('does not adopt reported choices or unrelated 不写 statements: %s', (source) => {
    expect(materialWritingRequirements(source)).toEqual([]);
  });

  it.each(['请用', '就用', '先用', '定为', '设为', '改为', '请定为'])('keeps title assignment %s as an editorial requirement', (assignment) => {
    expect(materialWritingRequirements(`标题${assignment}《先确认范围》。`)).toEqual([`标题${assignment}《先确认范围》`]);
    expect(materialWritingRequirements(`客户说：“标题${assignment}《客户要求》。”`)).toEqual([]);
  });
  it.each(['虚构情景', '模拟情景', '假设场景', '虚构故事', '模拟示例', '待核实案例'])('preserves the %s label and the following ending requirement', (label) => {
    expect(materialWritingRequirements(`保留${label}说明，结尾给一句回复的话。`)).toEqual([`保留${label}说明`, '结尾给一句回复的话']);
    expect(materialWritingRequirements(`客户说：“保留${label}说明，结尾给一句回复的话。”`)).toEqual([]);
    expect(materialWritingRequirements(`保留${label}说明是他们以前的做法。`)).toEqual([]);
  });
  it('separates tone, source labeling and prohibitions in the paid-user request', () => {
    expect(materialWritingRequirements('用平实的语气，保留虚构案例标识，不编造效果、不引导私信。')).toEqual([
      '用平实的语气', '保留虚构案例标识', '不编造效果、不引导私信',
    ]);
    expect(materialWritingRequirements('我想写给第一次独立接项目的顾问，公众号600字左右，标题用《客户临时加需求，我该怎么说》。'))
      .toEqual(['我想写给第一次独立接项目的顾问，公众号600字左右', '标题用《客户临时加需求，我该怎么说》']);
  });

  it.each(['用平实的语气', '请用自然的口吻写', '采用简洁的表达方式', '保持克制的文风', '保留虚构案例标识', '保留待核实说明', '不编造效果数据'])('keeps a standalone editorial direction: %s', (request) => {
    expect(materialWritingRequirements(request + '。')).toEqual([request]);
  });

  it.each([
    '用平实的语气跟客户谈判', '用平实的语气写了一封邮件', '采用简洁的表达方式完成了这次演讲',
    '客户说：“用平实的语气，保留虚构案例标识，不编造效果。”',
    '客户要求用自然的口吻写', '我用平实的语气解释了范围变化',
    '保留虚构案例标识是他们过去的做法',
  ])('does not turn a reported action into an editorial direction: %s', (source) => {
    expect(materialWritingRequirements(source + '。')).toEqual([]);
  });

  it('keeps audience and separate title directions behind a product exercise note', () => {
    const requirements = materialWritingRequirements('【虚构练习，仅用于产品体验】我是一名独立设计顾问，想写给小团队负责人。题目是“怎样提前沟通”。请写600字左右的公众号文章。');
    expect(requirements).toEqual(['想写给小团队负责人', '题目是“怎样提前沟通”', '请写600字左右的公众号文章']);
    expect(materialAuthorAudience(requirements)).toBe('小团队负责人');
    expect(materialWritingRequirements('客户说：“题目是怎样提前沟通。想写给老板。”')).toEqual([]);
    expect(materialWritingRequirements('【客户原话】我是一名顾问，想写给老板。')).toEqual([]);
  });
  it('recognizes a separately stated audience and length without adopting a customer quotation', () => {
    for (const prefix of ['读者是', '这篇文章的读者是', '受众：']) {
      const requirements = materialWritingRequirements(`${prefix}经常接项目的小团队负责人。请保留客户原话，写600到800字，用第一人称。`);
      expect(materialAuthorAudience(requirements)).toBe('经常接项目的小团队负责人');
      expect(requirements).toContain('写600到800字');
      expect(requirements).toContain('请保留客户原话');
    }
    expect(materialWritingRequirements('客户说：“读者是大学生，写600到800字。”')).toEqual([]);
  });
  it.each([
    '要求：700到1000字，平实直接',
    '这次写一篇700到1000字公众号文章，语气平实，不编造客户故事、收入和效果数据，不增加私信、购买或预约引导',
    '我希望读者记住：把变化讲清楚',
    '这次只想把服务经验写给小团队负责人，做一篇公众号短文',
    '写给没有专职编辑的小团队负责人',
    '字数控制在一千字以内',
    '语气平实一点',
    '请写成一篇公众号文章',
    '不要“赋能、闭环、破局”',
    '不能编造客户对白、成交额、节省比例或成功案例',
    '正文不要使用未经授权的客户姓名',
    '帮我写一篇《给新人的信》，保留温和的语气',
    '不要使用“赋能”和“闭环”',
    '不要使用客户合同截图',
    '不能出现未公开的营收数据',
  ])('preserves %s', (request) => {
    expect(materialWritingRequirements(request + '。').join('，')).toBe(request);
  });
  it('keeps business advice and quoted instructions out of editorial requests', () => {
    expect(materialWritingRequirements('我的观点：不要马上拒绝客户。客户说：“帮我写一篇广告”。我们过去服务过要求特别高的客户。')).toEqual([]);
  });
  it('retains requirements across sentences and numbered notes', () => {
    expect(materialWritingRequirements('1. 要求：700—1000字，平实直接。不能编造数据。\n- 结尾只保留一个动作。\n不引导私信、购买或预约。')).toEqual([
      '要求：700—1000字', '平实直接', '不能编造数据', '结尾只保留一个动作', '不引导私信、购买或预约',
    ]);
  });

  it.each([
    '只做公众号，700至900字，平实一点，不写营销口号、不引导私信或购买，结尾只保留一句行动建议',
    '本次仅做小红书，8张卡片，面向第一次做项目的人',
    '仅写视频号，口播控制在一分钟，结尾不要引导购买',
    '700至900字，语气直接，保留两个具体例子',
  ])('retains the full compound request: %s', (request) => {
    expect(materialWritingRequirements(request + '。').join('，')).toBe(request);
  });

  it('separates the self-introduction from its current writing purpose', () => {
    const request = '想写一篇公众号文章给经常遇到临时加需求的小团队负责人';
    expect(materialWritingRequirements(`我经营一家小型设计工作室，${request}。`)).toEqual([request]);
    expect(materialAuthorAudience([request])).toBe('经常遇到临时加需求的小团队负责人');
  });

  it.each([
    '客户说：“帮我写一篇公众号文章。结尾引导私信。不要出现客户姓名。”',
    '客户说：「只做小红书。\n字数控制在900字。」',
    '客户说："请写一篇文章！结尾引导预约？"',
    "客户说：'请写一篇文章。结尾引导预约。'",
    '我们讨论了客户要求，想写一篇公众号文章给他的客户看',
    '客户要求只做公众号，700至900字，结尾引导购买',
    '我们在项目会上复述需求：“我想分享一个做法。不要引导购买。”',
    '只做公众号运营，暂时不做其他业务',
    '我想把客户服务做成产品，先确定交付范围',
    '请整理客户需求，先确认预算和上线时间',
    '不要使用塑料包装，客户要求纸箱',
    '这次客户说：“不要使用这个标题，结尾要引导购买。”',
  ])('does not promote quoted or operational requests to author directions: %s', (source) => {
    expect(materialWritingRequirements(source + '。')).toEqual([]);
  });

  it('preserves an editorial quotation and decimal numbers without executing the quotation', () => {
    const request = '结尾只保留“先记下变化。再确认范围！”这句话，标题不要夸大';
    expect(materialWritingRequirements(request + '。')).toEqual(['结尾只保留“先记下变化。再确认范围！”这句话', '标题不要夸大']);
    expect(materialSentences('项目报价1,200.50元，分两期。客户说：“请写文章。结尾引导购买。”'))
      .toEqual(['项目报价1,200.50元，分两期', '客户说：“请写文章。结尾引导购买。”']);
    expect(materialClauses('项目报价1,200.50元，引用“增加什么、推迟什么，谁确认”'))
      .toEqual(['项目报价1,200.50元', '引用“增加什么、推迟什么，谁确认”']);
    expect(materialSentences("It's a project note。写给团队负责人。"))
      .toEqual(["It's a project note", '写给团队负责人']);
    expect(materialWritingRequirements('客户说："引用\\"文字\\"。结尾引导购买。"')).toEqual([]);
  });

  it.each([
    ['写给没有专职编辑的创始人', '没有专职编辑的创始人'],
    ['这次只想把服务经验写给小团队负责人，做一篇公众号短文', '小团队负责人'],
    ['我想写一篇关于“给新人写信”的文章给团队负责人', '团队负责人'],
    ['要求：引用客户原话“写给购买者”，结尾保持克制', undefined],
    ['不要写给采购经理，只讲自己的经历', undefined],
    ['要求：不要写给大企业，而是写给独立设计师', '独立设计师'],
  ])('reads the author audience without adopting a quoted audience: %s', (request, audience) => {
    expect(materialAuthorAudience([request!])).toBe(audience);
  });

  it('keeps every paid-user direction separate without splitting an exact quotation', () => {
    expect(materialWritingRequirements('请保留客户那句原话，用第一人称，600到800字，口语但不油腻，不要编造金额、成交结果或客户评价。结尾只保留“一页应该很快吧？”这句原话，不要引导关注、评论或私信。')).toEqual([
      '请保留客户那句原话', '用第一人称', '600到800字', '口语但不油腻', '不要编造金额、成交结果或客户评价',
      '结尾只保留“一页应该很快吧？”这句原话', '不要引导关注、评论或私信',
    ]);
    expect(materialWritingRequirements('客户说：“请保留我的原话，用第一人称，600到800字。”')).toEqual([]);
  });
});
