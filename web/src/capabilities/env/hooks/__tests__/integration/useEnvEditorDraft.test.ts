import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Agent, EnvFileInfo } from '@/types';
import { useEnvEditorDraft } from '@/capabilities/env/hooks/useEnvEditorDraft';
import type { EditorTarget } from '@/capabilities/env/hooks/useEnvironmentScreen';

function info(name: string, overrides: Partial<EnvFileInfo> = {}): EnvFileInfo {
  return { name, source: 'server', size: 5, modified: 0, var_count: 2, ...overrides };
}

function agent(overrides: Partial<Agent> = {}): Agent {
  return {
    agent_id: 'a1',
    hostname: 'devbox-01',
    ip_address: '10.0.0.1',
    port: 19090,
    status: 'online',
    ...overrides,
  } as Agent;
}

describe('useEnvEditorDraft — existing', () => {
  it('adopts the loaded source once and never clobbers edits on a reload', () => {
    const profile = info('a.env');
    const { result, rerender } = renderHook(
      ({ loaded }: { loaded: string | null }) =>
        useEnvEditorDraft({ kind: 'existing' }, profile, [], loaded),
      { initialProps: { loaded: null as string | null } },
    );
    expect(result.current.initialized).toBe(false);

    rerender({ loaded: 'A=1\n' });
    expect(result.current.content).toBe('A=1\n');
    expect(result.current.dirty).toBe(false);

    act(() => result.current.setContent('A=2\n'));
    expect(result.current.dirty).toBe(true);

    // A background reload landing mid-edit must not overwrite the draft.
    rerender({ loaded: 'A=3\n' });
    expect(result.current.content).toBe('A=2\n');
  });

  it('builds the ref from the profile, not from editable fields', () => {
    const profile = info('a.env', { source: 'agent', agent_id: 'a1' });
    const { result } = renderHook(() =>
      useEnvEditorDraft({ kind: 'existing' }, profile, [], 'x'),
    );
    expect(result.current.isNew).toBe(false);
    expect(result.current.buildRef()).toEqual({ name: 'a.env', source: 'agent', agent_id: 'a1' });
  });
});

describe('useEnvEditorDraft — new', () => {
  it('starts invalid until named, and appends .env when the name lacks it', () => {
    const { result } = renderHook(() =>
      useEnvEditorDraft({ kind: 'new' }, null, [], null),
    );
    expect(result.current.isNew).toBe(true);
    expect(result.current.nameValid).toBe(false);
    expect(result.current.source).toBe('server');

    act(() => result.current.setName('staging'));
    expect(result.current.nameValid).toBe(true);
    expect(result.current.dirty).toBe(true);
    expect(result.current.buildRef()).toEqual({
      name: 'staging.env',
      source: 'server',
      agent_id: undefined,
    });

    act(() => result.current.setName('staging.env'));
    expect(result.current.buildRef().name).toBe('staging.env');
  });

  it('requires an agent when the location is an agent', () => {
    const { result } = renderHook(() => useEnvEditorDraft({ kind: 'new' }, null, [], null));
    act(() => result.current.setName('x'));
    expect(result.current.locationValid).toBe(true);
    act(() => result.current.setSource('agent'));
    expect(result.current.locationValid).toBe(false);
    act(() => result.current.setAgentId('a1'));
    expect(result.current.locationValid).toBe(true);
    expect(result.current.buildRef().agent_id).toBe('a1');
  });

  it('defaults the agent to the first online agent', () => {
    const agents = [agent({ agent_id: 'off', status: 'offline' }), agent({ agent_id: 'a1' })];
    const { result } = renderHook(() => useEnvEditorDraft({ kind: 'new' }, null, agents, null));
    expect(result.current.agentId).toBe('a1');
  });
});

describe('useEnvEditorDraft — duplicate', () => {
  it('proposes a -copy name and inherits the source location', () => {
    const source = info('base.env', { source: 'agent', agent_id: 'a1' });
    const target: EditorTarget = { kind: 'duplicate', source };
    const { result } = renderHook(() =>
      useEnvEditorDraft(target, null, [agent()], 'B=2\n'),
    );
    expect(result.current.name).toBe('base-copy.env');
    expect(result.current.source).toBe('agent');
    expect(result.current.agentId).toBe('a1');
    expect(result.current.content).toBe('B=2\n');
    // Identical to what was proposed — not dirty until the user changes something.
    expect(result.current.dirty).toBe(false);
  });
});
