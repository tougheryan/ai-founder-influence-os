export interface PipelineStep {
  id: number;
  name: string;
  skill: string | null;
  phase: 'setup' | 'upstream' | 'midstream' | 'downstream';
  description: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  input?: Record<string, unknown>;
  output?: unknown;
  logs: LogEntry[];
  startTime?: string;
  endTime?: string;
}

export interface LogEntry {
  time: string;
  level: 'info' | 'warning' | 'error' | 'success';
  message: string;
}

export interface RuntimeValidationResult {
  path?: string;
  step?: string;
  valid: boolean;
  result?: Record<string, unknown>;
}

export interface SkillDefinition {
  name: string;
  description: string;
  triggerWords: string[];
  systemPrompt: string;
  parameters: SkillParameter[];
}

export type SkillParameterType = 'string' | 'number' | 'select' | 'boolean' | 'textarea' | 'multi-select' | 'material';

export interface SkillParameter {
  name: string;
  type: SkillParameterType;
  label: string;
  required: boolean;
  default?: string | number | boolean | string[];
  options?: string[];
  placeholder?: string;
  materialCategory?: string; // 'all' | 'pipeline/{stage}' | 'materials/{type}'
}

export interface BrainContext {
  you: string;
  user: string;
  commands: string;
}

export interface LLMConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  connectionMode?: 'direct' | 'hosted';
  licenseRequired?: boolean;
  demoUnlockRequired?: boolean;
  demoUnlocked?: boolean;
  gatewayUrl?: string;
  gatewayConnected?: boolean;
  gatewayAccountLabel?: string;
  gatewaySessionExpiresAt?: string;
  gatewayQuota?: {
    limit: number;
    used: number;
    remaining: number;
  };
  hasEnvKey?: boolean;
  envKeyName?: string;
  hasSavedKey?: boolean;
}

export interface PersistedConfig {
  connectionMode?: 'direct' | 'hosted';
  provider: string;
  model: string;
  baseUrl: string;
  temperature: number;
  maxTokens: number;
  apiKey?: string;
  gatewayUrl?: string;
  gatewaySession?: string;
  apiKeyFromEnv?: boolean;
}

export interface FileItem {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: string;
}

export interface MaterialType {
  id: string;
  title: string;
  description: string;
  path: string;
}
