import type { Terminal, ITerminalAddon } from '@xterm/xterm';

export class AddonManager {
  private addons = new Map<new (...args: unknown[]) => ITerminalAddon, ITerminalAddon>();

  constructor(private term: Terminal) {}

  /** Register an addon with the terminal and track it for later retrieval. */
  register<T extends ITerminalAddon>(addon: T): T {
    this.term.loadAddon(addon);
    this.addons.set(addon.constructor as new (...args: unknown[]) => ITerminalAddon, addon);
    return addon;
  }

  /** Get a previously registered addon by its constructor. */
  get<T extends ITerminalAddon>(type: new (...args: unknown[]) => T): T | undefined {
    return this.addons.get(type) as T | undefined;
  }
}
