// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getToken, setToken, clearToken, getRememberPreference, setRememberPreference } from '@/app/auth';

describe('auth token storage', () => {
  beforeEach(() => {
    // Clear storage before each test
    sessionStorage.clear();
    localStorage.clear();
  });

  afterEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  describe('getToken', () => {
    it('returns null when no token exists', () => {
      expect(getToken()).toBeNull();
    });

    it('returns token from sessionStorage', () => {
      sessionStorage.setItem('token', 'session-token');
      expect(getToken()).toBe('session-token');
    });

    it('returns token from localStorage when not in sessionStorage', () => {
      localStorage.setItem('token', 'local-token');
      expect(getToken()).toBe('local-token');
    });

    it('prefers sessionStorage over localStorage', () => {
      sessionStorage.setItem('token', 'session-token');
      localStorage.setItem('token', 'local-token');
      expect(getToken()).toBe('session-token');
    });
  });

  describe('setToken', () => {
    it('stores token in sessionStorage when remember=false', () => {
      setToken('test-token', false);
      expect(sessionStorage.getItem('token')).toBe('test-token');
      expect(localStorage.getItem('token')).toBeNull();
      expect(getToken()).toBe('test-token');
    });

    it('stores token in both storages when remember=true', () => {
      setToken('test-token', true);
      expect(sessionStorage.getItem('token')).toBe('test-token');
      expect(localStorage.getItem('token')).toBe('test-token');
    });

    // #2822: the persistence policy is a transition on every Connect, not an
    // additive write. Leaving the previously durable copy behind would let a
    // fresh browser session auto-connect with a credential the user just
    // opted out of persisting.
    it('revokes the durable token when remember=false replaces a remembered one', () => {
      localStorage.setItem('token', 'durable-a');

      setToken('session-b', false);

      expect(sessionStorage.getItem('token')).toBe('session-b');
      expect(localStorage.getItem('token')).toBeNull();
      expect(getToken()).toBe('session-b');

      // A fresh tab/browser session has no sessionStorage. Nothing durable
      // may remain for it to auto-connect with.
      sessionStorage.clear();
      expect(getToken()).toBeNull();
    });

    it('synchronizes both storages when a remembered token replaces an older one', () => {
      localStorage.setItem('token', 'older-durable-a');
      sessionStorage.setItem('token', 'older-session-a');

      setToken('remembered-b', true);

      expect(sessionStorage.getItem('token')).toBe('remembered-b');
      expect(localStorage.getItem('token')).toBe('remembered-b');
      expect(getToken()).toBe('remembered-b');
    });
  });

  // #354 semantics must survive the #2822 transition: Disconnect is not a
  // logout, so the remembered copy stays and a reload restores the session.
  describe('disconnect and reload (#354)', () => {
    it('keeps both copies across a Disconnect and restores from the durable copy', () => {
      setRememberPreference(true);
      setToken('remembered-a', true);

      // handleDisconnect only tears down the transport; it never calls the
      // auth-storage owner, so both copies remain for the next visit.
      expect(sessionStorage.getItem('token')).toBe('remembered-a');
      expect(localStorage.getItem('token')).toBe('remembered-a');

      // A reload starts a fresh browser session: sessionStorage is gone while
      // the remembered copy remains, which is what arms auto-connect.
      sessionStorage.clear();
      expect(getToken()).toBe('remembered-a');
      expect(getRememberPreference()).toBe(true);
    });
  });

  describe('clearToken', () => {
    it('clears token from both storages', () => {
      sessionStorage.setItem('token', 'session-token');
      localStorage.setItem('token', 'local-token');

      clearToken();

      expect(sessionStorage.getItem('token')).toBeNull();
      expect(localStorage.getItem('token')).toBeNull();
    });

    it('does not throw when storages are already empty', () => {
      expect(() => clearToken()).not.toThrow();
    });
  });

  describe('getRememberPreference', () => {
    it('returns false by default', () => {
      expect(getRememberPreference()).toBe(false);
    });

    it('returns true when set to true', () => {
      localStorage.setItem('remember', 'true');
      expect(getRememberPreference()).toBe(true);
    });

    it('returns false when set to false', () => {
      localStorage.setItem('remember', 'false');
      expect(getRememberPreference()).toBe(false);
    });
  });

  describe('setRememberPreference', () => {
    it('sets remember preference to true', () => {
      setRememberPreference(true);
      expect(localStorage.getItem('remember')).toBe('true');
    });

    it('sets remember preference to false', () => {
      setRememberPreference(false);
      expect(localStorage.getItem('remember')).toBe('false');
    });

    it('updates existing preference', () => {
      setRememberPreference(true);
      expect(getRememberPreference()).toBe(true);

      setRememberPreference(false);
      expect(getRememberPreference()).toBe(false);
    });
  });
});
