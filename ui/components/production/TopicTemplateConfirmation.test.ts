import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BrandTemplate } from '@/lib/brand-templates';
import { TopicTemplateConfirmation, nextTopicSuggestionIndex, previewTemplateChoice } from './TopicTemplateConfirmation';

const themes: BrandTemplate[] = ['apple', 'bold-blue', 'coffee-house', 'focus-green', 'wechat-native', 'nyt-classic'].map((id) => ({
  id, label: id, detail: `${id} theme`, layoutStyle: id, enabled: true, source: 'md2wechat', themeType: 'api',
}));

describe('topic template preview choice', () => {
  it('shows the selected theme in the preview before the operator clicks preview', () => {
    expect(previewTemplateChoice(themes, 'wechat-native', '')?.id).toBe('wechat-native');
    expect(previewTemplateChoice(themes, 'wechat-native', 'bold-blue')?.id).toBe('bold-blue');
  });
});

describe('topic suggestion keyboard navigation', () => {
  it('moves with arrow keys and wraps at both ends', () => {
    expect(nextTopicSuggestionIndex(0, 6, 'ArrowRight')).toBe(1);
    expect(nextTopicSuggestionIndex(5, 6, 'ArrowRight')).toBe(0);
    expect(nextTopicSuggestionIndex(0, 6, 'ArrowLeft')).toBe(5);
    expect(nextTopicSuggestionIndex(3, 6, 'ArrowUp')).toBe(2);
    expect(nextTopicSuggestionIndex(3, 6, 'ArrowDown')).toBe(4);
  });

  it('supports Home and End without intercepting unrelated keys', () => {
    expect(nextTopicSuggestionIndex(3, 6, 'Home')).toBe(0);
    expect(nextTopicSuggestionIndex(2, 6, 'End')).toBe(5);
    expect(nextTopicSuggestionIndex(2, 6, 'Tab')).toBeNull();
    expect(nextTopicSuggestionIndex(0, 0, 'ArrowRight')).toBeNull();
  });
});


describe('saved research while choosing a topic', () => {
  const base = { suggestions: [], topic: '作者保留的标题', templates: [], selectedTemplateId: 'default', selectedPlatformLabels: ['公众号'], onSelectSuggestion: () => {}, onTopicChange: () => {}, onSelectTemplate: () => {}, onConfirm: () => {} };
  it('offers reading existing references and retry without asking for another collection', () => {
    const html = renderToStaticMarkup(createElement(TopicTemplateConfirmation, { ...base, researchAvailable: true, onReload: () => {}, onViewSamples: () => {}, error: '读取失败，已有参考仍保留' }));
    expect(html).toContain('查看已保存参考');
    expect(html).toContain('重新读取选题');
    expect(html).toContain('作者保留的标题');
    expect(html).not.toContain('请先完成上一步');
    expect(html).not.toContain('全部 48');
  });
  it('shows loading rather than a misleading zero-results instruction', () => {
    const html = renderToStaticMarkup(createElement(TopicTemplateConfirmation, { ...base, researchAvailable: true, loading: true }));
    expect(html).toContain('正在读取本期选题建议');
    expect(html).not.toContain('0 个方向');
    expect(html).not.toContain('还不足以给出');
  });
  it('keeps the title and offers setup instead of starting generation without a connection', () => {
    const html = renderToStaticMarkup(createElement(TopicTemplateConfirmation, { ...base, researchAvailable: true, modelSetupIssue: '尚未配置模型密钥' }));
    expect(html).toContain('作者保留的标题');
    expect(html).toContain('连接写作服务后继续');
    expect(html).toContain('/settings#model-connection');
    expect(html).not.toContain('确认并生成内容方案');
  });
  it('does not duplicate the task setup action or allow generation while setup is still missing', () => {
    const html = renderToStaticMarkup(createElement(TopicTemplateConfirmation, { ...base, modelSetupIssue: '尚未配置模型密钥', modelSetupHandledByTask: true }));
    expect(html).toContain('作者保留的标题');
    expect(html).not.toContain('连接写作服务后继续');
    expect(html).not.toContain('确认并生成内容方案');
  });
});
