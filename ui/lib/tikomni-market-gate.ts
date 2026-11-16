import { verifyRuntimeTikomniMarketSnapshot } from './runtime-writer';

const MARKET_SNAPSHOT_PATH_RE = /^\s*-\s*(?:TikOmni\s*)?研究快照\s*[：:]\s*`?([^`\s]+\/snapshot\.json)`?\s*$/mi;
const MARKET_SNAPSHOT_SHA_RE = /^\s*-\s*(?:TikOmni\s*)?快照\s*(?:SHA-?256|sha-?256)\s*[：:]\s*`?([a-f0-9]{64})`?\s*$/mi;
const MARKET_SAMPLE_COUNT_RE = /^\s*-\s*(?:可验证(?:公开)?样本数|公开(?:可验证)?样本数|样本数量)\s*[：:]\s*([0-9]+)\b.*$/mi;

export type MarketSnapshotBinding = {
  snapshotPath: string;
  snapshotSha256: string;
};

/**
 * Facts that are frozen by the real-time TikOmni report rather than inferred
 * by a model. They can be safely repeated in a downstream validate report.
 */
export type MarketSignalEvidence = {
  sampleCount: number;
  creatorMode: boolean;
};

export class TikomniMarketGateError extends Error {}

export function marketSnapshotBindingFromReport(content: string, label: string): MarketSnapshotBinding {
  const pathMatch = MARKET_SNAPSHOT_PATH_RE.exec(content);
  const shaMatch = MARKET_SNAPSHOT_SHA_RE.exec(content);
  const snapshotPath = pathMatch?.[1]?.trim() || '';
  const snapshotSha256 = shaMatch?.[1]?.toLowerCase() || '';
  if (!snapshotPath || !snapshotSha256) {
    throw new TikomniMarketGateError(`${label}缺少 TikOmni 研究快照路径或 SHA-256，不能绕过实时对标门禁`);
  }
  if (!snapshotPath.startsWith('runs/') || snapshotPath.includes('..') || snapshotPath.includes('\\')) {
    throw new TikomniMarketGateError(`${label}中的 TikOmni 研究快照路径非法`);
  }
  return { snapshotPath, snapshotSha256 };
}

export function marketSignalEvidenceFromReport(content: string, label: string): MarketSignalEvidence {
  const match = MARKET_SAMPLE_COUNT_RE.exec(content);
  const sampleCount = match ? Number.parseInt(match[1], 10) : Number.NaN;
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 0) {
    throw new TikomniMarketGateError(`${label}缺少有效的可验证样本数量，不能把模型推测当作实时对标证据`);
  }
  const creatorMode = [
    /^\s*-\s*实时信号状态\s*[：:]\s*creator[\s_-]*mode\b/im,
    /^\s*-\s*创作模式\s*[：:]\s*(?:是|yes|true)\b/im,
    /^\s*-\s*(?:公开样本(?:对标)?状态|样本状态)\s*[：:].*(?:创作模式|暂不可用|不可用)/im,
  ].some((pattern) => pattern.test(content));
  if (creatorMode || sampleCount < 1) {
    throw new TikomniMarketGateError(`${label}没有取得任何已选平台的可验证公开样本，不能进入选题阶段`);
  }
  return { sampleCount, creatorMode: false };
}

export async function assertMarketSnapshotBoundToIntake(
  marketContent: string,
  intakePath: string,
  runId: string,
  label: string,
): Promise<MarketSnapshotBinding> {
  const binding = marketSnapshotBindingFromReport(marketContent, label);
  const verification = await verifyRuntimeTikomniMarketSnapshot(runId, binding.snapshotPath);
  if (!verification.verified) {
    throw new TikomniMarketGateError(
      `${label}绑定的 TikOmni 实时研究快照未通过校验：${verification.reason || '未知错误'}`,
    );
  }
  if (verification.run_id !== runId) {
    throw new TikomniMarketGateError(`${label}绑定的 TikOmni 研究快照不属于当前 runtime run`);
  }
  if (verification.manifest_path !== binding.snapshotPath || verification.snapshot_sha256 !== binding.snapshotSha256) {
    throw new TikomniMarketGateError(`${label}中的 TikOmni 研究快照摘要与存档不一致，需重新抓取对标`);
  }
  if (verification.source_path !== intakePath) {
    throw new TikomniMarketGateError(`${label}绑定的 TikOmni 研究快照不属于当前素材理解报告`);
  }
  return binding;
}
