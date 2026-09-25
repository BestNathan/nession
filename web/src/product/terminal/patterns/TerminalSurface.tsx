import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';
import type {
  CapsuleCapabilityProjection,
  CapsuleExperience,
} from '@/product/terminal/capsule/types';
import type { CapsuleCapabilityContribution } from '@/app/capsulePresence';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';

export interface TerminalSurfaceProps {
  /** xterm mount tree (TerminalPane). */
  children: ReactNode;
  inputDisabled: boolean;
  controller: TerminalController | null;
  /** Address route switch in progress — subtle veil over viewport. */
  isSwitching?: boolean;
  /** What the capsule may show: every reachable capability, marked by state, in `+`. */
  capsuleCapabilities?: CapsuleCapabilityContribution;
  /** A capability emerging beside the capsule, if Nession decided one should. */
  capsuleProjection?: CapsuleCapabilityProjection;
  /**
   * Which experience's capsule to render. **Required, and supplied by the
   * shell.**
   *
   * It used to be derived here — `useMediaQuery('(min-width: 768px)')`, against
   * the shell's own `(min-width: 1024px)` — so at any width in [768, 1024) the
   * App shell drew an App layout around a *Web* capsule, complete with the
   * permanent history control #1034 retired. iPad portrait and every landscape
   * phone sit in that band.
   *
   * This layer cannot see the shell's breakpoint: `product` may not import
   * `app`, which is precisely why a second breakpoint appeared here. Being told
   * is the only way the two can be guaranteed to agree.
   */
  experience: CapsuleExperience;
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
  capsuleProjection,
  experience,
}: TerminalSurfaceProps) {

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
      data-testid="terminal-surface"
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
        experience={experience}
        sendText={capsuleSendText}
        disabled={inputDisabled}
        capabilityDisclosure={capsuleCapabilities?.disclosure}
        capabilityProjection={capsuleProjection}
      />
    </div>
  );
}
