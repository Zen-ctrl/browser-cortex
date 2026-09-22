import {
  RouteDecisionSchema,
  parseTaskRequest,
  parseVersioned,
  type RouteDecision,
  type TaskKind,
  type TaskRequest,
} from '@browser-cortex/contracts';

export interface LocalRouteCapability {
  readonly available: boolean;
  readonly supportedTasks: readonly TaskKind[];
  readonly modelId?: string;
  readonly modelRevision?: string;
}

export interface OnlineRouteCapability {
  readonly configured: boolean;
  readonly explicitlyRequested: boolean;
  readonly approvedForSources: boolean;
  readonly supportedTasks: readonly TaskKind[];
  readonly modelId?: string;
  readonly modelRevision?: string;
}

export interface RouterEnvironment {
  readonly policyVersion: string;
  readonly policyAllowed: boolean;
  readonly policyDenialReason?: 'PERMISSION_DENIED' | 'SOURCE_REVOKED' | 'SENSITIVE_DATA_BLOCKED';
  readonly supportedTasks?: readonly TaskKind[];
  readonly deterministicTasks?: readonly TaskKind[];
  readonly local: LocalRouteCapability;
  readonly online: OnlineRouteCapability;
  readonly localFailure?: boolean;
}

const DEFAULT_SUPPORTED: readonly TaskKind[] = ['search', 'extract', 'summarize', 'transform', 'plan'];
const DEFAULT_DETERMINISTIC: readonly TaskKind[] = ['search', 'transform'];

function unavailable(request: TaskRequest, environment: RouterEnvironment, reason: string): RouteDecision {
  return parseVersioned(RouteDecisionSchema, {
    schemaVersion: 1,
    requestId: request.requestId,
    route: 'unavailable',
    reasonCodes: [reason],
    policyVersion: environment.policyVersion,
    requiresDisclosure: false,
  });
}

export class DeterministicRouter {
  public decide(requestInput: TaskRequest, environment: RouterEnvironment): RouteDecision {
    const request = parseTaskRequest(requestInput);
    if (environment.policyAllowed !== true) {
      return unavailable(request, environment, environment.policyDenialReason ?? 'PERMISSION_DENIED');
    }
    const supportedTasks = environment.supportedTasks ?? DEFAULT_SUPPORTED;
    if (!supportedTasks.includes(request.task)) {
      return unavailable(request, environment, 'TASK_OUTSIDE_VALIDATED_SCOPE');
    }

    const deterministicTasks = environment.deterministicTasks ?? DEFAULT_DETERMINISTIC;
    if (deterministicTasks.includes(request.task)) {
      return parseVersioned(RouteDecisionSchema, {
        schemaVersion: 1,
        requestId: request.requestId,
        route: 'deterministic',
        reasonCodes: ['DETERMINISTIC_OPERATION'],
        policyVersion: environment.policyVersion,
        requiresDisclosure: false,
      });
    }

    if (environment.local.available && environment.local.supportedTasks.includes(request.task)) {
      return parseVersioned(RouteDecisionSchema, {
        schemaVersion: 1,
        requestId: request.requestId,
        route: 'local-model',
        reasonCodes: ['LOCAL_CAPABILITY_VERIFIED'],
        ...(environment.local.modelId === undefined ? {} : { modelId: environment.local.modelId }),
        ...(environment.local.modelRevision === undefined
          ? {}
          : { modelRevision: environment.local.modelRevision }),
        policyVersion: environment.policyVersion,
        requiresDisclosure: false,
      });
    }

    // A local runtime failure is never converted into an online request.
    if (environment.localFailure) return unavailable(request, environment, 'LOCAL_EXECUTION_FAILED');
    if (request.onlinePolicy === 'deny') return unavailable(request, environment, 'ONLINE_POLICY_DENY');
    if (!environment.online.explicitlyRequested) {
      return unavailable(request, environment, 'ONLINE_EXPLICIT_REQUEST_REQUIRED');
    }
    if (!environment.online.configured) return unavailable(request, environment, 'ONLINE_NOT_CONFIGURED');
    if (!environment.online.approvedForSources) {
      return unavailable(request, environment, 'SENSITIVE_DATA_BLOCKED');
    }
    if (!environment.online.supportedTasks.includes(request.task)) {
      return unavailable(request, environment, 'ONLINE_TASK_UNSUPPORTED');
    }
    return parseVersioned(RouteDecisionSchema, {
      schemaVersion: 1,
      requestId: request.requestId,
      route: 'online-model',
      reasonCodes: ['ONLINE_APPROVAL_NEEDED'],
      ...(environment.online.modelId === undefined ? {} : { modelId: environment.online.modelId }),
      ...(environment.online.modelRevision === undefined
        ? {}
        : { modelRevision: environment.online.modelRevision }),
      policyVersion: environment.policyVersion,
      requiresDisclosure: true,
    });
  }
}
