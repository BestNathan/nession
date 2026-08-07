import { useState, useCallback, useRef } from 'react';
import { BottomSheet, type BottomTab } from './BottomSheet';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { EnvPanel } from './env/EnvPanel';
import { FileBrowser } from './FileBrowser';
import { MobileFileTabs } from './MobileFileTabs';
import type { FileOps, FileEntry } from '../services/fileOps';
import type { FontSizeManager } from '@/terminal/FontSizeManager';

interface MobileTerminalLayoutProps {
  terminalElement: React.ReactNode;
  sessionId: string;
  sessionName?: string;
  sendText: (text: string) => void;
  toolbarDisabled: boolean;
  fileOps?: FileOps | null;
  onTerminalReveal?: () => void;
  fontSizeManager?: FontSizeManager | null;
  onGetTerminalPwd?: () => Promise<string>;
}

export function MobileTerminalLayout({
  terminalElement,
  sessionId,
  sendText,
  toolbarDisabled,
  fileOps,
  fontSizeManager,
  onGetTerminalPwd,
}: MobileTerminalLayoutProps) {
  const [bottomTab, setBottomTab] = useState<BottomTab>('input');
  const [sheetCollapsed, setSheetCollapsed] = useState(false);

  const handleToggleCollapse = useCallback(() => {
    setSheetCollapsed((prev) => !prev);
  }, []);

  // Ref populated by MobileFileTabs so FileBrowser in BottomSheet
  // can trigger file opens in the tab strip above.
  const fileClickRef = useRef<((entry: FileEntry) => void) | null>(null);

  const envPanel = <EnvPanel sessionId={sessionId} />;
  const commandsPanel = <QuickCommandsPanel sendText={sendText} disabled={toolbarDisabled} />;
  const inputPanel = <InputPanel sendText={sendText} disabled={toolbarDisabled} />;
  const filesPanel = fileOps ? (
    <FileBrowser
      fileOps={fileOps}
      onFileClick={(entry) => fileClickRef.current?.(entry)}
      onFileDeleted={() => {}}
      onFileRenamed={() => {}}
      onGetTerminalPwd={onGetTerminalPwd}
    />
  ) : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {/* Mobile tab strip + content (terminal or FileViewer) */}
      {fileOps ? (
        <MobileFileTabs
          fileOps={fileOps}
          terminalElement={<div className="flex-1 min-h-0 relative">{terminalElement}</div>}
          sessionId={sessionId}
          onGetTerminalPwd={onGetTerminalPwd}
          onFileClickRef={fileClickRef}
        />
      ) : (
        <div className="flex-1 min-h-0 relative">{terminalElement}</div>
      )}
      <BottomSheet
        activeTab={bottomTab}
        onTabChange={setBottomTab}
        collapsed={sheetCollapsed}
        onToggleCollapse={handleToggleCollapse}
        showFilesTab={!!fileOps}
        fontSizeManager={fontSizeManager ?? null}
        inputPanel={inputPanel}
        commandsPanel={commandsPanel}
        envPanel={envPanel}
        filesPanel={filesPanel}
      />
    </div>
  );
}
