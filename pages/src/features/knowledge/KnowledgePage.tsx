import {Fragment, useEffect, useMemo, useRef, useState, type ReactElement} from 'react';
import {KnowledgeExternal, LocalLink} from '../../components/Links.tsx';
import {utcStamp} from '../../lib/format.ts';
import {
  filterKnowledge,
  knowledgeHref,
  knowledgeRoute,
  parseMarkdown,
  type BlockNode,
  type InlineNode,
  type KnowledgeArticle,
  type KnowledgeSnapshot,
} from './model.ts';
import {useUiState} from '../../app/ui-state.tsx';

const GITHUB = 'https://github.com/BestNathan/nession';

function Inline({nodes}: {nodes: InlineNode[]}): ReactElement {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.type === 'text') return <Fragment key={index}>{node.value}</Fragment>;
        if (node.type === 'strong') return <strong key={index}>{node.value}</strong>;
        if (node.type === 'code') return <code key={index}>{node.value}</code>;
        return (
          <a
            key={index}
            href={node.href}
            target={node.external ? '_blank' : undefined}
            rel={node.external ? 'noopener noreferrer' : undefined}
          >
            {node.text}
          </a>
        );
      })}
    </>
  );
}

function Blocks({blocks}: {blocks: BlockNode[]}): ReactElement {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'p':
            return <p key={index}><Inline nodes={block.children} /></p>;
          case 'h': {
            const Tag = ('h' + block.level) as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
            return <Tag key={index}><Inline nodes={block.children} /></Tag>;
          }
          case 'ul':
          case 'ol': {
            const Tag = block.type;
            return (
              <Tag key={index}>
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}><Inline nodes={item} /></li>
                ))}
              </Tag>
            );
          }
          case 'blockquote':
            return <blockquote key={index}><Inline nodes={block.children} /></blockquote>;
          case 'pre':
            return (
              <pre key={index}>
                <code>{block.value}</code>
              </pre>
            );
        }
      })}
    </>
  );
}

function Pill({label, className = ''}: {label: string; className?: string}): ReactElement {
  return <span className={'knowledge-tag ' + className}>{label}</span>;
}

function ArticleReader({
  article,
  source,
  paths,
}: {
  article: KnowledgeArticle;
  source: {sha: string};
  paths: Set<string>;
}): ReactElement {
  const blocks = useMemo(() => parseMarkdown(article.body, article, paths), [article, paths]);
  return (
    <article className="knowledge-reader">
      <LocalLink text="← All articles" path="/knowledge" className="knowledge-back" />
      <div className="eyebrow">{article.topic + ' / CURRENT KNOWLEDGE'}</div>
      <h2>{article.title}</h2>
      <p className="knowledge-description">{article.description}</p>
      <div className="knowledge-meta">
        <span>{'Updated ' + utcStamp(article.updated_at)}</span>
        <Pill label={article.status} className={article.status === 'candidate' ? 'candidate' : 'verified'} />
        {article.categories.map((category) => (
          <Pill key={category} label={category} />
        ))}
      </div>
      <div className="knowledge-authority">
        {article.status === 'verified'
          ? 'Verified means sourced project knowledge, not live runtime truth. Code, Gates and owner decisions remain authoritative.'
          : 'Candidate: this article is not verified against authoritative evidence.'}
      </div>
      <div className="knowledge-prose">
        <Blocks blocks={blocks} />
      </div>
      <section className="knowledge-sources">
        <h3>Evidence sources</h3>
        {article.sources.map((url, index) => (
          <KnowledgeExternal key={url + ':' + index} text={'Source ' + (index + 1) + ' · ' + url.replace(GITHUB + '/', '') + ' ↗'} url={url} />
        ))}
      </section>
      <div className="knowledge-actions">
        <KnowledgeExternal
          text="Original at pinned SHA ↗"
          url={GITHUB + '/blob/' + source.sha + '/' + article.path}
          className="action"
        />
        <KnowledgeExternal text="Git history ↗" url={GITHUB + '/commits/knowledge/' + article.path} className="action outline" />
      </div>
    </article>
  );
}

function ChangeList({data}: {data: KnowledgeSnapshot}): ReactElement {
  const paths = new Set(data.articles.map((article) => article.path));
  return (
    <div className="knowledge-changes">
      <div className="knowledge-change-intro">
        <div className="eyebrow">KNOWLEDGE / CHANGELOG</div>
        <h2>Changes over time.</h2>
        <p>The single append-only project log. Historical article bodies live in Git commits.</p>
      </div>
      <div className="knowledge-change-list">
        {data.changes.map((entry) => (
          <article className="knowledge-event" key={entry.at + ':' + entry.path + ':' + entry.action}>
            <time dateTime={entry.at}>{utcStamp(entry.at)}</time>
            <div>
              <div className="knowledge-event-heading">
                <Pill label={entry.action} />
                <strong>{entry.title}</strong>
              </div>
              <p>{entry.reason}</p>
              <div className="knowledge-event-links">
                {paths.has(entry.path) ? (
                  <LocalLink text="Read current article ↗" path={knowledgeHref(entry.path).slice(1)} />
                ) : null}
                <KnowledgeExternal text="Source issue / PR ↗" url={entry.source} />
              </div>
            </div>
          </article>
        ))}
        {!data.changes.length ? <p>No recorded changes.</p> : null}
      </div>
    </div>
  );
}

function KnowledgeFilters({
  data,
  topic,
  onTopic,
  category,
  onCategory,
}: {
  data: KnowledgeSnapshot;
  topic: string;
  onTopic: (topic: string) => void;
  category: string;
  onCategory: (category: string) => void;
}): ReactElement {
  const [categoryQuery, setCategoryQuery] = useState('');
  const all = ['all', ...data.categories];
  const current = all.includes(category) ? category : 'all';
  const term = categoryQuery.trim().toLocaleLowerCase();
  const options = all.filter(
    (candidate) => candidate === 'all' || candidate === current || candidate.toLocaleLowerCase().includes(term),
  );
  return (
    <aside className="knowledge-side">
      <div className="eyebrow">TOPICS</div>
      <div className="knowledge-topic-group">
        {['all', ...data.topics].map((candidate) => {
          const count =
            candidate === 'all'
              ? data.articles.length
              : data.articles.filter((article) => article.topic === candidate).length;
          const active = topic === candidate;
          return (
            <button
              key={candidate}
              className={'knowledge-filter' + (active ? ' active' : '')}
              type="button"
              aria-pressed={active ? 'true' : 'false'}
              onClick={() => onTopic(candidate)}
            >
              {(candidate === 'all' ? 'All topics' : candidate) + '  ' + count}
            </button>
          );
        })}
      </div>
      <div className="knowledge-categories">
        <label className="eyebrow knowledge-category-title" htmlFor="knowledge-category">
          CATEGORIES
        </label>
        <input
          className="knowledge-category-search"
          type="search"
          placeholder="Find a tag"
          aria-label="Search categories"
          value={categoryQuery}
          onChange={(event) => setCategoryQuery(event.target.value)}
        />
        <select
          className="knowledge-category"
          id="knowledge-category"
          value={current}
          onChange={(event) => onCategory(event.target.value)}
        >
          {options.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate === 'all' ? 'All tags' : candidate}
            </option>
          ))}
        </select>
      </div>
    </aside>
  );
}

export function KnowledgePage({
  data,
  hash,
}: {
  data: KnowledgeSnapshot | null;
  hash: string;
}): ReactElement {
  const route = knowledgeRoute(hash) || {view: 'browse', article: null};
  const {state, actions} = useUiState();
  const entries = useRef<HTMLDivElement>(null);
  const readerSlot = useRef<HTMLDivElement>(null);
  const snapshot =
    data && data.status === 'available' && data.source ? (data as KnowledgeSnapshot & {source: {sha: string; generated_at: string}}) : null;
  const source = snapshot?.source;
  const paths = useMemo(() => new Set((snapshot?.articles || []).map((article) => article.path)), [snapshot]);
  const selected = !snapshot
    ? null
    : route.article
      ? (snapshot.articles.find((article) => article.path === route.article) ?? null)
      : snapshot.articles[0] || null;
  const selectedPath = selected?.path || '';
  useEffect(() => {
    if (readerSlot.current) readerSlot.current.scrollTop = 0;
  }, [selectedPath]);

  return (
    <>
      <div className="eyebrow knowledge-kicker">NESSION / OPEN ENGINEERING / KNOWLEDGE</div>
      <h1 className="knowledge-heading">What we’ve learned, kept.</h1>
      <p className="knowledge-lede">Source-grounded engineering decisions and insights, preserved as the project evolves.</p>
      {!snapshot || !source ? (
        <div className="panel knowledge-unavailable">
          <h3>Knowledge snapshot unavailable</h3>
          <p>The pinned source could not be validated or loaded. This is not an empty knowledge base.</p>
          <KnowledgeExternal text="View Knowledge source ↗" url={GITHUB + '/tree/knowledge'} />
        </div>
      ) : (
        <>
          <div className="knowledge-snapshot">
            <span className="eyebrow">SOURCE SNAPSHOT</span>
            <strong>{'knowledge @ ' + source.sha.slice(0, 12)}</strong>
            <span>{snapshot.articles.length + ' articles · ' + snapshot.topics.length + ' topics'}</span>
            <small>{'Built ' + utcStamp(source.generated_at) + ' · read-only'}</small>
          </div>
          <nav className="knowledge-tabs">
            <LocalLink text="Browse knowledge" path="/knowledge" className={route.view === 'browse' ? 'active' : ''} />
            <LocalLink text="Changes" path="/knowledge?view=changes" className={route.view === 'changes' ? 'active' : ''} />
          </nav>
          {route.view === 'changes' ? (
            <ChangeList data={snapshot} />
          ) : (
            <KnowledgeBrowse
              data={snapshot}
              source={source}
              paths={paths}
              route={route}
              selected={selected}
              entries={entries}
              readerSlot={readerSlot}
              state={state.knowledge}
              actions={actions}
            />
          )}
        </>
      )}
    </>
  );
}

function KnowledgeBrowse({
  data,
  source,
  paths,
  route,
  selected,
  entries,
  readerSlot,
  state,
  actions,
}: {
  data: KnowledgeSnapshot;
  source: {sha: string};
  paths: Set<string>;
  route: {article: string | null};
  selected: KnowledgeArticle | null;
  entries: React.RefObject<HTMLDivElement | null>;
  readerSlot: React.RefObject<HTMLDivElement | null>;
  state: {query: string; topic: string; category: string};
  actions: {setKnowledge: (patch: {query?: string; topic?: string; category?: string}) => void};
}): ReactElement {
  const found = filterKnowledge(data.articles, state).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const currentCategory = ['all', ...data.categories].includes(state.category) ? state.category : 'all';
  const reading = Boolean(route.article && selected);
  return (
    <div className={'knowledge-layout' + (reading ? ' reading' : '')}>
      <KnowledgeFilters
        data={data}
        topic={state.topic}
        onTopic={(topic) => actions.setKnowledge({topic})}
        category={currentCategory}
        onCategory={(category) => actions.setKnowledge({category})}
      />
      <section className="knowledge-listbox">
        <input
          className="knowledge-search"
          type="search"
          value={state.query}
          placeholder="Search decisions and concepts"
          aria-label="Search Knowledge articles"
          onChange={(event) => actions.setKnowledge({query: event.target.value})}
        />
        <div className="knowledge-result-count">{found.length + ' ' + (found.length === 1 ? 'ARTICLE' : 'ARTICLES')}</div>
        <div className="knowledge-entries" role="region" aria-label="Knowledge article list" tabIndex={0} ref={entries}>
          {found.map((article) => (
            <a
              className={'knowledge-entry' + (selected?.path === article.path ? ' selected' : '')}
              href={knowledgeHref(article.path)}
              key={article.path}
            >
              <div className="eyebrow">{article.topic}</div>
              <strong>{article.title}</strong>
              <p>{article.description}</p>
              <div className="knowledge-entry-meta">
                <Pill label={article.status} className={article.status === 'candidate' ? 'candidate' : 'verified'} />
                <span>{utcStamp(article.updated_at)}</span>
              </div>
            </a>
          ))}
          {!found.length ? (
            <p className="knowledge-no-results">No matching articles. Try another topic, category or search term.</p>
          ) : null}
        </div>
      </section>
      <div
        className="knowledge-reader-slot"
        role="region"
        aria-label="Knowledge article reader"
        tabIndex={0}
        ref={readerSlot}
      >
        {route.article && !selected ? (
          <div className="panel">Article not found in this source snapshot.</div>
        ) : selected ? (
          <ArticleReader article={selected} source={source} paths={paths} />
        ) : (
          <div className="panel">No published knowledge articles.</div>
        )}
      </div>
    </div>
  );
}
