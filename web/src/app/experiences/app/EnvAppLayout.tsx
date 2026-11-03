import { useEffect, useRef } from 'react';
import {
  BindingDraftView,
  editorTargetKey,
  EnvironmentGuardDialog,
  EnvironmentNavigator,
  EnvImportDialog,
  EnvProfileDetail,
  EnvProfileEditor,
  refKey,
  SessionEnvironmentSummary,
  SessionEnvironmentView,
  bindingStatus,
  useEnvironmentWorkspace,
  type EditorTarget,
} from '@/capabilities/env';
import type { WorkspaceAppViewProps } from '@/app/workspace/workspaceContext';

type EnvWorkspace = ReturnType<typeof useEnvironmentWorkspace>;
type AppContext = WorkspaceAppViewProps['ctx'];

/** The pushed depth's own name, for the shell's navigation bar. */
function pushedTitle(
  editor: EditorTarget | null,
  view: EnvWorkspace['screen']['view'],
  selectedName: string | null,
): string | null {
  if (editor?.kind === 'new') {
    return 'New environment';
  }
  if (editor?.kind === 'duplicate') {
    return 'Duplicate';
  }
  if (editor) {
    return selectedName;
  }
  if (view === 'draft') {
    return 'Manage binding';
  }
  if (view === 'session') {
    return 'Session environment';
  }
  if (view === 'profile') {
    return selectedName;
  }
  return null;
}

function EditorDepth({ env, ctx }: { env: EnvWorkspace; ctx: AppContext }) {
  const { screen, selectedProfile } = env;
  if (!screen.editor) {
    return null;
  }
  return (
    <EnvProfileEditor
      key={editorTargetKey(screen.editor, screen.selectedKey)}
      target={screen.editor}
      profile={selectedProfile}
      agents={ctx.agents}
      onDirtyChange={screen.setDirty}
      onCancel={screen.cancelEdit}
      onSave={env.save}
    />
  );
}

function DraftDepth({ env, ctx }: { env: EnvWorkspace; ctx: AppContext }) {
  const { screen, binding, profiles } = env;
  if (!screen.draft) {
    return null;
  }
  return (
    <BindingDraftView
      baseline={screen.draftBaseline ?? []}
      draft={screen.draft}
      profiles={profiles.profiles}
      agents={ctx.agents}
      dirty={screen.dirty}
      pending={binding.pending}
      error={binding.error}
      onChange={screen.setDraftRefs}
      onCancel={screen.cancelBindingDraft}
      onApply={env.applyBinding}
    />
  );
}

function ProfileDepth({ env, ctx }: { env: EnvWorkspace; ctx: AppContext }) {
  const { screen, selectedProfile, binding } = env;
  if (!selectedProfile) {
    return null;
  }
  const status = bindingStatus(binding.binding, binding.error);
  return (
    <EnvProfileDetail
      profile={selectedProfile}
      agents={ctx.agents}
      includedInBinding={env.includedKeys.has(refKey(selectedProfile))}
      sessionLabel={env.sessionId ? status.title : null}
      onShowSession={env.showSession}
      onEdit={screen.startEdit}
      onDuplicate={() => screen.startDuplicate(selectedProfile)}
      onDelete={() => env.deleteProfile(selectedProfile)}
    />
  );
}

function SessionDepth({ env, ctx }: { env: EnvWorkspace; ctx: AppContext }) {
  const { sessionId, binding, profiles } = env;
  if (!sessionId) {
    return null;
  }
  return (
    <SessionEnvironmentView
      sessionId={sessionId}
      sessionName={ctx.session?.session_name ?? null}
      binding={binding}
      profiles={profiles.profiles}
      agents={ctx.agents}
      pending={binding.pending}
      onManage={env.startBindingDraft}
      onReapply={env.reapplyBinding}
      onRetry={() => void binding.refresh()}
    />
  );
}

function RootDepth({
  env,
  ctx,
  listScrollTop,
}: {
  env: EnvWorkspace;
  ctx: AppContext;
  listScrollTop: { current: number };
}) {
  const { sessionId, binding, profiles, screen } = env;
  return (
    <>
      {sessionId ? (
        <SessionEnvironmentSummary
          sessionId={sessionId}
          sessionName={ctx.session?.session_name ?? null}
          binding={binding}
          onOpen={env.showSession}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-hidden">
        <EnvironmentNavigator
          profiles={profiles.profiles}
          agents={ctx.agents}
          includedKeys={env.includedKeys}
          loading={profiles.loading}
          error={profiles.error}
          selectedKey={screen.selectedKey}
          onSelect={screen.selectProfile}
          onNew={screen.startNew}
          onImport={env.openImport}
          onRetry={() => void profiles.refresh()}
          restoredScrollTop={listScrollTop.current}
          onScrollSnapshot={(top) => {
            listScrollTop.current = top;
          }}
        />
      </div>
    </>
  );
}

function Depth({ env, ctx, listScrollTop }: {
  env: EnvWorkspace;
  ctx: AppContext;
  listScrollTop: { current: number };
}) {
  if (env.screen.editor) {
    return <EditorDepth env={env} ctx={ctx} />;
  }
  if (env.screen.view === 'draft' && env.screen.draft) {
    return <DraftDepth env={env} ctx={ctx} />;
  }
  if (env.selectedProfile) {
    return <ProfileDepth env={env} ctx={ctx} />;
  }
  if (env.screen.view === 'session' && env.sessionId) {
    return <SessionDepth env={env} ctx={ctx} />;
  }
  return <RootDepth env={env} ctx={ctx} listScrollTop={listScrollTop} />;
}

/**
 * App layout (#1202, Session-first in #2654): the root is a compact current
 * Session item followed by the searchable Profile list. The Session
 * Environment, Profile Detail, Edit and binding draft are pushed one at a
 * time through the shell's depth control (#1051); the capability owns the
 * dirty guard and the shell owns the single Back. No status strip is repeated
 * above every depth.
 */
export function EnvAppLayout({ ctx, depth }: WorkspaceAppViewProps) {
  const env = useEnvironmentWorkspace(ctx.session?.session_id ?? null);
  const { screen, selectedProfile } = env;
  const listScrollTop = useRef(0);

  const title = pushedTitle(screen.editor, screen.view, selectedProfile?.name ?? null);
  const setPush = depth.setPush;
  const leaveDepth = screen.leaveDepth;
  useEffect(() => {
    setPush(title === null ? null : { title, onLeave: leaveDepth });
  }, [setPush, title, leaveDepth]);

  return (
    <div data-testid="env-workspace-app" className="flex h-full min-h-0 flex-col">
      <Depth env={env} ctx={ctx} listScrollTop={listScrollTop} />
      <EnvironmentGuardDialog
        open={screen.guardOpen}
        onConfirm={screen.confirmGuard}
        onCancel={screen.cancelGuard}
      />
      <EnvImportDialog
        isOpen={env.importOpen}
        onClose={env.closeImport}
        agents={ctx.agents}
        onImported={env.onImported}
      />
    </div>
  );
}
