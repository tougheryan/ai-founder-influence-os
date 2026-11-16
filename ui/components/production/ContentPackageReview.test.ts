import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { contentSections } from '@/lib/content-editing';
import {
  displayReviewError,
  isContentPackageReviewReady,
  parseContentPackageReview,
  VideoReview,
  OpinionReview,
  type ContentPackageReviewChecks,
} from './ContentPackageReview';

const readerProps = { path: 'pipeline/package/native.md', sha256: 'a'.repeat(64), native: true,
  checked: false, expanded: true, total: 1, position: 1, onToggle: () => {}, onChange: () => {}, onEditSelection: () => {} };

function video(index: number): string {
  return `### 短视频 ${index}：短视频判断 ${index}
- 适用平台：视频号、抖音、小红书
- 发布标题：短视频标题 ${index}
- 封面字：口播重点 ${index}
- 3 秒钩子：先说一个具体的反差。
- 时长：45-60 秒

#### 分段口播稿
- 开场：先说一个具体的反差。
- 展开：讲清客户的场景和卡点。
- 转折：给出一个可执行的判断。
- 收口：留下一个可以回答的问题。

#### 逐句口播稿
| 时间段 | 口播文案 | 屏幕字幕 | 对应画面 |
|---|---|---|---|
| 0-3 秒 | 先说一个具体的反差。 | 反差 | 正面近景 |
| 4-15 秒 | 讲清客户场景。 | 客户场景 | 白板 |

#### 镜头清单
| 时间段 | 镜头/画面 | 口播/字幕 | 景别/动作 |
|---|---|---|---|
| 0-3 秒 | 正面近景 | 反差 | 直视镜头 |

#### 字幕重点
- 客户先看见自己的问题。
- 先说场景，再给方法。

#### B-roll 素材建议
- 白板上写出客户场景的过程。
- 已授权的工作笔记特写。

#### 平台发布表单
- 视频号标题：视频号标题 ${index}
- 视频号发布文案：完整保留客户场景和评论问题。
- 视频号话题：#内容表达 #客户问题
- 抖音标题：抖音标题 ${index}
- 抖音发布文案：前三秒先说反差。
- 抖音话题：#口播 #客户洞察
- 小红书视频标题：小红书视频标题 ${index}
- 小红书视频正文：补充可收藏的方法和场景。
- 小红书标签：#小红书 #内容表达 #客户问题
- 默认封面画面：正面近景，左侧放口播重点。`;
}

function opinion(index: number): string {
  const pages = Array.from({ length: 5 }, (_, page) => (
    `| P${page + 1} | 页卡标题 ${index}-${page + 1} | 第 ${page + 1} 页解释本条观点。 | 概念图解与关键词 | 标题加重点词 | 留白突出判断 |`
  )).join('\n');
  return `### 图文 ${index}：观点图文 ${index}
- 核心观点：先让客户看见自己的问题，再说方法。
- 适用平台：公众号、朋友圈、小红书
- 发布标题：观点图文标题 ${index}
- 封面字：观点重点 ${index}
- 分享文案：一段可以直接发布的观点文案。

#### 页卡脚本
| 页码 | 页面标题 | 页面正文 | 画面/配图建议 | 视觉层级 | 排版重点 |
|---|---|---|---|---|---|
${pages}

#### 平台发布稿
- 公众号文内标题：公众号观点标题 ${index}
- 公众号配文：把判断放在文章正文之后。
- 朋友圈图序：P1、P3、P5
- 朋友圈短文案：先让客户看见自己的问题。
- 小红书标题：小红书观点标题 ${index}
- 小红书正文：完整说明场景、判断和收藏价值。
- 小红书标签：#内容表达 #客户问题 #创始人`;
}

const PACKAGE = `# 最终内容 · 内容包审阅测试

## 1. 公众号母稿
- 发布标题：第一篇内容别急着介绍自己
- 标题备选：客户先看什么；别急着证明自己
- 封面字：先说客户问题
- 摘要：客户先判断你是否理解他的处境。
- 公众号排版提示：开头短段，重点判断使用引用卡。
- 配图位建议：在两个核心判断后各放一张概念图。

### 正文
#### 先说客户问题
客户先判断你有没有理解他的处境。

> 第一篇内容不是简历，客户先看你是否懂他的处境。

#### 再说你的方法
先写客户、卡点和下一步。

### 评论区引导
- 置顶评论：你现在最难说清的是哪个客户问题？

## 2. 短视频内容
${video(1)}

${video(2)}

## 3. 图文内容
${opinion(1)}

${opinion(2)}

${opinion(3)}`;

const NATIVE_VIDEO_PACKAGE = `# 平台原生内容 · 视频号审阅测试

## 0. 共享事实底稿
- 本期平台：视频号
- 事实与案例：客户需要先看见自己的问题。

## 3. 视频号原生口播
- 发布标题：客户为什么划走
- 3秒钩子：客户划走，不一定是你不专业。
- 建议时长：60秒

### 逐句口播稿
| 时间段 | 口播文案 | 屏幕字幕 | 对应画面 |
|---|---|---|---|
| 0-60秒 | 先说客户的问题，再介绍你的方法。 | 客户问题优先 | 正面口播 |

### 镜头清单
| 时间段 | 镜头/动作 | 画面目的 |
|---|---|---|
| 0-60秒 | 正面口播 | 表达判断 |

### 字幕重点
- 核心判断：客户问题优先

### B-roll 建议
- 白板上的客户问题清单

### 发布文案
- 简介：先说客户问题，再介绍方法。
- 话题：#视频号
- 置顶评论：你的客户最常卡在哪里？`;

function nativeXhsPackage(pages = Array.from({ length: 8 }, (_, index) => (
  `| P${index + 1} | ${index === 0 ? '封面钩子' : index === 7 ? '互动收口' : '观点展开'} | 页面标题 ${index + 1} | 页面正文 ${index + 1} | 统一色板与构图提示 ${index + 1} |`
)).join('\n')): string {
  return `# 平台原生内容 · 小红书审阅测试

## 0. 共享事实底稿
- 本期平台：小红书
- 事实与案例：客户需要先看见自己的问题。

## 2. 小红书原生图文
### 封面三句话
- 主句：别先写履历
- 副句：客户先看问题
- 补充句：第一条内容这样写

### 图文卡片脚本
| 页码 | 页面任务 | 页面标题 | 页面正文 | 视觉提示 |
|---|---|---|---|---|
${pages}

### 发布正文
- 标题：第一条内容，别急着写履历
- 正文：客户先判断你是否理解他的处境，再判断你的方法是否值得相信。
- 结尾问题：你现在最难说清哪个客户问题？

### 结尾标签
#小红书 #内容表达 #客户洞察`;
}

describe('native platform reading and selection controls', () => {
  it('uses the same platform aliases and heading fields at final review, without accepting conflicts', () => {
    const source = NATIVE_VIDEO_PACKAGE.replace('本期平台：视频号', '本期平台：shipinhao').replace('- 发布标题：客户为什么划走', '### 发布标题：\n客户为什么划走');
    const result = parseContentPackageReview(source);
    expect(result.errors).toEqual([]);
    expect(result.package?.videos[0].title).toBe('客户为什么划走');
    for (const broken of [source.replace('shipinhao', 'shipinhao、视频号'), source.replace('shipinhao', 'shipinhao、未知'), source.replace('### 发布标题：', '- 发布标题：另一个\n### 发布标题：'), source+'\n## 3. 视频号原生口播\n第二段']) {
      expect(parseContentPackageReview(broken).errors.length).toBeGreaterThan(0);
    }
  });
  it('shows each video utterance once and exposes its own selection action', () => {
    const video = parseContentPackageReview(NATIVE_VIDEO_PACKAGE).package!.videos[0];
    const html = renderToStaticMarkup(createElement(VideoReview, { ...readerProps, video, readerSections: contentSections(NATIVE_VIDEO_PACKAGE) }));
    expect(html.match(/先说客户的问题，再介绍你的方法。/g)).toHaveLength(1);
    expect(html).toContain('修改第 1 段口播');
    expect(html).not.toContain('分段口播稿');
    expect(html).not.toContain('抖音');
  });
  it('exposes all eight card bodies and publishing copy without repeating copy or unrelated platform forms', () => {
    const markdown = nativeXhsPackage(); const opinion = parseContentPackageReview(markdown).package!.opinions[0];
    const props = { ...readerProps, opinion, readerSections: contentSections(markdown) };
    const html = renderToStaticMarkup(createElement(OpinionReview, props));
    expect(html).toContain('修改小红书发布正文');
    for (let page = 1; page <= 8; page++) expect(html).toContain(`修改P${page} 正文`);
    expect(html.match(/客户先判断你是否理解他的处境，再判断你的方法是否值得相信。/g)).toHaveLength(1);
    expect(html).not.toContain('朋友圈');
    const readonly = renderToStaticMarkup(createElement(OpinionReview, { ...props, readOnly: true }));
    expect(readonly).toContain('页面正文 8'); expect(readonly).not.toContain('修改P8 正文');
    const stale = renderToStaticMarkup(createElement(OpinionReview, { ...props, readerSections: [] }));
    expect(stale).toContain('页面正文 8'); expect(stale).not.toContain('修改P8 正文');
  });
});

describe('ContentPackageReview parser', () => {
  it('reports ambiguous spoken tables rather than treating them as ready content', () => {
    const result = parseContentPackageReview(NATIVE_VIDEO_PACKAGE.replace('| 口播文案 |', '| 未知字段 |'));
    expect(result.errors).toContain('视频号口播文案无法完整识别，请核对逐句口播稿后再确认。');
  });

  it('parses only the selected native video lane with its B-roll guidance', () => {
    const result = parseContentPackageReview(NATIVE_VIDEO_PACKAGE);

    expect(result.errors).toEqual([]);
    expect(result.package?.nativePlatforms).toEqual(['shipinhao']);
    expect(result.package?.videos).toHaveLength(1);
    expect(result.package?.videos[0].bRoll).toEqual(['白板上的客户问题清单']);
    expect(result.package?.opinions).toEqual([]);
  });

  it('requires a complete native Xiaohongshu contract with exact P1-P8 pages', () => {
    const result = parseContentPackageReview(nativeXhsPackage());

    expect(result.errors).toEqual([]);
    expect(result.package?.nativePlatforms).toEqual(['xhs']);
    expect(result.package?.opinions[0].coverText.split('\n')).toEqual(['别先写履历', '客户先看问题', '第一条内容这样写']);
    expect(result.package?.opinions[0].pages.map((page) => page.page)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
    expect(result.package?.opinions[0].platformForms.xiaohongshu.tags).toContain('#客户洞察');
    expect(result.package?.opinions[0].copy).toBe('客户先判断你是否理解他的处境，再判断你的方法是否值得相信。');
    expect(result.package?.opinions[0].platformForms.xiaohongshu.copy).toBe('客户先判断你是否理解他的处境，再判断你的方法是否值得相信。\n\n你现在最难说清哪个客户问题？');
  });

  it('uses the same public title, closing question and tags when source comments are present', () => {
    const markdown = nativeXhsPackage().replace('- 标题：', '- 标题：<!-- 内部批注 -->').replace('#客户洞察', '#客户洞察<!-- 私有备注 -->');
    const result = parseContentPackageReview(markdown);
    expect(result.errors).toEqual([]);
    const opinion = result.package!.opinions[0];
    expect(opinion.title).not.toContain('内部');
    expect(opinion.platformForms.xiaohongshu.tags).not.toContain('私有');
    expect(opinion.platformForms.xiaohongshu.copy).toContain('你现在最难说清哪个客户问题？');
  });

  it('blocks compact page ranges and missing cover fields before visual production', () => {
    const result = parseContentPackageReview(nativeXhsPackage(
      '| P1 | 封面钩子 | 封面 | 正文 | 视觉提示 |\n| P2-P8 | 展开 | 合并页面 | 合并正文 | 合并提示 |',
    ).replace('- 补充句：第一条内容这样写\n', ''));

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('封面三句话、逐页 P1–P8'),
    ]));
  });

  it('parses the fixed 1+2+3 package into directly reviewable units', () => {
    const result = parseContentPackageReview(PACKAGE);

    expect(result.errors).toEqual([]);
    expect(result.package?.article.title).toBe('第一篇内容别急着介绍自己');
    expect(result.package?.article.commentGuide).toContain('哪个客户问题');
    expect(result.package?.videos).toHaveLength(2);
    expect(result.package?.videos[0]).toMatchObject({
      title: '短视频标题 1',
      subtitles: expect.arrayContaining(['客户先看见自己的问题。']),
      bRoll: expect.arrayContaining(['白板上写出客户场景的过程。']),
    });
    expect(result.package?.videos[0].platformForms.douyin.title).toBe('抖音标题 1');
    expect(result.package?.opinions).toHaveLength(3);
    expect(result.package?.opinions[0].pages.map((page) => page.page)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
    expect(result.package?.opinions[0].platformForms.moments.imageOrder).toBe('P1、P3、P5');
  });

  it('only becomes ready after all six explicit reviews are checked', () => {
    const partial: ContentPackageReviewChecks = {
      article: true,
      'video-1': true,
      'video-2': true,
      'opinion-1': true,
      'opinion-2': true,
    };
    const complete: ContentPackageReviewChecks = { ...partial, 'opinion-3': true };

    expect(isContentPackageReviewReady('ready', partial, 3)).toBe(false);
    expect(isContentPackageReviewReady('invalid', complete, 3)).toBe(false);
    expect(isContentPackageReviewReady('ready', complete, 3)).toBe(true);
  });

  it('only requires the actual opinion count, not a fixed three', () => {
    const twoOpinions: ContentPackageReviewChecks = {
      article: true,
      'video-1': true,
      'video-2': true,
      'opinion-1': true,
      'opinion-2': true,
    };
    expect(isContentPackageReviewReady('ready', twoOpinions, 2)).toBe(true);
    expect(isContentPackageReviewReady('ready', twoOpinions, 3)).toBe(false);
  });

  it('keeps content confirmation blocked when execution or card fields are incomplete', () => {
    const incomplete = PACKAGE
      .replace('#### B-roll 素材建议\n- 白板上写出客户场景的过程。\n- 已授权的工作笔记特写。\n', '#### B-roll 素材建议\n')
      .replace('- 朋友圈图序：P1、P3、P5\n', '');
    const result = parseContentPackageReview(incomplete);

    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('B-roll 素材建议'),
      expect.stringContaining('公众号、朋友圈、小红书发布字段'),
    ]));
  });

  it('keeps parser guidance natural while hiding unknown client failures', () => {
    expect(displayReviewError('内容包缺少 B-roll 素材建议。请重新生成。'))
      .toBe('全部内容缺少补充画面建议。请重新生成。');
    expect(displayReviewError('TypeError at /Users/alice/private/package.md {"token":"secret"}'))
      .toBe('本期内容没有读取成功。请重新生成后再试。');
  });
});
