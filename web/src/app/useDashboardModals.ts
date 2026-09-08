import { useState } from 'react';
import type { Agent, Session } from '../types';

/** Modal state for the dashboard. */
export function useDashboardModals() {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [sessionToKill, setSessionToKill] = useState<Session | null>(null);
  const [previewSession, setPreviewSession] = useState<Session | null>(null);

  return {
    selectedAgent, setSelectedAgent,
    showCreateModal, setShowCreateModal,
    sessionToKill, setSessionToKill,
    previewSession, setPreviewSession,
  };
}
