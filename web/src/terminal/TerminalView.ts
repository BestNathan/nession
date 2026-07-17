import { Terminal } from '@xterm/xterm';
import { Renderer } from './Renderer';
import { ThemeManager } from './ThemeManager';
import { TerminalSizeManager } from './TerminalSizeManager';
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

  private size: TerminalSizeManager;
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
    new Renderer(this.terminal, options.rendererType);
    new ThemeManager(this.terminal, options.theme);

    this.size = new TerminalSizeManager(this.terminal, container, container);

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
    // No-op: TerminalSizeManager is driven by tmux resize events, not viewport fitting.
  }

  /** Push a banner state from an external observer (e.g. React watching P2P). */
  setExternalBanner(banner: 'none' | 'reconnecting' | 'failed', attempt: number): void {
    if (this.isDisposed) { return; }
    this.onStateChange?.({
      banner,
      reconnectAttempt: attempt,
      isConnected: banner === 'none',
    });
  }

  /** Re-issue attach (tmux redraw) after a transport reconnect. */
  reattach(): void {
    if (this.isDisposed) { return; }
    this.connection.reattach().catch(() => {});
  }

  dispose(): void {
    this.isDisposed = true;
    if (this.attachTimer) { clearTimeout(this.attachTimer); this.attachTimer = null; }
    this.input.dispose();
    this.size.dispose();
    this.connection.dispose();
    this.terminal.dispose();
  }
}
