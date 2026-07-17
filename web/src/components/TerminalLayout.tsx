import { BottomBar, type BottomTab } from './BottomBar';
import { FileTabs } from './FileTabs';
import { EnvPanel } from './env/EnvPanel';
import { TerminalToolbar } from './TerminalToolbar';
import type { FileOps } from '../services/fileOps';
import type { ScalingManager } from '@/terminal/ScalingManager';

interface TerminalLayoutProps {
  terminalElement: React.ReactNode;
  bottomTab: BottomTab;
  onBottomTabChange: (tab: BottomTab) => void;
  sheetOpen: boolean;
  onSheetToggle: (open: boolean) => void;
  sessionId: string;
  sendText: (text: string) => void;
  toolbarDisabled: boolean;
  fileOps?: FileOps | null;
  onTerminalReveal?: () => void;
  scalingManager?: ScalingManager | null;
}

/**
 * Shared layout for terminal view with optional file operations.
 * Eliminates duplication between fileOps and no-fileOps branches.
 */
export function TerminalLayout({
  terminalElement,
  bottomTab,
  onBottomTabChange,
  sheetOpen,
  onSheetToggle,
  sessionId,
  sendText,
  toolbarDisabled,
  fileOps,
  onTerminalReveal,
  scalingManager,
}: TerminalLayoutProps) {
  const envPanel = <EnvPanel sessionId={sessionId} />;
  const commandsPanel = (
    <TerminalToolbar sendText={sendText} disabled={toolbarDisabled} scalingManager={scalingManager} />
  );

  if (fileOps) {
    return (
      <FileTabs
        fileOps={fileOps}
        onTerminalReveal={onTerminalReveal}
        bottomTab={bottomTab}
        onBottomTabChange={onBottomTabChange}
        sheetOpen={sheetOpen}
        onSheetToggle={onSheetToggle}
        envPanel={envPanel}
        commandsPanel={commandsPanel}
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
        onTabChange={onBottomTabChange}
        showFilesTab={false}
        sheetOpen={sheetOpen}
        onSheetToggle={onSheetToggle}
        envPanel={envPanel}
        commandsPanel={commandsPanel}
      />
    </>
  );
}
