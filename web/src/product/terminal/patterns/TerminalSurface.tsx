import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
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
import type { TerminalStreamState } from '@/platform/session-runtime/SessionRuntime';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import type { ResolvedWorkContext } from '@/product/terminal/capsule/workAwareness';
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

/** Delivery uncertainty remains visible on demand, never as Terminal chrome. */
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

/** Opt-in notice rows belong to the dialog, not to the xterm viewport. */
const terminalNoticeClass = 'flex min-w-0 flex-col gap-2 border-b border-border/60 pb-3 last:border-b-0 last:pb-0';

/** Clipboard actions require explicit user activation; keep them reachable in the contextual dialog. */
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
    if (active?.canWriteClipboardProgrammatically()) {
      void active.copyClipboardText(notice.text).then((copied) => {
        if (copied || active.copyClipboardTextFromGesture(notice.text)) {
          onDismiss?.();
          return;
        }
        setManualCopy(true);
      });
      return;
    }
    if (active?.copyClipboardTextFromGesture(notice.text)) {
      onDismiss?.();
      return;
    }
    setManualCopy(true);
  };
  const exactText = notice.kind === 'copy-required' ? notice.text : '';
  const tooLarge = exactText.length > MAX_SELECTABLE_COPY_TEXT;
  return (
    <div
      className={terminalNoticeClass}
      data-testid="terminal-clipboard-notice"
      data-clipboard-notice={notice.kind}
      role="status"
      aria-live="polite"
    >
      <div className="flex min-w-0 items-center gap-2">
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

/** Detail only: the Terminal never mounts an automatic notice overlay. */
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
          className={terminalNoticeClass}
          data-testid="terminal-history-degraded"
          role="status"
        >
          <span>History may be incomplete — some output was lost while disconnected.</span>
        </div>
      ) : null}
      {inputDrop ? (
        <div
          className={terminalNoticeClass}
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
          className={terminalNoticeClass}
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
  const hasNotices = Boolean(historyDegraded || inputDrop || clipboardNotice || terminalControl?.role === 'observer');
  const [statusOpen, setStatusOpen] = useState(false);

  // A dismissed/expired last notice must also reset the dialog's open state.
  // Otherwise the next notice could reopen the detail over xterm without a
  // user gesture, even though its trigger was temporarily absent.
  useEffect(() => {
    if (!hasNotices) { setStatusOpen(false); }
  }, [hasNotices]);

  // The original notice had a bounded lifetime. Keep that lifecycle even
  // when the user never opens its detail dialog.
  useEffect(() => {
    if (!clipboardNotice || !onDismissClipboardNotice) { return; }
    const lifetime = clipboardNotice.notice.kind === 'copy-required' ? 30_000 : 5_000;
    const timer = setTimeout(onDismissClipboardNotice, lifetime);
    return () => clearTimeout(timer);
  }, [clipboardNotice, onDismissClipboardNotice]);

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
      data-terminal-stream-state={streamState}
      className="relative flex min-h-0 flex-1 flex-col"
    >
      {/*
        The capsule host stays limited to the well and bottom composer (#1307).
        Status details are opt-in in the existing Capsule, not floating UI over
        terminal cells. The xterm grid never resizes when notices change.
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
        <Dialog open={hasNotices && statusOpen} onOpenChange={setStatusOpen}>
          <TerminalCapsule
          experience={experience}
          sendText={capsuleSendText}
          sendPhysKey={capsuleSendPhysKey}
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
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
            >
              <AlertCircle className="size-4" />
            </DialogTrigger>
          ) : null}
        />
        {hasNotices ? (
          <DialogContent aria-describedby={undefined}>
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
