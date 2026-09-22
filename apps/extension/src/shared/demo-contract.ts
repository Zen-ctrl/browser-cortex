import { sha256Fingerprint } from '@browser-cortex/contracts';
import {
  WORKFLOW_SCHEMA_VERSION,
  validateWorkflow,
  type WorkflowDefinition,
} from '@browser-cortex/workflows';

export const DEMO_INTEGRATION_ID = 'northline-demo-v1';
export const DEMO_INTEGRATION_VERSION = '1.0.0';
export const DEMO_RECORD_ID = 'PO-DEMO-1001';
export const DEMO_TOOL_READ = 'demo.records.read';
export const DEMO_TOOL_WRITE = 'demo.ticket.status.set';
export const DEMO_GRANT_LIFETIME_MS = 30 * 60 * 1_000;
export const DEMO_APPROVAL_LIFETIME_MS = 5 * 60 * 1_000;
export const DEMO_RECORDING_RETENTION_MS = 15 * 60 * 1_000;
export const DEMO_STATUSES = ['Needs review', 'Approved', 'On hold'] as const;

export type DemoStatus = (typeof DEMO_STATUSES)[number];

export interface DemoRecord {
  readonly reference: string;
  readonly supplier: string;
  readonly quantity: number;
  readonly unitPriceMinor: number;
  readonly currency: string;
  readonly requestedDelivery: string;
  readonly invoice?: string;
}

export interface DemoToolDeclaration {
  readonly name: string;
  readonly version: string;
  readonly effect: 'read' | 'local-write';
  readonly implementationId: string;
}

export interface DemoSnapshot {
  readonly integrationId: typeof DEMO_INTEGRATION_ID;
  readonly integrationVersion: typeof DEMO_INTEGRATION_VERSION;
  readonly pageIdentity: string;
  readonly recordId: typeof DEMO_RECORD_ID;
  readonly currentStatus: DemoStatus;
  readonly availableStatuses: readonly DemoStatus[];
  readonly purchaseOrder: DemoRecord;
  readonly invoice: DemoRecord;
  readonly declarations: readonly DemoToolDeclaration[];
}

export interface DemoComparison {
  readonly recordId: typeof DEMO_RECORD_ID;
  readonly quantityDifference: number;
  readonly monetaryDifferenceMinor: number;
  readonly currency: string;
  readonly currencyMismatch: boolean;
  readonly supplierMatch: boolean;
  readonly deliveryMatch: boolean;
  readonly evidence: readonly string[];
}

export interface RecordedDemoEvent {
  readonly operation: typeof DEMO_TOOL_WRITE;
  readonly recordId: typeof DEMO_RECORD_ID;
  readonly field: 'status';
  readonly from: DemoStatus;
  readonly to: DemoStatus;
  readonly integrationVersion: typeof DEMO_INTEGRATION_VERSION;
  readonly receivedAt: number;
}

export interface CompletedDemoRecording {
  readonly id: string;
  readonly origin: string;
  readonly sourceDocumentId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly events: readonly RecordedDemoEvent[];
}

export interface RecordingVariable {
  readonly name: string;
  readonly type: 'string';
  readonly defaultValue: DemoStatus;
  readonly allowedValues: readonly DemoStatus[];
}

export interface CompiledDemoWorkflow {
  readonly schemaVersion: 1;
  readonly kind: 'browser-cortex-demo-recording';
  readonly recordingId: string;
  readonly integrationId: typeof DEMO_INTEGRATION_ID;
  readonly integrationVersion: typeof DEMO_INTEGRATION_VERSION;
  readonly sourceDocumentId: string;
  readonly createdAt: number;
  readonly eventCount: number;
  readonly variables: readonly [RecordingVariable];
  readonly assumptions: readonly string[];
  readonly replay: {
    readonly origin: string;
    readonly recordId: typeof DEMO_RECORD_ID;
    readonly expectedCurrentStatus: DemoStatus;
    readonly variableName: string;
  };
  readonly workflow: WorkflowDefinition;
  readonly planFingerprint: string;
}

const EXPECTED_DECLARATIONS: readonly DemoToolDeclaration[] = Object.freeze([
  Object.freeze({
    name: DEMO_TOOL_READ,
    version: DEMO_INTEGRATION_VERSION,
    effect: 'read',
    implementationId: 'northline-demo-record-reader',
  }),
  Object.freeze({
    name: DEMO_TOOL_WRITE,
    version: DEMO_INTEGRATION_VERSION,
    effect: 'local-write',
    implementationId: 'northline-demo-ticket-status',
  }),
]);

const ASSUMPTIONS = Object.freeze([
  'The active page has the exact reviewed demo origin and integration version.',
  'Exactly one visible status target matches the selected value.',
  'The synthetic record identity and current status still match this plan.',
  'A fresh extension-owned grant and one-use action approval are required.',
  'Any origin, version, target, or current-state drift stops replay.',
]);

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} has an unsupported prototype.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  if (Object.keys(value).length !== expected.size || Object.keys(value).some((key) => !expected.has(key))) {
    throw new Error(`${label} contains unsupported fields.`);
  }
}

function boundedString(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} is invalid.`);
  }
  return value as number;
}

export function isDemoStatus(value: unknown): value is DemoStatus {
  return typeof value === 'string' && (DEMO_STATUSES as readonly string[]).includes(value);
}

export function canonicalDemoOrigin(input: string): string {
  const value = new URL(input);
  if (
    value.protocol !== 'http:'
    || (value.hostname !== 'localhost' && value.hostname !== '127.0.0.1')
    || value.port !== '4174'
    || value.username
    || value.password
  ) {
    throw new Error('The active page is outside the reviewed demo origin.');
  }
  return value.origin;
}

export function canonicalDemoPageIdentity(input: string): string {
  const value = new URL(input);
  const origin = canonicalDemoOrigin(value.origin);
  if (value.search || value.hash || (value.pathname !== '/' && value.pathname !== '/index.html')) {
    throw new Error('The active page is outside the reviewed demo document path.');
  }
  return `${origin}${value.pathname}`;
}

function parseRecord(value: unknown, label: string, invoiceRequired: boolean): DemoRecord {
  const record = plainObject(value, label);
  const expected = invoiceRequired
    ? ['reference', 'invoice', 'supplier', 'quantity', 'unitPriceMinor', 'currency', 'requestedDelivery']
    : ['reference', 'supplier', 'quantity', 'unitPriceMinor', 'currency', 'requestedDelivery'];
  exactKeys(record, expected, label);
  const parsed: DemoRecord = {
    reference: boundedString(record.reference, `${label} reference`, 128),
    supplier: boundedString(record.supplier, `${label} supplier`, 256),
    quantity: safeInteger(record.quantity, `${label} quantity`, 1),
    unitPriceMinor: safeInteger(record.unitPriceMinor, `${label} unit price`, 0),
    currency: boundedString(record.currency, `${label} currency`, 3),
    requestedDelivery: boundedString(record.requestedDelivery, `${label} requested delivery`, 10),
    ...(invoiceRequired ? { invoice: boundedString(record.invoice, `${label} invoice`, 128) } : {}),
  };
  if (parsed.reference !== DEMO_RECORD_ID || !/^[A-Z]{3}$/u.test(parsed.currency) || !/^\d{4}-\d{2}-\d{2}$/u.test(parsed.requestedDelivery)) {
    throw new Error(`${label} is outside the reviewed synthetic record contract.`);
  }
  return Object.freeze(parsed);
}

function parseDeclaration(value: unknown): DemoToolDeclaration {
  const declaration = plainObject(value, 'Tool declaration');
  exactKeys(declaration, ['name', 'version', 'effect', 'implementationId'], 'Tool declaration');
  const effect = declaration.effect;
  if (effect !== 'read' && effect !== 'local-write') throw new Error('Tool declaration effect is invalid.');
  return Object.freeze({
    name: boundedString(declaration.name, 'Tool name', 128),
    version: boundedString(declaration.version, 'Tool version', 64),
    effect,
    implementationId: boundedString(declaration.implementationId, 'Implementation ID', 128),
  });
}

function declarationsMatchExpected(declarations: readonly DemoToolDeclaration[]): boolean {
  if (declarations.length !== EXPECTED_DECLARATIONS.length) return false;
  return EXPECTED_DECLARATIONS.every((expected) => declarations.some((candidate) => (
    candidate.name === expected.name
    && candidate.version === expected.version
    && candidate.effect === expected.effect
    && candidate.implementationId === expected.implementationId
  )));
}

export function parseDemoSnapshot(value: unknown): DemoSnapshot {
  const snapshot = plainObject(value, 'Demo snapshot');
  exactKeys(snapshot, [
    'integrationId',
    'integrationVersion',
    'pageIdentity',
    'recordId',
    'currentStatus',
    'availableStatuses',
    'purchaseOrder',
    'invoice',
    'declarations',
  ], 'Demo snapshot');
  if (
    snapshot.integrationId !== DEMO_INTEGRATION_ID
    || snapshot.integrationVersion !== DEMO_INTEGRATION_VERSION
    || snapshot.recordId !== DEMO_RECORD_ID
    || !isDemoStatus(snapshot.currentStatus)
  ) {
    throw new Error('The page does not match the packaged demo integration contract.');
  }
  const pageIdentity = canonicalDemoPageIdentity(boundedString(snapshot.pageIdentity, 'Page identity', 2_048));
  const availableStatuses = snapshot.availableStatuses;
  if (
    !Array.isArray(availableStatuses)
    || availableStatuses.length !== DEMO_STATUSES.length
    || !availableStatuses.every(isDemoStatus)
    || new Set(availableStatuses).size !== DEMO_STATUSES.length
    || !DEMO_STATUSES.every((status) => availableStatuses.includes(status))
  ) {
    throw new Error('The demo status targets are missing, duplicated, or unsupported.');
  }
  if (!Array.isArray(snapshot.declarations) || snapshot.declarations.length > 8) {
    throw new Error('The page tool declarations are invalid.');
  }
  const declarations = snapshot.declarations.map(parseDeclaration);
  if (!declarationsMatchExpected(declarations)) {
    throw new Error('Page tool declarations do not match the packaged implementations.');
  }
  return Object.freeze({
    integrationId: DEMO_INTEGRATION_ID,
    integrationVersion: DEMO_INTEGRATION_VERSION,
    pageIdentity,
    recordId: DEMO_RECORD_ID,
    currentStatus: snapshot.currentStatus,
    availableStatuses: Object.freeze([...availableStatuses]) as readonly DemoStatus[],
    purchaseOrder: parseRecord(snapshot.purchaseOrder, 'Purchase order', false),
    invoice: parseRecord(snapshot.invoice, 'Invoice', true),
    declarations: Object.freeze(declarations),
  });
}

export function compareDemoRecords(snapshot: DemoSnapshot): DemoComparison {
  const quantityDifference = snapshot.invoice.quantity - snapshot.purchaseOrder.quantity;
  const currencyMismatch = snapshot.invoice.currency !== snapshot.purchaseOrder.currency;
  return Object.freeze({
    recordId: DEMO_RECORD_ID,
    quantityDifference,
    monetaryDifferenceMinor: quantityDifference * snapshot.purchaseOrder.unitPriceMinor,
    currency: snapshot.purchaseOrder.currency,
    currencyMismatch,
    supplierMatch: snapshot.invoice.supplier === snapshot.purchaseOrder.supplier,
    deliveryMatch: snapshot.invoice.requestedDelivery === snapshot.purchaseOrder.requestedDelivery,
    evidence: Object.freeze([
      `Purchase order quantity: ${snapshot.purchaseOrder.quantity}`,
      `Invoice quantity: ${snapshot.invoice.quantity}`,
      `Unit price in minor units: ${snapshot.purchaseOrder.unitPriceMinor}`,
      `Computed quantity difference: ${quantityDifference}`,
    ]),
  });
}

export function parseRecordedDemoEvent(value: unknown): RecordedDemoEvent {
  const event = plainObject(value, 'Recorded event');
  exactKeys(event, ['operation', 'recordId', 'field', 'from', 'to', 'integrationVersion', 'receivedAt'], 'Recorded event');
  if (
    event.operation !== DEMO_TOOL_WRITE
    || event.recordId !== DEMO_RECORD_ID
    || event.field !== 'status'
    || event.integrationVersion !== DEMO_INTEGRATION_VERSION
    || !isDemoStatus(event.from)
    || !isDemoStatus(event.to)
    || event.from === event.to
  ) {
    throw new Error('The recorded event is outside the reviewed demo contract.');
  }
  return Object.freeze({
    operation: DEMO_TOOL_WRITE,
    recordId: DEMO_RECORD_ID,
    field: 'status',
    from: event.from,
    to: event.to,
    integrationVersion: DEMO_INTEGRATION_VERSION,
    receivedAt: safeInteger(event.receivedAt, 'Recorded event timestamp'),
  });
}

function variableName(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(value)) {
    throw new Error('The workflow variable name is invalid.');
  }
  return value;
}

export async function compileDemoRecording(
  recording: CompletedDemoRecording,
  requestedVariableName = 'targetStatus',
): Promise<CompiledDemoWorkflow> {
  const name = variableName(requestedVariableName);
  if (recording.events.length < 1 || recording.events.length > 200) {
    throw new Error('A recording must contain between 1 and 200 reviewed events.');
  }
  const events = recording.events.map(parseRecordedDemoEvent);
  for (let index = 1; index < events.length; index += 1) {
    if (events[index - 1]?.to !== events[index]?.from) {
      throw new Error('Recorded status events do not form one deterministic state chain.');
    }
  }
  const first = events[0] as RecordedDemoEvent;
  const last = events[events.length - 1] as RecordedDemoEvent;
  if (first.from === last.to) {
    throw new Error('The normalized recording has no final state change.');
  }
  const origin = canonicalDemoOrigin(recording.origin);
  const workflowInput: WorkflowDefinition = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: `demo-recording-${recording.id}`.slice(0, 128),
    version: '1.0.0',
    name: 'Replay reviewed synthetic ticket status',
    description: `Normalized from ${events.length} vetted semantic event${events.length === 1 ? '' : 's'}.`,
    inputSchema: { [name]: 'string' },
    outputSchema: { result: 'object' },
    originScope: [origin],
    requiredCapabilities: ['active-demo:write'],
    sourceDependencies: [],
    toolDependencies: [{ name: DEMO_TOOL_WRITE, version: DEMO_INTEGRATION_VERSION }],
    limits: { maxRows: 1, maxSteps: 3, maxDurationMs: 10_000 },
    steps: [
      {
        id: 'preview',
        op: 'preview.show',
        input: {
          integrationId: DEMO_INTEGRATION_ID,
          recordId: DEMO_RECORD_ID,
          field: 'status',
          expectedCurrentStatus: first.from,
          selectedStatus: { variable: name },
        },
      },
      {
        id: 'approve',
        op: 'approval.require',
        input: { ref: 'steps.preview' },
        scope: 'demo-ticket-status-write',
      },
      {
        id: 'write',
        op: 'tool.invoke',
        approvalRef: 'steps.approve',
        tool: { name: DEMO_TOOL_WRITE, version: DEMO_INTEGRATION_VERSION },
        arguments: {
          integrationId: DEMO_INTEGRATION_ID,
          integrationVersion: DEMO_INTEGRATION_VERSION,
          recordId: DEMO_RECORD_ID,
          field: 'status',
          from: first.from,
          to: { ref: `input.${name}` },
        },
        output: 'result',
        timeoutMs: 5_000,
        failurePolicy: 'stop',
      },
    ],
  };
  const validated = validateWorkflow(workflowInput);
  const planFingerprint = await sha256Fingerprint(validated.workflow);
  return Object.freeze({
    schemaVersion: 1,
    kind: 'browser-cortex-demo-recording',
    recordingId: recording.id,
    integrationId: DEMO_INTEGRATION_ID,
    integrationVersion: DEMO_INTEGRATION_VERSION,
    sourceDocumentId: recording.sourceDocumentId,
    createdAt: Date.now(),
    eventCount: events.length,
    variables: Object.freeze([Object.freeze({
      name,
      type: 'string',
      defaultValue: last.to,
      allowedValues: Object.freeze([...DEMO_STATUSES]),
    })]) as readonly [RecordingVariable],
    assumptions: ASSUMPTIONS,
    replay: Object.freeze({
      origin,
      recordId: DEMO_RECORD_ID,
      expectedCurrentStatus: first.from,
      variableName: name,
    }),
    workflow: validated.workflow,
    planFingerprint,
  });
}

export async function parseCompiledDemoWorkflow(value: unknown): Promise<CompiledDemoWorkflow> {
  const wrapper = plainObject(value, 'Compiled workflow');
  exactKeys(wrapper, [
    'schemaVersion',
    'kind',
    'recordingId',
    'integrationId',
    'integrationVersion',
    'sourceDocumentId',
    'createdAt',
    'eventCount',
    'variables',
    'assumptions',
    'replay',
    'workflow',
    'planFingerprint',
  ], 'Compiled workflow');
  if (
    wrapper.schemaVersion !== 1
    || wrapper.kind !== 'browser-cortex-demo-recording'
    || wrapper.integrationId !== DEMO_INTEGRATION_ID
    || wrapper.integrationVersion !== DEMO_INTEGRATION_VERSION
  ) {
    throw new Error('The saved workflow uses an unsupported integration contract.');
  }
  const recordingId = boundedString(wrapper.recordingId, 'Recording ID', 128);
  const sourceDocumentId = boundedString(wrapper.sourceDocumentId, 'Source document ID', 256);
  const createdAt = safeInteger(wrapper.createdAt, 'Workflow creation timestamp');
  const eventCount = safeInteger(wrapper.eventCount, 'Workflow event count', 1);
  if (eventCount > 200) throw new Error('Workflow event count exceeds the recording limit.');
  if (!Array.isArray(wrapper.variables) || wrapper.variables.length !== 1) throw new Error('The saved workflow variable set is invalid.');
  const variable = plainObject(wrapper.variables[0], 'Workflow variable');
  exactKeys(variable, ['name', 'type', 'defaultValue', 'allowedValues'], 'Workflow variable');
  const name = variableName(variable.name);
  const allowedValues = variable.allowedValues;
  if (
    variable.type !== 'string'
    || !isDemoStatus(variable.defaultValue)
    || !Array.isArray(allowedValues)
    || allowedValues.length !== DEMO_STATUSES.length
    || !DEMO_STATUSES.every((status) => allowedValues.includes(status))
  ) {
    throw new Error('The saved workflow variable scope is invalid.');
  }
  const assumptions = wrapper.assumptions;
  if (
    !Array.isArray(assumptions)
    || assumptions.length !== ASSUMPTIONS.length
    || !ASSUMPTIONS.every((assumption, index) => assumptions[index] === assumption)
  ) {
    throw new Error('The saved workflow assumptions are invalid.');
  }
  const replay = plainObject(wrapper.replay, 'Replay binding');
  exactKeys(replay, ['origin', 'recordId', 'expectedCurrentStatus', 'variableName'], 'Replay binding');
  const origin = canonicalDemoOrigin(boundedString(replay.origin, 'Replay origin', 2_048));
  if (replay.recordId !== DEMO_RECORD_ID || !isDemoStatus(replay.expectedCurrentStatus) || replay.variableName !== name) {
    throw new Error('The replay binding is outside the packaged integration scope.');
  }
  const validated = validateWorkflow(wrapper.workflow);
  const workflow = validated.workflow;
  const steps = workflow.steps;
  const preview = steps[0];
  const approval = steps[1];
  const write = steps[2];
  const argumentsValue = write?.arguments;
  const expectedReference = { ref: `input.${name}` };
  const requiredCapabilities = new Set([
    'active-demo:write',
    `tool:${DEMO_TOOL_WRITE}@${DEMO_INTEGRATION_VERSION}`,
  ]);
  const strictTemplate = (() => {
    try {
      const previewRecord = plainObject(preview, 'Replay preview step');
      const approvalRecord = plainObject(approval, 'Replay approval step');
      const writeRecord = plainObject(write, 'Replay write step');
      const previewInput = plainObject(preview?.input, 'Replay preview input');
      const selectedStatus = plainObject(previewInput.selectedStatus, 'Replay preview variable');
      const argumentRecord = plainObject(argumentsValue, 'Replay write arguments');
      exactKeys(previewRecord, ['id', 'op', 'input'], 'Replay preview step');
      exactKeys(approvalRecord, ['id', 'op', 'input', 'scope'], 'Replay approval step');
      exactKeys(writeRecord, ['id', 'op', 'approvalRef', 'tool', 'arguments', 'output', 'timeoutMs', 'failurePolicy'], 'Replay write step');
      exactKeys(previewInput, ['integrationId', 'recordId', 'field', 'expectedCurrentStatus', 'selectedStatus'], 'Replay preview input');
      exactKeys(selectedStatus, ['variable'], 'Replay preview variable');
      exactKeys(argumentRecord, ['integrationId', 'integrationVersion', 'recordId', 'field', 'from', 'to'], 'Replay write arguments');
      return previewRecord.id === 'preview'
        && previewRecord.op === 'preview.show'
        && approvalRecord.id === 'approve'
        && approvalRecord.op === 'approval.require'
        && JSON.stringify(approvalRecord.input) === JSON.stringify({ ref: 'steps.preview' })
        && approvalRecord.scope === 'demo-ticket-status-write'
        && writeRecord.id === 'write'
        && writeRecord.op === 'tool.invoke'
        && writeRecord.approvalRef === 'steps.approve'
        && writeRecord.output === 'result'
        && writeRecord.timeoutMs === 5_000
        && writeRecord.failurePolicy === 'stop'
        && previewInput.integrationId === DEMO_INTEGRATION_ID
        && previewInput.recordId === DEMO_RECORD_ID
        && previewInput.field === 'status'
        && previewInput.expectedCurrentStatus === replay.expectedCurrentStatus
        && selectedStatus.variable === name;
    } catch {
      return false;
    }
  })();
  if (
    !strictTemplate
    || workflow.id !== `demo-recording-${recordingId}`.slice(0, 128)
    || workflow.version !== '1.0.0'
    || workflow.name !== 'Replay reviewed synthetic ticket status'
    || workflow.description !== `Normalized from ${eventCount} vetted semantic event${eventCount === 1 ? '' : 's'}.`
    || workflow.originScope?.length !== 1
    || workflow.originScope[0] !== origin
    || workflow.toolDependencies.length !== 1
    || workflow.toolDependencies[0]?.name !== DEMO_TOOL_WRITE
    || workflow.toolDependencies[0]?.version !== DEMO_INTEGRATION_VERSION
    || Object.keys(workflow.inputSchema).length !== 1
    || workflow.inputSchema[name] !== 'string'
    || Object.keys(workflow.outputSchema ?? {}).length !== 1
    || workflow.outputSchema?.result !== 'object'
    || workflow.sourceDependencies.length !== 0
    || workflow.limits.maxRows !== 1
    || workflow.limits.maxSteps !== 3
    || workflow.limits.maxDurationMs !== 10_000
    || workflow.requiredCapabilities.length !== requiredCapabilities.size
    || !workflow.requiredCapabilities.every((capability) => requiredCapabilities.has(capability))
    || steps.length !== 3
    || steps[0]?.op !== 'preview.show'
    || steps[1]?.op !== 'approval.require'
    || write?.op !== 'tool.invoke'
    || write.tool?.name !== DEMO_TOOL_WRITE
    || write.tool.version !== DEMO_INTEGRATION_VERSION
    || write.approvalRef !== 'steps.approve'
    || argumentsValue?.integrationId !== DEMO_INTEGRATION_ID
    || argumentsValue.integrationVersion !== DEMO_INTEGRATION_VERSION
    || argumentsValue.recordId !== DEMO_RECORD_ID
    || argumentsValue.field !== 'status'
    || argumentsValue.from !== replay.expectedCurrentStatus
    || JSON.stringify(argumentsValue.to) !== JSON.stringify(expectedReference)
  ) {
    throw new Error('The saved workflow does not match the finite demo replay template.');
  }
  const planFingerprint = boundedString(wrapper.planFingerprint, 'Plan fingerprint', 80);
  if (planFingerprint !== await sha256Fingerprint(workflow)) {
    throw new Error('The saved workflow plan fingerprint does not match its reviewed content.');
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'browser-cortex-demo-recording',
    recordingId,
    integrationId: DEMO_INTEGRATION_ID,
    integrationVersion: DEMO_INTEGRATION_VERSION,
    sourceDocumentId,
    createdAt,
    eventCount,
    variables: Object.freeze([Object.freeze({
      name,
      type: 'string',
      defaultValue: variable.defaultValue,
      allowedValues: Object.freeze([...DEMO_STATUSES]),
    })]) as readonly [RecordingVariable],
    assumptions: Object.freeze([...ASSUMPTIONS]),
    replay: Object.freeze({
      origin,
      recordId: DEMO_RECORD_ID,
      expectedCurrentStatus: replay.expectedCurrentStatus,
      variableName: name,
    }),
    workflow,
    planFingerprint,
  });
}

export function demoGrantParameterScope(): Record<string, unknown> {
  return {
    integrationId: DEMO_INTEGRATION_ID,
    integrationVersion: DEMO_INTEGRATION_VERSION,
    recordId: DEMO_RECORD_ID,
    field: 'status',
    allowedStatuses: [...DEMO_STATUSES],
  };
}

export function expectedDemoDeclarations(): readonly DemoToolDeclaration[] {
  return EXPECTED_DECLARATIONS;
}
