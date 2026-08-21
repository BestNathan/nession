import { useCallback } from 'react';
import { X, Terminal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SidePanel } from './SidePanel';
import { FileBrowser } from './FileBrowser';
import { FileViewer } from './FileViewer';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useFileTabs, type OpenFile } from '../hooks/useFileTabs';
import { BottomBar, type BottomTab } from './BottomBar';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { Tabs, TabsList, TabsTrigger } from './ui/tabs';
import { renderSlot } from '@/extensions/registry';
import type { FileOps, FileEntry } from '../services/fileOps';

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

interface FileTabBarProps {
  openFiles: OpenFile[];
  activeTabId: string;
  dirtyFiles: Set<string>;
  showTerminal: boolean;
  terminalHeaderExtensions: React.ReactNode[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

/** Horizontal tab strip: a fixed Terminal tab followed by extension tabs, then one tab per open file. */
function FileTabBar({
  openFiles,
  activeTabId,
  dirtyFiles,
  showTerminal,
  terminalHeaderExtensions,
  onSelect,
  onClose,
}: FileTabBarProps) {
  return (
    <Tabs
      value={showTerminal ? 'terminal' : activeTabId}
      onValueChange={(v) => onSelect(v)}
      className="flex-shrink-0"
    >
      <TabsList className="rounded-none border-b bg-muted/20 h-auto p-0 gap-0 overflow-x-auto w-full justify-start">
        <TabsTrigger
          value="terminal"
          className="gap-1 text-xs rounded-none border-r border-b-2 border-b-transparent data-active:border-b-primary data-active:bg-background h-auto py-1.5 px-3 flex-none"
        >
          <Terminal className="size-3" data-icon="inline-start" />
          Terminal
        </TabsTrigger>

        {/* Extension tabs */}
        {terminalHeaderExtensions}

        {openFiles.map((file) => (
          <TabsTrigger
            key={file.id}
            value={file.id}
            className="group gap-1 text-xs rounded-none border-r border-b-2 border-b-transparent data-active:border-b-primary data-active:bg-background h-auto py-1.5 px-3 flex-none max-w-[160px] [&_.tab-close]:pointer-events-auto"
          >
            <span className="truncate">{file.filename}</span>
            {dirtyFiles.has(file.id) && (
              <span className="size-1.5 rounded-full bg-amber-500 flex-shrink-0" />
            )}
            <X
              className="tab-close size-3 flex-shrink-0 opacity-0 group-hover:opacity-100 hover:text-destructive ml-0.5 transition-opacity"
              onClick={(e) => {
                e.stopPropagation();
                onClose(file.id);
              }}
            />
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
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
  const terminalHeaderExtensions = renderSlot('terminal-header', { sessionId: sessionId ?? '', sessionName: sessionName ?? '' });

  // On mobile the browser lives in the Bottom Bar; opening a file collapses the
  // sheet so the freshly opened tab is visible.
  const handleFileClickMobile = useCallback((entry: FileEntry) => {
    handleFileClick(entry);
    onSheetToggle(false);
  }, [handleFileClick, onSheetToggle]);

  // Shared main-content column (FileTabBar + terminal/file viewer + BottomBar).
  // Rendered inside the right ResizablePanel on desktop, and directly on mobile
  // where there is no side panel.
  const fileTabBar = (
    <FileTabBar
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
          <FileViewer key={activeFile.id} fileOps={fileOps} path={activeFile.path} filename={activeFile.filename} fileSize={activeFile.size} onClose={() => handleCloseFile(activeFile.id)} onDirtyChange={(dirty) => handleDirtyChange(activeFile.id, dirty)} />
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
    <>
      {!isMobile ? (
        /* Desktop: ResizablePanelGroup spans SidePanel + main content so the
           user can drag the handle to resize the file browser column. */
        <ResizablePanelGroup key={sessionId ?? 'default'} orientation="horizontal" className="gap-0">
          <ResizablePanel defaultSize="20" minSize="15" maxSize="35">
            <SidePanel>
              <FileBrowser fileOps={fileOps} onFileClick={handleFileClick} onFileDeleted={handleFileDeleted} onFileRenamed={handleFileRenamed} onGetTerminalPwd={onGetTerminalPwd} />
            </SidePanel>
          </ResizablePanel>

          <ResizableHandle className="!w-1 hover:bg-primary/50 transition-colors" />

          <ResizablePanel defaultSize="80" minSize="65">
            <div className="h-full min-w-0 flex flex-col">
              {fileTabBar}
              {content}
              {bottomBar}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        /* Mobile: no side panel — the file browser lives in BottomBar's Files
           tab. Keep the same main-content column. */
        <div className="h-full min-w-0 flex flex-col">
          {fileTabBar}
          {content}
          {bottomBar}
        </div>
      )}
    </>
  );
}
