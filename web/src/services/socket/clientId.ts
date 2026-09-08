import { v4 as uuidv4 } from 'uuid';

const CLIENT_ID_KEY = 'nessioclientid';

/**
 * Stable per-browser client identifier, persisted in localStorage.
 *
 * Sent with `client.auth` so the server can correlate the browser with its
 * previous sessions across refreshes and reconnects. Created once, then
 * reused for the life of the origin (unless the user clears site data).
 */
export function getOrCreateClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = uuidv4();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}
