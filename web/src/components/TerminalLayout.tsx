import { useState, useEffect } from 'react';
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
import type { TerminalController } from '@/terminal/controller/TerminalController';

interface TerminalLayoutProps {
  terminalElement: React.ReactNode;
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
  controller?: TerminalController | null;
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
  onScrollPages,
  onScrollToBottom,
  toolbarDisabled,
  fileOps,
  onTerminalReveal,
  fontSizeManager,
  onGetTerminalPwd,
  controller,
}: TerminalLayoutProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [bottomTab, setBottomTab] = useState<BottomTab>('input');
  const [sheetOpen, setSheetOpen] = useState(false);

  // Desktop keyboard input handling
  useEffect(() => {
    if (!isDesktop || !controller) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if target is an input/textarea (let native handling work)
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Ignore modifier-only keys
      if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') {
        return;
      }

      // Let xterm handle the keyboard input via its own event system
      // This useEffect is just to ensure the desktop layout is properly separated
      // The actual keyboard handling happens in xterm's TerminalInputHandler
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDesktop, controller]);

  const envPanel = <EnvPanel sessionId={sessionId} />;
  const inputPanel = <InputPanel sendText={(text) => {
    if (toolbarDisabled) {return;}
    controller?.handleInput({
      source: 'component-input',
      data: text,
      timestamp: Date.now(),
    });
  }} disabled={toolbarDisabled} />;
  const commandsPanel = <QuickCommandsPanel sendText={(text) => {
    if (toolbarDisabled) {return;}
    controller?.handleInput({
      source: 'component-quickcmd',
      data: text,
      timestamp: Date.now(),
    });
  }} disabled={toolbarDisabled} />;

  // ── Desktop path (≥768px) ──────────────────────────────────────────
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
          onScrollPages={onScrollPages}
          onScrollToBottom={onScrollToBottom}
          toolbarDisabled={toolbarDisabled}
          fileOps={fileOps}
          onTerminalReveal={onTerminalReveal}
          fontSizeManager={fontSizeManager}
          onGetTerminalPwd={onGetTerminalPwd}
          controller={controller}
        />
      </div>

      {/* Desktop */}
      <div className={cn('flex-1 min-h-0 flex flex-col', !isDesktop && 'hidden')}>
        {desktopContent}
      </div>
    </>
  );
}
