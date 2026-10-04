import { describe, expect, it } from 'vitest';
import {
  resolveTerminalKeysState,
  terminalKeysContext,
  terminalKeysProjection,
} from '../../terminalKeys';

/**
 * Terminal Keys' own answers (#1347 SC-37/38/39).
 *
 * The capsule's integration test walks the same path through the composed hook
 * (`sensedContext` on App and not on Web, `ownsInputFocus` on the projection).
 * What is here is the branches that path cannot reach — no Session, no
 * experience — plus the projection's static properties, which the composed
 * test reaches through the host and this one reads from the binding itself.
 */
describe('resolveTerminalKeysState', () => {
  it('is unavailable with nothing to type into', () => {
    // Not `available`: the entry offers what can be reached from where the user
    // already is, and there is no Terminal here to reach.
    expect(resolveTerminalKeysState({ experience: 'app' })).toBe('unavailable');
    expect(resolveTerminalKeysState({ experience: 'web' })).toBe('unavailable');
    expect(resolveTerminalKeysState({ sessionId: 's1' })).not.toBe('unavailable');
  });

  it('is relevant on App, which is the lifecycle word for earned presence (SC-37)', () => {
    expect(resolveTerminalKeysState({ sessionId: 's1', experience: 'app' })).toBe('relevant');
  });

  it('stays available on Web, where a keyboard makes the keys optional', () => {
    // The distinction the criterion rests on: Web *lists* them, App *senses*
    // them. Collapsing both to one state would either hide the keys on Web or
    // claim a keyboard-less device on the App.
    expect(resolveTerminalKeysState({ sessionId: 's1', experience: 'web' })).toBe('available');
  });

  it('treats an unknown experience as Web rather than guessing App', () => {
    expect(resolveTerminalKeysState({ sessionId: 's1' })).toBe('available');
  });
});

describe('terminalKeysContext (SC-37)', () => {
  it('senses App with a Session, and reports nothing anywhere else', () => {
    // `toEqual` is exact: a signal carries an id and one line of why, and no
    // status — the Work Ring reads work signals, so a context sense cannot light
    // it (SC-37, asserted where the ring is observable in
    // ContextDisclosure.test.tsx).
    expect(terminalKeysContext.sense({ experience: 'app', sessionId: 's1' })).toEqual({
      capabilityId: 'terminal-keys',
      summary: 'Touch controls for Terminal',
    });

    expect(terminalKeysContext.sense({ experience: 'web', sessionId: 's1' })).toBeNull();
    expect(terminalKeysContext.sense({ experience: 'app' })).toBeNull();
    expect(terminalKeysContext.sense({ sessionId: 's1' })).toBeNull();
    expect(terminalKeysContext.sense({})).toBeNull();
  });
});

describe('terminalKeysProjection (SC-38/39)', () => {
  it('is a Peek, and only a Peek — the accessory family stayed retired (SC-38)', () => {
    // `entry` used to say which Terminal depth the binding claimed, and the
    // accessory family was a third one (#1046, retired 2026-10-03). Both are
    // gone: there is one depth, so a binding has nothing to declare but its
    // body. Asserted as an absence on purpose — the axis was reintroduced once
    // already, and the field is what would bring its branch back with it.
    expect('entry' in terminalKeysProjection).toBe(false);
  });

  it('claims input focus while it is up (SC-39)', () => {
    // The capability's own statement about its Peek: the keys are tapped, and
    // the soft keyboard is the one thing that would cover the row being
    // reached for. Nession owns the shell and the dismissal; this flag is the
    // whole of what the capability says about the keyboard.
    expect(terminalKeysProjection.ownsInputFocus).toBe(true);
  });
});
