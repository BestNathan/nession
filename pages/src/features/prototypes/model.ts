// Strictly validated, pinned public prototype catalog. This is a read-only
// listing, not a second gallery implementation.
export const PROTOTYPE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*-[0-9]+$/;

export interface PrototypeEntry {
  slug: string;
  preview: string;
  source: string;
}

export interface PrototypeCatalog {
  schema_version: number;
  source: {branch: string; sha: string};
  entries: PrototypeEntry[];
}

export interface PrototypeInfo {
  title: string;
  description: string;
  eyebrow: string;
  kind: string;
}

const PROTOTYPE_INFO: Record<string, PrototypeInfo> = {
  'terminal-fixed-cols-2487': {
    title: 'Fixed-column Terminal Lab',
    description:
      'Compare true desktop and iPhone terminal font sizes while keeping the same logical columns. Change the viewport, column count and simulated keyboard.',
    eyebrow: 'TERMINAL / RESPONSIVE TYPE',
    kind: 'terminal',
  },
  'ai-workspace-2221': {
    title: 'AI Workspace',
    description:
      'A scene-first workspace: let the current intent shape the surface, move between scenes and inspect how an action becomes a visible interaction.',
    eyebrow: 'SYSTEM ONE / DYNAMIC SCENES',
    kind: 'workspace',
  },
  'ai-conversation-2254': {
    title: 'AI Conversation',
    description:
      'Follow a text-driven interaction from streamed AI content to structured business components, selection, and a contextual session flow.',
    eyebrow: 'SYSTEM TWO / TEXT-TO-UI',
    kind: 'conversation',
  },
};

export function prototypeInfo(slug: string): PrototypeInfo {
  const known = PROTOTYPE_INFO[slug];
  if (known) return known;
  const base = slug.replace(/-[0-9]+$/, '').replace(/-/g, ' ');
  return {
    title: base.replace(/\b\w/g, (character) => character.toUpperCase()),
    description: 'Explore this interactive Nession product concept and its mocked transitions.',
    eyebrow: 'DESIGN EXPLORATION',
    kind: 'generic',
  };
}

export function validPrototypeCatalog(data: unknown): data is PrototypeCatalog {
  const catalog = data as Partial<PrototypeCatalog> | null;
  if (
    catalog?.schema_version !== 1 ||
    catalog.source?.branch !== 'prototype' ||
    !/^[a-f0-9]{40}$/.test(catalog.source.sha || '') ||
    !Array.isArray(catalog.entries) ||
    catalog.entries.length > 100
  ) {
    return false;
  }
  const seen = new Set<string>();
  return catalog.entries.every((entry) => {
    if (
      typeof entry?.slug !== 'string' ||
      !PROTOTYPE_SLUG.test(entry.slug) ||
      seen.has(entry.slug)
    ) {
      return false;
    }
    seen.add(entry.slug);
    return (
      entry.preview === 'prototypes/' + entry.slug + '/index.html' &&
      entry.source ===
        'https://github.com/BestNathan/nession/blob/' + catalog.source?.sha + '/' + entry.slug + '/index.html'
    );
  });
}

export function sortedPrototypeEntries(entries: PrototypeEntry[]): PrototypeEntry[] {
  return [...entries].sort(
    (a, b) =>
      Number(b.slug.match(/[0-9]+$/)?.[0] || 0) - Number(a.slug.match(/[0-9]+$/)?.[0] || 0),
  );
}
