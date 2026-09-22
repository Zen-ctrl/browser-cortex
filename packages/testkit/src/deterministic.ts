export class DeterministicClock {
  #current: number;

  constructor(start = "2026-01-01T00:00:00.000Z") {
    this.#current = Date.parse(start);
    if (!Number.isFinite(this.#current)) throw new Error("Deterministic clock start is invalid.");
  }

  now = (): Date => new Date(this.#current);

  advance(milliseconds: number): Date {
    if (!Number.isSafeInteger(milliseconds)) throw new Error("Clock advance must be an integer.");
    this.#current += milliseconds;
    return this.now();
  }
}

export class DeterministicIds {
  #counter = 0;

  constructor(readonly prefix = "fixture") {}

  next(): string {
    this.#counter += 1;
    return `${this.prefix}-${String(this.#counter).padStart(6, "0")}`;
  }
}

export class ControlledFailure {
  readonly #failures = new Map<string, number>();

  failNext(point: string, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Failure count is invalid.");
    this.#failures.set(point, (this.#failures.get(point) ?? 0) + count);
  }

  reach(point: string): void {
    const remaining = this.#failures.get(point) ?? 0;
    if (remaining < 1) return;
    if (remaining === 1) this.#failures.delete(point);
    else this.#failures.set(point, remaining - 1);
    throw new Error(`Controlled synthetic failure at ${point}.`);
  }
}
