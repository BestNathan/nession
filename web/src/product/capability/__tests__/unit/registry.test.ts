import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_COMPACT_TITLE_MAX_GRAPHEMES,
  countCapabilityTitleGraphemes,
  resolveCapabilityCompactTitle,
} from '../../identity';
import { CapabilityRegistry } from '../../registry';
import type { CapabilityDefinition } from '../../model';

interface DefinitionOptions {
  title?: string;
  shortTitle?: string;
  resolve?: CapabilityDefinition['resolve'];
}

function definition(
  id: string,
  {
    title = id,
    shortTitle,
    resolve = (context) => ({
      scope: {
        workspaceId: context.workspaceId,
        locationId: context.locationId,
        sessionId: context.sessionId,
      },
      state: 'available',
    }),
  }: DefinitionOptions = {},
): CapabilityDefinition {
  return {
    id,
    title,
    ...(shortTitle === undefined ? {} : { shortTitle }),
    resolve,
  };
}

describe('CapabilityRegistry', () => {
  it('accepts open capability ids and resolves scoped snapshots', () => {
    const registry = new CapabilityRegistry();
    registry.register(definition('extension.example', { title: 'Example' }));

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
      title: 'Example',
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
      definition('broken', {
        resolve: () => {
          throw new Error('missing provider state');
        },
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
    const dispose = registry.register(definition('temp', { title: 'Temporary', shortTitle: 'Temp' }));

    expect(registry.has('temp')).toBe(true);
    dispose();
    expect(registry.has('temp')).toBe(false);
  });

  it('uses the full title directly when it fits the compact identity limit', () => {
    const registry = new CapabilityRegistry();
    registry.register(definition('files', { title: 'Files' }));

    const snapshot = registry.resolveAll({}).snapshots[0];

    expect(snapshot.shortTitle).toBeUndefined();
    expect(resolveCapabilityCompactTitle(snapshot)).toBe('Files');
  });

  it('requires a capability-owned shortTitle when the full title exceeds eight graphemes', () => {
    const registry = new CapabilityRegistry();

    expect(() =>
      registry.register(definition('env', { title: 'Environment' })),
    ).toThrow(
      'Capability "env" title "Environment" is 11 graphemes; add shortTitle with at most 8 graphemes.',
    );
  });

  it('rejects a shortTitle longer than the compact identity limit', () => {
    const registry = new CapabilityRegistry();

    expect(() =>
      registry.register(
        definition('env', {
          title: 'Environment',
          shortTitle: 'EnvConfig',
        }),
      ),
    ).toThrow(
      `Capability "env" shortTitle "EnvConfig" is 9 graphemes; shorten it to at most ${CAPABILITY_COMPACT_TITLE_MAX_GRAPHEMES} graphemes.`,
    );
  });

  it('preserves full and compact identity separately in resolved snapshots', () => {
    const registry = new CapabilityRegistry();
    registry.register(
      definition('env', {
        title: 'Environment',
        shortTitle: 'Env',
      }),
    );

    const snapshot = registry.resolveAll({}).snapshots[0];

    expect(snapshot.title).toBe('Environment');
    expect(snapshot.shortTitle).toBe('Env');
    expect(resolveCapabilityCompactTitle(snapshot)).toBe('Env');
  });

  it('counts user-visible grapheme clusters instead of UTF-16 code units', () => {
    const family = '👨‍👩‍👧‍👦';
    const composed = 'e\u0301';

    expect(family.length).toBeGreaterThan(1);
    expect(composed.length).toBe(2);
    expect(countCapabilityTitleGraphemes(family)).toBe(1);
    expect(countCapabilityTitleGraphemes(composed)).toBe(1);

    const exactlyEight = `${family}界界界界界界界`;
    const registry = new CapabilityRegistry();

    expect(countCapabilityTitleGraphemes(exactlyEight)).toBe(8);
    expect(() =>
      registry.register(definition('unicode', { title: exactlyEight })),
    ).not.toThrow();
  });

  it('rejects an empty declared shortTitle instead of rendering blank compact identity', () => {
    const registry = new CapabilityRegistry();

    expect(() =>
      registry.register(
        definition('env', {
          title: 'Environment',
          shortTitle: '',
        }),
      ),
    ).toThrow('Capability "env" shortTitle is empty');
  });
});
