import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';
import type {
  CapsuleCapabilityProjection,
  CapsuleExperience,
} from '@/product/terminal/capsule/types';
import type { CapsuleCapabilityContribution } from '@/app/capsulePresence';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import type { TerminalSemanticKey } from '@/platform/terminal-runtime/interaction/TerminalInteractionController';
import type { TerminalControlState } from '@/product/terminal/state/terminalControl';
import type { InputDrop } from '@/platform/terminal-runtime/inputQueue';
import { Button } from '@/components/ui/button';

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
  /** P2P control lease (#1095). Omit in relay until server forwards attach metadata. */
  terminalControl?: TerminalControlState;
  onTakeControl?: () => void;
  /** Input this Session lost rather than delivered (#1307 SC-09), if any. */
  inputDrop?: InputDrop | null;
  onDismissInputDrop?: () => void;
  /**
   * The shell's surface-navigation action beside the capsule — on Web, "Open
   * Workspace" (#1204). The surface owns no navigation; it hands the node to
   * the capsule's dock region, which owns the geometry.
   */
  surfaceAction?: ReactNode;
}

/**
 * What the surface says about input that will never arrive (#1307 SC-09).
 *
 * One sentence, and it is a statement rather than a question, because the
 * client cannot answer the question. That inability *is* the delivery-unknown
 * state: an agent that restarted cannot say whether the input in flight when
 * it died reached the PTY, so those bytes may already have run, and a user who
 * assumes they did not is a user who runs them a second time.
 *
 * `epoch` is therefore the case that must not be silent, and the others are
 * losses the client *can* account for — the requirement's "discard with
 * explicit UX" rather than three more kinds of silence. **None of them offers
 * a re-send**, and that is deliberate on both halves: the bytes were discarded
 * rather than stored (SC-15 keeps input contents out of durable state), and
 * re-sending input that may already have run is the automatic replay the
 * requirement forbids. What is left is the smallest useful thing — telling the
 * user what is uncertain, and getting out of the way.
 */
function inputDropNotice(drop: InputDrop): string {
  switch (drop.reason) {
    case 'epoch':
      return 'Some input may not have reached the session — check before re-running it.';
    case 'age':
      return 'Input was discarded before it could be delivered — it waited too long.';
    case 'bound':
      return 'Input was not sent — too much was already waiting.';
    case 'generation':
      return 'Input was discarded — another client took control.';
  }
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
  terminalControl,
  onTakeControl,
  inputDrop = null,
  onDismissInputDrop,
  surfaceAction,
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

  const capsuleSendPhysKey = (key: { seq?: string; semanticKey?: TerminalSemanticKey }) => {
    if (inputDisabled) {
      return;
    }
    controller?.sendPhysKey(key);
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
      {inputDrop ? (
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          data-testid="terminal-input-drop"
          role="status"
        >
          <span>{inputDropNotice(inputDrop)}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onDismissInputDrop?.()}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      {terminalControl?.role === 'observer' ? (
        <div
          className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
          data-testid="terminal-observer-bar"
        >
          <span>View only — another client is controlling this session.</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onTakeControl?.()}
          >
            Take control
          </Button>
        </div>
      ) : null}
      <TerminalCapsule
        experience={experience}
        sendText={capsuleSendText}
        sendPhysKey={capsuleSendPhysKey}
        disabled={inputDisabled}
        capabilityDisclosure={capsuleCapabilities?.disclosure}
        capabilityProjection={capsuleProjection}
        adjacentAction={surfaceAction}
      />
    </div>
  );
}
