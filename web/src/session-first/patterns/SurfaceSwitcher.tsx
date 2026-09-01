import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type Surface = 'terminal' | 'workspace';

export interface SurfaceSwitcherProps {
  surface: Surface;
  onSurfaceChange: (surface: Surface) => void;
}

export function SurfaceSwitcher({ surface, onSurfaceChange }: SurfaceSwitcherProps) {
  return (
    <Tabs
      value={surface}
      onValueChange={(v) => onSurfaceChange(v as Surface)}
      data-testid="surface-switcher"
    >
      <TabsList className="h-auto gap-0.5 bg-transparent p-0">
        <TabsTrigger
          value="terminal"
          className="rounded-none bg-transparent px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground"
        >
          Terminal
        </TabsTrigger>
        <TabsTrigger
          value="workspace"
          className="rounded-none bg-transparent px-1.5 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground"
        >
          Workspace
        </TabsTrigger>
      </TabsList>
      <TabsContent value="terminal" className="hidden" />
      <TabsContent value="workspace" className="hidden" />
    </Tabs>
  );
}
