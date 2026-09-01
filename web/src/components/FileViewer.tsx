import type { ComponentType } from 'react';
import { Edit3, Save, Eye, Code, Info, Lock } from 'lucide-react';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { Progress } from './ui/progress';
import { CodeMirrorEditor } from './CodeMirrorEditor';
import { MarkdownPreview } from './MarkdownPreview';
import { ImageViewer } from './ImageViewer';
import { VideoViewer } from './VideoViewer';
import { AudioViewer } from './AudioViewer';
import { PdfViewer } from './PdfViewer';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from './ui/alert-dialog';
import { type ViewerType } from '@/lib/viewerRegistry';
import { formatSize } from '@/lib/format';
import { useFileViewer, type ViewMode } from '@/hooks/useFileViewer';
import type { FileOps } from '../services/fileOps';

export interface FileViewerProps {
  fileOps: FileOps;
  path: string;
  filename: string;
  /** File size in bytes — when above the chunked threshold, forces read-only with progress. */
  fileSize?: number;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

interface FileViewerToolbarProps {
  filename: string;
  isDirty: boolean;
  isText: boolean;
  isReadOnly: boolean;
  saving: boolean;
  isMarkdown: boolean;
  viewMode: ViewMode;
  forceReadOnly: boolean;
  onSave: () => void;
  onEditToggle: () => void;
  onSetViewMode: (mode: ViewMode) => void;
  onCloseClick: () => void;
}

function FileViewerToolbar({
  filename, isDirty, isText, isReadOnly, saving, isMarkdown, viewMode, forceReadOnly, onSave, onEditToggle, onSetViewMode, onCloseClick,
}: FileViewerToolbarProps) {
  // Markdown files get a Preview/Raw mode toggle; Edit is only offered in raw mode.
  const showEditToggle = isText && !forceReadOnly && (!isMarkdown || viewMode === 'raw');

  return (
    <div className="flex items-center justify-between px-2 py-1 border-b border-border/60 flex-shrink-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground truncate max-w-[200px]">{filename}</span>
        {forceReadOnly && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-muted text-muted-foreground text-[10px]">
            <Lock className="h-2.5 w-2.5" /> Read-only
          </span>
        )}
        {isDirty && <span className="w-2 h-2 rounded-full bg-file-modified" title="Unsaved changes" />}
      </div>
      <div className="flex items-center gap-1">
        {isText && !isReadOnly && (
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={onSave} disabled={!isDirty || saving}>
            <Save className="h-3 w-3 mr-1" />{saving ? 'Saving...' : 'Save'}
          </Button>
        )}
        {isMarkdown && (
          <div className="flex items-center rounded-md bg-muted/60 p-0.5" role="group" aria-label="View mode">
            <Button
              variant={viewMode === 'preview' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-6 text-xs px-2"
              onClick={() => onSetViewMode('preview')}
              aria-pressed={viewMode === 'preview'}
            >
              <Eye className="h-3 w-3 mr-1" />Preview
            </Button>
            <Button
              variant={viewMode === 'raw' ? 'secondary' : 'ghost'}
              size="sm"
              className="h-6 text-xs px-2"
              onClick={() => onSetViewMode('raw')}
              aria-pressed={viewMode === 'raw'}
            >
              <Code className="h-3 w-3 mr-1" />Raw
            </Button>
          </div>
        )}
        {showEditToggle && (
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={onEditToggle}>
            <Edit3 className="h-3 w-3 mr-1" />{isReadOnly ? 'Edit' : 'View'}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground hover:text-destructive" onClick={onCloseClick} aria-label="Close file" title="Close file">✕</Button>
      </div>
    </div>
  );
}

interface FileViewerContentProps {
  loading: boolean;
  error: string | null;
  viewerType: ViewerType | null;
  mediaBlobUrl: string | null;
  filename: string;
  originalContent: string;
  content: string;
  isReadOnly: boolean;
  isDirty: boolean;
  isMarkdown: boolean;
  viewMode: ViewMode;
  showSuggestion: boolean;
  isChunkedLoading: boolean;
  loadedBytes: number;
  totalBytes: number;
  onRetry: () => void;
  onChange: (value: string) => void;
  onSuggestionPreview: () => void;
  onSuggestionDismiss: () => void;
  onCancelLoad: () => void;
}

function FileViewerContent({
  loading, error, viewerType, mediaBlobUrl, filename, originalContent, content,
  isReadOnly, isDirty, isMarkdown, viewMode, showSuggestion,
  isChunkedLoading, loadedBytes, totalBytes,
  onRetry, onChange, onSuggestionPreview, onSuggestionDismiss, onCancelLoad,
}: FileViewerContentProps) {
  // Chunked progress view — shown while a large file is being downloaded in chunks.
  const chunkedProgressView = (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
      <p className="text-sm text-muted-foreground">
        Loading… {formatSize(loadedBytes)} / {formatSize(totalBytes)}
      </p>
      <Progress value={totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0} className="w-64" />
      <Button variant="outline" size="sm" onClick={onCancelLoad}>Cancel</Button>
    </div>
  );

  // Media viewers
  if (viewerType && viewerType !== 'markdown') {
    const mediaViewers: Partial<Record<ViewerType, ComponentType<{ blobUrl: string; filename: string }>>> = {
      image: ImageViewer,
      video: VideoViewer,
      audio: AudioViewer,
      pdf: PdfViewer,
    };
    const MediaViewerComponent = viewerType ? mediaViewers[viewerType] : null;

    return (
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex flex-col p-3 gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 p-3 text-sm">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
          </div>
        ) : MediaViewerComponent && mediaBlobUrl ? (
          <MediaViewerComponent blobUrl={mediaBlobUrl} filename={filename} />
        ) : null}
      </div>
    );
  }

  // Markdown preview mode
  if (isMarkdown && viewMode === 'preview') {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {isDirty && originalContent !== content && (
          <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b bg-warning/10 border-warning/30 text-warning-foreground">
            <Info className="h-3 w-3 shrink-0" />
            <span>Preview shows the saved version. Save to update preview.</span>
          </div>
        )}
        <div className="flex-1 min-h-0">
          {isChunkedLoading ? chunkedProgressView : loading ? (
            <div className="flex flex-col p-3 gap-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center h-full gap-2 p-3 text-sm">
              <p className="text-destructive">{error}</p>
              <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
            </div>
          ) : (
            <MarkdownPreview content={originalContent} filename={filename} />
          )}
        </div>
      </div>
    );
  }

  // Raw text mode (CodeMirror)
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {showSuggestion && (
        <div className="flex items-center gap-2 px-3 py-1.5 text-xs border-b bg-info/10 border-info/30 text-info-foreground">
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span>This file looks like Markdown</span>
          <button
            onClick={onSuggestionPreview}
            className="ml-auto px-2 py-0.5 rounded text-xs bg-info hover:bg-info/80 text-info-foreground"
          >
            Preview
          </button>
          <button
            onClick={onSuggestionDismiss}
            className="px-1 py-0.5 text-info hover:text-info-foreground"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        {isChunkedLoading ? chunkedProgressView : loading ? (
          <div className="flex flex-col p-3 gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 p-3 text-sm">
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
          </div>
        ) : (
          <CodeMirrorEditor
            value={content}
            onChange={onChange}
            readOnly={isReadOnly}
            filename={filename}
          />
        )}
      </div>
    </div>
  );
}

export function FileViewer({ fileOps, path, filename, fileSize, onClose, onDirtyChange }: FileViewerProps) {
  const {
    viewerType,
    isMarkdown,
    viewMode,
    showSuggestion,
    content,
    originalContent,
    mediaBlobUrl,
    loading,
    error,
    isReadOnly,
    isDirty,
    saving,
    showUnsavedDialog,
    isText,
    loadedBytes,
    totalBytes,
    isChunkedLoading,
    forceReadOnly,
    setShowUnsavedDialog,
    loadFile,
    handleEditToggle,
    handleSetViewMode,
    handleContentChange,
    handleSave,
    handleCloseClick,
    handleConfirmClose,
    handleSuggestionPreview,
    handleSuggestionDismiss,
    handleCancelLoad,
  } = useFileViewer({ fileOps, path, filename, onClose, onDirtyChange, fileSize });

  return (
    <div className="flex flex-col h-full">
      <FileViewerToolbar
        filename={filename}
        isDirty={isDirty}
        isText={isText}
        isReadOnly={isReadOnly}
        saving={saving}
        isMarkdown={isMarkdown}
        viewMode={viewMode}
        forceReadOnly={forceReadOnly}
        onSave={handleSave}
        onEditToggle={handleEditToggle}
        onSetViewMode={handleSetViewMode}
        onCloseClick={handleCloseClick}
      />
      <FileViewerContent
        loading={loading}
        error={error}
        viewerType={viewerType}
        mediaBlobUrl={mediaBlobUrl}
        filename={filename}
        originalContent={originalContent}
        content={content}
        isReadOnly={isReadOnly}
        isDirty={isDirty}
        isMarkdown={isMarkdown}
        viewMode={viewMode}
        showSuggestion={showSuggestion}
        isChunkedLoading={isChunkedLoading}
        loadedBytes={loadedBytes}
        totalBytes={totalBytes}
        onRetry={loadFile}
        onChange={handleContentChange}
        onSuggestionPreview={handleSuggestionPreview}
        onSuggestionDismiss={handleSuggestionDismiss}
        onCancelLoad={handleCancelLoad}
      />

      <AlertDialog open={showUnsavedDialog} onOpenChange={setShowUnsavedDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Close anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmClose} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Close without saving</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
