# Fixed-column terminal sizing (#2487)

> Requirement: [GitHub #2487](https://github.com/BestNathan/nession/issues/2487).
> Supersedes **only** the dynamic-column rule of [#2286](https://github.com/BestNathan/nession/issues/2286).
> Its active-device ControlLease, generation fencing, authoritative resize
> timeline, ordered parser writer and P2P/Relay parity remain in force
> ([multi-client-ownership.md](multi-client-ownership.md),
> [interaction-semantics.md](interaction-semantics.md)).

Nession is one persistent tmux Session used sequentially on desktop and phone.
A Session has **one fixed logical column count**. What adapts per device is the
**rendered font size**, the **terminal content width**, and the **number of
rows**. The width never follows a viewport.

## The sizing rule

For one live Session:

- **Columns** are canonical. A viewport resize, sidebar change, orientation
  change, keyboard appearance, transport swap or controller handoff does not
  change them.
- **Rows** are `floor(usableHeight / measuredCellHeight)`, recomputed for the
  active Controller's usable height (capsule band and safe-area padding
  excluded). Only rows are sent with the Session's columns in an authorized
  resize.
- **Font size** is the largest size, up to the Web maximum (or the App/device
  token for mobile), whose **measured xterm cell** lets exactly the canonical
  columns fit the terminal content box. A narrower viewport shrinks the glyphs;
  it does not drop columns or stretch glyphs. There is no CSS
  `transform: scale()`: cell coordinates, selection and touch mapping must stay
  those of the rendered grid.
- **Content width** is `cols × measured cell width`. On a wide Web window
  (≥1024px) the terminal is capped and centred at that width; unused space is
  padding, not a wider grid. Below that breakpoint the capped grid is left
  aligned at the owned inset, so the shell's edge-swipe band still reaches the
  surface (#1081) instead of being pushed inward by centring. Owned horizontal
  insets remain part of the terminal host.

The measured cell comes from xterm's own renderer (including DPR and the
finally-loaded JetBrains Mono face), never from `fontSize × 0.6`. A late font
load re-fits the grid and recomputes rows before the first authoritative report.

## Authority and compatibility

| Layer | Owns | Does not own |
|---|---|---|
| Release parameter | The value embedded in `web/dist` and written to Server/Agent runtime configuration | A live Session's width |
| Web/App bundle | Font fitting, content-width cap, rows, rendering the Server/Session value | Per-client columns |
| Server | Validating its configured value; stating it on relay attach and create; exposing it in `server.info` | Resizing an Agent-owned pane |
| Agent | The tmux pane and the Session's authoritative width; clamping every resize; stating the width on attach | A per-client viewport |
| tmux | The actual pane geometry (`stty size`) | Nession policy |

- A **new** Session is created at the release-selected width. In a central
  deployment the Server states that value on its relayed create/attach and the
  Agent validates it; a direct or standalone caller falls back to the Agent's
  own configuration. The Agent applies that geometry explicitly after
  `new-session` and restores tmux's dynamic `window-size` policy: on tmux 3.4 a
  client attached to another Session otherwise sizes a newly created Session to
  its own terminal (#2520). Only the authorized resize path changes rows
  afterwards.
- An **existing** Session keeps the width its pane already has. Attaching never
  resizes the shared window to a client's build value. The Agent ignores the
  columns on `agent.terminal.resize` and applies only the requested rows, then
  fans out the size it actually applied. A client whose embedded value differs
  adopts that width for its local grid instead of reflowing the Session.
- A client from a build with a different embedded column count therefore sees
  the Session's grid, not a divergent one. An Agent predating the
  `terminal_cols` reply field is still safe: it ignores client columns too, and
  the client keeps its own build value as the initial grid.
- Changing a release default or a GitHub Variable changes **newly built
  artifacts and new Sessions**. It does not rewrite a running Session; a
  deployment does not silently reflow live panes. Reconfiguring an existing
  Session is an explicit operator action (for example, recreating it), not an
  attach side effect.
- **Standalone Agent:** the Agent is the PTY owner and reads the same
  `NESSION_TERMINAL_COLS` name from its own environment/config, so it never
  depends on a Server-only variable. It applies that width when it creates a
  Session and keeps an existing pane's width.

The ControlLease remains the authorization boundary: only the Controller may
send a resize, a stale generation is refused by name, and the applied resize is
recorded in the ordered stream so an observer cannot be dragged sideways by a
delayed frame. The only policy change here is the value applied for columns.

## Configuration pipeline

One release-level source, two kinds of destination:

```text
GitHub Variables (or approved defaults)
  ├─ VITE_NESSION_TERMINAL_COLS / VITE_NESSION_TERMINAL_WEB_FONT_SIZE
  │    → web/dist (validated by the Vite config; invalid input fails the build)
  └─ NESSION_TERMINAL_COLS / NESSION_TERMINAL_WEB_FONT_SIZE
       → Docker image ENV (build ARG recorded in image identity)
       → deploy/entrypoint-server.sh → /etc/nession/config.toml
       → ServerConfig → validation at startup → attach/create/info
       → deploy/entrypoint-agent.sh → agent-config.toml → Agent creation width
```

| Knob | Scope | Default | Meaning |
|---|---|---|---|
| `NESSION_TERMINAL_COLS` | Release / Server / Agent | `96` | Fixed columns for new Sessions |
| `NESSION_TERMINAL_WEB_FONT_SIZE` | Release / Web / Server diagnostics | `14` | Web preferred maximum CSS font size; never a PTY parameter |
| `VITE_NESSION_TERMINAL_COLS` | Web/App bundle | `96` | Inlined canonical columns |
| `VITE_NESSION_TERMINAL_WEB_FONT_SIZE` | Web bundle | `14` | Inlined Web maximum font |

Rules:

- The values are optional. Omitted values use the versioned defaults above;
  invalid values **fail closed**: the Vite build refuses to produce a bundle,
  and the Server/Agent runtime rejects an out-of-range environment or config
  value at startup.
- `NESSION_TERMINAL_COLS` accepts an integer in `[20, 400]`;
  `NESSION_TERMINAL_WEB_FONT_SIZE` accepts a number in `[6, 32]` CSS px.
- The Web font input changes only the Web maximum. Mobile uses the same
  embedded columns with its device profile as the maximum; there is no mobile
  columns value and no mobile fixed font.
- `web/dist` prints `WEB_TERMINAL_CONFIG_V1 {schema_version, cols,
  web_max_font_size, cols_source, web_font_source}` at build time. These are
  diagnostic values; they are not runtime overrides of an existing Session.
- `server.info` exposes the effective `terminal_cols` and
  `terminal_web_font_size`; a relay attach response states the same values.
  Comparing them with the build line is how a mixed release is detected.
- Staging and production resolve the same GitHub repository Actions Variables
  (`NESSION_TERMINAL_COLS`, `NESSION_TERMINAL_WEB_FONT_SIZE`) as the single
  release configuration source. They share the same approved defaults when
  either variable is absent; the selected values are snapshotted in each
  release artifact and provenance record.
- `deploy/docker-compose.yml` states both variables for local stacks. The
  Server and Agent images carry them as `ENV` set from build arguments, so the
  running container's environment — not only a temporary CI job — holds the
  selected value. GitOps advances the image tag; the image identity is the
  configuration carrier.

### Why 96 is the shipped default

The original #2487 device review selected 80 columns for the narrowest 375 px
phone. The product owner superseded that default with **96 columns** on
2026-10-28 (#2557), prioritizing the selected canonical width over fitting
all columns into the narrowest screen. This changes the release default, not
the fixed-width Session authority or font-fitting algorithm.

- At a 375 px viewport with 347 px of terminal content width, xterm's measured
  cell at the 6 CSS px fit floor can quantize to 4 px. 96 columns then need
  384 px and **cannot all fit**; the defined `overflow-x: auto` fallback applies.
  The earlier 80-column choice needed only 320 px under the same conditions.
- Desktop at the default 14 CSS px and an approximately 8.4 px measured cell
  needs around 806 px for 96 columns. The real width comes from xterm cell
  measurements, not that approximation.
- The release can change the default again only by changing the GitHub
  Variable and rebuilding; existing tmux Sessions retain their own widths.

Changing the default is the build/release parameter described below; it is
not a per-client setting and does not rewrite an existing Session.

## Rendering and accessibility

- The fit floor is **6 CSS px**; the ordinary manual-zoom floor remains 8 px.
  A very narrow content box may therefore show the canonical columns at a
  small font. The terminal is not silently reduced to fewer columns.
- When even the floor cannot fit the columns, the viewport scrolls
  horizontally (`overflow-x: auto`) and the grid publishes
  `data-terminal-cols-fit="false"`. This is the explicit fallback: readable
  cells over a clipped grid, never a different Session width.
- The release's canonical column count is a product decision. Lowering it (for
  readability on small devices) is done by changing the release parameter and
  rebuilding, not by a per-client setting.
- Touch, click-to-cell, selection, scrollback and IME continue to map to the
  rendered xterm cells at the smaller font. xterm owns the interaction model;
  no Web/App input fork is introduced.

## Diagnostics and acceptance

- **Build**: `WEB_TERMINAL_CONFIG_V1` line; invalid input exits non-zero.
- **Server config**: `config.toml` produced by the entrypoint; invalid values
  stop startup before the listener binds.
- **Runtime**: `server.info.terminal_cols`; relay/P2P attach responses;
  Agent `client.attach` reply `terminal_cols`.
- **Pane**: `stty size` (or `tmux display -p '#{window_width}x#{window_height}'`)
  shows the same columns for PC, phone and a reconnect; rows follow the active
  Controller.
- **Acceptance**: Cases SC-01..SC-09 in `e2e/acceptance/cases/2487/` own the
  executable evidence for this document. The interactive simulator remains on
  the shared orphan `prototype` branch (SC-05).

## Owners

- Product/design rule: this document and
  [terminal-surface.md](../design-system/patterns/terminal-surface.md).
- Lease, generations, ordered resize: [multi-client-ownership.md](multi-client-ownership.md).
- Web implementation: `web/src/platform/terminal-runtime/terminalConfig.ts`,
  `sizing.ts`, `controller/TerminalController.ts`.
- Server/Agent configuration: `crates/nession-common/src/config.rs`,
  `crates/nession-agent/src/config.rs`,
  `crates/nession-agent/src/session/registry.rs`.
- Deployment: `deploy/entrypoint-server.sh`, `deploy/entrypoint-agent.sh`,
  `deploy/docker-compose.yml`, the Server/Agent Dockerfiles and the release
  workflows.
