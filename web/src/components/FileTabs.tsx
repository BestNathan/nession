import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { X, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { generateId } from '@/lib/idGenerator';
import { SidePanel } from './SidePanel';
import { FileBrowser } from './FileBrowser';
import { FileViewer } from './FileViewer';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { BottomBar, type BottomTab } from './BottomBar';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { renderSlot } from '@/extensions/registry';
import type { FileOps, FileEntry } from '../services/fileOps';

export interface OpenFile {
  id: string;
  path: string;
  filename: string;
}

interface FileTabsProps {
  fileOps: FileOps;
  terminalElement: React.ReactNode;
  onTerminalReveal?: () => void;
  /** Bottom-bar wiring (state lifted in TerminalView; shared with the non-fileOps path). */
  bottomTab: BottomTab;
  onBottomTabChange: (tab: BottomTab) => void;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
  envPanel: React.ReactNode;
  commandsPanel: React.ReactNode;
  inputPanel?: React.ReactNode;
  sessionId?: string;
  sessionName?: string;
  /** Called to get the terminal's current working directory. */
  onGetTerminalPwd?: () => Promise<string>;
}

const MAX_TABS = 10;

interface TabBarProps {
  openFiles: OpenFile[];
  activeTabId: string;
  dirtyFiles: Set<string>;
  showTerminal: boolean;
  terminalHeaderExtensions: React.ReactNode[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/** Horizontal tab strip: a fixed Terminal tab followed by extension tabs, then one tab per open file. */
function TabBar({ openFiles, activeTabId, dirtyFiles, showTerminal, terminalHeaderExtensions, onSelect, onClose }: TabBarProps) {
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

      {/* Extension tabs */}
      {terminalHeaderExtensions}

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

/**
 * Open-file tab state: which files are open, which tab is active, dirty
 * tracking, and the handlers FileBrowser/FileViewer drive. Extracted from the
 * component to keep the render body small.
 */
function useFileTabs(onTerminalReveal?: () => void) {
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
    setOpenFiles((prev) => [...prev, { id, path: entry.path, filename: entry.name }]);
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

export function FileTabs({
  fileOps, terminalElement, onTerminalReveal,
  bottomTab, onBottomTabChange, sheetOpen, onSheetToggle, envPanel, commandsPanel, inputPanel,
  sessionId, sessionName, onGetTerminalPwd,
}: FileTabsProps) {
  const {
    openFiles, activeTabId, setActiveTabId, dirtyFiles, activeFile, showTerminal,
    handleFileClick, handleCloseFile, handleDirtyChange, handleFileDeleted, handleFileRenamed,
  } = useFileTabs(onTerminalReveal);

  const isMobile = useMediaQuery('(max-width: 1023px)');
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const terminalHeaderExtensions = renderSlot('terminal-header', { sessionId: sessionId ?? '', sessionName: sessionName ?? '' });

  // On mobile the browser lives in the Bottom Bar; opening a file collapses the
  // sheet so the freshly opened tab is visible.
  const handleFileClickMobile = useCallback((entry: FileEntry) => {
    handleFileClick(entry);
    onSheetToggle(false);
  }, [handleFileClick, onSheetToggle]);

  // Shared main-content column (TabBar + terminal/file viewer + BottomBar).
  // Rendered inside the right ResizablePanel on desktop, and directly on mobile
  // where there is no side panel.
  const tabBar = (
    <TabBar
      openFiles={openFiles}
      activeTabId={activeTabId}
      dirtyFiles={dirtyFiles}
      showTerminal={showTerminal}
      terminalHeaderExtensions={terminalHeaderExtensions}
      onSelect={setActiveTabId}
      onClose={handleCloseFile}
    />
  );

  const content = (
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
  );

  const bottomBar = (
    <BottomBar
      activeTab={bottomTab}
      onTabChange={onBottomTabChange}
      showFilesTab={isMobile}
      sheetOpen={sheetOpen}
      onSheetToggle={onSheetToggle}
      envPanel={envPanel}
      inputPanel={inputPanel}
      commandsPanel={commandsPanel}
      filesPanel={
        <FileBrowser fileOps={fileOps} onFileClick={handleFileClickMobile} onFileDeleted={handleFileDeleted} onFileRenamed={handleFileRenamed} onGetTerminalPwd={onGetTerminalPwd} />
      }
    />
  );

  return (
    <div className="flex-1 min-h-0">
      {!isMobile ? (
        /* Desktop: ResizablePanelGroup spans SidePanel + main content so the
           user can drag the handle to resize the file browser column. */
        <ResizablePanelGroup orientation="horizontal" className="gap-0">
          <ResizablePanel defaultSize={sidePanelOpen ? 20 : 0} minSize={sidePanelOpen ? 15 : 0} maxSize={35}>
            <SidePanel defaultOpen={sidePanelOpen} onOpenChange={setSidePanelOpen}>
              <FileBrowser fileOps={fileOps} onFileClick={handleFileClick} onFileDeleted={handleFileDeleted} onFileRenamed={handleFileRenamed} onGetTerminalPwd={onGetTerminalPwd} />
            </SidePanel>
          </ResizablePanel>

          {sidePanelOpen && <ResizableHandle className="!w-1 hover:bg-primary/50 transition-colors" />}

          <ResizablePanel defaultSize={sidePanelOpen ? 80 : 100} minSize={sidePanelOpen ? 65 : 100}>
            <div className="h-full min-w-0 flex flex-col">
              {tabBar}
              {content}
              {bottomBar}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        /* Mobile: no side panel — the file browser lives in BottomBar's Files
           tab. Keep the same main-content column. */
        <div className="h-full min-w-0 flex flex-col">
          {tabBar}
          {content}
          {bottomBar}
        </div>
      )}
    </div>
  );
}
