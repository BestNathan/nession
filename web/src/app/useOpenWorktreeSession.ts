import { useCallback } from 'react';
import { toast } from 'sonner';
import {
  canOpenWorktreeAsSession,
  normalizeWorktreePath,
  type GitWorktree,
} from '@/capabilities/git';
import { sessionsApi } from '@/product/session';
import type { Session } from '@/types';

function sessionsInWorktree(sessions: Session[], agentId: string, worktreePath: string): Session[] {
  const want = normalizeWorktreePath(worktreePath);
  return sessions.filter(
    (s) =>
      s.agent_id === agentId &&
      s.working_dir !== undefined &&
      s.working_dir !== null &&
      normalizeWorktreePath(s.working_dir) === want,
  );
}

function sessionNameForWorktree(worktreePath: string): string {
  const base = worktreePath.split('/').filter(Boolean).pop() ?? 'worktree';
  const safe = base.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
  return `wt-${safe}`;
}

export function useOpenWorktreeSession(opts: {
  agentId: string | undefined;
  selectSessionInWorkspace: (session: Session) => void;
}) {
  const { agentId, selectSessionInWorkspace } = opts;

  return useCallback(
    async (worktree: GitWorktree) => {
      if (!agentId) {
        toast.error('No agent selected for this Session.');
        return;
      }
      const gate = canOpenWorktreeAsSession(worktree);
      if (!gate.ok) {
        toast.error(gate.reason);
        return;
      }

      const listSessions = async () => {
        const resp = await sessionsApi.fetchSessions({ agentId, force: true });
        return resp.sessions;
      };

      const sessions = await listSessions();
      const matches = sessionsInWorktree(sessions, agentId, worktree.path);
      if (matches.length > 1) {
        toast.message('Several Sessions match this worktree — pick one in the list.', {
          description: matches.map((s) => s.session_name).join(', '),
        });
        return;
      }
      if (matches.length === 1) {
        selectSessionInWorkspace(matches[0]);
        toast.success('Opened existing Session for this worktree.');
        return;
      }

      const name = sessionNameForWorktree(worktree.path);
      const created = await sessionsApi.createSession(agentId, name, [], worktree.path);
      if (!created.success || !created.session_id) {
        toast.error(created.error ?? 'Could not create a Session for this worktree.');
        return;
      }
      selectSessionInWorkspace({
        session_id: created.session_id,
        agent_id: agentId,
        session_name: name,
        status: 'detached',
        window_count: 1,
        attached_clients: 0,
        working_dir: worktree.path,
        last_activity: new Date().toISOString(),
      });
      toast.success('Created Session for this worktree.');
    },
    [agentId, selectSessionInWorkspace],
  );
}
