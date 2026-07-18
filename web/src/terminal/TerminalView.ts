import { Terminal } from '@xterm/xterm';
import { Renderer } from './Renderer';
import { ThemeManager } from './ThemeManager';
import { TerminalSizeManager } from './TerminalSizeManager';
import { ScalingManager } from './ScalingManager';
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

  private scaling: ScalingManager;
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
    // 1. Create DOM structure: container -> scalingWrapper -> scrollContainer -> mountElement
    const scalingWrapper = document.createElement('div');
    scalingWrapper.style.cssText = 'position: relative; width: 100%; height: 100%; overflow: hidden;';

    const scrollContainer = document.createElement('div');
    scrollContainer.style.cssText = 'display: inline-block; overflow: auto;';

    const mountElement = document.createElement('div');
    mountElement.style.cssText = 'position: relative;';

    scrollContainer.appendChild(mountElement);
    scalingWrapper.appendChild(scrollContainer);
    container.appendChild(scalingWrapper);

    // 2. Create xterm instance.
    this.terminal = new Terminal({
      cursorBlink: true,
      fontSize: options.deviceProfile?.fontSize ?? 14,
      fontFamily: DEFAULT_FONT,
      theme: options.theme,
      allowProposedApi: true,
      scrollback: options.deviceProfile?.scrollback ?? 10000,
    });

    // 3. Create managers.
    new Renderer(this.terminal, options.rendererType);
    new ThemeManager(this.terminal, options.theme);
    this.scaling = new ScalingManager(scalingWrapper);
    this.size = new TerminalSizeManager(this.terminal, scrollContainer, mountElement);

    this.input = new InputManager(this.terminal);
    this.connection = new ConnectionManager(options.connection);

    // 4. Wire managers together.
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
    this.connection.onResize = (cols: number, rows: number) => {
      if (!this.isDisposed) {
        this.size.handleResize(cols, rows);
      }
    };

    // 5. Open terminal in DOM.
    this.terminal.open(mountElement);

    // 5b. Initialize mount element size and fit to viewport.
    // This ensures the container has explicit pixel dimensions and the terminal
    // is scaled to fill the available viewport space.
    requestAnimationFrame(() => {
      if (!this.isDisposed) {
        const cols = this.terminal.cols;
        const rows = this.terminal.rows;
        this.size.handleResize(cols, rows);

        // Use actual mount element dimensions for accurate scaling
        const terminalWidth = mountElement.clientWidth;
        const terminalHeight = mountElement.clientHeight;

        // Use the outer container (scaling wrapper's parent) dimensions for scaling reference
        // This is the actual visible area where the terminal should fit
        const outerContainer = scalingWrapper.parentElement;
        const containerWidth = outerContainer?.clientWidth ?? window.innerWidth;
        const containerHeight = outerContainer?.clientHeight ?? window.innerHeight;

        // Scale to fit container
        this.scaling.fitToViewport(terminalWidth, terminalHeight, containerWidth, containerHeight);
      }
    });

    // 6. Deferred attach (survives React StrictMode double-mount).
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

  /** Get the scaling manager for external zoom controls. */
  get scalingManager(): ScalingManager {
    return this.scaling;
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
    this.scaling.dispose();
    this.connection.dispose();
    this.terminal.dispose();
  }
}
