// Public Knowledge projection contract and safe Markdown parser. The renderer
// emits React text/nodes only; unrecognized Markdown remains plain text.
import {allowedKnowledgeExternal} from '../../components/Links.tsx';

const SHA = /^[a-f0-9]{40}$/;
export const KNOWLEDGE_ARTICLE = /^topics\/[a-z0-9]+(?:-[a-z0-9]+)*\/[^/]+\.md$/u;

export interface KnowledgeArticle {
  path: string;
  title: string;
  description: string;
  topic: string;
  categories: string[];
  status: 'verified' | 'candidate';
  updated_at: string;
  body: string;
  sources: string[];
}

export interface KnowledgeChange {
  at: string;
  action: string;
  title: string;
  path: string;
  reason: string;
  source: string;
}

export interface KnowledgeSource {
  branch: string;
  sha: string;
  generated_at: string;
}

export interface KnowledgeSnapshot {
  schema_version: number;
  status: 'available' | 'unavailable';
  source: KnowledgeSource | null;
  articles: KnowledgeArticle[];
  changes: KnowledgeChange[];
  topics: string[];
  categories: string[];
}

export interface KnowledgeFilterState {
  query: string;
  topic: string;
  category: string;
}

export interface KnowledgeRoute {
  view: 'browse' | 'changes';
  article: string | null;
}

export function knowledgeHref(path: string): string {
  if (!KNOWLEDGE_ARTICLE.test(path) || path.includes('..') || path.includes('\\')) return '#/knowledge';
  return '#/knowledge?article=' + encodeURIComponent(path);
}

export function knowledgeRoute(hash: string): KnowledgeRoute | null {
  const raw = String(hash || '').replace(/^#/, '');
  if (!/^\/knowledge(?:\?|$)/.test(raw)) return null;
  const query = new URLSearchParams(raw.split('?')[1] || '');
  const path = query.get('article');
  return {
    view: query.get('view') === 'changes' ? 'changes' : 'browse',
    article: path && KNOWLEDGE_ARTICLE.test(path) && !path.includes('..') ? path : null,
  };
}

export function validKnowledgeSnapshot(data: unknown): data is KnowledgeSnapshot {
  const snapshot = data as Partial<KnowledgeSnapshot> | null;
  return (
    snapshot?.schema_version === 1 &&
    ['available', 'unavailable'].includes(snapshot.status as string) &&
    Array.isArray(snapshot.articles) &&
    Array.isArray(snapshot.changes) &&
    Array.isArray(snapshot.topics) &&
    Array.isArray(snapshot.categories) &&
    snapshot.articles.length <= 200 &&
    snapshot.changes.length <= 2000 &&
    (snapshot.status === 'unavailable'
      ? snapshot.source === null && snapshot.articles.length === 0
      : snapshot.source?.branch === 'knowledge' &&
        SHA.test(snapshot.source.sha || '') &&
        snapshot.articles.every(
          (article) =>
            KNOWLEDGE_ARTICLE.test(article?.path || '') &&
            typeof article.title === 'string' &&
            typeof article.description === 'string' &&
            typeof article.body === 'string' &&
            ['verified', 'candidate'].includes(article.status) &&
            Array.isArray(article.categories) &&
            Array.isArray(article.sources),
        ))
  );
}

export function filterKnowledge(
  articles: KnowledgeArticle[],
  {query = '', topic = 'all', category = 'all'}: Partial<KnowledgeFilterState> = {},
): KnowledgeArticle[] {
  const term = query.toLocaleLowerCase().trim();
  return articles.filter(
    (article) =>
      (topic === 'all' || article.topic === topic) &&
      (category === 'all' || article.categories.includes(category)) &&
      (!term ||
        [article.title, article.description, article.topic, article.categories.join(' '), article.body]
          .join(' ')
          .toLocaleLowerCase()
          .includes(term)),
  );
}

export type InlineNode =
  | {type: 'text'; value: string}
  | {type: 'link'; text: string; href: string; external: boolean}
  | {type: 'strong'; value: string}
  | {type: 'code'; value: string};

export type BlockNode =
  | {type: 'p'; children: InlineNode[]}
  | {type: 'h'; level: number; children: InlineNode[]}
  | {type: 'ul' | 'ol'; items: InlineNode[][]}
  | {type: 'blockquote'; children: InlineNode[]}
  | {type: 'pre'; value: string};

type ResolvedLink = {href: string; external: boolean} | null;

function resolveLink(link: string, article: KnowledgeArticle, paths: Set<string>): ResolvedLink {
  if (typeof link !== 'string' || !link || link.startsWith('#')) return null;
  if (link.startsWith('https://')) return allowedKnowledgeExternal(link) ? {href: link, external: true} : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith('//')) return null;
  try {
    const parsed = new URL(link, 'https://knowledge.local/' + article.path);
    if (parsed.hostname !== 'knowledge.local') return null;
    const path = decodeURIComponent(parsed.pathname.slice(1));
    if (paths.has(path)) return {href: knowledgeHref(path), external: false};
  } catch {
    // Malformed link stays plain text.
  }
  return null;
}

const INLINE =
  /(\[([^\]]{1,240})\]\(([^)\s]{1,800})\)|\*\*([^*\n]{1,300})\*\*|\x60([^\x60\n]{1,300})\x60)/g;

function inline(content: string, article: KnowledgeArticle, paths: Set<string>): InlineNode[] {
  const nodes: InlineNode[] = [];
  let pos = 0;
  let match: RegExpExecArray | null;
  INLINE.lastIndex = 0;
  while ((match = INLINE.exec(content)) !== null) {
    if (match.index > pos) nodes.push({type: 'text', value: content.slice(pos, match.index)});
    if (match[2] !== undefined) {
      const link = resolveLink(match[3] as string, article, paths);
      if (link) nodes.push({type: 'link', text: match[2], href: link.href, external: link.external});
      else nodes.push({type: 'text', value: match[2]});
    } else if (match[4] !== undefined) {
      nodes.push({type: 'strong', value: match[4]});
    } else {
      nodes.push({type: 'code', value: match[5] as string});
    }
    pos = INLINE.lastIndex;
  }
  if (pos < content.length) nodes.push({type: 'text', value: content.slice(pos)});
  return nodes;
}

export function parseMarkdown(
  body: string,
  article: KnowledgeArticle,
  paths: Set<string>,
): BlockNode[] {
  const lines = body.split(/\r?\n/);
  const blocks: BlockNode[] = [];
  let list: {type: 'ul' | 'ol'; items: InlineNode[][]} | null = null;
  let code: string[] | null = null;
  let paragraph: string[] = [];

  function flush(): void {
    if (paragraph.length) {
      blocks.push({type: 'p', children: inline(paragraph.join(' '), article, paths)});
      paragraph = [];
    }
    list = null;
  }

  for (const line of lines) {
    if (code !== null) {
      if (/^ *\x60{3,}\s*$/.test(line)) {
        blocks.push({type: 'pre', value: code.join('\n')});
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^ *\x60{3,}[\w-]*\s*$/.test(line)) {
      flush();
      code = [];
      continue;
    }
    const heading = /^(#{1,5})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({
        type: 'h',
        level: Math.min((heading[1] as string).length + 1, 6),
        children: inline(heading[2] as string, article, paths),
      });
      continue;
    }
    const item = /^\s*(?:([-*])|([0-9]+)\.)\s+(.+)$/.exec(line);
    if (item) {
      if (paragraph.length) flush();
      const next = item[2] ? 'ol' : 'ul';
      if (!list || list.type !== next) {
        list = {type: next, items: []};
        blocks.push(list);
      }
      list.items.push(inline(item[3] as string, article, paths));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push({type: 'blockquote', children: inline(quote[1] as string, article, paths)});
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    if (list) flush();
    paragraph.push(line.trim());
  }
  if (code !== null) blocks.push({type: 'pre', value: code.join('\n')});
  flush();
  return blocks;
}
