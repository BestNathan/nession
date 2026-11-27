import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { formatSize, transcriptLabel } from '../../format';
import { parseTranscriptRecord } from '../../model/transcriptRecord';
import type { ClaudeCodeTranscriptRecord } from '../../types';
import { TranscriptList, TranscriptRecordsBody } from '../TranscriptView';
import { TranscriptRawInspector } from '../TranscriptRawInspector';
import { TranscriptRecordDetail } from '../TranscriptRecordDetail';
import type { ClaudeAppData } from './model';
import { ResourceIntro, ScrollBody } from './primitives';

/** Which transcripts exist at this Session's working directory. */
export function TranscriptsRoute({ data }: { data: ClaudeAppData }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-transcripts">
      <ResourceIntro
        eyebrow="Transcripts"
        title="Recorded sessions"
        description="Complete event streams. Every record is visible, including kinds this client does not model."
      />
      <TranscriptList
        list={data.state.transcripts.list}
        onSelect={data.actions.openTranscript}
        onRefresh={data.state.transcripts.refresh}
        refreshing={data.state.transcripts.refreshing}
        touch
      />
    </div>
  );
}

/** One transcript: every source row, each with its own Raw action. */
export function TranscriptRoute({ id, data }: { id: string; data: ClaudeAppData }) {
  const transcript = data.state.transcripts.list.transcripts.find(
    (candidate) => candidate.id === id,
  );
  const records = data.state.transcriptRecords;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-transcript">
      <ResourceIntro
        eyebrow="Transcript"
        title={transcript ? transcriptLabel(transcript) : 'Transcript'}
        description="Every source row. Raw is available on each one."
      />
      <TranscriptRecordsBody
        records={records.records}
        layout="push"
        expandedRef={null}
        onToggleRecord={() => undefined}
        onOpenRecord={(record) =>
          data.actions.push({ kind: 'record', transcriptId: id, record })
        }
        onOpenRaw={(record) => data.actions.push({ kind: 'raw', transcriptId: id, record })}
        onLoadOlder={() => records.loadOlder()}
        onReload={() => records.reload()}
        touch
      />
    </div>
  );
}

/** The record's native detail plus the one action that opens Raw. */
export function RecordRoute({
  transcriptId,
  record,
  data,
}: {
  transcriptId: string;
  record: ClaudeCodeTranscriptRecord;
  data: ClaudeAppData;
}) {
  const parsed = useMemo(
    () => (typeof record.raw === 'string' ? parseTranscriptRecord(record.raw) : null),
    [record.raw],
  );
  const label = parsed?.label ?? 'Record';
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-record">
      <ResourceIntro
        eyebrow={`Record · byte ${record.offset}`}
        title={label}
        description={`${formatSize(record.size_bytes)} · every record is readable, recognised or not`}
      />
      <ScrollBody className="px-[var(--nession-shell-space-4)] py-[var(--nession-shell-space-3)]" testId="claude-app-record-scroll">
        <TranscriptRecordDetail parsed={parsed} record={record} />
        <div className="mt-[var(--nession-shell-space-4)] border-t pt-[var(--nession-shell-space-3)]">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="claude-app-record-raw"
            onClick={() =>
              data.actions.push({ kind: 'raw', transcriptId, record })
            }
          >
            Raw
          </Button>
        </div>
      </ScrollBody>
    </div>
  );
}

/** Complete Raw inspection, pushed above the timeline. */
export function RawRoute({
  record,
  data,
}: {
  record: ClaudeCodeTranscriptRecord;
  data: ClaudeAppData;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-raw">
      <TranscriptRawInspector
        agentId={data.agentId}
        sessionId={data.sessionId}
        record={record}
        variant="pushed"
      />
    </div>
  );
}
