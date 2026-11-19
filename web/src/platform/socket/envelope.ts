import type { InvalidEnvelopeReason, SocketMessage } from './types';

/**
 * A text frame that is not a canonical transport envelope (#4070).
 *
 * The reason is a bounded classification, never the frame body: diagnostics
 * and `onError` consumers may log this, so it must not carry a raw payload,
 * token or URL. Per-Protocol payload validation stays with the owning
 * `TransportPlugin`; this error only says the shared envelope is unreadable.
 */
export class InvalidSocketEnvelopeError extends Error {
  constructor(readonly reason: InvalidEnvelopeReason) {
    super(`Invalid socket envelope: ${reason}`);
    this.name = 'InvalidSocketEnvelopeError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate and project one inbound text frame into the shared envelope.
 *
 * The envelope is the only contract the generic transport owns: a wire name
 * (`msg_type`), a correlation id, a sender timestamp and a payload container.
 * Unknown wire names and non-object payloads are deliberately valid — a
 * notification's body is its own contract, and rejecting an unrecognized wire
 * name here would be a protocol registry inside the transport.
 *
 * Throws {@link InvalidSocketEnvelopeError} before any router state is
 * touched, so a malformed frame can neither settle a pending request nor
 * reach subscribers.
 */
export function parseSocketEnvelope(raw: string): SocketMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidSocketEnvelopeError('malformed-json');
  }

  if (!isRecord(parsed)) {
    throw new InvalidSocketEnvelopeError('not-an-object');
  }
  if (typeof parsed.msg_type !== 'string' || parsed.msg_type.length === 0) {
    throw new InvalidSocketEnvelopeError('invalid-msg-type');
  }
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
    throw new InvalidSocketEnvelopeError('invalid-id');
  }
  // The canonical envelope carries milliseconds since the Unix epoch as a
  // `u64`; a safe non-negative integer is the faithful JavaScript projection.
  if (
    typeof parsed.timestamp !== 'number'
    || !Number.isSafeInteger(parsed.timestamp)
    || parsed.timestamp < 0
  ) {
    throw new InvalidSocketEnvelopeError('invalid-timestamp');
  }
  // `payload` is a required container. Its contents are not the transport's
  // contract; `null`, arrays and primitives are all valid wire payloads.
  if (!Object.prototype.hasOwnProperty.call(parsed, 'payload')) {
    throw new InvalidSocketEnvelopeError('missing-payload');
  }

  return {
    msg_type: parsed.msg_type,
    id: parsed.id,
    timestamp: parsed.timestamp,
    payload: parsed.payload,
  };
}
