import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../../registry';
import type { CapabilityDefinition } from '../../model';

function definition(
  id: string,
  resolve: CapabilityDefinition['resolve'] = (context) => ({
    scope: {
      workspaceId: context.workspaceId,
      locationId: context.locationId,
      sessionId: context.sessionId,
    },
    state: 'available',
  }),
): CapabilityDefinition {
  return { id, title: id, resolve };
}

describe('CapabilityRegistry', () => {
  it('accepts open capability ids and resolves scoped snapshots', () => {
    const registry = new CapabilityRegistry();
    registry.register(definition('extension.example'));

    const first = registry.resolveAll({
      workspaceId: 'workspace-a',
      locationId: 'location-a',
      sessionId: 'session-a',
    });
    const second = registry.resolveAll({
      workspaceId: 'workspace-a',
      locationId: 'location-b',
      sessionId: 'session-b',
    });

    expect(first.diagnostics).toEqual([]);
    expect(first.snapshots[0]).toMatchObject({
      id: 'extension.example',
      scope: {
        workspaceId: 'workspace-a',
        locationId: 'location-a',
        sessionId: 'session-a',
      },
    });
    expect(second.snapshots[0].scope).toEqual({
      workspaceId: 'workspace-a',
      locationId: 'location-b',
      sessionId: 'session-b',
    });
  });

  it('rejects duplicate ids deterministically', () => {
    const registry = new CapabilityRegistry();
    registry.register(definition('files'));

    expect(() => registry.register(definition('files'))).toThrow(
      'Capability "files" is already registered',
    );
  });

  it('isolates provider resolution failures and reports a diagnostic', () => {
    const registry = new CapabilityRegistry();
    registry.register(definition('healthy'));
    registry.register(
      definition('broken', () => {
        throw new Error('missing provider state');
      }),
    );

    const result = registry.resolveAll({ sessionId: 'session-a' });

    expect(result.snapshots.map((snapshot) => snapshot.id)).toEqual(['healthy']);
    expect(result.diagnostics).toEqual([
      {
        capabilityId: 'broken',
        message:
          'Capability "broken" could not be resolved: missing provider state. Fix the provider or its input context.',
      },
    ]);
  });

  it('supports unregistering exactly the provider that registered the id', () => {
    const registry = new CapabilityRegistry();
    const dispose = registry.register(definition('temporary'));

    expect(registry.has('temporary')).toBe(true);
    dispose();
    expect(registry.has('temporary')).toBe(false);
  });
});
