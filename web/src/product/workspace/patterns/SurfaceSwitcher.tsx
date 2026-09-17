import { LayoutPanelTop, SquareTerminal } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type Surface = 'terminal' | 'workspace';

export interface SurfaceSwitcherProps {
  surface: Surface;
  onSurfaceChange: (surface: Surface) => void;
}

/** The two surfaces, in the order they are offered. Icons only — the labels
 *  live in `aria-label` and the tooltip, because a text control floating over
 *  the terminal would be the loudest thing on a quiet surface. */
const SURFACES = [
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'workspace', label: 'Workspace', icon: LayoutPanelTop },
] as const;

/**
 * Terminal ↔ Workspace, as a floating icon capsule at the work surface's
 * top-right.
 *
 * It used to be a segmented text control inside the SessionHeader; the header
 * is gone (#748), so the affordance floats instead. It keeps `role="tab"` for
 * the two surfaces — this still switches work depth, not tools — and it keeps
 * the shared floating-surface elevation so it reads as one family with the
 * capsule rather than as a rival (visual-language.md).
 */
export function SurfaceSwitcher({ surface, onSurfaceChange }: SurfaceSwitcherProps) {
  return (
    <Tabs
      value={surface}
      onValueChange={(v) => onSurfaceChange(v as Surface)}
      data-testid="surface-switcher"
    >
      <TabsList className="h-auto gap-0.5 rounded-[var(--radius-capsule)] bg-[color:var(--terminal-capsule-surface)] p-1 shadow-[var(--elevation-floating)] backdrop-blur-md">
        {SURFACES.map((entry) => {
          const Icon = entry.icon;
          return (
            <TabsTrigger
              key={entry.id}
              value={entry.id}
              aria-label={entry.label}
              title={entry.label}
              className="size-[length:var(--control-md)] rounded-[var(--radius-capsule)] text-muted-foreground transition-colors hover:text-foreground data-active:bg-accent data-active:text-foreground"
            >
              <Icon className="size-[length:var(--icon-sm)]" aria-hidden />
            </TabsTrigger>
          );
        })}
      </TabsList>
      <TabsContent value="terminal" className="hidden" />
      <TabsContent value="workspace" className="hidden" />
    </Tabs>
  );
}
