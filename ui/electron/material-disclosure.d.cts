export function internalOnlyRestrictions(entries: readonly string[] | undefined): string[];
export function intakeDisclosureEntries(body: string): string[];
export function classifyDisclosureEntries(entries: readonly string[]): {
  writingRequirements: string[];
  restrictions: string[];
  unresolved: string[];
};
export const INTERNAL_ONLY_MESSAGE: string;
