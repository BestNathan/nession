import { describe, expect, it } from 'vitest';
import { collectContextSignals, type CapabilityContextBinding } from '../../contextSignals';

/**
 * The context-sense seam (#1347 SC-37/40).
 *
 * What these pin is the *shape* of the protocol, not Terminal Keys' answers:
 * a capability reports context by contributing a binding, and the collector
 * aggregates whatever it is handed. That is what makes work-sensed and
 * context-sensed capabilities one protocol rather than two — the disclosure
 * renders both lists through the same rows and the same selection, so nothing
 * downstream may need to know which registry a signal came from.
 */
describe('collectContextSignals', () => {
  it('carries a binding it has never seen, by shape alone (SC-40)', () => {
    // The point of the seam: a capability the collector does not import — a
    // future plugin, or a test's invented one — flows through because it
    // satisfies `CapabilityContextBinding`. If this ever needs a change to
    // `contextSignals.ts` to pass, the seam has become a registry of names.
    const stranger: CapabilityContextBinding = {
      id: 'invented',
      sense: (context) =>
        context.sessionId === undefined
          ? null
          : { capabilityId: 'invented', summary: 'Invented for this test' },
    };

    expect(collectContextSignals({ sessionId: 's1' }, [stranger])).toEqual([
      { capabilityId: 'invented', summary: 'Invented for this test' },
    ]);
    // …and quiet is the absence of a signal, not an empty one: nothing is
    // pushed, so a surface that renders the list renders nothing for it.
    expect(collectContextSignals({}, [stranger])).toEqual([]);
    expect(collectContextSignals({ sessionId: 's1' }, [])).toEqual([]);
  });

  it('keeps registration order across several bindings', () => {
    const binding = (id: string): CapabilityContextBinding => ({
      id,
      sense: () => ({ capabilityId: id, summary: id }),
    });

    expect(collectContextSignals({}, [binding('a'), binding('b'), binding('c')])).toEqual([
      { capabilityId: 'a', summary: 'a' },
      { capabilityId: 'b', summary: 'b' },
      { capabilityId: 'c', summary: 'c' },
    ]);
  });

  it('senses Terminal Keys on App with a Session, and nowhere else (SC-37)', () => {
    // The shipped registry, through the default parameter — so this is what
    // production actually collects, not a fixture's list.
    expect(collectContextSignals({ experience: 'app', sessionId: 's1' })).toEqual([
      { capabilityId: 'terminal-keys', summary: 'Touch controls for Terminal' },
    ]);

    // Web has a physical keyboard, so the keys are optional rather than
    // relevant; App without a Session has nothing to type into; and a surface
    // that does not know which experience it is must not claim App.
    expect(collectContextSignals({ experience: 'web', sessionId: 's1' })).toEqual([]);
    expect(collectContextSignals({ experience: 'app' })).toEqual([]);
    expect(collectContextSignals({ sessionId: 's1' })).toEqual([]);
    expect(collectContextSignals({})).toEqual([]);
  });
});
