export interface SimulatedRuntimeResponse {
  fixtureId: string;
  output: string;
  simulated: true;
}

/** Contract-test runtime. It is intentionally labeled simulated and is not inference evidence. */
export class SimulatedContractRuntime {
  readonly #responses: ReadonlyMap<string, string>;

  constructor(responses: Record<string, string>) {
    this.#responses = new Map(Object.entries(responses));
  }

  async run(fixtureId: string, signal?: AbortSignal): Promise<SimulatedRuntimeResponse> {
    if (signal?.aborted) throw signal.reason ?? new DOMException("Simulated request cancelled.", "AbortError");
    const output = this.#responses.get(fixtureId);
    if (output === undefined) throw new Error(`No simulated response exists for fixture ${fixtureId}.`);
    return { fixtureId, output, simulated: true };
  }
}
