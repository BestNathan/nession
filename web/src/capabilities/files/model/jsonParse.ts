export type JsonParseResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

/** Parse a whole JSON document. Does not mutate or reformat source text. */
export function parseJsonDocument(text: string): JsonParseResult {
  if (text.trim() === '') {
    return { ok: false, message: 'Empty file' };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    const message = err instanceof SyntaxError ? err.message : 'Invalid JSON';
    return { ok: false, message };
  }
}

export type JsonlRecord =
  | { kind: 'valid'; lineNumber: number; value: unknown; raw: string }
  | { kind: 'invalid'; lineNumber: number; raw: string; message: string };

/** Normalize newlines to LF without dropping the final line when it has no trailing newline. */
export function splitJsonlPhysicalLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (normalized.length === 0) {
    return [];
  }
  return normalized.split('\n');
}

/** Parse JSONL/NDJSON: one record per non-blank physical line; blank lines are skipped. */
export function parseJsonlRecords(text: string): JsonlRecord[] {
  const lines = splitJsonlPhysicalLines(text);
  const records: JsonlRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i];
    if (raw.trim() === '') {
      continue;
    }
    try {
      const value = JSON.parse(raw) as unknown;
      records.push({ kind: 'valid', lineNumber, value, raw });
    } catch (err) {
      const message = err instanceof SyntaxError ? err.message : 'Invalid JSON';
      records.push({ kind: 'invalid', lineNumber, raw, message });
    }
  }
  return records;
}
