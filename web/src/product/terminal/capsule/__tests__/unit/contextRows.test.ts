import { describe, expect, it } from 'vitest';
import { GitBranch } from 'lucide-react';
import { resolveContextRows, sensedWorkItems } from '../../contextRows';
import type { CapsuleCapabilityEntry, SensedCapabilityItem } from '../../types';
import type { ResolvedWorkContext } from '../../workAwareness';

function entry(id: string, title = id): CapsuleCapabilityEntry {
  return { id, title, state: 'available', icon: GitBranch };
}

function sensed(id: string, reason: string): SensedCapabilityItem {
  return { capabilityId: id, title: id, icon: GitBranch, reason };
}

const ENTRIES: readonly CapsuleCapabilityEntry[] = [
  entry('claude-code', 'Claude Code'),
  entry('git', 'Git'),
  entry('files', 'Files'),
  entry('session', 'Session'),
];

describe('resolveContextRows', () => {
  it('orders work first, then context, then the catalog', () => {
    const rows = resolveContextRows(
      [sensed('git', 'Running pre-commit')],
      [sensed('terminal-keys', 'Touch controls for Terminal')],
      ENTRIES,
    );

    expect(rows.map((row) => [row.capabilityId, row.kind])).toEqual([
      ['git', 'work'],
      ['terminal-keys', 'context'],
      // …then everything the senses did not claim, in the registry's own order.
      ['claude-code', 'ordinary'],
      ['files', 'ordinary'],
      ['session', 'ordinary'],
    ]);
  });

  it('shows a sensed capability once, not again in the catalog', () => {
    // The bug a flat list introduces: sensing adds presence, it does not remove
    // the registry entry, so rendering both groups in one column shows the same
    // capability twice — once with its reason, once without. The repo's
    // two-layer disclosure never had to think about it, because the catalog
    // lived in a submenu.
    const rows = resolveContextRows([sensed('claude-code', 'Working in this Session')], [], ENTRIES);

    expect(rows.filter((row) => row.capabilityId === 'claude-code')).toHaveLength(1);
    expect(rows[0]).toMatchObject({ capabilityId: 'claude-code', kind: 'work' });
  });

  it('keeps one row when a capability is somehow sensed both ways', () => {
    // `terminalKeysContext` and the work registry promise a capability is one or
    // the other; if that ever breaks, the stronger claim wins rather than the
    // list showing the id twice.
    const rows = resolveContextRows(
      [sensed('git', 'Running pre-commit')],
      [sensed('git', 'Touch controls for Terminal')],
      ENTRIES,
    );

    const git = rows.filter((row) => row.capabilityId === 'git');
    expect(git).toHaveLength(1);
    expect(git[0]).toMatchObject({ kind: 'work', reason: 'Running pre-commit' });
  });

  it('carries the entry’s display identity onto the ordinary row', () => {
    const rows = resolveContextRows([], [], ENTRIES);

    expect(rows[0]).toMatchObject({ capabilityId: 'claude-code', title: 'Claude Code' });
    // An ordinary row says what it is and nothing about why — the reason line is
    // the sensed half's, and its absence is what keeps the two halves legible.
    expect(rows[0].reason).toBeUndefined();
  });

  it('is empty when there is nothing to show', () => {
    expect(resolveContextRows([], [], [])).toEqual([]);
  });
});

describe('sensedWorkItems', () => {
  const context: ResolvedWorkContext = {
    status: 'working',
    summaries: [
      { capabilityId: 'claude-code', status: 'working', summary: 'Working in this Session' },
      { capabilityId: 'git', status: 'quiet', summary: 'Nothing to commit' },
      { capabilityId: 'not-registered', status: 'working', summary: 'Working on something' },
    ],
  };

  it('keeps working summaries that have an entry, and drops the rest', () => {
    expect(sensedWorkItems(context, ENTRIES)).toEqual([
      {
        capabilityId: 'claude-code',
        title: 'Claude Code',
        icon: GitBranch,
        reason: 'Working in this Session',
      },
    ]);
    // `git` is quiet (the ring is not lit for it), and `not-registered` has no
    // entry to take a title from — an id is not product copy (SC-19).
  });

  it('is empty while nothing is working', () => {
    expect(sensedWorkItems(undefined, ENTRIES)).toEqual([]);
    expect(sensedWorkItems({ status: 'quiet', summaries: [] }, ENTRIES)).toEqual([]);
  });
});
