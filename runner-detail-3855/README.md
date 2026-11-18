# Runner detail — Resources / Jobs / Logs (#3855)

- Requirement: https://github.com/BestNathan/nession/issues/3855
- Interactive entry: [index.html](index.html). This is a source-aligned static prototype on the shared orphan prototype branch.
- Data and interaction fidelity: **synthetic fixture only**, no GitHub API, no Runner registration/service operations, no live telemetry or Job logs.

## Design question and decision

Keep Runner details as a small Agent-scoped view, not another infrastructure app or Job scheduler.
The existing Session Workspace Agent capability gains a Runners list, Runner detail, and Job pushed detail.
Runner detail: Overview / Jobs / Settings. Selected Job: Steps / Logs. Resources show CPU, RSS, I/O and owned work directory usage with sample time and coverage warning, **never exact per-Job resource attribution**.
GitHub controls scheduling and remains authoritative for job/step status and log content; bounded run/job discovery may produce partial history.

## Interaction paths

1. Default Busy: Overview → All Jobs → select Job → select Step → Logs → search/copy → Back.
2. App widths 390 and 375 use App WorkspacePanel single header/back, no desktop Sidebar; Web widths 1180/1024 use Sidebar + ShellMain + WorkspacePanel + Agent content. Switch back without losing selected Job.
3. Agent link → Runner list → reopen Runner. Settings actions are visibly mock-only; a destructive action shows confirmation.
4. External fixture buttons cover Busy, Idle/Empty, GitHub Offline, Partial metric availability and GitHub API error.
5. Reset reloads all fixture state. The prototype frame uses actual CSS pixel sizing and emits the bubbled np:resize event.

## Source baseline

Current main reviewed: VISION.md, PRINCIPLE.md, docs/design/information-architecture.md, workspace.md, visual-language.md, web/src/product/agent/README.md, WebLayout, AppLayout and generated semantic tokens.
Candidate adds Runner capability *within* Agent context, not an Agent-first global navigation tree. Product DOM has one Web Workspace host and one App page header/back.
CSS is a local visual approximation using semantic --nession-* variables, not a pixel-verified production React/shadcn component render.

## Verification / limitations

- Mock static and state transitions were reviewed in source, but **real Chromium/Playwright was not executed**.
- Pages preview requires main-owned publisher and exact-SHA readback of prototypes/manifest.json. Branch commit alone is not publication proof.
- No production Acceptance/E2E success is implied. Issue SCs remain Pending.
- Browser verification checklist: Web 1180/1024; App 390/375; Web→App→Web; narrow reviewer width scroll both stage edges; Job detail/back; error/partial/empty states; keyboard focus, Escape confirm, Reset.

Out of scope: GitHub authorization policy, job scheduling/dispatch, sandbox, per-Job process instrumentation, unbounded historical indexing or background log streaming.