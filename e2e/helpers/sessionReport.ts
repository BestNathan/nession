import { expect, type Page } from '@playwright/test';

interface PushedSession {
  session_name?: string;
  foreground_command?: string | null;
}

/**
 * Observe the Session lists the server sends, so a spec can wait for the
 * *report* instead of for a rendering latency (#1326).
 *
 * A spec that waits for `session-item-workload` to stop reading `unknown` is
 * asking a question about the agent and the server — has the pane's foreground
 * command been reported yet — but reading the answer off the rendered row. That
 * conflates two claims with different owners and different failure modes:
 *
 * - **the report never arrived** (agent, server, or transport), and
 * - **the report arrived and the UI did not show it** (renderer).
 *
 * A duration allowance cannot tell them apart, and its failure says only
 * "still `unknown` after N seconds", which is why #1326 could not say whether
 * the fault was in the spec or behind it. Waiting on the protocol splits them:
 * the wait fails with the leg that did not happen, and the DOM assertion that
 * follows is about rendering alone.
 *
 * **It watches both wires the app itself reads, and that is load-bearing.**
 * `SessionsPlugin` learns the list from `server.sessions.changed` (the push) *and*
 * from `server.session.list` (the operation, whose response carries the same
 * `payload.sessions`). A first version of this helper matched only the push,
 * and failed deterministically on three CI attempts — the report was arriving
 * on the other wire. Matching the *payload shape* rather than a `msg_type` is
 * what makes it watch the whole path instead of half of it; it is also why
 * there is no wire constant here to go stale.
 *
 * This is still bounded by a timeout — nothing can wait forever — but the
 * signal is definite: a session list carrying this Session with a command in
 * it. The ceiling sits below the test's own budget so that a report which never
 * arrives fails *as* a missing report, rather than as a test timeout that says
 * nothing about which leg stalled.
 */
export function watchSessionReports(page: Page): {
  waitForCommand: (sessionName: string) => Promise<string>;
} {
  const reported = new Map<string, string>();

  page.on('websocket', (socket) => {
    socket.on('framereceived', (frame) => {
      const text = typeof frame.payload === 'string' ? frame.payload : null;
      if (text === null) {
        return;
      }
      let message: { payload?: { sessions?: PushedSession[] } };
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      const sessions = message.payload?.sessions;
      if (!Array.isArray(sessions)) {
        return;
      }
      for (const session of sessions) {
        const command = session.foreground_command;
        if (session.session_name && command) {
          reported.set(session.session_name, command);
        }
      }
    });
  });

  return {
    async waitForCommand(sessionName: string): Promise<string> {
      await expect
        .poll(() => reported.get(sessionName) ?? null, {
          message:
            `no session list carrying a foreground command for ${sessionName} ` +
            'reached the page. This is the agent/server leg, not the renderer: ' +
            'check that the agent reported the pane command and that the list ' +
            'reached the browser on either wire.',
          timeout: 15_000,
        })
        .not.toBeNull();
      return reported.get(sessionName) as string;
    },
  };
}
