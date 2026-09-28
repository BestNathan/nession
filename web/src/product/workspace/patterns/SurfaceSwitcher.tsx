import { LayoutPanelTop, SquareTerminal } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/shared/lib/utils';

export type Surface = 'terminal' | 'workspace';

export interface SurfaceSwitcherProps {
  surface: Surface;
  onSurfaceChange: (surface: Surface) => void;
}

const SURFACES = [
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'workspace', label: 'Workspace', icon: LayoutPanelTop },
] as const;

/**
 * Terminal ↔ Workspace, as a floating capsule at the work surface's top-right.
 *
 * The placement wrapper in `ShellMain` stays `pointer-events-none` so transparent
 * overlay space does not steal Terminal clicks; this root opts back in (#1168).
 *
 * Active Surface shows icon + short label; the inactive entry stays icon-only
 * with tooltip / `aria-label` (#1169).
 */
export function SurfaceSwitcher({ surface, onSurfaceChange }: SurfaceSwitcherProps) {
  return (
    <Tabs
      value={surface}
      onValueChange={(v) => onSurfaceChange(v as Surface)}
      data-testid="surface-switcher"
      className="pointer-events-auto"
    >
      <TabsList className="h-auto gap-0.5 rounded-[var(--radius-capsule)] bg-[color:var(--terminal-capsule-surface)] p-1 shadow-[var(--elevation-floating)] backdrop-blur-md">
        {SURFACES.map((entry) => {
          const Icon = entry.icon;
          const isActive = surface === entry.id;
          return (
            <TabsTrigger
              key={entry.id}
              value={entry.id}
              aria-label={entry.label}
              title={entry.label}
              data-testid={`surface-switcher-${entry.id}`}
              className={cn(
                'inline-flex shrink-0 items-center justify-center gap-1 rounded-[var(--radius-capsule)] text-muted-foreground transition-[color,background-color,padding] duration-[length:var(--motion-shell-duration)] ease-[var(--motion-shell-ease)] motion-reduce:transition-none hover:text-foreground data-active:bg-accent data-active:text-foreground',
                isActive
                  ? 'h-[length:var(--control-md)] px-2'
                  : 'size-[length:var(--control-md)]',
              )}
            >
              <Icon className="size-[length:var(--icon-sm)]" aria-hidden />
              {isActive ? (
                <span className="text-xs font-medium leading-none">{entry.label}</span>
              ) : null}
            </TabsTrigger>
          );
        })}
      </TabsList>
      <TabsContent value="terminal" className="hidden" />
      <TabsContent value="workspace" className="hidden" />
    </Tabs>
  );
}
