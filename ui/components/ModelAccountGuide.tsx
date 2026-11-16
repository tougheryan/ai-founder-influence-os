import type { LLMConfig } from '@/lib/types';

type AccountGuide = {
  name: string;
  baseUrl: string;
  keysUrl: string;
  helpUrl: string;
  instruction: string;
};

// Official documentation and its console links checked on 2026-09-18.
// Match the actual endpoint as well as the provider: compatible services can
// require their own accounts. Never send a custom endpoint's user to buy a key
// from the provider selected only for its API format.
const ACCOUNT_GUIDES: Record<string, AccountGuide> = {
  openai: {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    helpUrl: 'https://developers.openai.com/api/docs/quickstart',
    instruction: '在 API 平台的项目中创建并复制密钥。ChatGPT 订阅与 API 分开计费。',
  },
  deepseek: {
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    helpUrl: 'https://api-docs.deepseek.com/zh-cn/',
    instruction: '在 DeepSeek 开放平台的 API keys 页面创建并复制密钥。',
  },
  gemini: {
    name: 'Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    keysUrl: 'https://aistudio.google.com/api-keys?hl=zh-cn',
    helpUrl: 'https://ai.google.dev/gemini-api/docs/api-key?hl=zh-cn',
    instruction: '在 Google AI Studio 选择或创建项目，再创建并复制 Gemini API 密钥；旧密钥的迁移要求见官方指引。',
  },
  anthropic: {
    name: 'Anthropic / Claude',
    baseUrl: 'https://api.anthropic.com/v1/',
    keysUrl: 'https://platform.claude.com/settings/keys',
    helpUrl: 'https://platform.claude.com/docs/en/api/overview',
    instruction: '在 Claude Console 的 API Keys 中创建并复制密钥，核对所属工作空间和可调用模型。',
  },
  siliconflow: {
    name: 'SiliconFlow / 硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keysUrl: 'https://cloud.siliconflow.cn/account/ak',
    helpUrl: 'https://docs.siliconflow.cn/docs/userguide/quickstart',
    instruction: '在硅基流动控制台的 API 密钥页面创建并复制密钥，模型名称以该账号可用的模型为准。',
  },
  dashscope: {
    name: 'DashScope / 阿里云百炼',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keysUrl: 'https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key',
    helpUrl: 'https://help.aliyun.com/zh/model-studio/get-api-key',
    instruction: '当前默认地址对应华北 2（北京）。在对应业务空间创建并复制 API Key；密钥地域应与服务地址一致。',
  },
  moonshot: {
    name: 'Moonshot / Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    keysUrl: 'https://platform.kimi.com/console/api-keys',
    helpUrl: 'https://platform.kimi.com/docs/get-api-key',
    instruction: '在 Kimi API 开放平台的 API Keys 页面创建并复制密钥。',
  },
};

function matchesOfficialEndpoint(value: string, expected: string): boolean {
  try {
    const url = new URL(value);
    const official = new URL(expected);
    return url.protocol === 'https:' && !url.username && !url.password
      && !url.search && !url.hash && url.origin === official.origin
      && url.pathname.replace(/\/$/, '') === official.pathname.replace(/\/$/, '');
  } catch {
    return false;
  }
}

export function ModelAccountGuide({
  provider, baseUrl, connectionMode,
}: Pick<LLMConfig, 'provider' | 'baseUrl' | 'connectionMode'>) {
  if (connectionMode === 'hosted' || provider === 'aifios-hosted') return null;
  const known = Object.prototype.hasOwnProperty.call(ACCOUNT_GUIDES, provider) ? ACCOUNT_GUIDES[provider] : undefined;
  const guide = known && matchesOfficialEndpoint(baseUrl || known.baseUrl, known.baseUrl) ? known : undefined;
  const linkClass = 'font-semibold text-[#3B5E06] underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-[#52790C]';

  return (
    <details className="rounded-xl border border-[rgba(28,28,30,0.1)] bg-[#F7FAF4]">
      <summary className="cursor-pointer px-4 py-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-[#52790C]">
        {guide ? `没有密钥？准备 ${guide.name} 账号` : '没有密钥？查看当前服务的账号要求'}
      </summary>
      <div className="space-y-3 border-t border-[rgba(28,28,30,0.08)] p-4 text-sm leading-6">
        <p>密钥是让 Echo Founder 使用你的模型账号的访问凭证，请填写 API Key，而不是聊天账号的登录密码。</p>
        <ol className="list-decimal space-y-2 pl-5">
          <li>{guide ? <>
            打开 <a href={guide.keysUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>{guide.name} 密钥管理（新窗口）</a>，注册或登录 API 平台。{guide.instruction}
          </> : <>
            当前服务或地址使用自定义设置。请向提供这项服务的人取得配套的账号、密钥、API 地址和模型名称，再在下方“调整模型、地址与输出参数”中核对。仅选择服务商名称，不表示可使用该服务商的官方密钥。
          </>}</li>
          <li>在服务提供方核对模型权限、可用额度和 API 计费方式。软件授权与外部服务费用分别核对，测试连接也可能计费。</li>
          <li>回到上方粘贴密钥，点击“保存设置”，再点“测试连接”。测试成功后，用页面上方“回到工作台继续”返回原稿；若失败，按连接结果检查设置和账号。</li>
        </ol>
        {guide && <p><a href={guide.helpUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>查看 {guide.name} 官方指引（新窗口）</a></p>}
      </div>
    </details>
  );
}
