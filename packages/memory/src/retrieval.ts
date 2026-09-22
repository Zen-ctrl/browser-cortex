import { tokenize } from "./ingest.js";
import type {
  ChunkRecord,
  DocumentRecord,
  EmbeddingProvider,
  EmbeddingRecord,
  SearchAuthorization,
  SearchResult,
  SourceGrantRecord,
} from "./types.js";

const RRF_K = 60;

export interface RetrievalSnapshot {
  chunks: readonly ChunkRecord[];
  documents: ReadonlyMap<string, DocumentRecord>;
  embeddings: readonly EmbeddingRecord[];
  grants: readonly SourceGrantRecord[];
}

function finiteVector(vector: readonly number[]): boolean {
  return vector.length > 0 && vector.every(Number.isFinite);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || !finiteVector(left) || !finiteVector(right)) return Number.NEGATIVE_INFINITY;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return Number.NEGATIVE_INFINITY;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function isAuthorized(
  chunk: ChunkRecord,
  authorization: SearchAuthorization | undefined,
  grants: readonly SourceGrantRecord[],
): boolean {
  const now = authorization?.now ?? new Date();
  if (chunk.retentionUntil && Date.parse(chunk.retentionUntil) <= now.getTime()) return false;
  if (authorization?.allowedSourceIds && !authorization.allowedSourceIds.includes(chunk.documentId)) return false;
  if (authorization?.deniedSourceIds?.includes(chunk.documentId)) return false;
  if (authorization?.allowedSensitivities && !authorization.allowedSensitivities.includes(chunk.sensitivity)) return false;
  if (authorization?.origin && chunk.sourceOrigin && authorization.origin !== chunk.sourceOrigin) return false;
  if (!authorization?.recipient) return true;
  return grants.some(
    (grant) =>
      grant.workspaceId === chunk.workspaceId &&
      grant.recipient === authorization.recipient &&
      grant.sourceIds.includes(chunk.documentId) &&
      !grant.revokedAt &&
      Date.parse(grant.expiresAt) > now.getTime() &&
      (!grant.origin || grant.origin === authorization.origin),
  );
}

function lexicalScores(query: string, chunks: readonly ChunkRecord[]): Map<string, number> {
  const terms = [...new Set(tokenize(query))];
  const scores = new Map<string, number>();
  if (terms.length === 0 || chunks.length === 0) return scores;
  const documentFrequency = new Map<string, number>();
  for (const chunk of chunks) {
    const present = new Set(chunk.tokenTerms);
    for (const term of terms) if (present.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }
  const averageLength = chunks.reduce((sum, chunk) => sum + chunk.tokenTerms.length, 0) / chunks.length || 1;
  for (const chunk of chunks) {
    const frequencies = new Map<string, number>();
    for (const term of chunk.tokenTerms) if (terms.includes(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const frequency = frequencies.get(term) ?? 0;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
      const lengthNormalization = 1.2 * (0.25 + 0.75 * (chunk.tokenTerms.length / averageLength));
      score += idf * ((frequency * 2.2) / (frequency + lengthNormalization));
    }
    if (score > 0) scores.set(chunk.id, score);
  }
  return scores;
}

async function vectorScores(
  query: string,
  chunks: readonly ChunkRecord[],
  embeddings: readonly EmbeddingRecord[],
  provider: EmbeddingProvider | undefined,
  signal: AbortSignal | undefined,
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  if (!provider || signal?.aborted) return scores;
  const [queryVector] = await provider.embed([query], signal);
  if (!queryVector || !finiteVector(queryVector)) return scores;
  const allowedChunks = new Set(chunks.map((chunk) => chunk.id));
  for (const embedding of embeddings) {
    if (
      !allowedChunks.has(embedding.chunkId) ||
      embedding.modelId !== provider.modelId ||
      embedding.modelRevision !== provider.modelRevision ||
      embedding.dimensions !== queryVector.length
    ) {
      continue;
    }
    const score = cosine(queryVector, embedding.vector);
    if (Number.isFinite(score)) scores.set(embedding.chunkId, score);
  }
  return scores;
}

function rank(scores: ReadonlyMap<string, number>): Map<string, number> {
  const ordered = [...scores].sort((left, right) => right[1] - left[1]);
  return new Map(ordered.map(([id], index) => [id, index + 1]));
}

export async function retrieve(
  snapshot: RetrievalSnapshot,
  request: {
    workspaceId: string;
    query: string;
    limit: number;
    authorization?: SearchAuthorization;
    embeddingProvider?: EmbeddingProvider;
    signal?: AbortSignal;
  },
): Promise<SearchResult[]> {
  if (request.query.trim().length === 0 || request.query.length > 24_000) throw new Error("Search query is empty or too long.");
  if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) throw new Error("Search limit must be from 1 to 100.");
  const chunks = snapshot.chunks.filter(
    (chunk) => chunk.workspaceId === request.workspaceId && isAuthorized(chunk, request.authorization, snapshot.grants),
  );
  const lexical = lexicalScores(request.query, chunks);
  const vectors = await vectorScores(request.query, chunks, snapshot.embeddings, request.embeddingProvider, request.signal);
  if (request.signal?.aborted) throw request.signal.reason ?? new DOMException("Search cancelled.", "AbortError");
  const lexicalRank = rank(lexical);
  const vectorRank = rank(vectors);
  const candidates = new Set([...lexical.keys(), ...vectors.keys()]);
  return chunks
    .filter((chunk) => candidates.has(chunk.id))
    .map((chunk): SearchResult | undefined => {
      const document = snapshot.documents.get(chunk.documentId);
      if (!document || document.currentRevisionId !== chunk.revisionId || document.deletedAt) return undefined;
      const lRank = lexicalRank.get(chunk.id);
      const vRank = vectorRank.get(chunk.id);
      const combinedScore = (lRank ? 1 / (RRF_K + lRank) : 0) + (vRank ? 1 / (RRF_K + vRank) : 0);
      const vectorScore = vectors.get(chunk.id);
      const base = {
        documentId: chunk.documentId,
        revisionId: chunk.revisionId,
        chunkId: chunk.id,
        title: document.title,
        text: chunk.text,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        lexicalScore: lexical.get(chunk.id) ?? 0,
        combinedScore,
      };
      return vectorScore === undefined ? base : { ...base, vectorScore };
    })
    .filter((result): result is SearchResult => result !== undefined)
    .sort((left, right) => right.combinedScore - left.combinedScore || left.chunkId.localeCompare(right.chunkId))
    .slice(0, request.limit);
}
