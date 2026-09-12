import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSessionCapabilityFacts } from '@/app/useSessionCapabilityFacts';
import type { Session } from '@/types';

function session(id: string, command: string | null): Session {
  return {
    session_id: id,
    agent_id: 'a1',
    session_name: id,
    status: 'active',
    window_count: 1,
    attached_clients: 0,
    last_activity: '2026-01-01T00:00:00Z',
    foreground_command: command,
  } as Session;
}

describe('useSessionCapabilityFacts', () => {
  it('reports no facts without a session', () => {
    const { result } = renderHook(
      ({ current }: { current: Session | null }) => useSessionCapabilityFacts(current),
      { initialProps: { current: null as Session | null } },
    );
    expect(result.current).toBeUndefined();
  });

  it('reports the session foreground command', () => {
    const { result } = renderHook(
      ({ current }: { current: Session | null }) => useSessionCapabilityFacts(current),
      { initialProps: { current: session('a1:work', 'claude') as Session | null } },
    );
    expect(result.current?.sessionForegroundCommand).toBe('claude');
  });

  it('remembers commands seen earlier in the same session', () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: Session | null }) => useSessionCapabilityFacts(current),
      { initialProps: { current: session('a1:work', 'claude') as Session | null } },
    );
    rerender({ current: session('a1:work', 'bash') });
    expect(result.current?.sessionObservedCommands).toEqual(['claude', 'bash']);
  });

  it('does not carry one session history into another', () => {
    const { result, rerender } = renderHook(
      ({ current }: { current: Session | null }) => useSessionCapabilityFacts(current),
      { initialProps: { current: session('a1:work', 'claude') as Session | null } },
    );
    rerender({ current: session('a1:other', 'bash') });
    expect(result.current?.sessionObservedCommands).toEqual(['bash']);
  });
});
