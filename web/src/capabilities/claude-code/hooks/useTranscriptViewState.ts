import { useEffect, useState } from 'react';
import type { ClaudeCodeTranscriptRecord } from '../types';

/**
 * Selection state inside the Transcripts surface (#3726).
 *
 * The transcript selection itself belongs to the workspace hook; this owns the
 * three depths *inside* one transcript: the expanded row on Web, the pushed
 * record on App, and the Raw inspector. Changing transcript, Session or Agent
 * clears all three so an answer about the previous transcript is never readable
 * under the new one's header.
 */
export function useTranscriptViewState({
  open,
  agentId,
  sessionId,
}: {
  open: string | null;
  agentId: string | undefined;
  sessionId: string | undefined;
}) {
  const [expandedRef, setExpandedRef] = useState<string | null>(null);
  const [rawRecord, setRawRecord] = useState<ClaudeCodeTranscriptRecord | null>(null);
  const [pushedRecord, setPushedRecord] = useState<ClaudeCodeTranscriptRecord | null>(null);
  const [pushedRawOpen, setPushedRawOpen] = useState(false);

  useEffect(() => {
    setExpandedRef(null);
    setRawRecord(null);
    setPushedRecord(null);
    setPushedRawOpen(false);
  }, [agentId, sessionId, open]);

  const toggleRecord = (recordRef: string) => {
    setExpandedRef((current) => (current === recordRef ? null : recordRef));
  };

  const openRaw = (record: ClaudeCodeTranscriptRecord, layout: 'master-detail' | 'push') => {
    if (layout === 'push') {
      setPushedRecord(record);
      setPushedRawOpen(true);
      return;
    }
    setRawRecord(record);
  };

  const openRecord = (record: ClaudeCodeTranscriptRecord) => {
    setPushedRecord(record);
    setPushedRawOpen(false);
  };

  return {
    expandedRef,
    toggleRecord,
    rawRecord,
    openRaw,
    closeRaw: () => setRawRecord(null),
    pushedRecord,
    pushedRawOpen,
    openRecord,
    showPushedRaw: () => setPushedRawOpen(true),
    closePushedRecord: () => {
      setPushedRecord(null);
      setPushedRawOpen(false);
    },
  };
}
