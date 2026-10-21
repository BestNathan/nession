import { v4 as uuidv4 } from 'uuid';

const CLIENT_ID_KEY = 'nessioclientid';

/**
 * Stable id for contexts with no `localStorage` (unit tests, workers): the
 * answer is per-process rather than per-origin, which is all such a context
 * can honestly offer.
 */
let fallbackId: string | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Reading the property itself can throw when storage is blocked.
    return null;
  }
}

/**
 * Stable per-browser client identifier, persisted in localStorage.
 *
 * Sent with `client.auth` so the server can correlate the browser with its
 * previous sessions across refreshes and reconnects. Created once, then
 * reused for the life of the origin (unless the user clears site data).
 */
export function getOrCreateClientId(): string {
  const store = storage();
  if (store === null) {
    fallbackId ??= uuidv4();
    return fallbackId;
  }
  let id = store.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = uuidv4();
    try {
      store.setItem(CLIENT_ID_KEY, id);
    } catch {
      // Private mode can refuse the write; the id is still usable this session.
    }
  }
  return id;
}
