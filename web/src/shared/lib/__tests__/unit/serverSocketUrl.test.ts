import { describe, expect, it } from 'vitest';
import { deriveServerSocketUrl } from '../../serverSocketUrl';

// #4588 SC-02: the client derives its WebSocket scheme from the page's own
// protocol. HTTPS pages (the canonical bestnathan.top hosts) must always derive
// wss — never a cleartext downgrade — while the preserved nhome.local HTTP LAN
// behavior keeps ws. The host is carried verbatim, with no hardcoded hostname.
describe('deriveServerSocketUrl', () => {
  it('derives wss for every canonical HTTPS host', () => {
    for (const host of [
      'nession.bestnathan.top',
      'ui-nession.bestnathan.top',
      'staging-nession.bestnathan.top',
      'staging-ui-nession.bestnathan.top',
      'staging-01-nession.bestnathan.top',
      'preprod-nession.bestnathan.top',
    ]) {
      expect(deriveServerSocketUrl('https:', host)).toBe(`wss://${host}/ws`);
    }
  });

  it('never downgrades an HTTPS page to cleartext ws', () => {
    const url = deriveServerSocketUrl('https:', 'staging-nession.bestnathan.top');
    expect(url.startsWith('wss://')).toBe(true);
    expect(url.startsWith('ws://')).toBe(false);
  });

  it('preserves the nhome.local HTTP LAN behavior', () => {
    expect(deriveServerSocketUrl('http:', 'staging.nession.nhome.local')).toBe(
      'ws://staging.nession.nhome.local/ws',
    );
    expect(deriveServerSocketUrl('http:', 'nession.nhome.local')).toBe(
      'ws://nession.nhome.local/ws',
    );
  });

  it('carries the host and port verbatim', () => {
    expect(deriveServerSocketUrl('https:', 'ui-nession.bestnathan.top:8443')).toBe(
      'wss://ui-nession.bestnathan.top:8443/ws',
    );
    expect(deriveServerSocketUrl('http:', 'localhost:13000')).toBe(
      'ws://localhost:13000/ws',
    );
  });
});
