import { useState, useCallback } from 'react';
import { ArrowLeft, ChevronDown, ChevronUp } from 'lucide-react';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { EnvPanel } from './env/EnvPanel';
import { FileBrowser } from './FileBrowser';
import { FileViewer } from './FileViewer';
import { SwipeableViewport } from './SwipeableViewport';
import { BottomNavIndicator } from './BottomNavIndicator';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import type { FileOps, FileEntry } from '../services/fileOps';
import type { FontSizeManager } from '@/terminal/FontSizeManager';

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

/**
 * Collapsible input bar below the terminal on mobile. Collapsed: terminal
 * fills to bottom. Expanded: tabs for Input (text entry) and Commands
 * (quick commands).
 */
function CollapsibleInputBar({
  sendText,
  disabled,
  collapsed,
  onToggle,
}: {
  sendText: (text: string) => void;
  disabled: boolean;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <Tabs defaultValue="input" className="flex-shrink-0 border-t bg-background">
      <Collapsible
        open={!collapsed}
        onOpenChange={(open) => { if (open !== !collapsed) { onToggle(); } }}
      >
        {/* Toggle bar — always visible, compact when collapsed */}
        <div className="flex items-center gap-2 px-2 h-8">
          <CollapsibleTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="gap-1 text-xs h-6"
              >
                {collapsed ? (
                  <>
                    <ChevronUp className="size-3" />
                    Input & Commands
                  </>
                ) : (
                  <>
                    <ChevronDown className="size-3" />
                    Hide
                  </>
                )}
              </Button>
            }
          />
          {/* Tab switcher — only visible when expanded */}
          {!collapsed && (
            <TabsList className="text-xs h-7">
              <TabsTrigger value="input" className="text-xs gap-1 px-2 h-6">Input</TabsTrigger>
              <TabsTrigger value="commands" className="text-xs gap-1 px-2 h-6">Commands</TabsTrigger>
            </TabsList>
          )}
        </div>

        <CollapsibleContent className="overflow-hidden">
          <div className="max-h-[35vh] overflow-y-auto border-t">
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

/**
 * Mobile terminal layout with swipe-to-switch between Terminal, Files, and Envs.
 */
export function MobileTerminalLayout({
  terminalElement,
  sessionId,
  sendText,
  toolbarDisabled,
  fileOps,
  onGetTerminalPwd,
}: MobileTerminalLayoutProps) {
  const [activePanel, setActivePanel] = useState(0);
  const [inputCollapsed, setInputCollapsed] = useState(true);

  const {
    selectedFile,
    handleFileClick,
    handleBack,
    handleFileDeleted,
    handleFileRenamed,
  } = useFilesPanelNav();

  const panels = [
    // Panel 0: Terminal
    <div key="terminal" className="h-full flex flex-col">
      {terminalElement ? (
        <div className="flex-1 min-h-0 relative">{terminalElement}</div>
      ) : (
        <div className="flex-1 min-h-0" />
      )}
      <CollapsibleInputBar
        sendText={sendText}
        disabled={toolbarDisabled}
        collapsed={inputCollapsed}
        onToggle={() => setInputCollapsed((prev) => !prev)}
      />
    </div>,

    // Panel 1: Files
    <div key="files" className="h-full flex flex-col">
      {fileOps ? (
        selectedFile ? (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex items-center gap-2 px-2 py-1 border-b flex-shrink-0">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      onClick={handleBack}
                      aria-label="Back to files"
                    />
                  }
                >
                  <ArrowLeft className="size-4" />
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p>Back to files</p>
                </TooltipContent>
              </Tooltip>
              <span className="text-xs truncate">{selectedFile.name}</span>
            </div>
            <div className="flex-1 min-h-0">
              <FileViewer
                key={selectedFile.path}
                fileOps={fileOps}
                path={selectedFile.path}
                filename={selectedFile.name}
                onClose={handleBack}
                onDirtyChange={() => {}}
              />
            </div>
          </div>
        ) : (
          <FileBrowser
            fileOps={fileOps}
            onFileClick={handleFileClick}
            onFileDeleted={handleFileDeleted}
            onFileRenamed={handleFileRenamed}
            onGetTerminalPwd={onGetTerminalPwd}
          />
        )
      ) : (
        <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
          File browser unavailable
        </div>
      )}
    </div>,

    // Panel 2: Envs
    <div key="envs" className="h-full">
      <EnvPanel sessionId={sessionId} />
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
      <BottomNavIndicator count={3} activeIndex={activePanel} />
    </div>
  );
}
