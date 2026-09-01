import { cn } from '@/lib/utils';
import { WORKSPACE_TOOLS } from '@/session-first/workspace/tools';
import type { WorkspaceContext, WorkspaceToolId } from '@/session-first/workspace/toolTypes';

export interface WorkspaceShellProps {
  ctx: WorkspaceContext;
  activeTool: WorkspaceToolId;
}

/**
 * Workspace framework: renders the registry-driven bottom floating tool bar
 * and the active tool's layout for the current experience. The tool content
 * area sits on the workspace ground tier; the floating bar is the only
 * elevated element (capsule family).
 */
export function WorkspaceShell({ ctx, activeTool }: WorkspaceShellProps) {
  const active = WORKSPACE_TOOLS.find((t) => t.id === activeTool) ?? WORKSPACE_TOOLS[0];
  const ActiveLayout = active.layout[ctx.experience];

  return (
    <div
      data-testid="workspace-shell"
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40"
    >
      <div data-testid="workspace-tool-content" className="min-h-0 flex-1 overflow-hidden">
        <ActiveLayout ctx={ctx} />
      </div>
      <div
        data-testid="workspace-tool-bar"
        className="pointer-events-none absolute inset-x-0 bottom-[var(--sf-space-3)] z-10 flex justify-center px-4"
      >
        <div
          role="tablist"
          aria-label="Workspace tools"
          className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/60 bg-background px-1.5 py-1.5 shadow-lg"
        >
          {WORKSPACE_TOOLS.map((tool) => {
            const available = tool.availability(ctx);
            const Icon = tool.icon;
            const isActive = tool.id === activeTool;
            return (
              <button
                key={tool.id}
                id={`workspace-tool-tab-${tool.id}`}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls="workspace-tool-panel"
                disabled={!available}
                data-testid={`workspace-tool-${tool.id}`}
                onClick={() => ctx.onToolChange(tool.id)}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-[var(--sf-motion)] ease-[var(--sf-ease)]',
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                  !available && 'cursor-not-allowed opacity-40',
                )}
              >
                <Icon className="size-3.5" />
                {tool.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
