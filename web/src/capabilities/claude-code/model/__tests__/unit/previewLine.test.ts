import { describe, expect, it } from 'vitest';
import { previewLine } from '@/capabilities/claude-code/model/previewLine';

describe('previewLine', () => {
  it('collapses a multi-line prompt to one line without losing its words', () => {
    // A prompt is frequently multi-line — a pasted stack trace, a bulleted
    // request. In a one-line slot a newline either breaks the row's height or
    // gets clipped mid-word, so the shape is dropped and the words are kept.
    expect(previewLine('first line\nsecond line')).toBe('first line second line');
    expect(previewLine('a\n\n\nb')).toBe('a b');
    expect(previewLine('  padded   oddly  ')).toBe('padded oddly');
    expect(previewLine('tabs\tand\tspaces')).toBe('tabs and spaces');
  });

  it('keeps the prompt verbatim otherwise, including a slash command', () => {
    // Measured, `lastPrompt` is frequently a slash-command invocation rather
    // than prose. It is shown rather than filtered: it is still the honest
    // answer to "what was this conversation about". Only whitespace changes
    // here — nothing else may, or a surface would be editing what the user
    // typed.
    expect(previewLine('/nession-web-design 收敛 radius 层级')).toBe(
      '/nession-web-design 收敛 radius 层级',
    );
    expect(previewLine('why does `a[0]` panic?')).toBe('why does `a[0]` panic?');
  });

  it('returns null rather than an empty string when there is nothing to show', () => {
    // The distinction matters at the row: `''` is truthy enough to make a
    // caller draw a second line that contains nothing, which is the failure
    // #1120 names when it says a row without a preview must degrade to title
    // and time. `null` is the only value that lets the caller ask "is there a
    // preview?" and get a usable answer.
    expect(previewLine(null)).toBeNull();
    expect(previewLine(undefined)).toBeNull();
    expect(previewLine('')).toBeNull();
    expect(previewLine('   ')).toBeNull();
    expect(previewLine('\n\t  \n')).toBeNull();
  });

  it('keeps a one-character prompt', () => {
    // The measured minimum is 1. A length threshold here would look like
    // tidying and would actually be the client deciding that a short prompt is
    // not worth showing — a product judgement this layer does not get to make.
    expect(previewLine('?')).toBe('?');
    expect(previewLine('  ?  ')).toBe('?');
  });
});
