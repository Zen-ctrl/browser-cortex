import {
  RouteDecisionSchema,
  assertJsonValue,
  createSafeError,
  parseTaskRequest,
  parseVersioned,
  sha256Fingerprint,
  toSafeError,
  type JsonValue,
  type RouteDecision,
  type TaskKind,
  type TaskRequest,
} from '@browser-cortex/contracts';

import { DeterministicRouter, type RouterEnvironment } from './router.js';

export type CortexLifecycleState = 'new' | 'initializing' | 'ready' | 'disposing' | 'disposed';

export interface TaskProposal {
  readonly schemaVersion: 1;
  readonly request: TaskRequest;
  readonly route: RouteDecision;
  readonly proposalFingerprint: string;
  readonly createdAt: number;
}

export interface TaskExecutionResult {
  readonly schemaVersion: 1;
  readonly requestId: string;
  readonly route: 'deterministic' | 'local-model';
  readonly output: JsonValue;
}

export type TaskExecutor = (request: TaskRequest, signal: AbortSignal) => Promise<JsonValue>;

export interface CortexOptions {
  readonly initialize?: (signal: AbortSignal) => Promise<void>;
  readonly routeEnvironment: (request: TaskRequest) => RouterEnvironment | Promise<RouterEnvironment>;
  readonly deterministicExecutors?: Partial<Record<TaskKind, TaskExecutor>>;
  readonly localModelExecutor?: TaskExecutor;
  readonly router?: DeterministicRouter;
  readonly now?: () => number;
}

export interface Cortex {
  readonly state: CortexLifecycleState;
  initialize(): Promise<void>;
  propose(input: unknown, signal?: AbortSignal): Promise<TaskProposal>;
  execute(proposal: TaskProposal, signal?: AbortSignal): Promise<TaskExecutionResult>;
  cancel(requestId: string): boolean;
  dispose(): Promise<void>;
}

function linkSignals(external: AbortSignal | undefined): {
  readonly controller: AbortController;
  readonly cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort(external?.reason);
  if (external?.aborted) abort();
  else external?.addEventListener('abort', abort, { once: true });
  return { controller, cleanup: () => external?.removeEventListener('abort', abort) };
}

class CortexImpl implements Cortex {
  #state: CortexLifecycleState = 'new';
  readonly #router: DeterministicRouter;
  readonly #options: CortexOptions;
  readonly #proposals = new Map<string, TaskProposal>();
  readonly #active = new Map<string, AbortController>();
  readonly #executed = new Set<string>();
  #initializationController: AbortController | undefined;
  #initialization: Promise<void> | undefined;

  public constructor(options: CortexOptions) {
    this.#options = options;
    this.#router = options.router ?? new DeterministicRouter();
  }

  public get state(): CortexLifecycleState {
    return this.#state;
  }

  public initialize(): Promise<void> {
    if (this.#state === 'disposed' || this.#state === 'disposing') {
      return Promise.reject(createSafeError('DISPOSED'));
    }
    if (this.#state === 'ready') return Promise.reject(createSafeError('ALREADY_INITIALIZED'));
    if (this.#initialization) return this.#initialization;
    this.#state = 'initializing';
    const controller = new AbortController();
    this.#initializationController = controller;
    const pending = (async () => {
      try {
        // The optional injected hook may open local adapters. Core itself never installs a model or opens a transport.
        await this.#options.initialize?.(controller.signal);
        if (controller.signal.aborted || this.#state === 'disposing' || this.#state === 'disposed') throw createSafeError('DISPOSED');
        this.#state = 'ready';
      } catch (error) {
        if (controller.signal.aborted || this.#state === 'disposing' || this.#state === 'disposed') throw createSafeError('DISPOSED', { cause: error });
        this.#state = 'new';
        throw toSafeError(error, 'NOT_INITIALIZED');
      } finally {
        if (this.#initializationController === controller) this.#initializationController = undefined;
      }
    })();
    this.#initialization = pending;
    const clearPending = (): void => {
      if (this.#initialization === pending) this.#initialization = undefined;
    };
    void pending.then(clearPending, clearPending);
    return pending;
  }

  public async propose(input: unknown, signal?: AbortSignal): Promise<TaskProposal> {
    this.#assertReady();
    const request = parseTaskRequest(input);
    if (
      this.#proposals.has(request.requestId) ||
      this.#active.has(request.requestId) ||
      this.#executed.has(request.requestId)
    ) {
      throw createSafeError('DUPLICATE_REQUEST');
    }
    const linked = linkSignals(signal);
    this.#active.set(request.requestId, linked.controller);
    try {
      if (linked.controller.signal.aborted) throw createSafeError('CANCELLED');
      const environment = await this.#options.routeEnvironment(request);
      if (linked.controller.signal.aborted) throw createSafeError('CANCELLED');
      const route = this.#router.decide(request, environment);
      const proposalFingerprint = await sha256Fingerprint({ request, route });
      const createdAt = (this.#options.now ?? Date.now)();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw createSafeError('INVALID_INPUT');
      const proposal: TaskProposal = Object.freeze({
        schemaVersion: 1,
        request: Object.freeze(request),
        route: Object.freeze(route),
        proposalFingerprint,
        createdAt,
      });
      this.#proposals.set(request.requestId, proposal);
      return proposal;
    } catch (error) {
      throw toSafeError(error, 'PERMISSION_DENIED');
    } finally {
      linked.cleanup();
      this.#active.delete(request.requestId);
    }
  }

  public async execute(proposalInput: TaskProposal, signal?: AbortSignal): Promise<TaskExecutionResult> {
    this.#assertReady();
    const request = parseTaskRequest(proposalInput.request);
    const route = parseVersioned(RouteDecisionSchema, proposalInput.route);
    const stored = this.#proposals.get(request.requestId);
    if (stored === undefined || this.#executed.has(request.requestId)) {
      throw createSafeError('APPROVAL_INVALID');
    }
    // Reserve synchronously before any await so concurrent calls cannot both execute.
    this.#executed.add(request.requestId);
    this.#proposals.delete(request.requestId);
    const linked = linkSignals(signal);
    this.#active.set(request.requestId, linked.controller);
    try {
      if (linked.controller.signal.aborted) throw createSafeError('CANCELLED');
      const actualFingerprint = await sha256Fingerprint({ request, route });
      if (
        actualFingerprint !== stored.proposalFingerprint ||
        proposalInput.proposalFingerprint !== stored.proposalFingerprint
      ) {
        throw createSafeError('APPROVAL_INVALID');
      }

      const currentEnvironment = await this.#options.routeEnvironment(request);
      if (linked.controller.signal.aborted) throw createSafeError('CANCELLED');
      const currentRoute = this.#router.decide(request, currentEnvironment);
      const [approvedRouteFingerprint, currentRouteFingerprint] = await Promise.all([
        sha256Fingerprint(route),
        sha256Fingerprint(currentRoute),
      ]);
      if (approvedRouteFingerprint !== currentRouteFingerprint) {
        throw createSafeError(
          currentRoute.reasonCodes.includes('SOURCE_REVOKED') ? 'SOURCE_REVOKED' : 'PERMISSION_DENIED',
        );
      }
      if (route.route === 'online-model') throw createSafeError('DISCLOSURE_REQUIRED');
      if (route.route === 'unavailable') throw createSafeError('UNSUPPORTED_TASK');

      const executor =
        route.route === 'deterministic'
          ? this.#options.deterministicExecutors?.[request.task]
          : this.#options.localModelExecutor;
      if (executor === undefined) throw createSafeError('UNSUPPORTED_TASK');

      const output = await executor(request, linked.controller.signal);
      if (linked.controller.signal.aborted) throw createSafeError('CANCELLED');
      try {
        assertJsonValue(output);
      } catch (error) {
        throw createSafeError('INVALID_MODEL_OUTPUT', { cause: error });
      }
      return {
        schemaVersion: 1,
        requestId: request.requestId,
        route: route.route,
        output,
      };
    } catch (error) {
      throw toSafeError(error, route.route === 'local-model' ? 'INVALID_MODEL_OUTPUT' : 'INVALID_INPUT');
    } finally {
      linked.cleanup();
      this.#active.delete(request.requestId);
    }
  }

  public cancel(requestId: string): boolean {
    const controller = this.#active.get(requestId);
    if (controller === undefined) return false;
    controller.abort('cancelled');
    return true;
  }

  public async dispose(): Promise<void> {
    if (this.#state === 'disposed') return;
    this.#state = 'disposing';
    this.#initializationController?.abort('disposed');
    for (const controller of this.#active.values()) controller.abort('disposed');
    this.#active.clear();
    this.#proposals.clear();
    this.#executed.clear();
    this.#state = 'disposed';
  }

  #assertReady(): void {
    if (this.#state === 'disposed' || this.#state === 'disposing') throw createSafeError('DISPOSED');
    if (this.#state !== 'ready') throw createSafeError('NOT_INITIALIZED');
  }
}

export function createCortex(options: CortexOptions): Cortex {
  return new CortexImpl(options);
}
