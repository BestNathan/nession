import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { formatSize } from '@/shared/lib/format';
import type { JsonPreviewKind } from '../model/viewerRegistry';
import { MarkdownPreview } from './MarkdownPreview';
import { JsonPreview } from './JsonPreview';
import { JsonlPreview } from './JsonlPreview';

interface StructuredTextPreviewProps {
  filename: string;
  originalContent: string;
  content: string;
  isDirty: boolean;
  isMarkdown: boolean;
  jsonPreviewKind: JsonPreviewKind | null;
  loading: boolean;
  error: string | null;
  isChunkedLoading: boolean;
  loadedBytes: number;
  totalBytes: number;
  onRetry: () => void;
  onCancelLoad: () => void;
}

function ChunkedProgress({ loadedBytes, totalBytes, onCancelLoad }: {
  loadedBytes: number;
  totalBytes: number;
  onCancelLoad: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
      <p className="text-sm text-muted-foreground">
        Loading… {formatSize(loadedBytes)} / {formatSize(totalBytes)}
      </p>
      <Progress value={totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0} className="w-64" />
      <Button variant="outline" size="sm" onClick={onCancelLoad}>Cancel</Button>
    </div>
  );
}

function LoadError({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2 p-3 text-sm">
      <p className="text-destructive">{error}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="flex flex-col p-3 gap-2">
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/** Markdown / JSON / JSONL preview pane with shared load and dirty semantics. */
export function StructuredTextPreview({
  filename,
  originalContent,
  content,
  isDirty,
  isMarkdown,
  jsonPreviewKind,
  loading,
  error,
  isChunkedLoading,
  loadedBytes,
  totalBytes,
  onRetry,
  onCancelLoad,
}: StructuredTextPreviewProps) {
  let body: ReactNode;
  if (isChunkedLoading) {
    body = <ChunkedProgress loadedBytes={loadedBytes} totalBytes={totalBytes} onCancelLoad={onCancelLoad} />;
  } else if (loading) {
    body = <LoadingSkeleton />;
  } else if (error) {
    body = <LoadError error={error} onRetry={onRetry} />;
  } else if (isMarkdown) {
    body = <MarkdownPreview content={originalContent} filename={filename} />;
  } else if (jsonPreviewKind === 'jsonl') {
    body = <JsonlPreview content={originalContent} />;
  } else {
    body = <JsonPreview content={originalContent} />;
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {isDirty && originalContent !== content && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b bg-warning/10 border-warning/30 text-warning-foreground">
          <Info className="h-3 w-3 shrink-0" />
          <span>Preview shows the saved version. Save to update preview.</span>
        </div>
      )}
      <div className="flex-1 min-h-0">{body}</div>
    </div>
  );
}
