// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { normalizeHashRouterLocation } from '@/lib/hashRouterUrl';

describe('normalizeHashRouterLocation', () => {
  const replace = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('location', {
      origin: 'http://staging.nession.nhome.local',
      pathname: '/',
      hash: '',
      replace,
    });
    replace.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('no-ops when pathname is root', () => {
    normalizeHashRouterLocation();
    expect(replace).not.toHaveBeenCalled();
  });

  it('redirects bogus pathname to hash root', () => {
    vi.stubGlobal('location', {
      origin: 'http://staging.nession.nhome.local',
      pathname: '/login',
      hash: '',
      replace,
    });
    normalizeHashRouterLocation();
    expect(replace).toHaveBeenCalledWith('http://staging.nession.nhome.local/#/');
  });

  it('preserves an existing hash route when stripping pathname', () => {
    vi.stubGlobal('location', {
      origin: 'http://staging.nession.nhome.local',
      pathname: '/login',
      hash: '#/terminal/agent-1%3As1',
      replace,
    });
    normalizeHashRouterLocation();
    expect(replace).toHaveBeenCalledWith(
      'http://staging.nession.nhome.local/#/terminal/agent-1%3As1',
    );
  });
});
