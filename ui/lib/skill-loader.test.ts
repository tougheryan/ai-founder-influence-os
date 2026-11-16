import { describe, expect, it } from 'vitest';

import { buildUserMessage } from './skill-loader';

describe('content-validate prompt binding', () => {
  it('keeps the operator-selected topic in the validate prompt', () => {
    const topic = '把内容获客拆成动作：客户问题、案例整理与每周复盘';
    const message = buildUserMessage('content-validate', {
      topic,
      source: 'pipeline/intake/topic-intake.md',
      marketSignalPath: 'materials/research/topic-market-signal.md',
    });

    expect(message).toContain(`本期已选主题：${topic}`);
    expect(message).toContain('不得替换主题');
  });

  it('keeps the selected topic authoritative when building a blueprint prompt', () => {
    const topic = '把内容获客拆成动作：客户问题、案例整理与每周复盘';
    const message = buildUserMessage('content-blueprint', {
      topic,
      validateReportPath: 'pipeline/validate/example.md',
      intakeReportPath: 'pipeline/intake/example.md',
    });

    expect(message).toContain(`本期已选主题：${topic}`);
    expect(message).toContain('不得借此替换主题或重新选题');
    expect(message).toContain('确认状态：待作者确认');
    expect(message).toContain('提交本期平台、选题和排版不等于确认生成后的写作方案');
    expect(message).toContain('作者核对并明确确认方案后才能进入正文');
    expect(message).toContain('模型不得代为确认');
    expect(message).not.toMatch(/确认状态：(confirmed|已确认)|无需再次确认|直接生效/);
  });
});
