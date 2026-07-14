import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { AddonManager } from './AddonManager';
import { Renderer } from './Renderer';
import { ThemeManager } from './ThemeManager';
import { ViewportManager } from './ViewportManager';
import { InputManager } from './InputManager';
import { ConnectionManager } from './ConnectionManager';
import type {
  TerminalViewOptions,
  TerminalViewState,
  ConnectionState,
} from './types';

const DEFAULT_FONT =
  "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace";

export class TerminalView {
  readonly terminal: Terminal;

  private addons: AddonManager;
  private viewport: ViewportManager;
  private input: InputManager;
  private connection: ConnectionManager;

  private isDisposed = false;
  private attachTimer: ReturnType<typeof setTimeout> | null = null;

  onStateChange: ((state: TerminalViewState) => void) | null = null;
  onCtrlD: (() => void) | null = null;
  onError: ((error: Error) => void) | null = null;
  onDisconnect: (() => void) | null = null;

  constructor(container: HTMLElement, options: TerminalViewOptions) {
    // 1. Create xterm instance.
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: options.deviceProfile?.fontSize ?? 14,
      fontFamily: DEFAULT_FONT,
      theme: options.theme,
      allowProposedApi: true,
      scrollback: options.deviceProfile?.scrollback ?? 10000,
    });

    // 2. Create managers.
    this.addons = new AddonManager(this.terminal);

    // Renderer and ThemeManager are created for their constructor side-effects.
    new Renderer(this.terminal, options.rendererType);
    new ThemeManager(this.terminal, options.theme);

    const fitAddon = this.addons.register(new FitAddon());
    this.viewport = new ViewportManager(
      this.terminal,
      fitAddon,
      container,
      { profile: options.deviceProfile },
    );

    this.input = new InputManager(this.terminal);
    this.connection = new ConnectionManager(options.connection);

    // 3. Wire managers together.
    this.input.onData((data: string) => {
      if (!this.isDisposed) { this.connection.send(data); }
    });
    this.input.onCtrlD(() => {
      this.onCtrlD?.();
    });

    this.connection.onOutput = (data: string) => {
      if (!this.isDisposed) { this.terminal.write(data); }
    };
    this.connection.onStateChange = (state: ConnectionState, attempt: number) => {
      this.onStateChange?.({
        banner: state === 'reconnecting' ? 'reconnecting'
              : state === 'lost' ? 'failed'
              : 'none',
        reconnectAttempt: attempt,
        isConnected: state === 'connected',
      });
    };
    this.connection.onError = (err: Error) => {
      this.onError?.(err);
    };
    this.connection.onDisconnect = () => {
      this.onDisconnect?.();
    };

    // 4. Open terminal in DOM.
    this.terminal.open(container);

    // 5. Deferred attach (survives React StrictMode double-mount).
    this.attachTimer = setTimeout(() => {
      if (!this.isDisposed) {
        this.connection.attach().catch(() => {});
      }
    }, 50);
  }

  sendText(text: string): void {
    if (this.isDisposed) { return; }
    this.connection.send(text);
  }

  refit(): void {
    if (this.isDisposed) { return; }
    requestAnimationFrame(() => {
      if (!this.isDisposed) { this.viewport.fit(); }
    });
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.attachTimer) { clearTimeout(this.attachTimer); this.attachTimer = null; }
    this.input.dispose();
    this.viewport.dispose();
    this.connection.dispose();
    this.terminal.dispose();
  }
}
