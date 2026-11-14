import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';

/** The Sandbox capability's four sections (#3408). */
export const SANDBOX_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'images', label: 'Images' },
  { id: 'workspaces', label: 'Workspaces' },
  { id: 'policies', label: 'Policies' },
] as const;

export type SandboxSectionId = (typeof SANDBOX_SECTIONS)[number]['id'];

export interface SandboxSectionNavProps {
  experience: 'web' | 'app';
  value: SandboxSectionId;
  onValueChange: (value: SandboxSectionId) => void;
}

/**
 * Capability-local first-level navigation.
 *
 * Web places the nav at the right of the Sandbox header; App uses one compact
 * horizontal strip below the host's AppPageHeader. It never pushes route or
 * history depth and never becomes global application chrome.
 */
export function SandboxSectionNav({
  experience,
  value,
  onValueChange,
}: SandboxSectionNavProps) {
  return (
    <nav
      aria-label="Sandbox sections"
      data-testid="sandbox-sections"
      data-orientation={experience === 'web' ? 'horizontal' : 'horizontal'}
      className={cn(
        'flex min-w-0 items-center gap-1',
        experience === 'app' && 'w-full overflow-x-auto',
      )}
    >
      {SANDBOX_SECTIONS.map((section) => {
        const active = section.id === value;
        return (
          <button
            key={section.id}
            type="button"
            data-testid={`sandbox-section-${section.id}`}
            aria-current={active ? 'page' : undefined}
            onClick={() => onValueChange(section.id)}
            className={cn(
              'shrink-0 rounded-[var(--nession-radius-control)] px-3 transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              experience === 'web' ? 'h-8' : 'h-11',
              active
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              chromeSansRole('secondary'),
            )}
          >
            {section.label}
          </button>
        );
      })}
    </nav>
  );
}
