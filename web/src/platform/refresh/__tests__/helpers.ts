import type { RefreshClock } from '../types';

interface Timer {
  at: number;
  fn: () => void;
}

/**
 * Deterministic clock for lifecycle proofs. Time only moves when a test moves
 * it, and timers fire in due order (including ones armed while firing), so an
 * assertion about "how many reads happened" never depends on wall-clock luck.
 */
export class FakeClock implements RefreshClock {
  private time = 0;
  private seq = 0;
  private readonly timers = new Map<number, Timer>();

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): number {
    this.seq += 1;
    this.timers.set(this.seq, { at: this.time + Math.max(0, ms), fn });
    return this.seq;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | null = null;
      let next: Timer | null = null;
      for (const [id, timer] of this.timers) {
        if (timer.at > target) { continue; }
        if (next === null || timer.at < next.at || (timer.at === next.at && id < (nextId as number))) {
          nextId = id;
          next = timer;
        }
      }
      if (nextId === null || next === null) { break; }
      this.timers.delete(nextId);
      this.time = next.at;
      next.fn();
    }
    this.time = target;
  }
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let queued microtasks (promise callbacks) run. Real macrotask, because the
 *  clock under test is injected rather than installed globally. */
export async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
}

/** A jitter-free random source, so cadence/backoff assertions are exact. */
export const noJitter = (): number => 0.5;