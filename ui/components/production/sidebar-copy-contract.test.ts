import { describe, expect, it } from 'vitest';
import { SIDEBAR_COPY_CONTRACT } from '@/components/layout/Sidebar';

describe('left sidebar copy contract', () => {
  it('keeps agreed navigation labels aligned and independent from workbench stage copy', () => {
    expect(SIDEBAR_COPY_CONTRACT).toEqual({
      brand: 'Echo Founder',
      navigationLabel: '主导航',
      sections: {
        workbench: '工作台',
        assets: '内容资产',
        system: '系统',
      },
      workflow: '本期内容生产',
      progress: '当前进度',
      productionStages: {
        '1': '素材入库',
        '2': '公开信息研究、立项与模板',
        '3': '平台原生内容确认',
        '4': '按需视觉效果确认',
        '5': '已选平台成品确认',
        '6': '各平台发布结果',
        '7': '平台复盘与沉淀',
      },
      publicationDesk: {
        number: '05–06',
        label: '平台草稿与发布确认',
      },
      supportItems: [
        '素材与写作习惯',
        '爆款内容雷达',
        '内容对标研究',
        '文章与发布记录',
      ],
      settings: '系统设置',
      expand: '展开侧边栏',
      collapse: '收起侧边栏',
    });
  });
});
