import { describe, expect, it, vi } from 'vitest';

import {
  BoundedRuntimeScheduler,
  LocalRecoveryController,
  validateStructuredOutput,
} from '../src/index.js';

describe('bounded local runtime scheduling', () => {
  it('runs one job at a time, prioritizes generation, and isolates cancellation', async () => {
    const scheduler = new BoundedRuntimeScheduler();
    let releaseFirst = (): void => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const first = scheduler.schedule({
      requestId: 'embedding-1',
      kind: 'embedding',
      serializedInput: '{"text":"one"}',
      run: async () => {
        order.push('embedding-1');
        await firstGate;
        return 1;
      },
    });
    const cancelledController = new AbortController();
    const cancelled = scheduler.schedule({
      requestId: 'embedding-cancelled',
      kind: 'embedding',
      serializedInput: '{}',
      signal: cancelledController.signal,
      run: async () => 2,
    });
    const generation = scheduler.schedule({
      requestId: 'generation-1',
      kind: 'generation',
      serializedInput: '{"prompt":"bounded"}',
      run: async () => {
        order.push('generation-1');
        return 3;
      },
    });
    cancelledController.abort();
    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(cancelled).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(generation).resolves.toBe(3);
    expect(order).toEqual(['embedding-1', 'generation-1']);
    scheduler.dispose();
  });
});

describe('structured output and reduced mode', () => {
  it('permits only one independently validated repair', async () => {
    const repair = vi.fn(async () => '{"count":5}');
    await expect(
      validateStructuredOutput('{"count":"five"}', {
        validate(value) {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('object required');
          const count = (value as Record<string, unknown>).count;
          if (!Number.isSafeInteger(count)) throw new Error('integer required');
          return count as number;
        },
        repair,
      }),
    ).resolves.toEqual({ value: 5, repaired: true });
    expect(repair).toHaveBeenCalledOnce();
  });

  it('keeps deterministic tools available after a local generation failure', () => {
    const recovery = new LocalRecoveryController();
    expect(recovery.failed('GPU_UNAVAILABLE')).toMatchObject({
      mode: 'reduced',
      generationAvailable: false,
      deterministicToolsAvailable: true,
      workerGeneration: 1,
    });
    expect(recovery.ready()).toMatchObject({ mode: 'full', generationAvailable: true });
  });
});
