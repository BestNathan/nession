import { useEffect } from 'react';
import { X, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFileTabs } from '../hooks/useFileTabs';
import { FileViewer } from './FileViewer';
import type { FileOps, FileEntry } from '../services/fileOps';

interface MobileTabBarProps {
  openFiles: { id: string; path: string; filename: string }[];
  activeTabId: string;
  showTerminal: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/** Compact scrollable tab strip — no dirty dots, no extension tabs. */
function MobileTabBar({ openFiles, activeTabId, showTerminal, onSelect, onClose }: MobileTabBarProps) {
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
            'flex items-center gap-1 px-3 py-1.5 text-xs border-r border-b-2 transition-colors flex-shrink-0 max-w-[120px]',
            activeTabId === file.id ? 'border-b-primary bg-background text-foreground' : 'border-b-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          <span className="truncate">{file.filename}</span>
          <X className="h-3 w-3 flex-shrink-0 hover:text-destructive ml-0.5" onClick={(e) => { e.stopPropagation(); onClose(file.id); }} />
        </button>
      ))}
    </div>
  );
}

export interface MobileFileTabsProps {
  fileOps: FileOps;
  terminalElement: React.ReactNode;
  onTerminalReveal?: () => void;
  sessionId?: string;
  onGetTerminalPwd?: () => Promise<string>;
  /** Populated with handleFileClick so the parent can wire FileBrowser. */
  onFileClickRef: React.MutableRefObject<((entry: FileEntry) => void) | null>;
}

/**
 * Mobile file-tab layout — no SidePanel, no ResizablePanelGroup.
 *
 * Shares useFileTabs hook with desktop FileTabs. When no files are open
 * the tab strip is hidden and the terminal fills the screen (identical to
 * today's mobile experience). Clicking a file shows the tab strip +
 * FileViewer in place of the terminal.
 */
export function MobileFileTabs({
  fileOps,
  terminalElement,
  onTerminalReveal,
  onFileClickRef,
}: MobileFileTabsProps) {
  const {
    openFiles, activeTabId, setActiveTabId, activeFile, showTerminal,
    handleFileClick, handleCloseFile, handleDirtyChange,
  } = useFileTabs(onTerminalReveal);

  // Expose handleFileClick to parent so the FileBrowser in BottomSheet
  // can trigger file opens.
  useEffect(() => {
    onFileClickRef.current = handleFileClick;
  }, [handleFileClick, onFileClickRef]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Tab bar — only shown when files are open */}
      {openFiles.length > 0 && (
        <MobileTabBar
          openFiles={openFiles}
          activeTabId={activeTabId}
          showTerminal={showTerminal}
          onSelect={setActiveTabId}
          onClose={handleCloseFile}
        />
      )}

      {/* Content area — terminal or FileViewer */}
      <div className="flex-1 min-h-0 relative">
        {/* Terminal — always mounted, hidden when file tab is active */}
        <div className={cn('absolute inset-0 flex flex-col', !showTerminal && 'hidden')}>
          {terminalElement}
        </div>
        {/* FileViewer — shown when a file tab is active */}
        {!showTerminal && activeFile ? (
          <div className="absolute inset-0">
            <FileViewer
              key={activeFile.id}
              fileOps={fileOps}
              path={activeFile.path}
              filename={activeFile.filename}
              onClose={() => handleCloseFile(activeFile.id)}
              onDirtyChange={(dirty) => handleDirtyChange(activeFile.id, dirty)}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
