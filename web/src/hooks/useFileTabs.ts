import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { toast } from 'sonner';
import { generateId } from '@/lib/idGenerator';
import type { FileEntry } from '@/features/files';

export interface OpenFile {
  id: string;
  path: string;
  filename: string;
  /** File size in bytes at the time of open — drives chunked-load threshold in FileViewer. */
  size: number;
}

export const MAX_TABS = 10;

/**
 * Open-file tab state: which files are open, which tab is active, dirty
 * tracking, and the handlers FileBrowser/FileViewer drive. Extracted from the
 * component to keep the render body small.
 */
export function useFileTabs(onTerminalReveal?: () => void) {
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('terminal');
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(new Set());

  const handleFileClick = useCallback((entry: FileEntry) => {
    const existing = openFiles.find((f) => f.path === entry.path);
    if (existing) {
      setActiveTabId(existing.id);
      return;
    }

    if (openFiles.length >= MAX_TABS) {
      const toClose = openFiles.find((f) => !dirtyFiles.has(f.id));
      if (toClose) {
        setOpenFiles((prev) => prev.filter((f) => f.id !== toClose.id));
      } else {
        toast.error(`Maximum ${MAX_TABS} files open. Close some first.`);
        return;
      }
    }

    const id = generateId('file');
    setOpenFiles((prev) => [...prev, { id, path: entry.path, filename: entry.name, size: entry.size }]);
    setActiveTabId(id);
  }, [openFiles, dirtyFiles]);

  const handleCloseFile = useCallback((id: string) => {
    setOpenFiles((prev) => prev.filter((f) => f.id !== id));
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const handleDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      if (dirty) {next.add(id);}
      else {next.delete(id);}
      return next;
    });
  }, []);

  const handleFileDeleted = useCallback((path: string) => {
    // Look up the file ID from current openFiles. We depend on openFiles so
    // this is always in sync — the ref-based approach could be stale by one
    // frame when multiple state updates batch in the same tick. (#71 #7)
    const deletedFile = openFiles.find((f) => f.path === path);
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));
    if (deletedFile) {
      setDirtyFiles((prev) => {
        const next = new Set(prev);
        next.delete(deletedFile.id);
        return next;
      });
    }
  }, [openFiles]);

  const handleFileRenamed = useCallback((oldPath: string, newPath: string) => {
    const newFilename = newPath.split('/').pop() || newPath;
    setOpenFiles((prev) =>
      prev.map((f) =>
        f.path === oldPath ? { ...f, path: newPath, filename: newFilename } : f,
      ),
    );
  }, []);

  const activeFile = openFiles.find((f) => f.id === activeTabId);
  const showTerminal = activeTabId === 'terminal';

  // If the active tab was closed, switch to the last remaining tab or terminal.
  // useLayoutEffect runs before paint so the user never sees a blank frame
  // where activeFile is undefined. (#71 #2)
  useLayoutEffect(() => {
    if (activeTabId !== 'terminal' && !openFiles.find((f) => f.id === activeTabId)) {
      setActiveTabId(openFiles.length > 0 ? openFiles[openFiles.length - 1].id : 'terminal');
    }
  }, [activeTabId, openFiles, setActiveTabId]);

  // Refit the terminal whenever it transitions back into view. It stays mounted
  // (hidden via CSS) so its xterm instance + scrollback survive tab switches,
  // but xterm can't measure itself while display:none, so it needs a refit on
  // reveal. Skip the very first mount (already fits itself on open).
  const wasTerminalVisibleRef = useRef(showTerminal);
  useEffect(() => {
    if (showTerminal && !wasTerminalVisibleRef.current) {
      onTerminalReveal?.();
    }
    wasTerminalVisibleRef.current = showTerminal;
  }, [showTerminal, onTerminalReveal]);

  return {
    openFiles, activeTabId, setActiveTabId, dirtyFiles, activeFile, showTerminal,
    handleFileClick, handleCloseFile, handleDirtyChange, handleFileDeleted, handleFileRenamed,
  };
}
