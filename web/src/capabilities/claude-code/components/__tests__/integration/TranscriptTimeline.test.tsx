import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TranscriptTimeline } from '../../TranscriptTimeline';
import type { ClaudeCodeTranscriptRecord } from '../../../types';

function raw(value: unknown): string {
  return JSON.stringify(value);
}

function wire(
  ref: string,
  value: unknown,
  overrides: Partial<ClaudeCodeTranscriptRecord> = {},
): ClaudeCodeTranscriptRecord {
  const text = raw(value);
  return { record_ref: ref, offset: 0, size_bytes: text.length, raw: text, ...overrides };
}

const UNKNOWN = wire('r-unknown', {
  type: 'new-runtime-diagnostic',
  subtype: 'probe',
  detail: 'a future record type',
});
const INVALID: ClaudeCodeTranscriptRecord = {
  record_ref: 'r-invalid',
  offset: 100,
  size_bytes: 20,
  raw: 'this is not json',
};
const OVERSIZED: ClaudeCodeTranscriptRecord = {
  record_ref: 'r-large',
  offset: 200,
  size_bytes: 1_200_000,
};
const ASSISTANT = wire('r-assistant', {
  type: 'assistant',
  timestamp: '2026-10-01T00:00:01Z',
  message: {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'weighing' },
      { type: 'text', text: 'answer' },
      { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } },
    ],
  },
});
const TOOL_RESULT = wire('r-result', {
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'a.rs' }],
  },
});

function renderTimeline(
  records: ClaudeCodeTranscriptRecord[],
  overrides: Partial<Parameters<typeof TranscriptTimeline>[0]> = {},
) {
  const props: Parameters<typeof TranscriptTimeline>[0] = {
    records,
    layout: 'master-detail',
    expandedRef: null,
    onToggleRecord: vi.fn(),
    onOpenRecord: vi.fn(),
    onOpenRaw: vi.fn(),
    ...overrides,
  };
  return { ...render(<TranscriptTimeline {...props} />), props };
}

describe('TranscriptTimeline complete record rendering', () => {
  it('draws one persistent row for every physical record, including unknown, malformed and oversized', () => {
    renderTimeline([UNKNOWN, INVALID, OVERSIZED]);

    expect(screen.getAllByTestId('transcript-record')).toHaveLength(3);
    expect(screen.getByTestId('transcript-record-count').textContent).toBe('3');
  });

  it('names an unknown record by its upstream type instead of a parser-status badge', () => {
    renderTimeline([UNKNOWN]);

    const row = screen.getByTestId('transcript-record');
    expect(row.textContent).toContain('new-runtime-diagnostic · probe');
    expect(row.textContent?.toLowerCase()).not.toContain('unrecognized');
    expect(row.textContent?.toLowerCase()).not.toContain('unknown');
  });

  it('shows the original text preview of a malformed line', () => {
    renderTimeline([INVALID]);

    expect(screen.getByTestId('transcript-record').textContent).toContain('this is not json');
  });

  it('shows an oversized record as a reference row with its size', () => {
    renderTimeline([OVERSIZED]);

    const row = screen.getByTestId('transcript-record');
    expect(row.textContent).toContain('1.1 MB');
    expect(row.textContent).toContain('open Raw');
    expect(screen.getByTestId('transcript-raw-open')).toBeTruthy();
  });

  it('offers an independent Raw action on every row', () => {
    const { props } = renderTimeline([UNKNOWN, INVALID, ASSISTANT]);

    const buttons = screen.getAllByTestId('transcript-raw-open');
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[1] as HTMLElement);
    expect(props.onOpenRaw).toHaveBeenCalledWith(INVALID);
  });

  it('keeps a tool_use and its tool_result as two independently visible rows, visually linked', () => {
    // #3726 forbids backend pairing: the call and the answer are different
    // source lines and both remain reachable. The shared call id is the link,
    // not a shared row.
    renderTimeline([ASSISTANT, TOOL_RESULT], { expandedRef: 'r-result' });

    expect(screen.getAllByTestId('transcript-record')).toHaveLength(2);
    expect(screen.getAllByTestId('transcript-call-id').map((node) => node.textContent)).toEqual([
      'call-1',
      'call-1',
    ]);
    const resultDetail = screen.getByTestId('transcript-record-detail');
    expect(within(resultDetail).getByTestId('transcript-block')).toHaveAttribute(
      'data-kind',
      'tool_result',
    );
  });

  it('reveals native detail for a recognized row, including every block', () => {
    renderTimeline([ASSISTANT], { expandedRef: 'r-assistant' });

    const detail = screen.getByTestId('transcript-record-detail');
    expect(detail.textContent).toContain('weighing');
    expect(detail.textContent).toContain('answer');
    expect(detail.textContent).toContain('Bash');
    expect(within(detail).getAllByTestId('transcript-block').map((node) => node.dataset.kind)).toEqual([
      'thinking',
      'tool_use',
    ]);
  });

  it('reveals native detail for a system, metadata or unknown row rather than only Raw', () => {
    const metadata = wire('r-meta', { type: 'ai-title', aiTitle: 'a title' });
    renderTimeline([UNKNOWN, metadata], { expandedRef: 'r-meta' });

    expect(screen.getByTestId('transcript-record-detail').textContent).toContain('a title');
  });

  it('pushes instead of expanding on App', () => {
    const { props } = renderTimeline([ASSISTANT, TOOL_RESULT], { layout: 'push' });

    fireEvent.click(screen.getAllByTestId('transcript-record-open')[0] as HTMLElement);
    expect(props.onOpenRecord).toHaveBeenCalledWith(ASSISTANT);
    expect(props.onToggleRecord).not.toHaveBeenCalled();
  });

  it('keeps the paging and partial-tail signals the provider reported', () => {
    renderTimeline([UNKNOWN], {
      onLoadOlder: vi.fn(),
      loadingOlder: true,
      partialTail: true,
    });

    expect(screen.getByTestId('transcript-load-older').textContent).toContain('Loading');
    expect(screen.getByTestId('transcript-partial')).toBeTruthy();
  });
});
