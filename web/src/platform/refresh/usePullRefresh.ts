import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { PullController, type RefreshTelemetryEvent } from './PullController';
import { useRefreshRuntime } from './useRefreshRuntime';
import {
  INITIAL_PULL_STATUS,
  type PullContext,
  type PullOutcome,
  type PullRefreshPolicy,
  type PullStatus,
  type RefreshReason,
} from './types';

export interface UsePullRefreshOptions<T> {
  /** Owner-local identity: target/session incarnation, page/filter, auth scope.
   *  A change retires the previous context before any new read is published. */
  context: readonly unknown[];
  /** The surface is actually visible (route/depth), not merely mounted. */
  active?: boolean;
  /** Owner opt-in folded with authenticated transport readiness. */
  enabled?: boolean;
  pull: (ctx: PullContext) => Promise<T>;
  /** Synchronous guarded publication into the owner's existing state. */
  apply: (snapshot: T) => void;
  policy: PullRefreshPolicy;
  isPartial?: (snapshot: T) => boolean;
  /** Low-cardinality surface name for lifecycle telemetry. */
  label?: string;
  onTelemetry?: (event: RefreshTelemetryEvent) => void;
}

export interface UsePullRefreshResult<T> {
  /** Explicit current-scope read. Defaults to a user-initiated `manual`. */
  refresh: (reason?: RefreshReason) => Promise<PullOutcome>;
  invalidate: (reason?: RefreshReason) => void;
  /** Hand a complete push snapshot to the same fence the pulls use. */
  acceptExternal: (snapshot: T) => void;
  status: PullStatus;
}

/**
 * React adapter over {@link PullController} (#4602 §1).
 *
 * The controller — not this hook — owns ordering, fences and budgets. The hook
 * only translates React lifetimes into controller calls: mount/identity into a
 * context, visibility into `active`, transport readiness into `enabled`, and
 * app lifecycle signals into reasons. `pull`/`apply` are read through refs so a
 * new closure identity each render never rebuilds the state machine.
 */
export function usePullRefresh<T>(options: UsePullRefreshOptions<T>): UsePullRefreshResult<T> {
  const { scheduler, signals, clock } = useRefreshRuntime();
  const {
    context,
    active = true,
    enabled = true,
    policy,
    label,
    onTelemetry,
  } = options;

  const [status, setStatus] = useState<PullStatus>(INITIAL_PULL_STATUS);
  const controllerRef = useRef<PullController<T> | null>(null);

  const pullRef = useRef(options.pull);
  pullRef.current = options.pull;
  const applyRef = useRef(options.apply);
  applyRef.current = options.apply;
  const isPartialRef = useRef(options.isPartial);
  isPartialRef.current = options.isPartial;
  const policyRef = useRef(policy);
  policyRef.current = policy;
  const telemetryRef = useRef(onTelemetry);
  telemetryRef.current = onTelemetry;

  const contextRef = useRef(context);
  contextRef.current = context;
  const contextKey = JSON.stringify(context.map((part) => (
    part !== null && typeof part === 'object' ? JSON.stringify(part) : String(part)
  )));
  const policyKey = JSON.stringify(policy);

  useLayoutEffect(() => {
    const controller = new PullController<T>({
      scheduler,
      clock,
      pull: (ctx) => pullRef.current(ctx),
      apply: (snapshot) => applyRef.current(snapshot),
      isPartial: (snapshot) => isPartialRef.current?.(snapshot) ?? false,
      policy: policyRef.current,
      onStatus: setStatus,
      onTelemetry: (event) => telemetryRef.current?.(event),
      ...(label === undefined ? {} : { label }),
    });
    controllerRef.current = controller;
    return () => {
      controllerRef.current = null;
      controller.retire();
    };
  }, [scheduler, clock, label]);

  // Identity first, then readiness, then visibility: the controller turns the
  // first fully-satisfied combination into one `mount` read.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) { return; }
    controller.setContext(contextRef.current);
    controller.setEnabled(enabled);
    controller.setActive(active);
    // Identity is represented by its serialized key: a fresh array literal with
    // the same contents must not retire a live context.
  }, [contextKey, active, enabled]);

  // Re-arming on every render would push the due time forward forever, so the
  // policy is only handed over when its values actually change.
  useEffect(() => {
    controllerRef.current?.setPolicy(policyRef.current);
  }, [policyKey]);

  useEffect(() => {
    return signals.subscribe((event) => {
      const current = controllerRef.current;
      if (!current) { return; }
      const currentPolicy = policyRef.current;
      if (event.signal === 'reconnect' && currentPolicy.onReconnect) {
        void current.refresh('reconnect');
      } else if (event.signal === 'foreground' && currentPolicy.onForeground) {
        void current.refresh('foreground');
      }
    });
  }, [signals]);

  const refresh = useCallback((reason: RefreshReason = 'manual') => {
    const controller = controllerRef.current;
    if (!controller) { return Promise.resolve<PullOutcome>('cancelled'); }
    return controller.refresh(reason);
  }, []);

  const invalidate = useCallback((reason: RefreshReason = 'invalidate') => {
    controllerRef.current?.invalidate(reason);
  }, []);

  const acceptExternal = useCallback((snapshot: T) => {
    controllerRef.current?.acceptExternal(snapshot);
  }, []);

  return { refresh, invalidate, acceptExternal, status };
}