import type { EnvFileRef } from '@/types';
import { parseEnv } from '@/capabilities/env/model/envParser';

export interface PreviewEntry {
  ref: EnvFileRef;
  /** Null when the profile could not be read. */
  content: string | null;
  error: string | null;
}

export interface EffectivePreview {
  /** Effective key -> value; a later profile wins. Never rendered as values. */
  values: Map<string, string>;
  /** Keys defined by more than one selected profile, in first-seen order. */
  overlaps: string[];
  /** Number of distinct effective keys. */
  keyCount: number;
}

/**
 * The effective variables of an ordered profile selection.
 *
 * The values stay in memory for comparison only. The draft surface renders
 * key names and counts; it never prints a value.
 */
export function effectivePreview(entries: PreviewEntry[]): EffectivePreview {
  const values = new Map<string, string>();
  const definitions = new Map<string, number>();

  for (const entry of entries) {
    if (entry.content === null) {
      continue;
    }
    const parsed = parseEnv(entry.content);
    for (const [key, value] of parsed.vars) {
      values.set(key, value);
      definitions.set(key, (definitions.get(key) ?? 0) + 1);
    }
  }

  const overlaps = [...definitions]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);

  return { values, overlaps, keyCount: values.size };
}

/** Key names whose effective value differs between two selections. */
export function changedKeys(current: EffectivePreview, draft: EffectivePreview): string[] {
  const keys = new Set([...current.values.keys(), ...draft.values.keys()]);
  return [...keys].filter((key) => current.values.get(key) !== draft.values.get(key));
}
