import { useState, useEffect, useCallback } from 'react';
import { Edit3, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import { cn } from '@/lib/utils';
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

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    fileOps.readFile(path)
      .then((data) => {
        if (cancelled) return;
        const decoded = fileOps.base64Decode(data.content);
        setContent(decoded);
        setOriginalContent(decoded);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to read file');
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [path, fileOps]);

  const handleEditToggle = () => setIsReadOnly((prev) => !prev);

  const handleContentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
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
      toast.error(err instanceof Error ? err.message : 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [fileOps, path, content, filename, onDirtyChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (isDirty && !isReadOnly) handleSave();
    }
  };

  const handleCloseClick = () => {
    if (isDirty) {
      if (!window.confirm('You have unsaved changes. Close anyway?')) return;
    }
    onClose();
  };

  return (
    <div className="flex flex-col h-full" onKeyDown={handleKeyDown}>
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
          <Button variant="ghost" size="sm" className="h-7 text-xs hover:text-destructive" onClick={handleCloseClick}>✕</Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="p-3 space-y-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : error ? (
          <div className="p-3 text-center text-sm">
            <p className="text-destructive mb-1">{error}</p>
            <Button variant="outline" size="sm" onClick={() => { setLoading(true); setError(null); fileOps.readFile(path).then((data) => { setContent(fileOps.base64Decode(data.content)); setOriginalContent(fileOps.base64Decode(data.content)); setLoading(false); }).catch((err) => { setError(err instanceof Error ? err.message : 'Failed'); setLoading(false); }); }}>Retry</Button>
          </div>
        ) : (
          <textarea
            value={content}
            onChange={handleContentChange}
            readOnly={isReadOnly}
            className={cn('w-full h-full resize-none bg-transparent p-3 font-mono text-xs leading-relaxed', 'focus:outline-none', isReadOnly ? 'cursor-default' : 'cursor-text')}
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
