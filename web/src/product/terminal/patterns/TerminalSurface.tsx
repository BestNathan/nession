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
 *
 * ## It is currently not visible (#1307 stage 5, measured)
 *
 * The band below is the last flex child of the surface, and the capsule is
 * `absolute z-30` against the same host — so it floats over the band rather
 * than after it. Measured at 390x844 on `/fixture/app?drop=epoch`, which
 * renders this surface through the same components the product mounts:
 *
 * * notice 390x61 at y=783; capsule shell 366x56 at y=776, `z-index: 30`,
 *   background `oklch(1 0 0 / 0.96)` with `backdrop-filter: blur(12px)`;
 * * **366x49 of the two overlap — 75% of the notice**, sentence included, and
 *   `document.elementFromPoint` at the notice's own centre lands on the
 *   capsule's textarea;
 * * the frame is **byte-identical** (md5 `fa3c7ea907eaf6b212152736620aff1c`,
 *   35 061 bytes) whether the route names a drop or not, while the DOM differs
 *   by this whole band. Adding the notice changes no pixel.
 *
 * The observer bar below has the same geometry and so the same problem; it
 * predates this one, which is why the fix is a capsule-geometry decision
 * (`--terminal-capsule-shell-inset-*`) rather than a change here. Until it is
 * taken, this notice is asserted by tests that read the DOM and cannot see
 * occlusion — `TerminalSurface.test.tsx` and
 * `app/fixture/__tests__/integration/FixtureInputDrop.test.tsx` both pass.
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
