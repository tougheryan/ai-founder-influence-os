import { describe, expect, it } from 'vitest';
import { nativePlatforms, readNativeField, readNativeXhsCopy } from '@/electron/native-xhs-copy.cjs';
import { applyContentEdit, contentSections } from './content-editing';
import { publicationTextFromPackage } from './publication-text';

describe('native fields share editing and copying semantics', () => {
  it.each(['- 发布标题：原题', '### 发布标题：\n原题', '### 发布标题\r\n原题'])('edits the exact title span for %s', (field) => {
    const source = `## 3. 视频号原生口播\n${field}\n- 3秒钩子：开场\n### 逐句口播稿\n说这句。\n### 发布文案\n- 简介：简介原文\n- 话题：#测试\n- 置顶评论：问题？`;
    expect(readNativeField(source, ['发布标题'])).toBe('原题');
    expect(publicationTextFromPackage(source, 'video-title')).toBe('原题');
    const target = contentSections(source).find((section) => section.id === 'shipinhao:field:发布标题')!;
    const changed = applyContentEdit(source, { sectionId: target.id, scope: 'section' }, '新题');
    expect(changed).toBe(source.slice(0, target.start) + '新题' + source.slice(target.end));
    expect(publicationTextFromPackage(changed, 'video-title')).toBe('新题');
    expect(contentSections(source).some((section) => section.id === 'shipinhao:publish:简介')).toBe(true);
  });
  it('rejects ambiguous titles and retains an explicit metadata repair range', () => {
    const source = '## 3. 视频号原生口播\n- 发布标题：一\n### 发布标题：\n二\n### 逐句口播稿\n正文。';
    expect(() => readNativeField(source, ['发布标题'])).toThrow('重复');
    expect(() => publicationTextFromPackage(source, 'video-title')).toThrow();
    expect(contentSections(source).find((section) => section.id === 'shipinhao:metadata')?.text).toContain('二');
    expect(readNativeField('### 发布标题：\n<!-- 不是标题 -->\n### 正文\n正文', ['发布标题'])).toBe('');
    expect(readNativeField('```\n- 发布标题：示例\n```\n- 发布标题：原题', ['发布标题'])).toBe('原题');
    expect(() => readNativeField('- 发布标题：第一行\n第二行', ['发布标题'])).toThrow('多行');
  });
  it('preserves real list paragraphs in XHS copy while accepting heading fields', () => {
    const source = '## 2. 小红书原生图文\n### 发布正文\n#### 标题：\n原题\n#### 正文：\n第一段。\n\n- 第一点：别丢掉。\n#### 结尾问题：\n你怎么看？\n### 结尾标签\n#原标签';
    expect(readNativeXhsCopy(source).text).toBe('第一段。\n\n- 第一点：别丢掉。\n\n你怎么看？\n\n#原标签');
  });
  it('normalizes known aliases without accepting duplicate, unknown or inherited object keys', () => {
    expect(nativePlatforms('wechat、小红书 / shipinhao')).toEqual(['wechat', 'xhs', 'shipinhao']);
    for (const value of ['', '视频号 shipinhao', 'shipinhao guess', 'constructor', '__proto__']) expect(() => nativePlatforms(value)).toThrow();
  });
});
