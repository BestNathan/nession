import { useState } from 'react';
import type { EnvFileRef, EnvWriteResponse } from '@/types';

export interface EnvProfileSaveInput {
  ref: EnvFileRef;
  content: string;
  overwrite: boolean;
  force: boolean;
}

export interface EnvProfileSaveFlow {
  saving: boolean;
  error: string | null;
  impactOpen: boolean;
  setImpactOpen: (open: boolean) => void;
  overwriteOpen: boolean;
  setOverwriteOpen: (open: boolean) => void;
  /** Entry point: an in-use existing profile explains its impact first. */
  save: () => void;
  /** "Save and update" — overwrite + force after the impact was explained. */
  confirmImpact: () => void;
  /** "Replace" — overwrite after the existing profile was named. */
  confirmOverwrite: () => void;
}

/**
 * The write chain behind the Edit depth's Save (#1202 §4): one attempt at a
 * time, an `exists` answer opens the Replace dialog, an `in_use_by` answer
 * opens the impact dialog — and nothing is ever called "Force Save".
 */
export function useEnvProfileSave({
  isNew,
  inUseBy,
  buildInput,
  onSave,
}: {
  isNew: boolean;
  inUseBy: string[];
  buildInput: (overwrite: boolean, force: boolean) => EnvProfileSaveInput;
  onSave: (input: EnvProfileSaveInput) => Promise<EnvWriteResponse>;
}): EnvProfileSaveFlow {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [impactOpen, setImpactOpen] = useState(false);
  const [overwriteOpen, setOverwriteOpen] = useState(false);

  const attempt = async (overwrite: boolean, force: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const resp = await onSave(buildInput(overwrite, force));
      if (resp.success) {
        return;
      }
      if (resp.exists) {
        setOverwriteOpen(true);
      } else if ((resp.in_use_by?.length ?? 0) > 0) {
        setImpactOpen(true);
      } else {
        setError(resp.error ?? 'Failed to save');
      }
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (!isNew && inUseBy.length > 0) {
      setImpactOpen(true);
      return;
    }
    void attempt(!isNew, false);
  };

  return {
    saving,
    error,
    impactOpen,
    setImpactOpen,
    overwriteOpen,
    setOverwriteOpen,
    save,
    confirmImpact: () => void attempt(true, true),
    confirmOverwrite: () => void attempt(true, false),
  };
}
