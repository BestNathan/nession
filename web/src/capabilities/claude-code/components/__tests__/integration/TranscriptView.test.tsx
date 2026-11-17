import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptView } from '../../TranscriptView';
import type { TranscriptsListState } from '../../../hooks/useTranscripts';
import type { TranscriptRecordsState } from '../../../hooks/useTranscriptRecords';
import type {
  ClaudeCodeTranscriptItem,
  ClaudeCodeTranscriptRecord,
} from '../../../types';

vi.mock('../../../ClaudeCodePlugin', () => ({
  claudeCodeApi: {
    claudeCodeTranscriptRecord: vi.fn(),
  },
}));

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

function state(
  records: ClaudeCodeTranscriptRecord[],
  overrides: Partial<TranscriptRecordsState> = {},
): TranscriptRecordsState {
  return {
    state: 'ready',
    transcript: null,
    activity: null,
    records,
    hasMore: false,
    partialTail: false,
    loading: false,
    loadingOlder: false,
    error: null,
    ...overrides,
  };
}

function wire(ref: string, value: unknown): ClaudeCodeTranscriptRecord {
  const raw = JSON.stringify(value);
  return { record_ref: ref, offset: 0, size_bytes: raw.length, raw };
}

const VALID = wire('r1', {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'a readable answer' }],
  },
});
const MALFORMED: ClaudeCodeTranscriptRecord = {
  record_ref: 'r2',
  offset: 20,
  size_bytes: 14,
  raw: 'not json at all',
};

const EMPTY = state([]);

function rows(): string[] {
  return screen.getAllByTestId('transcript-open').map((row) => row.textContent ?? '');
}

function renderView({
  transcripts = [transcript({ title: 'Transcript execution view' })],
  records = EMPTY,
  open = null,
  layout = 'master-detail',
  onSelect = vi.fn(),
  onLoadOlder = vi.fn(),
  onReload = vi.fn(),
  onBack = vi.fn(),
}: {
  transcripts?: ClaudeCodeTranscriptItem[];
  records?: TranscriptRecordsState;
  open?: string | null;
  layout?: 'master-detail' | 'push';
  onSelect?: () => void;
  onLoadOlder?: () => void;
  onReload?: () => void;
  onBack?: () => void;
} = {}) {
  return render(
    <TranscriptView
      list={list(transcripts)}
      records={records}
      open={open}
      layout={layout}
      agentId="a1"
      sessionId="a1:work"
      onSelect={onSelect}
      onLoadOlder={onLoadOlder}
      onReload={onReload}
      onBack={onBack}
    />,
  );
}

describe('TranscriptView row labels', () => {
  it('labels a titled transcript by its title', () => {
    renderView();
    expect(rows()[0]).toContain('Transcript execution view');
  });

  it('labels an untitled subagent by its agent id, not its path-shaped id', () => {
    renderView({
      transcripts: [
        transcript({
          kind: 'sidechain',
          parent_id: 'a1b2c3d4-0000-4000-8000-000000000001',
          agent_id: 'agent-a11ce',
          id: 'a1b2c3d4-0000-4000-8000-000000000001/agent-a11ce',
        }),
      ],
    });
    expect(rows()[0]).toContain('agent-a11ce');
    expect(rows()[0]).not.toContain('a1b2c3d4-0000-4000-8000-000000000001/agent-a11ce');
  });

  it('still marks the subagent as one', () => {
    renderView({
      transcripts: [
        transcript({ kind: 'sidechain', agent_id: 'agent-a11ce', id: 'sess/agent-a11ce' }),
      ],
    });
    expect(screen.getByTestId('transcript-sidechain')).toBeTruthy();
  });

  it('falls back to the id for an untitled primary transcript', () => {
    renderView({
      transcripts: [transcript({ id: 'a1b2c3d4-0000-4000-8000-000000000001' })],
    });
    expect(rows()[0]).toContain('a1b2c3d4-0000-4000-8000-000000000001');
  });

  it('prefers a title over the agent id when Claude wrote one', () => {
    renderView({
      transcripts: [
        transcript({ kind: 'sidechain', agent_id: 'agent-a11ce', title: 'Explore the repo' }),
      ],
    });
    expect(rows()[0]).toContain('Explore the repo');
  });
});

describe('TranscriptView record interaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('expands a row in place on Web and keeps its Raw action separate', () => {
    renderView({ records: state([VALID]), open: 't1' });

    fireEvent.click(screen.getByTestId('transcript-record-open'));
    expect(screen.getByTestId('transcript-record-detail')).toBeTruthy();

    fireEvent.click(screen.getByTestId('transcript-raw-open'));
    expect(screen.getByTestId('transcript-raw-inspector')).toBeTruthy();
    expect(screen.getByTestId('transcript-raw-drawer')).toBeTruthy();
    // The drawer does not unmount the timeline behind it.
    expect(screen.getByTestId('transcript-timeline')).toBeTruthy();
  });

  it('shows a JSON tree and the original text for a valid record', () => {
    renderView({ records: state([VALID]), open: 't1' });
    fireEvent.click(screen.getByTestId('transcript-raw-open'));

    expect(screen.getByTestId('transcript-raw-tree')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Original text' }));
    expect(screen.getByTestId('transcript-raw-text').textContent).toBe(VALID.raw);
  });

  it('shows only the original text for a malformed record', () => {
    renderView({ records: state([MALFORMED]), open: 't1' });
    fireEvent.click(screen.getByTestId('transcript-raw-open'));

    expect(screen.queryByRole('tab', { name: 'Tree' })).toBeNull();
    expect(screen.getByTestId('transcript-raw-text').textContent).toBe(MALFORMED.raw);
  });

  it('closes the Raw drawer without touching the expanded row', () => {
    renderView({ records: state([VALID]), open: 't1' });
    fireEvent.click(screen.getByTestId('transcript-record-open'));
    fireEvent.click(screen.getByTestId('transcript-raw-open'));

    fireEvent.click(screen.getByTestId('transcript-raw-close'));

    expect(screen.queryByTestId('transcript-raw-inspector')).toBeNull();
    expect(screen.getByTestId('transcript-record-detail')).toBeTruthy();
  });

  it('clears expanded and Raw detail when the transcript changes', () => {
    const { rerender } = renderView({ records: state([VALID]), open: 't1' });
    fireEvent.click(screen.getByTestId('transcript-record-open'));
    fireEvent.click(screen.getByTestId('transcript-raw-open'));

    rerender(
      <TranscriptView
        list={list([transcript({ title: 'Another transcript' })])}
        records={state([VALID])}
        open="t2"
        layout="master-detail"
        agentId="a1"
        sessionId="a1:work"
        onSelect={vi.fn()}
        onLoadOlder={vi.fn()}
        onReload={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('transcript-raw-inspector')).toBeNull();
    expect(screen.queryByTestId('transcript-record-detail')).toBeNull();
  });

  it('pushes the record depth on App, with one Back to the timeline', () => {
    renderView({ records: state([VALID]), open: 't1', layout: 'push' });

    fireEvent.click(screen.getByTestId('transcript-record-open'));
    expect(screen.getByTestId('transcript-record-push')).toBeTruthy();
    expect(screen.queryByTestId('transcript-back')).toBeNull();

    fireEvent.click(screen.getByTestId('transcript-record-back'));
    expect(screen.queryByTestId('transcript-record-push')).toBeNull();
    expect(screen.getByTestId('transcript-timeline')).toBeTruthy();
  });

  it('opens Raw inside the pushed record depth on App', () => {
    renderView({ records: state([VALID]), open: 't1', layout: 'push' });

    fireEvent.click(screen.getByTestId('transcript-raw-open'));

    const inspector = screen.getByTestId('transcript-raw-inspector');
    expect(inspector.getAttribute('data-variant')).toBe('pushed');
    expect(screen.getByTestId('transcript-record-push')).toBeTruthy();
    // No second Back for Raw: the depth's own Back is the only leave.
    expect(screen.getAllByTestId('transcript-record-back')).toHaveLength(1);
    expect(screen.queryByTestId('transcript-raw-close')).toBeNull();
  });

  it('reports a missing transcript and offers reload on a read failure', () => {
    const onReload = vi.fn();
    renderView({
      records: state([], { state: 'not_found', error: 'That transcript is no longer here.' }),
      open: 't1',
      onReload,
    });
    expect(screen.getByTestId('transcript-not-found')).toBeTruthy();

    renderView({
      records: state([], { state: 'stale_cursor', error: 'The transcript changed.' }),
      open: 't2',
      onReload,
    });
    const messages = screen.getAllByTestId('transcript-items-error');
    fireEvent.click(messages[messages.length - 1]!.querySelector('button') as HTMLElement);
    expect(onReload).toHaveBeenCalled();
  });

  it('keeps unavailable distinct from an empty transcript', () => {
    renderView({
      records: state([], { state: 'unavailable', loading: false }),
      open: 't1',
    });
    expect(screen.getByTestId('transcript-items-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('transcript-empty')).toBeNull();
  });
});
