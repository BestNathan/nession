import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getToken, setToken, clearToken, getRememberPreference, setRememberPreference } from '../auth';

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
    });

    it('stores token in both storages when remember=true', () => {
      setToken('test-token', true);
      expect(sessionStorage.getItem('token')).toBe('test-token');
      expect(localStorage.getItem('token')).toBe('test-token');
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
