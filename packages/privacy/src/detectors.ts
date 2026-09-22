import { LIMITS, createSafeError } from '@browser-cortex/contracts';

export type SensitiveCategory =
  | 'email'
  | 'phone'
  | 'payment-card'
  | 'api-token'
  | 'private-key'
  | 'custom'
  | 'manual';

export type SensitiveSeverity = 'sensitive' | 'restricted';

export interface SensitiveSpan {
  readonly start: number;
  readonly end: number;
  readonly category: SensitiveCategory;
  readonly severity: SensitiveSeverity;
  readonly detector: string;
}

export interface ManualSensitiveSpan {
  readonly start: number;
  readonly end: number;
  readonly category?: 'manual';
  readonly severity?: SensitiveSeverity;
}

export interface DetectionOptions {
  readonly customTerms?: readonly string[];
  readonly manualSpans?: readonly ManualSensitiveSpan[];
  readonly maxDetections?: number;
}

const DEFAULT_MAX_DETECTIONS = 256;

function collectRegex(
  text: string,
  pattern: RegExp,
  category: SensitiveCategory,
  severity: SensitiveSeverity,
  detector: string,
  output: SensitiveSpan[],
  maximum: number,
  predicate?: (value: string) => boolean,
): void {
  for (const match of text.matchAll(pattern)) {
    if (output.length >= maximum) return;
    const value = match[0];
    const start = match.index;
    if (start === undefined || value.length === 0 || (predicate !== undefined && !predicate(value))) continue;
    output.push({ start, end: start + value.length, category, severity, detector });
  }
}

function luhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[\s-]/gu, '');
  if (!/^\d{13,19}$/u.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const code = digits.charCodeAt(index) - 48;
    let value = code;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function normalizeMaximum(value: number | undefined): number {
  const maximum = value ?? DEFAULT_MAX_DETECTIONS;
  if (!Number.isSafeInteger(maximum) || maximum <= 0 || maximum > 2_048) {
    throw createSafeError('INVALID_INPUT');
  }
  return maximum;
}

function addCustomTerms(
  text: string,
  terms: readonly string[],
  output: SensitiveSpan[],
  maximum: number,
): void {
  const foldedText = text.toLocaleLowerCase('en-US');
  const uniqueTerms = new Set(
    terms
      .map((term) => term.trim())
      .filter((term) => term.length >= 2 && term.length <= 256)
      .map((term) => term.toLocaleLowerCase('en-US')),
  );
  for (const term of uniqueTerms) {
    let offset = 0;
    while (offset < foldedText.length && output.length < maximum) {
      const start = foldedText.indexOf(term, offset);
      if (start < 0) break;
      output.push({
        start,
        end: start + term.length,
        category: 'custom',
        severity: 'sensitive',
        detector: 'workspace-term',
      });
      offset = start + Math.max(1, term.length);
    }
  }
}

function addManualSpans(
  text: string,
  spans: readonly ManualSensitiveSpan[],
  output: SensitiveSpan[],
  maximum: number,
): void {
  for (const span of spans) {
    if (output.length >= maximum) return;
    if (
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > text.length
    ) {
      throw createSafeError('INVALID_INPUT');
    }
    output.push({
      start: span.start,
      end: span.end,
      category: 'manual',
      severity: span.severity ?? 'sensitive',
      detector: 'user-marked',
    });
  }
}

export function detectSensitiveData(text: string, options: DetectionOptions = {}): SensitiveSpan[] {
  if (text.length > LIMITS.jsonStringCharacters) throw createSafeError('PAYLOAD_TOO_LARGE');
  const maximum = normalizeMaximum(options.maxDetections);
  const candidateLimit = maximum + 1;
  const spans: SensitiveSpan[] = [];

  // User-marked and restricted categories take priority. If the configured cap
  // cannot represent every discovered span, fail closed instead of silently
  // dropping a later high-severity secret.
  addManualSpans(text, options.manualSpans ?? [], spans, candidateLimit);
  const privateKeyBoundary = (kind: 'BEGIN' | 'END') =>
    ['-----', kind, ' ', '[A-Z0-9 ]*', 'PRIVATE KEY-----'].join('');
  collectRegex(
    text,
    new RegExp(`${privateKeyBoundary('BEGIN')}[\\s\\S]{0,65536}?${privateKeyBoundary('END')}`, 'gu'),
    'private-key',
    'restricted',
    'private-key-block',
    spans,
    candidateLimit,
  );
  collectRegex(
    text,
    /\b(?:sk|rk)-[A-Za-z0-9_-]{20,}\b|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b|\bAKIA[0-9A-Z]{16}\b/gu,
    'api-token',
    'restricted',
    'known-token-format',
    spans,
    candidateLimit,
  );
  collectRegex(
    text,
    /(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/gu,
    'payment-card',
    'restricted',
    'payment-card-luhn',
    spans,
    candidateLimit,
    luhnValid,
  );
  addCustomTerms(text, options.customTerms ?? [], spans, candidateLimit);
  collectRegex(
    text,
    /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+\b/giu,
    'email',
    'sensitive',
    'email-structure',
    spans,
    candidateLimit,
  );
  collectRegex(
    text,
    /(?<!\w)(?:\+?\d{1,3}[ .-]?)?(?:\(?\d{2,4}\)?[ .-]?)?\d{3}[ .-]?\d{4}(?!\w)/gu,
    'phone',
    'sensitive',
    'phone-like',
    spans,
    candidateLimit,
    (value) => {
      const digitCount = value.replace(/\D/gu, '').length;
      return digitCount >= 7 && digitCount <= 15;
    },
  );

  if (spans.length > maximum) throw createSafeError('SENSITIVE_DATA_BLOCKED');
  return spans
    .sort((left, right) => left.start - right.start || right.end - left.end || left.category.localeCompare(right.category))
    .slice(0, maximum);
}
