import { useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, Square, Trash2, Search, CornerDownLeft, X } from 'lucide-react';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { EnvPanel } from './env/EnvPanel';
import { FileBrowser } from './FileBrowser';
import { FileViewer } from './FileViewer';
import { SwipeableViewport } from './SwipeableViewport';
import { TerminalScrollOverlay } from './TerminalScrollOverlay';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import type { FileOps, FileEntry } from '../services/fileOps';
import type { FontSizeManager } from '@/terminal/FontSizeManager';
import { cn } from '@/lib/utils';

interface MobileTerminalLayoutProps {
  terminalElement: React.ReactNode | null;
  sessionId: string;
  sessionName?: string;
  sendText: (text: string) => void;
  /** Scroll the terminal scrollback by pages (negative = towards history). */
  onScrollPages: (pages: number) => void;
  /** Jump the terminal viewport to the newest output. */
  onScrollToBottom: () => void;
  toolbarDisabled: boolean;
  fileOps?: FileOps | null;
  onTerminalReveal?: () => void;
  fontSizeManager?: FontSizeManager | null;
  onGetTerminalPwd?: () => Promise<string>;
}

interface TerminalInputBarProps {
  sendText: (text: string) => void;
  disabled: boolean;
  collapsed: boolean;
  onToggle: () => void;
  onReveal?: () => void;
}

/**
 * Mobile terminal input bar redesigned for touch:
 * - h-10 toolbar with minimum 40px touch targets
 * - Collapsed: expand chevron + quick-action buttons (Ctrl-C, Enter, Clear, Search)
 * - Expanded: Tabs (Input|Commands) integrated in toolbar + close button
 * - Both tab panels share a fixed 30vh container — no height jumping
 */
function TerminalInputBar({
  sendText,
  disabled,
  collapsed,
  onToggle,
  onReveal,
}: TerminalInputBarProps) {
  const [activeTab, setActiveTab] = useState('input');

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open !== !collapsed) {
        onToggle();
        setTimeout(() => onReveal?.(), 250);
      }
    },
    [collapsed, onToggle, onReveal],
  );

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-shrink-0 border-t bg-background">
      <Collapsible open={!collapsed} onOpenChange={handleOpenChange}>
        {/* Toolbar — always visible, fixed height */}
        <div className="flex items-center gap-1.5 px-2 h-10">
          {/* Expand toggle — always present */}
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                className={cn('h-9 w-9', !collapsed && 'text-primary')}
                aria-label={collapsed ? 'Open input panel' : 'Close input panel'}
              >
                <ChevronUp
                  className={cn(
                    'size-4 transition-transform duration-200',
                    collapsed && 'rotate-180',
                  )}
                  data-icon
                />
              </Button>
            }
          />

          {/* Collapsed state: text label + quick actions */}
          {collapsed ? (
            <>
              <span className="text-xs text-muted-foreground font-medium select-none">
                Input
              </span>
              <div className="flex-1" />

              {/* Quick-action buttons — 5 equal-size touch targets */}
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => sendText('\x03')} disabled={disabled} aria-label="Ctrl-C"><Square className="size-4" data-icon /></Button>
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => sendText(' ')} disabled={disabled} aria-label="Space"><span className="text-[11px] font-mono font-bold">⎵</span></Button>
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => sendText('\r')} disabled={disabled} aria-label="Enter"><CornerDownLeft className="size-4" data-icon /></Button>
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => sendText('clear\n')} disabled={disabled} aria-label="Clear"><Trash2 className="size-4" data-icon /></Button>
              <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => sendText('\x12')} disabled={disabled} aria-label="Ctrl-R"><Search className="size-4" data-icon /></Button>
            </>
          ) : (
            <>
              {/* Expanded state: Tabs in toolbar + spacer + close */}
              <TabsList className="text-xs h-8">
                <TabsTrigger value="input" className="text-xs px-2.5 h-7">
                  Input
                </TabsTrigger>
                <TabsTrigger value="commands" className="text-xs px-2.5 h-7">
                  Commands
                </TabsTrigger>
              </TabsList>
              <div className="flex-1" />
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9"
                onClick={onToggle}
                aria-label="Close input panel"
              >
                <X className="size-4" data-icon />
              </Button>
            </>
          )}
        </div>

        {/* Content — fixed height, panels handle their own scroll */}
        <CollapsibleContent className="overflow-hidden">
          <Separator />
          <div className="h-[30vh] overflow-hidden">
            <TabsContent value="input" className="mt-0 h-full">
              <InputPanel sendText={sendText} disabled={disabled} />
            </TabsContent>
            <TabsContent value="commands" className="mt-0 h-full">
              <QuickCommandsPanel sendText={sendText} disabled={disabled} />
            </TabsContent>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Tabs>
  );
}

/**
 * Internal file navigation state for the Files panel on mobile.
 * Supports multiple open files with tab switching.
 */
function useFilesPanelNav() {
  const [openFiles, setOpenFiles] = useState<FileEntry[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  const handleFileClick = useCallback((entry: FileEntry) => {
    setOpenFiles((prev) => {
      const existing = prev.findIndex((f) => f.path === entry.path);
      if (existing >= 0) {
        setActiveIndex(existing);
        return prev;
      }
      setActiveIndex(prev.length);
      return [...prev, entry];
    });
  }, []);

  const handleTabClose = useCallback((index: number) => {
    setOpenFiles((prev) => {
      const next = prev.filter((_, i) => i !== index);
      if (next.length === 0) { return next; }
      setActiveIndex((a) => Math.min(a, next.length - 1));
      return next;
    });
  }, []);

  const handleFileDeleted = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const idx = prev.findIndex((f) => f.path === path);
      const next = prev.filter((f) => f.path !== path);
      if (next.length === 0) { return next; }
      if (idx >= 0 && activeIndex >= idx) { setActiveIndex(Math.max(0, activeIndex - 1)); }
      return next;
    });
  }, [activeIndex]);

  const handleFileRenamed = useCallback((oldPath: string, newPath: string) => {
    setOpenFiles((prev) => prev.map((f) => {
      if (f.path === oldPath) {
        const newName = newPath.split('/').pop() || newPath;
        return { ...f, path: newPath, name: newName };
      }
      return f;
    }));
  }, []);

  return {
    openFiles, activeIndex,
    handleFileClick, handleTabClose,
    handleFileDeleted, handleFileRenamed,
    setActiveIndex,
  };
}

interface FilesPanelProps {
  fileOps: FileOps;
  onGetTerminalPwd?: () => Promise<string>;
}

/**
 * Files panel with multi-tab viewer + collapsible file browser.
 * Top: File tabs + viewer (or empty state)
 * Bottom: Collapsible FileBrowser — slim bar when collapsed, flex-[4] when open
 */
function FilesPanel({ fileOps, onGetTerminalPwd }: FilesPanelProps) {
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const {
    openFiles, activeIndex,
    handleFileClick, handleTabClose,
    handleFileDeleted, handleFileRenamed,
    setActiveIndex,
  } = useFilesPanelNav();

  const activeFile = openFiles[activeIndex] ?? null;

  return (
    <div className="h-full flex flex-col">
      {/* FileViewer area */}
      <div
        className={cn(
          'min-h-0 flex flex-col',
          browserCollapsed ? 'flex-1' : 'flex-[6]',
        )}
      >
        {openFiles.length > 0 && activeFile ? (
          <>
            {/* Tab bar */}
            <div className="flex items-center gap-0.5 px-1 py-0.5 border-b flex-shrink-0 overflow-x-auto">
              {openFiles.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  className={cn(
                    'flex items-center gap-1 px-2 py-0.5 text-xs rounded-t whitespace-nowrap max-w-[120px]',
                    i === activeIndex
                      ? 'bg-background border border-b-background -mb-px'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                  onClick={() => setActiveIndex(i)}
                >
                  <span className="truncate">{f.name}</span>
                  <X
                    className="size-3 flex-shrink-0 hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); handleTabClose(i); }}
                  />
                </button>
              ))}
            </div>
            {/* Viewer */}
            <div className="flex-1 min-h-0">
              <FileViewer
                key={activeFile.path}
                fileOps={fileOps}
                path={activeFile.path}
                filename={activeFile.name}
                onClose={() => handleTabClose(activeIndex)}
                onDirtyChange={() => {}}
              />
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Select a file to view
          </div>
        )}
      </div>

      {/* Browser area — always shows toggle, collapsible content */}
      <div
        className={cn(
          'border-t bg-background flex-shrink-0 flex flex-col',
          browserCollapsed ? '' : 'flex-[4] min-h-0',
        )}
      >
        <div className="flex items-center px-2 h-7 flex-shrink-0 gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-xs h-6"
            onClick={() => setBrowserCollapsed((prev) => !prev)}
          >
            {browserCollapsed ? (
              <ChevronUp className="size-3" data-icon="inline-start" />
            ) : (
              <ChevronDown className="size-3" data-icon="inline-start" />
            )}
            Files
          </Button>
          {browserCollapsed && openFiles.length > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {openFiles.length} open
            </span>
          )}
        </div>
        {!browserCollapsed && (
          <div className="flex-1 min-h-0 overflow-hidden">
            <FileBrowser
              fileOps={fileOps}
              onFileClick={handleFileClick}
              onFileDeleted={handleFileDeleted}
              onFileRenamed={handleFileRenamed}
              onGetTerminalPwd={onGetTerminalPwd}
            />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Mobile terminal layout with swipe-to-switch between Terminal, Files, and Envs.
 */
export function MobileTerminalLayout({
  terminalElement,
  sessionId,
  sendText,
  onScrollPages,
  onScrollToBottom,
  toolbarDisabled,
  fileOps,
  onTerminalReveal,
  onGetTerminalPwd,
}: MobileTerminalLayoutProps) {
  const [activePanel, setActivePanel] = useState(0);
  const [inputCollapsed, setInputCollapsed] = useState(true);

  const panels = [
    // Panel 0: Terminal
    <div key="terminal" className="h-full flex flex-col">
      {terminalElement ? (
        <div className="flex-1 min-h-0 relative flex flex-col">
          {terminalElement}
          <TerminalScrollOverlay
            onScrollPages={onScrollPages}
            onScrollToBottom={onScrollToBottom}
          />
        </div>
      ) : (
        <div className="flex-1 min-h-0" />
      )}
      <TerminalInputBar
        sendText={sendText}
        disabled={toolbarDisabled}
        collapsed={inputCollapsed}
        onToggle={() => setInputCollapsed((prev) => !prev)}
        onReveal={onTerminalReveal}
      />
    </div>,

    // Panel 1: Files
    <div key="files" className="h-full flex flex-col">
      <div className="flex items-center px-3 h-7 border-b flex-shrink-0">
        <span className="text-xs text-muted-foreground font-medium">Files</span>
      </div>
      <div className="flex-1 min-h-0">
        {fileOps ? (
          <FilesPanel fileOps={fileOps} onGetTerminalPwd={onGetTerminalPwd} />
        ) : (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            File browser unavailable
          </div>
        )}
      </div>
    </div>,

    // Panel 2: Envs
    <div key="envs" className="h-full flex flex-col">
      <div className="flex items-center px-3 h-7 border-b flex-shrink-0">
        <span className="text-xs text-muted-foreground font-medium">Environment</span>
      </div>
      <div className="flex-1 min-h-0">
        <EnvPanel sessionId={sessionId} />
      </div>
    </div>,
  ];

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <SwipeableViewport
        activeIndex={activePanel}
        onIndexChange={setActivePanel}
      >
        {panels}
      </SwipeableViewport>
    </div>
  );
}
