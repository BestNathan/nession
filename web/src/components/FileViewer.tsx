import { useState, useEffect, useCallback, useRef, type ComponentType } from 'react';
import { Edit3, Save } from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '@/lib/errorHelpers';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { CodeMirrorEditor } from './CodeMirrorEditor';
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
import { getViewerType, parseExt, type ViewerType } from '@/lib/viewerRegistry';
import type { FileOps } from '../services/fileOps';

export interface FileViewerProps {
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

interface FileViewerToolbarProps {
  filename: string;
  isDirty: boolean;
  isText: boolean;
  isReadOnly: boolean;
  saving: boolean;
  onSave: () => void;
  onEditToggle: () => void;
  onCloseClick: () => void;
}

function FileViewerToolbar({
  filename, isDirty, isText, isReadOnly, saving, onSave, onEditToggle, onCloseClick,
}: FileViewerToolbarProps) {
  return (
    <div className="flex items-center justify-between px-2 py-1 border-b flex-shrink-0">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground truncate max-w-[200px]">{filename}</span>
        {isDirty && <span className="w-2 h-2 rounded-full bg-amber-500" title="Unsaved changes" />}
      </div>
      <div className="flex items-center gap-1">
        {isText && !isReadOnly && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onSave} disabled={!isDirty || saving}>
            <Save className="h-3 w-3 mr-1" />{saving ? 'Saving...' : 'Save'}
          </Button>
        )}
        {isText && (
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onEditToggle}>
            <Edit3 className="h-3 w-3 mr-1" />{isReadOnly ? 'Edit' : 'View'}
          </Button>
        )}
        <Button variant="ghost" size="sm" className="h-7 text-xs hover:text-destructive" onClick={onCloseClick} aria-label="Close file" title="Close file">✕</Button>
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
  content: string;
  isReadOnly: boolean;
  onRetry: () => void;
  onChange: (value: string) => void;
}

function FileViewerContent({
  loading, error, viewerType, mediaBlobUrl, filename, content, isReadOnly, onRetry, onChange,
}: FileViewerContentProps) {
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
      ) : (
        <CodeMirrorEditor
          value={content}
          onChange={onChange}
          readOnly={isReadOnly}
          filename={filename}
        />
      )}
    </div>
  );
}

export function FileViewer({ fileOps, path, filename, onClose, onDirtyChange }: FileViewerProps) {
  const ext = parseExt(path);
  const viewerType: ViewerType | null = ext ? getViewerType(ext) : null;
  const isText = viewerType === null;

  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [mediaBlobUrl, setMediaBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
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

      if (viewerType) {
        // Media file: create blob URL
        const newBlobUrl = base64ToBlobUrl(data.content, data.mime_type);
        // Revoke previous blob URL if any
        if (blobUrlRef.current) {
          URL.revokeObjectURL(blobUrlRef.current);
        }
        blobUrlRef.current = newBlobUrl;
        setMediaBlobUrl(newBlobUrl);
      } else {
        // Text file: decode to UTF-8
        const decoded = fileOps.base64Decode(data.content);
        setContent(decoded);
        setOriginalContent(decoded);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setLoading(false);
    }
  }, [path, fileOps, viewerType]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  const handleEditToggle = () => { setIsReadOnly((prev) => !prev); };

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
  }, [fileOps, path, content, filename, onDirtyChange]);

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

  return (
    <div className="flex flex-col h-full">
      <FileViewerToolbar
        filename={filename}
        isDirty={isDirty}
        isText={isText}
        isReadOnly={isReadOnly}
        saving={saving}
        onSave={handleSave}
        onEditToggle={handleEditToggle}
        onCloseClick={handleCloseClick}
      />
      <FileViewerContent
        loading={loading}
        error={error}
        viewerType={viewerType}
        mediaBlobUrl={mediaBlobUrl}
        filename={filename}
        content={content}
        isReadOnly={isReadOnly}
        onRetry={loadFile}
        onChange={handleContentChange}
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
