import { useState } from 'react';
import { FileTabs } from './FileTabs';
import { EnvPanel } from './env/EnvPanel';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { MobileTerminalLayout } from './MobileTerminalLayout';
import { BottomBar, type BottomTab } from './BottomBar';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { cn } from '@/lib/utils';
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
  onGetTerminalPwd?: () => Promise<string>;
}

/**
 * Shared layout for terminal view. Both mobile and desktop layouts are
 * always mounted; CSS `hidden` toggles visibility. This preserves layout
 * state (tab positions, scroll, panel index) across resize events.
 *
 * The terminalElement is rendered only in the currently-visible layout
 * to avoid dual xterm instances. A resize that flips the breakpoint will
 * unmount and remount the terminal, but xterm reconnects automatically.
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
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const [bottomTab, setBottomTab] = useState<BottomTab>('input');
  const [sheetOpen, setSheetOpen] = useState(false);

  const envPanel = <EnvPanel sessionId={sessionId} />;
  const inputPanel = <InputPanel sendText={sendText} disabled={toolbarDisabled} />;
  const commandsPanel = <QuickCommandsPanel sendText={sendText} disabled={toolbarDisabled} />;

  // ── Desktop path (≥1024px) ──────────────────────────────────────────
  const desktopContent = fileOps ? (
    <FileTabs
      fileOps={fileOps}
      onTerminalReveal={onTerminalReveal}
      bottomTab={bottomTab}
      onBottomTabChange={setBottomTab}
      sheetOpen={sheetOpen}
      onSheetToggle={setSheetOpen}
      envPanel={envPanel}
      inputPanel={inputPanel}
      commandsPanel={commandsPanel}
      sessionId={sessionId}
      sessionName={sessionName}
      onGetTerminalPwd={onGetTerminalPwd}
      terminalElement={
        isDesktop ? (
          <div className="h-full min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 flex flex-col">{terminalElement}</div>
          </div>
        ) : null
      }
    />
  ) : (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        {isDesktop && terminalElement}
      </div>
      <BottomBar
        activeTab={bottomTab}
        onTabChange={setBottomTab}
        showFilesTab={false}
        sheetOpen={sheetOpen}
        onSheetToggle={setSheetOpen}
        envPanel={envPanel}
        inputPanel={inputPanel}
        commandsPanel={commandsPanel}
      />
    </>
  );

  // ── Layout containers always mounted, hidden with CSS ──────────────

  return (
    <>
      {/* Mobile */}
      <div className={cn('flex-1 min-h-0 flex flex-col', isDesktop && 'hidden')}>
        <MobileTerminalLayout
          terminalElement={!isDesktop ? terminalElement : null}
          sessionId={sessionId}
          sessionName={sessionName}
          sendText={sendText}
          toolbarDisabled={toolbarDisabled}
          fileOps={fileOps}
          onTerminalReveal={onTerminalReveal}
          fontSizeManager={fontSizeManager}
          onGetTerminalPwd={onGetTerminalPwd}
        />
      </div>

      {/* Desktop */}
      <div className={cn('flex-1 min-h-0 flex flex-col', !isDesktop && 'hidden')}>
        {desktopContent}
      </div>
    </>
  );
}
