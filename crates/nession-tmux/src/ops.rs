//! The tmux **semantic** boundary: the one place this crate encodes what a
//! reusable tmux *operation* means.
//!
//! [`TmuxCommand`] owns *process addressing* — which binary, which socket, and the
//! `TMUX`/`TMUX_TMPDIR` stripping that keeps a child process from describing
//! some other server. It says nothing about *grammar*, and that gap is not
//! theoretical. One capability (`set-environment`) was written twice: once in
//! `manager.rs`, correctly, and once in `env.rs`, where the copy invented
//! `set-environment -t <session> -e KEY=VALUE`. `-e` is `new-session`'s flag and
//! a joined `KEY=VALUE` is not a variable name, so tmux refused every call,
//! every variable it was asked for went unset, and every caller reported
//! success (#980).
//!
//! So this module owns the operation and its argument vector. Nothing else does:
//!
//! ```text
//! TmuxCommand                                   = process / socket boundary
//! TmuxOps                                       = tmux semantic boundary
//! SessionManager / EnvManager / attach backends = Nession domain boundary
//! ```
//!
//! ## What it deliberately does not offer
//!
//! There is **no `run(args: &[&str])`**. A generic argv runner would leave the
//! grammar with the caller — `-e` would still be writable, just from one more
//! place — and the point of the boundary is that a caller *cannot express* the
//! wrong shape. The operations below take typed parameters and build a private,
//! fixed-arity argument vector, so there is nowhere for `-e` to come from.
//!
//! ## What it deliberately does not decide
//!
//! Result *policy* belongs to the caller, because it is a property of the call
//! and not of the operation. The same `set-environment` is `Required` when a
//! user asked for those variables ([`EnvManager::set_environment`]) and
//! `BestEffort` when it propagates an environment an earlier stage already
//! established to windows that do not exist yet
//! ([`SessionManager::create_session`](super::manager::SessionManager)). So
//! every operation here returns its failure and none of them swallows one; a
//! caller choosing `BestEffort` has to say so, and it says it in its own code
//! where a reader can see it.
//!
//! ## What is deliberately not here: control-mode command lines
//!
//! `control.rs` writes `send-keys … -H <hex>` and `resize-window …` to an
//! attached control-mode client's **stdin** rather than spawning anything. That
//! is tmux grammar too, and it is a *different operation* from the argv
//! [`TmuxOps::send_keys`] below — different flag, different payload encoding
//! (raw bytes rather than key names), different transport. It cannot become an
//! operation here as things stand either, because an operation's one guarantee
//! is that it returns the failure it caused, and that transport has no failure
//! to return: nothing is spawned, so there is no exit status, no stderr, and
//! tmux's answer to a bad line arrives asynchronously on the same pipe the
//! output comes back on. One `send_keys` covering both would be one name for
//! two incompatible result semantics. It is also the same shape as
//! `resize-window`, which #991 assigns to its step 8 — so that transport's seam
//! gets designed once both shapes are known, not from the first of them.
//!
//! [`TmuxCommand`]: crate::process::TmuxCommand
//! [`EnvManager::set_environment`]: super::env::EnvManager::set_environment

use anyhow::{Context, Result};

use crate::process::TmuxCommand;

/// tmux's own words for "this session does not hold that variable".
///
/// `show-environment <name>` exits 1 both when the variable is unset and when
/// the session does not exist — measured on tmux 3.6b, both messages on stderr:
///
/// ```text
/// $ tmux -S <sock> show-environment -t probe NESSION_MISSING
/// unknown variable: NESSION_MISSING                            (exit 1)
/// $ tmux -S <sock> show-environment -t nope NESSION_A
/// no such session: nope                                        (exit 1)
/// ```
///
/// The exit status alone therefore cannot tell "it is not there" from "I could
/// not look", and only this message separates them. Matching on tmux's wording
/// is a cost, paid in the safe direction: a later tmux that rewords it turns the
/// answer into an `Err` — loud — instead of a `None` claiming a variable is
/// unset when nobody managed to ask.
const UNKNOWN_VARIABLE: &str = "unknown variable";

/// The argument vector for one `set-environment`, in the order tmux receives it.
///
/// Both halves of #980 are properties of this array and of nothing else:
///
/// - there is no `-e`. That flag belongs to `new-session`; `set-environment`
///   answers `unknown flag -e` (exit 1, measured on tmux 3.6b).
/// - `name` and `value` are **two entries**. `set-environment` takes
///   `name [value]`, so a joined `KEY=VALUE` is not a variable name at all:
///   tmux answers `variable name contains =` (exit 1, measured).
///
/// Separate entries are also what keeps a value intact: one containing spaces,
/// quotes or `=` arrives as the single argv value the caller passed, and nothing
/// here reconstructs it into `KEY=VALUE`. Measured on tmux 3.6b: a value of `-x`
/// is taken as the value and not as a flag, because the argument parser stops
/// reading flags at the first non-flag argument (`name`).
///
/// The arity is part of the type — a sixth entry cannot be appended without
/// changing this signature.
fn set_environment_args<'a>(session: &'a str, name: &'a str, value: &'a str) -> [&'a str; 5] {
    ["set-environment", "-t", session, name, value]
}

/// The argument vector for one `show-environment`.
///
/// `show-environment [-g] [-h] [-s] [-t target-session] name` — one `name`, and
/// `-t` is what binds the answer to the session that was asked about. It is not
/// decoration: measured on tmux 3.6b with two sessions on one socket, a
/// target-less query answered out of a session the caller never named, and
/// reported `unknown variable` for a variable the other one held.
fn show_environment_args<'a>(session: &'a str, name: &'a str) -> [&'a str; 4] {
    ["show-environment", "-t", session, name]
}

/// The value half of the one `NAME=VALUE` line `show-environment` prints.
///
/// `split_once` rather than a split on every `=`: tmux prints the variable name
/// and then whatever the value holds, and a value may contain `=`. tmux
/// constructs the line, so nothing here reconstructs `KEY=VALUE` either.
///
/// `None` when the line holds no `=` at all — tmux answered successfully with
/// something that is not the line it documents.
fn value_from_line(line: &str) -> Option<String> {
    line.split_once('=').map(|(_, value)| value.to_string())
}

/// The format the window-size query asks tmux for.
///
/// Both dimensions in one format, because they are one round trip either way
/// and two queries could answer out of two different moments — a window
/// resized in between would report a width and a height that never coexisted.
/// It is a const so a caller cannot ask for half a size.
const WINDOW_SIZE_FORMAT: &str = "#{window_width} #{window_height}";

/// The argument vector for one window-size query.
///
/// `display-message [-p] [-t target-pane] [format]`. `-p` is what makes tmux
/// print the expansion to stdout instead of writing it into a status line, and
/// `-t` is what binds the answer to the session that was asked about — without
/// it tmux resolves a target of its own choosing (measured on 3.6b: with two
/// sessions on one socket, a target-less query answered out of one the caller
/// never named).
///
/// The arity is part of the type, like [`set_environment_args`]'s: a second
/// format entry cannot be appended without changing this signature.
fn window_size_args(session: &str) -> [&str; 5] {
    ["display-message", "-p", "-t", session, WINDOW_SIZE_FORMAT]
}

/// Parse the `"<cols> <rows>"` line [`TmuxOps::window_size`] asks for.
///
/// Whitespace-separated rather than a fixed split, because that is what tmux's
/// word is: it prints the two numbers and a newline. Extra trailing fields are
/// ignored, and a missing or unparseable dimension is an error rather than a
/// default — a call site that wants a default has to supply one, which is how
/// `capture_scrollback`'s 80×24 stays visible in `util.rs` beside the call it
/// belongs to.
fn size_from_line(line: &str) -> Result<(u16, u16)> {
    let mut parts = line.split_whitespace();
    let cols = parts
        .next()
        .with_context(|| format!("no width in {line:?}"))?
        .parse::<u16>()
        .with_context(|| format!("width in {line:?} is not a number"))?;
    let rows = parts
        .next()
        .with_context(|| format!("no height in {line:?}"))?
        .parse::<u16>()
        .with_context(|| format!("height in {line:?} is not a number"))?;
    Ok((cols, rows))
}

/// The pane's terminal modes, as tmux reports them (#1096 criterion 13).
///
/// **Why tmux is asked rather than tracked.** The modes belong to the pane's
/// terminal, and tmux is the thing that owns it: it keeps these flags so that
/// *it* can redraw, and it exposes them as format variables. An agent that
/// scanned the output stream for `CSI ? … h` instead would be re-deriving state
/// its own tmux already holds, and would get it wrong exactly where the stream
/// is lossy — a resumed control connection, a chunk boundary inside a sequence,
/// output produced before the agent attached.
///
/// Field order is the [`PANE_MODE_FORMAT`] order and is not alphabetical: it
/// follows the DEC private modes the escapes below are spelled in, so a reader
/// can hold both in their head at once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct PaneModeFlags {
    /// `?1` — application cursor keys. The one criterion 13 is named for.
    pub keypad_cursor: bool,
    /// `?1049` — the alternate screen.
    pub alternate: bool,
    /// `?6` — cursor addressing relative to the scroll region.
    pub origin: bool,
    /// `?7` — autowrap. On by default, so its *off* state is the interesting one.
    pub wrap: bool,
    /// `?25` — cursor visible.
    pub cursor_visible: bool,
    /// `?4` — insert mode (IRM). The one flag here that is not a DEC private
    /// mode; it is spelled `CSI 4 h`, not `CSI ? 4 h`.
    pub insert: bool,
    /// `?1000` — report button press and release.
    pub mouse_standard: bool,
    /// `?1002` — report button events, including drags.
    pub mouse_button: bool,
    /// `?1003` — report every pointer move.
    pub mouse_all: bool,
    /// `?1006` — SGR-encoded coordinates, a modifier of whichever of the three
    /// above is on rather than a reporting mode of its own.
    pub mouse_sgr: bool,
    /// `?1005` — UTF-8-encoded coordinates. Deprecated by xterm in favour of
    /// `?1006`, and still requested by applications in the wild.
    pub mouse_utf8: bool,
    /// `ESC =` — application keypad (DECKPAM). Not a CSI private mode at all,
    /// which is why it is last and spelled differently below.
    pub keypad: bool,
}

/// The format string one pane-mode query asks for, field for field in
/// [`PaneModeFlags`]' order.
///
/// A single const so the query and the parse cannot disagree about how many
/// fields there are or what they mean — [`pane_mode_flags_from_line`] checks
/// the count against this string rather than against a number written twice.
const PANE_MODE_FORMAT: &str = concat!(
    "#{keypad_cursor_flag} ",
    "#{alternate_on} ",
    "#{origin_flag} ",
    "#{wrap_flag} ",
    "#{cursor_flag} ",
    "#{insert_flag} ",
    "#{mouse_standard_flag} ",
    "#{mouse_button_flag} ",
    "#{mouse_all_flag} ",
    "#{mouse_sgr_flag} ",
    "#{mouse_utf8_flag} ",
    "#{keypad_flag}",
);

/// How many fields [`PANE_MODE_FORMAT`] expands to.
fn pane_mode_field_count() -> usize {
    PANE_MODE_FORMAT.split_whitespace().count()
}

/// The argument vector for one pane-mode query, shaped like
/// [`window_size_args`] and for the same reasons: `-p` prints instead of
/// writing a status line, `-t` binds the answer to the session that was asked
/// about, and the arity is in the type so a second format cannot be appended.
fn pane_mode_args(session: &str) -> [&str; 5] {
    ["display-message", "-p", "-t", session, PANE_MODE_FORMAT]
}

/// The pane cursor's position, as tmux reports it (#2464).
///
/// A screen capture restores the pane's *text* and [`PaneModeFlags`] restores
/// the *modes*, but neither carries where the cursor was left. A pane whose
/// application moved to an empty row and paused has a cursor that is not at
/// the end of the last written line, and a client that reconstructs the text
/// without it writes the next live byte at the wrong row/column.
///
/// `cursor_x`/`cursor_y` are zero-based and relative to the top-left of the
/// visible pane. `pane_height` comes with them because the caller has to tell
/// a cursor parked below the last written row (#2464's empty-row case) from a
/// cursor that is simply on the last row: the number of blank rows between the
/// text and the cursor is a function of the pane's height, and the capture it
/// is applied to also carries scrollback above the visible pane and
/// `-J`-joined wrapped lines that a bare row index would count as lines.
///
/// They are read with the same one-line format discipline as the modes: an
/// unknown target prints an empty line and exits 0, so the parse is what tells
/// "no answer" apart from "cursor at 0 0".
const PANE_CURSOR_FORMAT: &str = "#{cursor_x} #{cursor_y} #{pane_height}";

fn pane_cursor_args(session: &str) -> [&str; 5] {
    ["display-message", "-p", "-t", session, PANE_CURSOR_FORMAT]
}

/// Parse the cursor line [`TmuxOps::pane_cursor`] asks for.
///
/// Exactly three non-negative integers: a short or padded answer is a tmux this
/// code cannot trust the position from, and guessing one would recreate the
/// drift the query exists to remove.
fn pane_cursor_from_line(line: &str) -> Result<(u16, u16, u16)> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    let [x, y, height] = fields.as_slice() else {
        anyhow::bail!(
            "expected 3 pane cursor fields, got {}: {line:?}",
            fields.len()
        );
    };
    let x = x
        .parse::<u16>()
        .with_context(|| format!("cursor_x in {line:?} is not a number"))?;
    let y = y
        .parse::<u16>()
        .with_context(|| format!("cursor_y in {line:?} is not a number"))?;
    let height = height
        .parse::<u16>()
        .with_context(|| format!("pane_height in {line:?} is not a number"))?;
    Ok((x, y, height))
}

/// Parse the flags line [`TmuxOps::pane_mode_flags`] asks for.
///
/// **Every field is checked, and a wrong count is an error.** tmux expands a
/// format variable it does not know to nothing, and it exits 0 with an empty
/// line for a target that does not exist — so a short line means "this tmux
/// could not answer", not "these modes are off". Reading it as the latter would
/// silently restore nothing, which is the failure this whole op exists to fix.
///
/// `0` and `1` are the only values tmux produces for a flag. Anything else is
/// treated the same way as a missing field: an answer this code does not
/// understand is not one to act on.
fn pane_mode_flags_from_line(line: &str) -> Result<PaneModeFlags> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() != pane_mode_field_count() {
        anyhow::bail!(
            "expected {} pane mode flags, got {}: {line:?}",
            pane_mode_field_count(),
            fields.len()
        );
    }
    // One closure over the fields, so each named field below reads as the
    // position it is — the count check above makes the `None` arm unreachable,
    // and it is an error rather than a default anyway: a flag this code did not
    // receive is not a flag that is off.
    let mut bits = fields.iter().copied();
    let mut next = || -> Result<bool> {
        match bits.next() {
            Some("0") => Ok(false),
            Some("1") => Ok(true),
            Some(other) => Err(anyhow::anyhow!(
                "pane mode flag is neither 0 nor 1: {other:?}"
            )),
            None => Err(anyhow::anyhow!("pane mode flags ended early")),
        }
    };
    Ok(PaneModeFlags {
        keypad_cursor: next()?,
        alternate: next()?,
        origin: next()?,
        wrap: next()?,
        cursor_visible: next()?,
        insert: next()?,
        mouse_standard: next()?,
        mouse_button: next()?,
        mouse_all: next()?,
        mouse_sgr: next()?,
        mouse_utf8: next()?,
        keypad: next()?,
    })
}

/// The argument vector for resizing a session's window:
/// `resize-window -t <session> -x <cols> -y <rows>`.
///
/// The **spawned** form of this operation, and the reason it is an operation
/// rather than a caller-supplied vector: `util.rs` used to expose
/// `run_tmux_command(session, args: &[&str])` for this one call, which is the
/// `run(args)` shape #991 rules out — a caller that supplies the vector can
/// encode a subcommand with the wrong flags, or drop the target, and nothing
/// catches it. Here `-t` is in the vector and both dimensions are in it
/// together, so neither can be forgotten.
///
/// `ControlModeSession::resize` writes the same subcommand to control-mode
/// stdin instead. That is a different transport — no process, no exit status,
/// no stderr to carry — not a second grammar to keep in step; the same split
/// `send_keys` documents.
fn resize_window_args<'a>(session: &'a str, cols: &'a str, rows: &'a str) -> [&'a str; 7] {
    ["resize-window", "-t", session, "-x", cols, "-y", rows]
}

/// The argument vector for one line typed into a session:
/// `send-keys -t <session> <keys> Enter`.
///
/// `keys` is ONE entry, so a line containing spaces arrives as the single
/// argument the caller passed and nothing here splits it into key names. `Enter`
/// is the last of the fixed five, so pressing it cannot be forgotten at a call
/// site and cannot drift out of the grammar.
fn send_keys_args<'a>(session: &'a str, keys: &'a str) -> [&'a str; 5] {
    ["send-keys", "-t", session, keys, "Enter"]
}

/// The argument vector for capturing a pane's content with its escapes kept:
/// `capture-pane -t <session> -p -S <from> -E - -e -J`.
///
/// Every flag is load-bearing and each was a way to get this wrong:
///
/// - `-e` keeps the ANSI escape sequences. Without it xterm.js is handed plain
///   text and the bootstrap loses every colour and cursor move.
/// - `-S <from>` is where the capture starts, and it is counted **back from the
///   bottom** rather than forward from the top — so the result is the visible
///   screen plus up to that many lines above it, which is what a client
///   attaching to a live session wants. `from` arrives already spelled `-N`.
/// - `-E -` stops at the last line, so a pane that is not full is not padded
///   out to an arbitrary height.
/// - `-J` joins wrapped lines, and it is the difference between a snapshot a
///   client can be *fed* and one it cannot. tmux wraps long lines in its own
///   grid, and a capture is emitted **per grid row** — so without `-J` a
///   107-column line that the pane wrapped at 80 arrives as two lines, and the
///   client has no way to know they were ever one. xterm *does* re-join a row
///   it wrapped itself when the grid later changes (measured: a 107-character
///   line written into an 80-column xterm comes back as one row after a resize
///   to 142, 170 rows into the scrollback), but a break that arrived as data is
///   indistinguishable from a real newline and stays broken forever.
///
///   That is not hypothetical: the pane is created at the default 80×24 when
///   the client has not measured yet, which is the ordinary case on a reload,
///   so every restored history was 80-column fragments inside a 142-column
///   terminal. From the manual, verbatim: *"-J preserves trailing spaces and
///   joins any wrapped lines; -J implies -T."*
///
/// `from` is one entry, so the sign cannot be dropped at a call site and turn
/// "the last N lines" into "from line N" — the mistake this arity prevents.
fn capture_pane_args<'a>(session: &'a str, from: &'a str) -> [&'a str; 10] {
    [
        "capture-pane",
        "-t",
        session,
        "-p",
        "-S",
        from,
        "-E",
        "-",
        "-e",
        "-J",
    ]
}

/// The query that resolves a client's name from the process that owns it.
///
/// `detach-client -t` takes a **client** target, and a session name is not one
/// — measured on tmux 3.6b: `detach-client -t <session>` answers `can't find
/// client: <session>` with exit 1 and detaches nothing, which is why every
/// teardown that named a session had been a no-op since it was written
/// (#1011). tmux does record the pid of the process that attached, and
/// `#{client_pid}` is the `tmux attach` process this backend spawned, so the
/// client we own is the one carrying our child's pid. `-s <session>` would be
/// the wrong repair: it detaches *every* client of the session, including one
/// a user attached by hand.
fn list_clients_args() -> [&'static str; 3] {
    ["list-clients", "-F", "#{client_pid} #{client_name}"]
}

/// Detach one client, by name — see [`list_clients_args`] for why the name and
/// not the session. Fixed arity, so a caller cannot drop the target and detach
/// the current client by accident.
fn detach_client_args(client: &str) -> [&str; 3] {
    ["detach-client", "-t", client]
}

/// The client name on the line whose pid is `pid`, from a
/// [`list_clients_args`] listing. `None` means no client carries that pid.
///
/// Parsing lives here rather than at the call sites so the `-F` format and the
/// reading of it cannot drift apart — a listing read with the wrong shape finds
/// nothing and looks exactly like "the client is already gone".
fn client_name_for_pid_in(listing: &[u8], pid: u32) -> Option<String> {
    String::from_utf8_lossy(listing).lines().find_map(|line| {
        let mut fields = line.split_whitespace();
        let line_pid = fields.next()?.parse::<u32>().ok()?;
        let name = fields.next()?;
        (line_pid == pid).then(|| name.to_string())
    })
}

/// The tmux semantic owner: typed operations over one [`TmuxCommand`].
#[derive(Debug, Clone)]
pub struct TmuxOps {
    command: TmuxCommand,
}

impl TmuxOps {
    /// Bind the operations to a specific process addressing.
    pub fn new(command: TmuxCommand) -> Self {
        Self { command }
    }

    /// The process addressing these operations run on.
    pub fn command(&self) -> &TmuxCommand {
        &self.command
    }

    /// Set one environment variable on a session's tmux environment:
    /// `tmux set-environment -t <session> <name> <value>`.
    ///
    /// Whether a failure is `Required` or `BestEffort` is the caller's decision
    /// — see the module docs. This returns it either way, carrying tmux's own
    /// stderr, because `variable name contains =` and `no such session: …` are
    /// different problems and a summary that dropped the difference is what made
    /// #980 unreadable even in the logs that had it.
    pub async fn set_environment(&self, session: &str, name: &str, value: &str) -> Result<()> {
        // `TmuxCommand::output` captures stderr: tmux's message is the only thing
        // that says *why* a mutation failed.
        let output = self
            .command
            .output(&set_environment_args(session, name, value))
            .await
            .with_context(|| {
                format!("failed to spawn tmux set-environment for {name} on session {session}")
            })?;
        if output.status.success() {
            return Ok(());
        }
        anyhow::bail!(
            "tmux set-environment -t {session} {name} failed: {} ({})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }

    /// What tmux holds for `name` in `session`: the value, `Ok(None)` when the
    /// session holds nothing under that name, `Err` when the question could not
    /// be asked at all.
    ///
    /// Read back after a mutation, this is the only thing that distinguishes
    /// "the variable was set" from "nothing was set and everything reported
    /// success" — which is what #980 was, and why `set_environment` alone could
    /// not have caught it.
    ///
    /// Only the trailing newline is stripped from tmux's line: tmux preserves
    /// leading and trailing whitespace inside a value (measured on tmux 3.6b —
    /// `set-environment -t p K 'v '` reads back as `K=v \n`), so a `trim()`
    /// here would answer with a value the caller never wrote.
    pub async fn show_environment(&self, session: &str, name: &str) -> Result<Option<String>> {
        let output = self
            .command
            .output(&show_environment_args(session, name))
            .await
            .with_context(|| {
                format!("failed to spawn tmux show-environment for {name} on session {session}")
            })?;

        let stderr = String::from_utf8_lossy(&output.stderr);
        if !output.status.success() {
            if stderr.contains(UNKNOWN_VARIABLE) {
                return Ok(None);
            }
            anyhow::bail!(
                "tmux show-environment -t {session} {name} failed: {} ({})",
                output.status,
                stderr.trim()
            );
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.trim_end_matches(['\r', '\n']);
        value_from_line(line).map(Some).with_context(|| {
            format!(
                "tmux show-environment -t {session} {name} printed no NAME=VALUE line: {line:?}"
            )
        })
    }

    /// The current size of `session`'s active window, as tmux reports it:
    /// `tmux display-message -p -t <session> '#{window_width} #{window_height}'`.
    ///
    /// This was written twice before #991 — `util.rs` asked
    /// `-t <session> -p <format>` and fell back to 80×24 per dimension on any
    /// failure, `server/websocket.rs` asked `-p -t <session> <format>` and
    /// errored. Same query, two encodings, two policies. The query and its
    /// parse are here now; each caller keeps the policy it had, at its own call
    /// site (see the module docs).
    ///
    /// **A target that does not exist is not a non-zero exit.** Measured on
    /// tmux 3.6b against a live server: `display-message -p -t nope '<fmt>'`
    /// exits **0** and prints an empty line, because the format expands to
    /// nothing. So the parse is what fails, and this returns `Err` for it —
    /// which is what lets the `BestEffort` caller fall back to its default and
    /// keeps the `Required` caller from reading an empty answer as a size.
    pub async fn window_size(&self, session: &str) -> Result<(u16, u16)> {
        let output = self
            .command
            .output(&window_size_args(session))
            .await
            .with_context(|| format!("failed to spawn tmux display-message for {session}"))?;
        if !output.status.success() {
            anyhow::bail!(
                "tmux display-message -p -t {session} failed: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.trim_end_matches(['\r', '\n']);
        size_from_line(line).with_context(|| {
            format!("tmux display-message -p -t {session} answered no window size")
        })
    }

    /// The modes `session`'s pane terminal is currently in.
    ///
    /// Read by the bootstrap so a client that rebuilds its terminal learns the
    /// application's *state* and not only its text (#1096 criterion 13): a pane
    /// sitting in application-cursor mode must come back in it, or the next
    /// arrow key is encoded `^[[A` while the application waits for `^[OA`.
    ///
    /// [`TmuxOps::capture_pane`] cannot carry this. Measured against a pane put
    /// into `?1h`: `capture-pane -e` emits SGR attribute escapes and nothing
    /// else — private modes are terminal state, not text attributes, and tmux
    /// reconstructs the capture from the grid.
    ///
    /// Fails rather than guessing, like [`window_size`](Self::window_size) and
    /// for the same measured reason: an unknown target is an empty line and a
    /// zero exit, so the parse is the only place that can tell "no modes are
    /// set" from "tmux did not answer". The bootstrap's caller decides what a
    /// missing answer costs — see `send_bootstrap`.
    pub async fn pane_mode_flags(&self, session: &str) -> Result<PaneModeFlags> {
        let output = self
            .command
            .output(&pane_mode_args(session))
            .await
            .with_context(|| format!("failed to spawn tmux display-message for {session}"))?;
        if !output.status.success() {
            anyhow::bail!(
                "tmux display-message -p -t {session} failed: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.trim_end_matches(['\r', '\n']);
        pane_mode_flags_from_line(line).with_context(|| {
            format!("tmux display-message -p -t {session} answered no pane mode flags")
        })
    }

    /// The pane cursor's `(x, y)` and the pane height, all from the same
    /// one-line answer; `x`/`y` are zero-based from the top-left of the
    /// visible pane.
    ///
    /// Read by the bootstrap so a reconstructed screen puts the caret where
    /// the application left it (#2464). A pane whose application moved to an
    /// empty row and paused has a cursor that is not at the end of the last
    /// written line; without this the next live byte lands at the wrong
    /// row/column. The height is part of the same answer because the blank
    /// rows between the text and the cursor are `pane_height - 1 - y`, and
    /// reading it separately would allow a resize between the two queries to
    /// describe a screen that never existed.
    ///
    /// **This is a separate query from the capture and the modes.** It is a
    /// best-effort position at a nearby boundary, not proof that the bytes
    /// and the coordinates describe one instant; the caller decides whether
    /// the answer is coherent enough to emit (see `send_bootstrap`).
    pub async fn pane_cursor(&self, session: &str) -> Result<(u16, u16, u16)> {
        let output = self
            .command
            .output(&pane_cursor_args(session))
            .await
            .with_context(|| format!("failed to spawn tmux display-message for {session}"))?;
        if !output.status.success() {
            anyhow::bail!(
                "tmux display-message -p -t {session} failed: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        let stdout = String::from_utf8_lossy(&output.stdout);
        let line = stdout.trim_end_matches(['\r', '\n']);
        pane_cursor_from_line(line).with_context(|| {
            format!("tmux display-message -p -t {session} answered no pane cursor")
        })
    }

    /// Resize `session`'s window to `cols` × `rows` — the write counterpart of
    /// [`window_size`](Self::window_size).
    ///
    /// Called by `ControlModeSession::attach`, which has to set the size
    /// **before** the control-mode client exists: at that moment there is no
    /// stdin to write to, so the resize cannot travel the transport
    /// [`ControlModeSession::resize`](super::control::ControlModeSession::resize)
    /// uses. Same subcommand, same target, two routes — the split is the
    /// transport, not the grammar.
    pub async fn resize_window(&self, session: &str, cols: u16, rows: u16) -> Result<()> {
        let cols = cols.to_string();
        let rows = rows.to_string();
        let output = self
            .command
            .output(&resize_window_args(session, &cols, &rows))
            .await
            .with_context(|| format!("failed to spawn tmux resize-window for session {session}"))?;
        if output.status.success() {
            return Ok(());
        }
        anyhow::bail!(
            "tmux resize-window -t {session} -x {cols} -y {rows} failed: {} ({})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }

    /// Type one line into `session`'s active pane and press Enter:
    /// `tmux send-keys -t <session> <keys> Enter`.
    ///
    /// The `Enter` is part of the operation, not of the caller's argument,
    /// because every call site wants it: the line is a shell command and a line
    /// that is never submitted is not the operation anyone asked for.
    ///
    /// This is the **argv** form — a subprocess, whose exit status and stderr
    /// are the failure this returns. A control-mode client's `send-keys -H` is a
    /// different operation over a different transport and is deliberately not
    /// this; see the module docs for why it is not unified with it.
    ///
    /// Both halves of what changed when this moved: the argument vector is now
    /// built once, in [`send_keys_args`], instead of at the two call sites that
    /// each wrote it; and a failure now carries tmux's own stderr, where the
    /// `util::send_keys` it replaces discarded it (`Stdio::null()`) and
    /// reported only the session name (#991: a required failure retains useful
    /// tmux context). No caller's *class* changed — `EnvManager` still
    /// propagates, `SessionManager`'s legacy stage 2 still ignores.
    pub async fn send_keys(&self, session: &str, keys: &str) -> Result<()> {
        let output = self
            .command
            .output(&send_keys_args(session, keys))
            .await
            .with_context(|| format!("failed to spawn tmux send-keys for session {session}"))?;
        if output.status.success() {
            return Ok(());
        }
        anyhow::bail!(
            "tmux send-keys -t {session} failed: {} ({})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }

    /// The last `lines` lines of `session`'s active pane, escapes included, as
    /// raw bytes — or `Ok(None)` when tmux answers successfully with nothing,
    /// which is a session that exists and has no history yet.
    ///
    /// The three-state answer is the operation's, and it is deliberately not
    /// collapsed: "nothing to capture" and "could not capture" are a client
    /// that gets an empty prefill either way, but only one of them is worth a
    /// line in a log.
    ///
    /// **The failure is returned rather than replaced.** This used to be a
    /// free function in `util.rs` that resolved the process-wide tmux instead
    /// of the injected one, so a caller holding a `TmuxDep` for a *different*
    /// tmux would capture from the wrong server — silently, because the
    /// capture still succeeded and still returned bytes (#991's boundary).
    ///
    /// Size is **not** read here. A caller that wants the pane's geometry asks
    /// [`window_size`](Self::window_size) and decides for itself what a failure
    /// to read it means; `util::capture_scrollback` is the one caller that
    /// wants both and it says there why it falls back rather than propagating.
    pub async fn capture_pane(&self, session: &str, lines: u32) -> Result<Option<Vec<u8>>> {
        let from = format!("-{lines}");
        let output = self
            .command
            .output(&capture_pane_args(session, &from))
            .await
            .with_context(|| format!("failed to spawn tmux capture-pane for {session}"))?;
        if !output.status.success() {
            anyhow::bail!(
                "tmux capture-pane -t {session} -S {from} failed: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        if output.stdout.is_empty() {
            return Ok(None);
        }
        Ok(Some(output.stdout))
    }

    /// Detach the tmux client owned by `pid` — the one this backend spawned.
    ///
    /// `Ok(true)` means a client carried that pid and was detached.
    /// **`Ok(false)` means no client does, and is not a failure**: the client
    /// is already gone, so there is nothing left to detach. `Err` means the
    /// question could not be asked at all — tmux missing, server unreachable —
    /// and carries tmux's own words.
    ///
    /// The call sites classify all of this `Cleanup`, so the distinction is not
    /// about propagation: `Ok(false)` is the ordinary "already finished" answer
    /// and an `Err` is the one worth a line in a log. Collapsing them into a
    /// bare `let _ =` is what let the previous, session-targeted form stay
    /// invisible for as long as it did (#1011).
    pub async fn detach_client_by_pid(&self, pid: u32) -> Result<bool> {
        let Some(client) = self.client_name_for_pid(pid).await? else {
            return Ok(false);
        };
        let output = self
            .command
            .output(&detach_client_args(&client))
            .await
            .with_context(|| format!("failed to spawn tmux detach-client for {client}"))?;
        if output.status.success() {
            return Ok(true);
        }
        anyhow::bail!(
            "tmux detach-client -t {client} failed: {} ({})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }

    /// [`detach_client_by_pid`](Self::detach_client_by_pid) for a caller that
    /// cannot await. `Drop` is why this exists.
    ///
    /// The same operation on the blocking [`TmuxCommand::std`] builder, not a
    /// second grammar: both reach [`detach_client_args`] and
    /// [`client_name_for_pid_in`]. Only the spawn differs, which is the
    /// `std`/`tokio` duality [`TmuxCommand`] already carries.
    pub fn detach_client_by_pid_blocking(&self, pid: u32) -> Result<bool> {
        let Some(client) = self.client_name_for_pid_blocking(pid)? else {
            return Ok(false);
        };
        let output = self
            .command
            .output_blocking(&detach_client_args(&client))
            .with_context(|| format!("failed to spawn tmux detach-client for {client}"))?;
        if output.status.success() {
            return Ok(true);
        }
        anyhow::bail!(
            "tmux detach-client -t {client} failed: {} ({})",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )
    }

    /// The name of the client whose process is `pid`; `None` when no client
    /// carries it.
    async fn client_name_for_pid(&self, pid: u32) -> Result<Option<String>> {
        let output = self
            .command
            .output(&list_clients_args())
            .await
            .with_context(|| format!("failed to spawn tmux list-clients to resolve pid {pid}"))?;
        if !output.status.success() {
            anyhow::bail!(
                "tmux list-clients failed: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(client_name_for_pid_in(&output.stdout, pid))
    }

    /// [`client_name_for_pid`](Self::client_name_for_pid) on the blocking
    /// builder.
    fn client_name_for_pid_blocking(&self, pid: u32) -> Result<Option<String>> {
        let output = self
            .command
            .output_blocking(&list_clients_args())
            .with_context(|| format!("failed to spawn tmux list-clients to resolve pid {pid}"))?;
        if !output.status.success() {
            anyhow::bail!(
                "tmux list-clients failed: {} ({})",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(client_name_for_pid_in(&output.stdout, pid))
    }
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_environment_argv_splits_name_from_value() {
        // The two halves of #980 in one assertion: no `-e`, and `name`/`value`
        // as two entries rather than one joined `KEY=VALUE`.
        let argv = set_environment_args("sess", "KEY", "value");
        assert_eq!(argv, ["set-environment", "-t", "sess", "KEY", "value"]);
        assert!(
            !argv.contains(&"-e"),
            "`-e` is new-session's flag; set-environment refuses it: {argv:?}"
        );
        assert_eq!(argv.len(), 5, "arity is part of the grammar: {argv:?}");
        assert_ne!(
            argv[3], "KEY=value",
            "name and value must be two entries, not one joined KEY=VALUE: {argv:?}"
        );
    }

    #[test]
    fn set_environment_argv_keeps_a_value_intact() {
        // A value containing `=`, spaces and quotes is one argv entry. This is
        // what "passed as a separate argv value" means, and the `=` is the sharp
        // case: a joined `KEY=VALUE` would split it here rather than at tmux.
        for value in ["k=v=w", "a b  c", r#"he said "hi""#, "", "v "] {
            let argv = set_environment_args("sess", "KEY", value);
            assert_eq!(argv[4], value, "the value must arrive unchanged: {argv:?}");
            assert_eq!(
                argv[3], "KEY",
                "the name must not absorb the value: {argv:?}"
            );
        }
    }

    #[test]
    fn show_environment_argv_names_the_session_and_the_variable() {
        // Without `-t`, tmux resolves a session of its own choosing (measured on
        // 3.6b), so an answer can come from a session the caller never named.
        let argv = show_environment_args("sess", "KEY");
        assert_eq!(argv, ["show-environment", "-t", "sess", "KEY"]);
        assert!(
            argv.contains(&"-t"),
            "the target is what binds the answer to the session asked about: {argv:?}"
        );
        assert_eq!(argv.len(), 4, "arity is part of the grammar: {argv:?}");
    }

    #[test]
    fn value_from_line_splits_on_the_first_equals_only() {
        assert_eq!(value_from_line("K=v").as_deref(), Some("v"));
        assert_eq!(value_from_line("K=v=w").as_deref(), Some("v=w"));
        assert_eq!(value_from_line("K=").as_deref(), Some(""));
        assert_eq!(value_from_line("K= v ").as_deref(), Some(" v "));
        // A line with no `=` is not a value; the caller turns this into an error
        // rather than into an empty answer.
        assert_eq!(value_from_line("K"), None);
    }

    #[test]
    fn unknown_variable_is_recognized_as_the_unset_answer() {
        // The two non-zero answers tmux gives, as measured on 3.6b. Only the
        // first means "the session does not hold it"; the second must stay an
        // error, or a mistyped session name would read back as "unset".
        assert!("\nunknown variable: NESSION_MISSING\n".contains(UNKNOWN_VARIABLE));
        assert!(!"\nno such session: nope\n".contains(UNKNOWN_VARIABLE));
        assert!(!"\nno server running on /tmp/x/tmux.sock\n".contains(UNKNOWN_VARIABLE));
    }

    #[test]
    fn new_keeps_the_cmd_it_was_given() {
        // The constructor step 6 will use to hand the owner a substituted
        // `TmuxCmd`; without this the seam would exist but not bind.
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("probe.sock");
        let ops = TmuxOps::new(TmuxCommand::new("/nonexistent/fake-tmux", socket.clone()));
        assert_eq!(ops.command.socket_path(), socket.as_path());
        assert_eq!(ops.command.bin(), "/nonexistent/fake-tmux");
    }

    // ── the dependency, and the failure arms it makes reachable ──────────────

    #[tokio::test]
    async fn a_missing_binary_is_a_spawn_failure_not_a_silent_answer() {
        // The arm with no exit status to report: the binary does not exist, so
        // no process is ever spawned. It is a different failure from tmux
        // answering non-zero, and the message has to say which — a caller that
        // sees only "set-environment failed" cannot tell a refused flag from a
        // missing tmux.
        //
        // Covered through the owner's own addressing rather than through
        // `cmd::global()`: a test that reached the real binary here would not
        // reach this arm at all.
        let dir = tempfile::tempdir().expect("tempdir");
        let ops = TmuxOps::new(TmuxCommand::new(
            "/nonexistent/fake-tmux",
            dir.path().join("tmux.sock"),
        ));

        let set = format!(
            "{:#}",
            ops.set_environment("sess", "NESSON_SPAWN", "v")
                .await
                .expect_err("there is no binary to spawn")
        );
        assert!(
            set.contains("failed to spawn tmux set-environment"),
            "the failure must say the process never started: {set}"
        );
        assert!(
            set.contains("NESSON_SPAWN") && set.contains("sess"),
            "and it must name the variable and the session it was for: {set}"
        );

        let show = format!(
            "{:#}",
            ops.show_environment("sess", "NESSON_SPAWN")
                .await
                .expect_err("there is no binary to spawn")
        );
        assert!(
            show.contains("failed to spawn tmux show-environment"),
            "the query must fail the same way rather than answer `None`: {show}"
        );
        assert!(
            show.contains("NESSON_SPAWN") && show.contains("sess"),
            "and it must name the variable and the session it was asked about: {show}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn show_environment_refuses_an_answer_that_is_not_a_value() {
        // tmux exited 0 and printed something that is not the one `NAME=VALUE`
        // line it documents. `Ok(None)` here would say "the session does not
        // hold it", which is the answer a *successful* query gives — and the
        // caller cannot tell the two apart afterwards. The fake is what makes
        // the arm reachable: real tmux does not answer this way.
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::testing::FakeTmux::new(dir.path(), "printf 'not a value\\n'");

        let err = format!(
            "{:#}",
            TmuxOps::new(fake.command())
                .show_environment("sess", "NESSON_MALFORMED")
                .await
                .expect_err("a line with no `=` is not a value")
        );
        assert!(
            err.contains("printed no NAME=VALUE line"),
            "the failure must say what tmux answered instead: {err}"
        );
        assert!(
            err.contains("NESSON_MALFORMED") && err.contains("sess"),
            "and it must name the variable and the session it asked about: {err}"
        );
        assert_eq!(
            fake.calls(),
            vec![vec!["show-environment", "-t", "sess", "NESSON_MALFORMED"]],
            "the query must be the owner's grammar, run against the injected binary"
        );
    }

    // ── the window-size query ────────────────────────────────────────────────

    #[test]
    fn capture_pane_argv_joins_wrapped_lines() {
        // The behaviour this pins is in
        // `tests/integration/tmux.rs::capture_pane_returns_a_wrapped_line_whole`;
        // this is the cheap half — the flag is still on the vector. A capture
        // without `-J` emits one line **per grid row**, so a line the pane
        // wrapped at 80 arrives as two and nothing downstream can rejoin them,
        // because to a terminal that break is a real newline.
        let argv = capture_pane_args("sess", "-5000");
        assert!(
            argv.contains(&"-J"),
            "without -J the capture carries the pane's wrapping, not the \
             session's lines: {argv:?}"
        );
        assert!(
            argv.contains(&"-e"),
            "and it still has to carry the escapes, or every colour is lost"
        );
    }

    #[test]
    fn window_size_argv_prints_the_target_and_both_dimensions() {
        // Each assertion is the one that goes red under a specific edit:
        //   - drop `-p`            → the first (the full vector) fails
        //   - drop `-t`            → the first, and `names the target` below
        //   - swap `-p`/`-t`       → the first (the order is asserted)
        //   - ask only one dimension → `asks for both dimensions` fails
        let argv = window_size_args("sess");
        assert_eq!(
            argv,
            [
                "display-message",
                "-p",
                "-t",
                "sess",
                "#{window_width} #{window_height}"
            ]
        );
        assert!(
            argv.contains(&"-p"),
            "without -p tmux writes into a status line instead of stdout: {argv:?}"
        );
        assert!(
            argv.contains(&"-t"),
            "without -t tmux resolves a target of its own choosing, so the answer \
             can come from a session nobody asked about: {argv:?}"
        );
        let format = argv[4];
        assert!(
            format.contains("#{window_width}") && format.contains("#{window_height}"),
            "one query answers both dimensions, or a resize between two queries \
             reports a size that never existed: {format:?}"
        );
        assert_eq!(argv.len(), 5, "arity is part of the grammar: {argv:?}");
    }

    #[test]
    fn pane_mode_args_ask_for_every_flag_in_the_structs_order() {
        let argv = pane_mode_args("sess");
        assert_eq!(argv[0], "display-message");
        assert_eq!(
            argv,
            ["display-message", "-p", "-t", "sess", PANE_MODE_FORMAT],
            "`-p` and `-t` are load-bearing for the reasons window_size_args gives"
        );
        // The order the parse reads in is the order the format asks in, and
        // inserting a field is the mutation this pins: a new flag added to one
        // side only would shift every field after it.
        for (i, name) in [
            "keypad_cursor_flag",
            "alternate_on",
            "origin_flag",
            "wrap_flag",
            "cursor_flag",
            "insert_flag",
            "mouse_standard_flag",
            "mouse_button_flag",
            "mouse_all_flag",
            "mouse_sgr_flag",
            "mouse_utf8_flag",
            "keypad_flag",
        ]
        .iter()
        .enumerate()
        {
            let field = PANE_MODE_FORMAT.split_whitespace().nth(i);
            assert_eq!(
                field,
                Some(format!("#{{{name}}}").as_str()),
                "field {i} of the format is not {name}: {PANE_MODE_FORMAT:?}"
            );
        }
        assert_eq!(pane_mode_field_count(), 12);
    }

    #[test]
    fn pane_mode_flags_reads_the_line_tmux_prints() {
        let all_on = pane_mode_flags_from_line("1 1 1 1 1 1 1 1 1 1 1 1").unwrap();
        assert_eq!(
            all_on,
            PaneModeFlags {
                keypad_cursor: true,
                alternate: true,
                origin: true,
                wrap: true,
                cursor_visible: true,
                insert: true,
                mouse_standard: true,
                mouse_button: true,
                mouse_all: true,
                mouse_sgr: true,
                mouse_utf8: true,
                keypad: true,
            }
        );
        let all_off = pane_mode_flags_from_line("0 0 0 0 0 0 0 0 0 0 0 0").unwrap();
        assert_eq!(all_off, PaneModeFlags::default());
    }

    #[test]
    fn pane_mode_flags_refuses_a_short_or_unreadable_answer() {
        // The mutation this exists for: reading a short line as "those modes are
        // off". tmux prints an **empty line and exits 0** for a target that does
        // not exist (measured on 3.6b, see `window_size`), so a short answer is
        // tmux failing to answer — and treating it as all-off would restore
        // nothing while looking exactly like a success.
        for line in [
            "",
            "0 0 0",
            "1 1 1 1 1 1 1 1 1 1 1 1 1",
            "0 0 0 0 0 0 0 0 0 0 0",
        ] {
            assert!(
                pane_mode_flags_from_line(line).is_err(),
                "{line:?} is not an answer to a twelve-flag query"
            );
        }
        assert!(
            pane_mode_flags_from_line("0 0 0 0 0 0 0 0 0 0 0 2").is_err(),
            "a flag tmux does not produce is not one to act on"
        );
    }

    #[test]
    fn pane_cursor_args_ask_for_both_zero_based_coordinates() {
        let argv = pane_cursor_args("sess");
        assert_eq!(
            argv,
            ["display-message", "-p", "-t", "sess", PANE_CURSOR_FORMAT],
            "`-p` and `-t` are load-bearing for the reasons window_size_args gives"
        );
        assert_eq!(
            PANE_CURSOR_FORMAT, "#{cursor_x} #{cursor_y} #{pane_height}",
            "one query, or a cursor moving between two reads reports a position \
             that never existed; the height is what turns the row into a \
             distance from the text"
        );
    }

    #[test]
    fn pane_cursor_reads_the_line_tmux_prints() {
        // Zero-based, whitespace-separated and newline-terminated. 0 0 is a
        // real answer (the home position), which is why the parse cannot use
        // the empty line as "not answered" — that is what the field count and
        // the integer parse are for.
        assert_eq!(pane_cursor_from_line("0 0 24").ok(), Some((0, 0, 24)));
        assert_eq!(pane_cursor_from_line("11 14 60").ok(), Some((11, 14, 60)));
        assert_eq!(
            pane_cursor_from_line(" 11   14  60 \n").ok(),
            Some((11, 14, 60))
        );
    }

    #[test]
    fn pane_cursor_refuses_to_invent_a_position() {
        for line in [
            "",
            "11",
            "11 14",
            "11 14 0 0",
            "x 14 24",
            "11 y 24",
            "11 14 z",
            "-1 14 24",
            "11 -1 24",
            "11 14 -1",
        ] {
            assert!(
                pane_cursor_from_line(line).is_err(),
                "{line:?} is not a cursor + height answer"
            );
        }
    }

    #[test]
    fn size_from_line_reads_the_two_numbers_tmux_prints() {
        // Whitespace-separated, because that is tmux's word: it prints the two
        // numbers and a newline. A `split(' ')` instead would go red on the
        // leading/trailing-space case below.
        assert_eq!(size_from_line("200 60").ok(), Some((200, 60)));
        assert_eq!(
            size_from_line(" 200   60 \n").ok(),
            Some((200, 60)),
            "tmux's output is whitespace-separated and newline-terminated"
        );
        assert_eq!(
            size_from_line("200 60 extra").ok(),
            Some((200, 60)),
            "the size is the first two fields; a third cannot appear in the format"
        );
    }

    #[test]
    fn size_from_line_refuses_to_invent_a_dimension() {
        // The mutation this pins: defaulting a missing or unparseable dimension.
        // `capture_scrollback`'s 80×24 belongs to `capture_scrollback`; an owner
        // that supplied defaults would give the `Required` caller a size it
        // could not tell from a real one.
        for (line, missing) in [
            ("200", "no height"),
            ("", "no width"),
            ("200 x", "height"),
            ("x 60", "width"),
        ] {
            let err = size_from_line(line)
                .expect_err(&format!("{line:?} is not a size"))
                .to_string();
            assert!(
                err.contains(missing),
                "the failure must say what was missing ({missing:?}): {err}"
            );
            assert!(
                err.contains(&format!("{line:?}")),
                "the failure must quote what tmux actually answered: {err}"
            );
        }
    }

    #[test]
    fn send_keys_argv_presses_enter_and_keeps_the_line_whole() {
        // Two edits redden this, and both are the mistakes the inline copies
        // could make: dropping `Enter` (the line is typed but never submitted)
        // and splitting `keys` into key names (a line with spaces becomes
        // several keystrokes).
        let argv = send_keys_args("sess", "export A='b c'");
        assert_eq!(argv, ["send-keys", "-t", "sess", "export A='b c'", "Enter"]);
        assert_eq!(
            argv.last(),
            Some(&"Enter"),
            "the operation is \"type this line AND submit it\": {argv:?}"
        );
        assert_eq!(
            argv[3], "export A='b c'",
            "the line is one argument, not a sequence of key names: {argv:?}"
        );
        assert_eq!(argv.len(), 5, "arity is part of the grammar: {argv:?}");
    }

    #[tokio::test]
    async fn a_socket_with_no_server_fails_with_tmux_own_words() {
        // The non-zero-exit arm, for both operations, without a fake tmux: a
        // real tmux binary and a socket no server has ever bound. tmux answers
        // "error connecting to <path>" on stderr and exits 1.
        //
        // The mutation this pins is the one #980 was: swallowing the status.
        // Returning `Ok` where the status is non-zero reddens the `expect_err`
        // below (run: the send-keys half of the pair fails), and dropping
        // tmux's stderr from the message reddens the first assertion — a
        // `Required` caller that cannot see either is the failure mode #991
        // exists for.
        let dir = tempfile::tempdir().expect("tempdir");
        let socket = dir.path().join("tmux.sock");
        assert!(dir.path().join("tmux.sock").to_string_lossy().len() < 103);
        let ops = TmuxOps::new(TmuxCommand::new("tmux", socket.clone()));
        let socket_text = socket.to_string_lossy().into_owned();

        let errors = [
            ops.window_size("sess").await.expect_err("no server to ask"),
            ops.send_keys("sess", "echo hi")
                .await
                .expect_err("no server to type into"),
        ];
        for err in errors {
            let message = format!("{err:#}");
            assert!(
                message.contains("error connecting to"),
                "the failure must carry tmux's own stderr: {message}"
            );
            assert!(
                message.contains(&socket_text),
                "and it must name the socket tmux could not reach: {message}"
            );
        }
    }

    /// The listing is one line per client and the pid is what identifies ours.
    /// Both halves matter: reading the wrong field finds nothing, and "found
    /// nothing" is indistinguishable from "the client is already gone" — the
    /// two outcomes the operation exists to tell apart.
    #[test]
    fn the_client_with_our_pid_is_the_one_that_is_found() {
        let listing = b"111 client-111\n222 client-222\n333 client-333\n";
        assert_eq!(
            client_name_for_pid_in(listing, 222).as_deref(),
            Some("client-222"),
            "the pid selects the line, not the position in the listing"
        );
    }

    #[test]
    fn a_listing_without_our_pid_finds_nothing() {
        let listing = b"111 client-111\n222 client-222\n";
        assert_eq!(client_name_for_pid_in(listing, 999), None);
    }

    #[test]
    fn an_empty_listing_finds_nothing() {
        // What a server with no clients prints, and what the fake prints when
        // the attach never recorded a pid.
        assert_eq!(client_name_for_pid_in(b"", 1), None);
    }

    #[test]
    fn a_line_that_is_not_a_pid_is_skipped_rather_than_matched() {
        // tmux's own diagnostics can land on stdout; a line whose first field
        // is not a number must not be mistaken for a client.
        let listing = b"not-a-pid client-x\n42 client-42\n";
        assert_eq!(
            client_name_for_pid_in(listing, 42).as_deref(),
            Some("client-42"),
            "the unparsable line is skipped, and the real one after it is found"
        );
    }

    /// A required `resize-window` failure keeps tmux's own words.
    ///
    /// Moved here from `util.rs` when the attach-time resize stopped going
    /// through a caller-supplied argument vector (#991's non-goal): the claim
    /// is about the *operation*, so it belongs with the operation rather than
    /// with a helper that no longer exists.
    ///
    /// Its one caller propagates with `?` — a control-mode attach is abandoned
    /// when its pre-attach resize fails — so the class is `Required`, and
    /// #991's third error criterion is that a required failure carries tmux's
    /// context. Before step 7 the call was `.status()` with
    /// `stderr(Stdio::null())`, so "the session is gone", "tmux refused the
    /// size" and "the binary is broken" all reached the caller as
    /// `exited with status: 1`.
    ///
    /// Reddens on: dropping the stderr pipe (the marker assertion matches
    /// nothing), dropping the status from the message, or dropping the command.
    #[cfg(unix)]
    #[tokio::test]
    async fn a_required_resize_failure_carries_what_tmux_said() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::testing::FakeTmux::new(
            dir.path(),
            "case \"$1\" in resize-window) echo 'no such session: nession-fake-sess' >&2; exit 1;; \
             *) exit 0;; esac",
        );
        let ops = TmuxOps::new(fake.command());

        let err = ops
            .resize_window("nession-fake-sess", 80, 24)
            .await
            .expect_err("the injected binary refuses every resize-window");
        let message = format!("{err:#}");
        assert!(
            message.contains("no such session: nession-fake-sess"),
            "the failure must carry tmux's own stderr: {message}"
        );
        assert!(
            message.contains("exit status"),
            "and its exit status: {message}"
        );
        assert!(
            message.contains("resize-window"),
            "and the command it was running: {message}"
        );
        assert_eq!(
            fake.calls(),
            vec![vec![
                "resize-window",
                "-t",
                "nession-fake-sess",
                "-x",
                "80",
                "-y",
                "24"
            ]],
            "the target and both dimensions come from the owner's one vector"
        );
    }
}
