import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import type { Session } from '@/types';
import {
  useAttachConfiguration,
  type AttachChoice,
} from '@/product/session/hooks/useAttachConfiguration';
import { ModeChoices, PathChoices, RendererChoices } from './AttachParts';

export type { AttachChoice };

interface AttachDialogProps {
  isOpen: boolean;
  onClose: () => void;
  session: Session | null;
  /** Which flow opened the dialog: attach (confirm → attach) or configure
   *  (Save → persist the profile only). Defaults to 'attach'. */
  intent?: 'attach' | 'configure';
  /** Called with the resolved attach choice; the flow shows the terminal. */
  onConfirm: (session: Session, choice: AttachChoice) => void;
}

/**
 * Web Attach surface: pick the connection mode and (for P2P) a candidate
 * address.
 *
 * The selection/probing/confirmation owner is `useAttachConfiguration`; App
 * renders the same owner as a sheet and a full operation page (#3089). This
 * dialog is the Web presentation: a centered, content-capable surface whose
 * header and footer stay put while the middle scrolls.
 */
export function AttachDialog({ isOpen, intent = 'attach', onClose, session, onConfirm }: AttachDialogProps) {
  const attach = useAttachConfiguration({ isOpen, session });
  const { candidates, latencyByUrl, bestUrl, measured, probing, mode, isP2p } = attach;

  const handleConfirm = () => {
    const choice = attach.buildChoice();
    if (session && choice) {
      onConfirm(session, choice);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        size="wide"
        data-testid="attach-dialog"
      >
        <DialogHeader>
          <DialogTitle>Attach{session ? `: ${session.session_name}` : ''}</DialogTitle>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Connection Mode</Label>
            <ModeChoices mode={mode} onChange={attach.setMode} />
          </div>

          {/* Candidate address list.
              P2P mode: browser-measured latency.
              Relay mode: server TCP probe results (RTT + Reachable/Unreachable). */}
          {candidates.length > 0 ? (
            <PathChoices
              candidates={candidates}
              latencyByUrl={mode === 'relay'
                ? new Map(candidates.map(a => [a.url, a.rtt_ms ?? null]))
                : latencyByUrl}
              bestUrl={bestUrl}
              measured={isP2p && measured}
              probing={isP2p && probing}
              selectedUrl={attach.selectedUrl}
              onSelect={attach.selectUrl}
              onRetest={isP2p ? attach.retest : undefined}
              isRelay={mode === 'relay'}
            />
          ) : null}

          <RendererChoices
            renderer={attach.renderer}
            onChange={attach.setRenderer}
            webglSupported={attach.webglSupported}
          />

          {attach.error ? (
            <p className={cn('text-destructive', chromeSansRole('metadata'))} data-testid="attach-error">
              {attach.error}
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onClose()}>
            Cancel
          </Button>
          <Button
            type="button"
            data-testid="attach-confirm"
            onClick={() => handleConfirm()}
            disabled={!attach.attachInfo}
          >
            {intent === 'configure' ? 'Save' : 'Attach'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
