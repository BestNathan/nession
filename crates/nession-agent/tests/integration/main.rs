// Single harness for all nession-agent integration tests.

mod connection;
mod control_mode;
mod full_chain; // ← e2e_test.rs renamed (spec: Rust has no E2E layer)
mod server;
mod sync;
mod tmux;

// ── Shared helpers ───────────────────────────────────────────────────────────

// unique_session_name: defined 5× across the 6 files, 4 of them byte-identical.
// Extract to crate root. control_mode's copy differs (extra ctrl- segment) and
// stays module-private.
use futures_util::StreamExt;
use nession_agent::p2p_credentials::P2pCredentials;
use nession_protocol::contracts::p2p::agent_url_with_credential;
use nession_protocol::contracts::p2p::v1::{CredentialScope, P2pGrantPayload};
use rand::Rng;
use tokio_tungstenite::connect_async;

/// Prefix shared by every tmux session these tests create, so the contents of
/// a run directory left behind by a crashed run are recognizable at a glance.
/// Since #582, `scripts/sweep-test-sessions.sh` reclaims whole owned run
/// directories by pattern (`nession-test-tmux.*`) rather than by session name.
pub(crate) const TEST_SESSION_PREFIX: &str = "nession-test-";

pub(crate) fn unique_session_name(prefix: &str) -> String {
    let suffix: u32 = rand::thread_rng().gen();
    format!("{TEST_SESSION_PREFIX}{prefix}-{suffix}")
}

/// The agent id every test `AgentServer` in this crate registers under.
///
/// One constant because two things have to agree on it: the id the server is
/// built with, and the id a granted credential names. The store refuses a grant
/// addressed to another agent, so a mismatch is a credential that is never
/// honoured — silence at the dial, with nothing pointing at the cause.
pub(crate) const TEST_AGENT_ID: &str = "test-agent";

/// The credential every test dial presents.
///
/// **A literal, not a fresh UUID per server.** The store is per-server and the
/// servers are per-test, so uniqueness buys nothing — and a value that has to
/// appear twice in a function (granted, then put on the URL) is a value that
/// can drift.
pub(crate) const TEST_CREDENTIAL: &str = "nession-test-credential";

/// The scope a test dial presents unless it says otherwise: a browser's, at its
/// broadest.
///
/// The session name is a **placeholder**, and that is a statement rather than a
/// shortcut: the server is started before the test creates the session it will
/// attach to, so no credential granted here can name the right one, and the gate
/// compares the name in the credential against the name in the frame (#1013).
/// The consequence is deliberate — the five session-scoped wires are closed to
/// this credential, and a test that sends one dials through
/// [`connect_for`] once it knows its session's name.
pub(crate) fn browser_scope() -> CredentialScope {
    CredentialScope::for_attach(PLACEHOLDER_SESSION)
}

/// The session name [`browser_scope`] binds to.
///
/// Deliberately one **no frame in these tests names**, so that the dials which
/// reach a session-scoped wire by accident fail loudly instead of passing on a
/// placeholder that happened to match. It is spelled out rather than read as
/// "any session" because `CredentialScope` has no wildcard: a scope that covers
/// every session says so in [`CredentialScope::for_standalone`]'s field, and
/// nothing else does.
pub(crate) const PLACEHOLDER_SESSION: &str = "nession-test-placeholder";

/// The credential a **standalone** dial presents, for the one test whose single
/// connection names two sessions.
pub(crate) const STANDALONE_CREDENTIAL: &str = "nession-test-standalone-credential";

/// Grant `credential` into `credentials`, so a dial presenting it is honoured
/// (#1013).
///
/// Goes through [`P2pCredentials::grant`] — the method the Server's
/// `agent.p2p.grant` arrives at — rather than inserting into the map, so the
/// store's own rules (the target-agent binding, the refusal of an unreadable
/// expiry) apply to the credential a test presents: one a helper slipped past
/// them would be a test green on a credential production would refuse.
///
/// **Deliberately not a method on `AgentServer`.** A minter there is test-only
/// API on a production type, and the one this work first reached for was gated
/// on a cargo feature that this repo's test command never enables
/// (`scripts/filtered-test.sh` → `cargo test --workspace`, no `--features`) — so
/// it did not exist in the build that matters, and nothing said so until the
/// gate ran. `grant` is public and unconditional and is the same path, so the
/// wrapper was buying nothing but that hazard.
///
/// `p2p_credentials::Refusal` carries no `Error` impl and so cannot ride out on
/// `anyhow`'s `?`; it is rendered rather than chained.
pub(crate) fn mint_credential(
    credentials: &P2pCredentials,
    agent_id: &str,
    credential: &str,
    scope: CredentialScope,
) -> anyhow::Result<()> {
    let grant = P2pGrantPayload {
        request_id: "test-grant".to_string(),
        credential: credential.to_string(),
        agent_id: agent_id.to_string(),
        session_id: format!("{agent_id}:test"),
        scope,
        expires_at: (chrono::Utc::now() + chrono::Duration::seconds(300)).to_rfc3339(),
    };
    // `grant` hands back the credential's log tag, which is the store's answer
    // to "did this land"; the tag is what a warning would carry, and a test that
    // fails to grant has nothing to log it to.
    credentials.grant(agent_id, &grant).map_err(|refusal| {
        anyhow::anyhow!("the agent refused its own test credential: {refusal:?}")
    })?;
    Ok(())
}

/// The halves of a dialed P2P connection, named once: the three dial helpers
/// below would otherwise each spell the pair out.
pub(crate) type WsSink = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    tokio_tungstenite::tungstenite::Message,
>;
pub(crate) type WsStream = futures_util::stream::SplitStream<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
>;

/// Dial `addr`, presenting `credential` — which this store must already hold.
///
/// The credential travels **in** the URL rather than beside it, and through the
/// shared builder rather than by hand: the agent's listener binds
/// `127.0.0.1:0`, so the URL has no path, and writing the query onto it by hand
/// gives the request target `?token=x`. That is not origin-form, so the peer
/// drops the connection mid-handshake and the client reports an opaque
/// `HandshakeIncomplete` with no URL in it (#1013).
///
/// The store is asked first for the same reason: a dial presenting something it
/// never minted fails here, naming the reason, instead of arriving as that
/// opaque handshake failure.
async fn connect_presenting(
    credentials: &P2pCredentials,
    addr: std::net::SocketAddr,
    credential: &str,
) -> anyhow::Result<(WsSink, WsStream)> {
    anyhow::ensure!(
        credentials.authorize(credential).is_ok(),
        "the credential a test dial presents must be one its agent's store honours"
    );
    let url = agent_url_with_credential(&format!("ws://{addr}"), credential);
    let (ws, _resp) = connect_async(&url).await?;
    Ok(ws.split())
}

/// Connect presenting [`TEST_CREDENTIAL`], the broad credential a test server
/// mints for itself.
///
/// Reaches every wire **except** the five the scope gate binds to a session name
/// (#1013); a test that sends one of those says which session it means through
/// [`connect_for`].
pub(crate) async fn connect(
    credentials: &P2pCredentials,
    addr: std::net::SocketAddr,
) -> anyhow::Result<(WsSink, WsStream)> {
    connect_presenting(credentials, addr, TEST_CREDENTIAL).await
}

/// Connect presenting a credential bound to `session`.
///
/// Minted **here** rather than at server start, because the session names these
/// tests use are generated per run ([`TestSession`]) and so do not exist when
/// the server does. The credential string is derived from the session name,
/// which is all the uniqueness a per-server store needs: a second dial for the
/// same session re-grants the same value rather than needing a counter.
pub(crate) async fn connect_for(
    credentials: &P2pCredentials,
    addr: std::net::SocketAddr,
    session: &str,
) -> anyhow::Result<(WsSink, WsStream)> {
    let credential = format!("credential-for-{session}");
    mint_credential(
        credentials,
        TEST_AGENT_ID,
        &credential,
        CredentialScope::for_attach(session),
    )?;
    connect_presenting(credentials, addr, &credential).await
}

/// Connect presenting a **node-wide** credential: the terminal for every session.
///
/// [`CredentialScope::for_standalone`] — the shape an agent with no Server
/// honours (see `AgentConfig::server_url` in the agent runtime) — and the only
/// scope that lets one connection name more than one session, which is why the
/// one test that does is the one test that dials through this. Every other dial
/// here is bound to a single session, and that is where the gate's name
/// comparison is exercised.
pub(crate) async fn connect_all_sessions(
    credentials: &P2pCredentials,
    addr: std::net::SocketAddr,
) -> anyhow::Result<(WsSink, WsStream)> {
    mint_credential(
        credentials,
        TEST_AGENT_ID,
        STANDALONE_CREDENTIAL,
        CredentialScope::for_standalone(),
    )?;
    connect_presenting(credentials, addr, STANDALONE_CREDENTIAL).await
}

/// A fake `tmux` binary, for substitution through
/// [`TmuxDep::injected`](nession_agent::tmux::ops::TmuxDep::injected).
///
/// The unit-test copy of this is `crate::test_support::FakeTmux`, which
/// integration tests cannot see (see the note on [`TestSession`]). Keep the two
/// in step: both record the argv of every call with the `-S <socket>` prefix
/// stripped, both run `script` with `/bin/sh`, and both leave the recorded log
/// in the caller's temp dir.
///
/// It is here rather than in one test file because #991 step 6 is about a seam
/// that has to be reachable *from outside the crate*: a test that reached it
/// only through `#[cfg(test)]` items would pass while the seam stayed
/// unavailable to every other consumer.
#[cfg(unix)]
pub(crate) struct FakeTmux {
    bin: String,
    dir: std::path::PathBuf,
    socket: std::path::PathBuf,
}

/// Install `body` at `bin`, with the file created by a **child** process.
///
/// The path a test execs must never be one this process has open for writing.
/// `fork` copies the whole descriptor table, so a child forked from another
/// thread inherits a copy of any write descriptor held here, and `O_CLOEXEC`
/// drops it only once that child reaches its own `exec`. Until then the inode's
/// write count is positive, and an `exec` of the same path fails with `ETXTBSY`
/// (`Text file busy`) — the failure #1026 records.
///
/// So the content goes to a path that is **never exec'd**, and a child `cp`
/// creates the one that is: this process's descriptor table then holds no write
/// descriptor on `bin`. Measured on Linux in this shape — writer threads plus
/// threads forking continuously, 6000 attempts each — writing in-process gave
/// `ETXTBSY` 49 and then 54; this gave 0.
///
/// This is a copy of the same helper in `src/test_support.rs`, which
/// integration tests cannot see; keep the two in step.
#[cfg(unix)]
pub(crate) fn install_via_a_child(bin: &std::path::Path, body: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let src = bin.with_extension("src");
    std::fs::write(&src, body)?;
    let status = std::process::Command::new("cp").arg(&src).arg(bin).status();
    let _ = std::fs::remove_file(&src);
    if !status?.success() {
        return Err(std::io::Error::other(
            "installing the fake tmux: cp exited with a failure status",
        ));
    }
    // `chmod` does not open the file, so this cannot reintroduce the window.
    let mut perms = std::fs::metadata(bin)?.permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(bin, perms)
}

#[cfg(unix)]
impl FakeTmux {
    /// Write the fake into `dir`.
    ///
    /// `io::Result` rather than panicking here: this file's helpers are not
    /// themselves test code, so `allow-expect-in-tests` does not cover them —
    /// the caller (a `#[test]`) is where a failure is allowed to be fatal.
    pub(crate) fn new(dir: &std::path::Path, script: &str) -> std::io::Result<Self> {
        let bin = dir.join("tmux");
        // A child creates it: the path a test execs must not be one this
        // process wrote, because `fork` copies the descriptor table and an
        // `exec` of a write-opened file is `ETXTBSY` (#1026). Same reasoning and
        // measurements as the unit-test copy in `src/test_support.rs`.
        install_via_a_child(
            &bin,
            // One file per call, claimed with an O_EXCL create, so two
            // processes recording at once (a spawned tmux client and the parent
            // making awaited calls) cannot interleave. The mechanism, the
            // rejected alternatives and the measurements are documented on the
            // unit-test copy in `crates/nession-agent/src/test_support.rs`;
            // this body must stay in step with it.
            &format!(
                "#!/bin/sh\n\
                 if [ \"$1\" = \"-S\" ]; then shift 2; fi\n\
                 n=0\n\
                 while true; do\n\
                 while [ -e \"{dir}/{prefix}$n\" ]; do n=$((n + 1)); done\n\
                 if mkdir \"{dir}/{prefix}$n\" 2>/dev/null; then break; fi\n\
                 if [ ! -d \"{dir}/{prefix}$n\" ]; then\n\
                 echo \"fake tmux: cannot claim {dir}/{prefix}$n\" >&2\n\
                 exit 1\n\
                 fi\n\
                 n=$((n + 1))\n\
                 done\n\
                 printf '%s\\n' \"$@\" > \"{dir}/{prefix}$n/{record}\"\n\
                 echo \"{sep}\" >> \"{dir}/{prefix}$n/{record}\"\n\
                 {script}\n",
                dir = dir.display(),
                prefix = CALL_FILE_PREFIX,
                record = CALL_RECORD_NAME,
                sep = CALL_SEPARATOR,
            ),
        )?;
        Ok(Self {
            bin: bin.to_string_lossy().into_owned(),
            dir: dir.to_path_buf(),
            socket: dir.join("tmux.sock"),
        })
    }

    /// The tmux dependency to inject: this binary, on a socket no server has
    /// bound — so a call that failed to reach the fake cannot quietly succeed
    /// against a real one.
    pub(crate) fn dep(&self) -> nession_agent::tmux::ops::TmuxDep {
        nession_agent::tmux::ops::TmuxDep::injected(nession_agent::tmux::cmd::TmuxCmd::new(
            self.bin.clone(),
            self.socket.clone(),
        ))
    }

    /// Every call recorded so far, each as the argv entries tmux received.
    pub(crate) fn calls(&self) -> Vec<Vec<String>> {
        let mut calls = Vec::new();
        for n in 0.. {
            let claimed = self.dir.join(format!("{CALL_FILE_PREFIX}{n}"));
            // Indices are claimed in order by creating the directory, so the
            // first unclaimed one means there is nothing after it either.
            if !claimed.is_dir() {
                break;
            }
            let text = match std::fs::read_to_string(claimed.join(CALL_RECORD_NAME)) {
                Ok(text) => text,
                // Claimed, but the argv is not on disk yet — and later indices
                // may already be complete, so this is not where the scan ends.
                Err(_) => continue,
            };
            // The argv is written after the claim, so a call still being
            // recorded has no terminator.
            let Some(body) = text.trim_end_matches('\n').strip_suffix(CALL_SEPARATOR) else {
                continue;
            };
            let entries: Vec<String> = body
                .trim_matches('\n')
                .lines()
                .map(str::to_string)
                .collect();
            if !entries.is_empty() {
                calls.push(entries);
            }
        }
        calls
    }
}

/// Prefix of the one-directory-per-call records [`FakeTmux`] writes into its
/// directory.
#[cfg(unix)]
pub(crate) const CALL_FILE_PREFIX: &str = "call.";

/// Name of the file inside `call.N` that holds the call's argv.
#[cfg(unix)]
pub(crate) const CALL_RECORD_NAME: &str = "argv";

/// Terminator [`FakeTmux`] writes after the argv of each recorded call.
#[cfg(unix)]
pub(crate) const CALL_SEPARATOR: &str = "==call==";

/// What tmux holds for `name` in `session` — the value half of the one
/// `NAME=VALUE` line it prints, or `None` when tmux does not hold it.
///
/// This is how a test asks tmux what it actually holds, rather than asking
/// nession whether it thinks it succeeded — the distinction #980 turned on.
///
/// It goes through `TmuxOps::show_environment`, the one authoritative
/// implementation of `show-environment`'s grammar, exactly as the mutation
/// under test goes through `TmuxOps::set_environment`: the roundtrip is then a
/// read-back through the *operation*, not through a second hand-written copy of
/// the command that a grammar change could miss. `TmuxOps` builds every command
/// on `tmux::cmd::global()`, so this also addresses the socket the run was given
/// (`scripts/check-tmux-socket.sh` enforces that form).
///
/// A tmux that could not be asked at all collapses into `None` here, which is
/// what this helper has always reported; `Result` is the operation's contract,
/// and a test that needs the distinction asserts it directly on the operation.
pub(crate) async fn tmux_show_environment(session: &str, name: &str) -> Option<String> {
    nession_agent::tmux::ops::TmuxOps::global()
        .show_environment(session, name)
        .await
        .ok()
        .flatten()
}

/// Owns a generated session name and kills the tmux session on drop.
///
/// The tests' own `kill_session` calls only run on the happy path, so a panic
/// between creation and teardown used to leak the session permanently. Drop
/// runs during unwind too, which closes that hole.
pub(crate) struct TestSession {
    name: String,
}

impl TestSession {
    pub(crate) fn new(prefix: &str) -> Self {
        Self {
            name: unique_session_name(prefix),
        }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }
}

impl Drop for TestSession {
    fn drop(&mut self) {
        // Synchronous by necessity: Drop cannot await. A non-zero status just
        // means the test already cleaned up, so the result is ignored.
        //
        // Goes through tmux::cmd like every other tmux call in the workspace, so
        // this kill lands on nession's socket. A bare `tmux kill-session` here
        // would target the developer's real tmux server, where a name collision
        // would kill *their* session.
        let _ = nession_agent::tmux::cmd::global()
            .std()
            .args(["kill-session", "-t", &self.name])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}
