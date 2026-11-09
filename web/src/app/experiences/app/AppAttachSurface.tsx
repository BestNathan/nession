import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { agentDisplayName } from '@/shared/lib/format';
import { bodyAppClass, secondaryAppClass } from './appTypography';
import { Button } from '@/components/ui/button';
import type { Agent, Session } from '@/types';
import {
  useAttachConfiguration,
  type AttachChoice,
} from '@/product/session/hooks/useAttachConfiguration';
import {
  AttachModeSummary,
  ModeChoices,
  PathChoices,
  RendererChoices,
} from '@/product/session/components/AttachParts';
import { AppOperationPage, AppSheet } from './AppOperationPage';

type AttachState = ReturnType<typeof useAttachConfiguration>;

function AppAttachSettingsPage({
  attach,
  saving,
  onBack,
  onSubmit,
}: {
  attach: AttachState;
  saving: boolean;
  onBack: () => void;
  onSubmit: () => void;
}) {
  return (
    <AppOperationPage
      testId="app-attach-settings-page"
      title={saving ? 'Attach settings' : 'Connection settings'}
      backLabel={saving ? 'Sessions' : 'Attach'}
      onBack={onBack}
      footer={
        <Button
          type="button"
          data-testid="app-attach-settings-submit"
          disabled={!attach.attachInfo}
          className="min-h-11 w-full"
          onClick={onSubmit}
        >
          {saving ? 'Save settings' : 'Use this mode'}
        </Button>
      }
    >
      <div className="flex flex-col gap-[var(--nession-shell-space-2)]">
        <span className={cn('text-muted-foreground', secondaryAppClass)}>Connection mode</span>
        <ModeChoices mode={attach.mode} onChange={attach.setMode} layout="stack" />
      </div>
      {attach.candidates.length > 0 ? (
        <PathChoices
          candidates={attach.candidates}
          latencyByUrl={
            attach.mode === 'relay'
              ? new Map(attach.candidates.map((address) => [address.url, address.rtt_ms ?? null]))
              : attach.latencyByUrl
          }
          bestUrl={attach.bestUrl}
          measured={attach.isP2p && attach.measured}
          probing={attach.isP2p && attach.probing}
          selectedUrl={attach.selectedUrl}
          onSelect={attach.selectUrl}
          onRetest={attach.isP2p ? attach.retest : undefined}
          isRelay={attach.mode === 'relay'}
          layout="page"
        />
      ) : null}
      <RendererChoices
        renderer={attach.renderer}
        onChange={attach.setRenderer}
        webglSupported={attach.webglSupported}
        layout="stack"
      />
      {attach.error ? (
        <p className={cn('text-destructive', bodyAppClass)} data-testid="app-attach-error">
          {attach.error}
        </p>
      ) : null}
    </AppOperationPage>
  );
}

function AppAttachQuickSheet({
  attach,
  session,
  agent,
  onClose,
  onSettings,
  onAttach,
}: {
  attach: AttachState;
  session: Session;
  agent: Agent | undefined;
  onClose: () => void;
  onSettings: () => void;
  onAttach: () => void;
}) {
  return (
    <AppSheet
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
      title={`Attach: ${session.session_name}`}
      testId="app-attach-sheet"
      footer={
        <Button
          type="button"
          data-testid="app-attach-confirm"
          disabled={!attach.attachInfo}
          className="min-h-11 w-full"
          onClick={onAttach}
        >
          Attach
        </Button>
      }
    >
      <div className="flex flex-col gap-0.5">
        <span className={bodyAppClass}>{session.session_name}</span>
        <span className={cn('text-muted-foreground', secondaryAppClass)}>
          {agent ? agentDisplayName(agent) : session.agent_id}
        </span>
      </div>
      <AttachModeSummary
        mode={attach.mode}
        probing={attach.probing}
        bestUrl={attach.bestUrl}
        bestLatency={attach.bestUrl !== null ? attach.latencyByUrl.get(attach.bestUrl) ?? null : null}
        measured={attach.measured}
      />
      <button
        type="button"
        data-testid="app-attach-settings-entry"
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-[var(--nession-radius-surface)] border px-3 py-2 text-left"
        onClick={onSettings}
      >
        <span className="flex min-w-0 flex-col">
          <span className={bodyAppClass}>Connection settings</span>
          <span className={cn('text-muted-foreground', secondaryAppClass)}>
            Auto · P2P · Relay · Candidate paths
          </span>
        </span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </button>
      {attach.error ? (
        <p className={cn('text-destructive', bodyAppClass)} data-testid="app-attach-error">
          {attach.error}
        </p>
      ) : null}
    </AppSheet>
  );
}

/**
 * App Attach, two intents (#3089).
 *
 * - **Attach** opens the compact quick sheet: identity, the current
 *   connection summary, one primary Attach action, and the step into the full
 *   configuration page. Back from that page returns to the sheet with the
 *   selected mode/address preserved; nothing is attached until the sheet's
 *   Attach is pressed.
 * - **Configure** (the Session row's "Attach settings") opens the full page
 *   directly. Its one action saves the preference; it can never attach.
 *
 * The selection/probing/confirmation owner is shared with Web; this file is
 * only the App composition.
 */
export function AppAttachSurface({
  isOpen,
  intent,
  session,
  agents,
  onClose,
  onConfirm,
}: {
  isOpen: boolean;
  intent: 'attach' | 'configure';
  session: Session | null;
  agents: Agent[];
  onClose: () => void;
  onConfirm: (session: Session, choice: AttachChoice) => void;
}) {
  const attach = useAttachConfiguration({ isOpen, session });
  const [phase, setPhase] = useState<'sheet' | 'settings'>('sheet');

  useEffect(() => {
    if (isOpen) {
      setPhase(intent === 'configure' ? 'settings' : 'sheet');
    }
  }, [isOpen, intent, session?.session_id]);

  if (!isOpen || !session) {
    return null;
  }

  const agent = agents.find((candidate) => candidate.agent_id === session.agent_id);
  const saving = intent === 'configure';
  const confirm = () => {
    const choice = attach.buildChoice();
    if (choice) {
      onConfirm(session, choice);
    }
  };

  if (phase === 'settings') {
    return (
      <AppAttachSettingsPage
        attach={attach}
        saving={saving}
        onBack={() => (saving ? onClose() : setPhase('sheet'))}
        onSubmit={() => (saving ? confirm() : setPhase('sheet'))}
      />
    );
  }

  return (
    <AppAttachQuickSheet
      attach={attach}
      session={session}
      agent={agent}
      onClose={onClose}
      onSettings={() => setPhase('settings')}
      onAttach={() => confirm()}
    />
  );
}
