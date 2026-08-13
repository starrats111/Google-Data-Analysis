import { googleAdsLength } from "./text-length";

const MAX_HEADLINE_LENGTH = 30;
const MAX_DESCRIPTION_LENGTH = 90;
const MIN_HEADLINES = 3;
const MIN_DESCRIPTIONS = 2;
const MAX_HEADLINES = 15;
const MAX_DESCRIPTIONS = 4;

export interface CompletionInput {
  existingHeadlines: string[];
  existingDescriptions: string[];
  generatedHeadlines: string[];
  generatedDescriptions: string[];
}

export interface CompletionResult {
  headlines: string[];
  descriptions: string[];
}

function dedupeAndTake(
  existing: string[],
  generated: string[],
  minTarget: number,
  maxTarget: number,
  maxLength: number,
): string[] {
  const result = existing
    .filter((s) => s.length > 0 && googleAdsLength(s) <= maxLength)
    .slice(0, maxTarget);
  const seen = new Set(result.map((s) => s.toLowerCase()));
  for (const item of generated) {
    if (result.length >= minTarget) break;
    const lower = item.toLowerCase();
    if (!seen.has(lower) && item.length > 0 && googleAdsLength(item) <= maxLength) {
      seen.add(lower);
      result.push(item);
    }
  }
  return result.slice(0, maxTarget);
}

export function completeDraftCopy(input: CompletionInput): CompletionResult {
  return {
    headlines: dedupeAndTake(
      input.existingHeadlines,
      input.generatedHeadlines,
      MIN_HEADLINES,
      MAX_HEADLINES,
      MAX_HEADLINE_LENGTH,
    ),
    descriptions: dedupeAndTake(
      input.existingDescriptions,
      input.generatedDescriptions,
      MIN_DESCRIPTIONS,
      MAX_DESCRIPTIONS,
      MAX_DESCRIPTION_LENGTH,
    ),
  };
}
