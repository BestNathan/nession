import { describe, it, expect } from 'vitest';
import { buildAgentWsUrl } from '@/shared/lib/agentWsUrl';

/**
 * The one place a P2P credential reaches an agent URL from the browser.
 *
 * It had no test until #1013 stage 2, which is how it and the Rust side came to
 * disagree: the Server and the CLI each grew their own copy of this rule and the
 * copies already differed. This file pins the shared convention from the third
 * language, so a change to any one of them is a visible decision rather than a
 * silent drift.
 *
 * It moved here with the function in #1091, when the address probe became its
 * second consumer — and a `shared` consumer is what makes `shared` its home.
 */
describe('buildAgentWsUrl', () => {
  it('appends the credential as the token parameter', () => {
    expect(buildAgentWsUrl('ws://agent.example.com/ws', 'abc')).toBe(
      'ws://agent.example.com/ws?token=abc',
    );
  });

  it('joins with an ampersand when the URL already has a query', () => {
    expect(buildAgentWsUrl('ws://agent.example.com/ws?x=1', 'abc')).toBe(
      'ws://agent.example.com/ws?x=1&token=abc',
    );
  });

  /**
   * A URL with no path gets one, because a query cannot be appended without it.
   *
   * `ws://host:port` is a working agent URL — an absolute URI with an empty path
   * implies `/` — and it stops working the moment a query is put on it: the
   * request target becomes `?token=abc`, which is not origin-form, so the server
   * drops the connection during the handshake and the browser reports a failed
   * connection with nothing in it about the URL.
   *
   * Reachable without doing anything unusual: `connect_url` is an agent config
   * field documented as the public URL clients dial, and a tunnel endpoint
   * written without a path is exactly the `wss://host` shape.
   */
  it('gives a URL with no path one before the query', () => {
    expect(buildAgentWsUrl('wss://tunnel.example.com', 'abc')).toBe(
      'wss://tunnel.example.com/?token=abc',
    );
  });

  it('adds no parameter when there is no credential', () => {
    expect(buildAgentWsUrl('ws://agent.example.com/ws')).toBe('ws://agent.example.com/ws');
    expect(buildAgentWsUrl('ws://agent.example.com/ws', '')).toBe('ws://agent.example.com/ws');
  });

  it('escapes a credential that needs it', () => {
    expect(buildAgentWsUrl('ws://a/ws', 'a+b/c')).toBe('ws://a/ws?token=a%2Bb%2Fc');
  });
});
