import type { PipelineStep } from './types';

export type PipelinePhase = PipelineStep['phase'];
export type ProductionAutomationMode = 'automatic' | 'semi_automatic' | 'manual_required';

export interface PipelineStepDefinition {
  id: number;
  name: string;
  shortName: string;
  skill: string;
  phase: PipelinePhase;
  phaseLabel: string;
  color: string;
  iconKey: string;
  description: string;
  runtimeSteps: string[];
  outputStages: string[];
  destination: string;
  outputTitle: string;
  outputDescription: string;
  input: string;
  output: string;
  intervention: string;
  automationMode: ProductionAutomationMode;
  humanGate: string;
  blockedReturn: string;
  reviewItems: string[];
  example: string;
  production: boolean;
  autoRunnable: boolean;
}

export const PIPELINE_REGISTRY: PipelineStepDefinition[] = [
  {
    id: 1,
    name: '素材理解',
    shortName: '素材理解',
    skill: 'content-intake',
    phase: 'upstream',
    phaseLabel: '上游加工',
    color: '#E85D4C',
    iconKey: 'fileText',
    description: '读取任意素材，识别场景、人物、观点、情绪、案例与商业意图',
    runtimeSteps: ['intake'],
    outputStages: ['intake'],
    destination: 'pipeline/intake',
    outputTitle: '素材理解报告',
    outputDescription: '提取人物、场景、观点和可用案例。',
    input: '任意素材：文字 / PDF / 链接 / 图片 / 语音转文字',
    output: '结构化素材报告 · pipeline/intake/',
    intervention: '只在系统识别错场景、人物关系不完整，或素材里有隐私信息时介入。',
    automationMode: 'semi_automatic',
    humanGate: '确认授权范围、不可公开信息，以及推断不能被当作事实。',
    blockedReturn: '补原始材料、事实来源或公开范围后重跑素材理解。',
    reviewItems: ['场景识别是否准确', '人物、观点、案例是否抓全', '是否需要删除隐私或敏感细节'],
    example: `主场景：业务 / 产品增长 / 引流获客 + 个人履历混合

核心观点：AI 普及后，创作者的核心壁垒是「诚实说出自己真正相信的东西」

情绪：理性自省 + 温和批判

案例：创作者使用 Claude 写公众号的体验变化
  以前：30% 查资料 + 30% 搭结构 + 40% 改语气
  现在：查资料和搭结构被 AI 加速，改语气时间反而增加`,
    production: true,
    autoRunnable: true,
  },
  {
    id: 2,
    name: '平台研究、立项与内容蓝图',
    shortName: '研究+蓝图',
    skill: 'content-blueprint',
    phase: 'upstream',
    phaseLabel: '上游加工',
    color: '#E85D4C',
    iconKey: 'compass',
    description: '按已选平台分别研究公开样本与爆款机制，完成立项后形成共享事实和平台独立内容蓝图',
    runtimeSteps: ['validate', 'blueprint'],
    outputStages: ['validate', 'blueprint'],
    destination: 'pipeline/blueprint',
    outputTitle: '平台样本分级 + 立项闸门 + 平台内容蓝图',
    outputDescription: '保留样本机制和不可复制边界，再确定判断、证据链、叙事与评论承接。',
    input: '素材理解报告 + 公开样本对标报告',
    output: '平台样本分级报告 · materials/research/；立项报告 · pipeline/validate/；平台内容蓝图 · pipeline/blueprint/',
    intervention: '立项未通过时先补素材；通过后确认蓝图中的核心判断、证据链、商业收口和风险边界。',
    automationMode: 'semi_automatic',
    humanGate: '确认对标只吸收机制而不复制表达，再确认本轮主题、读者、核心判断与证据边界；低证据结论必须补证、降级或放弃。',
    blockedReturn: '立项不通过时回到素材理解，不进入写作。',
    reviewItems: ['是否有公开样本或明确样本不足', '立项结论是否为通过', '蓝图是否明确核心判断、证据链和章节任务', '是否匹配本次主平台与商业边界'],
    example: `共享事实：只保留素材可核验的事实、案例、观点与公开边界。

平台蓝图：公众号、小红书、视频号各自依据本平台样本确定受众入口、选题、结构和承接。

对标边界：只吸收标题机制、叙事入口与评论需求，不复制对标作者的标题、故事或表达。`,
    production: true,
    autoRunnable: true,
  },
  {
    id: 3,
    name: '按需探索：角度与拆解',
    shortName: '探索支线',
    skill: 'content-angle',
    phase: 'upstream',
    phaseLabel: '上游加工',
    color: '#E85D4C',
    iconKey: 'scissors',
    description: '仅在需要比较叙事角度、标题、钩子或平台表达时，生成候选角度并继续拆解',
    runtimeSteps: ['angle', 'breakdown'],
    outputStages: ['angles', 'breakdown'],
    destination: 'pipeline/angles/ + pipeline/breakdown/',
    outputTitle: '按需角度与内容拆解',
    outputDescription: '探索候选角度，再按选定角度拆出标题、钩子和平台结构。',
    input: '已通过的立项报告 + 可选思想母版蓝图',
    output: '候选角度 · pipeline/angles/；可执行拆解方案 · pipeline/breakdown/',
    intervention: '只在需要比较标题、钩子、结构或平台表达方向时调用；不替代默认母版蓝图。',
    automationMode: 'manual_required',
    humanGate: '确认探索结果没有偏离蓝图的核心判断、证据边界和商业承诺后，才把它作为写作补充。',
    blockedReturn: '回到立项或思想母版蓝图，调整判断或补齐证据。',
    reviewItems: ['是否真的需要多角度比较', '标题与钩子是否仍遵守事实边界', '探索结果是否只作为写作补充而非替代蓝图'],
    example: `候选角度：反差冲突 / 身份背书 / 情绪共鸣
拆解使用：选定一个角度后再生成标题、钩子、关键词和平台表达方案。
默认主线不运行此支线。`,
    production: true,
    autoRunnable: false,
  },
  {
    id: 4,
    name: '平台原生内容',
    shortName: '原生内容',
    skill: 'content-package',
    phase: 'midstream',
    phaseLabel: '中游生产',
    color: '#F4A261',
    iconKey: 'penTool',
    description: '从共享事实底稿出发，只为已选平台分别生成原生内容，不做母稿拆解或跨平台改写',
    runtimeSteps: ['package'],
    outputStages: ['package'],
    destination: 'pipeline/package',
    outputTitle: '已选平台原生成稿',
    outputDescription: '按选择交付公众号长文、小红书图文和/或视频号口播执行稿。',
    input: '已确认的共享事实底稿与各平台独立内容蓝图',
    output: '仅包含已选平台的原生成稿 · pipeline/package/',
    intervention: '只在语气不像本人、案例不够真实、或成稿需要重写局部段落时介入。',
    automationMode: 'semi_automatic',
    humanGate: '逐平台校正作者语气、第一手案例和无法验证的断言，并确认没有从其他平台成稿改写。',
    blockedReturn: '证据不足时回到思想母版蓝图；只有需要比较表达方向时才回到按需探索。',
    reviewItems: ['平台章节是否与本期选择完全一致', '表达是否像本人', '案例是否具体可信', '小红书是否含封面三句话、P1-P8 与结尾标签', '视频号是否含口播、镜头、字幕和发布文案'],
    example: `同一份真实素材共享事实与边界，但各平台独立生产：
  · 公众号：原生长文、摘要、头图文案与排版提示
  · 小红书：封面三句话、P1-P8 图文卡片、正文与结尾标签
  · 视频号：一条完整口播、镜头、字幕与发布文案`,
    production: true,
    autoRunnable: true,
  },
  {
    id: 5,
    name: '平台完整发布件',
    shortName: '完整发布件',
    skill: 'content-visual',
    phase: 'midstream',
    phaseLabel: '中游生产',
    color: '#F4A261',
    iconKey: 'image',
    description: '公众号自动生成一张封面、1–3 张正文配图和可复制微信 HTML；小红书生成 P1-P8 图文卡片，视频号单选时自动跳过。',
    runtimeSteps: ['visual'],
    outputStages: ['visual'],
    destination: 'pipeline/visual',
    outputTitle: '公众号完整发布件与小红书图文成品',
    outputDescription: '生成版本化公众号封面、正文配图、微信 HTML、P1-P8 图文卡片与质量结果；修改通过自然语言请求提交。',
    input: '已选平台原生成稿',
    output: '版本化平台成品 · pipeline/visual/{slug}/',
    intervention: '只需描述想改的证据、版式、色彩或视觉系统；系统保留全部版本和质量结果。',
    automationMode: 'semi_automatic',
    humanGate: '整体审核自动生成的一套发布件，必要时提交自然语言修订，并采用质量通过的版本。',
    blockedReturn: '在视觉工作台提交受限修订；不要直接修改配方或绕过质量门。',
    reviewItems: ['公众号是否包含一张封面、1–3 张正文配图和完整可复制 HTML', '小红书是否产出 P1-P8 完整套图', '文字是否与已确认内容一致', '视频号是否未生成额外视觉资产', '成品质量门是否通过'],
    example: `平台完整发布件阶段生成一套可整体确认的结果：
  · 公众号：保留原文与已有图片，生成可以直接查看的微信排版 HTML
  · 小红书：一组 3:4 P1-P8 图文卡片
  · 视频号：保留口播与拍摄稿，不生成视觉封面
  · 修改：描述“公众号换成杂志风”或“小红书减少每页文字”，系统整套生成新版本

用户不直接编辑模板、CSS 或配方 JSON。`,
    production: true,
    autoRunnable: true,
  },
  {
    id: 6,
    name: '平台发布成稿',
    shortName: '发布成稿',
    skill: '',
    phase: 'midstream',
    phaseLabel: '中游生产',
    color: '#F4A261',
    iconKey: 'package',
    description: '只为本期已选的公众号、小红书和视频号准备可复制、上传或拍摄的发布成稿',
    runtimeSteps: [],
    outputStages: ['publish-assets'],
    destination: 'pipeline/publish-assets/{slug}/',
    outputTitle: '平台发布成稿',
    outputDescription: '生成平台后台要填写、复制和上传的发布成稿。',
    input: '已选平台原生成稿 + 图文平台已采用视觉版本（如适用）',
    output: '本期已选平台的发布字段、文件与执行稿',
    intervention: '只在想更换公众号 HTML 风格、观点图文页序、封面或视频发布文案时介入。',
    automationMode: 'semi_automatic',
    humanGate: '确认实际准备上传的平台字段、标签和选择的视觉版本。',
    blockedReturn: '内容或承诺不一致时回到平台发布稿生成或视觉配方。',
    reviewItems: ['主界面是否只展示已选平台', '公众号是否有标题、摘要、完整 HTML 与配图', '小红书是否有正文、标签、页序与卡片', '视频号是否有提词器、镜头、字幕与发布文案'],
    example: `平台发布成稿应让用户一眼看到：
  · 公众号：推荐标题、摘要、推荐 HTML、封面/首图/正文配图状态
  · 小红书：一组原生图文的封面三句话、正文、P1-P8、标签与互动
  · 视频号：一份原生口播的提词器、镜头、字幕与发布文案
完整路径、HTML 总览和生成文件清单保留在高级归档。`,
    production: true,
    autoRunnable: true,
  },
  {
    id: 7,
    name: '可信审核',
    shortName: '可信审核',
    skill: 'content-audit',
    phase: 'midstream',
    phaseLabel: '中游生产',
    color: '#F4A261',
    iconKey: 'shieldCheck',
    description: '来源追溯、事实校验、隐私提醒、平台风险识别和修改建议',
    runtimeSteps: ['prelaunch', 'compliance', 'audit'],
    outputStages: ['prelaunch', 'compliance', 'audit'],
    destination: 'pipeline/audit',
    outputTitle: '可信审核',
    outputDescription: '检查事实、来源、隐私和平台风险。',
    input: '成稿',
    output: '审核报告 · pipeline/audit/',
    intervention: '这一步建议人工复核，尤其是事实、数字、引用来源和平台风险。',
    automationMode: 'semi_automatic',
    humanGate: '发布负责人逐项确认数字、引用、隐私、合规修改和最终发布版本。',
    blockedReturn: '任一硬风险回到写作、发布稿或视觉步骤修复，不生成发布记录。',
    reviewItems: ['硬数字是否有来源', '人物隐私是否处理干净', '平台敏感表达是否需要替换'],
    example: `来源追溯：
  ⚠️ 「三成/三成/四成」精力分配 → 个人估算，建议标注
  ⚠️ 「AI 一秒钟生成一百句」→ 修辞表达，建议替换为「大量」

隐私提醒：
  ✅ 文中人物已匿名化处理

平台风险：
  ✅ 未发现明显违禁词
  ℹ️ 「卧槽」一词出现 2 次，公众号语境可接受`,
    production: true,
    autoRunnable: true,
  },
  {
    id: 8,
    name: '数据复盘',
    shortName: '数据复盘',
    skill: 'content-review',
    phase: 'downstream',
    phaseLabel: '下游沉淀',
    color: '#1C1C1E',
    iconKey: 'barChart3',
    description: '基于发布数据做表现记录、评论洞察和下一条建议',
    runtimeSteps: ['publish', 'review'],
    outputStages: ['publish', 'review'],
    destination: 'pipeline/review',
    outputTitle: '数据复盘',
    outputDescription: '读取发布记录和平台反馈，生成复盘报告。',
    input: '发布数据',
    output: '复盘报告 · pipeline/review/',
    intervention: '需要补充真实发布数据、评论截图或用户反馈后再运行。',
    automationMode: 'manual_required',
    humanGate: '真人完成平台发布、账号授权或数据补录；复盘前确认数据属于当前内容。',
    blockedReturn: '没有真实链接、时间或同 run 数据时保持阻断，不用模拟数据补齐。',
    reviewItems: ['数据是否来自真实平台后台', '评论是否覆盖正反反馈', '下一条选题是否可执行'],
    example: `表现记录：阅读量、点赞、评论、转发、收藏率

评论洞察：
  · 高频问题归类
  · 用户情绪倾向
  · 最有价值的反馈

下一条建议：
  · 延续「人味/诚实」主题
  · 补充更具体的个人写作场景`,
    production: false,
    autoRunnable: false,
  },
  {
    id: 9,
    name: '自我沉淀',
    shortName: '自我沉淀',
    skill: 'self-archive',
    phase: 'downstream',
    phaseLabel: '下游沉淀',
    color: '#1C1C1E',
    iconKey: 'archive',
    description: '沉淀风格库、案例库、禁区清单，形成可复用创作资产',
    runtimeSteps: ['archive'],
    outputStages: ['archive'],
    destination: 'pipeline/archive',
    outputTitle: '自我沉淀',
    outputDescription: '把最终版和复盘结论沉淀为案例、风格和禁区。',
    input: '成稿 + 数据 + 反馈',
    output: '归档记录 · pipeline/archive/',
    intervention: '需要确认哪些表达、案例和禁区值得长期沉淀到个人资产库。',
    automationMode: 'semi_automatic',
    humanGate: '确认哪些案例、表达和禁区已经被真实反馈验证，值得长期复用。',
    blockedReturn: '反馈不足时回到数据复盘；未发布内容只能作为待验证观察归档。',
    reviewItems: ['这次内容沉淀了什么风格', '哪些案例以后还能复用', '哪些表达应加入禁区'],
    example: `更新 brain/style-evolution.md：
  · 新增「人味」主题表达偏好
  · 强化「反直觉观察」开头技法

更新 brain/case-library.md：
  · 收录「AI 让创作者更诚实」案例

更新 brain/taboo-list.md：
  · 避免将个人估算表述为行业普遍数据`,
    production: false,
    autoRunnable: false,
  },
  {
    id: 10,
    name: '数字孪生观察（风格沉淀）',
    shortName: '数字孪生',
    skill: 'content-twin',
    phase: 'downstream',
    phaseLabel: '下游沉淀',
    color: '#1C1C1E',
    iconKey: 'scanFace',
    description: '观察已发布成品，提炼可复用的内容 DNA、结构模式与表达特征，沉淀到 brain/twin/',
    runtimeSteps: ['twin'],
    outputStages: ['twin'],
    destination: 'pipeline/twin',
    outputTitle: '孪生观察',
    outputDescription: '只观察最终发布版，提炼稳定表达模式。',
    input: '最终发布版 · pipeline/final 或 pipeline/xhs/',
    output: '观察报告 + brain/twin/ 内容自我镜像',
    intervention: '写入记忆前必须选择最终发布版；粘贴文本只能用于只读观察，避免草稿污染长期风格。',
    automationMode: 'semi_automatic',
    humanGate: '选择最终发布版，并确认只有带证据的稳定模式进入长期内容记忆。',
    blockedReturn: '草稿只可只读观察；证据不足时回到归档或复盘补证。',
    reviewItems: ['是否选择公众号/小红书最终成稿', '是否只从已发布内容提炼稳定模式', '是否避免把中间草稿写入记忆层'],
    example: `内容 DNA 提取：
  · 核心主题：AI 工具普及后，创作者核心竞争力转向诚实表达与人味
  · 情绪基调：理性自省 + 温和批判
  · 叙事视角：第一人称亲历

可复用模式：
  · 结构：个人体验 → 反直觉发现 → 概念定义 → 行业推论 → 金句收尾
  · 标志性句式：「不是……不是……我想的是……」
  · 过渡方式：「故事是这样的。」「我举个例子。」`,
    production: false,
    autoRunnable: false,
  },
];

export const PIPELINE_STEPS: PipelineStep[] = PIPELINE_REGISTRY.map((step) => ({
  id: step.id,
  name: step.name,
  skill: step.skill,
  phase: step.phase,
  description: step.description,
  status: 'pending',
  logs: [],
}));

export const AUTOMATION_STEPS = PIPELINE_REGISTRY.filter((step) => step.autoRunnable).map((step) => step.id);
export const TASK_PACKAGE_STEPS = PIPELINE_REGISTRY.map((step) => step.id);
export const PRODUCTION_STEP_COUNT = PIPELINE_REGISTRY.filter((step) => step.production).length;

export const REQUIRED_HANDOFFS: Record<number, number[]> = {
  2: [1],
  3: [1, 2],
  4: [2],
  5: [4],
  6: [4, 5],
  7: [4, 6],
};

export const OUTPUT_STAGE_META = Object.fromEntries(
  PIPELINE_REGISTRY.map((step) => [
    step.id,
    {
      title: step.outputTitle,
      description: step.outputDescription,
      destination: step.destination,
    },
  ])
) as Record<number, { title: string; description: string; destination: string }>;

export const SKILL_NAMES: Record<string, string> = {
  'content-intake': '素材理解',
  'content-validate': '选题立项',
  'content-blueprint': '思想母版蓝图',
  'content-angle': '角度生成',
  'content-breakdown': '内容拆解',
  'wechat-writer': '公众号写作',
  'content-package': '平台原生内容',
  'xhs-card': '小红书图文',
  'content-visual': '视觉计划',
  'content-audit': '可信审核',
  'content-prelaunch': '发布前检查',
  'content-compliance': '平台合规',
  'content-review': '数据复盘',
  'self-archive': '自我沉淀',
  'content-twin': '数字孪生观察（风格沉淀）',
  'content-repurpose': '跨平台改编',
  'content-dbs-fusion': 'DBS 融合',
  'aihot': 'AI 热点',
  'hv-analysis': '横纵分析',
  'deep-research': '深度研究',
};

export const SKILL_OUTPUT_STAGE: Record<string, string> = {
  'content-intake': 'intake',
  'content-validate': 'validate',
  'content-blueprint': 'blueprint',
  'content-angle': 'angles',
  'content-breakdown': 'breakdown',
  'wechat-writer': 'final',
  'content-package': 'package',
  'content-visual': 'visual',
  'content-audit': 'audit',
  'content-prelaunch': 'prelaunch',
  'content-compliance': 'compliance',
  'content-review': 'review',
  'self-archive': 'archive',
  'content-twin': 'twin',
  'content-repurpose': 'platform-adapt',
  'content-dbs-fusion': 'dbs-fusion',
  'xhs-card': 'visual',
};

export const SKILL_RUNTIME_STEP: Record<string, string> = {
  'content-intake': 'intake',
  'content-validate': 'validate',
  'content-blueprint': 'blueprint',
  'content-angle': 'angle',
  'content-breakdown': 'breakdown',
  'wechat-writer': 'write',
  'content-package': 'package',
  'content-visual': 'visual',
  'content-audit': 'audit',
  'content-prelaunch': 'prelaunch',
  'content-compliance': 'compliance',
  'content-review': 'review',
  'self-archive': 'archive',
  'content-twin': 'twin',
  'content-repurpose': 'platform-adapt',
  'content-dbs-fusion': 'dbs-fusion',
  'xhs-card': 'visual',
};

const RUNTIME_TO_STEP = new Map<string, number>();
const STAGE_TO_STEP = new Map<string, number>();

for (const step of PIPELINE_REGISTRY) {
  for (const runtimeStep of step.runtimeSteps) RUNTIME_TO_STEP.set(runtimeStep, step.id);
  for (const stage of step.outputStages) STAGE_TO_STEP.set(stage, step.id);
}

export function getStepDefinition(stepId: number): PipelineStepDefinition | undefined {
  return PIPELINE_REGISTRY.find((step) => step.id === stepId);
}

export function getStepIdByRuntimeStep(runtimeStep: string | null | undefined): number | null {
  if (!runtimeStep) return null;
  return RUNTIME_TO_STEP.get(runtimeStep) ?? null;
}

export function getStepIdByOutputPath(path: string): number | null {
  const stage = path.split('/')[1];
  if (!stage) return null;
  return STAGE_TO_STEP.get(stage) ?? null;
}

export function getRuntimeStepByOutputPath(path: string): string | null {
  const stage = path.split('/')[1];
  if (!stage) return null;
  for (const step of PIPELINE_REGISTRY) {
    const stageIndex = step.outputStages.indexOf(stage);
    if (stageIndex >= 0) return step.runtimeSteps[stageIndex] ?? step.runtimeSteps[0] ?? null;
  }
  if (stage === 'validate') return 'validate';
  if (stage === 'publish') return 'publish';
  return null;
}

export function getRuntimeStepForStepId(stepId: number, latestFiles: Record<string, string | null | undefined>): string | null {
  const step = getStepDefinition(stepId);
  if (!step) return null;
  void latestFiles;
  // Grouped UI steps are complete only at their terminal artifact. Returning an
  // earlier file here turns a partial validate/write/prelaunch into a completed
  // topic, package, or release-gate group during state hydration.
  return step.runtimeSteps.at(-1) ?? null;
}

export function getOutputStageBySkill(skill: string | null | undefined): string {
  if (!skill) return 'final';
  const explicitStage = SKILL_OUTPUT_STAGE[skill];
  if (explicitStage) return explicitStage;
  const step = PIPELINE_REGISTRY.find((item) => item.skill === skill);
  return step?.outputStages[0] ?? 'final';
}

export function getRuntimeStepBySkill(skill: string | null | undefined): string {
  if (!skill) return 'write';
  const explicitStep = SKILL_RUNTIME_STEP[skill];
  if (explicitStep) return explicitStep;
  const step = PIPELINE_REGISTRY.find((item) => item.skill === skill);
  return step?.runtimeSteps[0] ?? 'write';
}

export function getFileStageLabel(path: string): string {
  const step = getStepDefinition(getStepIdByOutputPath(path) || 0);
  if (step) return step.outputTitle.replace(/报告|方案|清单/g, '') || step.shortName;
  return path.split('/')[1] || '产物';
}

export function getPhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    setup: '系统设置',
    upstream: '上游加工',
    midstream: '中游生产',
    downstream: '下游沉淀',
  };
  return labels[phase] || phase;
}

export function getPhaseColor(phase: string): string {
  const colors: Record<string, string> = {
    setup: '#6B6B6B',
    upstream: '#E85D4C',
    midstream: '#F4A261',
    downstream: '#1C1C1E',
  };
  return colors[phase] || '#6B6B6B';
}
