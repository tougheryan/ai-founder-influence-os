import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ResearchActivityRecord } from './ResearchActivityStatus';
import { ServiceCostNotice } from './ServiceCostNotice';
import { serviceRecordStatus } from '@/lib/service-status-copy';

describe('service records shown in their actual scope', () => {
  it('keeps a failed latest attempt separate from available archived samples', () => {
    const html = renderToStaticMarkup(<ResearchActivityRecord data={{ runId: 'run-a', title: '客户问题', state: 'current', checkedAt: '2026-09-16', collectedAt: '2026-09-15', reason: '已有研究与这期素材对应。', platforms: [{ id: 'wechat_mp', label: '公众号', status: 'available', sampleCount: 10 }], lastAttempt: { status: 'failed', startedAt: '2026-09-16', completedAt: null } }} />);
    expect(html).toContain('本期采集：未完成'); expect(html).toContain('10 条样本'); expect(html).toContain('已取得数据');
    expect(html).not.toContain('连接失败');
  });
  it('never calls unfamiliar, pending or running statuses completed', () => {
    for (const value of ['new_status', 'running', 'pending', null]) expect(serviceRecordStatus(value)).not.toBe('已完成');
  });
  it('does not show unavailable account usage as zero or an included free service', () => {
    const direct = renderToStaticMarkup(<ServiceCostNotice config={{ provider: 'openai', apiKey: '', model: 'test' }} />);
    expect(direct).toContain('费用未知'); expect(direct).toContain('测试模型连接会发送一次短文本请求');
    const hosted = renderToStaticMarkup(<ServiceCostNotice config={{ provider: 'aifios-hosted', apiKey: '', model: 'test' }} />);
    expect(hosted).toContain('尚未取得'); expect(hosted).not.toContain('剩余 0 次');
  });
});
