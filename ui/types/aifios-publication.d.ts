export {};

declare global {
  type AifiosCredentialId =
    | 'llm'
    | 'tikomni'
    | 'image_openrouter'
    | 'image_replicate'
    | 'image_ark'
    | 'image_dashscope'
    | 'image_zai'
    | 'image_minimax'
    | 'wechat_official_api'
    | 'wechat_browser_bridge'
    | 'xiaohongshu_browser_bridge'
    | 'moments_mobile_bridge';

  type AifiosCredentialStatus = {
    id: AifiosCredentialId;
    configured: boolean;
    updatedAt: string | null;
  };

  type AifiosBackupResult = {
    canceled: boolean;
    schema?: 'aifios.project-backup.v1';
    projectSchema?: 'aifios.project.v1';
    fileName?: string;
    fileCount?: number;
    totalBytes?: number;
    manifestSha256?: string;
    sourceProjectName?: string;
    switched?: boolean;
  };

  interface Window {
    aifiosCredentials?: {
      status: () => Promise<AifiosCredentialStatus[]>;
      save: (id: AifiosCredentialId, value: string) => Promise<AifiosCredentialStatus>;
      delete: (id: AifiosCredentialId) => Promise<AifiosCredentialStatus>;
    };
    aifiosProject?: {
      exportBackup: () => Promise<AifiosBackupResult>;
      importBackup: () => Promise<AifiosBackupResult>;
    };
    aifiosPublication?: {
      credentialStatus: () => Promise<Array<{ id: string; configured: boolean; updatedAt: string | null }>>;
      saveCredential: (id: string, value: string) => Promise<{ id: string; configured: boolean }>;
      deleteCredential: (id: string) => Promise<{ id: string; configured: boolean }>;
      bridgeStatus: () => Promise<Array<{ id: string; configured: boolean; mode: 'official_api' | 'authorized_browser' | 'mobile_bridge' }>>;
      openEditor: (platform: 'wechat' | 'xiaohongshu') => Promise<{ opened: boolean; platform: 'wechat' | 'xiaohongshu' }>;
      fillDraft: (request: {
        queuePath: string;
        runId: string;
        jobId: string;
        expectedPayloadHash: string;
      }) => Promise<{ receipt?: unknown }>;
    };
  }
}
