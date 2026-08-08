import { useState, useCallback } from 'react';
import { ChevronDown, ChevronUp, Square, Trash2, Search } from 'lucide-react';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { EnvPanel } from './env/EnvPanel';
import { FileBrowser } from './FileBrowser';
import { FileViewer } from './FileViewer';
import { SwipeableViewport } from './SwipeableViewport';
import { Button } from './ui/button';
import { Separator } from './ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import type { FileOps, FileEntry } from '../services/fileOps';
import type { FontSizeManager } from '@/terminal/FontSizeManager';
import { cn } from '@/lib/utils';

interface MobileTerminalLayoutProps {
  terminalElement: React.ReactNode | null;
  sessionId: string;
  sessionName?: string;
  sendText: (text: string) => void;
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
 * Collapsible input bar below the terminal. Collapsed: compact toolbar
 * with quick-action buttons. Expanded: full Tabs (Input | Commands).
 * Triggers onReveal after animation so the terminal refits.
 */
function TerminalInputBar({
  sendText,
  disabled,
  collapsed,
  onToggle,
  onReveal,
}: TerminalInputBarProps) {
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (open !== !collapsed) {
        onToggle();
        // Wait for collapse animation (~250ms), then trigger terminal refit
        setTimeout(() => onReveal?.(), 250);
      }
    },
    [collapsed, onToggle, onReveal],
  );

  return (
    <Tabs defaultValue="input" className="flex-shrink-0 border-t bg-background">
      <Collapsible open={!collapsed} onOpenChange={handleOpenChange}>
        {/* Toolbar — always visible */}
        <div className="flex items-center gap-1 px-2 h-9">
          {/* Collapse toggle */}
          <CollapsibleTrigger
            render={
              <Button variant="ghost" size="sm" className="gap-1 text-xs h-7">
                {collapsed ? (
                  <ChevronUp className="size-3" data-icon="inline-start" />
                ) : (
                  <ChevronDown className="size-3" data-icon="inline-start" />
                )}
                {collapsed ? 'Input & Commands' : 'Hide'}
              </Button>
            }
          />

          {/* Spacer */}
          <div className="flex-1" />

          {/* Quick-action buttons — only when collapsed */}
          {collapsed && (
            <>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => sendText('\x03')}
                      disabled={disabled}
                      aria-label="Send Ctrl-C"
                    />
                  }
                >
                  <Square className="size-3.5" data-icon />
                </TooltipTrigger>
                <TooltipContent side="top"><p>Ctrl-C</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => sendText('clear\n')}
                      disabled={disabled}
                      aria-label="Clear terminal"
                    />
                  }
                >
                  <Trash2 className="size-3.5" data-icon />
                </TooltipTrigger>
                <TooltipContent side="top"><p>Clear</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={() => sendText('\x12')}
                      disabled={disabled}
                      aria-label="Send Ctrl-R"
                    />
                  }
                >
                  <Search className="size-3.5" data-icon />
                </TooltipTrigger>
                <TooltipContent side="top"><p>Ctrl-R</p></TooltipContent>
              </Tooltip>
            </>
          )}

          {/* Tab switcher — only visible when expanded */}
          {!collapsed && (
            <TabsList className="text-xs h-7">
              <TabsTrigger value="input" className="text-xs gap-1 px-2 h-6">
                Input
              </TabsTrigger>
              <TabsTrigger value="commands" className="text-xs gap-1 px-2 h-6">
                Commands
              </TabsTrigger>
            </TabsList>
          )}
        </div>

        {/* Content — only when expanded */}
        <CollapsibleContent className="overflow-hidden">
          <Separator />
          <div className="max-h-[35vh] overflow-y-auto">
            <TabsContent value="input" className="mt-0">
              <InputPanel sendText={sendText} disabled={disabled} />
            </TabsContent>
            <TabsContent value="commands" className="mt-0">
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
 * Simple stack: FileBrowser → FileViewer with back arrow.
 */
function useFilesPanelNav() {
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);

  const handleFileClick = useCallback((entry: FileEntry) => {
    setSelectedFile(entry);
  }, []);

  const handleBack = useCallback(() => {
    setSelectedFile(null);
  }, []);

  const handleFileDeleted = useCallback((path: string) => {
    if (selectedFile && selectedFile.path === path) {
      setSelectedFile(null);
    }
  }, [selectedFile]);

  const handleFileRenamed = useCallback((oldPath: string, newPath: string) => {
    setSelectedFile((prev) => {
      if (prev && prev.path === oldPath) {
        const newName = newPath.split('/').pop() || newPath;
        return { ...prev, path: newPath, name: newName };
      }
      return prev;
    });
  }, []);

  return {
    selectedFile,
    handleFileClick,
    handleBack,
    handleFileDeleted,
    handleFileRenamed,
  };
}

interface FilesPanelProps {
  fileOps: FileOps;
  onGetTerminalPwd?: () => Promise<string>;
}

/**
 * Files panel with top-bottom split layout.
 * Top: FileViewer (or empty state) — flex-[6] when browser visible, flex-1 when collapsed
 * Bottom: Collapsible FileBrowser — flex-[4] when visible, hidden when collapsed
 */
function FilesPanel({ fileOps, onGetTerminalPwd }: FilesPanelProps) {
  const [browserCollapsed, setBrowserCollapsed] = useState(false);
  const {
    selectedFile,
    handleFileClick,
    handleFileDeleted,
    handleFileRenamed,
  } = useFilesPanelNav();

  return (
    <div className="h-full flex flex-col">
      {/* FileViewer area */}
      <div
        className={cn(
          'min-h-0 flex flex-col',
          browserCollapsed ? 'flex-1' : 'flex-[6]',
        )}
      >
        {selectedFile ? (
          <>
            {/* File header bar */}
            <div className="flex items-center gap-2 px-2 py-1 border-b flex-shrink-0">
              <span className="text-xs font-medium truncate">{selectedFile.name}</span>
            </div>
            <div className="flex-1 min-h-0">
              <FileViewer
                key={selectedFile.path}
                fileOps={fileOps}
                path={selectedFile.path}
                filename={selectedFile.name}
                onClose={() => {}}
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

      {/* Browser area */}
      <div
        className={cn(
          'border-t bg-background flex-shrink-0 flex flex-col',
          browserCollapsed ? 'hidden' : 'flex-[4] min-h-0',
        )}
      >
        {/* Collapse toggle */}
        <div className="flex items-center px-2 h-8 flex-shrink-0">
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
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <FileBrowser
            fileOps={fileOps}
            onFileClick={handleFileClick}
            onFileDeleted={handleFileDeleted}
            onFileRenamed={handleFileRenamed}
            onGetTerminalPwd={onGetTerminalPwd}
          />
        </div>
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
        <div className="flex-1 min-h-0 relative">{terminalElement}</div>
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
