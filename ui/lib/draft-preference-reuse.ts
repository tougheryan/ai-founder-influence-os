import { getMaterialAnalysisContext, getMaterialWritingRequirements, isMaterialAnalysisCurrent } from './material-analysis';
import { materialAnalysisFingerprint } from './material-analysis-version';
import { assertCreativeVersion, CreativeLibraryConflictError, CreativeLibraryError, readCreativeProfile, saveCreativeProfile, type CreativeProfilePatch } from './creative-library';
import { appendPreferenceText, draftPreferenceCandidates, reusablePreferenceText, type DraftPreferenceChoice } from './draft-preference-candidates';

export async function readDraftPreferenceReview(runId: string, inputFingerprint: string) {
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,100}$/.test(runId) || !/^[a-f0-9]{64}$/.test(inputFingerprint)) throw new CreativeLibraryError('请从当前稿件打开偏好建议。');
  // getMaterialAnalysisContext verifies this exact existing run, and applies
  // its current author correction. There is deliberately no active-run fallback.
  const context = await getMaterialAnalysisContext(runId);
  if (!context || !isMaterialAnalysisCurrent(context) || context.inputFingerprint !== inputFingerprint) throw new CreativeLibraryConflictError('本篇素材或要求已更新，请重新整理并核对后再保存偏好。');
  const profile = await readCreativeProfile();
  return {
    runId, inputFingerprint, analysisFingerprint: materialAnalysisFingerprint(context),
    profile, candidates: draftPreferenceCandidates(getMaterialWritingRequirements(context)),
  };
}

/** Caller holds material-analysis:<run> then creative-library:settings locks. */
export async function saveDraftPreferences(input: {
  runId: string; inputFingerprint: string; analysisFingerprint: unknown; expectedVersion: unknown; choices: unknown;
}) {
  const review = await readDraftPreferenceReview(input.runId, input.inputFingerprint);
  assertCreativeVersion(input.expectedVersion, review.profile.version);
  if (input.analysisFingerprint !== review.analysisFingerprint) throw new CreativeLibraryConflictError('本篇要求已修改，请重新读取偏好建议。');
  if (!Array.isArray(input.choices) || !input.choices.length || input.choices.length > 12) throw new CreativeLibraryError('请选择需要长期保留的偏好。');
  const patch: CreativeProfilePatch = {};
  const used = new Set<string>();
  for (const value of input.choices) {
    const choice = value as DraftPreferenceChoice;
    const candidate = review.candidates.find((item) => item.id === choice?.id);
    if (!candidate || used.has(candidate.id) || typeof choice.value !== 'string' || !reusablePreferenceText(choice.value)) throw new CreativeLibraryError('偏好候选已变化，或含有本篇临时要求，请重新核对。');
    used.add(candidate.id);
    patch[candidate.field] = appendPreferenceText(patch[candidate.field] ?? review.profile.profile[candidate.field], [choice.value.trim()]);
  }
  if (Object.entries(patch).every(([key, value]) => review.profile.profile[key as keyof CreativeProfilePatch] === value)) return review.profile;
  return saveCreativeProfile({ action: review.profile.initialized ? 'update' : 'initialize', profile: patch, expectedVersion: review.profile.version });
}
