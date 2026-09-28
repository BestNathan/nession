import { useEffect, useRef, useState } from 'react';
import type { Agent, EnvFileInfo, EnvFileRef, EnvSource } from '@/types';
import { toRef } from '@/capabilities/env/model/envRef';
import type { EditorTarget } from '@/capabilities/env/hooks/useEnvironmentScreen';

export interface EnvEditorDraft {
  name: string;
  setName: (v: string) => void;
  source: EnvSource;
  setSource: (v: EnvSource) => void;
  agentId: string;
  setAgentId: (v: string) => void;
  content: string;
  setContent: (v: string) => void;
  originalContent: string;
  isNew: boolean;
  dirty: boolean;
  nameValid: boolean;
  locationValid: boolean;
  /** The identity fields render only for new/duplicate targets. */
  initialized: boolean;
  buildRef: () => EnvFileRef;
}

function proposedNameFor(target: EditorTarget): string {
  return target.kind === 'duplicate'
    ? `${target.source.name.replace(/\.env$/, '')}-copy.env`
    : '';
}

function initialSourceFor(target: EditorTarget): EnvSource {
  return target.kind === 'duplicate' ? target.source.source : 'server';
}

function initialAgentFor(target: EditorTarget, agents: Agent[]): string {
  const firstOnline = agents.find((a) => a.status === 'online');
  if (target.kind === 'duplicate') {
    return target.source.agent_id ?? firstOnline?.agent_id ?? '';
  }
  return firstOnline?.agent_id ?? '';
}

/**
 * The Edit depth's draft state (#1202): identity fields for a new/duplicate
 * profile, raw source for any target, and the dirty derivation the layout's
 * leave-guard relies on. The loaded source is adopted exactly once, so a
 * background reload never clobbers edits in flight.
 */
export function useEnvEditorDraft(
  target: EditorTarget,
  profile: EnvFileInfo | null,
  agents: Agent[],
  loaded: string | null,
): EnvEditorDraft {
  const proposedName = proposedNameFor(target);
  const initialSource = initialSourceFor(target);
  const [initialAgent] = useState(() => initialAgentFor(target, agents));
  const [name, setName] = useState(proposedName);
  const [source, setSource] = useState<EnvSource>(initialSource);
  const [agentId, setAgentId] = useState(initialAgent);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current || loaded === null) {
      return;
    }
    initialized.current = true;
    setContent(loaded);
    setOriginalContent(loaded);
  }, [loaded]);

  const isNew = target.kind !== 'existing';
  const dirty = isNew
    ? name.trim() !== proposedName ||
      content !== originalContent ||
      source !== initialSource ||
      agentId !== initialAgent
    : content !== originalContent;

  const buildRef = (): EnvFileRef => {
    if (target.kind === 'existing' && profile) {
      return toRef(profile);
    }
    const trimmed = name.trim();
    return {
      name: trimmed.endsWith('.env') ? trimmed : `${trimmed}.env`,
      source,
      agent_id: source === 'agent' ? agentId : undefined,
    };
  };

  return {
    name,
    setName,
    source,
    setSource,
    agentId,
    setAgentId,
    content,
    setContent,
    originalContent,
    isNew,
    dirty,
    nameValid: name.trim().length > 0,
    locationValid: source !== 'agent' || agentId !== '',
    initialized: initialized.current || target.kind === 'new',
    buildRef,
  };
}
