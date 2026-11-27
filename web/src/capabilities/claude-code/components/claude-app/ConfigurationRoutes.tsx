import { Button } from '@/components/ui/button';
import { RefreshButton } from '@/components/ui/RefreshButton';
import { cn } from '@/shared/lib/utils';
import { chromeSansRole } from '@/shared/typography/chromeRoles';
import { workspaceFixedContextClearanceClass } from '@/shared/lib/workspaceScrollClearance';
import type { ClaudeCodeConfigFile, ClaudeCodeConfigScope } from '../../hooks/useClaudeCodeWorkspace';
import { ContentPanel, ScopePanel } from '../ClaudeCodeWorkspace';
import type { ClaudeAppData } from './model';

const CONFIG_SCOPES: ClaudeCodeConfigScope[] = ['project', 'global'];

function scopeLabel(scope: ClaudeCodeConfigScope): string {
  return scope === 'project' ? 'Project' : 'Global';
}

/**
 * Configuration's own scope axis, inside Configuration (#1120 item 7).
 *
 * `Project` and `Global` are scopes *of configuration*, not siblings of the
 * conversation, so they live under this resource rather than beside it. The
 * file list is a single column: App pushes the file, it never compresses Web's
 * tree-and-editor grid into 390 px.
 */
export function ConfigurationRoute({ data }: { data: ClaudeAppData }) {
  const state = data.state;
  const activeScope = state.activeScope;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-configuration">
      <div className="flex shrink-0 items-center border-b px-[var(--nession-shell-space-4)] py-[var(--nession-shell-space-2)]">
        <div
          role="group"
          aria-label="Claude configuration scope"
          className="flex gap-[var(--nession-shell-space-1)] rounded-[var(--nession-radius-control)] bg-muted p-[var(--nession-shell-space-1)]"
        >
          {CONFIG_SCOPES.map((scope) => (
            <Button
              key={scope}
              type="button"
              size="sm"
              variant={activeScope === scope ? 'default' : 'ghost'}
              aria-pressed={activeScope === scope}
              data-testid={`claude-app-configuration-${scope}`}
              onClick={() => state.setActiveScope(scope)}
            >
              {scopeLabel(scope)}
            </Button>
          ))}
        </div>
        {/* #4602: resting manual refresh of the current config scope. */}
        <span className="ml-auto">
          <RefreshButton
            onClick={() => state.handleRetry(activeScope)}
            variant="ghost"
            ariaLabel="Refresh Claude Code configuration"
          />
        </span>
      </div>
      <ScopePanel
        state={state.scopeStates[activeScope]}
        scope={activeScope}
        active
        touch
        onFileClick={(scope, file: ClaudeCodeConfigFile) => {
          state.setActiveScope(scope);
          void state.handleFileClick(scope, file);
          data.actions.push({ kind: 'config-file', scope, path: file.path });
        }}
        onRetry={state.handleRetry}
      />
      <p
        data-workspace-fixed-role="context"
        data-testid="claude-app-configuration-note"
        className={cn('shrink-0 px-[var(--nession-shell-space-4)] py-[var(--nession-shell-space-2)] text-muted-foreground', chromeSansRole('caption'), workspaceFixedContextClearanceClass)}
      >
        Configuration is read-only here. Editing belongs to an explicitly authorized
        operation.
      </p>
    </div>
  );
}

/** One configuration file's bounded content, pushed as its own depth. */
export function ConfigFileRoute({
  scope,
  data,
}: {
  scope: ClaudeCodeConfigScope;
  data: ClaudeAppData;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="claude-app-config-file">
      <ContentPanel
        state={data.state.scopeStates[scope]}
        scope={scope}
        onLoadMore={data.state.handleLoadMore}
      />
    </div>
  );
}
