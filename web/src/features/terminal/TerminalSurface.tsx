import { useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { useMediaQuery } from '@/shared/hooks/useMediaQuery';
import { TerminalCapsule, type CapsuleMode } from '@/features/terminal/capsule/TerminalCapsule';
import type { CapsuleCapabilityContribution } from '@/app/capsulePresence';
import type { TerminalController } from '@/core/terminal-runtime/controller/TerminalController';

export interface TerminalSurfaceProps {
  /** xterm mount tree (SessionFirstTerminalPane). */
  children: ReactNode;
  inputDisabled: boolean;
  controller: TerminalController | null;
  /** Address route switch in progress — subtle veil over viewport. */
  isSwitching?: boolean;
  /** What the capsule may show: every reachable capability, marked by state, in `+`. */
  capsuleCapabilities?: CapsuleCapabilityContribution;
}

/**
 * Session-first terminal surface: well host + floating capsule.
 * Does not import legacy TerminalLayout / MobileTerminalLayout / BottomBar.
 */
export function TerminalSurface({
  children,
  inputDisabled,
  controller,
  isSwitching = false,
  capsuleCapabilities,
}: TerminalSurfaceProps) {
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const [capsuleMode, setCapsuleMode] = useState<CapsuleMode>('input');
  const capsuleExperience = isDesktop ? 'web' : 'app';

  const capsuleSendText = (text: string) => {
    if (inputDisabled) {
      return;
    }
    controller?.handleInput({
      source: 'component-quickcmd',
      data: text,
      timestamp: Date.now(),
    });
  };

  return (
    <div
      data-testid="session-first-terminal-surface"
      className="relative flex min-h-0 flex-1 flex-col"
      data-terminal-capsule-host
      data-terminal-scrollback-mode="local-buffer"
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        {isSwitching && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-terminal-background/50">
            <Loader2 className="size-8 animate-spin text-muted-foreground" />
          </div>
        )}
        {children}
      </div>
      <TerminalCapsule
        experience={capsuleExperience}
        mode={capsuleMode}
        onModeChange={capsuleExperience === 'app' ? setCapsuleMode : undefined}
        sendText={capsuleSendText}
        disabled={inputDisabled}
        capabilityDisclosure={capsuleCapabilities?.disclosure}
      />
    </div>
  );
}
