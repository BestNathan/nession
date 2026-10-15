# Nession Pages

Independent public site for project introduction, AI workflow Agents, repository engineering indicators, active GitHub Issues/PRs, and metadata-only orphan Run Store inventory. See [Issue #1782](https://github.com/BestNathan/nession/issues/1782).

This is **not** the authenticated product Web UI. No product Web components, shared themes/tokens, auth, WebSocket or runtime endpoint is used. The Pages design is authored entirely under \`pages/\`; Node 24 is the only build requirement and there are no npm dependencies.

## Build locally (sanitized / offline-capable)

\`\`\`bash
cd pages
npm test
npm run check
npm run build
# output: pages/dist/
\`\`\`

The build reads \`METRICS_DIR/metrics.json\` and \`METRICS_DIR/agent-metrics.json\` from a read-only, pinned checkout of the canonical \`metrics\` orphan branch. It reads the AI Role/Instance registry from \`automation/agents/registry.json\` in trusted main. With \`GITHUB_TOKEN\`, it additionally queries the GitHub Issues/PRs and orphan ref metadata APIs at **build time**. Only strictly selected public fields are written into \`dist/data/site.json\`.

\`\`\`bash
METRICS_DIR=../metrics-store \
SOURCE_MAIN_SHA=<40-hex-SHA> METRICS_SHA=<40-hex-SHA> \
GITHUB_TOKEN=<read-only-token> node scripts/build.mjs
\`\`\`

If a source is unavailable the snapshot retains \`null\` / \`unavailable\` rather than inventing zero or success. Aggregate tokens and costs are not attributed to individual Agents. Orphan ref presence must not be interpreted as verified append-only protection. All browser links are bounded to the public GitHub repository.

The static UI uses hash navigation (\`#/agents\`, \`#/work\`, etc.) so direct deep links work under the repository's GitHub Pages base path without rewrite rules. Deployment is owned by a **separate, trusted, main-based workflow PR** per \`.github/AGENTS.md\`; it must not build, deploy, or modify \`web/\`.

## Phase 2-A — public source-backed observations

The build-only `agent-metrics.json` source supplies rolling 7-day and 30-day `runs.by_provider` and `runs.by_workflow` counts, and 7-day `runs.by_issue` counts. The versioned public projection includes only bounded, safe category names, observed nonnegative integer counts and source metadata. Missing observations remain `null` / N/A (not an inferred zero). It does **not** establish causal PR↔Agent linkage, exact-SHA Acceptance verdicts, live presence, per-Agent cost or orphan integrity. The independent Pages layout and UI do not depend on product `web/`.

## Phase 2-B1 — public PR HEAD evidence

Recent GitHub Actions Run metadata is fetched **only during the independent Pages build** and validated against exact, same-repository PR HEAD SHA, canonical workflow path/event, positive Run/attempt identity and bounded listing. The Collaboration view reports each canonical CI/E2E **workflow outcome**, never a Success Criterion / Acceptance verdict or an Issue↔PR/Agent causal join. No observed run means Not observed within a 100-run snapshot, not a claim about all history.

## Phase 2-B2 — source-only Issue Timeline PR references

For up to 12 public Issues, the independent Pages build requests GitHub `cross-referenced` Timeline events (bounded 100 events per Issue). A displayed PR must have a canonical same-repository GitHub Issue/PR API and HTML path. Deduplicated and capped at 6 PR links per Issue; a 100-event Timeline is labeled **truncated**, and a failed API fetch **unavailable**. A cross-reference is a GitHub mention/source link, not verified Issue ownership, implementation, Agent provenance, exact PR HEAD or SC Acceptance. Browser code never calls authenticated APIs.
