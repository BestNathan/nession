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
      return 'text-agent-online';
    case 'offline':
      return 'text-agent-offline';
    case 'error':
      return 'text-agent-error';
  }
}

function sessionValueClass(channel: SessionChannel): string {
  switch (channel) {
    case 'active':
      return 'text-session-active';
    case 'exited':
      return 'text-session-exited';
    case 'unknown':
      return 'text-session-unknown';
  }
}

function attachmentValueClass(channel: AttachmentChannel): string {
  switch (channel) {
    case 'attached':
      return 'text-attachment-attached';
    case 'failed':
      return 'text-attachment-failed';
    case 'attaching':
      return 'text-attachment-attaching';
    case 'detached':
      return 'text-attachment-detached';
  }
}

export function ConnectionStatus({ state }: { state: DomainState }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
      <span data-testid="channel-agent">
        <span className="text-muted-foreground">Agent </span>
        <span className={cn(agentValueClass(state.agent.channel))}>
          {state.agent.copy ?? state.agent.channel}
        </span>
      </span>
      <span data-testid="channel-session">
        <span className="text-muted-foreground">Session </span>
        <span className={cn(sessionValueClass(state.session.channel))}>
          {state.session.copy ?? state.session.channel}
        </span>
      </span>
      <span data-testid="channel-attachment">
        <span className="text-muted-foreground">This client </span>
        <span className={cn(attachmentValueClass(state.attachment.channel))}>
          {state.attachment.copy ?? state.attachment.channel}
        </span>
      </span>
    </div>
  );
}
