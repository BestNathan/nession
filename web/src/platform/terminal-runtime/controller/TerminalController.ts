// web/src/terminal/controller/TerminalController.ts
import type {
  DeviceProfile,
  InputMode,
  TerminalScrollbackMode,
  TerminalSession,
} from '../types';
import type { TerminalTransport } from '../transport/TerminalTransport';
import { provesVerifiedBootstrapRepair, streamBaselineFromBootstrap, type TerminalBootstrap } from '../bootstrap';
import type { VerifiedTerminalBaseline } from '../AppliedTerminalCursor';
import type { TerminalStreamPosition } from '../streamApply';
import { InputRouter } from '../input/InputRouter';
import { InputSourceManager } from '../input/InputSourceManager';
import { TerminalInputHandler } from '../input/TerminalInputHandler';
import { CommandInputHandler } from '../input/CommandInputHandler';
import { SearchInputHandler } from '../input/SearchInputHandler';
import { AIInputHandler } from '../input/AIInputHandler';
import { CustomInputHandler } from '../input/CustomInputHandler';
import { CapsuleOcclusionScroll } from '../capsule/occlusionScroll';
import { XtermEmulator } from '../xterm/XtermEmulator';
import { SerializedTerminalWriter, type TerminalWriterLimits } from './SerializedTerminalWriter';
import { MobileImeInput } from '../input/MobileImeInput';
import {
  TerminalInteractionController,
  type TerminalSemanticKey,
} from '../interaction/TerminalInteractionController';
import { TerminalGeometry } from '../view/TerminalGeometry';
import type { FontSizeManager } from '../xterm/FontSizeManager';
import type {
  TerminalDisposable,
  TerminalLinkMatcher,
  TerminalWriteOrigin,
} from '../emulator';
import {
  TerminalClipboardProtocol,
  type ClipboardEffectPort,
  type ClipboardNotice,
  type ClipboardProtocolLimits,
} from '../clipboard/ClipboardProtocol';
import { BrowserClipboardEffects } from '../clipboard/browserClipboard';
import { isImageClipboardMime } from '../clipboard/osc';

/** The raw xterm handle type, obtained without importing xterm here (#2581). */
type RawTerminal = XtermEmulator['terminal'];

/**
 * What replaces a buffer when a **complete** bootstrap arrives (#321): erase
 * the display, erase the scrollback, home the cursor. Deliberately not
 * `terminal.reset()`, which also resets modes — see
 * {@link TerminalController.hasSessionOutput}.
 */
const BOOTSTRAP_BUFFER_RESET = '\x1b[2J\x1b[3J\x1b[H';

/**
 * What a **truncated** bootstrap gets instead (#1305): erase the display and
 * home the cursor, but leave the scrollback alone.
 *
 * The agent's byte ceiling drops the *oldest* history, so a truncated snapshot
 * is newer but shorter than what a long-attached client already holds — its
 * scrollback budget is 10k lines (mobile) / 50k (desktop)
 * (`DeviceProfile.PROFILES`) against the agent's 5000-line, 512 KiB capture.
 * Erasing the scrollback for a snapshot that cannot refill it destroys context
 * the client is configured to keep, so the one thing the snapshot *can*
 * restore — the current screen — is what gets replaced. `\x1b[2J` erases the
 * viewport and leaves the scrollback; `\x1b[3J` is the half that would not
 * come back.
 */
const BOOTSTRAP_SCREEN_RESET = '\x1b[2J\x1b[H';

export interface TerminalControllerEvents {
  onTransportReady?: (ready: boolean) => void;
  /**
   * A snapshot that **replaced** the buffer has finished xterm parsing: a
   * cut-proven full-VT checkpoint (#2008), or an atomic, non-truncated
   * epoch-start history capture, which IS the pane's history at that stream
   * position and is written after a buffer reset (#2160). A screen-only
   * repaint and a replay prefix are neither and must not clear a history
   * repair (#2155).
   */
  onBootstrapApplied?: () => void;
  /**
   * The current renderer parsed an atomic, complete Agent stream-log prefix.
   *
   * This is a *stream position*, not a screen/history repair: `fidelity`
   * partial/screen-only content can still follow it, and the buffer may not
   * hold history that predates the Agent's reader. Emitted only from the
   * latest bootstrap's write callback for the current transport/renderer
   * (#2120).
   */
  onStreamBaseline?: (baseline: VerifiedTerminalBaseline) => void;
  /** Parser writer pressure/stall invalidates synchronized output. */
  onStreamTruncated?: () => void;
  /**
   * The parser writer refused further work and this controller replaced the
   * xterm that owned it (#2196). A halted writer cannot be resumed: the only
   * repair is a fresh renderer plus a bootstrap that refills it, so the owner
   * must request one on a new attach. Emitted after the replacement is mounted
   * and bound to a transport.
   */
  onRendererReplaced?: () => void;
  /** An individual Agent event is now parsed/applied by the current xterm.
   * Not a cumulative applied cursor, nor an output ACK (#1950). */
  onStreamEventParsed?: (position: TerminalStreamPosition) => void;
  onInputModeChange?: (sessionId: string, mode: InputMode) => void;
  onResize?: (sessionId: string, cols: number, rows: number) => void;
  onTitleChange?: (sessionId: string, title: string) => void;
  /**
   * A transient clipboard state the surface may state truthfully: a blocked
   * OSC 52 copy that a user gesture can complete, a refused write, or an
   * image-only paste the TUI has not negotiated (#2598).
   */
  onClipboardNotice?: (notice: ClipboardNotice) => void;
}

/**
 * How the session-lifecycle owner tells this controller its transport
 * identity was swapped (#1309).
 *
 * Structural rather than typed against SessionRuntime: the controller learns
 * THAT a swap finished and rebuilds from its transport factory (which reads
 * the owner's current identity), so terminal-runtime stays free of a
 * session-runtime import — and the subscription is installed in the
 * constructor, because an effect-installed one can miss a swap that lands
 * between the layout-phase attach and the passive phase (the same ordering
 * lesson as #598).
 */
export interface TerminalTransportBinding {
  /** Subscribe to swap notifications; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

export interface TerminalControllerOptions {
  rendererType: 'webgl' | 'canvas';
  fontSize?: number;
  /** xterm's line-height: a multiple of the font box, from the Experience tokens. */
  lineHeight?: number;
  scrollback?: number;
  /**
   * Device class this terminal was built for. 'mobile' swaps xterm's hidden
   * helper textarea for {@link MobileImeInput} so soft keyboards and IMEs have
   * a real, cursor-anchored element to attach to.
   */
  deviceProfile?: DeviceProfile;
  scrollbackMode?: TerminalScrollbackMode;
  /**
   * The Session's stated fixed column count (#2487), if the caller already
   * knows it — the Server states its release value on attach, and the Agent
   * states the live Session's width on its attach reply. Absent means "use
   * this build's embedded value"; the Agent's first authoritative resize
   * adopts the live value either way.
   */
  terminalCols?: number;
  events?: TerminalControllerEvents;
  /** Lifecycle-owner swap channel — the controller rewires when it fires. */
  transportBinding?: TerminalTransportBinding;
  /**
   * Bounds for the parser writer ({@link SerializedTerminalWriter}). Defaults
   * are the measured production bounds; tests inject small ones to drive the
   * overflow repair deterministically.
   */
  writerLimits?: Partial<TerminalWriterLimits>;
  /**
   * Clipboard effect adapter. Defaults to the browser Clipboard API; tests
   * inject a fake to observe OSC 52/5522 effects without a real clipboard.
   */
  clipboardEffects?: ClipboardEffectPort;
  clipboardLimits?: Partial<ClipboardProtocolLimits>;
}

/**
 * Mobile IME handling needs both a mobile-sized viewport and actual touch
 * input. A touch-capable laptop stays on the desktop path: MobileImeInput
 * deliberately does not translate Ctrl/Alt chords, which a physical keyboard
 * needs and xterm already handles.
 */
function shouldUseMobileIme(profile: DeviceProfile | undefined): boolean {
  return profile === 'mobile' && typeof window !== 'undefined' && 'ontouchstart' in window;
}

/**
 * Imperative facade over xterm + TerminalTransport. React components interact
 * with this class instead of touching xterm or WebSocket/P2P details directly.
 *
 * The transport is acquired lazily via a factory (not a direct instance) so
 * the controller never couples to ConnectionManager's concrete shape — the
 * caller wraps ConnectionManager into a TerminalTransport at the boundary.
 */
export class TerminalController {
  readonly session: TerminalSession;

  private _terminal: RawTerminal | null = null;
  private instance: XtermEmulator;
  /**
   * FIFO parser ordering survives a transport rewire along with the emulator.
   *
   * It does NOT survive a halted writer (#2196): a queue that refused work is
   * replaced together with the xterm it serializes, never reset in place.
   */
  private writer: SerializedTerminalWriter;
  private readonly options: TerminalControllerOptions;
  private mountElement: HTMLElement | null = null;
  private repairQueued = false;
  private disposed = false;
  private transportFactory: () => TerminalTransport;
  private transport: TerminalTransport | null = null;
  private geometry: TerminalGeometry | null = null;
  /** Link matchers survive a renderer replacement (SC-03). */
  private readonly linkMatchers: TerminalLinkMatcher[] = [];
  private linkDisposables: TerminalDisposable[] = [];
  /** The Session's stated fixed columns, when a caller or the Agent stated one. */
  private sessionCols: number | null;
  private inputRouter: InputRouter | null = null;
  private inputSourceManager: InputSourceManager;
  private mobileIme: MobileImeInput | null = null;
  private interaction: TerminalInteractionController | null = null;
  private capsuleOcclusionScroll: CapsuleOcclusionScroll | null = null;
  /** OSC 52/5522 protocol state for this viewport (#2598). */
  private clipboardProtocol: TerminalClipboardProtocol | null = null;
  private clipboardHost: TerminalDisposable | null = null;
  private clipboardEffects: ClipboardEffectPort | null = null;
  private hostPasteCleanup: (() => void) | null = null;
  private titleUnsub: (() => void) | null = null;
  private transportBindingUnsub: (() => void) | null = null;
  private useMobileIme: boolean;
  private readonly scrollbackMode: TerminalScrollbackMode;
  private attached = false;
  /** Only the active Controller may fit xterm to this client's own box.
   * Observers render the Agent/tmux authoritative shared pane grid (#2286).
   * Their container measurements are retained for a future takeover. */
  private observerReadOnly = false;
  /**
   * Whether this xterm holds output of the session's. Latches — the thing it
   * describes arriving is the only transition — and a bootstrap counts,
   * because the buffer it replaces is gone while what replaced it is history
   * the user can see.
   *
   * **A bootstrap counts when xterm has parsed it, not when it was handed
   * over** (#1491). The flag's reader asks "does my Terminal hold the session's
   * history" and decides from the answer whether to ask the agent for a
   * snapshot, so a flag lifted by bytes still in the write queue answers for a
   * buffer that is empty or half-filled — and the attach it steers then skips
   * the snapshot that would have filled it. Live frames have no such moment
   * and latch on arrival: they are a stream, and a reader waiting on a
   * callback would see "no output" for a session that is producing plenty.
   *
   * Read by the attach path (`!hasSessionOutput` ⇒ ask for a bootstrap, #321).
   * A local {@link TerminalController.write} deliberately does not set it: that
   * writes display, not history, and a page whose first session output is the
   * snapshot must still be able to ask for one.
   */
  private _hasSessionOutput = false;
  /**
   * Whether a capture (a bootstrap of any fidelity) has been parsed into the
   * xterm that is mounted now.
   *
   * This is not the same question as {@link hasSessionOutput}, and conflating
   * them lost history (#2194): a **replacement** renderer receives live frames
   * as soon as a transport is bound, so it answers "I hold output" while
   * holding none of the session's history. The attach that follows then skips
   * the capture — and the terminal silently starts a new timeline. A renderer
   * only answers this one `true` after a capture's write callback ran for it.
   */
  private _hasParsedCapture = false;
  /**
   * Numbers the snapshots this controller has handed to xterm, so the newest
   * one's write callback is the only one that can lift
   * {@link hasSessionOutput}. A re-attach while a large snapshot is still
   * parsing hands over a second one; both callbacks run, and the older of them
   * describes a buffer that has since been erased (#1491).
   */
  private bootstrapSequence = 0;
  events?: TerminalControllerEvents;

  /** Callbacks → Jotai */
  onTitleChange: ((title: string) => void) | null = null;
  onError: ((err: Error) => void) | null = null;

  constructor(
    session: TerminalSession,
    transportFactory: () => TerminalTransport,
    options: TerminalControllerOptions = { rendererType: 'canvas' },
  ) {
    this.session = session;
    this.transportFactory = transportFactory;
    this.options = options;
    this.instance = new XtermEmulator(options);
    this.writer = this.createWriter();
    this._terminal = this.instance.terminal;
    this.installClipboardProtocol();
    this.inputSourceManager = new InputSourceManager();
    this.useMobileIme = shouldUseMobileIme(options.deviceProfile);
    this.scrollbackMode = options.scrollbackMode ?? 'legacy';
    this.events = options.events;
    this.sessionCols = typeof options.terminalCols === 'number' ? options.terminalCols : null;
    this.initInputRouter();
    // Subscribed at construction, not in an effect: the swap notification is
    // synchronous with the owner's identity change, so the rewire lands in
    // the same tick and can never bind a just-disposed transport generation.
    this.transportBindingUnsub = options.transportBinding?.subscribe(() => {
      if (this.attached && this._terminal) {
        this.rewireTransport(this._terminal);
      }
    }) ?? null;
  }

  private createWriter(): SerializedTerminalWriter {
    // The engine port is the writer target: `write`/`resize` are the ordered
    // mutation surface, and nothing else in this class calls them.
    return new SerializedTerminalWriter(
      this.instance,
      () => this.handleWriterDegraded(),
      this.options.writerLimits,
    );
  }

  /**
   * Bind the OSC 52/5522 protocol to the current emulator (#2598).
   *
   * The protocol object is per controller, not per attach: an offer captured
   * from a user paste or a pending write belongs to this viewport, and the
   * controller survives transport rewires. A renderer replacement allocates a
   * new parser, so the whole binding is rebuilt there and the old offer is
   * dropped with the buffer it described.
   */
  private installClipboardProtocol(): void {
    this.clipboardHost?.dispose();
    this.clipboardHost = null;
    this.clipboardProtocol?.dispose();
    this.clipboardEffects = this.options.clipboardEffects ?? new BrowserClipboardEffects({
      notice: (notice) => this.events?.onClipboardNotice?.(notice),
    });
    this.clipboardProtocol = new TerminalClipboardProtocol({
      sendToPty: (data) => { this.sendProtocolBytes(data); },
      effects: this.clipboardEffects,
      isAuthorized: () => this.canEffectClipboard(),
      limits: this.options.clipboardLimits,
    });
    this.clipboardHost = this.instance.registerClipboardHost(this.clipboardProtocol);
  }

  /**
   * Effects need an authorized, foreground Controller: never an observer, a
   * detached viewport, or a hidden tab (the Clipboard API is not usable there,
   * and a remote process must not act while the user cannot see the result).
   */
  private canEffectClipboard(): boolean {
    return !this.disposed
      && this.attached
      && !this.observerReadOnly
      && this.transport !== null
      && (typeof document === 'undefined' || document.visibilityState === 'visible');
  }

  /**
   * Protocol replies are PTY input. They never come from a user key, so they
   * do not change the active input mode, and an observer never sends them —
   * an observer holds no ControlLease and must not write into the pane.
   */
  private sendProtocolBytes(data: string): void {
    if (this.disposed || this.observerReadOnly) { return; }
    this.transport?.send(data);
  }

  /**
   * Inspect one paste before xterm/mobile-IME text handling (#2598).
   *
   * Text keeps the existing contract: it pastes through the normal path, with
   * bracketed-paste encoding decided by xterm. Image data is captured here as
   * a one-time OSC 5522 offer; an image-only paste is not text, so it is
   * prevented from reaching either text handler. This is a capture listener on
   * the viewport so it covers the desktop helper textarea and the mobile IME
   * anchor with one owner.
   */
  private handleHostPaste(event: ClipboardEvent): void {
    const data = event.clipboardData;
    const protocol = this.clipboardProtocol;
    if (!data || !protocol) { return; }
    const text = data.getData('text/plain');
    const files: File[] = [];
    for (const item of Array.from(data.items ?? [])) {
      if (item.kind !== 'file' || !item.type.startsWith('image/')) { continue; }
      const file = item.getAsFile();
      if (file) { files.push(file); }
    }
    if (files.length === 0) { return; }
    if (text.length === 0) {
      event.preventDefault();
      event.stopPropagation();
    }
    void this.readClipboardImages(files).then((images) => {
      protocol.userPasted({ text: text.length > 0 ? text : undefined, images });
    });
  }

  private async readClipboardImages(
    files: readonly File[],
  ): Promise<{ mime: string; bytes: Uint8Array }[]> {
    const images: { mime: string; bytes: Uint8Array }[] = [];
    for (const file of files) {
      if (!isImageClipboardMime(file.type)) { continue; }
      try {
        images.push({ mime: file.type, bytes: new Uint8Array(await file.arrayBuffer()) });
      } catch {
        // An unreadable item is not a clipboard protocol error: the remaining
        // MIME types are still offered truthfully.
      }
    }
    return images;
  }

  /**
   * Complete a blocked OSC 52 copy from an explicit user gesture (the "Copy"
   * action in the surface notice). Returns whether the browser accepted it.
   *
   * This is the async path. On an ordinary HTTP origin there is no
   * `navigator.clipboard` to call (#2614): the surface must ask
   * {@link canWriteClipboardProgrammatically} first and use
   * {@link copyClipboardTextFromGesture} in the click instead of spending the
   * gesture on a call that cannot succeed.
   */
  async copyClipboardText(text: string): Promise<boolean> {
    const effects = this.clipboardEffects;
    if (!effects) { return false; }
    try {
      await effects.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether this origin can write the clipboard without a user gesture
   * (#2614). `false` on plain HTTP, where the async Clipboard API is absent.
   */
  canWriteClipboardProgrammatically(): boolean {
    return this.clipboardEffects?.writeTextIsProgrammatic?.() ?? false;
  }

  /**
   * Copy text synchronously from inside the activating click (#2614), for
   * origins without the async API. Must be called in the same task as the
   * event; `false` means the browser refused and the surface must offer the
   * selectable-text path instead of claiming a copy.
   */
  copyClipboardTextFromGesture(text: string): boolean {
    return this.clipboardEffects?.writeTextFromGesture?.(text) ?? false;
  }

  /**
   * The parser writer will not accept more work. State the gap to its owner,
   * then replace the renderer.
   *
   * The replacement is deferred by one microtask: `degrade()` runs from the
   * writer's own enqueue/parse path, and disposing the xterm instance and the
   * transport that delivered the frame underneath that stack would tear down
   * a handler while it is still executing. Every write between the halt and
   * the replacement is dropped by the halted writer — the gap is already
   * stated, and the bootstrap that follows refills the new buffer.
   */
  private handleWriterDegraded(): void {
    this.events?.onStreamTruncated?.();
    if (this.repairQueued || this.disposed) { return; }
    this.repairQueued = true;
    queueMicrotask(() => {
      this.repairQueued = false;
      this.rebuildRenderer();
    });
  }

  /**
   * Replace the xterm instance and its parser writer after the writer halted
   * (#2196).
   *
   * A halted writer is a statement about the renderer, not a queue that can
   * be flushed: it dropped operations and cannot vouch for the parser state
   * afterwards. So the renderer is rebuilt empty, the new writer starts clean,
   * and the owner is told to request the bootstrap that gives the new buffer
   * its history. Until that capture is parsed and proved, the runtime keeps
   * reporting the degraded state (it is the owner of that decision).
   */
  private rebuildRenderer(): void {
    if (this.disposed || !this._terminal) { return; }
    // A halt is repaired even without a viewport (a local write can overflow
    // before attach); only the mounting half is skipped then and the next
    // attach mounts the clean instance.
    const element = this.attached ? this.mountElement : null;
    if (this.attached && !element) { return; }

    this.teardownTerminalUi();
    // Any bootstrap callback still held by the old xterm describes a buffer
    // that no longer exists; the sequence is what keeps it from vouching for
    // `hasSessionOutput` on the replacement.
    this.bootstrapSequence += 1;
    this.writer.dispose();
    this.instance.unmount();
    this.instance.dispose();

    this.instance = new XtermEmulator(this.options);
    this.writer = this.createWriter();
    this._terminal = this.instance.terminal;
    // A new parser needs the protocol handlers re-bound; the offer and any
    // in-flight write described the old buffer and are dropped with it.
    this.installClipboardProtocol();
    // The replacement holds nothing of the session's yet; an attach that
    // reads this flag must ask for the history the old buffer had.
    this._hasSessionOutput = false;
    if (element) {
      this.instance.mount(element);
      // Retires the transport that was bound to the disposed xterm and binds a
      // fresh one; the runtime advances its generation and re-attaches with a
      // bootstrap when it hears about the replacement.
      this.rewireTransport(this._terminal);
      this.wireTerminalUi(element);
      this.rewireLinkMatchers();
    }
    this.events?.onRendererReplaced?.();
  }

  /**
   * Create the input router and register the mode handlers that don't need an
   * xterm instance yet. The terminal handler is registered in attach() once the
   * xterm instance exists. Returns the router so re-attach can rebuild it after
   * detach() clears the reference.
   */
  private initInputRouter(): InputRouter {
    const router = new InputRouter();
    router.register(new CommandInputHandler());
    router.register(new SearchInputHandler());
    router.register(new AIInputHandler());
    router.register(new CustomInputHandler());
    this.inputRouter = router;
    return router;
  }

  /**
   * The raw xterm handle while attached; null after detach().
   *
   * Platform/tests only. Product/UI consumes the emulator port through this
   * controller and `nession/no-direct-xterm` rejects importing the engine's raw
   * module from those layers (#2581).
   */
  get terminal(): RawTerminal | null {
    return this._terminal;
  }

  get sessionId(): string {
    return this.session.id;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** True when xterm is open in the DOM and transport handlers are wired. */
  isViewportAttached(): boolean {
    return this.attached;
  }

  /** Create xterm, mount on `element`, and wire the transport to it. */
  attach(element: HTMLElement): void {
    if (this.instance.isDisposed || this.disposed) {
      return;
    }
    // Kept so a writer-halt repair can mount its replacement in the same
    // viewport without asking React to re-render (#2196).
    this.mountElement = element;

    // Same container — transport-only rewire (P2P socket / route changed).
    if (this.attached && this.instance.element?.parentElement === element) {
      this.rewireTransport(this.instance.terminal);
      return;
    }

    // Reparent to a new viewport container (React remount). Same teardown as a
    // full detach, minus dropping the instance — see `teardownTerminalUi`.
    if (this.attached && this.instance.element?.parentElement !== element) {
      this.teardownTerminalUi();
      this.teardownTransport();
      this.instance.unmount();
      this.attached = false;
    }
    if (this.attached) { return; }

    this.instance.mount(element);
    if (!this.instance.element) {
      this.teardownTransport();
      return;
    }

    this.attached = true;
    this._terminal = this.instance.terminal;
    this.rewireTransport(this._terminal);
    this.wireTerminalUi(element);
    this.rewireLinkMatchers();
  }

  /** Swap ConnectionManager after P2P reconnect without tearing down xterm. */
  private rewireTransport(terminal: RawTerminal): void {
    this.teardownTransport();
    // A new transport generation may restart the Agent stream epoch; stale
    // epoch checks are relative to the stream this transport will deliver.
    this.clipboardProtocol?.resetStreamEpoch();
    const transport = this.transportFactory();
    this.transport = transport;
    transport.onOutput = (data: Uint8Array, bootstrap?: TerminalBootstrap, position?: TerminalStreamPosition) => {
      // A bootstrap is the session's history, not more output: it **replaces**
      // this buffer instead of appending to it, which is the whole reason the
      // agent can re-send history on every attach that needs one without the
      // user ending up with two copies on screen (#321).
      //
      // The wipe is escape sequences rather than `terminal.reset()`, which
      // would also leave every mode the application set — including the
      // alternate screen of a TUI whose pane this snapshot came from. Erase
      // display, erase scrollback, cursor home: the three things a replaced
      // buffer needs, and nothing else.
      //
      // A shortened or unverified capture cannot stand in for the client's
      // existing scrollback. Repaint the visible screen only; preserve history
      // unless a proven atomic, full-VT checkpoint justifies replacement.
      // An atomic cut beyond position 0 is a complete replay of the Agent's
      // ordered stream log, so replacing the buffer is what makes "every event
      // through `throughSeq` was applied" true — appending it to bytes a
      // previous subscription already applied would duplicate them.
      //
      // An epoch-start cut (#2124) has no replay, but a **history-sized,
      // non-truncated** capture taken there is the pane's history at that
      // stream position: everything the client retained is a prefix of it.
      // Appending it over the retained buffer writes the overlap a second time
      // (#2160), and repainting only the screen leaves the frames produced
      // while the transport was down missing. So it replaces too. A truncated
      // capture is newer than it is complete — the byte ceiling dropped the
      // oldest history (#1305) — so that one still only repaints the screen,
      // and an unverified capture never replaces.
      //
      // Fidelity stays whatever the marker states; this is a stream baseline,
      // not the full-VT repair `provesVerifiedBootstrapRepair` gates.
      const streamBaseline = bootstrap ? streamBaselineFromBootstrap(bootstrap) : undefined;
      const completeHistoryCut = bootstrap !== undefined
        && bootstrap.cutConsistency === 'atomic'
        && bootstrap.requestedLines > 0
        && !bootstrap.truncated;
      const replayReplacesBuffer = provesVerifiedBootstrapRepair(bootstrap)
        || (streamBaseline !== undefined && streamBaseline.appliedThrough > 0)
        || completeHistoryCut;
      // A capture is a screen reconstruction, and its trailing absolute caret
      // addresses a row on the **pane's** screen. Adopt the geometry the Agent
      // stated before the bytes: a renderer that has not measured the Session
      // yet is still at a placeholder size, and the caret would land above the
      // end of the buffer it just wrote — the row shrink that follows then
      // reflows away every line below it, which is the snapshot's newest
      // history (#2483). Queued through the writer, so the resize is parsed
      // before the reset and the snapshot, never after them.
      if (bootstrap?.paneCols !== undefined && bootstrap.paneRows !== undefined) {
        // Same owner as the attach-time remote size: the Session states its
        // width, and the client's next fit follows it rather than fighting it
        // (#2487).
        this.adoptSessionCols(bootstrap.paneCols);
        this.writer.resize(bootstrap.paneCols, bootstrap.paneRows);
      }
      const origin: TerminalWriteOrigin = bootstrap
        ? { source: 'replay' }
        : { source: 'live', streamEpoch: position?.streamEpoch };
      if (bootstrap) {
        this.writer.write(replayReplacesBuffer
          ? BOOTSTRAP_BUFFER_RESET : BOOTSTRAP_SCREEN_RESET, undefined, origin);
      }
      const follow = this.capsuleOcclusionScroll?.snapshotFollowing() ?? false;
      // A snapshot is this buffer's *history*, and handing it to xterm is not
      // the same fact as xterm holding it: the parse is asynchronous, so the
      // one moment that can be vouched for is the write callback (#1491). The
      // sequence is what keeps a superseded snapshot's callback from vouching
      // for a buffer it no longer describes — the flag means "my Terminal
      // holds the session's history", and until the newest snapshot has
      // landed, it does not.
      //
      // Live output is the other way round: it is a *stream*, with no
      // completion to wait for, so it latches on arrival. A reader that waited
      // for a callback there would report "no session output" for every
      // session that never sends a bootstrap.
      const bootstrapSeq = bootstrap ? ++this.bootstrapSequence : null;
      this.writer.write(data, () => {
        if (bootstrapSeq !== null
          && bootstrapSeq === this.bootstrapSequence
          && this._terminal === terminal
          && this.transport === transport) {
          this.markSessionOutput();
          this._hasParsedCapture = true;
          // The baseline is a parser-applied stream position, not a claim that
          // the screen was restored: it comes strictly from an atomic cut and
          // this write's callback in the current generation.
          if (streamBaseline) {
            this.events?.onStreamBaseline?.(streamBaseline);
          }
          // A truncated pane capture can repaint the current screen, but
          // cannot establish that the missing history was recovered. A
          // complete history capture was written after a buffer reset and is
          // the pane's history, so it does repair it (#2155).
          // Only an **epoch-start** history capture is that repair. A
          // complete replay prefix (throughSeq > 0) is a stream position: its
          // partial fidelity does not restore history that predates the
          // Agent's reader (#2120), which is not this callback's claim.
          if (provesVerifiedBootstrapRepair(bootstrap)
            || (completeHistoryCut && bootstrap?.throughSeq === 0)) {
            this.events?.onBootstrapApplied?.();
          }
        }
        if (bootstrapSeq === null && position
          && this._terminal === terminal && this.transport === transport) {
          this.events?.onStreamEventParsed?.(position);
        }
        if (follow) {
          this.capsuleOcclusionScroll?.afterOutputWhileFollowing();
        }
      }, origin);
      if (bootstrapSeq === null) { this.markSessionOutput(); }
    };
    transport.onResize = (cols: number, rows: number, position?: TerminalStreamPosition) => {
      // The Agent states the geometry it actually applied. If that width is
      // not the one this client was rendering (an existing Session from a
      // different release, or a clamped request), adopt it before drawing the
      // remote size, so the next fit does not fight the Session (#2487).
      this.adoptSessionCols(cols);
      this.writer.resize(cols, rows, () => {
        if (position && this._terminal === terminal && this.transport === transport) {
          this.events?.onStreamEventParsed?.(position);
        }
      });
    };
    transport.onError = (err: Error) => { this.onError?.(err); };
    this.events?.onTransportReady?.(true);
  }

  /**
   * Called from the output path, so it stays cheap: the flag check is the whole
   * cost on every frame after the first. No event — a reader at attach time is
   * what the flag is for, and a consumer that had to be notified would be one
   * more thing to keep in step with a fact that never un-sets.
   */
  private markSessionOutput(): void {
    this._hasSessionOutput = true;
  }

  /**
   * Whether this xterm already holds the session's history. False only for a
   * buffer no session output has reached — a fresh xterm, which is exactly what
   * a page reload produces and exactly the case a bootstrap exists for.
   */
  get hasSessionOutput(): boolean {
    return this._hasSessionOutput;
  }

  /**
   * Whether the mounted xterm parsed a capture of this session (#2194).
   *
   * The attach decision this answers is "would re-sending history duplicate
   * what I hold, or fill what I lack?" — and live output alone neither
   * duplicates nor fills history. See {@link _hasParsedCapture}.
   */
  get hasParsedCapture(): boolean {
    return this._hasParsedCapture;
  }

  private teardownTransport(): void {
    this.events?.onTransportReady?.(false);
    if (this.transport) {
      this.transport.onOutput = null;
      this.transport.onResize = null;
      this.transport.onError = null;
      this.transport.dispose();
      this.transport = null;
    }
  }

  private wireTerminalUi(element: HTMLElement): void {
    this.instance.onCellSizeChange = (reason) => {
      // A webfont landing changes the cell the fit was based on, so re-fit.
      // A user zoom is an explicit font choice: keep it and recompute rows.
      this.geometry?.remeasure({ fitFont: reason === 'font-load' });
    };

    const capsuleHost = element.closest('[data-terminal-capsule-host]');
    if (this.scrollbackMode === 'local-buffer' && capsuleHost instanceof HTMLElement) {
      this.capsuleOcclusionScroll = new CapsuleOcclusionScroll(
        this.instance,
        capsuleHost,
        () => this.cellDimensions.height,
      );
      requestAnimationFrame(() => {
        if (!this.attached || !this.capsuleOcclusionScroll) { return; }
        this.capsuleOcclusionScroll.bind();
      });
    }

    // Retained, not fire-and-forget: a persistent emulator survives every
    // attach, so an un-disposed title listener accumulates one per attach and
    // is never released (#1096).
    const titleSub = this.instance.onTitleChange((title: string) => {
      this.onTitleChange?.(title);
    });
    this.titleUnsub = () => titleSub.dispose();

    const transport = this.transport;
    if (!transport) { return; }

    const router = this.inputRouter ?? this.initInputRouter();
    this.interaction = new TerminalInteractionController(this.instance, (data) => {
      this.inputSourceManager.setActiveSource('keyboard');
      this.transport?.send(data);
    });
    const terminalHandler = new TerminalInputHandler(this.interaction);
    router.register(terminalHandler);
    terminalHandler.activate();

    const onPaste = (event: Event) => { this.handleHostPaste(event as ClipboardEvent); };
    element.addEventListener('paste', onPaste, true);
    this.hostPasteCleanup = () => element.removeEventListener('paste', onPaste, true);

    const imeHost = this.instance.element;
    if (this.useMobileIme && imeHost) {
      this.mobileIme = new MobileImeInput(this.instance, imeHost, {
        onCommitText: (text) => this.interaction?.sendText(text),
        onPaste: (text) => this.interaction?.paste(text),
        onSemanticKey: (key) => {
          this.interaction?.trySendSemanticKey(key);
        },
      });
    }

    this.geometry = new TerminalGeometry(this);
    requestAnimationFrame(() => {
      if (!this.attached) { return; }
      const dims = this.cellDimensions;
      this.geometry?.observe(element, dims.width, dims.height);
    });
  }

  /**
   * Register a link matcher over logical buffer lines (#2581 SC-05).
   *
   * Product/UI supplies recognition and the navigation action; the engine owns
   * line reading, wrap joining and cell mapping. The matcher survives a
   * renderer replacement, and disposing once releases it for good.
   */
  registerLinkMatcher(matcher: TerminalLinkMatcher): TerminalDisposable | null {
    if (this.disposed) { return null; }
    if (!this.linkMatchers.includes(matcher)) {
      this.linkMatchers.push(matcher);
    }
    const disposable = this.instance.registerLinkMatcher(matcher);
    this.linkDisposables.push(disposable);
    let active = true;
    return {
      dispose: () => {
        if (!active) { return; }
        active = false;
        const index = this.linkMatchers.indexOf(matcher);
        if (index >= 0) { this.linkMatchers.splice(index, 1); }
        disposable.dispose();
        this.linkDisposables = this.linkDisposables.filter((entry) => entry !== disposable);
      },
    };
  }

  /**
   * Re-install every active link matcher on the current emulator. A halted
   * writer replaces the xterm instance (#2196); the matcher registry is the
   * controller's, so the replacement gets the same links without a React
   * effect replay.
   */
  private rewireLinkMatchers(): void {
    for (const disposable of this.linkDisposables) {
      disposable.dispose();
    }
    this.linkDisposables = this.linkMatchers.map((matcher) =>
      this.instance.registerLinkMatcher(matcher));
  }

  /**
   * Release everything `wireTerminalUi` bound to the mounted terminal, leaving
   * the xterm instance itself alive.
   *
   * One method, called by both `detach()` and the reparent branch of
   * `attach()`. Those two used to tear down different subsets — reparent
   * released the transport and the capsule scroll but left the input handler,
   * the IME, the resize observer and the title subscription wired — so a
   * viewport remount leaked a subscription that the next attach then doubled
   * (#1096). Converging them is the point, not a tidy-up.
   */
  private teardownTerminalUi(): void {
    this.hostPasteCleanup?.();
    this.hostPasteCleanup = null;

    this.geometry?.dispose();
    this.geometry = null;

    this.mobileIme?.dispose();
    this.mobileIme = null;

    this.titleUnsub?.();
    this.titleUnsub = null;

    this.capsuleOcclusionScroll?.dispose();
    this.capsuleOcclusionScroll = null;

    // `dispose`, not `setMode`: setMode deactivates the current handler and
    // then activates the one for the requested mode — and the requested mode
    // is the active one — so it left a live `terminal.onData` subscription on
    // a router that was dropped immediately after, with nothing left holding a
    // reference to dispose it. Every keystroke was then sent once per leaked
    // subscription, which is `x` arriving as `xx` (#1096).
    this.inputRouter?.dispose();
    this.inputRouter = null;

    this.interaction = null;
  }

  /** Dispose xterm, transport, and the resize observer. */
  detach(): void {
    if (!this.attached) { return; }
    this.attached = false;
    this.mountElement = null;

    this.teardownTerminalUi();
    this.teardownTransport();

    this.instance.unmount();
    this._terminal = null;
  }

  /** Tear down xterm, transport, and GPU resources (controller replacement / unmount). */
  dispose(): void {
    this.disposed = true;
    this.transportBindingUnsub?.();
    this.transportBindingUnsub = null;
    this.detach();
    this.clipboardHost?.dispose();
    this.clipboardHost = null;
    this.clipboardProtocol?.dispose();
    this.clipboardProtocol = null;
    this.writer.dispose();
    this.instance.dispose();
  }

  // ── Data flow ───────────────────────────────────────────────────────────

  /**
   * Write data to the xterm display (e.g. from an external source).
   *
   * Display, not session history: this does not lift
   * {@link TerminalController.hasSessionOutput}, so a controller that has only
   * ever been written to here still asks for a bootstrap on attach.
   */
  write(data: string | Uint8Array): void {
    const follow = this.capsuleOcclusionScroll?.snapshotFollowing() ?? false;
    if (!this._terminal) { return; }
    this.writer.write(data, () => {
      if (follow) {
        this.capsuleOcclusionScroll?.afterOutputWhileFollowing();
      }
    }, { source: 'replay' });
  }

  /**
   * Unified input entry point for all input sources.
   * Layer 1: Update active source via InputSourceManager
   * Layer 2: Route to current mode handler via InputRouter
   */
  handleInput(event: import('../types').InputEvent): void {
    // Layer 1: Update active source
    this.inputSourceManager.setActiveSource(event.source);

    // Layer 2: Route to current mode handler
    this.inputRouter?.route(event.data);
  }

  /** Send user input to the transport (→ PTY). */
  send(data: string, source: import('../types').InputSource = 'component-input'): void {
    this.handleInput({ source, data, timestamp: Date.now() });
  }

  /**
   * Terminal Keys / capsule — a semantic key when there is one (#1096).
   *
   * `seq` is optional because a semantic key has no bytes of its own: encoding
   * it is the interaction layer's job, and it depends on the terminal's mode.
   * The caller supplies one or the other, never both.
   */
  sendPhysKey(key: { seq?: string; semanticKey?: TerminalSemanticKey }): void {
    if (key.semanticKey && this.interaction) {
      this.interaction.sendSemanticKey(key.semanticKey);
      return;
    }
    if (key.seq) {
      this.send(key.seq, 'component-input');
    }
  }

  /** Get the currently active input source. */
  getActiveInputSource(): import('../types').InputSource | null {
    return this.inputSourceManager.getActiveSource();
  }

  /** Apply attach-time stream cursor for gap catch-up (#1094). */
  seedStreamCursor(streamEpoch: number | undefined, streamCursor: number | undefined): void {
    this.transport?.seedStreamCursor?.(streamEpoch, streamCursor);
  }

  /** Gate keyboard / IME → PTY when this client is an observer (#1095). */
  setRemoteInputEnabled(enabled: boolean): void {
    this.instance.setInputEnabled(enabled);
    this.mobileIme?.setEnabled(enabled);
  }

  /**
   * Register a callback for input source changes.
   * Returns an unsubscribe function.
   */
  onInputSourceChange(callback: (source: import('../types').InputSource) => void): () => void {
    return this.inputSourceManager.onSourceChange(callback);
  }

  /**
   * Reconcile the input cursor against what the attach reply stated (#1307).
   *
   * Delegated like the rest of the transport surface: the controller is where
   * the React layer meets the transport, and the decision about what a moved
   * epoch or generation means belongs one level down.
   */
  seedInputCursor(seed: import('../transport/TerminalTransport').TerminalInputSeed): void {
    this.transport?.seedInputCursor?.(seed);
  }

  /** Flush any input waiting for the session to be attached. */
  flushInputBuffer(): void {
    this.transport?.flushInputBuffer();
  }

  /**
   * Flush every outbound buffer (input FIFO + coalesced resize) in one call.
   * Wired to the terminalState === 'attached' transition so queued I/O leaves
   * the browser as soon as the agent has acked client.attach.
   */
  flushAllOutbound(): void {
    this.transport?.flushAllOutbound();
  }

  // ── Terminal actions ────────────────────────────────────────────────────

  /** Called by the product lease owner, not inferred from DOM focus.
   * A passive observer reflow must not overwrite the pane's authoritative
   * geometry; clear any debounce captured under an older Controller lease. */
  setObserverReadOnly(value: boolean): void {
    this.observerReadOnly = value;
    if (value) { this.geometry?.cancelPending(); }
  }

  get isObserverReadOnly(): boolean {
    return this.observerReadOnly;
  }

  /** Resize the local xterm grid optimistically and notify the transport. */
  resize(cols: number, rows: number): void {
    this.resizeLocal(cols, rows);
    this.sendResize(cols, rows);
  }

  /**
   * Apply the measured local grid in the same FIFO as terminal.write/remote
   * authoritative resizes (#2283). Calling xterm.resize directly during an
   * unfinished parser callback mutates the grid beneath older ANSI output.
   *
   * The container's measurement and remote size publication are still
   * immediate/debounced respectively; the *buffer mutation* may wait for an
   * outstanding xterm parser write. This trades a short visual fit delay for
   * deterministic terminal history and cursor correctness.
   */
  resizeLocal(cols: number, rows: number): void {
    this.writer.resize(cols, rows);
  }

  /** Notify the transport (→ PTY) of a new size, without touching xterm. */
  sendResize(cols: number, rows: number): void {
    this.transport?.sendResize(cols, rows);
  }

  /**
   * This client just acquired (or restated) the session's ControlLease (#2286).
   *
   * The lease is the authority for which client's viewport drives the shared
   * PTY, so adoption is where the client stops following the previous
   * controller's size and states its own:
   *
   * 1. the transport forgets the size it last sent, because that number may be
   *    the one it stated at attach while *another* device was moving the pane;
   *    deduping against it would leave the PTY at the other device's size;
   * 2. the viewport is measured again **now** (`remeasure`, not the remembered
   *    size) and both the local grid and the PTY are moved to it.
   *
   * The local grid is applied synchronously and the PTY notification is not
   * debounced here: adoption is a discrete handoff, not a drag.
   */
  adoptControl(): void {
    // The acquisition already succeeded. Re-enable local fit immediately,
    // before React's control-state effect can observe the new generation.
    this.setObserverReadOnly(false);
    this.transport?.restateResize?.();
    // Ordered: a takeover can land while xterm is still parsing output. The
    // handoff is discrete, so there is no flicker argument for mutating the
    // buffer synchronously here — it must not cross an unfinished parse
    // (#2286 SC-04). The continuous drag path keeps its immediate fit.
    this.geometry?.remeasure({ ordered: true });
  }

  /**
   * Resize the local grid **through the parser writer** (#2286 SC-04).
   *
   * A discrete geometry change (adoption, authoritative application) may wait
   * for the current `terminal.write` callback without any visual cost; applying
   * it directly would let output that is still being parsed land under a grid
   * it was never produced for.
   */
  resizeLocalOrdered(cols: number, rows: number): void {
    this.resizeLocal(cols, rows);
  }

  focus(): void {
    // On mobile the IME textarea is the real input target; focusing xterm would
    // only bounce through the helper-textarea redirect.
    if (this.mobileIme) {
      this.mobileIme.focus();
      return;
    }
    this.instance.focus();
  }

  clear(): void {
    this.instance.clear();
  }

  paste(text: string): void {
    this.instance.paste(text);
  }

  // ── Scroll / font-size / cell dimensions ─────────────────────────────────

  /** Scroll the xterm viewport to the live bottom (above capsule occlusion when present). */
  scrollToBottom(): void {
    if (this.capsuleOcclusionScroll) {
      this.capsuleOcclusionScroll.scrollToMarginBottom();
      return;
    }
    this.instance.scrollToBottom();
  }
  /** Scroll the xterm viewport by whole pages (negative = up). */
  scrollPages(pages: number): void {
    if (this.capsuleOcclusionScroll) {
      this.capsuleOcclusionScroll.scrollPages(pages);
      return;
    }
    this.instance.scrollPages(pages);
  }
  /** Scroll the xterm viewport by lines (negative = up). */
  scrollLines(lines: number): void {
    if (this.capsuleOcclusionScroll) {
      this.capsuleOcclusionScroll.scrollLines(lines);
      return;
    }
    this.instance.scrollLines(lines);
  }

  /** Font-size manager while attached; null after detach(). */
  get fontSizeManager(): FontSizeManager | null {
    return this.instance?.fontSizeManager ?? null;
  }

  /** Current cell pixel dimensions; 8×16 fallback. */
  get cellDimensions(): { width: number; height: number } {
    return this.instance?.cellDimensions() ?? { width: 8, height: 16 };
  }

  /**
   * Render at `fontSize` and return the cell xterm measured for it.
   *
   * The fixed-column fit probes real cell widths; asking xterm rather than
   * scaling `fontSize × 0.6` is what makes the result the grid it draws.
   */
  measureFont(fontSize: number): { width: number; height: number } {
    return this.instance.setFontSize(fontSize);
  }

  /**
   * Publish the measured terminal content width to the viewport stylesheet.
   *
   * `TerminalGeometry` owns the value; this class owns the DOM write, which is
   * why the registered producer of `--nession-local-terminal-content-width`
   * remains the controller (#2581 SC-06).
   */
  applyContentWidth(container: HTMLElement, contentWidth: number, fits: boolean): void {
    container.style.setProperty(
      '--nession-local-terminal-content-width',
      `${contentWidth}px`,
    );
    container.dataset.terminalColsFit = fits ? 'true' : 'false';
  }


  // ── Input mode ───────────────────────────────────────────────────────────

  setInputMode(mode: InputMode): void {
    this.inputRouter?.setMode(mode);
    this.events?.onInputModeChange?.(this.sessionId, mode);
  }

  getInputMode(): InputMode {
    return this.inputRouter?.getMode() ?? { type: 'terminal' };
  }

  /** Publish viewport cols/rows to the React layer (attach sizing, debounced PTY resize). */
  publishViewportResize(cols: number, rows: number): void {
    this.events?.onResize?.(this.sessionId, cols, rows);
  }

  /**
   * Adopt the Session's authoritative fixed columns (#2487).
   *
   * The caller is either the Server/Agent attach statement (before the first
   * grid is drawn) or the Agent's own resize fan-out, which states the width
   * it actually applied after clamping a client's request. The local grid —
   * font fit, content-width cap and rows — is recomputed for the new width;
   * the Agent remains the owner of that width, never this client.
   */
  adoptSessionCols(cols: number): void {
    if (!Number.isFinite(cols) || cols <= 0) { return; }
    this.sessionCols = cols;
    this.geometry?.adoptSessionCols(cols);
  }

  /** The Session's stated fixed columns, or null while nobody stated them. */
  get statedTerminalCols(): number | null {
    return this.sessionCols;
  }
}
