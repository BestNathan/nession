import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import type { TerminalTransport } from '@/platform/terminal-runtime/transport/TerminalTransport';
import type { TerminalBootstrap } from '@/platform/terminal-runtime/bootstrap';
import type { TerminalStreamPosition } from '@/platform/terminal-runtime/streamApply';
import type { InputDrop } from '@/platform/terminal-runtime/inputQueue';
import {
  TerminalController,
  type TerminalControllerEvents,
} from '@/platform/terminal-runtime/controller/TerminalController';
import { TerminalSurface } from '@/product/terminal/patterns/TerminalSurface';
import { TerminalViewport } from '@/product/terminal/components/TerminalViewport';
import type { CapsuleCapabilityProjection } from '@/product/terminal/capsule/types';
import { projectionBindingFor } from '@/app/capsuleProjections';
import type { ClipboardNoticeState } from '@/product/terminal/state/ui';
import type { ClipboardNotice } from '@/platform/terminal-runtime/clipboard/ClipboardProtocol';
import type { TerminalSession } from '@/product/terminal/state/session';
import { cn } from '@/shared/lib/utils';
import { fixtureInputDrop } from './fixtureInputDrop';
import { fixtureStatusInputs } from './fixtureStatusNotices';

/** What the browser Cases drive (#2598). The fixture owns no product logic. */
export interface ClipboardHarness {
  emit(
    text: string,
    options?: { bootstrap?: TerminalBootstrap; position?: TerminalStreamPosition },
  ): void;
  setObserver(readOnly: boolean): void;
  /** Record that the opt-in notice action was executed (#2658). */
  takeControl(): void;
  readonly takeControlCalls: number;
  sent: string[];
  focus(): void;
  /** Lifecycle/memory machinery (#2879); test-only, like the rest of the harness. */
  lifecycle: LifecycleHarness;
}

/** A host the terminal was mounted in, observed by reference ownership. */
export interface LifecycleHostObservation {
  /** `live` names the attached Terminal, `other` a different one, `none` no Terminal. */
  reference: 'none' | 'live' | 'other';
  connected: boolean;
}

/** One read-only view of the controller's retained resources (#2879). */
export interface LifecycleSnapshot {
  terminalId: number | null;
  /** Last non-empty buffer line, proving a buffer survived a reattach. */
  bufferTail: string;
  bufferLength: number;
  hosts: LifecycleHostObservation[];
  controllersLive: number;
  rendererReplacements: number;
  scrollback: number;
}

/**
 * Lifecycle operations a Case performs on the production `TerminalController`.
 *
 * These mirror real transitions — viewport reparent/reattach, Session
 * replacement, renderer overflow repair and link cleanup — instead of
 * reimplementing them in the Case. Provider inspection and activation stay in
 * the Case's page context, where the xterm-private check does not apply.
 */
export interface LifecycleHarness {
  /** Mount the same controller in a new host (the reparent path). */
  attachNewHost(): void;
  /** Detach the controller from its current host, preserving its buffer. */
  detach(): void;
  /** Dispose the controller (Session teardown). */
  disposeController(): void;
  snapshot(): LifecycleSnapshot;
  /** Register the Case link matcher; one line containing LINK becomes a link. */
  installLinks(): void;
  /** Dispose the public link registration exactly once. */
  disposeLinks(): void;
  /** Links activated through the provider currently registered on the live xterm. */
  activations(): number;
  /** Create/attach/parse/detach/dispose one replacement controller (Session switch). */
  rotateSession(): Promise<void>;
  /** Queue more events than the production writer admits, forcing a rebuild. */
  forceOverflow(): void;
}

declare global {
  interface Window {
    clipboardHarness?: ClipboardHarness;
  }
}

/** The debug/E2E reference `mount()` places on a host (see XtermEmulator). */
interface DebugHost extends HTMLElement {
  xtermInstance?: unknown;
}

/** The private slice of the raw Terminal the lifecycle Case observes. */
interface DebugTerminal {
  options: { scrollback?: number };
  buffer: {
    active: {
      length: number;
      getLine(index: number): { translateToString(trimRight?: boolean): string } | undefined;
    };
  };
}

/**
 * A protocol harness transport: it records the bytes the controller would send
 * to a PTY and lets the page deliver bytes to the parser. Everything above it —
 * the ordered writer, xterm, the OSC 52/5522 protocol, the browser clipboard
 * effects and the surface notices — is the production path.
 */
function createHarnessTransport() {
  const sent: string[] = [];
  const transport: TerminalTransport & {
    emit: ClipboardHarness['emit'];
  } = {
    mode: 'p2p',
    send: (data: string) => { sent.push(data); },
    sendResize: () => {},
    flushInputBuffer: () => {},
    flushPendingResize: () => {},
    flushAllOutbound: () => {},
    onOutput: null,
    onResize: null,
    onError: null,
    dispose: () => {},
    emit: (text, options) => {
      transport.onOutput?.(
        new TextEncoder().encode(text),
        options?.bootstrap,
        options?.position,
      );
    },
  };
  return { transport, sent };
}

type HarnessTransport = ReturnType<typeof createHarnessTransport>['transport'];

/** Stable numeric identities for raw Terminals (never serialize the object). */
function createTerminalIdMap(): (terminal: object | null) => number | null {
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  return (terminal) => {
    if (!terminal) { return null; }
    let id = ids.get(terminal);
    if (id === undefined) {
      id = nextId;
      nextId += 1;
      ids.set(terminal, id);
    }
    return id;
  };
}

interface LifecycleHarnessOptions {
  instance: TerminalController;
  transport: HarnessTransport;
  session: TerminalSession;
  rendererReplacements(): number;
}

/** The #2879 lifecycle/memory operations, over the real controller. */
function createLifecycleHarness({
  instance,
  transport,
  session,
  rendererReplacements,
}: LifecycleHarnessOptions): LifecycleHarness {
  const createdHosts: HTMLElement[] = [];
  const viewportHost = document.querySelector('[data-terminal-viewport]');
  if (viewportHost instanceof HTMLElement) {
    createdHosts.push(viewportHost);
  }
  let rotationsLive = 0;
  let mainDisposed = false;
  let linkDisposable: { dispose(): void } | null = null;
  let activatedLinks = 0;
  const terminalIdOf = createTerminalIdMap();

  const lifecycle: LifecycleHarness = {
    attachNewHost() {
      const root = document.querySelector('[data-testid="fixture-clipboard-host"]');
      if (!(root instanceof HTMLElement)) { throw new Error('fixture host is missing'); }
      const host = document.createElement('div');
      host.style.width = '480px';
      host.style.height = '160px';
      root.appendChild(host);
      createdHosts.push(host);
      instance.attach(host);
    },
    detach() {
      instance.detach();
    },
    disposeController() {
      mainDisposed = true;
      instance.dispose();
    },
    snapshot() {
      const terminal = instance.terminal as unknown as DebugTerminal | null;
      const buffer = terminal?.buffer.active;
      let bufferTail = '';
      if (buffer) {
        // The newest non-empty line anywhere: a short write lands near the top
        // of an otherwise empty screen, so a fixed tail window would miss it.
        for (let index = buffer.length - 1; index >= 0; index -= 1) {
          const text = buffer.getLine(index)?.translateToString(true) ?? '';
          if (text) { bufferTail = text; break; }
        }
      }
      return {
        terminalId: terminalIdOf(instance.terminal as unknown as object | null),
        bufferTail,
        bufferLength: buffer?.length ?? 0,
        hosts: createdHosts.map((host) => {
          const reference = (host as DebugHost).xtermInstance;
          return {
            reference: reference === undefined
              ? 'none'
              : reference === instance.terminal ? 'live' : 'other',
            connected: host.isConnected,
          };
        }),
        controllersLive: (mainDisposed ? 0 : 1) + rotationsLive,
        rendererReplacements: rendererReplacements(),
        scrollback: terminal?.options.scrollback ?? 0,
      };
    },
    installLinks() {
      lifecycle.disposeLinks();
      activatedLinks = 0;
      linkDisposable = instance.registerLinkMatcher((line) => (
        line.text.includes('LINK')
          ? [{ startIndex: 0, endIndex: 4, activate: () => { activatedLinks += 1; } }]
          : []
      ));
    },
    disposeLinks() {
      linkDisposable?.dispose();
      linkDisposable = null;
    },
    activations() {
      return activatedLinks;
    },
    async rotateSession() {
      const root = document.querySelector('[data-testid="fixture-clipboard-host"]');
      if (!(root instanceof HTMLElement)) { throw new Error('fixture host is missing'); }
      const hostElement = document.createElement('div');
      hostElement.style.width = '480px';
      hostElement.style.height = '120px';
      root.appendChild(hostElement);
      const rotatedTransport = createHarnessTransport().transport;
      rotationsLive += 1;
      const rotated = new TerminalController(
        { ...session, id: 'fixture:rotation:' + rotationsLive },
        () => rotatedTransport,
        { rendererType: 'canvas', scrollbackMode: 'local-buffer' },
      );
      try {
        rotated.attach(hostElement);
        rotatedTransport.emit('ROTATE\r\n');
        await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
        rotated.detach();
      } finally {
        rotated.dispose();
        rotationsLive -= 1;
      }
      const retained = (hostElement as DebugHost).xtermInstance;
      hostElement.remove();
      if (retained !== undefined) {
        throw new Error('a rotated Session host retained its xterm instance');
      }
    },
    forceOverflow() {
      // More events than the production writer admits (4096): this is the
      // real overflow path, not a fixture-only disposal.
      for (let index = 0; index < 4_500; index += 1) {
        transport.emit('OVERFLOW ' + index + '\r\n');
      }
    },
  };
  return lifecycle;
}

/**
 * `/fixture/clipboard` — the canonical browser surface for the terminal
 * clipboard protocols (#2598).
 *
 * The acceptance Cases and E2E suites drive `window.clipboardHarness`:
 * sequence bytes in, observe the clipboard/notices, read the PTY-bound replies.
 * It mounts the real `TerminalSurface` so a notice is the product's notice, not
 * a test-only reproduction.
 */
export function FixtureClipboard() {
  const search = useLocation().search;
  // #2657: the App experience owns a 28px edge band that the direction pad
  // must respect. The shell attribute is what `appEdgeBandReservation` reads,
  // so a Case can opt into the App shell here without rendering the whole
  // spatial pager. Existing clipboard/scroll Cases keep the Web default.
  const appShell = new URLSearchParams(search).get('experience') === 'app';
  // The route can hand the surface any one of the four status inputs (#2621).
  // They are *initial* states: a notice the fixture then receives from the real
  // controller replaces the clipboard one, and Dismiss really dismisses.
  const initialStatus = useMemo(() => fixtureStatusInputs(search), [search]);
  const [notice, setNotice] = useState<ClipboardNoticeState | null>(initialStatus.clipboardNotice);
  const [inputDrop, setInputDrop] = useState<InputDrop | null>(() => fixtureInputDrop(search));
  const { historyDegraded, terminalControl } = initialStatus;
  const [controller, setController] = useState<TerminalController | null>(null);
  const takeControlRef = useRef(0);

  /**
   * Opt-in Terminal Keys projection for byte-level browser Cases (#2710).
   *
   * The clipboard route already mounts the production controller. With
   * `?capability=terminal-keys` it also mounts the real capability body over
   * that controller, so a Case can click a key and read the harness bytes
   * without provisioning the App shell. The projection is the capability's own
   * binding; no key logic is reimplemented here.
   */
  const capabilityId = new URLSearchParams(search).get('capability');
  const [capabilityProjection, setCapabilityProjection] =
    useState<CapsuleCapabilityProjection | null>(null);
  useEffect(() => {
    if (capabilityId !== 'terminal-keys') {
      setCapabilityProjection(null);
      return;
    }
    const binding = projectionBindingFor('terminal-keys');
    if (!binding) {
      return;
    }
    setCapabilityProjection({
      id: 'terminal-keys',
      title: 'Terminal Keys',
      ownsInputFocus: true,
      onDismiss: () => setCapabilityProjection(null),
      body: (_focus, setFocus, actions) =>
        binding.body({
          ...actions,
          agentId: undefined,
          sessionId: 'fixture:clipboard',
          state: 'relevant',
          onFocusChange: setFocus,
        }),
    });
  }, [capabilityId]);

  useEffect(() => {
    let sequence = 0;
    const { transport, sent } = createHarnessTransport();
    let rendererReplacements = 0;
    const events: TerminalControllerEvents = {
      onClipboardNotice: (state: ClipboardNotice) => {
        sequence += 1;
        setNotice({ id: sequence, notice: state });
      },
      onRendererReplaced: () => {
        rendererReplacements += 1;
      },
    };
    const session: TerminalSession = {
      id: 'fixture:clipboard',
      name: 'clipboard',
      status: 'connected',
      mode: 'p2p',
      startedAt: 0,
    };
    const instance = new TerminalController(session, () => transport, {
      rendererType: 'canvas',
      // The orchestrated product surface defaults to local-buffer scrollback
      // (`useTerminalOrchestration`); the fixture must mount the same scroll
      // ownership the touch Cases exercise (#2659).
      scrollbackMode: 'local-buffer',
      events,
    });

    // TerminalViewport owns attach/detach, exactly as it does in the product,
    // so the touch gesture (#2657) is mounted over the real surface here too.
    setController(instance);
    window.clipboardHarness = {
      emit: transport.emit,
      sent,
      setObserver: (readOnly) => instance.setObserverReadOnly(readOnly),
      takeControl: () => { takeControlRef.current += 1; },
      get takeControlCalls() { return takeControlRef.current; },
      focus: () => instance.focus(),
      lifecycle: createLifecycleHarness({
        instance,
        transport,
        session,
        rendererReplacements: () => rendererReplacements,
      }),
    };
    return () => {
      delete window.clipboardHarness;
      instance.dispose();
      setController(null);
    };
  }, []);

  return (
    <div
      className="flex h-[100dvh] flex-col bg-background"
      data-testid="fixture-clipboard"
      data-experience={appShell ? 'app' : undefined}
    >
      <TerminalSurface
        experience={appShell ? 'app' : 'web'}
        inputDisabled={false}
        controller={controller}
        historyDegraded={historyDegraded}
        inputDrop={inputDrop}
        onDismissInputDrop={() => setInputDrop(null)}
        terminalControl={terminalControl}
        onTakeControl={() => window.clipboardHarness?.takeControl()}
        clipboardNotice={notice}
        onDismissClipboardNotice={() => setNotice(null)}
        capsuleProjection={capabilityProjection ?? undefined}
      >
        <div
          className={cn('min-h-0 flex-1', appShell && 'flex flex-col')}
          data-testid="fixture-clipboard-host"
        >
          <TerminalViewport controller={controller} />
        </div>
      </TerminalSurface>
    </div>
  );
}
