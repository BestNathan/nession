import { useCallback, useEffect, useState } from 'react';
import type {
  SandboxCurrentContext,
  SandboxPolicyDraft,
  SandboxPreflightResult,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { draftSignature } from '../model';
import { sandboxApi } from '../SandboxPlugin';

export interface SandboxPreflightState {
  preflight: { signature: string; result: SandboxPreflightResult } | null;
  preflightBusy: boolean;
  /** A request-level failure (offline/transport), not a policy verdict. */
  preflightError: string | null;
  runPreflight: (draft: SandboxPolicyDraft) => void;
  clearPreflight: () => void;
}

/**
 * One preflight result bound to the draft signature and the context
 * generation it was run against (#3124).
 *
 * A context change discards the result: it describes a different Pane. A draft
 * edit does not discard it — the signature comparison in the composer makes it
 * unusable, so the UI can still show why the earlier draft failed while the
 * user edits.
 */
export function useSandboxPreflight(options: {
  sessionId: string | null;
  context: SandboxCurrentContext | null;
  workingDir: string;
}): SandboxPreflightState {
  const { sessionId, context, workingDir } = options;
  const [preflight, setPreflight] = useState<{
    signature: string;
    result: SandboxPreflightResult;
  } | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  useEffect(() => {
    setPreflight(null);
  }, [context?.generation]);

  const runPreflight = useCallback(
    (draft: SandboxPolicyDraft) => {
      if (!sessionId || !context) {
        return;
      }
      setPreflightBusy(true);
      setPreflightError(null);
      sandboxApi
        .preflight(sessionId, context.generation, draft, workingDir)
        .then((result) => setPreflight({ signature: draftSignature(draft), result }))
        .catch((failure: unknown) => {
          setPreflightError(
            failure instanceof Error
              ? failure.message
              : 'The Sandbox preflight could not be run',
          );
        })
        .finally(() => setPreflightBusy(false));
    },
    [sessionId, context, workingDir],
  );

  const clearPreflight = useCallback(() => {
    setPreflight(null);
    setPreflightError(null);
  }, []);

  return { preflight, preflightBusy, preflightError, runPreflight, clearPreflight };
}
