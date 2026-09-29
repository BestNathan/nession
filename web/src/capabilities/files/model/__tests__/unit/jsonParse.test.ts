import { describe, it, expect } from 'vitest';
import { parseJsonDocument, parseJsonlRecords, splitJsonlPhysicalLines } from '../../jsonParse';

describe('parseJsonDocument', () => {
  it('parses valid JSON objects and scalars', () => {
    expect(parseJsonDocument('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonDocument('null')).toEqual({ ok: true, value: null });
    expect(parseJsonDocument('[1,2]')).toEqual({ ok: true, value: [1, 2] });
  });

  it('reports empty and invalid JSON without throwing', () => {
    expect(parseJsonDocument('   ').ok).toBe(false);
    expect(parseJsonDocument('{bad').ok).toBe(false);
  });
});

describe('splitJsonlPhysicalLines', () => {
  it('normalizes CRLF and keeps a final line without trailing newline', () => {
    expect(splitJsonlPhysicalLines('a\r\nb\nc')).toEqual(['a', 'b', 'c']);
    expect(splitJsonlPhysicalLines('only')).toEqual(['only']);
  });
});

describe('parseJsonlRecords', () => {
  it('maps non-blank lines to records with physical line numbers', () => {
    const records = parseJsonlRecords('{"id":1}\n\n{"id":2}\r\n{"id":3}');
    expect(records.map((r) => r.lineNumber)).toEqual([1, 3, 4]);
  });

  it('isolates malformed lines', () => {
    const records = parseJsonlRecords('{"ok":true}\n{broken\n{"n":2}');
    expect(records[0].kind).toBe('valid');
    expect(records[1].kind).toBe('invalid');
    expect(records[2].kind).toBe('valid');
  });

  it('accepts non-object JSON values per line', () => {
    const records = parseJsonlRecords('"hello"\n42\ntrue\nnull\n[]');
    expect(records.every((r) => r.kind === 'valid')).toBe(true);
  });
});
