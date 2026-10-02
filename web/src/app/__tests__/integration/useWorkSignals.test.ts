import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useWorkSignals } from '@/app/useWorkSignals';
import type { Session } from '@/types';

function session(foregroundCommand: string | null): Session {
  return {
    session_id: 's1',
    session_name: 's1',
    agent_id: 'a1',
    foreground_command: foregroundCommand,
  } as Session;
}

describe('useWorkSignals (#1347 SC-14)', () => {
  it('is quiet without a session', () => {
    const { result } = renderHook(() => useWorkSignals(undefined));

    expect(result.current.status).toBe('quiet');
  });

  it('is working while the pane runs a Claude Code command (passive sensing)', () => {
    const { result } = renderHook(() => useWorkSignals(session('claude.exe')));

    expect(result.current.status).toBe('working');
    expect(result.current.summaries).toContainEqual(
      expect.objectContaining({ capabilityId: 'claude-code', status: 'working' }),
    );
  });

  it('is quiet when the pane runs an unrelated command', () => {
    const { result } = renderHook(() => useWorkSignals(session('bash')));

    expect(result.current.status).toBe('quiet');
  });

  it('follows the foreground command as it changes', () => {
    const { result, rerender } = renderHook(
      ({ command }: { command: string | null }) =>
        useWorkSignals(session(command)),
      { initialProps: { command: 'claude' as string | null } },
    );

    expect(result.current.status).toBe('working');

    rerender({ command: null });

    expect(result.current.status).toBe('quiet');
  });
});
