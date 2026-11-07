import { useCallback, useState } from 'react';
import { Code, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { ImageViewer } from './components/ImageViewer';
import { VideoViewer } from './components/VideoViewer';
import { AudioViewer } from './components/AudioViewer';
import { PdfViewer } from './components/PdfViewer';
import { StructuredPreview } from './components/StructuredTextPreview';
import { resolveFilePresentation } from './presentation';
import type { FileContentViewerProps, FileViewMode } from './types';

const noop = () => {};

function ModeToggle({
  mode,
  onMode,
}: {
  mode: FileViewMode;
  onMode: (mode: FileViewMode) => void;
}) {
  return (
    <div
      className="flex shrink-0 items-center rounded-[var(--nession-radius-control)] bg-muted/60 p-0.5"
      role="group"
      aria-label="View mode"
    >
      <Button
        variant={mode === 'preview' ? 'secondary' : 'ghost'}
        size="sm"
        className={cn('h-6 px-2', chromeSansRole('body'))}
        onClick={() => onMode('preview')}
        aria-pressed={mode === 'preview'}
      >
        <Eye className="mr-1 h-3 w-3" />Preview
      </Button>
      <Button
        variant={mode === 'source' ? 'secondary' : 'ghost'}
        size="sm"
        className={cn('h-6 px-2', chromeSansRole('body'))}
        onClick={() => onMode('source')}
        aria-pressed={mode === 'source'}
      >
        <Code className="mr-1 h-3 w-3" />Raw
      </Button>
    </div>
  );
}

/**
 * The one read-only file presentation owner (#2876).
 *
 * It receives authorized content and renders it; it does not select, read,
 * edit, save or know about Files/Git/session authority. The format policy is
 * [`resolveFilePresentation`], so both capabilities resolve a path the same
 * way. Callers own path/status headers and any edit/save lifecycle.
 */
export function FileContentViewer({
  file,
  data,
  sourceEditor,
  mode,
  onModeChange,
  readOnly = true,
  onTextChange,
  initialLine,
}: FileContentViewerProps) {
  const Source = sourceEditor;
  const presentation = resolveFilePresentation(file, data);
  const [internalMode, setInternalMode] = useState<FileViewMode>('preview');

  const requested: FileViewMode = mode && mode !== 'auto' ? mode : internalMode;
  const supportsPreview = presentation.canPreview && data.kind === 'text';
  const canPreview = supportsPreview && data.complete;
  const effective: FileViewMode = canPreview ? requested : 'source';

  const chooseMode = useCallback(
    (next: FileViewMode) => {
      setInternalMode(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  if (data.kind === 'unavailable') {
    return (
      <div
        data-testid="file-view-unavailable"
        data-presentation="unavailable"
        className={cn('flex h-full items-center justify-center p-4 text-muted-foreground', chromeSansRole('secondary'))}
      >
        {data.reason}
      </div>
    );
  }

  if (data.kind === 'media') {
    const media = (() => {
      switch (presentation.kind) {
        case 'image':
          return <ImageViewer blobUrl={data.url} filename={file.path} />;
        case 'video':
          return <VideoViewer blobUrl={data.url} filename={file.path} />;
        case 'audio':
          return <AudioViewer blobUrl={data.url} filename={file.path} />;
        case 'pdf':
          return <PdfViewer blobUrl={data.url} filename={file.path} />;
        default:
          return (
            <div
              data-testid="file-view-unavailable"
              data-presentation="unavailable"
              className={cn('flex h-full items-center justify-center p-4 text-muted-foreground', chromeSansRole('secondary'))}
            >
              This media type cannot be displayed.
            </div>
          );
      }
    })();

    return (
      <div
        data-testid="file-content-viewer"
        data-presentation={presentation.kind}
        className="flex h-full min-h-0 flex-col"
      >
        {media}
      </div>
    );
  }

  if (data.kind !== 'text') {
    return null;
  }

  const showToggle = canPreview;
  const structuredKind =
    presentation.kind === 'markdown' || presentation.kind === 'json' || presentation.kind === 'jsonl'
      ? presentation.kind
      : null;
  const text = data.text;

  return (
    <div
      data-testid="file-content-viewer"
      data-presentation={presentation.kind}
      data-mode={effective}
      className="flex h-full min-h-0 flex-col"
    >
      {showToggle ? (
        <div className="flex shrink-0 items-center justify-end border-b border-border/40 px-3 py-1">
          <ModeToggle mode={effective} onMode={chooseMode} />
        </div>
      ) : null}
      {!data.complete && supportsPreview ? (
        <p
          data-testid="file-view-incomplete"
          className={cn('shrink-0 border-b border-border/40 px-3 py-1 text-muted-foreground', chromeSansRole('metadata'))}
        >
          Preview unavailable for incomplete content — showing source.
        </p>
      ) : null}
      {effective === 'preview' && structuredKind ? (
        <div className="min-h-0 flex-1">
          <StructuredPreview
            filename={file.path}
            content={text}
            kind={structuredKind}
            onMarkdownFallback={() => chooseMode('source')}
          />
        </div>
      ) : (
        <div data-testid="file-content-code" className="min-h-0 flex-1">
          <Source
            value={text}
            onChange={readOnly ? noop : onTextChange ?? noop}
            readOnly={readOnly}
            filename={file.path}
            initialLine={initialLine}
          />
        </div>
      )}
    </div>
  );
}
