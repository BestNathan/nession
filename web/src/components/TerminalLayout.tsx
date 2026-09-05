import { useState, useEffect } from 'react';
import { FileTabs } from './FileTabs';
import { EnvPanel } from './env/EnvPanel';
import { InputPanel } from './InputPanel';
import { QuickCommandsPanel } from './QuickCommandsPanel';
import { MobileTerminalLayout } from './MobileTerminalLayout';
import { BottomBar, type BottomTab } from './BottomBar';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { TerminalCapsule } from '@/session-first/TerminalCapsule';
import { cn } from '@/lib/utils';
import type { FileOps } from '@/features/files';
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
  /** Session-first mobile: skip Files/Env swipe panels (use Workspace instead). */
  terminalOnly?: boolean;
  /** Desktop toolbar variant when fileOps is absent (session-first path). */
  toolbar?: 'bottombar' | 'capsule';
}

interface DesktopToolbarLayoutProps {
  toolbar: 'bottombar' | 'capsule';
  isDesktop: boolean;
  terminalElement: React.ReactNode;
  toolbarDisabled: boolean;
  envPanel: React.ReactNode;
  inputPanel: React.ReactNode;
  commandsPanel: React.ReactNode;
  bottomTab: BottomTab;
  onBottomTabChange: (tab: BottomTab) => void;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
  sendText: (text: string) => void;
}

function DesktopToolbarLayout({
  toolbar,
  isDesktop,
  terminalElement,
  toolbarDisabled,
  envPanel,
  inputPanel,
  commandsPanel,
  bottomTab,
  onBottomTabChange,
  sheetOpen,
  onSheetToggle,
  sendText,
}: DesktopToolbarLayoutProps) {
  if (toolbar === 'capsule') {
    return (
      <div className="relative flex-1 min-h-0 flex flex-col" data-terminal-capsule-host>
        {isDesktop ? (
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            {terminalElement}
          </div>
        ) : null}
        {isDesktop ? (
          <TerminalCapsule
            experience="web"
            sendText={sendText}
            disabled={toolbarDisabled}
          />
        ) : null}
      </div>
    );
  }

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        {isDesktop && terminalElement}
      </div>
      <BottomBar
        activeTab={bottomTab}
        onTabChange={onBottomTabChange}
        showFilesTab={false}
        sheetOpen={sheetOpen}
        onSheetToggle={onSheetToggle}
        envPanel={envPanel}
        inputPanel={inputPanel}
        commandsPanel={commandsPanel}
      />
    </>
  );
}

function useDesktopKeyboardGuard(
  isDesktop: boolean,
  controller: TerminalController | null | undefined,
) {
  useEffect(() => {
    if (!isDesktop || !controller) {
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      if (e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift' || e.key === 'Meta') {
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isDesktop, controller]);
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
  terminalOnly = false,
  toolbar = 'bottombar',
}: TerminalLayoutProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [bottomTab, setBottomTab] = useState<BottomTab>('input');
  const [sheetOpen, setSheetOpen] = useState(false);
  useDesktopKeyboardGuard(isDesktop, controller);

  const capsuleSendText = (text: string) => {
    if (toolbarDisabled) {
      return;
    }
    controller?.handleInput({
      source: 'component-quickcmd',
      data: text,
      timestamp: Date.now(),
    });
  };

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
    <DesktopToolbarLayout
      toolbar={toolbar}
      isDesktop={isDesktop}
      terminalElement={terminalElement}
      toolbarDisabled={toolbarDisabled}
      envPanel={envPanel}
      inputPanel={inputPanel}
      commandsPanel={commandsPanel}
      bottomTab={bottomTab}
      onBottomTabChange={setBottomTab}
      sheetOpen={sheetOpen}
      onSheetToggle={setSheetOpen}
      sendText={capsuleSendText}
    />
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
          terminalOnly={terminalOnly}
        />
      </div>

      {/* Desktop */}
      <div className={cn('flex-1 min-h-0 flex flex-col', !isDesktop && 'hidden')}>
        {desktopContent}
      </div>
    </>
  );
}
