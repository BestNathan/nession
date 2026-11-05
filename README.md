# Nession Prototypes

**Purpose:** a dedicated, history-isolated branch for **all** clickable design prototypes.

- **Branch:** `prototype` (one shared branch, never one branch per Issue).
- **Directory convention:** `<topic>-<issue-number>/` (one prototype per directory; revisions stay inside that directory).
- **Each prototype:** `index.html` (standalone browser UI), `README.md` (scope, data/behavior fidelity, related Requirement).
- **No runtime coupling:** mock-only assets, never production Web/API, secrets, or live user data.
- **Event-driven publication signal:** the only permitted non-mock file is `.github/workflows/prototype-changed.yml`. It runs on `prototype` pushes with **read-only permissions** and emits a completion signal. No checkout, secrets, deploy privileges, build artifacts, script execution, or direct dispatch. The trusted `main` `Deploy / Public Pages` workflow owns sanitized publishing and HTTPS verification. See [main-owned authoring Skill](https://github.com/BestNathan/nession/blob/main/.claude/skills/nession-prototype/SKILL.md).
- **Links from Requirements:** use a pin to the exact **prototype commit SHA**, and move the link when the design changes.
- **Hosting:** the main-owned `Deploy / Public Pages` pipeline publishes an inert, sanitized static copy from the pinned `prototype` SHA at [Nession Pages / Prototypes](https://bestnathan.github.io/nession/prototypes/) when the main Pages workflow receives the unprivileged push signal (or its scheduled/manual triggers). A direct preview is `https://bestnathan.github.io/nession/prototypes/<topic>-<issue-number>/index.html`. These links are only confirmed live after exact HTTPS readback; do not confuse a source browser with a rendered preview.
- **Source:** keep the separate GitHub URL `https://github.com/BestNathan/nession/blob/<published-sha>/<topic>-<issue-number>/index.html` for exact provenance. Preview pages expose this with **View source**.
- **Timing:** prototype pushes start a read-only Change Signal workflow; main's trusted Pages workflow publishes when it completes successfully. Commits made with GitHub Actions' default `GITHUB_TOKEN` are not guaranteed to trigger downstream workflows; use an approved writer identity. Always check the published `prototypes/manifest.json` SHA before claiming a refreshed preview.
- **Evidence:** mock HTML is design discussion material, **not Acceptance evidence**.

## Catalog

| Shared Prototype Page Kit (review-frame components, three regions) | [#2758](https://github.com/BestNathan/nession/issues/2758) | [Interactive HTML](prototype-frame-2758/index.html) · [Reusable CSS](prototype-frame-2758/frame.css) · [Behavior](prototype-frame-2758/frame.js) |

| Prototype | Requirement | HTML |
|---|---|---|
| Files Workspace / source-aware selection, creation and safe edit | [#2751](https://github.com/BestNathan/nession/issues/2751) | [Interactive HTML](files-workspace-2751/index.html) · [Scenario & fidelity](files-workspace-2751/README.md) |
| AI Workspace (Progressive Action Space + Pending Goal + Jev mock) | [#2221](https://github.com/BestNathan/nession/issues/2221) | [Interactive HTML](ai-workspace-2221/index.html) · [Protocol](ai-workspace-2221/PROTOCOL.md) |

| AI Conversation (Text → business component → Text) | [#2254](https://github.com/BestNathan/nession/issues/2254) | [Interactive HTML](ai-conversation-2254/index.html) · [Protocol](ai-conversation-2254/PROTOCOL.md) |
| Fixed-column Terminal / real CSS font-size simulator | [#2487](https://github.com/BestNathan/nession/issues/2487) | [Interactive HTML](terminal-fixed-cols-2487/index.html) · [Scenario & fidelity](terminal-fixed-cols-2487/README.md) |
| Terminal Clipboard Protocols / transient permission & unsupported states | [#2598](https://github.com/BestNathan/nession/issues/2598) | [Interactive HTML](terminal-clipboard-2598/index.html) · [Scenario & fidelity](terminal-clipboard-2598/README.md) |

| Agent Workspace / current-Session process tree + collapsible, grouped Agent/Process details | [#2514](https://github.com/BestNathan/nession/issues/2514) | [Interactive HTML](agent-process-discovery-2514/index.html) · [Scenario & fidelity](agent-process-discovery-2514/README.md) |

| Session Environment Workspace / ordered binding, prompt convergence | [#2654](https://github.com/BestNathan/nession/issues/2654) | [Interactive HTML](environment-session-2654/index.html) · [Scenario & fidelity](environment-session-2654/README.md) |
| Git capability / GitHub repository context | [#1290](https://github.com/BestNathan/nession/issues/1290) | [Interactive HTML](git-github-1290/index.html) · [Scenario & fidelity](git-github-1290/README.md) |

| Mobile Terminal long-press arrow gesture | [#2657](https://github.com/BestNathan/nession/issues/2657) | [Interactive HTML](terminal-direction-2657/index.html) · [Scenario & fidelity](terminal-direction-2657/README.md) |

| Public Knowledge Explorer / topic, article, evidence and global changelog | [#2664](https://github.com/BestNathan/nession/issues/2664) | [Interactive HTML](pages-knowledge-2664/index.html) · [Scenario & fidelity](pages-knowledge-2664/README.md) |

| Claude Code Auto Memory / Session-context Markdown reader, Frontmatter and index-linked navigation | [#2689](https://github.com/BestNathan/nession/issues/2689) · [#2742](https://github.com/BestNathan/nession/issues/2742) | [Interactive HTML](claude-memory-2689/index.html) · [Scenario & fidelity](claude-memory-2689/README.md) |

| Mobile Terminal Keys / Quick Commands (chords, Insert vs Run) | [#2710](https://github.com/BestNathan/nession/issues/2710) | [Interactive HTML](terminal-keys-commands-2710/index.html) · [Scenario & fidelity](terminal-keys-commands-2710/README.md) |

| Mobile App Swipe / edge navigation & gesture ownership | [#2724](https://github.com/BestNathan/nession/issues/2724) | [Interactive HTML](mobile-swipe-2724/index.html) · [Scenario & fidelity](mobile-swipe-2724/README.md) |

Do not add more `prototypes/<topic>` branches. Add another sibling directory here.
