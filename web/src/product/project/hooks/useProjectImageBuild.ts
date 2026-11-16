import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  imagesApi,
  isTerminalBuild,
  type ImageBuildDescriptor,
  type ImageDescriptor,
} from '@/capabilities/images';

/** The Git source a Project build is allowed to name. */
export interface ProjectImageBuildSource {
  repository_url: string;
  ref: string;
}

export interface ProjectImageBuildState {
  build: ImageBuildDescriptor | null;
  builtImage: ImageDescriptor | null;
  submitting: boolean;
  submitError: string | null;
  active: boolean;
  start: () => Promise<void>;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
  clear: () => void;
}

/**
 * The identity fence for one Git build source (#3677).
 *
 * The Server validates and canonicalizes the source; this only folds the
 * spellings it accepts (surrounding whitespace, a trailing slash and `.git`)
 * so a recovered build descriptor matches the draft it was built from.
 * Validation stays with the protocol contract.
 */
export function projectImageBuildSourceKey(
  source: ProjectImageBuildSource | null,
): string | null {
  if (!source) {
    return null;
  }
  const repositoryUrl = source.repository_url.trim();
  const reference = source.ref.trim();
  if (!repositoryUrl || !reference) {
    return null;
  }
  let canonicalUrl = repositoryUrl;
  if (canonicalUrl.startsWith('https://github.com/')) {
    if (canonicalUrl.endsWith('/')) {
      canonicalUrl = canonicalUrl.slice(0, -1);
    }
    if (canonicalUrl.endsWith('.git')) {
      canonicalUrl = canonicalUrl.slice(0, -'.git'.length);
    }
  }
  return `${canonicalUrl}\u0000${reference}`;
}

/**
 * Build-visible state tagged with the source identity it belongs to.
 *
 * A value from another identity is never rendered, so a stale completion
 * cannot appear under a source the user has since selected.
 */
interface ScopedBuildState {
  key: string | null;
  build: ImageBuildDescriptor | null;
  builtImage: ImageDescriptor | null;
  submitting: boolean;
  submitError: string | null;
}

function emptyScopedState(key: string | null): ScopedBuildState {
  return {
    key,
    build: null,
    builtImage: null,
    submitting: false,
    submitError: null,
  };
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

type ScopedUpdate = (current: ScopedBuildState) => ScopedBuildState;
type ApplyScoped = (key: string | null, update: ScopedUpdate) => void;

/**
 * Recover the newest durable build for one Git source after a remount.
 *
 * The Server build directory is authoritative: navigating away and back, or
 * reconnecting, reads the same record rather than remembering a transient
 * client phase. An active build is followed; a succeeded one stays available so
 * the explicit "Use this image" step is not lost.
 */
function useBuildRecovery(key: string | null, applyScoped: ApplyScoped): void {
  useEffect(() => {
    if (!key) {
      return;
    }
    let cancelled = false;
    let lastState = imagesApi.connectionState();
    const recover = () => {
      void imagesApi
        .listBuilds({ limit: 50 })
        .then((page) => {
          if (cancelled) {
            return;
          }
          const matching = page.builds.filter(
            (candidate) =>
              candidate.source.kind === 'github'
              && projectImageBuildSourceKey({
                repository_url: candidate.source.repository_url,
                ref: candidate.source.ref,
              }) === key,
          );
          const recovered =
            matching.find((candidate) => !isTerminalBuild(candidate))
            ?? matching.find((candidate) => candidate.status === 'succeeded')
            ?? null;
          if (recovered) {
            applyScoped(key, (current) => ({
              ...current,
              build: recovered,
              builtImage: null,
            }));
          }
        })
        .catch(() => undefined);
    };
    recover();
    const unsubscribe = imagesApi.onConnectionStateChange((state) => {
      if (lastState !== 'connected' && state === 'connected') {
        recover();
      }
      lastState = state;
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [key, applyScoped]);
}

/** Follow the durable record while it is the visible active build. */
function useBuildFollow(applyVisible: (update: ScopedUpdate) => void): void {
  useEffect(() => {
    // Register before any submission can begin. Subscribing only after the
    // submitted build renders as active loses terminal notifications arriving
    // between commit and the next passive effect.
    return imagesApi.onBuildChanged((next) => {
      applyVisible((current) =>
        current.build
        && !isTerminalBuild(current.build)
        && current.build.build_id === next.build_id
          ? { ...current, build: next }
          : current,
      );
    });
  }, [applyVisible]);
}

/** Resolve a succeeded build's immutable registry descriptor. */
function useBuiltImage(
  build: ImageBuildDescriptor | null,
  key: string | null,
  applyScoped: ApplyScoped,
): void {
  const digest = build?.status === 'succeeded' ? build.digest ?? null : null;
  useEffect(() => {
    if (!digest || !key) {
      return;
    }
    let cancelled = false;
    void imagesApi
      .getImage({ digest })
      .then((image) => {
        if (!cancelled) {
          applyScoped(key, (current) => ({ ...current, builtImage: image }));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [digest, key, applyScoped]);
}

/**
 * The asynchronous Git build attached to a Project image reference (#3334).
 *
 * Submission returns immediately with the durable record; the Project draft
 * changes only through the explicit action in the field component. Every
 * visible value and every asynchronous completion belongs to one normalized
 * Git source identity (#3677): changing the URL or ref hides the previous
 * source's build and image immediately, and late submit/recovery/descriptor/
 * cancel/retry/notification results for the old identity are ignored. The
 * Server-owned durable build itself is never canceled by a source switch.
 */
export function useProjectImageBuild(
  source: ProjectImageBuildSource | null,
): ProjectImageBuildState {
  const repositoryUrl = source?.repository_url.trim() ?? null;
  const reference = source?.ref.trim() ?? null;
  const sourceKey = projectImageBuildSourceKey(source);
  const [state, setState] = useState<ScopedBuildState>(() => emptyScopedState(sourceKey));
  const keyRef = useRef(sourceKey);

  // A source change must fence async completions before any promise callback
  // can observe the new props, so the identity is committed synchronously.
  useLayoutEffect(() => {
    keyRef.current = sourceKey;
  }, [sourceKey]);

  const applyScoped = useCallback<ApplyScoped>((key, update) => {
    setState((current) => {
      if (keyRef.current !== key) {
        return current;
      }
      return update(current.key === key ? current : emptyScopedState(key));
    });
  }, []);

  const applyVisible = useCallback((update: ScopedUpdate) => {
    setState((current) =>
      current.key === null || current.key !== keyRef.current ? current : update(current),
    );
  }, []);

  useBuildRecovery(sourceKey, applyScoped);
  useBuildFollow(applyVisible);

  // Derive rather than reset in an effect: the previous source's result must
  // not survive even one render after the draft source changes.
  const visible = state.key === sourceKey ? state : emptyScopedState(sourceKey);
  const currentBuild = visible.build;
  const active = currentBuild !== null && !isTerminalBuild(currentBuild);

  useBuiltImage(currentBuild, sourceKey, applyScoped);

  const start = useCallback(async () => {
    if (!sourceKey || !repositoryUrl || !reference) {
      return;
    }
    applyScoped(sourceKey, (current) => ({
      ...current,
      submitting: true,
      submitError: null,
      builtImage: null,
    }));
    try {
      const submitted = await imagesApi.submitBuild({
        kind: 'github',
        repository_url: repositoryUrl,
        ref: reference,
      });
      applyScoped(sourceKey, (current) => ({
        ...current,
        build: submitted,
        submitting: false,
      }));
    } catch (cause: unknown) {
      applyScoped(sourceKey, (current) => ({
        ...current,
        build: null,
        submitting: false,
        submitError: errorMessage(cause, 'The image build could not be submitted'),
      }));
    }
  }, [sourceKey, repositoryUrl, reference, applyScoped]);

  const cancel = useCallback(async () => {
    if (!sourceKey || !currentBuild) {
      return;
    }
    try {
      const updated = await imagesApi.cancelBuild(currentBuild.build_id);
      applyScoped(sourceKey, (current) =>
        current.build?.build_id === currentBuild.build_id
          ? { ...current, build: updated }
          : current,
      );
    } catch (cause: unknown) {
      applyScoped(sourceKey, (current) => ({
        ...current,
        submitError: errorMessage(cause, 'The build could not be canceled'),
      }));
    }
  }, [sourceKey, currentBuild, applyScoped]);

  const retry = useCallback(async () => {
    if (!sourceKey || !currentBuild) {
      return;
    }
    applyScoped(sourceKey, (current) => ({ ...current, builtImage: null }));
    try {
      const updated = await imagesApi.retryBuild(currentBuild.build_id);
      applyScoped(sourceKey, (current) =>
        current.build?.build_id === currentBuild.build_id
          ? { ...current, build: updated, builtImage: null }
          : current,
      );
    } catch (cause: unknown) {
      applyScoped(sourceKey, (current) => ({
        ...current,
        submitError: errorMessage(cause, 'The build could not be retried'),
      }));
    }
  }, [sourceKey, currentBuild, applyScoped]);

  const clear = useCallback(() => {
    applyScoped(sourceKey, () => emptyScopedState(sourceKey));
  }, [sourceKey, applyScoped]);

  return {
    build: currentBuild,
    builtImage: visible.builtImage,
    submitting: visible.submitting,
    submitError: visible.submitError,
    active,
    start,
    cancel,
    retry,
    clear,
  };
}
