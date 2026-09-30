import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptView } from '../../TranscriptView';
import type { TranscriptsListState } from '../../../hooks/useTranscripts';
import type { TranscriptItemsState } from '../../../hooks/useTranscriptItems';
import type { ClaudeCodeTranscriptItem } from '../../../types';

/**
 * What a row says when Claude never titled the transcript.
 *
 * A subagent has no `ai-title` record — that is a session-level fact — so its
 * row falls back to an id. The provider's id for one is *path-shaped*:
 * `<session-uuid>/agent-<id>`. Rendered whole behind `truncate`, the part that
 * distinguishes one subagent from another is the part that gets cut off first,
 * leaving a row that looks identical to its parent's and to its siblings'.
 *
 * `agent_id` exists on the contract for exactly this ("the subagent's own id,
 * for a sidechain"), so the fallback uses it.
 */

function transcript(overrides: Partial<ClaudeCodeTranscriptItem>): ClaudeCodeTranscriptItem {
  return {
    id: 'a1b2c3d4-0000-4000-8000-000000000001',
    cwd: '/work',
    kind: 'primary',
    parent_id: null,
    agent_id: null,
    title: null,
    preview: null,
    created_at: null,
    updated_at: '2026-09-30T10:00:00.000Z',
    ...overrides,
  };
}

function list(transcripts: ClaudeCodeTranscriptItem[]): TranscriptsListState {
  return { state: 'ready', transcripts, binding: null, loading: false, error: null };
}

const items: TranscriptItemsState = {
  state: 'ready',
  transcript: null,
  activity: null,
  items: [],
  hasMore: false,
  partialTail: false,
  stats: null,
  loading: false,
  loadingOlder: false,
  error: null,
};

function rows(): string[] {
  return screen.getAllByTestId('transcript-open').map((row) => row.textContent ?? '');
}

function renderList(transcripts: ClaudeCodeTranscriptItem[]) {
  render(
    <TranscriptView
      list={list(transcripts)}
      items={items}
      open={null}
      layout="master-detail"
      onSelect={vi.fn()}
      onLoadOlder={vi.fn()}
      onBack={vi.fn()}
    />,
  );
}

describe('TranscriptView row labels', () => {
  it('labels a titled transcript by its title', () => {
    renderList([transcript({ title: 'Transcript execution view' })]);
    expect(rows()[0]).toContain('Transcript execution view');
  });

  it('labels an untitled subagent by its agent id, not its path-shaped id', () => {
    renderList([
      transcript({
        kind: 'sidechain',
        parent_id: 'a1b2c3d4-0000-4000-8000-000000000001',
        agent_id: 'agent-a11ce',
        id: 'a1b2c3d4-0000-4000-8000-000000000001/agent-a11ce',
      }),
    ]);
    expect(rows()[0]).toContain('agent-a11ce');
    expect(rows()[0]).not.toContain('a1b2c3d4-0000-4000-8000-000000000001/agent-a11ce');
  });

  it('still marks the subagent as one', () => {
    renderList([
      transcript({ kind: 'sidechain', agent_id: 'agent-a11ce', id: 'sess/agent-a11ce' }),
    ]);
    expect(screen.getByTestId('transcript-sidechain')).toBeTruthy();
  });

  // The counterexample that keeps the rule honest: a *primary* transcript with
  // no title has no agent id to fall back to, and inventing one would be worse
  // than showing the id it actually has.
  it('falls back to the id for an untitled primary transcript', () => {
    renderList([transcript({ id: 'a1b2c3d4-0000-4000-8000-000000000001' })]);
    expect(rows()[0]).toContain('a1b2c3d4-0000-4000-8000-000000000001');
  });

  it('prefers a title over the agent id when Claude wrote one', () => {
    renderList([transcript({ kind: 'sidechain', agent_id: 'agent-a11ce', title: 'Explore the repo' })]);
    expect(rows()[0]).toContain('Explore the repo');
  });
});
