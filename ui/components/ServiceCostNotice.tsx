import type { LLMConfig } from '@/lib/types';

export function ServiceCostNotice({ config }: { config: LLMConfig }) {
  const hosted = config.connectionMode === 'hosted' || config.provider === 'aifios-hosted';
  const remaining = config.gatewayQuota?.remaining;
  return <section id="service-costs" aria-label="费用与调用说明" className="scroll-mt-6 space-y-2 rounded-xl border border-[rgba(28,28,30,0.1)] bg-white p-4 text-sm leading-6">
    <h2 className="font-bold">哪些操作会产生费用</h2>
    <p>{hosted
      ? '当前使用授权服务。模型请求按授权额度记录；软件使用期限、包含的服务和补充额度价格以你的购买约定为准。'
      : '当前选择自备模型账号。生成和模型改稿由所选服务商按账号规则计费；软件授权期限、包含服务和升级权益以购买约定为准，不代表已包含外部账号额度。'}</p>
    {hosted && <p>最近读取的模型请求额度：{typeof remaining === 'number' && Number.isSafeInteger(remaining) && remaining >= 0 ? `剩余 ${remaining} 次` : '尚未取得'}。次数不能换算成已完成文章数。</p>}
    <ul className="list-disc space-y-1 pl-5">
      <li>阅读已有内容、保存文字和手动改稿不会调用模型。</li>
      <li>按自己的题目写，不需要平台数据服务；让产品帮你研究平台选题时，再配置数据账号。</li>
      <li>测试模型连接会发送一次短文本请求，可能计入服务费用或授权额度。</li>
      <li>采集平台数据使用数据服务账号，重新采集可能再次产生费用。</li>
    <li>公众号主题预览及优先排版路径会请求 md2wechat 外部 API，需单独的服务账号，可能计费；生成正式排版时会发送文章文字。失败后回退本地基础排版，不代表此前外部请求没有费用。小红书卡片在本机渲染，不调用生图服务。</li>
      <li>本期模型调用次数上限不覆盖主题预览、排版和平台数据服务。</li>
    </ul>
    <p className="text-xs text-[#6B6B6B]">当前尚未汇总本期所有服务的实际账单，费用未知；不能按 0 元理解。实际扣费及失败请求是否计费，以对应服务记录为准。</p>
  </section>;
}
