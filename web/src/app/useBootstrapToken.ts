import { useEffect, useRef } from 'react';

/**
 * Remove only the URL bootstrap `token` query parameter, preserving the path,
 * hash, `server_url` and every unrelated query parameter.
 */
export function withoutBootstrapToken(href: string): string {
  const url = new URL(href);
  if (!url.searchParams.has('token')) {
    return href;
  }
  url.searchParams.delete('token');
  return url.pathname + url.search + url.hash;
}

/**
 * Consume the URL bootstrap token exactly once.
 *
 * The token has already been read into the app's auth state by the caller's
 * initializer when this effect runs. Removing it before the handshake outcome
 * is known means neither a rejected token nor Disconnect can leave a
 * reloadable credential in the address bar. The selected token continues to
 * live under the existing storage policy; this hook owns only its URL copy.
 */
export function useBootstrapTokenConsumption(): void {
  const pending = useRef(
    typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).has('token'),
  );

  useEffect(() => {
    if (!pending.current) {
      return;
    }
    pending.current = false;
    const next = withoutBootstrapToken(window.location.href);
    if (next !== window.location.href) {
      window.history.replaceState(window.history.state, '', next);
    }
  }, []);
}
