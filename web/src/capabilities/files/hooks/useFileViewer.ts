import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/shared/lib/errorHelpers';
import type { JsonPreviewKind, ViewerType } from '@/shared/file-viewer/model/viewerRegistry';
import { mediaHintForPath, resolveFilePresentation } from '@/shared/file-viewer';
import {
  AUTO_APPLY_CONFIDENCE,
  SUGGEST_CONFIDENCE,
  detectLanguageForFile,
} from '@/shared/markdown';
import { readFileChunked, type FileData, type FileOps } from '@/capabilities/files';
import { fileErrorMessage, fileErrorKind } from '../model/fileErrors';
import { useMarkdownPreviewErrorFallback } from './useMarkdownPreviewErrorFallback';
import { base64ToBlobUrl } from '@/shared/lib/blob';
export type ViewMode = 'preview' | 'raw';

/**
 * What a guarded save produced. A navigation guard must distinguish a saved
 * document (the switch may proceed), a revision conflict (the viewer's own
 * conflict decision now owns the next step) and any other failure (the draft
 * stays here and the guard offers retry/cancel/discard).
 */
export type FileSaveOutcome = 'saved' | 'conflict' | 'failed';

/** A caller may request the mounted viewer's guarded save before navigating. */
export type FileSaveHandler = () => Promise<FileSaveOutcome>;

/**
 * Files larger than this switch to chunked reading with a progress bar.
 * 10 MB keeps single-request latency bounded on slow P2P links while still
 * making common text files (configs, logs, source) load in one round-trip.
 */
const CHUNKED_READ_THRESHOLD = 10 * 1024 * 1024;

export interface UseFileViewerParams {
  fileOps: FileOps;
  path: string;
  filename: string;
  /**
   * Leave this file. Omitted when the caller owns leaving the depth the viewer
   * is in — the App's pushed detail has one Back, in its page header, and a ✕
   * beside it would be a second control for the same leave (#1051). The viewer
   * then renders no close affordance and asks no discard question: the caller's
   * own guard is the only one, so there is one answer per leave rather than two
   * that could disagree.
   */
  onClose?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Save-in-flight state, for a caller guarding its own navigation. */
  onSavingChange?: (saving: boolean) => void;
  /**
   * Register the viewer's guarded save. The caller owns the navigation
   * decision; the viewer still owns the content, revision and write.
   */
  onSaveHandlerChange?: (handler: FileSaveHandler | null) => void;
  /**
   * File size in bytes, if known up-front from the FileEntry. Files larger than
   * CHUNKED_READ_THRESHOLD are loaded in chunks with a visible progress bar and
   * forced read-only — saving them back through a single `file.write` is not
   * safe at that scale.
   */
  fileSize?: number;
  /**
   * A navigation target from a Terminal file reference (#3187). A location
   * makes the viewer open source/raw at that position: a rendered preview has
   * no source line to show, so it cannot satisfy the reference.
   */
  initialLine?: number;
  initialColumn?: number;
}

/** Decode base64 content to a Blob URL for media viewers. */

/** Replace the caller's Blob URL with one for the freshly read media. */
function replaceMediaBlob(
  current: { current: string | null },
  base64: string,
  mimeType: string,
): string {
  const url = base64ToBlobUrl(base64, mimeType);
  if (current.current) {
    URL.revokeObjectURL(current.current);
  }
  current.current = url;
  return url;
}

interface FileLoaderResult {
  viewerType: ViewerType | null;
  content: string;
  originalContent: string;
  mediaBlobUrl: string | null;
  mediaMimeType: string | null;
  loading: boolean;
  error: string | null;
  loadedBytes: number;
  totalBytes: number;
  isChunkedLoading: boolean;
  forceReadOnly: boolean;
  /** Revision of the content currently loaded, for guarded saves. */
  revision: string | undefined;
  setRevision: (revision: string | undefined) => void;
  loadFile: () => Promise<void>;
  setContent: (content: string) => void;
  setOriginalContent: (content: string) => void;
  handleCancelLoad: () => void;
}

/**
 * The only flight allowed to publish (issue #2902). `isCurrent` binds the
 * generation this flight took; a superseded or cancelled flight fails it, so
 * its settles cannot mutate the successor's content, progress or loading.
 */
interface LoadFlight {
  isCurrent: () => boolean;
  setError: (message: string) => void;
  settle: () => void;
}

interface ChunkedFlight extends LoadFlight {
  begin: () => void;
  setProgress: (loaded: number, total: number) => void;
  attachCancel: (cancel: () => void) => void;
  complete: (text: string) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to read file';
}

/** Read one whole file; only the owning flight publishes the answer. */
async function readWholeFile(
  fileOps: FileOps,
  path: string,
  flight: LoadFlight,
  publish: (data: FileData) => void,
): Promise<void> {
  try {
    const data = await fileOps.readFile(path);
    if (flight.isCurrent()) { publish(data); }
  } catch (err) {
    if (flight.isCurrent()) { flight.setError(errorMessage(err)); }
  } finally {
    if (flight.isCurrent()) { flight.settle(); }
  }
}

/**
 * Stream a large file in bounded chunks. A chunk that settles after cancel is
 * never decoded, reported or committed: `readFileChunked` rejects it and this
 * flight's generation can no longer publish.
 */
async function readChunkedFile(
  fileOps: FileOps,
  path: string,
  flight: ChunkedFlight,
): Promise<void> {
  flight.begin();
  const result = readFileChunked(fileOps, path, (loaded, total) => {
    if (flight.isCurrent()) { flight.setProgress(loaded, total); }
  });
  if (!flight.isCurrent()) {
    result.cancel();
    return;
  }
  flight.attachCancel(result.cancel);
  try {
    const fullText = await result.promise;
    if (flight.isCurrent()) { flight.complete(fullText); }
  } catch (err) {
    if (!flight.isCurrent()) { return; }
    if (err instanceof DOMException && err.name === 'AbortError') { return; }
    flight.setError(errorMessage(err));
  } finally {
    if (flight.isCurrent()) { flight.settle(); }
  }
}

/**
 * Read-file state: decodes text content or builds a media blob URL, tracks
 * loading/error, and calls `onDecoded` after a text file is decoded so the
 * caller can run content-based markdown detection. The server-reported MIME
 * type is passed along, since `text/markdown` is a far stronger signal than
 * anything the content itself can offer. For files above the chunked
 * threshold, falls back to progressive chunked reads so the UI can render a
 * progress bar instead of a frozen skeleton.
 */
function useFileLoader(
  fileOps: FileOps,
  path: string,
  fileSize: number | undefined,
  onDecoded: (decoded: string, mimeType?: string) => void,
): FileLoaderResult {
  const onDecodedRef = useRef(onDecoded);
  useEffect(() => {
    onDecodedRef.current = onDecoded;
  });

  const viewerType: ViewerType | null = mediaHintForPath(path);

  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [mediaBlobUrl, setMediaBlobUrl] = useState<string | null>(null);
  const [mediaMimeType, setMediaMimeType] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isChunkedLoading, setIsChunkedLoading] = useState(false);
  const [forceReadOnly, setForceReadOnly] = useState(false);
  const [revision, setRevision] = useState<string | undefined>(undefined);
  const blobUrlRef = useRef<string | null>(null);
  const chunkedCancelRef = useRef<(() => void) | null>(null);
  /**
   * Monotonic owner of the current read (issue #2902). Every load takes the
   * next generation; only that generation may publish content, progress,
   * error or loading, and only it may clear the cancel handle.
   */
  const loadGenerationRef = useRef(0);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      loadGenerationRef.current += 1;
      if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
      chunkedCancelRef.current?.();
      chunkedCancelRef.current = null;
    };
  }, []);

  const handleCancelLoad = useCallback(() => {
    // Cancel is a settled, non-loading state: invalidate the flight first so a
    // chunk that settles late cannot publish content or restore loading.
    loadGenerationRef.current += 1;
    chunkedCancelRef.current?.();
    chunkedCancelRef.current = null;
    setIsChunkedLoading(false);
    setLoading(false);
  }, []);

  // Large text files: chunked read, forced read-only — too big to round-trip.
  const runChunkedLoad = useCallback(async (size: number, generation: number) => {
    await readChunkedFile(fileOps, path, {
      isCurrent: () => loadGenerationRef.current === generation,
      begin: () => {
        setForceReadOnly(true);
        setIsChunkedLoading(true);
        setTotalBytes(size);
        // A chunked document is read-only; a guarded save is not offered and
        // the per-chunk revision describes a moment, not the loaded result.
        setRevision(undefined);
      },
      setProgress: (loaded, total) => { setLoadedBytes(loaded); setTotalBytes(total); },
      attachCancel: (cancel) => { chunkedCancelRef.current = cancel; },
      complete: (text) => { setContent(text); setOriginalContent(text); onDecodedRef.current(text); },
      setError,
      settle: () => {
        setIsChunkedLoading(false);
        setLoading(false);
        chunkedCancelRef.current = null;
      },
    });
  }, [fileOps, path]);

  const loadFile = useCallback(async () => {
    // Take ownership before cancelling the previous flight: the old reader's
    // late chunk or finally block must not be able to touch this generation.
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    chunkedCancelRef.current?.();
    chunkedCancelRef.current = null;

    setLoading(true);
    setError(null);
    setLoadedBytes(0);
    setTotalBytes(0);
    setIsChunkedLoading(false);
    setMediaMimeType(null);

    if (fileSize && fileSize > CHUNKED_READ_THRESHOLD) {
      await runChunkedLoad(fileSize, generation);
      return;
    }

    setForceReadOnly(false);
    await readWholeFile(fileOps, path, {
      isCurrent: () => loadGenerationRef.current === generation,
      setError,
      settle: () => setLoading(false),
    }, (data) => {
      setRevision(data.revision);

      // Media files
      if (viewerType && viewerType !== 'markdown') {
        setMediaBlobUrl(replaceMediaBlob(blobUrlRef, data.content, data.mime_type));
        setMediaMimeType(data.mime_type);
        return;
      }

      // Text content — decode
      const decoded = fileOps.base64Decode(data.content);
      setContent(decoded);
      setOriginalContent(decoded);
      onDecodedRef.current(decoded, data.mime_type);
    });
  }, [path, fileOps, viewerType, fileSize, runChunkedLoad]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  return {
    viewerType,
    content,
    originalContent,
    mediaBlobUrl,
    mediaMimeType,
    loading,
    error,
    loadedBytes,
    totalBytes,
    isChunkedLoading,
    forceReadOnly,
    revision,
    setRevision,
    loadFile,
    setContent,
    setOriginalContent,
    handleCancelLoad,
  };
}

/**
 * Dirty/save lifecycle, including the guarded write and its conflict actions.
 *
 * Kept apart from the viewer body because the save decision (which revision to
 * expect, what to do with a conflict) is a lifecycle of its own; the viewer is
 * already the largest composition in this feature.
 */
function useFileSave({
  fileOps,
  path,
  filename,
  content,
  revision,
  setRevision,
  setOriginalContent,
  onDirtyChange,
  loadFile,
}: {
  fileOps: FileOps;
  path: string;
  filename: string;
  content: string;
  revision: string | undefined;
  setRevision: (revision: string | undefined) => void;
  setOriginalContent: (content: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  loadFile: () => Promise<void>;
}) {
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  /**
   * The editor's latest content. A write commits the snapshot it submitted,
   * but editing stays possible while that request is in flight; dirty must be
   * reconciled against what the editor holds when the write completes, not
   * cleared because the older snapshot was persisted (#3322).
   */
  const latestContentRef = useRef(content);
  latestContentRef.current = content;

  const save = useCallback(async (overwrite: boolean): Promise<FileSaveOutcome> => {
    setSaving(true);
    setConflict(false);
    const submittedContent = content;
    try {
      const result = await fileOps.writeFile(
        path,
        submittedContent,
        overwrite || revision === undefined ? {} : { expectedRevision: revision },
      );
      setRevision(result.revision);
      setOriginalContent(submittedContent);
      // The committed baseline is the submitted snapshot; newer edits remain
      // dirty so a second guarded save can persist them.
      const stillDirty = latestContentRef.current !== submittedContent;
      setIsDirty(stillDirty);
      onDirtyChange?.(stillDirty);
      toast.success(`Saved ${filename}`);
      return 'saved';
    } catch (err) {
      if (fileErrorKind(err) === 'conflict') {
        setConflict(true);
        toast.error(fileErrorMessage(err, 'save file'));
        return 'conflict';
      }
      toastError(err, 'Failed to save file');
      return 'failed';
    } finally {
      setSaving(false);
    }
  }, [fileOps, path, content, filename, onDirtyChange, revision, setOriginalContent, setRevision]);

  const handleSave = useCallback(() => {
    void save(false);
  }, [save]);

  const handleSaveOverwrite = useCallback(() => {
    void save(true);
  }, [save]);

  /** Discard the local edit and read the file again after a conflict. */
  const handleReloadAfterConflict = useCallback(() => {
    setConflict(false);
    setIsDirty(false);
    onDirtyChange?.(false);
    void loadFile();
  }, [loadFile, onDirtyChange]);

  return {
    isDirty,
    setIsDirty,
    saving,
    save,
    conflict,
    setConflict,
    handleSave,
    handleSaveOverwrite,
    handleReloadAfterConflict,
  };
}

/**
 * View mode and the markdown suggestion, including the navigation-target rule:
 * a Terminal reference must open source/raw at its position, and re-activating
 * the same file elsewhere re-enters raw without discarding the document.
 */
function useFileViewMode(
  opensInPreviewByExt: boolean,
  initialLine: number | undefined,
  initialColumn: number | undefined,
) {
  const [viewMode, setViewMode] = useState<ViewMode>(
    initialLine !== undefined ? 'raw' : opensInPreviewByExt ? 'preview' : 'raw',
  );
  const [showSuggestion, setShowSuggestion] = useState(false);
  const locationKey = initialLine === undefined
    ? null
    : `${initialLine}:${initialColumn ?? ''}`;
  const appliedLocationRef = useRef(locationKey);

  useEffect(() => {
    if (locationKey === null || appliedLocationRef.current === locationKey) {
      return;
    }
    appliedLocationRef.current = locationKey;
    setViewMode('raw');
    setShowSuggestion(false);
  }, [locationKey]);

  return { viewMode, setViewMode, showSuggestion, setShowSuggestion };
}

/**
 * Report save-in-flight state and register the guarded save for a caller that
 * owns navigation. The caller decides *whether* to navigate; the viewer keeps
 * the content, revision and write.
 */
function useFileSaveReporting(
  saving: boolean,
  save: (overwrite: boolean) => Promise<FileSaveOutcome>,
  onSavingChange?: (saving: boolean) => void,
  onSaveHandlerChange?: (handler: FileSaveHandler | null) => void,
) {
  useEffect(() => {
    onSavingChange?.(saving);
  }, [onSavingChange, saving]);

  // The registered handler is stable; it reaches the latest save closure
  // through a ref, so a click cannot observe a save built from older content.
  const saveRef = useRef(save);
  saveRef.current = save;

  useEffect(() => {
    if (!onSaveHandlerChange) {
      return;
    }
    onSaveHandlerChange(() => saveRef.current(false));
    return () => onSaveHandlerChange(null);
  }, [onSaveHandlerChange]);
}

/**
 * State and handlers for the FileViewer component: file loading, markdown
 * detection (extension- and content-based), Preview/Raw view mode, dirty
 * tracking, and save. Extracted so the render body stays small.
 */
export function useFileViewer({
  fileOps, path, filename, onClose, onDirtyChange, onSavingChange,
  onSaveHandlerChange, fileSize, initialLine, initialColumn,
}: UseFileViewerParams) {
  const presentation = resolveFilePresentation({ path });
  const jsonPreviewKind: JsonPreviewKind | null = presentation.jsonKind;
  const isMarkdownByExt = presentation.kind === 'markdown';
  const opensInPreviewByExt = isMarkdownByExt || jsonPreviewKind !== null;
  const [isMarkdown, setIsMarkdown] = useState(isMarkdownByExt);
  const { viewMode, setViewMode, showSuggestion, setShowSuggestion } =
    useFileViewMode(opensInPreviewByExt, initialLine, initialColumn);
  const suggestionDismissedRef = useRef(false);
  const [isReadOnly, setIsReadOnly] = useState(true);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);

  const handleDecoded = useCallback((decoded: string, mimeType?: string) => {
    // A navigation target is read as source at a line, so content sniffing
    // must not move the viewer into a preview that cannot show that line.
    if (initialLine !== undefined) {
      return;
    }
    // The extension already settled it, or the user has dismissed the offer.
    if (isMarkdownByExt || suggestionDismissedRef.current) {
      return;
    }

    const detection = detectLanguageForFile(path, decoded, mimeType);
    if (detection.language !== 'markdown') {
      return;
    }

    if (detection.confidence >= AUTO_APPLY_CONFIDENCE) {
      // Trustworthy metadata (MIME type or a conventional basename such as
      // CHANGELOG) — safe to open in preview.
      setIsMarkdown(true);
      setViewMode('preview');
    } else if (detection.confidence >= SUGGEST_CONFIDENCE) {
      // Content sniffing only, which is capped below the auto-apply band. Stay
      // in raw and offer a dismissible suggestion instead of silently changing
      // how the file is rendered.
      setIsMarkdown(true);
      setViewMode('raw');
      setShowSuggestion(true);
    }
  }, [initialLine, isMarkdownByExt, path, setShowSuggestion, setViewMode]);

  const {
    viewerType, content, originalContent, mediaBlobUrl, mediaMimeType, loading, error,
    loadedBytes, totalBytes, isChunkedLoading, forceReadOnly, revision,
    setRevision, loadFile, setContent, setOriginalContent, handleCancelLoad,
  } = useFileLoader(fileOps, path, fileSize, handleDecoded);

  const saveState = useFileSave({
    fileOps,
    path,
    filename,
    content,
    revision,
    setRevision,
    setOriginalContent,
    onDirtyChange,
    loadFile,
  });

  useFileSaveReporting(saveState.saving, saveState.save, onSavingChange, onSaveHandlerChange);

  const handleEditToggle = () => {
    // Chunked-loaded files are forced read-only — too large to round-trip safely.
    if (forceReadOnly) { return; }
    setIsReadOnly((prev) => !prev);
  };

  const handleSetViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    if (mode === 'raw') { setIsReadOnly(true); }
  };

  useMarkdownPreviewErrorFallback(filename, handleSetViewMode);

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    const dirty = newContent !== originalContent;
    saveState.setIsDirty(dirty);
    onDirtyChange?.(dirty);
  };

  // The close affordance is wired only when the caller passed `onClose`.
  const handleCloseClick = () => {
    if (saveState.isDirty) {
      setShowUnsavedDialog(true);
      return;
    }
    onClose?.();
  };

  const handleConfirmClose = () => { setShowUnsavedDialog(false); onClose?.(); };

  const handleSuggestionPreview = () => { setViewMode('preview'); setShowSuggestion(false); };

  const handleSuggestionDismiss = () => {
    setShowSuggestion(false);
    suggestionDismissedRef.current = true;
  };

  const isText = viewerType === null || viewerType === 'markdown';

  const hasPreviewRawToggle = isMarkdown || jsonPreviewKind !== null;

  return {
    viewerType,
    isMarkdown,
    jsonPreviewKind,
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
    isDirty: saveState.isDirty,
    saving: saveState.saving,
    conflict: saveState.conflict,
    setConflict: saveState.setConflict,
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
    handleSave: saveState.handleSave,
    handleSaveOverwrite: saveState.handleSaveOverwrite,
    handleReloadAfterConflict: saveState.handleReloadAfterConflict,
    handleCloseClick,
    handleConfirmClose,
    handleSuggestionPreview,
    handleSuggestionDismiss,
    handleCancelLoad,
  };
}
