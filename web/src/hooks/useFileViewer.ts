import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/lib/errorHelpers';
import { getViewerType, parseExt, type ViewerType } from '@/lib/viewerRegistry';
import {
  AUTO_APPLY_CONFIDENCE,
  SUGGEST_CONFIDENCE,
  detectLanguageForFile,
  isMarkdownExt,
} from '@/markdown';
import { readFileChunked, type FileOps } from '@/features/files';
export type ViewMode = 'preview' | 'raw';

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
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /**
   * File size in bytes, if known up-front from the FileEntry. Files larger than
   * CHUNKED_READ_THRESHOLD are loaded in chunks with a visible progress bar and
   * forced read-only — saving them back through a single `file.write` is not
   * safe at that scale.
   */
  fileSize?: number;
}

/** Decode base64 content to a Blob URL for media viewers. */
function base64ToBlobUrl(base64: string, mimeType: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

interface FileLoaderResult {
  ext: string;
  viewerType: ViewerType | null;
  content: string;
  originalContent: string;
  mediaBlobUrl: string | null;
  loading: boolean;
  error: string | null;
  loadedBytes: number;
  totalBytes: number;
  isChunkedLoading: boolean;
  forceReadOnly: boolean;
  loadFile: () => Promise<void>;
  setContent: (content: string) => void;
  setOriginalContent: (content: string) => void;
  handleCancelLoad: () => void;
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

  const ext = parseExt(path);
  const viewerType: ViewerType | null = ext ? getViewerType(ext) : null;

  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [mediaBlobUrl, setMediaBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadedBytes, setLoadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [isChunkedLoading, setIsChunkedLoading] = useState(false);
  const [forceReadOnly, setForceReadOnly] = useState(false);
  const blobUrlRef = useRef<string | null>(null);
  const chunkedCancelRef = useRef<(() => void) | null>(null);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) { URL.revokeObjectURL(blobUrlRef.current); blobUrlRef.current = null; }
      chunkedCancelRef.current?.();
      chunkedCancelRef.current = null;
    };
  }, []);

  const handleCancelLoad = useCallback(() => {
    chunkedCancelRef.current?.();
    chunkedCancelRef.current = null;
    setIsChunkedLoading(false);
  }, []);

  // Large text files: chunked read, forced read-only — too big to round-trip.
  const runChunkedLoad = useCallback(async (size: number) => {
    setForceReadOnly(true);
    setIsChunkedLoading(true);
    setTotalBytes(size);
    const result = readFileChunked(fileOps, path, (loaded, total) => {
      setLoadedBytes(loaded);
      setTotalBytes(total);
    });
    chunkedCancelRef.current = result.cancel;
    try {
      const fullText = await result.promise;
      setContent(fullText);
      setOriginalContent(fullText);
      onDecodedRef.current(fullText);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') { return; }
      setError(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setIsChunkedLoading(false);
      setLoading(false);
      chunkedCancelRef.current = null;
    }
  }, [fileOps, path]);

  const loadFile = useCallback(async () => {
    // Cancel any in-flight chunked read from a previous load so the stale
    // resolver can't land after we reset state.
    chunkedCancelRef.current?.();
    chunkedCancelRef.current = null;

    setLoading(true);
    setError(null);
    setLoadedBytes(0);
    setTotalBytes(0);
    setIsChunkedLoading(false);

    if (fileSize && fileSize > CHUNKED_READ_THRESHOLD) {
      await runChunkedLoad(fileSize);
      return;
    }

    setForceReadOnly(false);

    try {
      const data = await fileOps.readFile(path);

      // Media files
      if (viewerType && viewerType !== 'markdown') {
        const newBlobUrl = base64ToBlobUrl(data.content, data.mime_type);
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
        }
        blobUrlRef.current = newBlobUrl;
        setMediaBlobUrl(newBlobUrl);
        return;
      }

      // Text content — decode
      const decoded = fileOps.base64Decode(data.content);
      setContent(decoded);
      setOriginalContent(decoded);
      onDecodedRef.current(decoded, data.mime_type);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setLoading(false);
    }
  }, [path, fileOps, viewerType, fileSize, runChunkedLoad]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  return {
    ext,
    viewerType,
    content,
    originalContent,
    mediaBlobUrl,
    loading,
    error,
    loadedBytes,
    totalBytes,
    isChunkedLoading,
    forceReadOnly,
    loadFile,
    setContent,
    setOriginalContent,
    handleCancelLoad,
  };
}

/**
 * State and handlers for the FileViewer component: file loading, markdown
 * detection (extension- and content-based), Preview/Raw view mode, dirty
 * tracking, and save. Extracted so the render body stays small.
 */
export function useFileViewer({ fileOps, path, filename, onClose, onDirtyChange, fileSize }: UseFileViewerParams) {
  const ext = parseExt(path);
  // Markdown detection — extension-based wins, content-based is fallback
  const isMarkdownByExt = ext ? isMarkdownExt(ext) : false;
  const [isMarkdown, setIsMarkdown] = useState(isMarkdownByExt);
  const [viewMode, setViewMode] = useState<ViewMode>(isMarkdownByExt ? 'preview' : 'raw');
  const [showSuggestion, setShowSuggestion] = useState(false);
  const suggestionDismissedRef = useRef(false);

  const [isReadOnly, setIsReadOnly] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);

  const handleDecoded = useCallback((decoded: string, mimeType?: string) => {
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
  }, [isMarkdownByExt, path]);

  const {
    viewerType, content, originalContent, mediaBlobUrl, loading, error,
    loadedBytes, totalBytes, isChunkedLoading, forceReadOnly,
    loadFile, setContent, setOriginalContent, handleCancelLoad,
  } = useFileLoader(fileOps, path, fileSize, handleDecoded);

  // Listen for MarkdownPreview error events
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ filename: string }>).detail;
      if (detail.filename === filename) {
        setViewMode('raw');
      }
    };
    window.addEventListener('markdown-preview-error', handler);
    return () => window.removeEventListener('markdown-preview-error', handler);
  }, [filename]);

  const handleEditToggle = () => {
    // Chunked-loaded files are forced read-only — too large to round-trip safely.
    if (forceReadOnly) { return; }
    setIsReadOnly((prev) => !prev);
  };

  const handleSetViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    if (mode === 'raw') { setIsReadOnly(true); }
  };

  const handleContentChange = (newContent: string) => {
    setContent(newContent);
    const dirty = newContent !== originalContent;
    setIsDirty(dirty);
    onDirtyChange?.(dirty);
  };

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await fileOps.writeFile(path, content);
      setOriginalContent(content);
      setIsDirty(false);
      onDirtyChange?.(false);
      toast.success(`Saved ${filename}`);
    } catch (err) {
      toastError(err, 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [fileOps, path, content, filename, onDirtyChange, setOriginalContent]);

  const handleCloseClick = () => {
    if (isDirty) {
      setShowUnsavedDialog(true);
      return;
    }
    onClose();
  };

  const handleConfirmClose = () => { setShowUnsavedDialog(false); onClose(); };

  const handleSuggestionPreview = () => { setViewMode('preview'); setShowSuggestion(false); };

  const handleSuggestionDismiss = () => {
    setShowSuggestion(false);
    suggestionDismissedRef.current = true;
  };

  // Determine if this is a non-markdown text file (for toolbar logic)
  const isMedia = viewerType !== null && viewerType !== 'markdown';
  const isText = !isMedia;

  return {
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
  };
}
