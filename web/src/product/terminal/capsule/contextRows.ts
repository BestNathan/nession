import type { LucideIcon } from 'lucide-react';
import type { CapabilityId } from '@/product/capability';
import type { ResolvedWorkContext } from '@/product/terminal/capsule/workAwareness';
import type { CapsuleCapabilityEntry, SensedCapabilityItem } from '@/product/terminal/capsule/types';

/**
 * The rows of the Context Capsule, in the order the surface renders them
 * (#1347 SC-35/SC-41).
 *
 * A pure function rather than a layer inside the component, because the two
 * things it decides are the two things worth testing on their own: **the order**
 * (sensed first — work, then context — the ordinary catalog after) and **the
 * de-duplication**, which a flat list introduces and the two-layer disclosure
 * this replaces got for free.
 *
 * That second one is not a detail. A sensed capability is still *in* the
 * registry's entry list — sensing adds presence, it does not remove the entry —
 * so a surface that renders both lists in one column shows the same capability
 * twice, once with its reason and once without. The id may appear once, in the
 * sensed half, and its reason is what says why.
 */
export type ContextRowKind = 'work' | 'context' | 'ordinary';

export interface ContextRow {
  capabilityId: CapabilityId;
  title: string;
  /** The capability's own glyph. The app layer resolves it; absent is legal. */
  icon?: LucideIcon;
  /** One line saying why this row is here. Sensed rows only. */
  reason?: string;
  kind: ContextRowKind;
}

/**
 * The three groups, in render order, de-duplicated.
 *
 * Work outranks context — "what you are running" over "what this device
 * affords" — and both outrank the catalog, which keeps the registry's own order
 * so a capability's slot stays put as senses come and go.
 */
export function resolveContextRows(
  workItems: readonly SensedCapabilityItem[],
  contextItems: readonly SensedCapabilityItem[],
  entries: readonly CapsuleCapabilityEntry[],
): ContextRow[] {
  const rows: ContextRow[] = [];
  const sensed = new Set<CapabilityId>();

  for (const item of workItems) {
    sensed.add(item.capabilityId);
    rows.push({ ...item, kind: 'work' });
  }
  for (const item of contextItems) {
    // A capability cannot be both working and context-sensed — the registry
    // promises it is one or the other — but if it ever is, the work row (which
    // carries the stronger claim, and its own summary) wins and this one is
    // dropped rather than shown twice.
    if (sensed.has(item.capabilityId)) {
      continue;
    }
    sensed.add(item.capabilityId);
    rows.push({ ...item, kind: 'context' });
  }

  for (const entry of entries) {
    if (sensed.has(entry.id)) {
      continue;
    }
    rows.push({
      capabilityId: entry.id,
      title: entry.title,
      icon: entry.icon,
      kind: 'ordinary',
    });
  }

  return rows;
}

/**
 * The sensed *work* items: working summaries resolved to the capability's
 * display identity (#1347 SC-19).
 *
 * A summary whose capability has no disclosure entry is dropped rather than
 * rendered as its raw id — the row's copy is Nession's, and an id is not copy.
 * Moved here from `CapsuleInputTools` unchanged when the disclosure became a
 * flat list: it is the same mapping, and it belongs with the ordering rule it
 * feeds.
 */
export function sensedWorkItems(
  workContext: ResolvedWorkContext | undefined,
  entries: readonly CapsuleCapabilityEntry[],
): SensedCapabilityItem[] {
  if (!workContext) {
    return [];
  }
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return workContext.summaries.flatMap((summary) => {
    if (summary.status !== 'working') {
      return [];
    }
    const entry = byId.get(summary.capabilityId);
    return entry
      ? [
          {
            capabilityId: summary.capabilityId,
            title: entry.title,
            icon: entry.icon,
            reason: summary.summary,
          },
        ]
      : [];
  });
}
