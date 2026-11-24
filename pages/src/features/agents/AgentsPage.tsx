import type {ReactElement} from 'react';
import type {SiteSnapshot} from '../../data/types.ts';
import type {AgentOutcomeItem, AgentOutcomeWindow} from '../../data/types.ts';
import {date, duration, fmt, pct} from '../../lib/format.ts';
import {LocalLink} from '../../components/Links.tsx';
import {Callout, Empty, Entry, Grid, Hint, List, Metric, PageHead, Section} from '../../components/Primitives.tsx';
import {agentDetailPath, agentSelection, type AgentMatch, type AgentPeriod} from '../../app/router.ts';

export function agentOutcomeSummary(agent: AgentOutcomeItem | undefined, legacyCount: number | null = null): string {
  if (!agent) return legacyCount === null ? 'Not observed' : fmt(legacyCount) + ' runs · outcome unavailable';
  return fmt(agent.total) + ' runs · ' + fmt(agent.success) + ' succeeded · ' + fmt(agent.failure) + ' failed';
}

function AgentPeriodLinks({
  pathFor,
  period,
}: {
  pathFor: (period: AgentPeriod) => string;
  period: AgentPeriod;
}): ReactElement {
  return (
    <div className="agent-periods">
      {(['7d', '30d'] as const).map((candidate) => (
        <LocalLink
          key={candidate}
          text={candidate === '7d' ? 'Last 7 days' : 'Last 30 days'}
          path={pathFor(candidate)}
          className={'agent-period' + (candidate === period ? ' active' : '')}
        />
      ))}
    </div>
  );
}

export function AgentsPage({snapshot, hash}: {snapshot: SiteSnapshot; hash: string}): ReactElement {
  const agents = snapshot.agents || {};
  const summary = agents.summary || {};
  const period = agentSelection(hash).period;
  const distribution = agents.distribution || {};
  const outcome: AgentOutcomeWindow = agents.outcomes?.[period] || {status: 'unavailable', items: [], unattributed: null};
  const known = new Set((agents.roster || []).map((agent) => agent.role + ':' + agent.id));
  const roster = [
    ...(agents.roster || []),
    ...(outcome.items || [])
      .filter((agent) => !known.has(agent.role + ':' + agent.id))
      .map((agent) => ({role: agent.role, id: agent.id, provider: 'Source-attested', observed_7d: null})),
  ];

  const panelFor = (title: string, key: 'providers' | 'workflows'): ReactElement => {
    const window7 = distribution['7d']?.[key];
    const window30 = distribution['30d']?.[key];
    if (!window7?.available && !window30?.available) {
      return (
        <article className="panel">
          <h3>{title}</h3>
          <p>Breakdown unavailable for these windows.</p>
        </article>
      );
    }
    const names = [
      ...new Set([...(window7?.items || []), ...(window30?.items || [])].map((item) => item.name)),
    ].slice(0, 12);
    const counts = (source: typeof window7, name: string): number | undefined =>
      source?.items?.find((item) => item.name === name)?.count;
    const rows = names.map((name) => (
      <Entry
        key={name}
        title={name}
        subtitle={'Canonical ' + title.toLowerCase() + ' aggregation'}
        value={fmt(counts(window7, name)) + ' / ' + fmt(counts(window30, name))}
        stamp="runs · 7d / 30d"
      />
    ));
    return (
      <article className="panel">
        <h3>{title}</h3>
        {rows.length ? <List>{rows}</List> : <p>No valid observations in these source windows.</p>}
      </article>
    );
  };

  return (
    <>
      <PageHead
        kicker="THE AI TEAM"
        title="The agents behind the work."
        description="Registered workflow Agents are not the Nession runtime node Agents. A role can exist without a successful run; usage is shown only where actually observed."
      />
      <Hint>
        {'Agent metrics source: ' +
          (agents.freshness?.state || 'unavailable') +
          ' · measured ' +
          date(agents.generated_at) +
          ' · site built ' +
          date(snapshot.generated_at)}
      </Hint>
      <Section kicker="OBSERVED USAGE" title="Work in numbers" hint="7-day window · missing measurements are N/A, not zero.">
        <Grid cols="three">
          <Metric label="Agent runs" value={fmt(summary.runs_7d)} note="workflow summary" />
          <Metric
            label="Tokens"
            value={fmt(summary.tokens_7d)}
            note={'observed ' + fmt(summary.tokens_observed_runs) + ' runs'}
          />
          <Metric
            label="Agent duration"
            value={duration(summary.duration_7d)}
            note={'avg ' + duration(summary.duration_avg_7d) + ' · observed ' + fmt(summary.duration_observed_runs) + ' runs'}
          />
          <Metric
            label="Tool calls"
            value={fmt(summary.tools_7d)}
            note={'observed ' + fmt(summary.tools_observed_runs) + ' runs'}
          />
          <Metric
            label="Cost in USD"
            value={summary.cost_7d === null || summary.cost_7d === undefined ? 'Unobserved' : '$' + fmt(summary.cost_7d)}
            note={'observed ' + fmt(summary.cost_observed_runs) + ' runs · no estimation'}
          />
        </Grid>
      </Section>
      <Section
        kicker="OBSERVED TIME WINDOWS"
        title="7 days and 30 days"
        hint={
          'Canonical workflow totals · generated ' +
          date(agents.generated_at) +
          ' · metrics revision ' +
          (snapshot.source?.metrics_sha?.slice(0, 12) || 'unavailable')
        }
      >
        <Grid cols="two">
          <Metric label="7-day runs" value={fmt(summary.runs_7d)} note="observed workflow runs" />
          <Metric label="30-day runs" value={fmt(summary.runs_30d)} note="observed workflow runs" />
        </Grid>
      </Section>
      <Section
        kicker="SOURCE AGGREGATES"
        title="Who ran the work"
        hint="By provider and workflow. Counts are measured totals, not individual Agent costs, real-time presence or success verdicts."
      >
        <Grid cols="two">
          {panelFor('Providers', 'providers')}
          {panelFor('Workflows', 'workflows')}
        </Grid>
      </Section>
      <Section
        kicker="PER-AGENT EXECUTIONS"
        title="Execution by Agent"
        hint={'Observed ' + period + ' · counts reflect Agent outcomes, not Workflow or SC verdicts.'}
      >
        <AgentPeriodLinks pathFor={(candidate) => '/agents' + (candidate === '30d' ? '?window=30d' : '')} period={period} />
        {roster.length ? (
          <List>
            {roster.map((agent) => {
              const stats = outcome.items?.find((item) => item.id === agent.id && item.role === agent.role);
              const legacyCount = period === '7d' ? agent.observed_7d ?? null : null;
              return (
                <article className="entry" key={agent.role + ':' + agent.id}>
                  <div className="entry-main">
                    <LocalLink
                      text={agent.id}
                      path={'/agents/' + agent.role + '/' + agent.id + (period === '30d' ? '?window=30d' : '')}
                      className="entry-title"
                    />
                    <small>{agent.role + ' · ' + String(agent.provider)}</small>
                  </div>
                  <div className="entry-right">
                    <strong>{agentOutcomeSummary(stats, legacyCount)}</strong>
                    <span>
                      {stats
                        ? 'Other / unknown: ' + fmt(stats.cancelled + stats.timed_out + stats.unknown)
                        : legacyCount === null
                          ? 'No observed identity in this window'
                          : 'Outcome breakdown unavailable for this source'}
                    </span>
                  </div>
                </article>
              );
            })}
          </List>
        ) : (
          <Empty title="No Agent registry" text="There are no registered or source-attested Agents in this snapshot." />
        )}
      </Section>
      <Hint>
        {'Per-Agent coverage: ' +
          (outcome.status || 'unavailable') +
          ' · unattributed executions: ' +
          fmt(outcome.unattributed) +
          '. Missing identities are never assigned to a role by Workflow name; missing measurements are not zero.'}
      </Hint>
      <Callout>
        Execution success is not a GitHub Workflow success or an Acceptance SC Pass. Recent Runs are bounded observations;
        raw prompts, failures and Provider sessions remain private.
      </Callout>
    </>
  );
}

export function AgentDetailPage({
  snapshot,
  hash,
  match,
}: {
  snapshot: SiteSnapshot;
  hash: string;
  match: AgentMatch;
}): ReactElement {
  const selection = agentSelection(hash);
  const period = selection.period;
  const agents = snapshot.agents || {};
  const window = agents.outcomes?.[period];
  const registered = (agents.roster || []).find((agent) => agent.id === match.id && agent.role === match.role);
  const actual = window?.items?.find((agent) => agent.id === match.id && agent.role === match.role);
  const back = (
    <LocalLink text="← AI Agents" path={'/agents' + (period === '30d' ? '?window=30d' : '')} className="back-link" />
  );
  if (!registered && !actual) {
    return (
      <>
        {back}
        <Empty
          title="Agent identity not observed"
          text="No matching registered or source-attested Agent exists in this public snapshot."
        />
      </>
    );
  }
  const records = (actual?.recent || []).filter(
    (run) => !selection.outcome || run.outcome === selection.outcome,
  );
  return (
    <>
      {back}
      <PageHead
        kicker="AGENT EXECUTION"
        title={match.id}
        description={
          'Role: ' +
          match.role +
          ' · Registered provider: ' +
          (registered?.provider || 'Unregistered') +
          ' · GitHub Workflow Agent; not a Nession runtime node.'
        }
      />
      <Hint>
        {'Source: ' +
          (agents.freshness?.state || 'unavailable') +
          ' · measured ' +
          date(agents.generated_at) +
          ' · metrics revision ' +
          (snapshot.source?.metrics_sha?.slice(0, 12) || 'unavailable') +
          ' · coverage ' +
          (window?.status || 'unavailable')}
      </Hint>
      <AgentPeriodLinks pathFor={(candidate) => agentDetailPath(match.role, match.id, candidate)} period={period} />
      <Section
        kicker="EXECUTION OUTCOMES"
        title={'Observed ' + period + ' runs'}
        hint="Agent execution results, not GitHub workflow/Acceptance verdicts."
      >
        <Grid cols="two">
          <Metric label="Runs" value={fmt(actual?.total ?? null)} note="Source-observed attempts" />
          <Metric label="Succeeded" value={fmt(actual?.success ?? null)} note="Completed execution" />
          <Metric label="Failed" value={fmt(actual?.failure ?? null)} note="Agent execution failure" />
          <Metric
            label="Success rate"
            value={
              actual && actual.success + actual.failure > 0
                ? pct(actual.success / (actual.success + actual.failure))
                : 'N/A'
            }
            note="Succeeded / (succeeded + failed)"
          />
        </Grid>
      </Section>
      <Section
        kicker="RUN HISTORY"
        title="Recent executions"
        hint="A bounded sample of at most 8 source-attested attempts; open GitHub Actions for details."
      >
        <div className="agent-periods">
          {([null, 'success', 'failure', 'cancelled', 'timed_out', 'unknown'] as const).map((result) => (
            <LocalLink
              key={result || 'all'}
              text={result || 'All'}
              path={agentDetailPath(match.role, match.id, period, result)}
              className={'agent-period' + (selection.outcome === result ? ' active' : '')}
            />
          ))}
        </div>
        {records.length ? (
          <List>
            {records.map((run) => (
              <Entry
                key={run.run_id + ':' + run.attempt}
                title={'Run ' + run.run_id + ' / attempt ' + run.attempt}
                subtitle={
                  run.workflow +
                  ' · ' +
                  run.outcome +
                  ' · ' +
                  run.provider +
                  (run.issue ? ' · Issue #' + run.issue : ' · Issue unlinked')
                }
                value={duration(run.duration_ms)}
                url={run.url}
                stamp={date(run.observed_at)}
              />
            ))}
          </List>
        ) : (
          <Empty
            title={actual ? 'No matching observed attempts' : 'Run source unavailable'}
            text={
              actual
                ? 'No matching Run in this bounded recent sample.'
                : 'A registered Agent without source records is not an observed zero.'
            }
          />
        )}
      </Section>
      <Hint>
        {'Other outcomes: ' +
          fmt(actual?.cancelled ?? null) +
          ' cancelled · ' +
          fmt(actual?.timed_out ?? null) +
          ' timed out · ' +
          fmt(actual?.unknown ?? null) +
          ' unknown. The recent list is sampled; totals cover the observed ' +
          period +
          ' window.'}
      </Hint>
    </>
  );
}
