/**
 * Append a connection token to an agent WebSocket URL as a query parameter.
 *
 * The browser half of a convention three languages write by hand, and nothing
 * generates: the Server's relay dials use
 * `nession_protocol::contracts::p2p::agent_url_with_credential` and the CLI
 * goes through a Rust `P2pConnection`. A rename of `token` in any one of them
 * produces agent connections that fail for a reason nothing at either end can
 * explain, so the rules below are the same three the Rust side implements:
 *
 * - **No token adds no parameter.** `token=` with nothing after it makes "no
 *   credential" and "the empty credential" the same bytes.
 * - **A URL that already has a query joins with `&`.**
 * - **A URL with no path gets one first.** `wss://host` is a working agent URL
 *   — an absolute URI with an empty path implies `/` — and `wss://host?token=x`
 *   is not: the request target becomes `?token=x`, which is not origin-form, so
 *   the peer drops the connection mid-handshake and the browser reports a
 *   failed connection with nothing in it about the URL. `connect_url` is agent
 *   config documented as the public URL clients dial, so a tunnel endpoint
 *   written without a path is exactly this shape.
 *
 * Lives in `shared/lib` rather than beside the socket service that first needed
 * it because its consumers include `shared/lib/addressSelection.ts`, and
 * `shared` may import nothing above it (#1091). The rule classifies a module by
 * who consumes it, which is the same test that keeps `addressSelection` here.
 */
export function buildAgentWsUrl(agentUrl: string, connectionToken?: string): string {
  if (!connectionToken) {
    return agentUrl;
  }
  const parameter = `token=${encodeURIComponent(connectionToken)}`;
  if (agentUrl.includes('?')) {
    return `${agentUrl}&${parameter}`;
  }
  const authorityOnly = /^[a-z][a-z0-9+.-]*:\/\/[^/]*$/i.test(agentUrl);
  return `${agentUrl}${authorityOnly ? '/?' : '?'}${parameter}`;
}
