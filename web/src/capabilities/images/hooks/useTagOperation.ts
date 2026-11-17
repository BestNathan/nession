import { useEffect, useState } from 'react';
import {
  ImageTagMutationError,
  imagesApi,
  type ImageLibraryEntry,
  type ImageReferenceImpact,
} from '../ImagesPlugin';

export type TagOperationKind = 'create' | 'move' | 'remove';

export interface TagOperationState {
  kind: TagOperationKind;
  tag: string;
  expected: string | null;
}

export function tagOperationTitle(kind: TagOperationKind): string {
  switch (kind) {
    case 'create':
      return 'Create tag';
    case 'move':
      return 'Move tag';
    case 'remove':
      return 'Unlink tag';
  }
}

/** Known or unobservable references that forbid a silent unlink. */
export function needsImpactReview(impact: ImageReferenceImpact | null): boolean {
  if (!impact) {
    return false;
  }
  return (
    impact.unknown
    || impact.project_pins > 0
    || impact.session_pins > 0
    || impact.leases > 0
    || impact.compose_references > 0
  );
}

/**
 * The Tag operation state machine (#3799).
 *
 * It owns the draft, the impact read for a deliberate unlink, the CAS submit
 * and the conflict/refusal readback. The Server remains the mutation
 * authority; this hook never retries a stale expectation.
 */
export function useTagOperation(
  entry: ImageLibraryEntry,
  operation: TagOperationState,
  onClose: () => void,
  onChanged: () => void,
) {
  const [tagName, setTagName] = useState(operation.tag);
  const [targetDigest, setTargetDigest] = useState(entry.manifest_digest ?? '');
  const [impact, setImpact] = useState<ImageReferenceImpact | null>(null);
  const [impactLoading, setImpactLoading] = useState(operation.kind === 'remove');
  const [acceptImpact, setAcceptImpact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflictDigest, setConflictDigest] = useState<string | null>(null);

  useEffect(() => {
    if (operation.kind !== 'remove') {
      return;
    }
    let cancelled = false;
    setImpactLoading(true);
    void imagesApi
      .tagImpact(entry.repository, operation.tag)
      .then((next) => {
        if (!cancelled) {
          setImpact(next);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) {
          return;
        }
        const mutation = cause instanceof ImageTagMutationError ? cause : null;
        setImpact(mutation?.impact ?? null);
        setError(
          cause instanceof Error ? cause.message : 'Reference impact could not be observed',
        );
      })
      .finally(() => {
        if (!cancelled) {
          setImpactLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [entry.repository, operation.kind, operation.tag]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setConflictDigest(null);
    try {
      if (operation.kind === 'remove') {
        await imagesApi.removeTag({
          repository: entry.repository,
          tag: operation.tag,
          expected_digest: operation.expected ?? entry.manifest_digest ?? '',
          accept_reference_impact: acceptImpact,
        });
      } else {
        await imagesApi.setTag({
          repository: entry.repository,
          tag: tagName.trim(),
          digest: targetDigest.trim(),
          ...(operation.kind === 'move'
            ? { expected_digest: operation.expected ?? entry.manifest_digest ?? '' }
            : {}),
        });
      }
      onChanged();
      onClose();
    } catch (cause: unknown) {
      const mutation = cause instanceof ImageTagMutationError ? cause : null;
      setError(cause instanceof Error ? cause.message : 'The Tag operation was refused');
      setConflictDigest(mutation?.currentDigest ?? null);
      if (mutation?.impact) {
        setImpact(mutation.impact);
      }
    } finally {
      setBusy(false);
    }
  };

  const needsReview = needsImpactReview(impact);
  const confirmDisabled =
    busy
    || (operation.kind === 'remove'
      ? impact === null || impact.unknown || (needsReview && !acceptImpact)
      : tagName.trim() === '' || targetDigest.trim() === '');

  return {
    tagName,
    setTagName,
    targetDigest,
    setTargetDigest,
    impact,
    impactLoading,
    acceptImpact,
    setAcceptImpact,
    busy,
    error,
    conflictDigest,
    needsReview,
    confirmDisabled,
    submit,
  };
}
