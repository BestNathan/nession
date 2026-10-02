import { describe, expect, it } from 'vitest';
import { Bot, Rocket } from 'lucide-react';
import {
  resolveConversationIdentity,
  type CapabilityConversationBinding,
} from '@/app/conversationIdentities';
import type { CapabilityFacts } from '@/product/capability';

function facts(foregroundCommand: string | null): CapabilityFacts {
  return { sessionForegroundCommand: foregroundCommand };
}

describe('resolveConversationIdentity (#1347 SC-25)', () => {
  it('resolves the claude-code identity while the pane runs Claude Code', () => {
    const identity = resolveConversationIdentity(facts('claude.exe'));

    expect(identity?.capabilityId).toBe('claude-code');
    expect(identity?.glyph).toBe(Bot);
  });

  it('resolves nothing when the pane runs an unrelated command', () => {
    expect(resolveConversationIdentity(facts('bash'))).toBeNull();
  });

  it('resolves nothing without facts', () => {
    expect(resolveConversationIdentity(undefined)).toBeNull();
  });
});

describe('resolveConversationIdentity — the seam, not the capability (#1347 SC-25)', () => {
  it('resolves a binding the registry has never seen, by shape rather than by name', () => {
    // Re-review #2 on #1347: a second conversational capability (Codex,
    // OpenCode) must project its identity without the shell learning its
    // name. This binding is not registered anywhere; if it flows through,
    // the seam is the contribution contract and not a Claude special case.
    const codex: CapabilityConversationBinding = {
      id: 'codex',
      sense: (input) =>
        input?.sessionForegroundCommand === 'codex'
          ? { capabilityId: 'codex', glyph: Rocket }
          : null,
    };

    const identity = resolveConversationIdentity(facts('codex'), [codex]);

    expect(identity).toEqual({ capabilityId: 'codex', glyph: Rocket });
  });

  it('treats a null sense result as quiet — idle capabilities project nothing', () => {
    const idle: CapabilityConversationBinding = { id: 'idle-one', sense: () => null };

    expect(resolveConversationIdentity(facts('bash'), [idle])).toBeNull();
  });

  it('the first live identity wins — one foreground owns the pane at a time', () => {
    const quiet: CapabilityConversationBinding = { id: 'quiet-one', sense: () => null };
    const live: CapabilityConversationBinding = {
      id: 'live-one',
      sense: () => ({ capabilityId: 'live-one', glyph: Rocket }),
    };
    const alsoLive: CapabilityConversationBinding = {
      id: 'live-two',
      sense: () => ({ capabilityId: 'live-two', glyph: Bot }),
    };

    const identity = resolveConversationIdentity(undefined, [quiet, live, alsoLive]);

    expect(identity?.capabilityId).toBe('live-one');
  });
});
