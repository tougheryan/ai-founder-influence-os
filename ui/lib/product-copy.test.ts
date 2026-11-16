import { describe, expect, it } from 'vitest';
import {
  PLATFORM_DISPLAY_NAMES,
  MACOS_KEYCHAIN_EXPLANATION,
  COMMON_ACTION_DISPLAY_NAMES,
  PRODUCTION_STAGE_DISPLAY_NAMES,
  PRODUCTION_STATUS_DISPLAY_NAMES,
  PRODUCT_COPY,
  contentRadarTierDisplayName,
  platformDisplayName,
} from './product-copy';

describe('product display copy', () => {
  it('uses plain page names that match the work users do', () => {
    expect(Object.values(PRODUCT_COPY.pages).map((page) => page.title)).toEqual([
      '做本期内容',
      '素材与写作习惯',
      '热门选题',
      '账号与视频分析',
      '发布准备与记录',
      '文章与发布记录',
      '系统设置',
    ]);
  });

  it('keeps the primary actions as verb plus object', () => {
    expect(Object.values(COMMON_ACTION_DISPLAY_NAMES)).toEqual([
      '继续当前步骤',
      '添加素材',
      '查找选题',
      '分析账号',
      '分析视频',
      '生成所选平台发布内容',
      '汇总本周发布',
      '保存设置',
      '测试连接',
    ]);
  });

  it('shows familiar platform names while keeping aliases internal', () => {
    expect(platformDisplayName('wechat')).toBe('公众号');
    expect(platformDisplayName('wechat_mp')).toBe('公众号');
    expect(platformDisplayName('xiaohongshu')).toBe('小红书');
    expect(platformDisplayName('moments')).toBe('朋友圈');
    expect(platformDisplayName('shipinhao')).toBe('视频号');
    expect(platformDisplayName('wechat_channels')).toBe('视频号');
    expect(platformDisplayName('douyin')).toBe('抖音');
    expect(platformDisplayName('unknown', '其他平台')).toBe('其他平台');
    expect(Object.values(PLATFORM_DISPLAY_NAMES)).not.toContain('内容源');
  });

  it('turns internal opportunity tiers into decisions users can act on', () => {
    expect(contentRadarTierDisplayName('立即做')).toBe('建议现在做');
    expect(contentRadarTierDisplayName('差异化切入')).toBe('换个角度再做');
    expect(contentRadarTierDisplayName('暂缓')).toBe('暂时不做');
  });

  it('keeps internal production ids while showing task-based labels', () => {
    expect(Object.values(PRODUCTION_STAGE_DISPLAY_NAMES)).toEqual([
      '素材与共享底稿',
      '平台选择与独立研究',
      '平台原生内容',
      '平台完整发布件',
      '检查发布成品',
      '记录发布结果',
      '每周复盘（可选）',
    ]);
    expect(PRODUCTION_STATUS_DISPLAY_NAMES.pending).toBe('未开始');
    expect(PRODUCTION_STATUS_DISPLAY_NAMES.manual_intervention_required).toBe('待你确认');
    expect(new Set(Object.values(PRODUCTION_STATUS_DISPLAY_NAMES))).toEqual(
      new Set(['未开始', '进行中', '待你确认', '已完成', '失败']),
    );
  });

  it('uses one clear macOS password explanation wherever Keychain is involved', () => {
    expect(MACOS_KEYCHAIN_EXPLANATION).toBe(
      '首次保存时，macOS 可能要求输入这台 Mac 的登录密码，以允许应用使用系统钥匙串。不要把密码填进应用。',
    );
  });
});
