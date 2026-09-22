import {
  ContextSegmentSchema,
  LIMITS,
  TaskContextSchema,
  createSafeError,
  parseTaskRequest,
  parseVersioned,
  type ContextSegment,
  type ProvenanceLabel,
  type Sensitivity,
  type SourceReference,
  type TaskContext,
  type TaskRequest,
} from '@browser-cortex/contracts';

export interface ContextSegmentInput {
  readonly id: string;
  readonly label: ProvenanceLabel;
  readonly content: string;
  readonly sensitivity: Sensitivity;
  readonly source?: SourceReference;
}

export function createContextSegment(input: ContextSegmentInput): ContextSegment {
  const trustedInstructions =
    input.label === 'user-input' || input.label === 'trusted-application-state';
  return parseVersioned(ContextSegmentSchema, {
    schemaVersion: 1,
    id: input.id,
    label: input.label,
    content: input.content,
    sensitivity: input.sensitivity,
    ...(input.source === undefined ? {} : { source: input.source }),
    trustedInstructions,
  });
}

export interface AssembleTaskContextInput {
  readonly request: TaskRequest;
  readonly segments: readonly ContextSegment[];
  readonly allowedToolNames?: readonly string[];
  readonly sensitivity: Sensitivity;
  readonly timeBudgetMs?: number;
}

export function assembleTaskContext(input: AssembleTaskContextInput): TaskContext {
  const request = parseTaskRequest(input.request);
  const segments = input.segments.map((segment) => parseVersioned(ContextSegmentSchema, segment));
  const allowedSources = new Set(request.sourceIds);
  let totalCharacters = 0;
  for (const segment of segments) {
    totalCharacters += segment.content.length;
    if (totalCharacters > LIMITS.contextSegments * LIMITS.contextSegmentCharacters) {
      throw createSafeError('PAYLOAD_TOO_LARGE');
    }
    if (
      segment.source !== undefined &&
      segment.label === 'retrieved-source' &&
      !allowedSources.has(segment.source.documentId)
    ) {
      throw createSafeError('PERMISSION_DENIED');
    }
    if (
      (segment.label === 'selected-page-content' ||
        segment.label === 'retrieved-source' ||
        segment.label === 'tool-output') &&
      segment.trustedInstructions
    ) {
      throw createSafeError('INVALID_INPUT');
    }
  }
  return parseVersioned(TaskContextSchema, {
    schemaVersion: 1,
    requestId: request.requestId,
    workspaceId: request.workspaceId,
    goal: request.input,
    segments,
    allowedToolNames: input.allowedToolNames ?? [],
    sensitivity: input.sensitivity,
    onlinePolicy: request.onlinePolicy,
    timeBudgetMs: input.timeBudgetMs ?? 120_000,
  });
}
