import { StrictMode } from 'react';
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  useBootstrapTokenConsumption,
  withoutBootstrapToken,
} from '../../useBootstrapToken';

function setUrl(url: string): void {
  window.history.replaceState({}, '', url);
}

afterEach(() => {
  setUrl('/');
});

describe('withoutBootstrapToken', () => {
  it('removes only token and preserves path, other query parameters and hash', () => {
    expect(withoutBootstrapToken(
      'https://app.test/workspace?token=secret&server_url=ws%3A%2F%2Fhost%2Fws&keep=1#/sessions/one',
    )).toBe(
      '/workspace?server_url=ws%3A%2F%2Fhost%2Fws&keep=1#/sessions/one',
    );
  });

  it('removes every repeated token parameter without touching unrelated ones', () => {
    expect(withoutBootstrapToken('https://app.test/?token=one&keep=1&token=two#/x')).toBe(
      '/?keep=1#/x',
    );
  });

  it('returns the original URL when no token is present', () => {
    const href = 'https://app.test/?server_url=ws%3A%2F%2Fhost%2Fws#/sessions/one';
    expect(withoutBootstrapToken(href)).toBe(href);
  });
});

describe('useBootstrapTokenConsumption', () => {
  it('consumes the token once before the handshake outcome is known', () => {
    setUrl('/?token=secret&server_url=ws%3A%2F%2Flocalhost%3A19090%2Fws&keep=1#/sessions/one');

    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );
    const { rerender } = renderHook(() => useBootstrapTokenConsumption(), { wrapper });

    expect(window.location.search).not.toContain('token');
    expect(window.location.search).toContain('server_url=');
    expect(window.location.search).toContain('keep=1');
    expect(window.location.hash).toBe('#/sessions/one');
    expect(window.location.href).not.toContain('secret');

    rerender();
    expect(window.location.search).not.toContain('token');
    expect(window.location.hash).toBe('#/sessions/one');
  });

  it('leaves a URL without a bootstrap token untouched', () => {
    setUrl('/workspace?keep=1#/sessions/one');
    renderHook(() => useBootstrapTokenConsumption());
    expect(window.location.search).toBe('?keep=1');
    expect(window.location.hash).toBe('#/sessions/one');
  });
});
