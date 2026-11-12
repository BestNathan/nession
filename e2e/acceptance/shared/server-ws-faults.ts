// #3358 browser fault injector: make every WebSocket look unreachable.
//
// The Case needs the *client* side of a Server/P2P outage, not a production
// deployment. The wrapper is installed before app scripts run. While `reject`
// is set, every constructed socket is closed as soon as it can be, so the
// transport observes a network failure on every dial; clearing the flag lets
// the next retry through unchanged. No token, URL or app state is read here.
import type { Page } from '@playwright/test';

interface FaultState {
  reject: boolean;
  sockets: WebSocket[];
}

declare global {
  interface Window {
    __wsFault?: FaultState;
  }
}

export async function installWebSocketFaultInjector(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state: FaultState = { reject: false, sockets: [] };
    window.__wsFault = state;
    const Native = window.WebSocket;
    const Wrapped = new Proxy(Native, {
      construct(target, args) {
        const socket = Reflect.construct(target, args) as WebSocket;
        state.sockets.push(socket);
        if (state.reject) {
          const close = (): void => {
            try {
              socket.close();
            } catch {
              // Already closed by the transport — the fault is still delivered.
            }
          };
          socket.addEventListener('open', close);
          setTimeout(close, 0);
        }
        return socket;
      },
    });
    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      writable: true,
      value: Wrapped,
    });
  });
}

/** Start or stop making new sockets fail, without touching the app directly. */
export async function setWebSocketFault(page: Page, reject: boolean): Promise<void> {
  await page.evaluate((value) => {
    if (!window.__wsFault) {
      throw new Error('WebSocket fault injector is not installed');
    }
    window.__wsFault.reject = value;
  }, reject);
}

/** Drop every socket the app currently holds, as a network partition would. */
export async function dropAllSockets(page: Page): Promise<void> {
  await page.evaluate(() => {
    if (!window.__wsFault) {
      throw new Error('WebSocket fault injector is not installed');
    }
    for (const socket of window.__wsFault.sockets) {
      try {
        socket.close();
      } catch {
        // Idempotent: a socket the app already replaced is gone either way.
      }
    }
    window.__wsFault.sockets.length = 0;
  });
}
