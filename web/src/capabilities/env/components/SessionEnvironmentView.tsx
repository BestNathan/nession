import { useState } from 'react';
import { AlertTriangle, ChevronDown, CircleAlert, RefreshCw } from 'lucide-react';
import { cn } from '@/shared/lib/utils';
import { workspaceScrollClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { Agent, EnvFileInfo } from '@/types';
import type { SessionEnvBindingState } from '@/capabilities/env/types';
import type { SessionEnvBinding } from '@/capabilities/env/hooks/useSessionEnvBinding';
import { bindingStatus, type BindingStatusView, type BindingTone } from '@/capabilities/env/model/bindingStatus';
import { profileLocation } from '@/capabilities/env/model/profile';
import { refKey } from '@/capabilities/env/model/envRef';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

type BindingState = SessionEnvBindingState | null;

const TONES: Record<BindingTone, string> = {
  quiet: 'text-muted-foreground',
  info: 'bg-muted/40 text-muted-foreground',
  warning: 'bg-warning/10 text-warning',
  error: 'bg-destructive/10 text-destructive',
};

function StatusIcon({ tone }: { tone: BindingTone }) {
  if (tone === 'warning') {
    return <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />;
  }
  if (tone === 'error') {
    return <CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />;
  }
  return null;
}

function Details({ binding, reason }: { binding: BindingState; reason: string | null }) {
  const observed = binding?.observed;
  return (
    <dl
      id="env-session-details-body"
      data-testid="env-session-details-body"
      className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 border-t border-border/60 pt-2"
    >
      <dt>Desired revision</dt>
      <dd>{binding?.desired_revision ?? 'Unavailable'}</dd>
      <dt>Applied revision</dt>
      <dd>{observed?.applied_revision ?? 'Unavailable'}</dd>
      <dt>Managed keys</dt>
      <dd>{observed ? observed.managed_keys.length : 'Unavailable'}</dd>
      {observed?.shell ? (
        <>
          <dt>Shell</dt>
          <dd>{observed.shell}</dd>
        </>
      ) : null}
      {reason ? (
        <>
          <dt>Reason</dt>
          <dd data-testid="env-session-details-reason">{reason}</dd>
        </>
      ) : null}
    </dl>
  );
}

function StatusPanel({
  status,
  binding,
  reason,
}: {
  status: BindingStatusView;
  binding: BindingState;
  reason: string | null;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <>
      <div
        data-testid="env-session-status"
        data-status={status.status}
        data-tone={status.tone}
        className={cn(
          'mt-4 rounded-[var(--nession-radius-surface)] px-3 py-2',
          TONES[status.tone],
          chromeSansRole('metadata'),
        )}
      >
        <div className="flex items-start gap-2">
          <StatusIcon tone={status.tone} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span data-testid="env-session-status-title">{status.title}</span>
              <button
                type="button"
                data-testid="env-session-details"
                aria-expanded={detailsOpen}
                aria-controls="env-session-details-body"
                onClick={() => setDetailsOpen((open) => !open)}
                className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
              >
                Details
                <ChevronDown
                  aria-hidden
                  className={cn('size-3 transition-transform', detailsOpen && 'rotate-180')}
                />
              </button>
            </div>
            {status.detail ? (
              <p data-testid="env-session-status-detail" className="mt-0.5 opacity-90">
                {status.detail}
              </p>
            ) : null}
          </div>
        </div>
        {detailsOpen ? <Details binding={binding} reason={reason} /> : null}
      </div>

      {status.outdated ? (
        <p
          data-testid="env-session-outdated"
          className={cn('mt-3 text-warning', chromeSansRole('metadata'))}
        >
          A bound profile changed since this Session materialized its revision.
          Reapply materializes the new content; the running shell still converges
          at its next prompt.
        </p>
      ) : null}
    </>
  );
}

function IncludedProfiles({
  desired,
  profiles,
  agents,
}: {
  desired: NonNullable<BindingState>['desired_profiles'];
  profiles: EnvFileInfo[];
  agents: Agent[];
}) {
  if (desired.length === 0) {
    return (
      <p
        data-testid="env-session-empty"
        className={cn('text-muted-foreground', chromeSansRole('secondary'))}
      >
        No environment is applied to this Session. Manage binding to choose an
        ordered selection.
      </p>
    );
  }
  const byKey = new Map(profiles.map((profile) => [refKey(profile), profile]));
  return (
    <ol
      data-testid="env-session-profiles"
      className="divide-y divide-border rounded-[var(--nession-radius-surface)] border"
    >
      {desired.map((entry, index) => {
        const profile = byKey.get(refKey(entry.profile));
        return (
          <li
            key={refKey(entry.profile)}
            data-testid={`env-session-profile-${refKey(entry.profile)}`}
            className="flex items-center gap-3 px-3 py-2"
          >
            <span className={cn('w-5 shrink-0 text-muted-foreground', chromeSansRole('metadata'))}>
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate', chromeSansRole('primary'))}>
                {entry.profile.name}
              </span>
              <span className={cn('block truncate text-muted-foreground', chromeSansRole('metadata'))}>
                {profile ? profileLocation(profile, agents) : 'Profile unavailable'}
                {entry.outdated ? ' · source changed' : ''}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export interface SessionEnvironmentViewProps {
  sessionId: string;
  sessionName: string | null;
  binding: SessionEnvBinding;
  profiles: EnvFileInfo[];
  agents: Agent[];
  pending: boolean;
  onManage: () => void;
  onReapply: () => Promise<boolean>;
  onRetry: () => void;
}

/**
 * The Session-first Environment overview (#2654).
 *
 * The standing line states the observed state without revision telemetry or a
 * success badge. Revision, applied revision and managed-key count live behind
 * `Details`. Warnings and errors carry the Agent's reason immediately.
 */
export function SessionEnvironmentView({
  sessionId,
  sessionName,
  binding,
  profiles,
  agents,
  pending,
  onManage,
  onReapply,
  onRetry,
}: SessionEnvironmentViewProps) {
  const status = bindingStatus(binding.binding, binding.error);
  const desired = binding.binding?.desired_profiles ?? [];
  const showReapply = status.outdated || status.status === 'error';
  const showRetry = status.status === 'unavailable';

  if (binding.loading && !binding.binding) {
    return (
      <div
        data-testid="env-session-environment"
        className={cn('flex h-full min-h-0 flex-col gap-3 p-4', workspaceScrollClearanceClass)}
      >
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div
      data-testid="env-session-environment"
      data-status={status.status}
      className={cn(
        'flex h-full min-h-0 flex-col overflow-y-auto p-4',
        workspaceScrollClearanceClass,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
            Session environment
          </p>
          <h2 className={cn('truncate', chromeSansRole('title'))}>
            {sessionName ?? sessionId}
          </h2>
          <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
            {sessionName ? `${sessionId} · ` : ''}
            {desired.length === 0
              ? 'No profiles included'
              : `${desired.length} ${desired.length === 1 ? 'profile' : 'profiles'} · later profiles win`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {showRetry ? (
            <Button size="sm" variant="outline" data-testid="env-session-retry" onClick={onRetry}>
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          ) : null}
          {showReapply ? (
            <Button
              size="sm"
              variant="outline"
              data-testid="env-session-reapply"
              disabled={pending}
              onClick={() => void onReapply()}
            >
              Reapply
            </Button>
          ) : null}
          <Button
            size="sm"
            data-testid="env-manage-binding"
            disabled={pending}
            onClick={onManage}
          >
            Manage binding
          </Button>
        </div>
      </div>

      <StatusPanel
        status={status}
        binding={binding.binding}
        reason={binding.binding?.observed?.last_error ?? binding.error}
      />

      <div className="mt-5 min-h-0">
        <h3 className={cn('mb-2', chromeSansRole('primary'))}>Included profiles</h3>
        <IncludedProfiles desired={desired} profiles={profiles} agents={agents} />
      </div>
    </div>
  );
}
