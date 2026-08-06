import { useState } from 'react';
import { BottomBar, type BottomTab } from './BottomBar';
import { FileTabs } from './FileTabs';
import { EnvPanel } from './env/EnvPanel';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { MobileTerminalLayout } from './MobileTerminalLayout';
import { useMediaQuery } from '../hooks/useMediaQuery';
import type { FileOps } from '../services/fileOps';
import type { FontSizeManager } from '@/terminal/FontSizeManager';

interface TerminalLayoutProps {
  terminalElement: React.ReactNode;
  sessionId: string;
  sessionName?: string;
  sendText: (text: string) => void;
  toolbarDisabled: boolean;
  fileOps?: FileOps | null;
  onTerminalReveal?: () => void;
  fontSizeManager?: FontSizeManager | null;
  /** Called to get the terminal's current working directory. */
  onGetTerminalPwd?: () => Promise<string>;
}

/**
 * Shared layout for terminal view. Mobile (≤1023px) delegates to
 * MobileTerminalLayout with FloatingKeyBar + BottomSheet. Desktop uses
 * the existing FileTabs + BottomBar pattern with shared InputPanel and
 * QuickCommandsPanel.
 */
export function TerminalLayout({
  terminalElement,
  sessionId,
  sessionName,
  sendText,
  toolbarDisabled,
  fileOps,
  onTerminalReveal,
  fontSizeManager,
  onGetTerminalPwd,
}: TerminalLayoutProps) {
  const isMobile = useMediaQuery('(max-width: 1023px)');
  // Desktop-only state — must be called unconditionally (rules-of-hooks)
  const [bottomTab, setBottomTab] = useState<BottomTab>('commands');
  const [sheetOpen, setSheetOpen] = useState(false);

  // Mobile path — completely separate layout with FloatingKeyBar + BottomSheet
  if (isMobile) {
    return (
      <MobileTerminalLayout
        terminalElement={terminalElement}
        sessionId={sessionId}
        sessionName={sessionName}
        sendText={sendText}
        toolbarDisabled={toolbarDisabled}
        fileOps={fileOps}
        onTerminalReveal={onTerminalReveal}
        fontSizeManager={fontSizeManager}
        onGetTerminalPwd={onGetTerminalPwd}
      />
    );
  }

  // ── Desktop path (≥1024px) ──────────────────────────────────────────

  const envPanel = <EnvPanel sessionId={sessionId} />;
  const commandsPanel = (
    <div className="flex flex-col min-h-0">
      <InputPanel sendText={sendText} disabled={toolbarDisabled} />
      <QuickCommandsPanel sendText={sendText} disabled={toolbarDisabled} />
    </div>
  );

  if (fileOps) {
    return (
      <FileTabs
        fileOps={fileOps}
        onTerminalReveal={onTerminalReveal}
        bottomTab={bottomTab}
        onBottomTabChange={setBottomTab}
        sheetOpen={sheetOpen}
        onSheetToggle={setSheetOpen}
        envPanel={envPanel}
        commandsPanel={commandsPanel}
        sessionId={sessionId}
        sessionName={sessionName}
        onGetTerminalPwd={onGetTerminalPwd}
        terminalElement={
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 flex flex-col">{terminalElement}</div>
          </div>
        }
      />
    );
  }

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">{terminalElement}</div>
      <BottomBar
        activeTab={bottomTab}
        onTabChange={setBottomTab}
        showFilesTab={false}
        sheetOpen={sheetOpen}
        onSheetToggle={setSheetOpen}
        envPanel={envPanel}
        commandsPanel={commandsPanel}
      />
    </>
  );
}
