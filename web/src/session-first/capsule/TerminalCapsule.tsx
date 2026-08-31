import { useState } from 'react';
import { cn } from '@/lib/utils';
import { CapsuleCommandsRow } from '@/session-first/capsule/CapsuleCommandsRow';
import { CapsuleInputRow } from '@/session-first/capsule/CapsuleInputRow';
import { CapsuleModeToggle } from '@/session-first/capsule/CapsuleModeToggle';
import type {
  CapsuleMode,
  CapsulePopoverId,
  CapsuleVariant,
  DockHeight,
} from '@/session-first/capsule/types';

export interface TerminalCapsuleProps {
  sendText: (text: string) => void;
  disabled?: boolean;
  variant: CapsuleVariant;
  mode?: CapsuleMode;
  onModeChange?: (mode: CapsuleMode) => void;
}

export function TerminalCapsule({
  sendText,
  disabled = false,
  variant,
  mode = 'input',
  onModeChange,
}: TerminalCapsuleProps) {
  const [openPopover, setOpenPopover] = useState<CapsulePopoverId | null>(null);
  const [dockHeight, setDockHeight] = useState<DockHeight>('single');

  const historyOpen = openPopover === 'history';
  const commandsOpen = openPopover === 'commands';

  const setHistoryOpen = (open: boolean) => {
    setOpenPopover(open ? 'history' : null);
  };

  const setCommandsOpen = (open: boolean) => {
    setOpenPopover(open ? 'commands' : null);
  };

  const isMobile = variant === 'mobile';
  const showModeToggle = Boolean(isMobile && onModeChange);
  const activeMode = isMobile ? mode : 'input';
  const allowMultiLineGrowth = !isMobile || activeMode === 'input';
  const isCommandsMode = isMobile && activeMode === 'commands';
  const isExpanded = allowMultiLineGrowth && dockHeight === 'multi';

  return (
    <div
      data-testid="terminal-capsule"
      data-disabled={disabled ? 'true' : undefined}
      data-dock-height={isExpanded ? 'multi' : 'single'}
      className={cn(
        'absolute inset-x-3 z-10 flex flex-col',
        'bottom-[max(0.75rem,env(safe-area-inset-bottom))]',
      )}
    >
      <div
        className={cn(
          'border border-border shadow-lg backdrop-blur-sm',
          'bg-[var(--sf-capsule-surface)] text-foreground',
          'px-2 py-1.5',
          'transition-[border-radius,padding] duration-[var(--sf-motion)] ease-[var(--sf-ease)]',
          isExpanded || isCommandsMode ? 'rounded-2xl py-2' : 'rounded-full',
          isCommandsMode ? 'flex min-h-11 items-center gap-2' : 'flex',
        )}
      >
        {isCommandsMode && onModeChange ? (
          <>
            <CapsuleModeToggle mode={mode} onModeChange={onModeChange} disabled={disabled} />
            <CapsuleCommandsRow
              sendText={sendText}
              disabled={disabled}
              commandsOpen={commandsOpen}
              onCommandsOpenChange={setCommandsOpen}
            />
          </>
        ) : (
          <CapsuleInputRow
            sendText={sendText}
            disabled={disabled}
            historyOpen={historyOpen}
            onHistoryOpenChange={setHistoryOpen}
            commandsOpen={commandsOpen}
            onCommandsOpenChange={setCommandsOpen}
            showCommandsButton={!isMobile}
            showPasteCopy={!isMobile}
            leading={
              showModeToggle && onModeChange ? (
                <CapsuleModeToggle mode={mode} onModeChange={onModeChange} disabled={disabled} />
              ) : null
            }
            onHeightChange={allowMultiLineGrowth ? setDockHeight : undefined}
          />
        )}
      </div>
    </div>
  );
}

export type { CapsuleMode } from '@/session-first/capsule/types';
