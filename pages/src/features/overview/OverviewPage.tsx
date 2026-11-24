import type {ReactElement} from 'react';
import type {SiteSnapshot} from '../../data/types.ts';
import {date, fmt} from '../../lib/format.ts';
import {LocalLink} from '../../components/Links.tsx';
import {Empty, Entry, Grid, List, Metric, Section} from '../../components/Primitives.tsx';

const LOOP = [
  ['Issue', 'The shared work contract'],
  ['Developer', 'Implement and checkpoint'],
  ['Reviewer', 'Inspect, repair and verify'],
  ['Quality + E2E', 'Exact revision, real tests'],
  ['Acceptance', 'Evidence before completion'],
] as const;

export function OverviewPage({snapshot}: {snapshot: SiteSnapshot}): ReactElement {
  const repository = snapshot.repository?.current;
  const efficiency = snapshot.repository?.efficiency;
  const agents = snapshot.agents?.summary;
  const latestIssues = (snapshot.work?.issues || []).slice(0, 4);
  return (
    <>
      <section className="hero">
        <div>
          <div className="eyebrow">OPEN SOURCE  /  DISTRIBUTED WORKSPACE</div>
          <h1>
            {'An open space '}
            <em>for what comes next.</em>
          </h1>
          <p className="lede">
            Work should continue across machines, terminals and AI agents without rebuilding your context. Nession is
            building that experience—and showing the engineering behind it.
          </p>
          <div className="actions">
            <LocalLink text="Explore the Agents  ↗" path="/agents" className="action" />
            <LocalLink text="See the engineering  ↗" path="/work" className="action outline" />
          </div>
        </div>
        <aside className="diagram">
          <div className="diagram-head">
            <span className="eyebrow">COLLABORATION LOOP</span>
            <span className="mono">01 / 05</span>
          </div>
          {LOOP.map(([title, subtitle], index) => (
            <LoopStep key={title} index={index} title={title} subtitle={subtitle} />
          ))}
          <div className="loop-foot">
            <i className="dot" />
            <span>Documented workflow · actual progress depends on verified evidence</span>
          </div>
        </aside>
      </section>
      <Section
        kicker="PROJECT PULSE"
        title="The work, at a glance"
        hint="A generated snapshot, not a live connection to the project."
      >
        <Grid cols="four">
          <Metric label="Source lines" value={fmt(repository?.loc)} note={'main · ' + date(snapshot.repository?.generated_at)} />
          <Metric label="Open issues" value={fmt(efficiency?.open_issues)} note="GitHub snapshot" />
          <Metric label="Open pull requests" value={fmt(efficiency?.open_prs)} note="GitHub snapshot" />
          <Metric label="Observed AI runs · 7 days" value={fmt(agents?.runs_7d)} note="Canonical workflow telemetry" />
        </Grid>
      </Section>
      <Section kicker="WHY NESSION" title="Less infrastructure. More continuity." hint="One product, distributed execution.">
        <Grid cols="three">
          <Empty
            title="One working context"
            text="Move between local machines, remote servers and terminals without turning connection management into your work."
          />
          <Empty
            title="Open engineering"
            text="See issue requirements, code reviews, testing and acceptance evidence instead of a polished success counter."
          />
          <Empty
            title="Agents with provenance"
            text="Explore registered AI roles and observed model runs. Missing measurements stay missing."
          />
        </Grid>
      </Section>
      <Section kicker="NOW BUILDING" title="Follow the work" hint="Links point to the source GitHub Issues and pull requests.">
        {latestIssues.length ? (
          <List>
            {latestIssues.map((issue) => (
              <Entry
                key={issue.number}
                title={'#' + issue.number + '  ' + issue.title}
                subtitle={'Issue · ' + issue.state}
                value="Updated"
                url={issue.url}
                stamp={date(issue.updated_at)}
              />
            ))}
          </List>
        ) : (
          <Empty title="No current Issue snapshot" text="GitHub activity could not be verified for this build." />
        )}
      </Section>
      <Section kicker="PRODUCT / DESIGN LAB" title="Try the experience." hint="Working interaction mockups, not production feature claims.">
        <article className="prototype-teaser">
          <div className="prototype-teaser-copy">
            <div className="eyebrow">THE INTERACTIVE PROTOTYPE LIBRARY</div>
            <h3>From a product idea to something you can try.</h3>
            <p>
              Explore scene-first AI interactions, text-native interfaces and the cross-device terminal experience
              without leaving the Nession Pages navigation.
            </p>
            <LocalLink text="Browse interactive prototypes  ↗" path="/prototypes" className="action" />
          </div>
          <div className="prototype-teaser-visual">
            <div className="prototype-teaser-window">
              <span>ness ion / interaction lab</span>
              <div className="prototype-teaser-line" />
              <div className="prototype-teaser-line short" />
              <div className="prototype-teaser-target">Preview the behavior</div>
            </div>
          </div>
        </article>
      </Section>
    </>
  );
}

function LoopStep({index, title, subtitle}: {index: number; title: string; subtitle: string}): ReactElement {
  return (
    <>
      {index ? <div className="loop-arrow">↓</div> : null}
      <div className="loop-step">
        <span className="loop-no">{String(index + 1).padStart(2, '0')}</span>
        <div>
          <strong>{title}</strong>
          <small>{subtitle}</small>
        </div>
      </div>
    </>
  );
}
