import type { Terminal, ITerminalAddon } from '@xterm/xterm';

/**
 * Addon ownership for one xterm instance (#2581).
 *
 * `loadAddon` registers the addon with xterm's own addon manager, which
 * disposes it exactly once when the terminal is disposed. This host adds the
 * two things that manager does not provide: a typed lookup by constructor, and
 * an explicit single-addon disposal for renderer recovery (a lost WebGL
 * context disposes its addon and loads Canvas without destroying the terminal).
 */
export class XtermAddonHost {
  private readonly addons = new Map<new (...args: never[]) => ITerminalAddon, ITerminalAddon>();
  private disposed = false;

  constructor(private readonly term: Terminal) {}

  /** Register an addon with the terminal and track it for later retrieval. */
  register<T extends ITerminalAddon>(addon: T): T {
    if (this.disposed) {
      return addon;
    }
    this.term.loadAddon(addon);
    this.addons.set(addon.constructor as new (...args: never[]) => ITerminalAddon, addon);
    return addon;
  }

  /** Get a previously registered addon by its constructor. */
  get<T extends ITerminalAddon>(type: new (...args: never[]) => T): T | undefined {
    return this.addons.get(type) as T | undefined;
  }

  /** Dispose one addon now and forget it (renderer fallback). */
  dispose(type: new (...args: never[]) => ITerminalAddon): void {
    const addon = this.addons.get(type);
    if (!addon) {
      return;
    }
    this.addons.delete(type);
    try {
      addon.dispose();
    } catch {
      // A renderer addon can throw when disposed before its first layout pass.
    }
  }

  /**
   * Release tracking without disposing the addons: xterm's addon manager owns
   * their disposal and runs it exactly once from `Terminal.dispose()`.
   */
  disposeTracking(): void {
    this.disposed = true;
    this.addons.clear();
  }
}
