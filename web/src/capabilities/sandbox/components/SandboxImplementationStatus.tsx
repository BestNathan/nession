import { Badge } from '@/components/ui/badge';
import type { SandboxCapabilityCatalog } from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { cn } from '@/shared/lib/utils';
import { implementationDisabledReason, implementationSupport } from '../model';

export interface SandboxImplementationStatusProps {
  catalog: SandboxCapabilityCatalog;
  /** Canonical policy path, for example `resource.cgroup_v2`. */
  path: string;
  label: string;
}

/**
 * One registered policy implementation's measured status (#3161).
 *
 * The Agent owns the status; this component never derives support from the
 * platform or from the presence of an editor. An unavailable or unmeasured
 * implementation stays visible with its reason but its controls are disabled
 * by the owning section.
 */
export function SandboxImplementationStatus({
  catalog,
  path,
  label,
}: SandboxImplementationStatusProps) {
  const implementation = implementationSupport(catalog, path);
  const status = implementation?.status ?? 'unknown';
  const reason = implementationDisabledReason(catalog, path);
  return (
    <div
      data-testid={`sandbox-implementation-${path}`}
      className="flex min-w-0 flex-wrap items-center gap-2"
    >
      <span className={chromeSansRole('secondary')}>{label}</span>
      <Badge data-testid={`sandbox-implementation-status-${path}`} variant="outline">
        {status}
      </Badge>
      {reason ? (
        <span
          data-testid={`sandbox-implementation-reason-${path}`}
          className={cn(chromeSansRole('caption'), 'min-w-0 text-muted-foreground')}
        >
          {reason}
        </span>
      ) : null}
    </div>
  );
}
