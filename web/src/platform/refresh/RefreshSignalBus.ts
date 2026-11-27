/**
 * App-level lifecycle signals, decoupled from the surfaces that react to them
 * (#4602 §1).
 *
 * The bus carries only facts the app composition already establishes: the
 * authenticated transport came back, or the page returned to the foreground
 * after its liveness probe succeeded. It carries no business scope — each
 * controller decides for itself whether it is the active, enabled reader of a
 * scope worth re-reading.
 *
 * `activate` is deliberately absent: activation is a local `active` transition
 * on the controller, so showing one Workspace view never provokes a read burst
 * across every other cached surface.
 */
export type RefreshSignal = 'foreground' | 'reconnect';

export interface RefreshSignalEvent {
  signal: RefreshSignal;
  /** Transport generation the signal was observed on, when known. A controller
   *  uses it to ignore a signal from a socket it has already left. */
  generation?: number;
}

type Listener = (event: RefreshSignalEvent) => void;

export class RefreshSignalBus {
  private readonly listeners = new Set<Listener>();
  private lastEmit: { signal: RefreshSignal; at: number } | null = null;

  constructor(private readonly now: () => number = () => Date.now()) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Publish a lifecycle signal.
   *
   * A foreground recovery that already reconnected the transport must not also
   * queue a second read for the same resume: `reconnect` wins inside the
   * dedupe window, which is the "dedupe with reconnect" rule in #4602 §2.
   */
  emit(event: RefreshSignalEvent, dedupeWindowMs = 1_000): void {
    const at = this.now();
    if (event.signal === 'foreground' && this.lastEmit
      && this.lastEmit.signal === 'reconnect'
      && at - this.lastEmit.at < dedupeWindowMs) {
      return;
    }
    this.lastEmit = { signal: event.signal, at };
    for (const listener of [...this.listeners]) { listener(event); }
  }

  clear(): void {
    this.listeners.clear();
    this.lastEmit = null;
  }
}