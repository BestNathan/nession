/**
 * Frontend pull/refresh lifecycle (#4602).
 *
 * Owns *when* a read happens and *whether its answer may still be published*.
 * Business data, query scope, filters, pagination and mutations stay with the
 * Product/Capability that already owns them — there is no resource registry,
 * unified business cache or backend protocol here.
 */
export { PullController } from './PullController';
export type { PullControllerOptions, RefreshTelemetryEvent } from './PullController';
export { RefreshScheduler } from './RefreshScheduler';
export type {
  RefreshPriority,
  RefreshRegistration,
  RefreshSchedulerOptions,
} from './RefreshScheduler';
export { RefreshSignalBus } from './RefreshSignalBus';
export type { RefreshSignal, RefreshSignalEvent } from './RefreshSignalBus';
export { RefreshProvider } from './RefreshProvider';
export type { RefreshProviderProps } from './RefreshProvider';
export type { RefreshRuntime } from './RefreshRuntimeContext';
export { useRefreshRuntime } from './useRefreshRuntime';
export { usePullRefresh } from './usePullRefresh';
export type { UsePullRefreshOptions, UsePullRefreshResult } from './usePullRefresh';
export { RefreshTelemetry } from './RefreshTelemetry';
export type { RefreshAggregate } from './RefreshTelemetry';
export {
  DEFAULT_COALESCE_MS,
  DEFAULT_MAX_IN_FLIGHT,
  DEFAULT_MAX_PER_TARGET,
  DEFAULT_TIMEOUT_MS,
  INITIAL_PULL_STATUS,
  backoffDelay,
  isStrongReason,
  jittered,
  systemClock,
} from './types';
export type {
  PullContext,
  PullOutcome,
  PullRefreshPolicy,
  PullStatus,
  RefreshClock,
  RefreshReason,
} from './types';