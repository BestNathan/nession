import { useCallback, useEffect, useState } from 'react';
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
 * Recover the newest durable build for one Git source after a remount.
 *
 * The Server build directory is authoritative: navigating away and back, or
 * reconnecting, reads the same record rather than remembering a transient
 * client phase. An active build is followed; a succeeded one stays available so
 * the explicit "Use this image" step is not lost.
 */
function useBuildRecovery(
  repositoryUrl: string | null,
  reference: string | null,
  setBuild: (build: ImageBuildDescriptor | null) => void,
  setBuiltImage: (image: ImageDescriptor | null) => void,
): void {
  useEffect(() => {
    if (!repositoryUrl || !reference) {
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
              && candidate.source.repository_url === repositoryUrl
              && candidate.source.ref === reference,
          );
          const recovered =
            matching.find((candidate) => !isTerminalBuild(candidate))
            ?? matching.find((candidate) => candidate.status === 'succeeded')
            ?? null;
          if (recovered) {
            setBuild(recovered);
            setBuiltImage(null);
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
  }, [repositoryUrl, reference, setBuild, setBuiltImage]);
}

/** Follow the durable record while it is active. */
function useBuildFollow(
  build: ImageBuildDescriptor | null,
  active: boolean,
  setBuild: (build: ImageBuildDescriptor) => void,
): void {
  const buildId = build?.build_id ?? null;
  useEffect(() => {
    if (!buildId || !active) {
      return;
    }
    return imagesApi.onBuildChanged((next) => {
      if (next.build_id === buildId) {
        setBuild(next);
      }
    });
  }, [buildId, active, setBuild]);
}

/** Resolve a succeeded build's immutable registry descriptor. */
function useBuiltImage(
  build: ImageBuildDescriptor | null,
  setBuiltImage: (image: ImageDescriptor | null) => void,
): void {
  const digest = build?.status === 'succeeded' ? build.digest ?? null : null;
  useEffect(() => {
    if (!digest) {
      return;
    }
    let cancelled = false;
    void imagesApi
      .getImage({ digest })
      .then((image) => {
        if (!cancelled) {
          setBuiltImage(image);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [digest, setBuiltImage]);
}

/**
 * The asynchronous Git build attached to a Project image reference (#3334).
 *
 * Submission returns immediately with the durable record; the Project draft
 * changes only through the explicit action in the field component.
 */
export function useProjectImageBuild(
  source: ProjectImageBuildSource | null,
): ProjectImageBuildState {
  const [build, setBuildState] = useState<ImageBuildDescriptor | null>(null);
  const [builtImage, setBuiltImageState] = useState<ImageDescriptor | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const repositoryUrl = source?.repository_url ?? null;
  const reference = source?.ref ?? null;
  const active = build !== null && !isTerminalBuild(build);

  useBuildRecovery(repositoryUrl, reference, setBuildState, setBuiltImageState);
  useBuildFollow(build, active, setBuildState);
  useBuiltImage(build, setBuiltImageState);

  const start = useCallback(async () => {
    if (!repositoryUrl || !reference) {
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    setBuiltImageState(null);
    try {
      const submitted = await imagesApi.submitBuild({
        kind: 'github',
        repository_url: repositoryUrl,
        ref: reference,
      });
      setBuildState(submitted);
    } catch (cause: unknown) {
      setBuildState(null);
      setSubmitError(
        cause instanceof Error ? cause.message : 'The image build could not be submitted',
      );
    } finally {
      setSubmitting(false);
    }
  }, [repositoryUrl, reference]);

  const cancel = useCallback(async () => {
    if (!build) {
      return;
    }
    try {
      setBuildState(await imagesApi.cancelBuild(build.build_id));
    } catch (cause: unknown) {
      setSubmitError(cause instanceof Error ? cause.message : 'The build could not be canceled');
    }
  }, [build]);

  const retry = useCallback(async () => {
    if (!build) {
      return;
    }
    try {
      setBuiltImageState(null);
      setBuildState(await imagesApi.retryBuild(build.build_id));
    } catch (cause: unknown) {
      setSubmitError(cause instanceof Error ? cause.message : 'The build could not be retried');
    }
  }, [build]);

  const clear = useCallback(() => {
    setBuildState(null);
    setBuiltImageState(null);
    setSubmitError(null);
  }, []);

  return {
    build,
    builtImage,
    submitting,
    submitError,
    active,
    start,
    cancel,
    retry,
    clear,
  };
}
