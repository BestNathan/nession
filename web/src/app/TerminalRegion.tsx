import type { ReactNode } from 'react';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { TerminalPane } from '@/product/terminal/TerminalPane';
import { TerminalSurface } from '@/product/terminal/patterns/TerminalSurface';
import type { CapsuleCapabilityContribution } from '@/app/capsulePresence';
import type {
  CapsuleCapabilityProjection,
  CapsuleExperience,
} from '@/product/terminal/capsule/types';
import { useTerminalOrchestration } from '@/product/terminal/useTerminalOrchestration';

export interface TerminalRegionProps {
  hidden: boolean;
  onDisconnect: () => void;
  onError: (error: Error) => void;
  /** Which experience's capsule to render — supplied by the shell. */
  experience: CapsuleExperience;
  /** What the capsule may show: the chip that earned presence, plus the rest on demand. */
  capsuleCapabilities?: CapsuleCapabilityContribution;
  capsuleProjection?: CapsuleCapabilityProjection;
  onOpenWorkspaceFile?: (path: string, line?: number) => void;
  /** The shell's surface-navigation action beside the capsule (#1204). */
  surfaceAction?: ReactNode;
}

/**
 * Session-first terminal entry — native surface + shared xterm engine.
 * Does not use legacy TerminalLayout / dashboard terminal chrome.
 */
export function TerminalRegion({
  hidden,
  onDisconnect,
  onError,
  experience,
  capsuleCapabilities,
  capsuleProjection,
  onOpenWorkspaceFile,
  surfaceAction,
}: TerminalRegionProps) {
  const {
    sessionId,
    controller,
    isSwitching,
    inputDisabled,
    viewportReady,
    terminalState,
    transportEpoch,
    terminalControl,
    onTakeControl,
  } = useTerminalOrchestration({ onDisconnect, onError });

  return (
    <div
      data-testid="terminal"
      className={cn('flex min-h-0 flex-1 flex-col', hidden && 'hidden')}
    >
      {!sessionId ? (
        <div className={cn('flex min-h-0 flex-1 items-center justify-center text-muted-foreground', chromeSansRole('secondary'))}>
          Select a session to open its terminal.
        </div>
      ) : (
        <TerminalSurface
          experience={experience}
          inputDisabled={inputDisabled}
          controller={controller}
          isSwitching={isSwitching}
          capsuleCapabilities={capsuleCapabilities}
          capsuleProjection={capsuleProjection}
          surfaceAction={surfaceAction}
          terminalControl={terminalControl}
          onTakeControl={() => {
            void onTakeControl();
          }}
        >
          <TerminalPane
            sessionId={sessionId}
            controller={controller}
            terminalState={terminalState}
            viewportReady={viewportReady}
            transportEpoch={transportEpoch}
            onOpenWorkspaceFile={onOpenWorkspaceFile}
          />
        </TerminalSurface>
      )}
    </div>
  );
}
