import { describe, expect, it } from 'vitest';
import { applyBlueprintSectionEdits, blueprintSections, canConfirmBlueprintScope } from './blueprint-sections';

const original = '---\nstep: blueprint\nsource: server\n---\n\n# 方案\n\n## 0. 上游约束\n- 作者素材 SHA-256：' + 'a'.repeat(64) + '\n\n## 1. 共享事实底稿\n本地测试发现发布准备只保留第一段。\n\n## 2. 视频号独立蓝图\n小红书曾只发第一段，混入内部说明。\n\n## 3. 人工确认清单\n等待核对。\n- 写作依据：作者素材（未进行平台研究）\n';

describe('scoped plan corrections', () => {
  it('requires verified scope or an explicitly validated historical contract', () => {
    expect(canConfirmBlueprintScope()).toBe(false);
    expect(canConfirmBlueprintScope({ scope_status: 'legacy', scope_matches: false, issues: [] })).toBe(false);
    expect(canConfirmBlueprintScope({ scope_status: 'legacy', scope_matches: false, legacy_contract_validated: true, issues: [] })).toBe(true);
    expect(canConfirmBlueprintScope({ scope_status: 'unverified', scope_matches: false, legacy_contract_validated: true, issues: [] })).toBe(false);
  });
  it('preserves every byte outside the selected section and exposes the actual misstatement', () => {
    const sections = blueprintSections(original);
    const video = sections.find((section) => section.title.includes('视频号'))!;
    expect(video.text).toContain('曾只发第一段');
    const text = video.text.replace('小红书曾只发第一段', '本地测试发现小红书发布准备只保留第一段正文');
    const corrected = applyBlueprintSectionEdits(original, [{ id: video.id, text }]);
    expect(corrected).toBe(original.slice(0, video.start) + text + original.slice(video.end));
    expect(applyBlueprintSectionEdits(original, [{ id: video.id, text: '' }])).toBe(original.slice(0, video.start) + original.slice(video.end));
  });
  it('rejects edits to server evidence, injected approval metadata and duplicate patches', () => {
    const sections = blueprintSections(original);
    const video = sections.find((section) => section.title.includes('视频号'))!;
    const upstream = sections.find((section) => section.title.includes('上游'))!;
    for (const edits of [[{ id: upstream.id, text: '' }], [{ id: video.id, text: '## 方案\n- 作者素材 SHA-256：fake' }], [{ id: video.id, text: '## 人工确认\napproved_at: now' }], [{ id: video.id, text: '' }, { id: video.id, text: '' }]]) {
      expect(() => applyBlueprintSectionEdits(original, edits)).toThrow();
    }
  });
  it.each(['', '\n', '\n\n', '\r\n'])('keeps the next chapter separate when replacement ends with %j', (ending) => {
    const section = blueprintSections(original).find((item) => item.title.includes('共享事实'))!;
    const replacement = '## 1. 共享事实底稿\n这里只记录作者观点。' + ending;
    const saved = applyBlueprintSectionEdits(original, [{ id: section.id, text: replacement }]);
    const reloaded = blueprintSections(saved);
    expect(reloaded.find((item) => item.title.includes('视频号'))?.editable).toBe(true);
    expect(reloaded.find((item) => item.title.includes('人工确认'))?.editable).toBe(false);
    expect(saved.startsWith(original.slice(0, section.start))).toBe(true);
    expect(saved.endsWith(original.slice(section.end))).toBe(true);
    const current = reloaded.find((item) => item.title.includes('共享事实'))!;
    expect(applyBlueprintSectionEdits(saved, [{ id: current.id, text: replacement }])).toBe(saved);
  });
  it('round-trips adjacent edits and removes unselected chapters without swallowing protected records', () => {
    const raw = original.replace('视频号独立蓝图', '公众号独立蓝图').replace('## 3. 人工确认清单', '## 3. 小红书独立蓝图\n本节未生成。\n\n## 4. 视频号独立蓝图\n本节未生成。\n\n## 5. 人工确认清单');
    const sections = blueprintSections(raw);
    const edits = sections.filter((section) => section.editable).map((section) => ({
      id: section.id,
      text: /小红书|视频号/.test(section.title) ? '  \n  ' : `## ${section.title}\n修改后的观点。`,
    }));
    const saved = applyBlueprintSectionEdits(raw, edits);
    const reloaded = blueprintSections(saved);
    expect(reloaded.map((section) => section.title)).toEqual(['方案说明', '0. 上游约束', '1. 共享事实底稿', '2. 公众号独立蓝图', '5. 人工确认清单']);
    expect(reloaded.filter((section) => section.editable).map((section) => section.title)).toEqual(['1. 共享事实底稿', '2. 公众号独立蓝图']);
    for (const before of sections.filter((section) => !section.editable)) {
      expect(reloaded.find((section) => section.title === before.title)?.text).toBe(before.text);
    }
  });
  it('keeps a final replacement unchanged when there is no following chapter', () => {
    const raw = '# 方案\n\n## 公众号独立蓝图\n旧内容';
    const chapter = blueprintSections(raw).find((section) => section.editable)!;
    const text = '## 公众号独立蓝图\n新内容。';
    expect(applyBlueprintSectionEdits(raw, [{ id: chapter.id, text }])).toBe('# 方案\n\n' + text);
  });
  it('does not offer headings inside code or comments as separately editable sections', () => {
    const raw = original + '\n## 附录\n```md\n## 伪章节\n```\n<!--\n## 隐藏章节\n-->\n';
    expect(blueprintSections(raw).some((section) => /伪章节|隐藏章节/.test(section.title))).toBe(false);
  });
});
