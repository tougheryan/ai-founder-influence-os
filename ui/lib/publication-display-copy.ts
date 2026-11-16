import { platformDisplayName } from './product-copy';

export type PublicationDisplayPlatform = 'wechat' | 'xiaohongshu' | 'moments' | 'shipinhao' | 'douyin';
export type PublicationDisplayStatus =
  | 'pending'
  | 'authorizing'
  | 'draft_filled'
  | 'retryable_failure'
  | 'manual_intervention_required'
  | 'published_confirmed'
  | 'unknown_completion';

type PublicationErrorDisplayJob = {
  platform: PublicationDisplayPlatform;
  status: PublicationDisplayStatus;
  last_error?: { code?: string; message?: string };
};

type PublicationLabelDisplayJob = {
  platform: PublicationDisplayPlatform;
  item_id: string;
  delivery_kind: 'draft_fill' | 'execution_package';
};

const SAFE_JOB_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function safePublicationJobErrorCode(code?: string): string {
  const normalized = code?.trim().toLowerCase();
  return normalized && SAFE_JOB_ERROR_CODE.test(normalized) ? normalized : 'unknown_error';
}

export function publicationJobErrorCopy(job: PublicationErrorDisplayJob): string | null {
  if (!job.last_error) return null;
  const code = safePublicationJobErrorCode(job.last_error.code);
  const platform = platformDisplayName(job.platform);
  const messages: Record<string, string> = {
    captcha: `${platform}要求输入验证码。请在平台完成验证后重试。`,
    risk_control: `${platform}需要安全确认。请在平台完成确认后重试。`,
    device_confirmation: `${platform}需要设备确认。请在已配对设备上确认后重试。`,
    authorization_required: `${platform}授权已失效。请到系统设置重新授权后重试。`,
    browser_session_required: job.platform === 'xiaohongshu'
      ? '还没有登录小红书。打开编辑器完成登录后再试。'
      : `还没有登录${platform}后台。打开编辑器完成登录后再试。`,
    mobile_bridge_required: '手机连接尚未完成。请到系统设置连接手机后重试。',
    browser_fill_incomplete: `内容没有完整填入${platform}。请在已打开的编辑器中补齐并保存草稿。`,
    browser_save_confirmation_required: `内容已填入${platform}编辑器，但还不能确认是否保存成功。请到平台检查并手动保存草稿。`,
    snapshot_clone_failed: `配图没有完整交给${platform}。请重新打开编辑器后重试。`,
    interrupted_authorization: '上次操作在平台确认时中断，结果还不确定。请先到平台核实，不要直接重试。',
    credential_unavailable: `${platform}连接还没有配置好。请到系统设置检查授权后重试。`,
    configuration_missing: `${platform}连接还没有配置好。请到系统设置完成配置后重试。`,
    not_configured: `${platform}连接还没有配置好。请到系统设置完成配置后重试。`,
    adapter_unavailable: `${platform}连接暂时不可用。请检查系统设置后重试。`,
    api_unavailable: `${platform}接口暂时不可用。请稍后重试，或改用已登录的编辑器。`,
    network_unavailable: `${platform}连接失败。请检查网络后重试。`,
    network_timeout: `${platform}连接超时。请检查网络后重试。`,
    temporary_network: `${platform}连接中断。请检查网络后重试。`,
    bridge_exception: '本机连接没有完成这项操作。请检查系统设置后重试。',
    invalid_adapter_result: '平台返回的状态无法确认。请先到平台核实结果。',
  };
  if (messages[code]) return messages[code];
  if (job.status === 'unknown_completion') {
    return '这项操作的结果还不确定。请先到平台核实，不要直接重试。';
  }
  return '这份内容没有准备好。请重试；如果仍失败，可在技术详情中查看错误代码。';
}

export function publicationJobDisplayLabel(job: PublicationLabelDisplayJob): string {
  const ordinal = job.item_id.match(/-(\d+)$/)?.[1];
  if (job.platform === 'wechat') return '公众号长文';
  if (job.platform === 'xiaohongshu') return `小红书观点图文${ordinal ? ` ${ordinal}` : ''}`;
  if (job.platform === 'moments') return `朋友圈观点图文${ordinal ? ` ${ordinal}` : ''}`;
  return `${platformDisplayName(job.platform)}口播稿与拍摄说明${ordinal ? ` ${ordinal}` : ''}`;
}

export function publicationPrimaryAction(
  queueIsCurrent: boolean,
  queueIsComplete: boolean,
): 'prepare' | 'execute' {
  return queueIsCurrent && queueIsComplete ? 'execute' : 'prepare';
}
