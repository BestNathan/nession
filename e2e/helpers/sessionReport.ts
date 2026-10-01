import { expect, type Page } from '@playwright/test';

/**
 * The push a web client learns Session state from. Named here rather than
 * spelled at the call site so a rename cannot leave the wait watching a wire
 * nothing sends — the failure would be a timeout, which reads as slowness.
 */
const SESSIONS_CHANGED = 'server.sessions.changed';

interface PushedSession {
  session_name?: string;
  foreground_command?: string | null;
}

/**
 * Observe the Session reports the server pushes, so a spec can wait for the
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
 * the fault was in the spec or behind it. Waiting on the push splits them: the
 * wait fails with the leg that did not happen, and the DOM assertion that
 * follows is about rendering alone.
 *
 * This is still bounded by a timeout — nothing can wait forever — but the
 * signal is definite: one protocol message, carrying this Session, with a
 * command in it. The timeout is a ceiling on the report, not a guess at how
 * long a browser takes to paint.
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
      let message: { msg_type?: string; payload?: { sessions?: PushedSession[] } };
      try {
        message = JSON.parse(text);
      } catch {
        return;
      }
      if (message.msg_type !== SESSIONS_CHANGED) {
        return;
      }
      for (const session of message.payload?.sessions ?? []) {
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
            `the server never pushed a foreground command for ${sessionName}. ` +
            'This is the agent/server leg, not the renderer: check that the ' +
            `agent reported the pane command and that ${SESSIONS_CHANGED} reached the page.`,
          timeout: 30_000,
        })
        .not.toBeNull();
      return reported.get(sessionName) as string;
    },
  };
}
