export const IMAGE_ACCOUNT_POLICY_SCHEMA = 'echo-founder.image-account-policy.v1' as const;

export const IMAGE_PROVIDER_ACCOUNTS = [
  { id: 'image_openrouter', provider: 'openrouter', name: 'OpenRouter', routeSummary: 'OpenAI、Gemini、Seedream 等多模型', env: 'OPENROUTER_API_KEY' },
  { id: 'image_ark', provider: 'ark', name: '火山方舟', routeSummary: 'Seedream 系列', env: 'ARK_API_KEY' },
  { id: 'image_dashscope', provider: 'dashscope', name: '阿里云百炼', routeSummary: 'Qwen Image、Wan Image', env: 'DASHSCOPE_API_KEY', workspaceRequired: true },
  { id: 'image_replicate', provider: 'replicate', name: 'Replicate', routeSummary: 'Google Nano Banana 系列', env: 'REPLICATE_API_TOKEN' },
  { id: 'image_zai', provider: 'zai', name: '智谱开放平台', routeSummary: 'GLM-Image', env: 'ZAI_API_KEY' },
  { id: 'image_minimax', provider: 'minimax', name: 'MiniMax', routeSummary: 'Image-01', env: 'MINIMAX_API_KEY' },
] as const;

export type ImageCredentialId = typeof IMAGE_PROVIDER_ACCOUNTS[number]['id'];
export type ImageAccountPreset = 'model_richness' | 'domestic_stability' | 'custom';

export type ImageAccountPolicy = {
  schema_version: typeof IMAGE_ACCOUNT_POLICY_SCHEMA;
  preset: ImageAccountPreset;
  primary_provider: ImageCredentialId | null;
  backup_provider: ImageCredentialId | null;
  advanced_provider: ImageCredentialId | null;
  budgets_cny: {
    per_call_limit: number;
    per_task_limit: number;
    monthly_reminder: number;
  };
  first_paid_call_confirmed: boolean;
  updated_at: string;
};

export const IMAGE_ACCOUNT_PRESETS: ReadonlyArray<{
  id: Exclude<ImageAccountPreset, 'custom'>;
  label: string;
  detail: string;
  order: readonly ImageCredentialId[];
}> = [
  {
    id: 'model_richness',
    label: '模型丰富度',
    detail: 'OpenRouter 主账户 + 火山方舟备用，适合比较不同视觉方向。',
    order: ['image_openrouter', 'image_ark', 'image_dashscope'],
  },
  {
    id: 'domestic_stability',
    label: '国内稳定',
    detail: '火山方舟主账户 + 阿里云百炼备用，适合国内网络与账单管理。',
    order: ['image_ark', 'image_dashscope', 'image_zai'],
  },
];

const PROVIDER_IDS = new Set<string>(IMAGE_PROVIDER_ACCOUNTS.map((item) => item.id));

export function defaultImageAccountPolicy(): ImageAccountPolicy {
  return {
    schema_version: IMAGE_ACCOUNT_POLICY_SCHEMA,
    preset: 'model_richness',
    primary_provider: null,
    backup_provider: null,
    advanced_provider: null,
    budgets_cny: {
      per_call_limit: 5,
      per_task_limit: 20,
      monthly_reminder: 100,
    },
    first_paid_call_confirmed: false,
    updated_at: '',
  };
}

function providerId(value: unknown): ImageCredentialId | null {
  return typeof value === 'string' && PROVIDER_IDS.has(value)
    ? value as ImageCredentialId
    : null;
}

function finiteBudget(value: unknown, fallback: number, min: number, max: number): number {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount) || amount < min || amount > max) return fallback;
  return Math.round(amount * 100) / 100;
}

export function normalizeImageAccountPolicy(value: unknown): ImageAccountPolicy {
  const fallback = defaultImageAccountPolicy();
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const rawBudgets = record.budgets_cny && typeof record.budgets_cny === 'object' && !Array.isArray(record.budgets_cny)
    ? record.budgets_cny as Record<string, unknown>
    : {};
  const preset = record.preset === 'domestic_stability' || record.preset === 'custom'
    ? record.preset
    : 'model_richness';
  const primary = providerId(record.primary_provider);
  const backup = providerId(record.backup_provider);
  const advanced = providerId(record.advanced_provider);
  const uniqueBackup = backup && backup !== primary ? backup : null;
  const uniqueAdvanced = advanced && advanced !== primary && advanced !== uniqueBackup ? advanced : null;
  const perCall = finiteBudget(rawBudgets.per_call_limit, fallback.budgets_cny.per_call_limit, 0.1, 40);
  const perTask = finiteBudget(rawBudgets.per_task_limit, fallback.budgets_cny.per_task_limit, perCall, 100);
  return {
    schema_version: IMAGE_ACCOUNT_POLICY_SCHEMA,
    preset,
    primary_provider: primary,
    backup_provider: uniqueBackup,
    advanced_provider: uniqueAdvanced,
    budgets_cny: {
      per_call_limit: perCall,
      per_task_limit: perTask,
      monthly_reminder: finiteBudget(rawBudgets.monthly_reminder, fallback.budgets_cny.monthly_reminder, 1, 10_000),
    },
    first_paid_call_confirmed: record.first_paid_call_confirmed === true,
    updated_at: typeof record.updated_at === 'string' ? record.updated_at : '',
  };
}

export function effectiveImageAccountOrder(
  policy: ImageAccountPolicy,
  configured: readonly ImageCredentialId[],
): ImageCredentialId[] {
  const configuredSet = new Set<ImageCredentialId>(configured);
  const preset = IMAGE_ACCOUNT_PRESETS.find((item) => item.id === policy.preset) || IMAGE_ACCOUNT_PRESETS[0];
  const candidates = [
    policy.primary_provider,
    policy.backup_provider,
    policy.advanced_provider,
    ...preset.order,
    ...IMAGE_PROVIDER_ACCOUNTS.map((item) => item.id),
  ];
  return candidates.filter((item, index, values): item is ImageCredentialId => (
    item !== null && configuredSet.has(item) && values.indexOf(item) === index
  ));
}

export function configuredImageCredentialIds(environment: NodeJS.ProcessEnv = process.env): ImageCredentialId[] {
  if (typeof environment.AIFIOS_IMAGE_ACCOUNT_IDS === 'string') {
    const marked = environment.AIFIOS_IMAGE_ACCOUNT_IDS.split(',').map((item) => item.trim());
    return IMAGE_PROVIDER_ACCOUNTS.flatMap((item) => marked.includes(item.id) ? [item.id] : []);
  }
  return IMAGE_PROVIDER_ACCOUNTS.flatMap((item) => String(environment[item.env] || '').trim() ? [item.id] : []);
}
