import { useState, useEffect, useCallback } from 'react';
import { Edit3, Save } from 'lucide-react';
import { toast } from 'sonner';
import { toastError } from '@/lib/errorHelpers';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { CodeMirrorEditor } from './CodeMirrorEditor';
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
import type { FileOps } from '../services/fileOps';

export interface FileViewerProps {
  fileOps: FileOps;
  path: string;
  filename: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function FileViewer({ fileOps, path, filename, onClose, onDirtyChange }: FileViewerProps) {
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isReadOnly, setIsReadOnly] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);

  const loadFile = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fileOps.readFile(path);
      const decoded = fileOps.base64Decode(data.content);
      setContent(decoded);
      setOriginalContent(decoded);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setLoading(false);
    }
  }, [path, fileOps]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  const handleEditToggle = () => setIsReadOnly((prev) => !prev);

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
      {/* Toolbar */}
      <div className="flex items-center justify-between px-2 py-1 border-b flex-shrink-0">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="font-medium text-foreground truncate max-w-[200px]">{filename}</span>
          {isDirty && <span className="w-2 h-2 rounded-full bg-amber-500" title="Unsaved changes" />}
        </div>
        <div className="flex items-center gap-1">
          {!isReadOnly && (
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleSave} disabled={!isDirty || saving}>
              <Save className="h-3 w-3 mr-1" />{saving ? 'Saving...' : 'Save'}
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleEditToggle}>
            <Edit3 className="h-3 w-3 mr-1" />{isReadOnly ? 'Edit' : 'View'}
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-xs hover:text-destructive" onClick={handleCloseClick} aria-label="Close file" title="Close file">✕</Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex flex-col p-3 gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <div className="p-3 text-center text-sm">
            <p className="text-destructive mb-1">{error}</p>
            <Button variant="outline" size="sm" onClick={loadFile}>Retry</Button>
          </div>
        ) : (
          <CodeMirrorEditor
            value={content}
            onChange={handleContentChange}
            readOnly={isReadOnly}
            filename={filename}
          />
        )}
      </div>

      {/* Unsaved changes dialog */}
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
