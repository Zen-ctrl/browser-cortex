import { LIMITS, createSafeError } from '@browser-cortex/contracts';

import type { SensitiveCategory, SensitiveSeverity, SensitiveSpan } from './detectors.js';

export interface MergedSensitiveSpan {
  readonly start: number;
  readonly end: number;
  readonly categories: readonly SensitiveCategory[];
  readonly severity: SensitiveSeverity;
}

export interface RedactionEntry extends MergedSensitiveSpan {
  readonly placeholder: string;
}

export interface RedactionResult {
  readonly sanitizedText: string;
  readonly entries: readonly RedactionEntry[];
  readonly replacementMap: ReadonlyMap<string, string>;
}

export interface RehydrationResult {
  readonly text: string;
  readonly unresolvedPlaceholders: readonly string[];
}

const PLACEHOLDER_PATTERN = /\[\[BCX_[a-f0-9]{32}_[0-9]{1,4}_[a-f0-9]{16}\]\]/gu;

function randomHex(bytes: number): string {
  const data = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(data);
  let result = '';
  for (const byte of data) result += byte.toString(16).padStart(2, '0');
  return result;
}

function severityRank(value: SensitiveSeverity): number {
  return value === 'restricted' ? 2 : 1;
}

export function mergeSensitiveSpans(text: string, input: readonly SensitiveSpan[]): MergedSensitiveSpan[] {
  const sorted = input
    .map((span) => {
      if (
        !Number.isSafeInteger(span.start) ||
        !Number.isSafeInteger(span.end) ||
        span.start < 0 ||
        span.end <= span.start ||
        span.end > text.length
      ) {
        throw createSafeError('INVALID_INPUT');
      }
      return span;
    })
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const merged: Array<{
    start: number;
    end: number;
    categories: SensitiveCategory[];
    severity: SensitiveSeverity;
  }> = [];
  for (const span of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || span.start > previous.end) {
      merged.push({
        start: span.start,
        end: span.end,
        categories: [span.category],
        severity: span.severity,
      });
      continue;
    }
    previous.end = Math.max(previous.end, span.end);
    if (!previous.categories.includes(span.category)) previous.categories.push(span.category);
    if (severityRank(span.severity) > severityRank(previous.severity)) previous.severity = span.severity;
  }
  return merged.map((span) => Object.freeze({
    ...span,
    categories: Object.freeze([...span.categories].sort()),
  }));
}

export function redactSensitiveData(text: string, spans: readonly SensitiveSpan[]): RedactionResult {
  if (text.length > LIMITS.jsonStringCharacters) throw createSafeError('PAYLOAD_TOO_LARGE');
  const merged = mergeSensitiveSpans(text, spans);
  const replacementMap = new Map<string, string>();
  const entries: RedactionEntry[] = [];
  let token: string;
  do token = randomHex(16); while (text.includes(`[[BCX_${token}_`));
  let cursor = 0;
  let sanitizedText = '';
  for (const [index, span] of merged.entries()) {
    let placeholder: string;
    do placeholder = `[[BCX_${token}_${index}_${randomHex(8)}]]`; while (text.includes(placeholder));
    sanitizedText += text.slice(cursor, span.start);
    sanitizedText += placeholder;
    replacementMap.set(placeholder, text.slice(span.start, span.end));
    entries.push(Object.freeze({ ...span, placeholder }));
    cursor = span.end;
  }
  sanitizedText += text.slice(cursor);
  return {
    sanitizedText,
    entries: Object.freeze(entries),
    replacementMap,
  };
}

export function rehydrateText(
  responseText: string,
  replacementMap: ReadonlyMap<string, string>,
): RehydrationResult {
  if (responseText.length > LIMITS.generatedOutputBytes) throw createSafeError('PAYLOAD_TOO_LARGE');
  const unresolved = new Set<string>();
  const text = responseText.replace(PLACEHOLDER_PATTERN, (placeholder) => {
    const replacement = replacementMap.get(placeholder);
    if (replacement === undefined) {
      unresolved.add(placeholder);
      return placeholder;
    }
    return replacement;
  });
  return { text, unresolvedPlaceholders: Object.freeze([...unresolved]) };
}
