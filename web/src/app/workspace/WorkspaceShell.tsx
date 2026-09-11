import { Plus } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { resolveCapabilityPresences } from '@/features/capabilities';
import { cn } from '@/lib/utils';
import { resolveWorkspaceCapabilities } from '@/app/workspace/capabilities';
import {
  buildWorkspacePresentationModel,
  type WorkspacePresentationItem,
} from '@/app/workspace/presentation';
import { WORKSPACE_TOOLS } from '@/app/workspace/tools';
import type {
  WorkspaceContext,
  WorkspaceTool,
  WorkspaceToolId,
} from '@/app/workspace/toolTypes';

const workspaceViewBindings = new Map<string, WorkspaceTool>(
  WORKSPACE_TOOLS.map((tool) => [tool.id, tool]),
);

export interface WorkspaceShellProps {
  ctx: WorkspaceContext;
  activeCapabilityId: WorkspaceToolId;
}

function bindingFor(item: WorkspacePresentationItem): WorkspaceTool | undefined {
  return workspaceViewBindings.get(item.snapshot.id);
}

interface CapabilityDisclosureMenuProps {
  items: WorkspacePresentationItem[];
  onSelect: (id: WorkspaceToolId) => void;
}

/** Progressive disclosure for capabilities that earned no direct presence. */
function CapabilityDisclosureMenu({ items, onSelect }: CapabilityDisclosureMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="More workspace capabilities"
            data-testid="workspace-capability-more"
            className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)] hover:text-foreground"
          >
            <Plus className="size-3.5" />
            More
          </button>
        }
      />
      <DropdownMenuContent side="top" align="center" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Workspace capabilities</DropdownMenuLabel>
          {items.map((item) => {
            const binding = bindingFor(item)!;
            const Icon = binding.icon;
            return (
              <DropdownMenuItem
                key={item.snapshot.id}
                data-testid={`workspace-capability-picker-${item.snapshot.id}`}
                data-capability-state={item.snapshot.state}
                onClick={() => onSelect(item.snapshot.id)}
              >
                <Icon />
                <span className="min-w-0 flex-1 truncate">{item.snapshot.title}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Workspace framework: semantic capabilities resolve first, then a bounded
 * Nession-owned presentation model decides what earns direct presence and what
 * stays progressively discoverable through More.
 */
export function WorkspaceShell({ ctx, activeCapabilityId }: WorkspaceShellProps) {
  const resolution = resolveWorkspaceCapabilities(ctx);
  const presences = resolveCapabilityPresences(resolution.snapshots, {
    surface: 'workspace',
  });
  const presentation = buildWorkspacePresentationModel({
    snapshots: resolution.snapshots,
    presences,
    openedCapabilityId: activeCapabilityId,
  });

  const openedPresence = presentation.opened?.presence;
  const activeBinding = workspaceViewBindings.get(activeCapabilityId);
  const canRenderActive = activeBinding && openedPresence?.level !== 'hidden';
  const ActiveLayout = canRenderActive ? activeBinding.layout[ctx.experience] : null;

  const directItems = [...presentation.primary, ...presentation.contextual].filter(bindingFor);
  const discoverableItems = presentation.discoverable.filter(bindingFor);
  const hasNavigation = directItems.length > 0 || discoverableItems.length > 0;

  return (
    <div
      data-testid="workspace-shell"
      data-capability-diagnostics={resolution.diagnostics.length}
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40"
    >
      <div data-testid="workspace-tool-content" className="min-h-0 flex-1 overflow-hidden">
        {ActiveLayout ? (
          <ActiveLayout ctx={ctx} />
        ) : (
          <div
            data-testid="workspace-capability-unavailable"
            className="flex h-full min-h-0 items-center justify-center px-6 text-center"
          >
            <div className="max-w-sm space-y-1.5">
              <p className="text-sm font-medium text-foreground">
                {activeBinding?.label ?? activeCapabilityId} is not available here
              </p>
              <p className="text-xs text-muted-foreground">
                Choose another capability from More. Nession will keep this view stable instead of switching automatically.
              </p>
            </div>
          </div>
        )}
      </div>

      {hasNavigation ? (
        <div
          data-testid="workspace-tool-bar"
          data-navigation-mode="contextual"
          className="pointer-events-none absolute inset-x-0 bottom-[var(--shell-space-3)] z-10 flex justify-center px-4"
        >
          <nav
            aria-label="Workspace capabilities"
            className="pointer-events-auto flex items-center gap-1 rounded-full border border-border/60 bg-background px-1.5 py-1.5 shadow-lg"
          >
            {directItems.map((item) => {
              const binding = bindingFor(item)!;
              const Icon = binding.icon;
              const isActive = item.snapshot.id === activeCapabilityId;
              return (
                <button
                  key={item.snapshot.id}
                  id={`workspace-capability-${item.snapshot.id}`}
                  type="button"
                  aria-pressed={isActive}
                  data-testid={`workspace-tool-${item.snapshot.id}`}
                  data-capability-state={item.snapshot.state}
                  data-capability-presence={item.presence.level}
                  onClick={() => ctx.onToolChange(item.snapshot.id)}
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors duration-[var(--motion-shell-duration)] ease-[var(--motion-shell-ease)]',
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" />
                  {item.snapshot.title}
                </button>
              );
            })}

            {discoverableItems.length > 0 ? (
              <CapabilityDisclosureMenu
                items={discoverableItems}
                onSelect={ctx.onToolChange}
              />
            ) : null}
          </nav>
        </div>
      ) : null}
    </div>
  );
}
