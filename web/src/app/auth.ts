const TOKEN_KEY = 'token';
const REMEMBER_KEY = 'remember';

/**
 * Retrieves the authentication token from storage.
 * Checks sessionStorage first, then falls back to localStorage.
 *
 * @returns The token string if found, null otherwise
 */
export function getToken(): string | null {
  // Check sessionStorage first
  const sessionToken = sessionStorage.getItem(TOKEN_KEY);
  if (sessionToken) {
    return sessionToken;
  }

  // Fall back to localStorage
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Stores the authentication token in storage.
 * Always stores in sessionStorage. The `remember` flag is the persistence
 * policy for the *whole* token, not just this write: `true` synchronizes the
 * durable localStorage copy, `false` revokes any copy left by an earlier
 * remembered login. Leaving a durable copy behind would let a fresh browser
 * session auto-connect with a credential the user just opted out of persisting
 * (#2822). Disconnect still never calls this owner, so #354's non-logout
 * semantics are preserved.
 *
 * @param token - The token to store
 * @param remember - Whether to persist the token across sessions
 */
export function setToken(token: string, remember: boolean): void {
  // Always store in sessionStorage
  sessionStorage.setItem(TOKEN_KEY, token);

  if (remember) {
    // Remembered: both copies carry the selected token.
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    // Session-only: the durable copy must not outlive the choice.
    localStorage.removeItem(TOKEN_KEY);
  }
}

/**
 * Clears the authentication token from all storage locations.
 */
export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
}

/**
 * Gets the user's preference for remembering the token.
 *
 * @returns true if the user wants to remember the token, false otherwise
 */
export function getRememberPreference(): boolean {
  const value = localStorage.getItem(REMEMBER_KEY);
  return value === 'true';
}

/**
 * Sets the user's preference for remembering the token.
 *
 * @param value - true to remember the token, false to forget it
 */
export function setRememberPreference(value: boolean): void {
  localStorage.setItem(REMEMBER_KEY, value.toString());
}
