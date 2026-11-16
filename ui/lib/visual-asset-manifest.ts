export type VisualAssetCandidate = {
  assetId: string;
  semanticRole: string;
  revisionId: string;
  path: string;
  sha256: string;
  platformBindings: string[];
  width?: number;
  height?: number;
  selectedAt?: string;
};

export type VisualAssetManifest = {
  schema: 'aifios.visual-asset-manifest.v1';
  slug: string;
  sourceContentHash: string;
  requiredRoles: string[];
  selections: Record<string, VisualAssetCandidate>;
  updatedAt?: string;
};

export function selectVisualAsset(
  manifest: VisualAssetManifest,
  candidate: VisualAssetCandidate,
  selectedAt = new Date().toISOString(),
): VisualAssetManifest {
  return {
    ...manifest,
    selections: {
      ...manifest.selections,
      [candidate.semanticRole]: {
        ...candidate,
        platformBindings: [...candidate.platformBindings],
        selectedAt,
      },
    },
    updatedAt: selectedAt,
  };
}

export function validateVisualAssetManifest(manifest: VisualAssetManifest): {
  valid: boolean;
  missingRoles: string[];
} {
  const missingRoles = manifest.requiredRoles.filter((role) => !manifest.selections[role]);
  return { valid: missingRoles.length === 0, missingRoles };
}

export function selectedAssetPlatforms(manifest: VisualAssetManifest): Record<string, string[]> {
  const destinations: Record<string, string[]> = {};
  for (const asset of Object.values(manifest.selections)) {
    for (const platform of asset.platformBindings) {
      destinations[platform] = [...new Set([...(destinations[platform] || []), asset.assetId])];
    }
  }
  return destinations;
}
