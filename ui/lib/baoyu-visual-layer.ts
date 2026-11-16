export type BaoyuPlatformKind = 'wechat' | 'xhs';

export type BaoyuVisualAsset = {
  assetId: string;
  designLayer: string;
  executionTool: string;
  format: string;
  size: string;
  coreCopy: string;
  outputPath: string;
  promptPath: string;
  baoyuPreset: string;
  baoyuSpec: string;
};

export type BaoyuVisualLayer = {
  platformKind: BaoyuPlatformKind;
  designSystem: string;
  palette: string;
  typography: string;
  layout: string;
  bridgeRule: string;
  promptPolicy: string;
  rasterPolicy: string;
  assets: BaoyuVisualAsset[];
};

function detectPlatformKind(platformLabel: string, sourcePath: string): BaoyuPlatformKind {
  const signal = `${platformLabel} ${sourcePath}`;
  if (/小红书|xhs|xiaohongshu/i.test(signal)) return 'xhs';
  return 'wechat';
}

function commonVisualLanguage(kind: BaoyuPlatformKind): Pick<BaoyuVisualLayer, 'designSystem' | 'palette' | 'typography' | 'layout'> {
  if (kind === 'xhs') {
    return {
      designSystem: 'Baoyu xhs-images + infographic：把观点拆成封面、清单卡、对比卡和结尾 CTA。',
      palette: '主色 #141413 墨黑；背景 #FAF9F5 暖白；辅助 #F2D9C7 柔橙；强调 #D97757 暖橙；校验色 #6A9BCC 克制蓝。',
      typography: '封面使用 Noto Sans SC Heavy；正文卡使用 Noto Sans SC Medium；标签和注释使用 Noto Sans SC Regular。',
      layout: '3:4 卡片网格；封面强标题居中，正文卡片左对齐清单，所有文字进入移动端安全区。',
    };
  }

  return {
    designSystem: 'md2wechat + Baoyu cover-image + article-illustrator：公众号正文排版以本机 md2wechat 主题为准，封面和插图沿用同一套 editorial 视觉语法。',
    palette: '主色 #141413 墨黑；背景 #FAF9F5 暖白；辅助 #E8E6DC 浅灰；强调 #D97757 暖橙；次强调 #6A9BCC 克制蓝。',
    typography: '中文标题使用 Noto Sans SC Bold；正文与说明使用 Noto Sans SC Regular；英文和路径使用 Inter / SF Mono。',
    layout: '21:9 封面左右分栏；首图承接导语；正文插图嵌入关键小节；HTML 使用任务中已确认的 md2wechat 主题。',
  };
}

function wechatAssets(slug: string): BaoyuVisualAsset[] {
  return [
    {
      assetId: 'wechat-html',
      designLayer: 'md2wechat',
      executionTool: 'md2wechat',
      format: 'HTML',
      size: '1 个已确认主题的完整公众号排版',
      coreCopy: '使用任务中已确认的 md2wechat API 主题生成公众号 HTML',
      outputPath: `pipeline/visual/${slug}/publish/{revision}/wechat/wechat-article.html`,
      promptPath: `pipeline/visual/${slug}/prompts/01-wechat-md2wechat-layout.md`,
      baoyuPreset: 'mode=api, theme=<selected-md2wechat-theme>, lang=zh',
      baoyuSpec: '只生成已确认主题对应的一份公众号 HTML；md2wechat 不可用时使用 Echo Founder 单一基础排版回退。',
    },
    {
      assetId: 'wechat-cover-21x9',
      designLayer: 'baoyu-cover-image',
      executionTool: 'xhs-card / baoyu-cover-image',
      format: 'PNG',
      size: '21:9 / 900x383',
      coreCopy: '公众号封面：标题主视觉 + 文章核心冲突',
      outputPath: `pipeline/visual/${slug}/wechat-cover-21x9.png`,
      promptPath: `pipeline/visual/${slug}/prompts/03-wechat-cover-21x9.md`,
      baoyuPreset: 'type=metaphor, palette=elegant, rendering=hand-drawn, text=title-subtitle, mood=balanced, font=clean',
      baoyuSpec: '用 baoyu-cover-image 的 metaphor/hand-drawn/elegant 规则生成主视觉提示词；公众号尺寸按 21:9 适配，不能用装饰性渐变替代主体隐喻。',
    },
    {
      assetId: 'wechat-sharecard-1x1',
      designLayer: 'baoyu-cover-image',
      executionTool: 'xhs-card / baoyu-cover-image',
      format: 'PNG',
      size: '1:1 / 500x500',
      coreCopy: '公众号分享卡：短标题 + 单一视觉符号',
      outputPath: `pipeline/visual/${slug}/wechat-sharecard-1x1.png`,
      promptPath: `pipeline/visual/${slug}/prompts/04-wechat-sharecard-1x1.md`,
      baoyuPreset: 'type=conceptual, palette=warm, rendering=flat-vector, text=title-only, mood=subtle, font=clean',
      baoyuSpec: '用 baoyu-cover-image 的 conceptual/flat-vector 规则压缩成单一视觉符号，文字不超过两行。',
    },
    {
      assetId: 'wechat-first-image',
      designLayer: 'baoyu-article-illustrator',
      executionTool: 'ian-xiaohei-illustrations',
      format: 'PNG',
      size: '16:9 / 公众号正文首图',
      coreCopy: '公众号首图：把导语中的核心冲突转成一眼能懂的视觉隐喻',
      outputPath: `pipeline/visual/${slug}/wechat-first-image.png`,
      promptPath: `pipeline/visual/${slug}/prompts/05-wechat-first-image.md`,
      baoyuPreset: 'type=scene, style=editorial, palette=warm, density=balanced',
      baoyuSpec: '首图必须服务导语，不做装饰图；图注写入 HTML 配图槽位。',
    },
    {
      assetId: 'wechat-inline-illustrations',
      designLayer: 'baoyu-article-illustrator',
      executionTool: 'ian-xiaohei-illustrations',
      format: 'PNG set',
      size: '16:9 / 2-4 张正文配图',
      coreCopy: '公众号正文配图：分别嵌入关键小节，承接框架、对比和证据等级',
      outputPath: `pipeline/visual/${slug}/inline-illustrations/`,
      promptPath: `pipeline/visual/${slug}/prompts/06-wechat-inline-illustrations.md`,
      baoyuPreset: 'type=framework, style=minimal, palette=warm, density=balanced',
      baoyuSpec: '用 baoyu-article-illustrator 判断插图位置和信息结构，再交给 ian-xiaohei-illustrations 保持 Echo Founder 小黑 IP；每张图必须写明对应正文小节。',
    },
  ];
}

function xhsAssets(slug: string): BaoyuVisualAsset[] {
  return [
    {
      assetId: 'xhs-home-cover',
      designLayer: 'baoyu-xhs-images',
      executionTool: 'xhs-card',
      format: 'PNG',
      size: '3:4 / 1242x1660',
      coreCopy: '小红书首页图：封面三行文案 + 主题主视觉',
      outputPath: `pipeline/visual/${slug}/xhs-home-cover.png`,
      promptPath: `pipeline/visual/${slug}/prompts/01-xhs-cover.md`,
      baoyuPreset: 'preset=warning, style=bold, layout=sparse, palette=warm',
      baoyuSpec: '用 baoyu-xhs-images 的 warning/sparse 做封面钩子，标题必须进入移动端安全区。',
    },
    {
      assetId: 'xhs-carousel',
      designLayer: 'baoyu-xhs-images',
      executionTool: 'xhs-card',
      format: 'PNG set',
      size: '3:4 / 6-8 张',
      coreCopy: '能写、不能写、要补证的清单卡片',
      outputPath: `pipeline/visual/${slug}/xhs-carousel/`,
      promptPath: `pipeline/visual/${slug}/prompts/02-xhs-carousel.md`,
      baoyuPreset: 'preset=knowledge-card, style=notion, layout=dense, palette=macaron',
      baoyuSpec: '用 baoyu-xhs-images 的 knowledge-card/dense 把步骤拆成收藏型图文卡，第二页开始保持 image-1 风格锚点。',
    },
    {
      assetId: 'xhs-copy-tags',
      designLayer: 'baoyu-xhs-images',
      executionTool: 'publish-assets',
      format: 'MD',
      size: '正文笔记 + 标签 + 评论区承接',
      coreCopy: '小红书发布文案：正文、标签和评论区承接与卡片页一致',
      outputPath: `pipeline/publish-assets/${slug}/xiaohongshu-copy.md`,
      promptPath: `pipeline/visual/${slug}/prompts/03-xhs-copy-tags.md`,
      baoyuPreset: 'copy=rednote-body, tag_count=6-10, tone=useful-not-salesy',
      baoyuSpec: '正文文案不能和卡片主张脱节；标签从标题、痛点、平台和人群中提取，不堆无关热词。',
    },
    {
      assetId: 'xhs-comparison',
      designLayer: 'baoyu-infographic',
      executionTool: 'xhs-card',
      format: 'PNG',
      size: '3:4 / comparison',
      coreCopy: '对比卡：真实证据 / 公开补证 / 只能表达观点',
      outputPath: `pipeline/visual/${slug}/xhs-comparison.png`,
      promptPath: `pipeline/visual/${slug}/prompts/04-infographic-comparison.md`,
      baoyuPreset: 'layout=binary-comparison, style=hand-drawn-edu, aspect=3:4, lang=zh',
      baoyuSpec: '用 baoyu-infographic 的 binary-comparison 做证据等级对比，避免把弱证据包装成事实证明。',
    },
    {
      assetId: 'inline-illustration',
      designLayer: 'baoyu-article-illustrator',
      executionTool: 'ian-xiaohei-illustrations',
      format: 'PNG',
      size: '16:9',
      coreCopy: '小黑手绘：作者面对缺失证据拼图',
      outputPath: `pipeline/visual/${slug}/inline-xiaohei.png`,
      promptPath: `pipeline/visual/${slug}/prompts/05-article-illustration.md`,
      baoyuPreset: 'type=scene, style=warm, palette=warm, density=minimal',
      baoyuSpec: '用 baoyu-article-illustrator 的 scene/warm 生成隐喻，再交给小黑风格保持账号识别。',
    },
  ];
}

export function buildBaoyuVisualLayer(input: {
  slug: string;
  platformLabel: string;
  sourcePath: string;
  imageType?: string;
}): BaoyuVisualLayer {
  const platformKind = detectPlatformKind(input.platformLabel, input.sourcePath);
  const visualLanguage = commonVisualLanguage(platformKind);
  const assets = platformKind === 'xhs' ? xhsAssets(input.slug) : wechatAssets(input.slug);

  return {
    platformKind,
    ...visualLanguage,
    bridgeRule: 'Echo Founder 负责产物契约、路径、Manifest 和质量门；Baoyu 负责风格、版式、色彩、文字密度和提示词纪律；执行工具负责真实落盘。',
    promptPolicy: `每个视觉资产必须先写入独立 prompt 文件，再调用生成或排版工具；计划阶段只登记 ${input.imageType || '封面/卡片/插图'} 的 prompt 路径，不声称文件已经存在。`,
    rasterPolicy: '需要 PNG/JPG 时必须走真实 raster 后端，优先使用 Codex native imagegen；不能用 SVG/HTML/canvas 冒充位图；生成图中文字错误时重写 prompt 后重生成，不能涂改位图。',
    assets,
  };
}
