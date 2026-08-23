import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import type { Agent } from '../types';

/**
 * Manages dialog state and refresh triggers for the Dashboard.
 */
export function useDashboardDialogs() {
  const [serverRefreshKey, setServerRefreshKey] = useState(0);
  const [agentToDelete, setAgentToDelete] = useState<Agent | null>(null);

  const handleTerminalDisconnect = useCallback(() => {
    toast.error('Terminal connection lost');
  }, []);

  const handleTerminalError = useCallback((err: Error) => {
    toast.error(`Terminal error: ${err.message}`);
  }, []);

  const incrementServerRefreshKey = useCallback(() => {
    setServerRefreshKey((n) => n + 1);
  }, []);

  return {
    serverRefreshKey,
    agentToDelete,
    setAgentToDelete,
    handleTerminalDisconnect,
    handleTerminalError,
    incrementServerRefreshKey,
  };
}
