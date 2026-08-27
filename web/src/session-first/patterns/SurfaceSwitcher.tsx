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
      <TabsList>
        <TabsTrigger value="terminal">Terminal</TabsTrigger>
        <TabsTrigger value="workspace">Workspace</TabsTrigger>
      </TabsList>
      <TabsContent value="terminal" className="hidden" />
      <TabsContent value="workspace" className="hidden" />
    </Tabs>
  );
}
