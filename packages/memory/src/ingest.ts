import { sha256, text, utf8 } from "./encoding.js";
import type { ChunkRecord, ImportMediaType, ImportSource, Sensitivity } from "./types.js";
import { DEFAULT_MAX_JSON_DEPTH, MEMORY_SCHEMA_VERSION } from "./types.js";

const MAX_TITLE_LENGTH = 512;
const DEFAULT_CHUNK_CHARACTERS = 1_800;
const CHUNK_OVERLAP_CHARACTERS = 160;

export function tokenize(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((term) => term.length > 1)
    .slice(0, 4_000) ?? [];
}

function jsonDepth(value: unknown, depth = 0): number {
  if (depth > DEFAULT_MAX_JSON_DEPTH) return depth;
  if (Array.isArray(value)) return value.reduce((max, item) => Math.max(max, jsonDepth(item, depth + 1)), depth);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (max, item) => Math.max(max, jsonDepth(item, depth + 1)),
      depth,
    );
  }
  return depth;
}

function validateCsv(input: string): void {
  let quoted = false;
  let columns: number | undefined;
  let currentColumns = 1;
  let rows = 0;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character === '"') {
      if (quoted && input[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && character === ",") currentColumns += 1;
    else if (!quoted && character === "\n") {
      columns ??= currentColumns;
      if (currentColumns !== columns && input.slice(0, index).trim().length > 0) {
        throw new Error("CSV rows have inconsistent column counts.");
      }
      currentColumns = 1;
      rows += 1;
      if (rows > 100_000) throw new Error("CSV import exceeds the row safety limit.");
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
}

export function decodeAndValidateImport(source: ImportSource, maxBytes: number): { normalized: string; byteLength: number; warnings: string[] } {
  if (source.title.trim().length === 0 || source.title.length > MAX_TITLE_LENGTH) throw new Error("Document title is invalid.");
  const bytes = typeof source.content === "string" ? utf8(source.content) : source.content;
  if (bytes.byteLength > maxBytes) throw new Error(`Document exceeds the ${maxBytes} byte import limit.`);
  let decoded: string;
  try {
    decoded = typeof source.content === "string" ? source.content : text(bytes);
  } catch {
    throw new Error("Document is not valid UTF-8.");
  }
  const normalized = decoded.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const warnings: string[] = [];
  if (normalized.includes("\u0000")) throw new Error("Document contains unsupported null characters.");
  switch (source.mediaType) {
    case "application/json": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(normalized);
      } catch {
        throw new Error("JSON document is malformed.");
      }
      if (jsonDepth(parsed) > DEFAULT_MAX_JSON_DEPTH) throw new Error("JSON document exceeds the nesting limit.");
      break;
    }
    case "text/csv":
      validateCsv(normalized);
      break;
    case "text/markdown":
    case "text/plain":
      break;
    default:
      throw new Error("Unsupported import media type.");
  }
  if (normalized.length === 0) warnings.push("The imported document is empty.");
  return { normalized, byteLength: bytes.byteLength, warnings };
}

function preferredBoundary(input: string, start: number, hardEnd: number): number {
  if (hardEnd >= input.length) return input.length;
  const minimum = start + Math.floor(DEFAULT_CHUNK_CHARACTERS * 0.55);
  const candidates = [input.lastIndexOf("\n#", hardEnd), input.lastIndexOf("\n\n", hardEnd), input.lastIndexOf(". ", hardEnd) + 1];
  return candidates.find((candidate) => candidate >= minimum) ?? hardEnd;
}

export function createChunks(args: {
  text: string;
  workspaceId: string;
  documentId: string;
  revisionId: string;
  sensitivity: Sensitivity;
  sourceOrigin?: string;
  retentionUntil?: string;
  makeId: () => string;
  maxChunks: number;
}): ChunkRecord[] {
  const chunks: ChunkRecord[] = [];
  let start = 0;
  while (start < args.text.length) {
    if (chunks.length >= args.maxChunks) throw new Error("Document exceeds the active chunk limit.");
    const end = preferredBoundary(args.text, start, Math.min(args.text.length, start + DEFAULT_CHUNK_CHARACTERS));
    const chunkText = args.text.slice(start, end);
    const base: ChunkRecord = {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      kind: "chunk",
      id: args.makeId(),
      documentId: args.documentId,
      revisionId: args.revisionId,
      workspaceId: args.workspaceId,
      index: chunks.length,
      text: chunkText,
      startOffset: start,
      endOffset: end,
      tokenTerms: tokenize(chunkText),
      sensitivity: args.sensitivity,
    };
    const withOrigin = args.sourceOrigin === undefined ? base : { ...base, sourceOrigin: args.sourceOrigin };
    chunks.push(args.retentionUntil === undefined ? withOrigin : { ...withOrigin, retentionUntil: args.retentionUntil });
    if (end >= args.text.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP_CHARACTERS);
  }
  return chunks;
}

export async function fingerprintImport(cryptoProvider: Crypto, mediaType: ImportMediaType, content: string): Promise<string> {
  return sha256(cryptoProvider, utf8(`${mediaType}\u0000${content}`));
}
