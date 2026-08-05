import { useState, useEffect, useCallback } from 'react';
import { BottomSheet, type BottomTab } from './BottomSheet';
import { FloatingKeyBar } from './FloatingKeyBar';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { EnvPanel } from './env/EnvPanel';
import { FileBrowser } from './FileBrowser';
import { useVisualViewport } from '../hooks/useVisualViewport';
import { useFloatingKeyBar } from '../hooks/useFloatingKeyBar';
import type { FileOps } from '../services/fileOps';
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
  focusTerminal?: () => void;
  onGetTerminalPwd?: () => Promise<string>;
}

export function MobileTerminalLayout({
  terminalElement,
  sessionId,
  sendText,
  toolbarDisabled,
  fileOps,
  fontSizeManager,
  focusTerminal,
  onGetTerminalPwd,
}: MobileTerminalLayoutProps) {
  const { isKeyboardOpen } = useVisualViewport();
  const keyBar = useFloatingKeyBar();
  const [bottomTab, setBottomTab] = useState<BottomTab>('input');
  const [sheetCollapsed, setSheetCollapsed] = useState(false);

  // Keyboard: hide floating key bar (don't need virtual keys while typing).
  // Do NOT auto-collapse — it causes a layout-shift→refocus loop that makes
  // the keyboard bounce erratically on iOS/Android.
  useEffect(() => {
    if (isKeyboardOpen) {
      keyBar.forceHide();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isKeyboardOpen]);

  const handleToggleCollapse = useCallback(() => {
    setSheetCollapsed((prev) => !prev);
  }, []);

  const envPanel = <EnvPanel sessionId={sessionId} />;
  const commandsPanel = <QuickCommandsPanel sendText={sendText} disabled={toolbarDisabled} />;
  const inputPanel = <InputPanel sendText={sendText} disabled={toolbarDisabled} />;
  const filesPanel = fileOps ? (
    <FileBrowser
      fileOps={fileOps}
      onFileClick={() => {}}
      onFileDeleted={() => {}}
      onFileRenamed={() => {}}
      onGetTerminalPwd={onGetTerminalPwd}
    />
  ) : undefined;

  return (
    <div className="flex-1 min-h-0 flex flex-col relative">
      {/* Terminal area */}
      <div className="flex-1 min-h-0 relative">
        {terminalElement}

        {/* KeyBar trigger strip — semi-transparent hint bar that reveals the floating key bar on tap */}
        <div
          className="absolute bottom-0 left-0 right-0 h-3 z-10 bg-foreground/5"
          onTouchStart={() => keyBar.show()}
        >
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/40 pointer-events-none">
            ▲ tap for keyboard keys
          </div>
        </div>

        {/* Floating key bar overlay */}
        <FloatingKeyBar
          sendText={sendText}
          focusTerminal={focusTerminal ?? (() => {})}
          visible={keyBar.visible}
          dismissed={keyBar.dismissed}
          onShow={keyBar.show}
          onActivity={keyBar.onActivity}
          onDismiss={keyBar.dismiss}
          onRestore={keyBar.restore}
        />
      </div>

      {/* Bottom sheet */}
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
