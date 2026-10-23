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
  | {
    kind: 'resize';
    streamEpoch: number;
    streamSeq: number;
    cols: number;
    rows: number;
    /**
     * The ControlLease generation that authorized the resize (#2286).
     *
     * Replay carries it for the same reason a live frame does: a resize
     * recorded under a lease the session has since left must not move the
     * current controller's grid. Absent from providers that recorded the event
     * before the field existed, and on frames that are levels rather than
     * stream events.
     */
    controlGeneration?: number;
  };

/** Agent-assigned position at stream delivery, NOT an xterm parser-applied ACK. */
export interface TerminalStreamPosition {
  streamEpoch: number;
  streamSeq: number;
}

export interface StreamApplyHandlers {
  onOutput: (data: Uint8Array, position?: TerminalStreamPosition) => void;
  onResize: (
    cols: number,
    rows: number,
    position?: TerminalStreamPosition,
    controlGeneration?: number,
  ) => void;
}

/** Apply ordered stream events from `agent.terminal.stream.resume` (#1094). */
export function applyTerminalStreamEvents(
  events: TerminalStreamEvent[],
  handlers: StreamApplyHandlers,
): void {
  for (const event of events) {
    const position: TerminalStreamPosition = {
      streamEpoch: event.streamEpoch,
      streamSeq: event.streamSeq,
    };
    if (event.kind === 'output') {
      handlers.onOutput(decodeBase64Bytes(event.data), position);
    } else if (event.controlGeneration !== undefined) {
      handlers.onResize(event.cols, event.rows, position, event.controlGeneration);
    } else {
      handlers.onResize(event.cols, event.rows, position);
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
      const controlGeneration = ev.control_generation;
      out.push({
        kind: 'resize',
        streamEpoch,
        streamSeq,
        cols: ev.cols,
        rows: ev.rows,
        // Absent or malformed reads as "the provider did not state one", which
        // the consumer treats as an unfenced legacy event rather than inventing
        // a generation that could suppress a real resize.
        ...(typeof controlGeneration === 'number'
          && Number.isSafeInteger(controlGeneration)
          && controlGeneration >= 0
          ? { controlGeneration }
          : {}),
      });
    }
  }
  return out;
}
