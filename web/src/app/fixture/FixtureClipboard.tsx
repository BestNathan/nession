import { useEffect, useRef, useState } from 'react';
import type { TerminalTransport } from '@/platform/terminal-runtime/transport/TerminalTransport';
import type { TerminalBootstrap } from '@/platform/terminal-runtime/bootstrap';
import type { TerminalStreamPosition } from '@/platform/terminal-runtime/streamApply';
import {
  TerminalController,
  type TerminalControllerEvents,
} from '@/platform/terminal-runtime/controller/TerminalController';
import { TerminalSurface } from '@/product/terminal/patterns/TerminalSurface';
import type { ClipboardNoticeState } from '@/product/terminal/state/ui';
import type { ClipboardNotice } from '@/platform/terminal-runtime/clipboard/ClipboardProtocol';
import type { TerminalSession } from '@/product/terminal/state/session';

/** What the browser Cases drive (#2598). The fixture owns no product logic. */
export interface ClipboardHarness {
  emit(
    text: string,
    options?: { bootstrap?: TerminalBootstrap; position?: TerminalStreamPosition },
  ): void;
  setObserver(readOnly: boolean): void;
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
  const hostRef = useRef<HTMLDivElement>(null);
  const [notice, setNotice] = useState<ClipboardNoticeState | null>(null);
  const [controller, setController] = useState<TerminalController | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) { return; }
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
      events,
    });
    instance.attach(host);
    setController(instance);
    window.clipboardHarness = {
      emit: transport.emit,
      sent,
      setObserver: (readOnly) => instance.setObserverReadOnly(readOnly),
      focus: () => instance.focus(),
    };
    return () => {
      delete window.clipboardHarness;
      instance.dispose();
      setController(null);
    };
  }, []);

  return (
    <div className="flex h-[100dvh] flex-col bg-background" data-testid="fixture-clipboard">
      <TerminalSurface
        experience="web"
        inputDisabled={false}
        controller={controller}
        clipboardNotice={notice}
        onDismissClipboardNotice={() => setNotice(null)}
      >
        <div ref={hostRef} className="min-h-0 flex-1" data-testid="fixture-clipboard-host" />
      </TerminalSurface>
    </div>
  );
}
