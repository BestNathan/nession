import { expect, type Page } from '@playwright/test';

/**
 * Deterministic control over `server.session.attach` replies (#2873).
 *
 * The attach-profile fast path is driven by an async attach-info reply, and a
 * race between two of them cannot be produced from the test by timing. This
 * helper patches the page's `WebSocket` before the app loads: it records each
 * outgoing attach request (id → session), and, while a Session is *held*, it
 * parks that Session's reply before the app's socket handler sees it. The
 * reply is delivered verbatim on release, so the app's real attach flow runs
 * against a real Server — only the delivery order is controlled.
 *
 * Holds are explicit and per Session; nothing here waits on a duration.
 */

export interface AttachControl {
  hold(sessionId: string): void;
  release(sessionId: string): boolean;
  heldCount(sessionId: string): number;
  requestCount(sessionId: string): number;
  /** Attach-info requests still awaiting their reply (any Session). */
  pendingCount(): number;
  /** Forget per-Session request counts (e.g. the create dialog's own fetch). */
  resetRequests(): void;
}

declare global {
  interface Window {
    __attachControl?: AttachControl;
  }
}

/** Install the interceptor. Must run before `page.goto`. */
export async function installAttachResponseControl(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    /** Attach request id → Session id, filled on send. */
    const pending = new Map<string, string>();
    /** Session id → held reply deliveries, filled on receive. */
    const held = new Map<string, Array<() => void>>();
    /** Session id → number of attach-info requests the app sent. */
    const requestCounts = new Map<string, number>();

    function parseFrame(data: unknown): {
      id?: unknown;
      msg_type?: unknown;
      payload?: unknown;
    } | null {
      if (typeof data !== 'string') { return null; }
      try {
        const value: unknown = JSON.parse(data);
        if (typeof value !== 'object' || value === null) { return null; }
        return value as { id?: unknown; msg_type?: unknown; payload?: unknown };
      } catch {
        return null;
      }
    }

    function ControlledWebSocket(
      this: unknown,
      url: string | URL,
      protocols?: string | string[],
    ): WebSocket {
      const socket =
        protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      const messageListeners: Array<(event: MessageEvent) => void> = [];
      let onmessageHandler: ((event: MessageEvent) => void) | null = null;

      const deliver = (event: MessageEvent): void => {
        for (const listener of messageListeners) { listener.call(socket, event); }
        if (onmessageHandler) { onmessageHandler.call(socket, event); }
      };

      // Register natively (bypassing the instance override below) so the
      // original MessageEvent — with its real `data` — reaches us exactly once.
      NativeWebSocket.prototype.addEventListener.call(socket, 'message', (event) => {
        const frame = parseFrame((event as MessageEvent).data);
        // The reply carries its request's own wire name and id.
        if (
          frame?.msg_type === 'server.session.attach' &&
          typeof frame.id === 'string' &&
          pending.has(frame.id)
        ) {
          const sessionId = pending.get(frame.id) as string;
          pending.delete(frame.id);
          const queue = held.get(sessionId);
          if (queue) {
            queue.push(() => deliver(event as MessageEvent));
            return;
          }
        }
        deliver(event as MessageEvent);
      });

      const addEventListener = socket.addEventListener.bind(socket);
      socket.addEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) => {
        if (type === 'message' && typeof listener === 'function') {
          messageListeners.push(listener as (event: MessageEvent) => void);
          return;
        }
        addEventListener(type, listener, options);
      }) as WebSocket['addEventListener'];

      const removeEventListener = socket.removeEventListener.bind(socket);
      socket.removeEventListener = ((
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | EventListenerOptions,
      ) => {
        if (type === 'message' && typeof listener === 'function') {
          const index = messageListeners.indexOf(listener as (event: MessageEvent) => void);
          if (index >= 0) { messageListeners.splice(index, 1); }
          return;
        }
        removeEventListener(type, listener, options);
      }) as WebSocket['removeEventListener'];

      // WebSocketService assigns `ws.onmessage`; route it through the same
      // controlled delivery instead of the native property.
      Object.defineProperty(socket, 'onmessage', {
        configurable: true,
        get: () => onmessageHandler,
        set: (handler: ((event: MessageEvent) => void) | null) => {
          onmessageHandler = handler;
        },
      });

      const send = socket.send.bind(socket);
      socket.send = ((data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        if (typeof data === 'string') {
          const frame = parseFrame(data);
          if (frame?.msg_type === 'server.session.attach' && typeof frame.id === 'string') {
            const payload = frame.payload as { session_id?: unknown } | undefined;
            if (typeof payload?.session_id === 'string') {
              pending.set(frame.id, payload.session_id);
              requestCounts.set(
                payload.session_id,
                (requestCounts.get(payload.session_id) ?? 0) + 1,
              );
            }
          }
        }
        send(data);
      }) as WebSocket['send'];

      return socket;
    }

    // Keep `instanceof WebSocket` and the ready-state constants working.
    ControlledWebSocket.prototype = NativeWebSocket.prototype;
    Object.defineProperties(ControlledWebSocket, {
      CONNECTING: { value: NativeWebSocket.CONNECTING },
      OPEN: { value: NativeWebSocket.OPEN },
      CLOSING: { value: NativeWebSocket.CLOSING },
      CLOSED: { value: NativeWebSocket.CLOSED },
    });
    window.WebSocket = ControlledWebSocket as unknown as typeof WebSocket;

    window.__attachControl = {
      hold: (sessionId: string) => {
        if (!held.has(sessionId)) { held.set(sessionId, []); }
      },
      /** Deliver the oldest held reply for this Session, in arrival order. */
      release: (sessionId: string) => {
        const queue = held.get(sessionId);
        const next = queue?.shift();
        if (!queue || !next) { return false; }
        next();
        return true;
      },
      heldCount: (sessionId: string) => held.get(sessionId)?.length ?? 0,
      requestCount: (sessionId: string) => requestCounts.get(sessionId) ?? 0,
      pendingCount: () => pending.size,
      resetRequests: () => {
        pending.clear();
        requestCounts.clear();
      },
    };
  });
}

export async function holdAttachResponse(page: Page, sessionId: string): Promise<void> {
  await page.evaluate((id) => {
    const control = window.__attachControl;
    if (!control) { throw new Error('attach response control is not installed'); }
    control.hold(id);
  }, sessionId);
}

/** Wait until `count` attach replies for this Session are parked. */
export async function waitForHeldAttach(
  page: Page,
  sessionId: string,
  count = 1,
): Promise<void> {
  await expect
    .poll(() => page.evaluate(
      (id) => window.__attachControl?.heldCount(id) ?? 0,
      sessionId,
    ))
    .toBe(count);
}

/** Release the oldest held reply; false when none was parked. */
export async function releaseAttachResponse(page: Page, sessionId: string): Promise<boolean> {
  return page.evaluate((id) => {
    const control = window.__attachControl;
    if (!control) { throw new Error('attach response control is not installed'); }
    return control.release(id);
  }, sessionId);
}

export async function attachRequestCount(page: Page, sessionId: string): Promise<number> {
  return page.evaluate(
    (id) => window.__attachControl?.requestCount(id) ?? 0,
    sessionId,
  );
}

/** Wait until every attach-info request sent so far has its reply. */
export async function waitForNoPendingAttach(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => window.__attachControl?.pendingCount() ?? 0))
    .toBe(0);
}

/**
 * Start counting from zero. Session creation opens the attach dialog, which
 * fetches attach info of its own; the scenario only wants its own clicks.
 * Call only after {@link waitForNoPendingAttach}.
 */
export async function resetAttachRequestCounts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const control = window.__attachControl;
    if (!control) { throw new Error('attach response control is not installed'); }
    control.resetRequests();
  });
}
