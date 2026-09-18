/**
 * HashRouter routes live in `/#/…`. nginx `try_files` serves index.html for any
 * pathname (`/login`, `/foo/bar`), which leaves a bogus path in the address bar
 * while the hash router boots at `#/`.
 */
export function normalizeHashRouterLocation(): void {
  const { pathname, hash } = window.location;
  if (pathname === '/' || pathname === '') {
    return;
  }
  const hashRoute = hash.startsWith('#') ? hash : '#/';
  window.location.replace(`${window.location.origin}/${hashRoute}`);
}
