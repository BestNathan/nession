function decodeBase64Bytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export type TerminalStreamEvent =
  | { kind: 'output'; streamEpoch: number; streamSeq: number; data: string }
  | { kind: 'resize'; streamEpoch: number; streamSeq: number; cols: number; rows: number };

export interface StreamApplyHandlers {
  onOutput: (data: Uint8Array) => void;
  onResize: (cols: number, rows: number) => void;
}

/** Apply ordered stream events from `agent.terminal.stream.resume` (#1094). */
export function applyTerminalStreamEvents(
  events: TerminalStreamEvent[],
  handlers: StreamApplyHandlers,
): void {
  for (const event of events) {
    if (event.kind === 'output') {
      handlers.onOutput(decodeBase64Bytes(event.data));
    } else {
      handlers.onResize(event.cols, event.rows);
    }
  }
}

export function parseStreamEvents(raw: unknown): TerminalStreamEvent[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: TerminalStreamEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const ev = item as Record<string, unknown>;
    const kind = ev.kind;
    const streamEpoch = ev.stream_epoch;
    const streamSeq = ev.stream_seq;
    if (typeof streamEpoch !== 'number' || typeof streamSeq !== 'number') {
      continue;
    }
    if (kind === 'output' && typeof ev.data === 'string') {
      out.push({
        kind: 'output',
        streamEpoch,
        streamSeq,
        data: ev.data,
      });
    } else if (
      kind === 'resize' &&
      typeof ev.cols === 'number' &&
      typeof ev.rows === 'number'
    ) {
      out.push({
        kind: 'resize',
        streamEpoch,
        streamSeq,
        cols: ev.cols,
        rows: ev.rows,
      });
    }
  }
  return out;
}
