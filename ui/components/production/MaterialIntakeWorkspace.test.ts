import { describe, expect, it, vi } from 'vitest';
import { Children, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isValidReferenceUrl, MaterialIntakeWorkspace, MaterialTitleSuggestion } from './MaterialIntakeWorkspace';

describe('using the author title from pasted material', () => {
  const materialText = '已有题目：《临时加需求，先把这三件事写清楚》。只做公众号。';
  function titleProps(overrides: Partial<Parameters<typeof MaterialTitleSuggestion>[0]> = {}) {
    return { materialText, topic: '', writingMode: 'platform' as const, busy: false, analysisStale: false,
      onTopicChange: vi.fn(), onWritingModeChange: vi.fn(), ...overrides };
  }
  function suggestionButton(props: Parameters<typeof MaterialTitleSuggestion>[0]) {
    const element = MaterialTitleSuggestion(props);
    return element && Children.toArray(element.props.children).find((child) => isValidElement(child) && child.type === 'button');
  }
  it('leaves research selected and waits for a click before changing either field', () => {
    const props = titleProps();
    const html = renderToStaticMarkup(createElement(MaterialTitleSuggestion, props));
    expect(html).toContain('使用素材里的题目');
    expect(html).toContain('确认素材后才生成方案');
    expect(props.onTopicChange).not.toHaveBeenCalled();
    expect(props.onWritingModeChange).not.toHaveBeenCalled();
    const button = suggestionButton(props);
    expect(isValidElement(button)).toBe(true);
    if (!isValidElement<{ onClick: () => void }>(button)) throw new Error('missing suggestion button');
    button.props.onClick();
    expect(props.onTopicChange).toHaveBeenCalledExactlyOnceWith('临时加需求，先把这三件事写清楚');
    expect(props.onWritingModeChange).toHaveBeenCalledExactlyOnceWith('author_material');
  });
  it('fills an empty author topic without changing the mode again', () => {
    const props = titleProps({ writingMode: 'author_material' });
    const button = suggestionButton(props);
    if (!isValidElement<{ onClick: () => void }>(button)) throw new Error('missing suggestion button');
    button.props.onClick();
    expect(props.onTopicChange).toHaveBeenCalledExactlyOnceWith('临时加需求，先把这三件事写清楚');
    expect(props.onWritingModeChange).not.toHaveBeenCalled();
  });
  it('does not offer replacement of a typed or restored title, stale material, or quoted titles', () => {
    for (const overrides of [{ topic: '我的手动题目' }, { analysisStale: true }, { materialText: '客户说：已有题目：《客户文章》' }]) {
      const props = titleProps(overrides);
      expect(MaterialTitleSuggestion(props)).toBeNull();
      expect(props.onTopicChange).not.toHaveBeenCalled();
      expect(props.onWritingModeChange).not.toHaveBeenCalled();
    }
  });
  it('does not accept a suggestion during analysis or another pending action', () => {
    const props = titleProps({ busy: true });
    const button = suggestionButton(props);
    if (!isValidElement<{ disabled: boolean; onClick: () => void }>(button)) throw new Error('missing suggestion button');
    expect(button.props.disabled).toBe(true);
    button.props.onClick();
    expect(props.onTopicChange).not.toHaveBeenCalled();
    expect(props.onWritingModeChange).not.toHaveBeenCalled();
  });
  it('derives a new suggestion from current material, with no retained analysis title', () => {
    const props = titleProps({ materialText: '已有题目：《新素材的题目》' });
    const button = suggestionButton(props);
    if (!isValidElement<{ onClick: () => void }>(button)) throw new Error('missing suggestion button');
    button.props.onClick();
    expect(props.onTopicChange).toHaveBeenCalledExactlyOnceWith('新素材的题目');
  });
});

describe('isValidReferenceUrl', () => {
  it('accepts complete public web links', () => {
    expect(isValidReferenceUrl('https://www.xiaohongshu.com/user/profile/demo')).toBe(true);
    expect(isValidReferenceUrl(' http://example.com/article ')).toBe(true);
  });

  it('rejects text, relative paths, and non-web protocols', () => {
    expect(isValidReferenceUrl('不是链接')).toBe(false);
    expect(isValidReferenceUrl('/article/1')).toBe(false);
    expect(isValidReferenceUrl('javascript:alert(1)')).toBe(false);
    expect(isValidReferenceUrl('')).toBe(false);
  });
});

describe('MaterialIntakeWorkspace guidance', () => {
  it('offers author writing without research and requires a title before starting', () => {
    const props = {
      materialText: '自己的素材', links: [], uploadedFiles: [], analysisStale: false,
      analysis: { summary: '记录改动再确认', facts: [], cases: [], risks: [], recommendedTypeId: 'business-growth' as const, recommendedStructureId: 'customer-solution-case-cta' },
      selectedTypeId: 'business-growth', selectedStructureId: 'customer-solution-case-cta', selectedPlatforms: ['wechat' as const], busy: false,
      writingMode: 'author_material' as const, onWritingModeChange: () => {}, onTopicChange: () => {},
      onMaterialTextChange: () => {}, onLinksChange: () => {}, onFilesChange: () => {}, onUploadFiles: async () => [],
      onRetryFileExtraction: async (file: Parameters<import('./MaterialIntakeWorkspace').MaterialIntakeWorkspaceProps['onRetryFileExtraction']>[0]) => file,
      onAnalyze: async () => {}, onStartNewPeriod: async () => {}, onInitializeDirection: () => {}, onSelectType: () => {}, onSelectStructure: () => {}, onSelectedPlatformsChange: () => {}, onStartResearch: () => {},
    };
    const empty = renderToStaticMarkup(createElement(MaterialIntakeWorkspace, { ...props, topic: '' }));
    const suggested = renderToStaticMarkup(createElement(MaterialIntakeWorkspace, { ...props, topic: '', writingMode: 'platform', materialText: '已有题目：《临时加需求，先把这三件事写清楚》。只做公众号。' }));
    expect(suggested).toContain('使用素材里的题目');
    expect(suggested).toMatch(/type="radio" name="writing-mode" checked=""\/> 帮我找方向/);
    expect(suggested).not.toContain('value="临时加需求，先把这三件事写清楚"');
    const startButton = (html: string) => html.match(/<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?确认素材，按这个题目写<\/button>/)?.[0];
    expect(startButton(empty)).toContain('disabled=""');
    const ready = renderToStaticMarkup(createElement(MaterialIntakeWorkspace, { ...props, topic: '客户临时改需求' }));
    expect(ready).toContain('不会采集平台数据');
    expect(ready).toContain('value="客户临时改需求"');
    expect(ready).not.toContain('确认底稿并开始找选题');
    expect(startButton(ready)).toBeDefined();
    expect(startButton(ready)).not.toContain('disabled=');
    const missing = renderToStaticMarkup(createElement(MaterialIntakeWorkspace, {
      ...props, topic: '客户临时改需求', modelSetupIssue: '尚未配置模型密钥', onOpenModelSetup: () => {},
    }));
    expect(startButton(missing)).toContain('disabled=');
    expect(missing).toContain('保存草稿并连接写作服务');
    expect(missing).toContain('素材、题目和本篇要求会保留');
    expect(missing).toContain('测试连接、生成方案和正文可能产生');
    const connected = renderToStaticMarkup(createElement(MaterialIntakeWorkspace, { ...props, topic: '客户临时改需求', modelSetupIssue: null }));
    expect(startButton(connected)).not.toContain('disabled=');
    expect(connected).not.toContain('生成方案前，先连接写作服务');
    // Research has its own account requirements; missing a writing model must
    // not disable local material analysis or silently switch the chosen mode.
    const research = renderToStaticMarkup(createElement(MaterialIntakeWorkspace, { ...props, writingMode: 'platform', modelSetupIssue: '尚未配置模型密钥' }));
    expect(research).not.toContain('生成方案前，先连接写作服务');
    expect(research).toContain('确认底稿并开始找选题');
  });
  it('takes the operator directly from understood material to topic research', () => {
    const html = renderToStaticMarkup(createElement(MaterialIntakeWorkspace, {
        materialText: '客户访谈素材',
        links: [],
        uploadedFiles: [],
        analysis: {
          summary: '这份素材主要讨论客户获客问题和解决过程。',
          facts: ['客户正在寻找更稳定的获客方式。'],
          cases: ['一次客户访谈。'],
          risks: [],
          recommendedTypeId: 'business-growth',
          recommendedStructureId: 'customer-solution-case-cta',
          sources: [{ id: 'text:raw', kind: 'text', label: '粘贴文字', status: 'read', detail: '已读取。' }],
        },
        analysisStale: false,
        selectedTypeId: 'business-growth',
        selectedStructureId: 'customer-solution-case-cta',
        selectedPlatforms: ['wechat'],
        busy: false,
        onMaterialTextChange: () => undefined,
        onLinksChange: () => undefined,
        onFilesChange: () => undefined,
        onUploadFiles: async () => [],
        onRetryFileExtraction: async (file) => file,
        onAnalyze: async () => undefined,
        onStartNewPeriod: async () => undefined,
        onInitializeDirection: () => undefined,
        onSelectType: () => undefined,
        onSelectStructure: () => undefined,
        onSelectedPlatformsChange: () => undefined,
        onStartResearch: () => undefined,
      }));

    expect(html).toContain('选择这期要做的平台');
    expect(html).toContain('只研究你选择的平台');
    expect(html).toContain('已选择 1 个平台');
    expect(html).toContain('确认底稿并开始找选题');
    expect(html).toContain('已整理你的素材');
    expect(html).not.toContain('已读懂你的素材');
    expect(html).toContain('不会把目标、禁令或待核验说法当成事实');
    expect(html).toContain('继续写作不表示同意公开发布');
    expect(html).not.toContain('继续下一步即表示');
    expect(html).toContain('尚未提取到公开限制，不代表已获授权');
    expect(html).toMatch(/<input[^>]+type="file"[^>]+tabindex="-1"[^>]+aria-hidden="true"/);
    expect(html).not.toContain('选择内容类型和文章结构');
    expect(html).not.toContain('业务与客户案例');
  });

  it.each(['author_material', 'platform'] as const)('does not present stale analysis as a current fact base in %s mode', (writingMode) => {
    const html = renderToStaticMarkup(createElement(MaterialIntakeWorkspace, {
      writingMode,
      materialText: '已经修改的新素材',
      links: [],
      uploadedFiles: [],
      analysis: {
        summary: '旧摘要不应继续展示',
        facts: ['旧错误事实不应继续展示'],
        cases: ['旧错误案例不应继续展示'],
        risks: [],
        recommendedTypeId: 'business-growth',
        recommendedStructureId: 'customer-solution-case-cta',
      },
      analysisStale: true,
      selectedTypeId: 'business-growth',
      selectedStructureId: 'customer-solution-case-cta',
      selectedPlatforms: ['wechat'],
      busy: false,
      onMaterialTextChange: () => undefined,
      onLinksChange: () => undefined,
      onFilesChange: () => undefined,
      onUploadFiles: async () => [],
      onRetryFileExtraction: async (file) => file,
      onAnalyze: async () => undefined,
      onStartNewPeriod: async () => undefined,
      onInitializeDirection: () => undefined,
      onSelectType: () => undefined,
      onSelectStructure: () => undefined,
      onSelectedPlatformsChange: () => undefined,
      onStartResearch: () => undefined,
    }));

    expect(html).toContain('上次整理结果已失效');
    expect(html).toContain('不会作为当前事实底稿');
    expect(html).not.toContain('旧错误事实不应继续展示');
    expect(html).not.toContain('旧错误案例不应继续展示');
    if (writingMode === 'author_material') {
      expect(html).toContain('素材已更改。请重新整理后，再核对题目和写作要求。');
      expect(html).not.toContain('素材已更改。请重新整理后，再查看同类内容。');
    } else {
      expect(html).toContain('素材已更改。请重新整理后，再查看同类内容。');
    }
  });
});
