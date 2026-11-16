import { describe, expect, it } from 'vitest';
import { parseTranscriptRecord } from '../../transcriptRecord';

describe('parseTranscriptRecord', () => {
  it('decodes every physical line, including an unknown type, without losing it', () => {
    // The load-bearing property of #3726: a record type this version has never
    // seen is still a record with its own upstream name — not a dropped line,
    // and not a row labelled "unrecognized".
    const parsed = parseTranscriptRecord(
      JSON.stringify({
        type: 'new-runtime-diagnostic',
        subtype: 'probe',
        timestamp: '2026-10-01T00:00:00Z',
        detail: 'future record',
      }),
    );

    expect(parsed.kind).toBe('unknown');
    expect(parsed.label).toBe('new-runtime-diagnostic · probe');
    expect(parsed.type).toBe('new-runtime-diagnostic');
    expect(parsed.subtype).toBe('probe');
    expect(parsed.preview).toContain('future record');
    expect(parsed.label.toLowerCase()).not.toContain('unrecognized');
  });

  it('keeps malformed JSON as a generic record carrying the original text', () => {
    const parsed = parseTranscriptRecord('this is not json');

    expect(parsed.kind).toBe('invalid');
    expect(parsed.validJson).toBe(false);
    expect(parsed.value).toBeNull();
    expect(parsed.label).toBe('Record');
    expect(parsed.preview).toBe('this is not json');
  });

  it('decodes a multi-block assistant line as one record with sub-blocks', () => {
    // One source line is one row; the blocks are inside it. In particular the
    // `tool_use` is not a separate row and remains independently readable.
    const parsed = parseTranscriptRecord(
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-10-01T00:00:01Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'weighing the options' },
            { type: 'text', text: 'the answer' },
            { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
      }),
    );

    expect(parsed.kind).toBe('assistant');
    expect(parsed.blocks.map((block) => block.kind)).toEqual([
      'thinking',
      'text',
      'tool_use',
    ]);
    expect(parsed.blocks[2]).toMatchObject({ kind: 'tool_use', name: 'Bash', callId: 'call-1' });
  });

  it('keeps a tool result as its own user record, not consumed by the tool call', () => {
    // #3726 explicitly forbids backend pairing: both source lines must remain
    // visible and independently inspectable.
    const parsed = parseTranscriptRecord(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'a.rs' }],
        },
      }),
    );

    expect(parsed.kind).toBe('user');
    expect(parsed.label).toBe('You');
    expect(parsed.blocks).toEqual([
      { kind: 'tool_result', callId: 'call-1', text: 'a.rs', isError: false },
    ]);
  });

  it('distinguishes injected context from a person typing', () => {
    const parsed = parseTranscriptRecord(
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: { role: 'user', content: [{ type: 'text', text: 'injected' }] },
      }),
    );
    expect(parsed.label).toBe('Context');
  });

  it('names a metadata record by its upstream type', () => {
    const parsed = parseTranscriptRecord(
      JSON.stringify({ type: 'ai-title', aiTitle: 'Transcript execution view' }),
    );
    expect(parsed.kind).toBe('metadata');
    expect(parsed.label).toBe('ai-title');
    expect(parsed.preview).toBe('Transcript execution view');
  });

  it('keeps an attachment payload readable as native detail', () => {
    const parsed = parseTranscriptRecord(
      JSON.stringify({
        type: 'attachment',
        attachment: { type: 'hook_success', hookName: 'PostToolUse' },
      }),
    );
    expect(parsed.kind).toBe('attachment');
    expect(parsed.label).toBe('hook_success');
    expect(parsed.fields).toEqual(
      expect.arrayContaining([
        { label: 'hookName', value: 'PostToolUse' },
      ]),
    );
  });

  it('accepts valid JSON that is not an object without losing it', () => {
    const parsed = parseTranscriptRecord('[1,2,3]');
    expect(parsed.validJson).toBe(true);
    expect(parsed.kind).toBe('unknown');
    expect(parsed.value).toEqual([1, 2, 3]);
  });

  it('does not throw on a record whose content has an unexpected shape', () => {
    const parsed = parseTranscriptRecord(
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: { unexpected: true } },
      }),
    );
    expect(parsed.kind).toBe('assistant');
    expect(parsed.blocks).toEqual([]);
    expect(parsed.validJson).toBe(true);
  });

  it('keeps an unmodelled content block visible inside its record', () => {
    const parsed = parseTranscriptRecord(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'citation', text: 'a future block' }],
        },
      }),
    );
    expect(parsed.blocks).toEqual([
      { kind: 'other', blockType: 'citation', preview: 'a future block' },
    ]);
  });
});
