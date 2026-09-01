import { cn } from '@/lib/utils';
import type {
  AgentChannel,
  AttachmentChannel,
  DomainState,
  SessionChannel,
} from '@/session-first/domainState';

function agentValueClass(channel: AgentChannel): string {
  switch (channel) {
    case 'online':
      return '';
    case 'offline':
      return 'text-agent-offline';
    case 'error':
      return 'text-agent-error';
  }
}

function sessionValueClass(channel: SessionChannel): string {
  switch (channel) {
    case 'active':
      return '';
    case 'exited':
      return 'text-session-exited';
    case 'unknown':
      return '';
  }
}

function attachmentValueClass(channel: AttachmentChannel): string {
  switch (channel) {
    case 'attached':
      return '';
    case 'failed':
      return 'text-attachment-failed';
    case 'attaching':
      return 'text-attachment-attaching';
    case 'detached':
      return '';
  }
}

/** Muted by default; tailwind-merge lets a domain state class win (cn = clsx + tailwind-merge). */
function fragmentClass(stateClass: string): string {
  return cn('text-muted-foreground', stateClass);
}

/** Compact single-line form: values joined by ·; healthy = fully muted (P3). */
export function ConnectionStatus({ state }: { state: DomainState }) {
  return (
    <div
      data-testid="connection-status"
      className="flex min-w-0 items-center gap-1 text-xs"
    >
      <span data-testid="channel-agent" className={fragmentClass(agentValueClass(state.agent.channel))}>
        {state.agent.copy ?? state.agent.channel}
      </span>
      <span className="text-muted-foreground/40">·</span>
      <span data-testid="channel-session" className={fragmentClass(sessionValueClass(state.session.channel))}>
        {state.session.copy ?? state.session.channel}
      </span>
      <span className="text-muted-foreground/40">·</span>
      <span data-testid="channel-attachment" className={fragmentClass(attachmentValueClass(state.attachment.channel))}>
        {state.attachment.copy ?? state.attachment.channel}
      </span>
    </div>
  );
}
