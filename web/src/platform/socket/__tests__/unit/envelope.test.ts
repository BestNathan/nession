// not-protocol-file: this file pins the shared transport envelope, not a wire
// contract. Unknown names are deliberately valid here to prove the transport
// does not grow a protocol registry.
import { describe, expect, it } from 'vitest';
import { InvalidSocketEnvelopeError, parseSocketEnvelope } from '@/platform/socket/envelope';

function raw(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    msg_type: 'agent.ping',
    id: 'req-1',
    timestamp: 1_789_000_000_000,
    payload: { ok: true },
    ...overrides,
  });
}

describe('parseSocketEnvelope', () => {
  it('accepts a canonical envelope, preserving an unknown future wire', () => {
    expect(parseSocketEnvelope(raw({ msg_type: 'future.subject.event' }))).toEqual({
      msg_type: 'future.subject.event',
      id: 'req-1',
      timestamp: 1_789_000_000_000,
      payload: { ok: true },
    });
  });

  it('accepts payloads that are not objects (the envelope is generic)', () => {
    for (const payload of ['text', 7, null, [1, 2], false]) {
      expect(parseSocketEnvelope(raw({ payload })).payload).toEqual(payload);
    }
  });

  it.each([
    ['malformed JSON', '{not json', 'malformed-json'],
    ['a JSON primitive', '"just-a-string"', 'not-an-object'],
    ['JSON null', 'null', 'not-an-object'],
    ['a JSON array', '[]', 'not-an-object'],
    ['a missing msg_type', raw({ msg_type: undefined }), 'invalid-msg-type'],
    ['an empty msg_type', raw({ msg_type: '' }), 'invalid-msg-type'],
    ['a numeric msg_type', raw({ msg_type: 7 }), 'invalid-msg-type'],
    ['a missing id', raw({ id: undefined }), 'invalid-id'],
    ['an empty id', raw({ id: '' }), 'invalid-id'],
    ['a numeric id', raw({ id: 3 }), 'invalid-id'],
    ['a missing timestamp', raw({ timestamp: undefined }), 'invalid-timestamp'],
    ['a negative timestamp', raw({ timestamp: -1 }), 'invalid-timestamp'],
    ['a fractional timestamp', raw({ timestamp: 1.5 }), 'invalid-timestamp'],
    ['a string timestamp', raw({ timestamp: '1' }), 'invalid-timestamp'],
    ['a missing payload', raw({ payload: undefined }), 'missing-payload'],
  ])('rejects %s with %s', (_case, text, reason) => {
    let caught: unknown;
    try {
      parseSocketEnvelope(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidSocketEnvelopeError);
    expect((caught as InvalidSocketEnvelopeError).reason).toBe(reason);
  });

  it('never echoes the raw frame in its error', () => {
    const secret = 'super-secret-token-value';
    const text = JSON.stringify({
      msg_type: 'agent.ping',
      id: 'req-1',
      timestamp: 1,
      auth_token: secret,
    });

    let caught: unknown;
    try {
      parseSocketEnvelope(text);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(InvalidSocketEnvelopeError);
    expect(String(caught)).not.toContain(secret);
    expect(JSON.stringify(caught)).not.toContain(secret);
  });
});
