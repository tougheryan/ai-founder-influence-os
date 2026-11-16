export type RevisionReviewComparison = {
  newIssues: string[]; existingIssues: string[];
  newWarnings: string[]; existingWarnings: string[];
};

// The same whole-article length check remains a whole-article check after a local
// edit. Preserve the latest count in its text without calling it a new risk.
const reviewKey = (value: string) => value.replace(/^(公众号(?:正文|摘要)当前约 )\d+( 字)/, '$1[字数]$2');
function compare(before: string[], after: string[]) {
  const counts = new Map<string, number>();
  for (const item of before) counts.set(reviewKey(item), (counts.get(reviewKey(item)) || 0) + 1);
  const added: string[] = []; const existing: string[] = [];
  for (const item of after) {
    const key = reviewKey(item); const count = counts.get(key) || 0;
    if (count) { existing.push(item); counts.set(key, count - 1); }
    else added.push(item);
  }
  return { added, existing };
}
export function compareRevisionReview(before: { issues: string[]; warnings: string[] }, after: { issues: string[]; warnings: string[] }): RevisionReviewComparison {
  const issues = compare(before.issues, after.issues);
  const warnings = compare(before.warnings, after.warnings);
  return { newIssues: issues.added, existingIssues: issues.existing, newWarnings: warnings.added, existingWarnings: warnings.existing };
}
