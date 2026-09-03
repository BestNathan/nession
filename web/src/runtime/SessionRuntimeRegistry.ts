import { SessionRuntime, type SessionRuntimeConfig } from '@/runtime/SessionRuntime';

interface RegistryEntry {
  runtime: SessionRuntime;
  refs: number;
}

export class SessionRuntimeRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  acquire(sessionId: string, config: SessionRuntimeConfig): SessionRuntime {
    const existing = this.entries.get(sessionId);
    if (existing) {
      existing.refs += 1;
      existing.runtime.updateContext(config);
      return existing.runtime;
    }
    const runtime = new SessionRuntime(config);
    this.entries.set(sessionId, { runtime, refs: 1 });
    return runtime;
  }

  release(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) {
      return;
    }
    entry.refs -= 1;
    if (entry.refs <= 0) {
      entry.runtime.dispose();
      this.entries.delete(sessionId);
    }
  }

  get(sessionId: string): SessionRuntime | null {
    return this.entries.get(sessionId)?.runtime ?? null;
  }
}

export const sessionRuntimeRegistry = new SessionRuntimeRegistry();
