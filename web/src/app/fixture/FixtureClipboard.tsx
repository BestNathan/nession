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
}

declare global {
  interface Window {
    clipboardHarness?: ClipboardHarness;
  }
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

  useEffect(() => {
    let sequence = 0;
    const { transport, sent } = createHarnessTransport();
    const events: TerminalControllerEvents = {
      onClipboardNotice: (state: ClipboardNotice) => {
        sequence += 1;
        setNotice({ id: sequence, notice: state });
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
