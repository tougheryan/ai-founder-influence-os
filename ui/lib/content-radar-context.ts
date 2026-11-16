import type { ContentRadarPlatform, ContentRadarSnapshot } from './content-radar';
import { productionWorkspaceContext } from './production-workspace-context';

/** Navigation hints only. Reading these never starts research or authorizes a draft. */
export function contentRadarContext(raw: string | null) {
  const context = productionWorkspaceContext(raw);
  if (context.state !== 'selected') return { context, platforms: [] as ContentRadarPlatform[], industry: '' };
  const draft = JSON.parse(raw!).draft;
  const aliases: Record<string, ContentRadarPlatform> = {
    wechat: 'wechat_mp', wechat_mp: 'wechat_mp', xiaohongshu: 'xiaohongshu',
    shipinhao: 'wechat_channels', wechat_channels: 'wechat_channels',
  };
  const platforms = [...new Set<ContentRadarPlatform>(
    (Array.isArray(draft.selectedPlatforms) ? draft.selectedPlatforms : [])
      .filter((value: unknown): value is string => typeof value === 'string' && Object.hasOwn(aliases, value))
      .map((value: string) => aliases[value]),
  )];
  // Keep the complete title so the author can shorten it deliberately, not silently.
  const industry = typeof draft.topic === 'string' && draft.topic.trim().length <= 120 ? draft.topic.trim() : '';
  return { context, platforms, industry };
}

export function radarQueryReady(platform: ContentRadarPlatform | null, industry: string): boolean {
  const length = industry.trim().replace(/\s+/g, ' ').length;
  return platform !== null && length >= 2 && length <= 30;
}

export function radarForQuery(snapshot: ContentRadarSnapshot | null, platform: ContentRadarPlatform | null, industry: string) {
  return snapshot?.platform === platform && snapshot.industry === industry.trim().replace(/\s+/g, ' ') ? snapshot : null;
}
