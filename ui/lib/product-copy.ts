export const PRODUCT_COPY = {
  appName: 'Echo Founder',
  workspaceName: '内容创作工作台',
  pages: {
    production: {
      title: '做本期内容',
      breadcrumbs: ['内容创作', '做本期内容'],
    },
    materials: {
      title: '素材与写作习惯',
      breadcrumbs: ['内容资料', '素材与写作习惯'],
    },
    contentRadar: {
      title: '热门选题',
      breadcrumbs: ['选题分析', '热门选题'],
    },
    benchmarkAdvisor: {
      title: '账号与视频分析',
      breadcrumbs: ['选题分析', '账号与视频分析'],
    },
    publicationDesk: {
      title: '发布准备与记录',
      breadcrumbs: ['内容创作', '发布准备与记录'],
    },
    weeklyReview: {
      title: '文章与发布记录',
      breadcrumbs: ['内容创作', '文章与发布记录'],
    },
    settings: {
      title: '系统设置',
      breadcrumbs: ['系统', '系统设置'],
    },
  },
} as const;

export const PRODUCT_VERSION_DISPLAY = process.env.NEXT_PUBLIC_ECHO_FOUNDER_VERSION?.trim() || '开发构建';

export const PLATFORM_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  wechat: '公众号',
  wechat_mp: '公众号',
  xiaohongshu: '小红书',
  moments: '朋友圈',
  shipinhao: '视频号',
  wechat_channels: '视频号',
  douyin: '抖音',
};

export const CONTENT_RADAR_TIER_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  '立即做': '建议现在做',
  '差异化切入': '换个角度再做',
  '继续观察': '继续观察',
  '暂缓': '暂时不做',
};

export const PRODUCTION_STAGE_DISPLAY_NAMES = {
  'material-boundary': '素材与共享底稿',
  'topic-template': '平台选择与独立研究',
  'content-package': '平台原生内容',
  'visual-assets': '平台完整发布件',
  'draft-information': '检查发布成品',
  'publication-result': '记录发布结果',
  'weekly-review': '每周复盘（可选）',
} as const;

export const PRODUCTION_STATUS_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  queued: '未开始',
  running: '进行中',
  completed: '已完成',
  failed: '失败',
  blocked: '待你确认',
  pending: '未开始',
  skipped: '已完成',
  draft_filled: '已完成',
  retryable_failure: '失败',
  manual_intervention_required: '待你确认',
  unknown_completion: '待你确认',
  published_confirmed: '已完成',
  authorizing: '进行中',
};

export const CREDENTIAL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  product_access: '产品访问码',
  hosted_license: '设备授权码',
  llm: '模型密钥',
  tikomni: '平台数据密钥',
  macos_keychain: 'Mac 登录密码',
};

export const COMMON_ACTION_DISPLAY_NAMES = {
  continueCurrentStep: '继续当前步骤',
  addMaterial: '添加素材',
  findTopics: '查找选题',
  analyzeAccount: '分析账号',
  analyzeVideo: '分析视频',
  generatePublicationContent: '生成所选平台发布内容',
  summarizeWeeklyPublication: '汇总本周发布',
  saveSettings: '保存设置',
  testConnection: '测试连接',
} as const;

export const MACOS_KEYCHAIN_EXPLANATION = '首次保存时，macOS 可能要求输入这台 Mac 的登录密码，以允许应用使用系统钥匙串。不要把密码填进应用。';

export function platformDisplayName(platform: string, fallback?: string): string {
  return PLATFORM_DISPLAY_NAMES[platform] || fallback || platform;
}

export function contentRadarTierDisplayName(tier: string): string {
  return CONTENT_RADAR_TIER_DISPLAY_NAMES[tier] || tier;
}
