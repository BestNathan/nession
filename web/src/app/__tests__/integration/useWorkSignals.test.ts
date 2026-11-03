import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useWorkSignals } from '@/app/useWorkSignals';
import { collectWorkSignals, type CapabilityWorkBinding } from '@/app/workSignals';
import type { CapabilityFacts } from '@/product/capability';

function facts(foregroundCommand: string | null): CapabilityFacts {
  return { sessionForegroundCommand: foregroundCommand };
}

describe('useWorkSignals (#1347 SC-14)', () => {
  it('is quiet without facts', () => {
    const { result } = renderHook(() => useWorkSignals(undefined));

    expect(result.current.status).toBe('quiet');
  });

  it('stays quiet while the pane runs a Claude Code command (#2663)', () => {
    // A foreground `claude`/`claude.exe` proves the CLI is OPEN, not that a
    // task is running. The owner rejected the old Work Ring and the false
    // "Working in this session" claim it was fed by this observation.
    const { result } = renderHook(() => useWorkSignals(facts('claude.exe')));

    expect(result.current.status).toBe('quiet');
    expect(result.current.summaries).toEqual([]);
    // The production binding list contributes nothing from process presence.
    expect(collectWorkSignals(facts('claude.exe'))).toEqual([]);
  });

  it('is quiet when the pane runs an unrelated command', () => {
    const { result } = renderHook(() => useWorkSignals(facts('bash')));

    expect(result.current.status).toBe('quiet');
  });

  it('stays quiet as the foreground command changes', () => {
    const { result, rerender } = renderHook(
      ({ command }: { command: string | null }) => useWorkSignals(facts(command)),
      { initialProps: { command: 'claude' as string | null } },
    );

    expect(result.current.status).toBe('quiet');

    rerender({ command: null });

    expect(result.current.status).toBe('quiet');
  });
});

describe('collectWorkSignals — the seam, not the capability (#1347 SC-14/19)', () => {
  it('aggregates a binding the collector has never seen, by shape rather than by name', () => {
    // Re-review #2 on #1347: a second capability must be able to report work
    // without the shell learning its name. This binding is not registered
    // anywhere; if it flows through, the seam is the contribution contract and
    // not a Claude special case.
    const secondCapability: CapabilityWorkBinding = {
      id: 'codex',
      sense: (input) =>
        input?.sessionForegroundCommand === 'codex'
          ? { capabilityId: 'codex', status: 'working', summary: 'Codex is running' }
          : null,
    };

    const signals = collectWorkSignals(facts('codex'), [secondCapability]);

    expect(signals).toEqual([
      { capabilityId: 'codex', status: 'working', summary: 'Codex is running' },
    ]);
  });

  it('treats a null sense result as quiet — idle capabilities emit nothing', () => {
    const idle: CapabilityWorkBinding = { id: 'idle-one', sense: () => null };

    expect(collectWorkSignals(facts('bash'), [idle])).toEqual([]);
  });

  it('collects from more than one contribution into one signal list', () => {
    const working: CapabilityWorkBinding = {
      id: 'one',
      sense: () => ({ capabilityId: 'one', status: 'working', summary: 'one at work' }),
    };
    const alsoWorking: CapabilityWorkBinding = {
      id: 'two',
      sense: () => ({ capabilityId: 'two', status: 'working', summary: 'two at work' }),
    };

    const signals = collectWorkSignals(undefined, [working, alsoWorking]);

    expect(signals.map((signal) => signal.capabilityId)).toEqual(['one', 'two']);
  });
});
