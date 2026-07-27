// Server-backed quick-command state for the terminal toolbar (issue #95).
//
// Fetches user commands from the server, subscribes to `server.commands.changed`
// for live updates, performs a one-time migration of legacy localStorage
// commands, and exposes add/delete helpers.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useWebSocket } from '../hooks/useWebSocket';
import type { WebSocketService } from '../services/websocket';
import {
  loadLegacyCommands,
  clearLegacyCommands,
  type QuickCommand,
} from './quickCommands';

export interface UseQuickCommandsResult {
  userCommands: QuickCommand[];
  addCommand: (label: string, command: string) => Promise<void>;
  deleteCommand: (id: string) => Promise<void>;
}

export function useQuickCommands(): UseQuickCommandsResult {
  const wsService = useWebSocket();
  const [userCommands, setUserCommands] = useState<QuickCommand[]>([]);
  // Tracks the wsService instance we've already done the initial fetch for.
  // Guards against React StrictMode's double-mount in dev (mount → cleanup →
  // mount) firing two identical initial `client.commands.list` requests. A
  // genuine wsService change (reconnect) resets it and re-fetches.
  const initialFetchFor = useRef<WebSocketService | null>(null);

  const refreshCommands = useCallback(async () => {
    try {
      const resp = await wsService.listCommands();
      setUserCommands(
        resp.commands.map((c) => ({
          id: c.id,
          label: c.label,
          command: c.command,
          raw: c.raw,
        })),
      );
    } catch {
      // Not connected/authenticated yet — leave the list empty.
    }
  }, [wsService]);

  // Load commands on mount and whenever the server broadcasts a change.
  // The subscription is always (re)established so a reconnected wsService is
  // wired up correctly; only the initial fetch is de-duplicated.
  useEffect(() => {
    if (initialFetchFor.current !== wsService) {
      initialFetchFor.current = wsService;
      void refreshCommands();
    }
    const unsubscribe = wsService.onCommandsChanged(() => {
      void refreshCommands();
    });
    return unsubscribe;
  }, [wsService, refreshCommands]);

  // One-time migration of any legacy localStorage commands into the server.
  // The ref guard makes this run at most once per hook instance — without it,
  // StrictMode's dev double-mount would import every legacy command twice
  // (both mounts read localStorage before clearLegacyCommands() runs).
  const migrationStarted = useRef(false);
  useEffect(() => {
    if (migrationStarted.current) {
      return;
    }
    const legacy = loadLegacyCommands();
    if (legacy.length === 0) {
      return;
    }
    migrationStarted.current = true;
    (async () => {
      try {
        for (const cmd of legacy) {
          await wsService.addCommand(cmd.label, cmd.command, cmd.raw ?? false);
        }
        clearLegacyCommands();
        toast.success(`Imported ${legacy.length} saved command(s) to the server`);
        await refreshCommands();
      } catch {
        // Leave localStorage intact so we can retry on the next connection.
        migrationStarted.current = false;
      }
    })();
  }, [wsService, refreshCommands]);

  const addCommand = useCallback(
    async (label: string, command: string) => {
      try {
        await wsService.addCommand(label, command, false);
        await refreshCommands();
      } catch {
        toast.error('Failed to add command');
      }
    },
    [wsService, refreshCommands],
  );

  const deleteCommand = useCallback(
    async (id: string) => {
      try {
        await wsService.removeCommand(id);
        // Optimistic local update; the server broadcast will also refresh.
        setUserCommands((prev) => prev.filter((c) => c.id !== id));
      } catch {
        toast.error('Failed to delete command');
      }
    },
    [wsService],
  );

  return { userCommands, addCommand, deleteCommand };
}
