import { FileText, FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/shared/lib/utils';
import { chromeLabelRole, chromeMonoRole, chromeSansRole } from '@/shared/typography/chromeRoles';
import { WorkspaceBoundedScrollport } from '@/components/ui/workspace-scrollport';
import type { WorkspaceContext } from '@/app/workspace/workspaceContext';
import { ConversationView } from '@/shared/ai-conversation';
import { claudeCodeConversationAdapter } from '../conversation/adapter';
import { useMemory } from '../hooks/useMemory';
import type { useMcp } from '../hooks/useMcp';
import {
  SCOPES,
  useClaudeCodeWorkspace,
  type ClaudeCodeConfigFile,
  type ClaudeCodeConfigScope,
  type ClaudeCodeResourceView,
  type ScopeState,
} from '../hooks/useClaudeCodeWorkspace';
import { TranscriptView } from './TranscriptView';
import { MemoryView } from './MemoryView';
import { McpPane } from './McpView';
import { formatSize } from '../format';

/**
 * The configuration file list for one scope.
 *
 * Exported because the App's Claude composition draws the same owner as a
 * pushed single-column screen; the rows keep one definition so the two
 * experiences cannot disagree about which files exist or what selecting one
 * means. `touch` raises the row floor to the App's 44px target without
 * changing Web's denser pointer row.
 */
export function FileList({
  state,
  scope,
  onFileClick,
  active,
  touch = false,
}: {
  state: ScopeState;
  scope: ClaudeCodeConfigScope;
  onFileClick: (scope: ClaudeCodeConfigScope, file: ClaudeCodeConfigFile) => void;
  active: boolean;
  touch?: boolean;
}) {
  return (
    <div className="space-y-[var(--nession-shell-space-4)] p-[var(--nession-shell-space-3)]" data-testid={active ? 'claude-code-file-list' : undefined}>
      {state.categories.map((category) => (
        <section key={category.name}>
          <h2 className={cn('mb-[var(--nession-shell-space-1)] px-[var(--nession-shell-space-2)] text-muted-foreground', chromeLabelRole())}>
            {category.name}
          </h2>
          <div className="space-y-[var(--nession-rhythm-fact-stack)]">
            {category.files.map((file) => (
              <button
                key={file.path}
                type="button"
                aria-label={file.path}
                aria-current={state.selectedFile?.path === file.path ? 'true' : undefined}
                onClick={() => onFileClick(scope, file)}
                className={cn(
                  'flex w-full items-center gap-[var(--nession-shell-space-2)] rounded-[var(--nession-radius-control)] px-[var(--nession-shell-space-2)] py-[var(--nession-rhythm-field-stack)] text-left transition-colors',
                  touch && 'min-h-[length:var(--nession-control-md)]',
                  chromeSansRole('secondary'),
                  'hover:bg-accent hover:text-accent-foreground focus-visible:outline-solid focus-visible:outline-[length:var(--nession-focus-ring-width)] focus-visible:outline-ring focus-visible:outline-offset-[calc(-1*var(--nession-focus-ring-offset))]',
                  state.selectedFile?.path === file.path && 'bg-accent text-accent-foreground',
                )}
              >
                <FileText className="size-[length:var(--nession-icon-sm)] shrink-0 text-muted-foreground" />
                <span className="truncate">{file.path}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/**
 * One configuration scope: the list, or the provider's own answer for why it
 * cannot be listed. Exported for the App composition for the same reason as
 * `FileList`.
 */
export function ScopePanel({
  state,
  scope,
  onFileClick,
  onRetry,
  active,
  touch = false,
}: {
  state: ScopeState;
  scope: ClaudeCodeConfigScope;
  onFileClick: (scope: ClaudeCodeConfigScope, file: ClaudeCodeConfigFile) => void;
  onRetry: (scope: ClaudeCodeConfigScope) => void;
  active: boolean;
  touch?: boolean;
}) {
  if (state.loading) {
    return (
      <div className="p-[var(--nession-shell-space-4)]" data-testid={`claude-code-scope-${scope}`} data-scope={scope}>
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>Loading Claude Code files...</p>
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="space-y-[var(--nession-shell-space-3)] p-[var(--nession-shell-space-4)]" data-testid={`claude-code-scope-${scope}`} data-scope={scope}>
        <p className={cn('text-destructive', chromeSansRole('body'))} role="alert">{state.error}</p>
        <Button
          data-testid={`claude-code-retry-${scope}`}
          variant="outline"
          size="sm"
          onClick={() => onRetry(scope)}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (state.available === false) {
    return (
      <div className="p-[var(--nession-shell-space-4)]" data-testid={`claude-code-scope-${scope}`} data-scope={scope}>
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>Claude Code not installed</p>
      </div>
    );
  }
  if (state.categories.length === 0) {
    return (
      <div className="p-[var(--nession-shell-space-4)]" data-testid={`claude-code-scope-${scope}`} data-scope={scope}>
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>No Claude Code files found.</p>
      </div>
    );
  }
  return (
    <WorkspaceBoundedScrollport
      data-testid={`claude-code-scope-${scope}`}
      data-scope={scope}
    >
      <FileList state={state} scope={scope} onFileClick={onFileClick} active={active} touch={touch} />
    </WorkspaceBoundedScrollport>
  );
}

/**
 * The read half of Configuration: the selected file's identity and content.
 * Exported for the App's pushed file depth.
 */
export function ContentPanel({
  state,
  scope,
  onLoadMore,
}: {
  state: ScopeState;
  scope: ClaudeCodeConfigScope;
  onLoadMore: (scope: ClaudeCodeConfigScope) => void;
}) {
  if (!state.selectedFile) {
    return <p className={cn('p-[var(--nession-shell-space-5)] text-muted-foreground', chromeSansRole('secondary'))}>Select a file to view its content.</p>;
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col p-[var(--nession-shell-space-4)]">
      <div className="flex flex-wrap items-center justify-between gap-[var(--nession-shell-space-3)] border-b pb-[var(--nession-shell-space-3)]">
        <div className="min-w-0">
          <p className={cn('truncate', chromeMonoRole('code'))} title={state.selectedFile.path}>{state.selectedFile.path}</p>
          <p className={cn('text-muted-foreground', chromeSansRole('metadata'))}>
            {state.contentType || state.selectedFile.content_type} · {formatSize(state.totalSize || state.selectedFile.size)}
          </p>
        </div>
        {state.hasMore && (
          <Button
            data-testid="claude-code-load-more"
            variant="outline"
            size="sm"
            disabled={state.readLoading}
            onClick={() => onLoadMore(scope)}
          >
            Load more
          </Button>
        )}
      </div>
      {state.readLoading && <p className={cn('py-[var(--nession-shell-space-3)] text-muted-foreground', chromeSansRole('secondary'))}>Loading content...</p>}
      {state.readError && <p className={cn('py-[var(--nession-shell-space-3)] text-destructive', chromeSansRole('body'))} role="alert">{state.readError}</p>}
      <WorkspaceBoundedScrollport viewportClassName="overflow-auto" data-testid="claude-code-content">
        <pre className={cn('whitespace-pre-wrap py-[var(--nession-shell-space-4)]', chromeMonoRole('code'))}>
          {state.content || (state.readLoading ? '' : '(empty)')}
        </pre>
      </WorkspaceBoundedScrollport>
    </div>
  );
}

/**
 * The Web presentation of Claude Code's Workspace (#1120, #1234, #2689, #3600).
 *
 * Five sections in one tab strip, with master/detail Configuration and
 * Transcript views. App no longer shares this composition: it draws the
 * conversation-first stack in `ClaudeCodeAppWorkspace` (#3829), while both
 * surfaces share `useClaudeCodeWorkspace` so the data and its guards stay one
 * owner.
 */
export function ClaudeCodeWorkspace({ ctx }: { ctx: WorkspaceContext }) {
  const {
    agentId,
    sessionId,
    activeScope,
    setActiveScope,
    activeView,
    setActiveView,
    scopeStates,
    handleRetry,
    handleFileClick,
    handleLoadMore,
    conversation,
    transcripts,
    transcriptRecords,
    openTranscript,
    setOpenTranscript,
    memory,
    mcp,
  } = useClaudeCodeWorkspace(ctx);

  if (!agentId || !sessionId) {
    return (
      <div data-testid="claude-code-workspace" className="flex h-full min-h-0 items-center justify-center p-[var(--nession-shell-space-5)]">
        <p className={cn('text-muted-foreground', chromeSansRole('secondary'))}>Select an agent and session to browse Claude Code files.</p>
      </div>
    );
  }

  const activeState = scopeStates[activeScope];
  const showHeading = ctx.experience !== 'app';
  return (
    <div data-testid="claude-code-workspace" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-[var(--nession-shell-space-4)] border-b px-[var(--nession-shell-space-4)] py-[var(--nession-shell-space-3)]">
        {showHeading ? (
          <div className="flex items-center gap-[var(--nession-shell-space-2)]">
            <FolderOpen className="size-[length:var(--nession-icon-md)] text-muted-foreground" />
            <h1 className={chromeSansRole('title')}>Claude Code</h1>
          </div>
        ) : null}
        <Tabs
          value={activeView}
          onValueChange={(value) => setActiveView(value as ClaudeCodeResourceView)}
          className="min-w-0"
        >
          {/* Named so the visual gate can assert this strip as a *region*
              (#1332). A change here — this strip gained its third tab — is a
              large fraction of this element and a negligible fraction of the
              frame, which is why the whole-frame budget did not see it.
              The strip wraps rather than clipping its last tab: App hides the
              heading but not the padding, and four tabs no longer fit 390 px. */}
          <TabsList
            data-testid="claude-code-view-tabs"
            className="max-w-full flex-wrap justify-end max-sm:h-auto!"
          >
            <TabsTrigger value="conversations">Conversations</TabsTrigger>
            <TabsTrigger value="transcripts">Transcripts</TabsTrigger>
            <TabsTrigger value="memory">Memory</TabsTrigger>
            <TabsTrigger value="mcp">MCP</TabsTrigger>
            <TabsTrigger value="configuration">Configuration</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>
      {/* Render every panel but hide the inactive ones. Conditional rendering
          would unmount a view on tab switch, resetting its local state (showList,
          scroll positions) and causing a visual "refresh". Keeping them mounted
          preserves the user's position — which for Transcripts is what makes
          switching to Configuration and back not lose the open transcript. */}
      <main className={activeView === 'conversations' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <ConversationView
          snapshot={conversation.snapshot}
          providerLabel={claudeCodeConversationAdapter.identity.label}
          // `#1120` items 8 and 9. The mapping lives here rather than inside
          // the view because it is the same decision `showHeading` above
          // already makes from the same field: what the experience has room
          // for. A viewport, not a mode — and App is the only one that has to
          // push.
          layout={ctx.experience === 'app' ? 'push' : 'master-detail'}
          onSelect={conversation.select}
          onLoadOlder={conversation.loadOlder}
          onReload={conversation.reload}
        />
      </main>
      <main className={activeView === 'transcripts' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
        <TranscriptView
          list={transcripts.list}
          records={transcriptRecords.records}
          open={openTranscript}
          agentId={agentId}
          sessionId={sessionId}
          // The same split `ConversationView` makes from the same field: the
          // experience decides how much room there is, and App has to push.
          layout={ctx.experience === 'app' ? 'push' : 'master-detail'}
          onSelect={setOpenTranscript}
          onLoadOlder={() => transcriptRecords.loadOlder()}
          onReload={() => transcriptRecords.reload()}
          onBack={() => setOpenTranscript(null)}
          onRefresh={transcripts.refresh}
          refreshing={transcripts.refreshing}
        />
      </main>
      <MemoryPane active={activeView === 'memory'} memory={memory} />
      <McpWorkspacePane active={activeView === 'mcp'} mcp={mcp} experience={ctx.experience} />
      <div className={activeView === 'configuration' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
          {/* Configuration's own sub-axis (#1120 item 7). It sits here, under
              the section that has scopes, rather than beside `Conversations` —
              which is the whole of the flattening this change undoes. */}
          <div className="flex shrink-0 items-center border-b px-[var(--nession-shell-space-4)] py-[var(--nession-shell-space-2)]">
            <Tabs value={activeScope} onValueChange={(value) => setActiveScope(value as ClaudeCodeConfigScope)}>
              <TabsList>
                <TabsTrigger value="project">Project</TabsTrigger>
                <TabsTrigger value="global">Global</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(12rem,18rem)_minmax(0,1fr)]">
            <aside className="min-h-0 border-r">
              {SCOPES.map((scope) => (
                <div key={scope} className={activeScope === scope ? 'flex h-full min-h-0' : 'hidden'}>
                  <ScopePanel
                    state={scopeStates[scope]}
                    scope={scope}
                    onFileClick={handleFileClick}
                    onRetry={handleRetry}
                    active={activeScope === scope}
                  />
                </div>
              ))}
            </aside>
            <main className="flex min-h-0 flex-col">
              <ContentPanel state={activeState} scope={activeScope} onLoadMore={handleLoadMore} />
            </main>
          </div>
        </div>
    </div>
  );
}

function McpWorkspacePane({
  active,
  mcp,
  experience,
}: {
  active: boolean;
  mcp: ReturnType<typeof useMcp>;
  experience: WorkspaceContext['experience'];
}) {
  return (
    <main className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      {/* Keyed by Session so a switch unmounts an open editor or confirmation
          dialog instead of leaving a write aimed at the previous target (#3600). */}
      <McpPane
        key={mcp.sessionKey ?? 'no-session'}
        mcp={mcp}
        experience={experience}
      />
    </main>
  );
}

function MemoryPane({
  active,
  memory,
}: {
  active: boolean;
  memory: ReturnType<typeof useMemory>;
}) {
  return (
    <main className={active ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
      <MemoryView
        memory={memory.memory}
        onOpenFile={(path) => void memory.openFile(path)}
        onLoadMore={() => memory.loadMore()}
        onRetry={() => memory.retry()}
        onRetryRead={() => {
          const path = memory.memory.selectedPath;
          if (path) {
            void memory.openFile(path);
          }
        }}
      />
    </main>
  );
}
