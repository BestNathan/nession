import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { TerminalCapsule } from '@/product/terminal/capsule/TerminalCapsule';
import { CapsuleIconVisual } from '@/product/terminal/capsule/CapsuleIconVisual';
import {
  capsuleDetailDialogClass,
  capsuleIconButtonClass,
} from '@/product/terminal/capsule/capsuleStyles';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import type {
  CapsuleCapabilityProjection,
  CapsuleExperience,
} from '@/product/terminal/capsule/types';
import type { CapsuleCapabilityContribution } from '@/app/capsulePresence';
import type { TerminalController } from '@/platform/terminal-runtime/controller/TerminalController';
import type {
  TerminalChordKey,
  TerminalChordModifier,
  TerminalSemanticKey,
} from '@/platform/terminal-runtime/interaction/TerminalInteractionController';
import type { TerminalControlState } from '@/product/terminal/state/terminalControl';
import type { InputDrop } from '@/platform/terminal-runtime/inputQueue';
import type { TerminalStreamState } from '@/platform/session-runtime/SessionRuntime';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ResolvedWorkContext } from '@/product/terminal/capsule/workAwareness';
import { useNoticeDisclosure } from '@/product/terminal/hooks/useNoticeDisclosure';
import type { ClipboardNoticeState } from '@/product/terminal/state/ui';
import type { ClipboardNotice } from '@/platform/terminal-runtime/clipboard/ClipboardProtocol';
import { cn } from '@/shared/lib/utils';
import { chromeMonoRole } from '@/shared/typography/chromeRoles';

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
  /**
   * The runtime observed output it cannot prove it received (#2155). A quiet
   * status line, not an error: the session is live, the history behind the
   * visible screen may be incomplete, and the notice disappears only when a
   * complete snapshot has repaired the buffer.
   */
  historyDegraded?: boolean;
  /**
   * The runtime's explicit synchronized / degraded-live / unavailable answer
   * (#1926 SC-08). Published as `data-terminal-stream-state` so the browser
   * fixtures assert the state itself rather than inferring it from which
   * notice happens to be rendered. It does not add a visual element: the
   * quiet degraded notice stays tied to an **observed** gap, and a
   * screen-only-but-clean attach is degraded-live without shouting.
   */
  streamState?: TerminalStreamState;
  /** Input this Session lost rather than delivered (#1307 SC-09), if any. */
  inputDrop?: InputDrop | null;
  onDismissInputDrop?: () => void;
  /**
   * A transient OSC 52/5522 clipboard state (#2598): a blocked copy a user
   * gesture can still complete, a refused write, or an image-only paste the
   * TUI has not negotiated. It is a status strip, never a toolbar.
   */
  clipboardNotice?: ClipboardNoticeState | null;
  onDismissClipboardNotice?: () => void;
  /**
   * The shell's surface-navigation action beside the capsule — on Web, "Open
   * Workspace" (#1204). The surface owns no navigation; it hands the node to
   * the capsule's dock region, which owns the geometry.
   */
  surfaceAction?: ReactNode;
  /** Work-awareness context (#1347): whether any capability is working. */
  workContext?: ResolvedWorkContext;
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
 * ## It was invisible until stage 6, and the geometry is why (measured)
 *
 * The band used to be the last flex child of the surface *while the surface
 * root was itself the capsule host*, so the capsule — `absolute z-30` against
 * that host — floated over the band rather than after it. Measured at 390x844
 * on `/fixture/app?drop=epoch`, which renders this surface through the same
 * components the product mounts:
 *
 * * notice 390x61 at y=783; capsule shell 366x56 at y=776, `z-index: 30`,
 *   background `oklch(1 0 0 / 0.96)` with `backdrop-filter: blur(12px)`;
 * * **366x49 of the two overlapped — 75% of the notice**, sentence included, and
 *   `document.elementFromPoint` at the notice's own centre landed on the
 *   capsule's textarea;
 * * the frame was **byte-identical** (md5 `fa3c7ea907eaf6b212152736620aff1c`,
 *   35 061 bytes) whether the route named a drop or not, while the DOM differed
 *   by this whole band. Adding the notice changed no pixel.
 *
 * #2621 moved the notices out of the capsule host into an absolute overlay so
 * they no longer reserved Terminal height, but the owner decision in #2658 is
 * stricter: the Terminal carries no automatic notice at all. This sentence is
 * therefore only reachable through the Capsule's explicit notices disclosure;
 * it is still the same sentence, and the loss it describes is still never
 * silent.
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

/** One sentence per truthful clipboard state; no capability claims beyond it. */
function clipboardNoticeText(notice: ClipboardNotice): string {
  switch (notice.kind) {
    case 'copy-required':
      return 'The terminal wants to copy to your clipboard.';
    case 'write-denied':
      return 'Clipboard write was blocked by the browser.';
    case 'unsupported-image-paste':
      return 'Image clipboard protocol not supported by this TUI';
    case 'image-too-large':
      return 'Clipboard image is too large to transfer through this terminal.';
  }
}

/**
 * One opt-in status row inside the notices dialog (#2658).
 *
 * The Terminal never mounts this: the row exists only while the user has
 * opened the notices disclosure, so no automatic strip can cover the grid or
 * reserve a Terminal row.
 */
const terminalNoticeRowClass =
  'flex min-w-0 flex-wrap items-center gap-2 border-b border-border/60 pb-3 last:border-b-0 last:pb-0';

/**
 * The compact clipboard notice (#2598, #2621, #2614).
 *
 * A blocked OSC 52 write keeps its text only until the user acts or the
 * notice expires. The parent status overlay is positioned outside the capsule
 * host, so this notice neither reserves a Terminal row nor hides behind the
 * bottom composer. A repeated notice re-arms through `state.id`.
 *
 * ## The action has to work on ordinary HTTP too (#2614, #2656)
 *
 * The deployed staging origin is plain HTTP, where browsers do not expose the
 * async Clipboard API. The notice's Copy action calls the shared browser
 * clipboard owner directly inside the click; that owner integrates
 * `copy-to-clipboard`, whose HTTP branch runs the DOM copy before its Promise
 * settles, while a secure origin uses the library's async branch. There is no
 * post-await legacy retry: once a promise has been awaited the transient
 * activation may be gone, so a refusal asks for a fresh click and, when the
 * browser cannot copy at all, presents the bounded selectable surface. It
 * never claims a copy that did not happen.
 */
const MAX_SELECTABLE_COPY_TEXT = 64 * 1024;

function TerminalClipboardNoticeStrip({
  state,
  controller,
  onDismiss,
}: {
  state: ClipboardNoticeState;
  controller: TerminalController | null;
  onDismiss?: () => void;
}) {
  const [manualCopy, setManualCopy] = useState(false);
  const notice = state.notice;
  useEffect(() => {
    setManualCopy(false);
  }, [state.id]);
  const copy = () => {
    if (notice.kind !== 'copy-required') { return; }
    const active = controller;
    if (!active) {
      setManualCopy(true);
      return;
    }
    // One shared-owner invocation, inside the click (#2656): its HTTP branch
    // runs the DOM copy before this Promise settles. Awaiting it and then
    // retrying the legacy path would spend an activation that is already gone.
    void active.copyClipboardTextFromGesture(notice.text).then((copied) => {
      if (copied) {
        onDismiss?.();
        return;
      }
      setManualCopy(true);
    });
  };
  const exactText = notice.kind === 'copy-required' ? notice.text : '';
  const tooLarge = exactText.length > MAX_SELECTABLE_COPY_TEXT;
  return (
    <div
      className={cn(terminalNoticeRowClass, 'flex-col items-stretch')}
      data-testid="terminal-clipboard-notice"
      data-clipboard-notice={notice.kind}
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span>
          {manualCopy
            ? tooLarge
              ? 'This clipboard text is too large to copy here.'
              : 'The copy could not be completed automatically — select the text below and press Ctrl/Cmd+C.'
            : clipboardNoticeText(notice)}
        </span>
        {notice.kind === 'copy-required' && !manualCopy ? (
          <Button type="button" variant="secondary" size="sm" className="h-7 px-2" onClick={() => copy()}>
            Copy
          </Button>
        ) : null}
      </div>
      {manualCopy && !tooLarge ? (
        <Textarea
          readOnly
          rows={2}
          aria-label="Clipboard text to copy"
          data-testid="terminal-clipboard-manual"
          className={cn('mt-1 h-16 min-h-0 resize-none', chromeMonoRole('code'))}
          value={exactText}
          onFocus={(event) => event.currentTarget.select()}
        />
      ) : null}
    </div>
  );
}

/**
 * The opt-in notice details (#2658).
 *
 * Rendered only inside the Capsule's notices dialog, after an explicit user
 * gesture. It keeps the same sentences and actions the #2621 overlay had; what
 * changed is when they exist: never automatically, and never over the grid.
 */
function TerminalNoticeDetails({
  historyDegraded,
  inputDrop,
  clipboardNotice,
  controller,
  terminalControl,
  onDismissInputDrop,
  onDismissClipboardNotice,
  onTakeControl,
}: {
  historyDegraded: boolean;
  inputDrop: InputDrop | null;
  clipboardNotice: ClipboardNoticeState | null;
  controller: TerminalController | null;
  terminalControl?: TerminalControlState;
  onDismissInputDrop?: () => void;
  onDismissClipboardNotice?: () => void;
  onTakeControl?: () => void;
}) {
  return (
    <div data-testid="terminal-notice-details" className="flex flex-col gap-3">
      {historyDegraded ? (
        <div
          className={terminalNoticeRowClass}
          data-testid="terminal-history-degraded"
          role="status"
        >
          <span>History may be incomplete — some output was lost while disconnected.</span>
        </div>
      ) : null}
      {inputDrop ? (
        <div
          className={terminalNoticeRowClass}
          data-testid="terminal-input-drop"
          role="status"
        >
          <span>{inputDropNotice(inputDrop)}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 shrink-0 px-2"
            onClick={() => onDismissInputDrop?.()}
          >
            Dismiss
          </Button>
        </div>
      ) : null}
      {clipboardNotice ? (
        <TerminalClipboardNoticeStrip
          state={clipboardNotice}
          controller={controller}
          onDismiss={onDismissClipboardNotice}
        />
      ) : null}
      {terminalControl?.role === 'observer' ? (
        <div
          className={terminalNoticeRowClass}
          data-testid="terminal-observer-bar"
          role="status"
        >
          <span>View only — another client is controlling this session.</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 shrink-0 px-2"
            onClick={() => onTakeControl?.()}
          >
            Take control
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Session-first terminal surface: well host + floating capsule.
 * Does not import legacy TerminalLayout / MobileTerminalLayout / BottomBar.
 */
/**
 * The capsule's terminal actions, gated by the same input-authority flag every
 * other user-input path uses (#1095).
 *
 * A chord goes to `TerminalController.sendChord`, which hands it to the
 * interaction runtime's encoder; this file never composes an escape.
 */
function useCapsuleTerminalSenders(
  controller: TerminalController | null,
  inputDisabled: boolean,
) {
  const capsuleSendText = useCallback((text: string) => {
    if (inputDisabled) {
      return;
    }
    controller?.handleInput({
      source: 'component-quickcmd',
      data: text,
      timestamp: Date.now(),
    });
  }, [controller, inputDisabled]);

  const capsuleSendPhysKey = useCallback(
    (key: { seq?: string; semanticKey?: TerminalSemanticKey }) => {
      if (inputDisabled) {
        return;
      }
      controller?.sendPhysKey(key);
    },
    [controller, inputDisabled],
  );

  const capsuleSendChord = useCallback(
    (modifier: TerminalChordModifier, key: TerminalChordKey) => {
      if (inputDisabled) {
        return;
      }
      controller?.sendChord(modifier, key);
    },
    [controller, inputDisabled],
  );

  return { capsuleSendText, capsuleSendPhysKey, capsuleSendChord };
}

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
  historyDegraded = false,
  streamState = 'unavailable',
  onDismissInputDrop,
  clipboardNotice = null,
  onDismissClipboardNotice,
  surfaceAction,
  workContext,
}: TerminalSurfaceProps) {
  const { hasNotices, dialogOpen: noticesDialogOpen, setOpen: setNoticesOpen, notices } =
    useNoticeDisclosure({
      historyDegraded,
      inputDrop,
      clipboardNotice,
      terminalControl,
      onDismissClipboardNotice,
    });

  const { capsuleSendText, capsuleSendPhysKey, capsuleSendChord } =
    useCapsuleTerminalSenders(controller, inputDisabled);

  return (
    <div
      data-testid="terminal-surface"
      data-terminal-stream-state={streamState}
      data-terminal-notices={notices || undefined}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {/*
        The capsule host stays limited to the well and bottom composer (#1307).
        Status details are reached only through the capsule's notices action
        (#2658): the Terminal mounts no automatic overlay, so the host remains
        the only flex-filling region and the grid cannot move with a notice.
      */}
      <div
        data-terminal-capsule-host
        data-terminal-scrollback-mode="local-buffer"
        className="relative flex min-h-0 flex-1 flex-col"
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {isSwitching && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-terminal-background/50">
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
            </div>
          )}
          {children}
        </div>
        <Dialog open={noticesDialogOpen} onOpenChange={setNoticesOpen}>
          <TerminalCapsule
            experience={experience}
            sendText={capsuleSendText}
            sendPhysKey={capsuleSendPhysKey}
            sendChord={capsuleSendChord}
            disabled={inputDisabled}
            capabilityDisclosure={capsuleCapabilities?.disclosure}
            capabilityProjection={capsuleProjection}
            adjacentAction={surfaceAction}
            workContext={workContext}
            statusAction={hasNotices ? (
              <DialogTrigger
                data-testid="terminal-notices-trigger"
                aria-label="Terminal notices"
                title="Terminal notices"
                className={cn(
                  capsuleIconButtonClass,
                  'inline-flex items-center justify-center text-muted-foreground hover:text-foreground',
                )}
              >
                <CapsuleIconVisual>
                  <AlertCircle />
                </CapsuleIconVisual>
              </DialogTrigger>
            ) : null}
          />
          {noticesDialogOpen ? (
            <DialogContent
              data-testid="terminal-notices-dialog"
              aria-describedby={undefined}
              className={capsuleDetailDialogClass}
            >
              <DialogHeader>
                <DialogTitle>Terminal notices</DialogTitle>
              </DialogHeader>
              <TerminalNoticeDetails
                historyDegraded={historyDegraded}
                inputDrop={inputDrop}
                clipboardNotice={clipboardNotice}
                controller={controller}
                terminalControl={terminalControl}
                onDismissInputDrop={onDismissInputDrop}
                onDismissClipboardNotice={onDismissClipboardNotice}
                onTakeControl={onTakeControl}
              />
            </DialogContent>
          ) : null}
        </Dialog>
      </div>
    </div>
  );
}
