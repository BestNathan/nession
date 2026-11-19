import { Edit3, Save, Info, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/shared/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { FileContentViewer } from '@/shared/file-viewer';
import { CodeMirrorEditor } from '@/platform/editor';
import type { ViewerType } from '@/shared/file-viewer/model/viewerRegistry';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/components/ui/alert-dialog';
import { formatSize } from '@/shared/lib/format';
import {
  useFileViewer,
  type FileSaveHandler,
  type ViewMode,
} from '../hooks/useFileViewer';
import type { FileOps } from '@/capabilities/files';
import { chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';

export interface FileViewerProps {
  fileOps: FileOps;
  path: string;
  filename: string;
  /** File size in bytes — when above the chunked threshold, forces read-only with progress. */
  fileSize?: number;
  /**
   * Leave this file. Omitted when the caller owns leaving the depth the viewer
   * sits in — the App's pushed detail has one Back, in its page header, and the
   * ✕ that used to sit here was a second control for the same leave (#1051).
   */
  onClose?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Save-in-flight state, for a caller guarding its own navigation. */
  onSavingChange?: (saving: boolean) => void;
  /** Register the viewer's guarded save; the caller owns the navigation. */
  onSaveHandlerChange?: (handler: FileSaveHandler | null) => void;
  initialLine?: number;
  /** 1-based column when a Terminal reference carried one (#3187). */
  initialColumn?: number;
}

interface FileViewerToolbarProps {
  /** The full path, which is what the header shows. */
  path: string;
  filename: string;
  isDirty: boolean;
  isText: boolean;
  isReadOnly: boolean;
  saving: boolean;
  hasPreviewRawToggle: boolean;
  viewMode: ViewMode;
  forceReadOnly: boolean;
  onSave: () => void;
  onEditToggle: () => void;
  /** Absent when the caller owns leaving — see `FileViewerProps.onClose`. */
  onCloseClick?: () => void;
}

/**
 * The toolbar's own controls — the body role, per Experience (#1073).
 *
 * They were `text-xs` from the shared `Button size="sm"` default, which is a
 * desktop density: on App it made the actions smaller than everything they act
 * on. The leaf exists on both experiences so this one class keeps working in
 * the Web layout, which composes the same viewer.
 */
const fileViewerActionClass = chromeSansRole('body');

function FileViewerToolbar({
  path, filename, isDirty, isText, isReadOnly, saving, hasPreviewRawToggle, viewMode, forceReadOnly, onSave, onEditToggle, onCloseClick,
}: FileViewerToolbarProps) {
  // Structured previews get Preview/Raw; Edit is only offered in raw mode.
  const showEditToggle = isText && !forceReadOnly && (!hasPreviewRawToggle || viewMode === 'raw');

  return (
    <div className="flex flex-shrink-0 items-center justify-between gap-[var(--nession-shell-space-2)] border-b border-border/60 px-[var(--nession-workspace-editor-head-pad-x)] py-[var(--nession-shell-space-1)]">
      <div className={cn('flex min-w-0 items-center gap-[var(--nession-shell-space-2)] text-muted-foreground', chromeMonoRole('code'))}>
        {/* The path, not the basename. The mockup's head reads
            `web/src/platform/terminal-runtime/xterm/ThemeManager.ts` — with a tree beside
            it, a bare filename does not say which of several `index.css` is
            open. */}
        <span className="truncate">{path || filename}</span>
        {forceReadOnly && (
          <span className={cn('inline-flex items-center gap-1 rounded-[var(--nession-radius-control)] bg-muted px-1.5 py-0.5 text-muted-foreground', chromeSansRole('caption'))}>
            <Lock className="h-2.5 w-2.5" /> Read-only
          </span>
        )}
        {isDirty && <span className="w-2 h-2 rounded-full bg-file-modified" title="Unsaved changes" />}
      </div>
      <div className="flex items-center gap-1">
        {isText && !isReadOnly && (
          <Button variant="ghost" size="sm" className={cn('h-7 text-muted-foreground', fileViewerActionClass)} onClick={onSave} disabled={!isDirty || saving}>
            <Save className="h-3 w-3 mr-1" />{saving ? 'Saving...' : 'Save'}
          </Button>
        )}
        {showEditToggle && (
          <Button variant="ghost" size="sm" className={cn('h-7 text-muted-foreground', fileViewerActionClass)} onClick={onEditToggle}>
            <Edit3 className="h-3 w-3 mr-1" />{isReadOnly ? 'Edit' : 'View'}
          </Button>
        )}
        {onCloseClick ? (
          <Button variant="ghost" size="sm" className={cn('h-7 text-muted-foreground hover:text-destructive', fileViewerActionClass)} onClick={onCloseClick} aria-label="Close file" title="Close file">✕</Button>
        ) : null}
      </div>
    </div>
  );
}

interface FileViewerContentProps {
  loading: boolean;
  error: string | null;
  viewerType: ViewerType | null;
  mediaBlobUrl: string | null;
  mediaMimeType: string | null;
  path: string;
  originalContent: string;
  content: string;
  isReadOnly: boolean;
  isDirty: boolean;
  /** Files' resolved markdown signal (extension or accepted content detection). */
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
  onViewModeChange: (mode: ViewMode) => void;
  initialLine?: number;
  initialColumn?: number;
}

function FileViewerContent({
  loading, error, viewerType, mediaBlobUrl, mediaMimeType, path, originalContent, content,
  isReadOnly, isDirty, isMarkdown, viewMode, showSuggestion,
  isChunkedLoading, loadedBytes, totalBytes,
  onRetry, onChange, onSuggestionPreview, onSuggestionDismiss, onCancelLoad,
  onViewModeChange, initialLine, initialColumn,
}: FileViewerContentProps) {
  // Chunked progress view — shown while a large file is being downloaded in chunks.
  const chunkedProgressView = (
    <div className="flex flex-col items-center justify-center h-full gap-3 p-6">
      <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>
        Loading… {formatSize(loadedBytes)} / {formatSize(totalBytes)}
      </p>
      <Progress value={totalBytes > 0 ? (loadedBytes / totalBytes) * 100 : 0} className="w-64" />
      <Button variant="outline" size="sm" onClick={onCancelLoad}>Cancel</Button>
    </div>
  );

  // Media viewers — one shared presentation, fed by the caller's Blob URL.
  if (viewerType && viewerType !== 'markdown') {
    return (
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex flex-col p-3 gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <div className={cn('flex h-full flex-col items-center justify-center gap-2 p-3', chromeSansRole('secondary'))}>
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
          </div>
        ) : mediaBlobUrl ? (
          <FileContentViewer
            file={{ path }}
            sourceEditor={CodeMirrorEditor}
            data={{
              kind: 'media',
              url: mediaBlobUrl,
              mimeType: mediaMimeType ?? 'application/octet-stream',
              complete: true,
            }}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {showSuggestion && (
        <div className={cn('flex items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-muted-foreground', chromeSansRole('metadata'))}>
          <Info className="h-3.5 w-3.5 shrink-0" />
          <span>This file looks like Markdown</span>
          <button
            onClick={onSuggestionPreview}
            className={cn('ml-auto rounded-[var(--nession-radius-control)] bg-primary px-2 py-0.5 text-primary-foreground hover:bg-primary/80', chromeSansRole('metadata'))}
          >
            Preview
          </button>
          <button
            onClick={onSuggestionDismiss}
            className="px-1 py-0.5 text-muted-foreground hover:text-foreground"
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
          <div className={cn('flex h-full flex-col items-center justify-center gap-2 p-3', chromeSansRole('secondary'))}>
            <p className="text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>
          </div>
        ) : (
          <FileContentViewer
            // Files' accepted content detection is a validated MIME hint for
            // the shared policy; the path alone may be a plain .txt.
            file={{ path, mimeType: isMarkdown ? 'text/markdown' : undefined }}
            sourceEditor={CodeMirrorEditor}
            data={{
              kind: 'text',
              // The structured preview shows the saved revision, exactly as it
              // did before the shared viewer; raw shows the editable buffer.
              text: viewMode === 'preview' ? originalContent : content,
              complete: true,
            }}
            mode={viewMode === 'preview' ? 'preview' : 'source'}
            onModeChange={(mode) => onViewModeChange(mode === 'preview' ? 'preview' : 'raw')}
            readOnly={isReadOnly}
            onTextChange={onChange}
            initialLine={initialLine}
            initialColumn={initialColumn}
          />
        )}
      </div>
      {isDirty && viewMode === 'preview' ? (
        <p className={cn('shrink-0 border-t border-warning/30 bg-warning/10 px-3 py-1.5 text-warning-foreground', chromeSansRole('metadata'))}>
          Preview shows the saved version. Save to update preview.
        </p>
      ) : null}
    </div>
  );
}

function FileConflictDialog({
  open,
  onOpenChange,
  onReload,
  onOverwrite,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReload: () => void;
  onOverwrite: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="file-conflict-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>File changed on disk</AlertDialogTitle>
          <AlertDialogDescription>
            This file changed after you opened it. Reload the newer content, or overwrite it
            with your edit.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <Button variant="outline" onClick={onReload}>
            Reload file
          </Button>
          <AlertDialogAction onClick={onOverwrite}>Overwrite</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface FileViewerDialogsProps {
  /** The viewer owns close/discard only when it owns the close affordance. */
  hasClose: boolean;
  showUnsavedDialog: boolean;
  setShowUnsavedDialog: (open: boolean) => void;
  handleConfirmClose: () => void;
  conflict: boolean;
  setConflict: (open: boolean) => void;
  handleReloadAfterConflict: () => void;
  handleSaveOverwrite: () => void;
}

function FileViewerDialogs({
  hasClose,
  showUnsavedDialog,
  setShowUnsavedDialog,
  handleConfirmClose,
  conflict,
  setConflict,
  handleReloadAfterConflict,
  handleSaveOverwrite,
}: FileViewerDialogsProps) {
  return (
    <>
      {/* The viewer's own unsaved dialog exists only for its own close
          affordance. Without one the caller owns leaving, and the caller's
          guard is the only one — two guards could disagree (#1051). */}
      {hasClose ? (
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
      ) : null}
      <FileConflictDialog
        open={conflict}
        onOpenChange={(open) => {
          if (!open) {
            setConflict(false);
          }
        }}
        onReload={handleReloadAfterConflict}
        onOverwrite={handleSaveOverwrite}
      />
    </>
  );
}

export function FileViewer({
  fileOps,
  path,
  filename,
  fileSize,
  onClose,
  onDirtyChange,
  onSavingChange,
  onSaveHandlerChange,
  initialLine,
  initialColumn,
}: FileViewerProps) {
  const {
    viewerType,
    isMarkdown,
    hasPreviewRawToggle,
    viewMode,
    showSuggestion,
    content,
    originalContent,
    mediaBlobUrl,
    mediaMimeType,
    loading,
    error,
    isReadOnly,
    isDirty,
    saving,
    conflict,
    setConflict,
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
    handleSaveOverwrite,
    handleReloadAfterConflict,
    handleCloseClick,
    handleConfirmClose,
    handleSuggestionPreview,
    handleSuggestionDismiss,
    handleCancelLoad,
  } = useFileViewer({
    fileOps, path, filename, onClose, onDirtyChange, onSavingChange,
    onSaveHandlerChange, fileSize, initialLine, initialColumn,
  });

  return (
    <div className="flex flex-col h-full">
      <FileViewerToolbar
        path={path}
        filename={filename}
        isDirty={isDirty}
        isText={isText}
        isReadOnly={isReadOnly}
        saving={saving}
        hasPreviewRawToggle={hasPreviewRawToggle}
        viewMode={viewMode}
        forceReadOnly={forceReadOnly}
        onSave={handleSave}
        onEditToggle={handleEditToggle}
        onCloseClick={onClose ? handleCloseClick : undefined}
      />
      <FileViewerContent
        loading={loading}
        error={error}
        viewerType={viewerType}
        mediaBlobUrl={mediaBlobUrl}
        mediaMimeType={mediaMimeType}
        path={path}
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
        onViewModeChange={handleSetViewMode}
        initialLine={initialLine}
        initialColumn={initialColumn}
      />
      {/* The viewer's own unsaved dialog exists only for its own close
          affordance. Without one the caller owns leaving, and the caller's
          guard is the only one — two guards could disagree (#1051). */}
      <FileViewerDialogs
        hasClose={Boolean(onClose)}
        showUnsavedDialog={showUnsavedDialog}
        setShowUnsavedDialog={setShowUnsavedDialog}
        handleConfirmClose={handleConfirmClose}
        conflict={conflict}
        setConflict={setConflict}
        handleReloadAfterConflict={handleReloadAfterConflict}
        handleSaveOverwrite={handleSaveOverwrite}
      />
    </div>
  );
}
