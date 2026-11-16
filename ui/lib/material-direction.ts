/**
 * Client-safe catalog for the single expression-direction choice made at the
 * material entrance. Server validation imports this same module.
 */
export type MaterialTypeId =
  | 'personal-experience'
  | 'interview-event'
  | 'personal-growth'
  | 'work-life-vlog'
  | 'business-growth'
  | 'global-expression';

export type MaterialStructure = {
  id: string;
  title: string;
  description: string;
};

export type MaterialTypeDefinition = {
  id: MaterialTypeId;
  title: string;
  description: string;
  platforms: string[];
  structures: MaterialStructure[];
};

export type MaterialDirection = {
  materialTypeId: MaterialTypeId;
  structureId: string;
};

export const MATERIAL_TYPE_CATALOG: readonly MaterialTypeDefinition[] = [
  {
    id: 'personal-experience',
    title: '个人履历 / 经验 / 知识分享',
    description: '用于建立专业身份和可信背书，适合职业经历、方法论、行业判断和复盘。',
    platforms: ['视频号', '小红书', '公众号'],
    structures: [
      { id: 'experience-turn-method', title: '经历转折 -> 认知变化 -> 方法论', description: '从真实经历切入，落到可复用的方法。' },
      { id: 'review-decision-principle', title: '问题复盘 -> 关键决定 -> 可复用原则', description: '用一次具体选择说明判断标准。' },
      { id: 'judgement-case-action', title: '专业判断 -> 案例验证 -> 行动建议', description: '先给判断，再用案例让读者理解怎么做。' },
    ],
  },
  {
    id: 'interview-event',
    title: '访谈 / 嘉宾出席 / 演讲分享',
    description: '将线下高价值对话沉淀为内容资产，适合活动纪实、观点金句和人物背书。',
    platforms: ['视频号', '公众号', '朋友圈'],
    structures: [
      { id: 'scene-viewpoint-interpretation', title: '现场片段 -> 核心观点 -> 延伸解读', description: '把活动现场的一个瞬间扩展成有立场的内容。' },
      { id: 'quote-collision-stance', title: '嘉宾金句 -> 观点碰撞 -> 个人立场', description: '用对话张力建立自己的判断。' },
      { id: 'issue-dialogue-conclusion', title: '议题拆解 -> 对话实录 -> 可执行结论', description: '保留讨论脉络，也给出下一步做法。' },
    ],
  },
  {
    id: 'personal-growth',
    title: '个人成长 / 人生心得',
    description: '增强真实感和情绪连接，适合讲转折、选择、压力、修复和长期主义。',
    platforms: ['小红书', '视频号', '朋友圈'],
    structures: [
      { id: 'difficulty-turn-choice', title: '具体困境 -> 转折时刻 -> 新选择', description: '从一件难事讲清楚选择为什么改变。' },
      { id: 'pressure-repair-longterm', title: '压力失败 -> 自我修复 -> 长期主义', description: '让恢复过程成为可感知的价值。' },
      { id: 'life-question-story-resonance', title: '人生问题 -> 经验叙事 -> 读者共鸣', description: '用个人经验回应一个很多人正在面对的问题。' },
    ],
  },
  {
    id: 'work-life-vlog',
    title: '日常工作 / 生活 Vlog',
    description: '将碎片化日常变成稳定素材池，适合出差、会议、客户拜访和工作现场。',
    platforms: ['小红书', '视频号', '抖音'],
    structures: [
      { id: 'scene-detail-judgement', title: '场景切片 -> 细节观察 -> 职业判断', description: '从一个细节连接到专业洞察。' },
      { id: 'work-problem-solution', title: '工作片段 -> 问题发生 -> 解决过程', description: '把真实工作过程组织成可追看的叙事。' },
      { id: 'behind-method-insight', title: '幕后过程 -> 方法沉淀 -> 心得', description: '让日常记录沉淀为长期可用的经验。' },
    ],
  },
  {
    id: 'business-growth',
    title: '业务经验 / 产品与服务',
    description: '适合解释客户问题、分享业务方法和说明产品价值；是否引导咨询或购买由本期要求决定。',
    platforms: ['公众号', '小红书', '朋友圈'],
    structures: [
      { id: 'customer-question-method', title: '读者问题 -> 判断依据 -> 做法与适用范围', description: '解释一个具体问题，给出可执行的方法和不适用的情况；不默认添加销售引导。' },
      { id: 'customer-solution-case-cta', title: '客户问题 -> 解决方案 -> 案例与 CTA', description: '从客户视角说明价值和下一步。' },
      { id: 'business-product-conversion', title: '业务判断 -> 产品策略 -> 转化路径', description: '讲清楚为什么这样做，以及如何形成结果。' },
      { id: 'growth-mistake-mechanism-list', title: '增长误区 -> 关键机制 -> 行动清单', description: '用明确的反常识判断建立专业信任。' },
    ],
  },
  {
    id: 'global-expression',
    title: '全球化表达 / 跨境内容',
    description: '面向海外用户、东南亚华人和关注中国市场的专业人士，支持双语内容适配。',
    platforms: ['小红书', '视频号', '抖音'],
    structures: [
      { id: 'global-change-local-action', title: '海外变化 -> 本土影响 -> 行动建议', description: '把外部变化翻译成读者需要的判断。' },
      { id: 'crossculture-case-adaptation', title: '跨文化案例 -> 差异分析 -> 适配方法', description: '不只展示差异，也说明具体如何适配。' },
      { id: 'global-trend-market-opportunity', title: '全球趋势 -> 专业判断 -> 市场机会', description: '用趋势建立判断，再落到实际机会。' },
    ],
  },
] as const;

export function materialDirectionFor(typeId: string, structureId: string): MaterialDirection | null {
  const type = MATERIAL_TYPE_CATALOG.find((item) => item.id === typeId);
  if (!type || !type.structures.some((item) => item.id === structureId)) return null;
  return { materialTypeId: type.id, structureId };
}
