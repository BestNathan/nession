import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TranscriptTimeline } from '../../TranscriptTimeline';
import type { ClaudeCodeTranscriptEntry } from '../../../types';

/**
 * The collapsed line is the transcript's *summary* of a record, and the one
 * thing it must never do is make a bounded body look like a whole one.
 *
 * These tests exist because the view already said so in prose — "a truncated
 * body still says so on the collapsed line" — while the code only said it for
 * tools. Measured, the bodies that actually exceed their ceiling are the
 * *other* kinds: reasoning runs to 126 KB and an attachment to 1.2 MB, both cut
 * to 8 KB before they reach the page. A reader looking at a 1.2 MB attachment
 * rendered as 8 KB with no marker is being told the session recorded less than
 * it did, which is the failure the disclosure model was built to avoid.
 */

function attachment(overrides: { truncated: boolean }): ClaudeCodeTranscriptEntry {
  return {
    kind: 'attachment',
    id: 'a1',
    timestamp: '2026-09-30T10:00:00.000Z',
    attachment_type: 'file',
    payload: { text: 'first 8 KB of a much larger file', kind: 'text', truncated: overrides.truncated },
  };
}

function reasoning(overrides: { truncated: boolean }): ClaudeCodeTranscriptEntry {
  return {
    kind: 'reasoning',
    id: 'r1',
    timestamp: '2026-09-30T10:00:00.000Z',
    reasoning_type: 'thinking',
    text: { text: 'a long thought', kind: 'text', truncated: overrides.truncated },
  };
}

function tool(overrides: { truncated: boolean }): ClaudeCodeTranscriptEntry {
  return {
    kind: 'tool',
    id: 't1',
    timestamp: '2026-09-30T10:00:00.000Z',
    tool: {
      call_id: 'call-1',
      name: 'Bash',
      status: 'success',
      summary: 'cargo test',
      input: { text: '{}', kind: 'json', truncated: false },
      output: { text: 'ok', kind: 'text', truncated: overrides.truncated },
    },
  };
}

/** The collapsed line's whole text, which is what a reader sees without clicking. */
function collapsedLine(): string {
  return screen.getByTestId('transcript-item').textContent ?? '';
}

describe('TranscriptTimeline truncated bodies', () => {
  it('says a cut attachment body is cut', () => {
    render(<TranscriptTimeline items={[attachment({ truncated: true })]} />);
    expect(collapsedLine()).toContain('truncated');
  });

  it('says a cut reasoning body is cut', () => {
    render(<TranscriptTimeline items={[reasoning({ truncated: true })]} />);
    expect(collapsedLine()).toContain('truncated');
  });

  // The companion counterexample: a marker that is always on says nothing. If
  // the rule were "attachments carry a status", these two would pass while the
  // reader learned nothing about which bodies were actually cut.
  it('says nothing about a whole attachment body', () => {
    render(<TranscriptTimeline items={[attachment({ truncated: false })]} />);
    expect(collapsedLine()).not.toContain('truncated');
  });

  it('says nothing about a whole reasoning body', () => {
    render(<TranscriptTimeline items={[reasoning({ truncated: false })]} />);
    expect(collapsedLine()).not.toContain('truncated');
  });

  it('still carries the tool status alongside the cut', () => {
    render(<TranscriptTimeline items={[tool({ truncated: true })]} />);
    expect(collapsedLine()).toContain('success');
    expect(collapsedLine()).toContain('truncated');
  });

  it('leaves a tool status alone when nothing was cut', () => {
    render(<TranscriptTimeline items={[tool({ truncated: false })]} />);
    expect(collapsedLine()).toContain('success');
    expect(collapsedLine()).not.toContain('truncated');
  });
});
