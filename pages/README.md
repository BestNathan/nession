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
