import { z } from 'zod';

import { ERROR_CODES, createSafeError } from './errors.js';
import { assertJsonValue, type JsonValue } from './json.js';
import { LIMITS, SCHEMA_VERSION } from './limits.js';

export const IdentifierSchema = z
  .string()
  .min(1)
  .max(LIMITS.identifierCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, 'Identifier contains unsupported characters.');

export const FingerprintSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(LIMITS.jsonStringCharacters),
    z.array(JsonValueSchema).max(LIMITS.jsonEntries),
    z.record(z.string().max(LIMITS.identifierCharacters), JsonValueSchema).superRefine((value, context) => {
      for (const key of Object.keys(value)) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          context.addIssue({ code: 'custom', message: `Unsafe JSON key: ${key}.` });
        }
      }
    }),
  ]),
);

export const RouteKindSchema = z.enum(['deterministic', 'local-model', 'online-model']);
export type RouteKind = z.infer<typeof RouteKindSchema>;

export const SensitivitySchema = z.enum(['public', 'internal', 'sensitive', 'restricted']);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const RunStateSchema = z.enum([
  'draft',
  'validated',
  'awaiting-approval',
  'ready',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
  'outcome-unknown',
]);
export type RunState = z.infer<typeof RunStateSchema>;

export const TaskKindSchema = z.enum(['search', 'extract', 'summarize', 'transform', 'plan']);
export type TaskKind = z.infer<typeof TaskKindSchema>;

export const TaskRequestSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  requestId: IdentifierSchema,
  task: TaskKindSchema,
  input: z.string().min(1).max(LIMITS.taskInstructionCharacters),
  sourceIds: z.array(IdentifierSchema).max(LIMITS.sourceIds),
  workspaceId: IdentifierSchema,
  onlinePolicy: z.enum(['deny', 'ask']),
  outputSchemaId: IdentifierSchema.optional(),
});
export type TaskRequest = z.infer<typeof TaskRequestSchema>;

export function parseVersioned<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const version =
    typeof input === 'object' && input !== null && 'schemaVersion' in input
      ? (input as { readonly schemaVersion?: unknown }).schemaVersion
      : undefined;
  throw createSafeError(version !== undefined && version !== SCHEMA_VERSION
    ? 'INVALID_SCHEMA_VERSION'
    : 'INVALID_INPUT');
}

export function parseTaskRequest(input: unknown): TaskRequest {
  return parseVersioned(TaskRequestSchema, input);
}

export const RouteReasonCodeSchema = z
  .string()
  .min(1)
  .max(LIMITS.reasonCodeCharacters)
  .regex(/^[A-Z][A-Z0-9_]*$/u);

export const RouteDecisionSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  requestId: IdentifierSchema,
  route: z.union([RouteKindSchema, z.literal('unavailable')]),
  reasonCodes: z.array(RouteReasonCodeSchema).min(1).max(LIMITS.reasonCodes),
  modelId: IdentifierSchema.optional(),
  modelRevision: z.string().min(1).max(256).optional(),
  policyVersion: z.string().min(1).max(LIMITS.policyVersionCharacters),
  requiresDisclosure: z.boolean(),
});
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;

export const SourceReferenceSchema = z
  .strictObject({
    documentId: IdentifierSchema,
    revision: z.string().min(1).max(256),
    chunkId: IdentifierSchema,
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
  })
  .refine((value) => value.endOffset >= value.startOffset, {
    message: 'Source end offset must not precede its start offset.',
    path: ['endOffset'],
  });
export type SourceReference = z.infer<typeof SourceReferenceSchema>;

export const ProvenanceLabelSchema = z.enum([
  'user-input',
  'trusted-application-state',
  'selected-page-content',
  'retrieved-source',
  'tool-output',
]);
export type ProvenanceLabel = z.infer<typeof ProvenanceLabelSchema>;

export const ContextSegmentSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: IdentifierSchema,
  label: ProvenanceLabelSchema,
  content: z.string().max(LIMITS.contextSegmentCharacters),
  sensitivity: SensitivitySchema,
  source: SourceReferenceSchema.optional(),
  trustedInstructions: z.boolean(),
});
export type ContextSegment = z.infer<typeof ContextSegmentSchema>;

export const TaskContextSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  requestId: IdentifierSchema,
  workspaceId: IdentifierSchema,
  goal: z.string().min(1).max(LIMITS.taskInstructionCharacters),
  segments: z.array(ContextSegmentSchema).max(LIMITS.contextSegments),
  allowedToolNames: z.array(IdentifierSchema).max(128),
  sensitivity: SensitivitySchema,
  onlinePolicy: z.enum(['deny', 'ask']),
  timeBudgetMs: z.number().int().positive().max(120_000),
});
export type TaskContext = z.infer<typeof TaskContextSchema>;

export const SafeErrorSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  code: z.enum(ERROR_CODES),
  message: z.string().min(1).max(512),
  recoverable: z.boolean(),
  retryHint: z.string().min(1).max(512).optional(),
});

export const SourceRevisionSchema = z.strictObject({
  sourceId: IdentifierSchema,
  revision: z.string().min(1).max(256),
});
export type SourceRevision = z.infer<typeof SourceRevisionSchema>;

export const ApprovalBindingSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  purpose: z.enum(['online-disclosure', 'tool-action']),
  payloadFingerprint: FingerprintSchema,
  endpoint: z.string().url().max(LIMITS.endpointCharacters),
  method: z.enum(['POST']),
  model: z.string().min(1).max(LIMITS.modelLabelCharacters),
  sourceRevisions: z.array(SourceRevisionSchema).max(LIMITS.sourceReferences),
  policyVersion: z.string().min(1).max(LIMITS.policyVersionCharacters),
});
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;

export const CapabilityGrantSchema = z
  .strictObject({
    schemaVersion: z.literal(SCHEMA_VERSION),
    grantId: IdentifierSchema,
    subject: IdentifierSchema,
    originatingApplication: z.string().min(1).max(512),
    workspaceId: IdentifierSchema,
    operation: IdentifierSchema,
    sourceIds: z.array(IdentifierSchema).max(LIMITS.sourceIds),
    sourceNamespace: z.string().min(1).max(256).optional(),
    toolVersion: z.string().min(1).max(128).optional(),
    parameterFingerprint: FingerprintSchema.optional(),
    recipient: z.string().min(1).max(512).optional(),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    usageLimit: z.number().int().positive().max(10_000),
    revoked: z.boolean(),
  })
  .refine((value) => value.expiresAt > value.issuedAt, {
    message: 'Grant expiration must be after issuance.',
    path: ['expiresAt'],
  });
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>;

export const DisclosureSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  disclosureId: IdentifierSchema,
  endpoint: z.string().url().max(LIMITS.endpointCharacters),
  endpointOrigin: z.string().url().max(LIMITS.endpointCharacters),
  method: z.literal('POST'),
  modelLabel: z.string().min(1).max(LIMITS.modelLabelCharacters),
  serializedPayload: z.string().max(LIMITS.canonicalBytes),
  payloadByteLength: z.number().int().nonnegative().max(LIMITS.canonicalBytes),
  payloadFingerprint: FingerprintSchema,
  sourceRevisions: z.array(SourceRevisionSchema).max(LIMITS.sourceReferences),
  detectedCategories: z.array(IdentifierSchema).max(64),
  limitations: z.array(z.string().min(1).max(512)).max(32),
  policyVersion: z.string().min(1).max(LIMITS.policyVersionCharacters),
  expiresAt: TimestampSchema,
});
export type Disclosure = z.infer<typeof DisclosureSchema>;

export const OnlineProviderResponseSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  output: z.string().max(LIMITS.generatedOutputBytes),
  model: z.string().min(1).max(LIMITS.modelLabelCharacters).optional(),
  usage: z
    .strictObject({
      inputTokens: z.number().int().nonnegative().optional(),
      outputTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
});
export type OnlineProviderResponse = z.infer<typeof OnlineProviderResponseSchema>;

export const ToolDescriptorSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  name: IdentifierSchema,
  version: z.string().min(1).max(128),
  description: z.string().min(1).max(1_024),
  origin: z.string().url().max(LIMITS.endpointCharacters),
  effect: z.enum(['read', 'local-write', 'external-write']),
  inputSchema: JsonValueSchema,
  outputSchema: JsonValueSchema,
  requiredCapabilities: z.array(IdentifierSchema).max(64),
  timeoutMs: z.number().int().positive().max(120_000),
  idempotency: z.enum(['read-only', 'keyed', 'none']),
  implementationId: IdentifierSchema,
});
export type ToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

export const RuntimeCapabilitiesSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  generationAvailable: z.boolean(),
  embeddingAvailable: z.boolean(),
  structuredOutput: z.boolean(),
  modelIds: z.array(IdentifierSchema).max(32),
  reducedMode: z.boolean(),
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;

export const WorkflowOperationSchema = z.enum([
  'source.select', 'csv.parse', 'rows.filter', 'rows.sort', 'rows.project', 'rows.aggregate',
  'records.compare', 'memory.search', 'text.extract', 'draft.create', 'preview.show',
  'approval.require', 'tool.invoke', 'file.export',
]);
export const WorkflowStepSchema = z.strictObject({
  id: IdentifierSchema,
  op: WorkflowOperationSchema,
  input: JsonValueSchema.optional(),
  output: IdentifierSchema.optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  failurePolicy: z.enum(['stop', 'continue']).optional(),
  predicate: JsonValueSchema.optional(),
  fields: z.array(IdentifierSchema).max(256).optional(),
  sort: z.array(z.strictObject({
    field: IdentifierSchema,
    direction: z.enum(['asc', 'desc']),
    mode: z.enum(['primitive', 'decimal', 'iso-date']).optional(),
  })).max(16).optional(),
  aggregate: z.array(z.strictObject({
    field: IdentifierSchema,
    operation: z.enum(['count', 'sum', 'min', 'max', 'average']),
    output: IdentifierSchema,
    currency: z.strictObject({ field: IdentifierSchema, output: IdentifierSchema }).optional(),
  })).max(32).optional(),
  compareFields: z.array(IdentifierSchema).max(256).optional(),
  scope: z.string().min(1).max(512).optional(),
  approvalRef: z.string().min(1).max(512).optional(),
  tool: z.strictObject({ name: IdentifierSchema, version: z.string().min(1).max(128) }).optional(),
  arguments: z.record(IdentifierSchema, JsonValueSchema).optional(),
  filename: z.string().min(1).max(512).optional(),
  format: z.enum(['csv', 'json', 'text']).optional(),
  schema: z.record(IdentifierSchema, z.enum(['string', 'number', 'boolean', 'null'])).optional(),
  query: z.string().min(1).max(LIMITS.taskInstructionCharacters).optional(),
});
const WorkflowValueTypeSchema = z.enum(['string', 'number', 'boolean', 'object', 'array']);
export const WorkflowDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: IdentifierSchema,
  version: z.string().min(1).max(128),
  name: z.string().min(1).max(512),
  description: z.string().max(2_048).optional(),
  inputSchema: z.record(IdentifierSchema, WorkflowValueTypeSchema),
  outputSchema: z.record(IdentifierSchema, WorkflowValueTypeSchema).optional(),
  originScope: z.array(z.string().url().max(LIMITS.endpointCharacters)).max(32).optional(),
  requiredCapabilities: z.array(IdentifierSchema).max(128),
  sourceDependencies: z.array(SourceRevisionSchema).max(LIMITS.sourceReferences),
  toolDependencies: z.array(z.strictObject({ name: IdentifierSchema, version: z.string().min(1).max(128) })).max(64),
  limits: z.strictObject({
    maxRows: z.number().int().positive().max(10_000),
    maxSteps: z.number().int().positive().max(32),
    maxDurationMs: z.number().int().positive().max(120_000),
  }),
  steps: z.array(WorkflowStepSchema).min(1).max(32),
});
export type WorkflowDefinitionContract = z.infer<typeof WorkflowDefinitionSchema>;

const IsoTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
export const StepReceiptSchema = z.strictObject({
  stepId: IdentifierSchema,
  operation: WorkflowOperationSchema,
  state: z.enum(['succeeded', 'failed', 'cancelled', 'outcome-unknown']),
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema,
  outputName: z.string().min(1).max(256).optional(),
  errorCode: z.string().min(1).max(128).optional(),
});
export const WorkflowReceiptSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  receiptId: IdentifierSchema,
  runId: IdentifierSchema,
  workflowId: IdentifierSchema,
  workflowVersion: z.string().min(1).max(128),
  planFingerprint: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/u),
  state: RunStateSchema,
  sourceRevisions: z.array(SourceRevisionSchema).max(LIMITS.sourceReferences),
  steps: z.array(StepReceiptSchema).max(32),
  startedAt: IsoTimestampSchema,
  endedAt: IsoTimestampSchema,
  outputFingerprint: FingerprintSchema.optional(),
});
export type WorkflowReceipt = z.infer<typeof WorkflowReceiptSchema>;

function parseBoundedVersioned<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    assertJsonValue(input);
  } catch (error) {
    throw createSafeError('INVALID_INPUT', { cause: error });
  }
  return parseVersioned(schema, input);
}

export function parseWorkflowDefinition(input: unknown): WorkflowDefinitionContract {
  return parseBoundedVersioned(WorkflowDefinitionSchema, input);
}

export function parseWorkflowReceipt(input: unknown): WorkflowReceipt {
  return parseBoundedVersioned(WorkflowReceiptSchema, input);
}
