import { useCallback, useState } from 'react';
import type {
  SandboxActionResult,
  SandboxCurrentContext,
  SandboxImageSelection,
  SandboxPolicyDraft,
  SandboxPreflightResult,
} from '@/generated/protocol/core/server-session-sandbox-context/v1';
import { fieldErrorsByField, type SandboxActionError } from '../model';
import { sandboxApi } from '../SandboxPlugin';

function newEnterId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return `enter-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function actionErrorOf(result: SandboxActionResult): SandboxActionError {
  return {
    kind: result.error_kind ?? null,
    message: result.error ?? 'The Sandbox action was refused',
    fieldErrors: fieldErrorsByField(result.field_errors ?? undefined),
  };
}

export interface SandboxTransitionsState {
  busy: boolean;
  actionError: SandboxActionError | null;
  confirming: boolean;
  requestEnter: () => void;
  cancelConfirm: () => void;
  confirmEnter: (
    draft: SandboxPolicyDraft,
    preflight: { signature: string; result: SandboxPreflightResult },
  ) => void;
  returnToNative: () => void;
  focusPane: (paneId: string) => void;
  reset: () => void;
}

/**
 * The explicit Enter and the two focus switches (#3124).
 *
 * Enter is only reachable through a preflight the caller has already checked
 * against the draft on screen; the request reuses that preflight's generation
 * and a fresh idempotency id. A failed Enter keeps the confirmation and the
 * draft, and adopts the Agent's context if it changed.
 */
export function useSandboxTransitions(options: {
  sessionId: string | null;
  images: readonly SandboxImageSelection[];
  workingDir: string;
  applyContext: (context: SandboxCurrentContext | null) => void;
}): SandboxTransitionsState {
  const { sessionId, images, workingDir, applyContext } = options;
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<SandboxActionError | null>(null);
  const [confirming, setConfirming] = useState(false);

  const runAction = useCallback(
    (action: () => Promise<SandboxActionResult>) => {
      setBusy(true);
      setActionError(null);
      action()
        .then((result) => {
          if (result.context) {
            applyContext(result.context);
          }
          if (!result.success) {
            setActionError(actionErrorOf(result));
          }
        })
        .catch((failure: unknown) => {
          setActionError({
            kind: 'unavailable',
            message: failure instanceof Error ? failure.message : 'The Sandbox action failed',
          });
        })
        .finally(() => setBusy(false));
    },
    [applyContext],
  );

  const confirmEnter = useCallback(
    (
      draft: SandboxPolicyDraft,
      preflight: { signature: string; result: SandboxPreflightResult },
    ) => {
      if (!sessionId) {
        return;
      }
      setBusy(true);
      setActionError(null);
      sandboxApi
        .enter({
          sessionId,
          generation: preflight.result.generation,
          probeGeneration: preflight.result.catalog.probe_generation,
          enterId: newEnterId(),
          policy: draft,
          images,
          workingDir,
        })
        .then((result) => {
          if (result.context) {
            applyContext(result.context);
          }
          if (result.success) {
            setConfirming(false);
          } else {
            setActionError(actionErrorOf(result));
            // A refusal that reports the Pane already inside (for example a
            // second confirmation racing the first) must not leave the App's
            // Enter-Sandbox depth stacked over an inside projection.
            if (result.context?.status === 'inside') {
              setConfirming(false);
            }
          }
        })
        .catch((failure: unknown) => {
          setActionError({
            kind: 'unavailable',
            message:
              failure instanceof Error ? failure.message : 'The Sandbox Enter request failed',
          });
        })
        .finally(() => setBusy(false));
    },
    [sessionId, images, workingDir, applyContext],
  );

  const requestEnter = useCallback(() => {
    setActionError(null);
    setConfirming(true);
  }, []);

  const cancelConfirm = useCallback(() => {
    setConfirming(false);
    setActionError(null);
  }, []);

  const returnToNative = useCallback(() => {
    if (sessionId) {
      runAction(() => sandboxApi.returnToNative(sessionId));
    }
  }, [sessionId, runAction]);

  const focusPane = useCallback(
    (paneId: string) => {
      if (sessionId) {
        runAction(() => sandboxApi.focus(sessionId, paneId));
      }
    },
    [sessionId, runAction],
  );

  const reset = useCallback(() => {
    setActionError(null);
    setConfirming(false);
  }, []);

  return {
    busy,
    actionError,
    confirming,
    requestEnter,
    cancelConfirm,
    confirmEnter,
    returnToNative,
    focusPane,
    reset,
  };
}
