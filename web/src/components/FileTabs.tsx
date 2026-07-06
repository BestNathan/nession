import { useState, useCallback, useEffect, useRef } from 'react';
import { X, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SidePanel } from './SidePanel';
import { FileBrowser } from './FileBrowser';
import { FileViewer } from './FileViewer';
import type { FileOps, FileEntry } from '../services/fileOps';

export interface OpenFile {
  id: string;
  path: string;
  filename: string;
}

interface FileTabsProps {
  fileOps: FileOps;
  terminalElement: React.ReactNode;
  /**
   * Called when the terminal tab becomes visible again after a file tab was
   * shown. Lets the parent refit the terminal, which cannot measure itself
   * while hidden (display:none).
   */
  onTerminalReveal?: () => void;
}

const MAX_TABS = 10;

interface TabBarProps {
  openFiles: OpenFile[];
  activeTabId: string;
  dirtyFiles: Set<string>;
  showTerminal: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/** Horizontal tab strip: a fixed Terminal tab followed by one tab per open file. */
function TabBar({ openFiles, activeTabId, dirtyFiles, showTerminal, onSelect, onClose }: TabBarProps) {
  return (
    <div className="flex items-center border-b bg-muted/20 flex-shrink-0 overflow-x-auto">
      <button
        onClick={() => onSelect('terminal')}
        className={cn(
          'flex items-center gap-1 px-3 py-1.5 text-xs border-r border-b-2 transition-colors flex-shrink-0',
          showTerminal ? 'border-b-primary bg-background text-foreground' : 'border-b-transparent text-muted-foreground hover:text-foreground',
        )}
      >
        <Terminal className="h-3 w-3" /> Terminal
      </button>

      {openFiles.map((file) => (
        <button
          key={file.id}
          onClick={() => onSelect(file.id)}
          className={cn(
            'flex items-center gap-1 px-3 py-1.5 text-xs border-r border-b-2 transition-colors flex-shrink-0 max-w-[160px]',
            activeTabId === file.id ? 'border-b-primary bg-background text-foreground' : 'border-b-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <span className="truncate">{file.filename}</span>
          {dirtyFiles.has(file.id) && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" />}
          <X className="h-3 w-3 flex-shrink-0 hover:text-destructive ml-0.5" onClick={(e) => { e.stopPropagation(); onClose(file.id); }} />
        </button>
      ))}
    </div>
  );
}

export function FileTabs({ fileOps, terminalElement, onTerminalReveal }: FileTabsProps) {
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
        alert(`Maximum ${MAX_TABS} files open. Close some first.`);
        return;
      }
    }

    const id = `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setOpenFiles((prev) => [...prev, { id, path: entry.path, filename: entry.name }]);
    setActiveTabId(id);
  }, [openFiles, dirtyFiles]);

  const handleCloseFile = useCallback((id: string) => {
    if (dirtyFiles.has(id)) {
      if (!window.confirm('Unsaved changes will be lost. Close anyway?')) {return;}
    }
    setOpenFiles((prev) => {
      const filtered = prev.filter((f) => f.id !== id);
      if (activeTabId === id) {
        setActiveTabId(filtered.length > 0 ? filtered[filtered.length - 1].id : 'terminal');
      }
      return filtered;
    });
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, [activeTabId, dirtyFiles]);

  const handleDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyFiles((prev) => {
      const next = new Set(prev);
      if (dirty) {next.add(id);}
      else {next.delete(id);}
      return next;
    });
  }, []);

  const handleFileDeleted = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const filtered = prev.filter((f) => f.path !== path);
      if (prev.length !== filtered.length) {
        const deletedFile = prev.find((f) => f.path === path);
        if (deletedFile && activeTabId === deletedFile.id) {
          setActiveTabId(filtered.length > 0 ? filtered[filtered.length - 1].id : 'terminal');
        }
        // Clean up dirty tracking for the deleted file
        if (deletedFile) {
          setDirtyFiles((prevDirty) => {
            const next = new Set(prevDirty);
            next.delete(deletedFile.id);
            return next;
          });
        }
      }
      return filtered;
    });
  }, [activeTabId]);

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

  return (
    <div className="flex-1 min-h-0 flex flex-row">
      <SidePanel>
        <FileBrowser fileOps={fileOps} onFileClick={handleFileClick} onFileDeleted={handleFileDeleted} onFileRenamed={handleFileRenamed} />
      </SidePanel>

      <div className="flex-1 min-w-0 flex flex-col">
        {/* Tab bar */}
        <TabBar
          openFiles={openFiles}
          activeTabId={activeTabId}
          dirtyFiles={dirtyFiles}
          showTerminal={showTerminal}
          onSelect={setActiveTabId}
          onClose={handleCloseFile}
        />

        {/* Content */}
        <div className="flex-1 min-h-0 relative">
          {/* Terminal stays mounted at all times — hidden (not unmounted) when a
              file tab is active — so its xterm instance and scrollback survive
              tab switches. `hidden` sets display:none; refit happens on reveal. */}
          <div className={cn('absolute inset-0', !showTerminal && 'hidden')}>
            {terminalElement}
          </div>
          {!showTerminal && activeFile ? (
            <div className="absolute inset-0">
              <FileViewer key={activeFile.id} fileOps={fileOps} path={activeFile.path} filename={activeFile.filename} onClose={() => handleCloseFile(activeFile.id)} onDirtyChange={(dirty) => handleDirtyChange(activeFile.id, dirty)} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
