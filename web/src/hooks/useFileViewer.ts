import { useState, useEffect, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { toastError } from '@/lib/errorHelpers';
import { getViewerType, parseExt, isMarkdownExt, type ViewerType } from '@/lib/viewerRegistry';
import { detectMarkdown } from '@/lib/contentDetector';
import type { FileOps } from '../services/fileOps';

export type ViewMode = 'preview' | 'raw';

export interface UseFileViewerParams {
  fileOps: FileOps;
  path: string;
  filename: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
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
  loadFile: () => Promise<void>;
  setContent: (content: string) => void;
  setOriginalContent: (content: string) => void;
}

/**
 * Read-file state: decodes text content or builds a media blob URL, tracks
 * loading/error, and calls `onDecoded` after a text file is decoded so the
 * caller can run content-based markdown detection.
 */
function useFileLoader(
  fileOps: FileOps,
  path: string,
  onDecoded: (decoded: string) => void,
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
  const blobUrlRef = useRef<string | null>(null);

  // Revoke blob URL on unmount
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, []);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
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
      onDecodedRef.current(decoded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setLoading(false);
    }
  }, [path, fileOps, viewerType]);

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
    loadFile,
    setContent,
    setOriginalContent,
  };
}

/**
 * State and handlers for the FileViewer component: file loading, markdown
 * detection (extension- and content-based), Preview/Raw view mode, dirty
 * tracking, and save. Extracted so the render body stays small.
 */
export function useFileViewer({ fileOps, path, filename, onClose, onDirtyChange }: UseFileViewerParams) {
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

  const handleDecoded = useCallback((decoded: string) => {
    // Content-based markdown detection for extensionless files
    if (!isMarkdownByExt && !ext && !suggestionDismissedRef.current) {
      const detection = detectMarkdown(decoded);

      if (detection.confidence === 'high') {
        setIsMarkdown(true);
        setViewMode('preview');
      } else if (detection.confidence === 'medium') {
        setIsMarkdown(true);
        setViewMode('raw');
        setShowSuggestion(true);
      }
      // low → do nothing, stays as plain text
    }
  }, [isMarkdownByExt, ext]);

  const {
    viewerType, content, originalContent, mediaBlobUrl, loading, error, loadFile, setContent, setOriginalContent,
  } = useFileLoader(fileOps, path, handleDecoded);

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

  const handleEditToggle = () => { setIsReadOnly((prev) => !prev); };

  const handleSetViewMode = (mode: ViewMode) => {
    setViewMode(mode);
    // Entering raw mode always starts in view-only; preview ignores readOnly.
    if (mode === 'raw') {
      setIsReadOnly(true);
    }
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

  const handleConfirmClose = () => {
    setShowUnsavedDialog(false);
    onClose();
  };

  const handleSuggestionPreview = () => {
    setViewMode('preview');
    setShowSuggestion(false);
  };

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
  };
}
