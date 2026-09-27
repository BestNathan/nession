import { describe, expect, it } from 'vitest';
import { conversationLabel } from '@/capabilities/claude-code/model/conversationLabel';

describe('conversationLabel', () => {
  it('uses the title the provider read, verbatim', () => {
    // Verbatim is the requirement, not a convenience: measured titles are
    // multilingual and free-form, and they include CJK. A truncation or an
    // ASCII assumption in this layer would corrupt them before any element
    // that knows its own width had a chance to decide anything.
    expect(conversationLabel({ title: 'app-sessions-redesign' })).toBe('app-sessions-redesign');
    expect(conversationLabel({ title: '底板反向条件分支' })).toBe('底板反向条件分支');
    expect(conversationLabel({ title: 'rookie 的 13 个 cookie' })).toBe(
      'rookie 的 13 个 cookie',
    );
  });

  it('trims a title rather than letting padding reach the layout', () => {
    expect(conversationLabel({ title: '  capsule radius  ' })).toBe('capsule radius');
  });

  it('falls back to a date, said as a date, when Claude recorded no title', () => {
    // About a fifth of real transcripts carry none (measured: 3 of 14), so this
    // is a real path. The assertion pins the *shape* — a labelled date — rather
    // than recomputing the string from the same locale calls, which would pass
    // no matter what this function did.
    const label = conversationLabel({ title: null, updated_at: '2026-09-25T12:00:00Z' }, 'en-US');
    expect(label).toMatch(/^Conversation · [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}/);
  });

  it('never returns an empty label, however little it was given', () => {
    // A blank row is worse than an honest one: it reads as a rendering bug
    // rather than as "Claude named nothing".
    expect(conversationLabel({ title: '' })).toBe('Conversation');
    expect(conversationLabel({ title: '   ' })).toBe('Conversation');
    expect(conversationLabel({ updated_at: null })).toBe('Conversation');
    expect(conversationLabel({ updated_at: 'not a timestamp' })).toBe('Conversation');
    expect(conversationLabel(undefined)).toBe('Conversation');
  });

  it('prefers a title over a timestamp when it has both', () => {
    // The two are not alternatives to weigh: a title is what the conversation
    // is called, and the date is only what is left when nothing called it.
    expect(
      conversationLabel({ title: 'capsule radius', updated_at: '2026-09-25T12:00:00Z' }, 'en-US'),
    ).toBe('capsule radius');
  });
});
