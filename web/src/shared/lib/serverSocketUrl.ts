/**
 * Derive the Server WebSocket URL from the page's own protocol and host
 * (#4588).
 *
 * An HTTPS page always derives `wss` — never a cleartext `ws` downgrade — and
 * an HTTP page (the preserved `nhome.local` LAN behavior) derives `ws`. The
 * host is carried verbatim, so the canonical single-label `bestnathan.top`
 * hosts and the `nhome.local` hosts both work without any hardcoded hostname.
 * This is the one client-side scheme-derivation owner; candidate agent
 * addresses are never scheme-rewritten (see `addressSelection.ts`).
 */
export function deriveServerSocketUrl(protocol: string, host: string): string {
  const scheme = protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${host}/ws`;
}
