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
 * Always stores in sessionStorage. If remember is true, also stores in localStorage.
 *
 * @param token - The token to store
 * @param remember - Whether to persist the token across sessions
 */
export function setToken(token: string, remember: boolean): void {
  // Always store in sessionStorage
  sessionStorage.setItem(TOKEN_KEY, token);

  // Store in localStorage if remember is true
  if (remember) {
    localStorage.setItem(TOKEN_KEY, token);
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
