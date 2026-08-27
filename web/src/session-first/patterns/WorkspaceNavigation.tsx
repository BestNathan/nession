import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export type WorkspaceToolId = 'files' | 'session' | 'agent';

export interface WorkspaceNavigationProps {
  tool: WorkspaceToolId;
  onToolChange: (tool: WorkspaceToolId) => void;
  filesAvailable: boolean;
}

export function WorkspaceNavigation({
  tool,
  onToolChange,
  filesAvailable,
}: WorkspaceNavigationProps) {
  return (
    <Tabs
      value={tool}
      onValueChange={(v) => onToolChange(v as WorkspaceToolId)}
      data-testid="workspace-navigation"
    >
      <TabsList>
        {filesAvailable && <TabsTrigger value="files">Files</TabsTrigger>}
        <TabsTrigger value="session">Session</TabsTrigger>
        <TabsTrigger value="agent">Agent</TabsTrigger>
      </TabsList>
      {filesAvailable && <TabsContent value="files" className="hidden" />}
      <TabsContent value="session" className="hidden" />
      <TabsContent value="agent" className="hidden" />
    </Tabs>
  );
}
