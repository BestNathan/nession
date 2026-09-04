import { SessionRuntime, type RuntimeMirrorSnapshot, type SessionRuntimeConfig } from '@/runtime/SessionRuntime';

/** One acquire() lease. release() is idempotent and generation-safe. */
export interface SessionRuntimeLease {
  readonly runtime: SessionRuntime;
  release(): void;
}

interface RegistryEntry {
  runtime: SessionRuntime;
  /** Live lease ids issued against THIS entry generation. */
  leases: Set<number>;
}

/** Defer dispose one macrotask so React StrictMode effect replay can re-acquire. */
const DISPOSE_DEFER_MS = 0;

export class SessionRuntimeRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly pendingDispose = new Map<string, ReturnType<typeof setTimeout>>();
  /** Registry-global monotone lease id — stale ids from a replaced entry never collide. */
  private nextLeaseId = 1;

  /** Ref-count lease only — does not mutate an existing runtime's config. */
  acquire(sessionId: string, config: SessionRuntimeConfig): SessionRuntimeLease {
    const pending = this.pendingDispose.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      this.pendingDispose.delete(sessionId);
    }

    let entry = this.entries.get(sessionId);
    if (!entry) {
      entry = { runtime: new SessionRuntime(config), leases: new Set() };
      this.entries.set(sessionId, entry);
    }

    const leaseId = this.nextLeaseId++;
    entry.leases.add(leaseId);
    const runtime = entry.runtime;
    return {
      runtime,
      release: () => this.release(sessionId, leaseId),
    };
  }

  /** Designated config owner — mutates runtime when the lease already exists. */
  update(sessionId: string, config: SessionRuntimeConfig): RuntimeMirrorSnapshot | null {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return null;
    }
    return entry.runtime.updateContext(config);
  }

  /** Stale or duplicate releases are no-ops: the lease id must be live for this entry. */
  private release(sessionId: string, leaseId: number): void {
    const entry = this.entries.get(sessionId);
    if (!entry || !entry.leases.delete(leaseId)) {
      return;
    }
    if (entry.leases.size > 0) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingDispose.delete(sessionId);
      const current = this.entries.get(sessionId);
      if (!current || current.leases.size > 0) {
        return;
      }
      current.runtime.dispose();
      this.entries.delete(sessionId);
    }, DISPOSE_DEFER_MS);
    this.pendingDispose.set(sessionId, timer);
  }

  get(sessionId: string): SessionRuntime | null {
    return this.entries.get(sessionId)?.runtime ?? null;
  }
}

export const sessionRuntimeRegistry = new SessionRuntimeRegistry();
