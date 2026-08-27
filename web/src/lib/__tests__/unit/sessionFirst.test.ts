// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isSessionFirst, setSessionFirst } from '@/lib/sessionFirst';

const KEY = 'nession_session_first';

describe('sessionFirst', () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    localStorage.clear();
    window.history.replaceState({}, '', '/');
  });

  it('defaults off when query and storage are empty', () => {
    expect(isSessionFirst()).toBe(false);
  });

  it('reads localStorage 1', () => {
    localStorage.setItem(KEY, '1');
    expect(isSessionFirst()).toBe(true);
  });

  it('query session_first=1 wins and writes storage', () => {
    window.history.replaceState({}, '', '/?session_first=1');
    expect(isSessionFirst()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe('1');
  });

  it('query session_first=0 forces legacy and writes storage', () => {
    localStorage.setItem(KEY, '1');
    window.history.replaceState({}, '', '/?session_first=0');
    expect(isSessionFirst()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe('0');
  });

  it('setSessionFirst writes storage', () => {
    setSessionFirst(true);
    expect(localStorage.getItem(KEY)).toBe('1');
    expect(isSessionFirst()).toBe(true);
    setSessionFirst(false);
    expect(localStorage.getItem(KEY)).toBe('0');
    expect(isSessionFirst()).toBe(false);
  });
});
