/**
 * Notification capabilities an Agent negotiates on `agent.attach` (#2877).
 *
 * This lives in `platform` because the session runtime (below `product`) is
 * the consumer that switches wire semantics; the product terminal API also
 * re-exports it for its callers. The canonical string is
 * `nession_protocol::contracts::terminal::v1::TERMINAL_PROGRESS_NOTIFICATIONS_V1`
 * — a capability is a value, not a wire, so there is no generated binding to
 * import and the two spellings are kept in step by the tests on both sides.
 */
export const TERMINAL_PROGRESS_NOTIFICATIONS_V1 = 'terminal-progress-notifications-v1';
