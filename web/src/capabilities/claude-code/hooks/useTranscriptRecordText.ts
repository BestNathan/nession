import { useEffect, useState } from 'react';
import { claudeCodeApi } from '../ClaudeCodePlugin';
import type { ClaudeCodeTranscriptRecord } from '../types';

/**
 * Upper bound on a single record the inspector will assemble.
 *
 * Each response is already bounded by the provider. This bound exists so a
 * pathological record cannot exhaust the browser tab; when it is reached the
 * inspector says the record was not shown completely rather than presenting a
 * partial buffer as the whole record.
 */
const MAX_RECORD_BYTES = 64 * 1024 * 1024;

export interface TranscriptRecordTextState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  raw: string;
  /** Bytes assembled so far. */
  loadedBytes: number;
  /** The record's total length, when the provider reported it. */
  sizeBytes: number;
  /** True only when the complete record has been assembled. */
  complete: boolean;
  error: string | null;
}

const IDLE: TranscriptRecordTextState = {
  status: 'idle',
  raw: '',
  loadedBytes: 0,
  sizeBytes: 0,
  complete: false,
  error: null,
};

function failure(responseState: string): string {
  switch (responseState) {
    case 'stale_generation':
      return 'The transcript changed. Reload it to read this record.';
    case 'not_found':
      return 'That record is no longer available.';
    case 'unavailable':
      return 'This Session’s working directory cannot be established.';
    default:
      return 'The record could not be read.';
  }
}

/**
 * Assemble one record's complete text from bounded chunks (#3726).
 *
 * A page carries most records inline, in which case there is no request at all.
 * A record too large for the page arrives as a placeholder and is read here,
 * chunk by chunk, until the provider says the line ends. `complete` is true
 * only then — a failure leaves it false, so the Raw view never labels a partial
 * assembly as the complete record.
 */
export function useTranscriptRecordText({
  agentId,
  sessionId,
  record,
  open,
}: {
  agentId: string | undefined;
  sessionId: string | undefined;
  record: ClaudeCodeTranscriptRecord | null;
  open: boolean;
}): TranscriptRecordTextState {
  const [state, setState] = useState<TranscriptRecordTextState>(IDLE);
  const recordRef = record?.record_ref ?? null;
  const inlineRaw = record?.raw ?? null;
  const sizeBytes = record?.size_bytes ?? 0;

  useEffect(() => {
    if (!open || !agentId || !sessionId || recordRef === null) {
      setState(IDLE);
      return;
    }
    if (inlineRaw !== null) {
      const loadedBytes = new TextEncoder().encode(inlineRaw).length;
      setState({
        status: 'ready',
        raw: inlineRaw,
        loadedBytes,
        sizeBytes: sizeBytes || loadedBytes,
        complete: true,
        error: null,
      });
      return;
    }

    let cancelled = false;
    setState({
      status: 'loading',
      raw: '',
      loadedBytes: 0,
      sizeBytes,
      complete: false,
      error: null,
    });

    void (async () => {
      let raw = '';
      let offset = 0;
      let totalBytes = sizeBytes;
      for (;;) {
        const response = await claudeCodeApi.claudeCodeTranscriptRecord({
          agent_id: agentId,
          session_id: sessionId,
          record_ref: recordRef,
          ...(offset > 0 ? { offset } : {}),
        });
        if (cancelled) {
          return;
        }
        if (response.state !== 'ready') {
          setState((current) => ({
            ...current,
            status: 'error',
            complete: false,
            error:
              response.state === 'error'
                ? (response.error ?? 'The record could not be read.')
                : failure(response.state),
          }));
          return;
        }
        const chunk = response.raw ?? '';
        if (response.size_bytes !== null && response.size_bytes !== undefined) {
          totalBytes = response.size_bytes;
        }
        raw += chunk;
        // The provider reports the next byte offset from the file. Counting
        // encoded characters here would drift on invalid UTF-8, which is
        // decoded lossily and can change length.
        offset =
          response.next_offset ??
          (response.offset ?? offset) + new TextEncoder().encode(chunk).length;
        const complete = response.has_more !== true;
        setState({
          status: complete ? 'ready' : 'loading',
          raw,
          loadedBytes: offset,
          sizeBytes: totalBytes || offset,
          complete,
          error: null,
        });
        if (complete) {
          return;
        }
        if (offset > MAX_RECORD_BYTES) {
          setState((current) => ({
            ...current,
            status: 'error',
            complete: false,
            error: 'This record is too large to display completely in the browser.',
          }));
          return;
        }
      }
    })().catch((error: unknown) => {
      if (cancelled) {
        return;
      }
      setState((current) => ({
        ...current,
        status: 'error',
        complete: false,
        error:
          error instanceof Error
            ? error.message
            : 'The record could not be read.',
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [agentId, sessionId, recordRef, inlineRaw, sizeBytes, open]);

  return state;
}
