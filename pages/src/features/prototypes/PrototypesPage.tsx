import type {ReactElement} from 'react';
import {GitHubLink} from '../../components/Links.tsx';
import {Empty, Grid, PageHead, Section} from '../../components/Primitives.tsx';
import type {Resource} from '../../data/load.ts';
import {prototypeInfo, sortedPrototypeEntries, type PrototypeCatalog} from './model.ts';

function previewHref(preview: string): string {
  return typeof document === 'undefined' ? preview : new URL(preview, document.baseURI).href;
}

export function PrototypesPage({catalog}: {catalog: Resource<PrototypeCatalog>}): ReactElement {
  return (
    <>
      <PageHead
        kicker="PRODUCT / INTERACTIVE LAB"
        title="Ideas in motion."
        description="Design explorations that can be opened, clicked and reviewed. These are experimental browser mockups, not live Nession Sessions or production acceptance evidence."
      />
      <Section
        kicker="THE PROTOTYPE LIBRARY"
        title="Explore a direction."
        hint="Same Nession Pages experience; each concept keeps its own standalone interactive HTML."
      >
        {catalog.status === 'loading' ? (
          <Empty title="Loading published prototypes" text="Reading the pinned public artifact list." />
        ) : catalog.status !== 'available' || !catalog.data?.entries.length ? (
          <Empty
            title="Prototype catalog unavailable"
            text="The published prototype manifest could not be verified. Existing engineering evidence and other Pages routes remain available."
          />
        ) : (
          <>
            <Grid cols="three">
              {sortedPrototypeEntries(catalog.data.entries).map((entry) => {
                const info = prototypeInfo(entry.slug);
                const issue = entry.slug.match(/([0-9]+)$/)?.[1] || '';
                return (
                  <article className="prototype-card" data-kind={info.kind} key={entry.slug}>
                    <div className="prototype-art" aria-hidden="true">
                      <div className="prototype-miniature">
                        <div className="prototype-miniature-top">{'NESSION / ' + info.kind.toUpperCase()}</div>
                        <div className="prototype-miniature-line" />
                        <div className="prototype-miniature-line second" />
                        <div className="prototype-miniature-line third" />
                      </div>
                    </div>
                    <div className="prototype-card-body">
                      <div className="prototype-card-meta">
                        <span className="eyebrow">{info.eyebrow}</span>
                        <span className="tag neutral">{'Issue #' + issue}</span>
                      </div>
                      <h3>{info.title}</h3>
                      <p>{info.description}</p>
                      <div className="prototype-card-links">
                        <a
                          className="action"
                          href={previewHref(entry.preview)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={'Open ' + info.title + ' interactive HTML in a new tab'}
                        >
                          Open interactive HTML  ↗
                        </a>
                        <GitHubLink className="prototype-source" text="View source ↗" url={entry.source} />
                        <GitHubLink
                          className="prototype-source"
                          text={'Requirement #' + issue + ' ↗'}
                          url={'https://github.com/BestNathan/nession/issues/' + issue}
                        />
                      </div>
                    </div>
                  </article>
                );
              })}
            </Grid>
            <div className="prototype-publication">
              <span className="mono">SHARED PROTOTYPE SOURCE</span>
              <span>{(catalog.data.source.sha.slice(0, 12)) + ' · Snapshot published by Nession Pages'}</span>
              <GitHubLink
                text="Pinned branch source ↗"
                url={'https://github.com/BestNathan/nession/tree/' + catalog.data.source.sha}
              />
            </div>
          </>
        )}
      </Section>
      <Section
        kicker="HOW TO USE"
        title="Explore, then inspect."
        hint="A prototype is a design decision aid—not a claim that the production feature is complete."
      >
        <Grid cols="three">
          <Empty
            title="1. Open the HTML"
            text="Try the interactive mock at the original viewport size. Every preview has a link back to the Pages gallery."
          />
          <Empty
            title="2. Follow the source"
            text="Use the pinned GitHub source or owning Requirement to review the implementation and design questions."
          />
          <Empty
            title="3. Validate in production separately"
            text="A mock interaction can inform product decisions, but real Agent, tmux, Session and E2E behavior must be verified independently."
          />
        </Grid>
      </Section>
    </>
  );
}
