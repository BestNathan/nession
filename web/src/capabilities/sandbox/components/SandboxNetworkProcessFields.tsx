import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { SandboxNetworkMode } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import type { SandboxDraftState } from '../hooks/useSandboxDraft';
import { entriesToLines } from '../model';

const NETWORK_MODES: readonly SandboxNetworkMode[] = ['allow', 'deny', 'restricted'];
const NAMESPACES = ['pid', 'ipc', 'user', 'uts', 'cgroup'] as const;

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn(chromeSansRole('caption'), 'text-muted-foreground')}
    >
      {children}
    </label>
  );
}

/** Network mode/egress and the explicit Linux namespace requests. */
export function SandboxNetworkProcessFields({ draft }: { draft: SandboxDraftState }) {
  const namespaces = draft.draft.process?.linux_namespaces;
  const mode = draft.draft.network?.mode ?? 'allow';
  const changeMode = (value: SandboxNetworkMode | null) => {
    if (!value) {
      return;
    }
    draft.patch({
      network:
        value === 'restricted'
          ? {
              mode: value,
              ingress: 'deny',
              egress: draft.draft.network?.egress ?? {
                allow: [],
                deny: [],
                private_network: 'deny',
              },
            }
          : { mode: value, ingress: 'deny' },
    });
  };
  return (
    <>
      <fieldset className="flex min-w-0 flex-col gap-3 rounded-[var(--nession-radius-surface)] border border-border/60 p-3">
        <legend className={cn(chromeSansRole('primary'), 'px-1')}>Network</legend>
        <div className="flex min-w-0 flex-col gap-1">
          <FieldLabel htmlFor="sandbox-network-mode">Mode</FieldLabel>
          <Select value={mode} onValueChange={changeMode}>
            <SelectTrigger id="sandbox-network-mode" data-testid="sandbox-network-mode">
              <span>{mode}</span>
            </SelectTrigger>
            <SelectContent>
              {NETWORK_MODES.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {candidate}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {mode === 'restricted' ? (
          <div className="flex min-w-0 flex-col gap-3 sm:flex-row">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldLabel htmlFor="sandbox-egress-allow">Allowed destinations</FieldLabel>
              <Textarea
                id="sandbox-egress-allow"
                data-testid="sandbox-egress-allow"
                rows={2}
                value={entriesToLines(draft.draft.network?.egress?.allow ?? [])}
                onChange={(event) => draft.setEgress('allow', event.target.value)}
              />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <FieldLabel htmlFor="sandbox-egress-deny">Denied destinations</FieldLabel>
              <Textarea
                id="sandbox-egress-deny"
                data-testid="sandbox-egress-deny"
                rows={2}
                value={entriesToLines(draft.draft.network?.egress?.deny ?? [])}
                onChange={(event) => draft.setEgress('deny', event.target.value)}
              />
            </div>
          </div>
        ) : null}
      </fieldset>

      <fieldset className="flex min-w-0 flex-col gap-3 rounded-[var(--nession-radius-surface)] border border-border/60 p-3">
        <legend className={cn(chromeSansRole('primary'), 'px-1')}>Process namespaces</legend>
        <p className={cn(chromeSansRole('caption'), 'text-muted-foreground')}>
          Linux-native. The backend baseline namespaces are always present; these are explicit
          additional requests.
        </p>
        <div className="flex flex-wrap gap-4">
          {NAMESPACES.map((namespace) => (
            <label
              key={namespace}
              className="flex min-h-11 items-center gap-2"
              htmlFor={`sandbox-namespace-${namespace}`}
            >
              <Checkbox
                id={`sandbox-namespace-${namespace}`}
                data-testid={`sandbox-namespace-${namespace}`}
                checked={namespaces?.[namespace] ?? false}
                disabled={namespace === 'cgroup' && !(namespaces?.user ?? false)}
                onCheckedChange={() => draft.toggleNamespace(namespace)}
              />
              <span className={chromeSansRole('secondary')}>{namespace}</span>
            </label>
          ))}
        </div>
        {namespaces?.cgroup && !namespaces.user ? (
          <p className={cn(chromeSansRole('caption'), 'text-destructive')}>
            The cgroup namespace requires the user namespace.
          </p>
        ) : null}
      </fieldset>
    </>
  );
}
