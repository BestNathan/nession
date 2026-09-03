import { SessionRuntime, type RuntimeMirrorSnapshot, type SessionRuntimeConfig } from '@/runtime/SessionRuntime';

interface RegistryEntry {
  runtime: SessionRuntime;
  refs: number;
  transportFirst: boolean;
}

/** Defer dispose one macrotask so React StrictMode effect replay can re-acquire. */
const DISPOSE_DEFER_MS = 0;

export class SessionRuntimeRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly pendingDispose = new Map<string, ReturnType<typeof setTimeout>>();

  /** Ref-count lease only — does not mutate an existing runtime's config. */
  acquire(sessionId: string, config: SessionRuntimeConfig): SessionRuntime {
    const pending = this.pendingDispose.get(sessionId);
    if (pending) {
      clearTimeout(pending);
      this.pendingDispose.delete(sessionId);
    }

    const existing = this.entries.get(sessionId);
    if (existing) {
      if (existing.transportFirst !== config.transportFirst) {
        existing.runtime.dispose();
        this.entries.delete(sessionId);
      } else {
        existing.refs += 1;
        return existing.runtime;
      }
    }
    const runtime = new SessionRuntime(config);
    this.entries.set(sessionId, { runtime, refs: 1, transportFirst: config.transportFirst });
    return runtime;
  }

  /** Designated config owner — mutates runtime when the lease already exists. */
  update(sessionId: string, config: SessionRuntimeConfig): RuntimeMirrorSnapshot | null {
    const existing = this.entries.get(sessionId);
    if (!existing) {
      return null;
    }
    return existing.runtime.updateContext(config);
  }

  release(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }
    entry.refs -= 1;
    if (entry.refs > 0) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingDispose.delete(sessionId);
      const current = this.entries.get(sessionId);
      if (!current || current.refs > 0) {
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
