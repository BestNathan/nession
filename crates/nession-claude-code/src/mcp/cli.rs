//! The `claude` CLI as this capability's native MCP configuration adapter
//! (#3600).
//!
//! ## Why a subprocess
//!
//! `~/.claude.json` is Claude Code's file. Its shape carries migration state,
//! project keys and fields this capability does not model, and a second writer
//! would be a second source of truth for a format we do not own. The CLI is the
//! native adapter; this module builds it as an argument vector and never
//! through a shell.
//!
//! ## The Session's environment, not the Agent's
//!
//! Every invocation runs in the Session's cwd with the Session's observed
//! `HOME` and `CLAUDE_CONFIG_DIR`. The Agent daemon's own `HOME` must not leak
//! in: it may belong to a different OS user, and it would read or write a
//! configuration the Session's Claude never sees. `PATH` is the Session's, so
//! the `claude` that runs is the one the user installed.
//!
//! ## Version gate
//!
//! `claude mcp add-json` and `claude mcp remove --scope` are the operations
//! this view relies on. A CLI that is missing, unparseable or older than
//! [`MIN_VERSION`] is answered as unsupported; this capability does not fall
//! back to editing the state file.

use std::process::Stdio;
use std::time::Duration;

use tokio::io::AsyncReadExt;
use tokio::process::Command;

use crate::session_context::SessionContext;

use super::config::Roots;

/// The oldest CLI behaviour this adapter relies on.
pub const MIN_VERSION: Version = Version {
    major: 2,
    minor: 0,
    patch: 0,
};

/// Bound on one CLI invocation. Configuration writes are local and small.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(20);
/// Bound on captured stdout or stderr. The CLI's messages are short; a larger
/// stream is drained and marked truncated rather than buffered.
pub const MAX_OUTPUT_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
}

impl std::fmt::Display for Version {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

impl Version {
    /// The first `major.minor.patch` token in a version banner.
    pub fn parse(text: &str) -> Option<Self> {
        for token in text.split_whitespace() {
            let cleaned = token.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
            let mut parts = cleaned.split('.');
            let (Some(major), Some(minor), Some(patch)) =
                (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            if let (Ok(major), Ok(minor), Ok(patch)) = (major.parse(), minor.parse(), patch.parse())
            {
                return Some(Self {
                    major,
                    minor,
                    patch,
                });
            }
        }
        None
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Availability {
    Available(ClaudeCli),
    Unavailable(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeCli {
    pub version: Version,
    pub version_text: String,
}

/// The environment one `claude` child gets.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommandEnvironment {
    pub home: String,
    pub config_dir: Option<String>,
    pub path: Option<String>,
}

/// Read the Session values the CLI needs.
///
/// `None` from a variable lookup means the host could not ask; for `PATH` that
/// falls back to the Agent's inherited value, which is the ordinary case. For
/// `HOME` it cannot fall back — [`Roots`] already required an observed one.
pub async fn command_environment(
    context: &dyn SessionContext,
    session_id: &str,
    roots: &Roots,
) -> CommandEnvironment {
    let path = context
        .session_environment_variable(session_id, "PATH")
        .await
        .flatten();
    CommandEnvironment {
        home: roots.home.to_string_lossy().into_owned(),
        config_dir: roots
            .config_dir_is_explicit
            .then(|| roots.config_dir.to_string_lossy().into_owned()),
        path,
    }
}

fn command(program: &str, roots: &Roots, environment: &CommandEnvironment) -> Command {
    let mut command = Command::new(program);
    command
        .current_dir(&roots.cwd)
        .env("HOME", &environment.home)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    match &environment.config_dir {
        Some(config_dir) => {
            command.env("CLAUDE_CONFIG_DIR", config_dir);
        }
        // The Agent's value is not the Session's. Removing it after the child
        // inherits lets Claude resolve the default from the Session's HOME.
        None => {
            command.env_remove("CLAUDE_CONFIG_DIR");
        }
    }
    if let Some(path) = &environment.path {
        command.env("PATH", path);
    }
    command
}

fn claude_program() -> &'static str {
    if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    }
}

/// A bounded read that keeps draining, so a chatty child never blocks on a
/// full pipe after the retained prefix is complete.
async fn read_bounded<R: tokio::io::AsyncRead + Unpin>(mut reader: R) -> (Vec<u8>, bool) {
    let mut retained = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut truncated = false;
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let room = MAX_OUTPUT_BYTES.saturating_sub(retained.len());
                if room == 0 {
                    truncated = true;
                } else if read > room {
                    retained.extend_from_slice(chunk.get(..room).unwrap_or(chunk.as_slice()));
                    truncated = true;
                } else {
                    retained.extend_from_slice(chunk.get(..read).unwrap_or(chunk.as_slice()));
                }
            }
        }
    }
    (retained, truncated)
}

async fn collect(
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
) -> (Vec<u8>, bool, Vec<u8>, bool) {
    let stdout_task = tokio::spawn(async move {
        match stdout {
            Some(reader) => read_bounded(reader).await,
            None => (Vec::new(), false),
        }
    });
    let stderr_task = tokio::spawn(async move {
        match stderr {
            Some(reader) => read_bounded(reader).await,
            None => (Vec::new(), false),
        }
    });
    let (stdout, stdout_truncated) = stdout_task.await.unwrap_or((Vec::new(), false));
    let (stderr, stderr_truncated) = stderr_task.await.unwrap_or((Vec::new(), false));
    (stdout, stdout_truncated, stderr, stderr_truncated)
}

/// Detect the CLI in the Session's context and enforce the version gate.
pub async fn detect(context: &dyn SessionContext, session_id: &str, roots: &Roots) -> Availability {
    let environment = command_environment(context, session_id, roots).await;
    let spawned = command(claude_program(), roots, &environment)
        .arg("--version")
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => return Availability::Unavailable(format!("claude CLI not found: {error}")),
    };
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let status = tokio::time::timeout(COMMAND_TIMEOUT, child.wait()).await;
    if status.is_err() {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let (stdout, _, stderr, _) = collect(stdout, stderr).await;
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    );
    let Some(version) = Version::parse(&text) else {
        return Availability::Unavailable("claude CLI did not report a version".to_string());
    };
    if version < MIN_VERSION {
        return Availability::Unavailable(format!(
            "claude CLI {version} is older than {MIN_VERSION}"
        ));
    }
    let version_text = text
        .lines()
        .find(|line| line.contains(&version.to_string()))
        .unwrap_or_default()
        .trim()
        .to_string();
    Availability::Available(ClaudeCli {
        version,
        version_text,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOutput {
    pub success: bool,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
}

/// The one operation a mutation needs from the native CLI.
///
/// A trait rather than a direct call so a unit test can exercise the write,
/// readback, conflict and rollback paths without a real `claude` binary or a
/// shell. Production uses [`NativeCli`], which is the only implementation that
/// starts a process.
#[async_trait::async_trait]
pub trait McpCli: Send + Sync {
    async fn run(
        &self,
        context: &dyn SessionContext,
        session_id: &str,
        roots: &Roots,
        arguments: &[String],
    ) -> Result<CliOutput, String>;
}

/// The process-backed adapter.
pub struct NativeCli;

#[async_trait::async_trait]
impl McpCli for NativeCli {
    async fn run(
        &self,
        context: &dyn SessionContext,
        session_id: &str,
        roots: &Roots,
        arguments: &[String],
    ) -> Result<CliOutput, String> {
        run_mcp(context, session_id, roots, arguments).await
    }
}

/// Run one `claude mcp ...` invocation.
///
/// `arguments` excludes the program and the `mcp` verb: callers pass the
/// subcommand onward, and every element is a separate argv entry. There is no
/// shell and no string concatenation.
pub async fn run_mcp(
    context: &dyn SessionContext,
    session_id: &str,
    roots: &Roots,
    arguments: &[String],
) -> Result<CliOutput, String> {
    let environment = command_environment(context, session_id, roots).await;
    let mut claude = command(claude_program(), roots, &environment);
    claude.arg("mcp");
    for argument in arguments {
        claude.arg(argument);
    }
    let mut child = claude.spawn().map_err(|error| error.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let waited = tokio::time::timeout(COMMAND_TIMEOUT, child.wait()).await;
    let timed_out = waited.is_err();
    if timed_out {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
    let status = waited.ok().and_then(Result::ok);
    let (stdout, stdout_truncated, stderr, stderr_truncated) = collect(stdout, stderr).await;
    Ok(CliOutput {
        success: status.is_some_and(|status| status.success()),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        timed_out,
        truncated: stdout_truncated || stderr_truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::config::Roots;
    use crate::mcp::test_support::install_executable_fixture;
    use crate::session_context::SessionClaudeConfig;
    use async_trait::async_trait;
    use std::fs;
    use tempfile::TempDir;

    struct FixedContext {
        cwd: String,
        home: String,
        config_dir: Option<String>,
        path: String,
    }

    #[async_trait]
    impl SessionContext for FixedContext {
        async fn session_cwd(&self, _session_id: &str) -> Option<String> {
            Some(self.cwd.clone())
        }
        async fn session_claude_config(&self, _session_id: &str) -> Option<SessionClaudeConfig> {
            Some(SessionClaudeConfig {
                home: Some(self.home.clone()),
                config_dir: self.config_dir.clone(),
                ..SessionClaudeConfig::default()
            })
        }
        async fn session_claude_active(&self, _session_id: &str) -> Option<bool> {
            None
        }
        async fn session_claude_binding(
            &self,
            _session_id: &str,
        ) -> Option<crate::binding::Binding> {
            None
        }
        async fn session_environment_variable(
            &self,
            _session_id: &str,
            name: &str,
        ) -> Option<Option<String>> {
            (name == "PATH").then(|| Some(self.path.clone()))
        }
    }

    fn fixture(
        version_banner: &str,
        record: Option<&std::path::Path>,
    ) -> (TempDir, Roots, FixedContext, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let bin = temp.path().join("bin");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let record_line = record
            .map(|path| format!("printf '%s\\n' \"$@\" > '{}'\n", path.display()))
            .unwrap_or_default();
        let script = format!(
            "#!/bin/sh\n{record_line}\nif [ \"$1\" = \"--version\" ]; then echo '{version_banner}'; exit 0; fi\necho 'Added stdio MCP server fixture to local config'\n"
        );
        let claude = bin.join("claude");
        install_executable_fixture(&claude, &script);
        let roots = Roots {
            cwd: cwd.clone(),
            canonical_cwd: cwd.clone(),
            home: home.clone(),
            config_dir: home.join(".claude"),
            config_dir_is_explicit: false,
            state_file: home.join(".claude.json"),
            project_file: cwd.join(".mcp.json"),
            managed_file: None,
        };
        let context = FixedContext {
            cwd: cwd.to_string_lossy().into_owned(),
            home: home.to_string_lossy().into_owned(),
            config_dir: None,
            path: bin.to_string_lossy().into_owned(),
        };
        (temp, roots, context, bin)
    }

    #[test]
    fn a_version_banner_is_parsed_from_the_common_shapes() {
        assert_eq!(
            Version::parse("2.1.325 (Claude Code)"),
            Some(Version {
                major: 2,
                minor: 1,
                patch: 325
            })
        );
        assert_eq!(
            Version::parse("claude 2.0.1"),
            Some(Version {
                major: 2,
                minor: 0,
                patch: 1
            })
        );
        assert_eq!(Version::parse("no version here"), None);
    }

    #[test]
    fn the_minimum_version_is_two_zero_zero() {
        assert!(Version::parse("2.0.0").unwrap() >= MIN_VERSION);
        assert!(Version::parse("1.9.9").unwrap() < MIN_VERSION);
    }

    #[tokio::test]
    async fn detect_accepts_a_supported_cli() {
        let (_temp, roots, context, _bin) = fixture("2.1.325 (Claude Code)", None);
        assert_eq!(
            detect(&context, "agent:s", &roots).await,
            Availability::Available(ClaudeCli {
                version: Version {
                    major: 2,
                    minor: 1,
                    patch: 325
                },
                version_text: "2.1.325 (Claude Code)".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn detect_refuses_a_cli_older_than_the_adapter() {
        let (_temp, roots, context, _bin) = fixture("1.0.0 (Claude Code)", None);
        match detect(&context, "agent:s", &roots).await {
            Availability::Unavailable(reason) => assert!(reason.contains("older than")),
            other => panic!("expected an unsupported CLI, got {other:?}"),
        }
    }

    /// SC-03 (#4080): the CLI child runs with the Session's observed
    /// environment. An override is used as-is; a variable the host cannot
    /// observe is left to the Agent's inherited environment rather than
    /// invented.
    #[tokio::test]
    async fn the_session_path_is_used_and_an_unobservable_one_inherits_the_agent_path() {
        let (_temp, roots, context, bin) = fixture("2.1.325 (Claude Code)", None);
        let environment = command_environment(&context, "agent:s", &roots).await;
        assert_eq!(
            environment.path.as_deref(),
            Some(bin.to_string_lossy().as_ref()),
            "the Session's PATH must be the one the CLI child gets"
        );
        assert_eq!(
            environment.home,
            roots.home.to_string_lossy(),
            "the observed Session HOME is the child's HOME"
        );

        let fallback =
            command_environment(&crate::session_context::NoSessionContext, "agent:s", &roots).await;
        assert_eq!(fallback.path, None);
        let command = command("claude", &roots, &fallback);
        assert!(
            !command
                .as_std()
                .get_envs()
                .any(|(key, _)| key == std::ffi::OsStr::new("PATH")),
            "an unobservable Session must inherit the Agent PATH, not get a fabricated one"
        );
    }

    #[tokio::test]
    async fn detect_refuses_a_missing_cli() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let roots = Roots {
            cwd: cwd.clone(),
            canonical_cwd: cwd.clone(),
            home: home.clone(),
            config_dir: home.join(".claude"),
            config_dir_is_explicit: false,
            state_file: home.join(".claude.json"),
            project_file: cwd.join(".mcp.json"),
            managed_file: None,
        };
        let context = FixedContext {
            cwd: cwd.to_string_lossy().into_owned(),
            home: home.to_string_lossy().into_owned(),
            config_dir: None,
            path: temp.path().join("empty").to_string_lossy().into_owned(),
        };
        match detect(&context, "agent:s", &roots).await {
            Availability::Unavailable(reason) => assert!(reason.contains("not found")),
            other => panic!("expected a missing CLI, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn run_mcp_passes_arguments_without_a_shell() {
        let temp = TempDir::new().unwrap();
        let record = temp.path().join("argv.txt");
        let (_fixture, roots, context, _bin) = fixture("2.1.325 (Claude Code)", Some(&record));
        let output = run_mcp(
            &context,
            "agent:s",
            &roots,
            &[
                "add-json".to_string(),
                "--scope".to_string(),
                "local".to_string(),
                "server".to_string(),
                r#"{"type":"stdio","command":"tool arg"}"#.to_string(),
            ],
        )
        .await
        .unwrap();
        assert!(output.success, "{output:?}");
        let recorded = fs::read_to_string(&record).unwrap();
        let lines: Vec<&str> = recorded.lines().collect();
        assert_eq!(lines[0], "mcp");
        assert_eq!(lines[1], "add-json");
        assert_eq!(lines[5], r#"{"type":"stdio","command":"tool arg"}"#);
    }

    #[tokio::test]
    async fn the_child_gets_the_sessions_home_and_not_the_agents_config_dir() {
        let temp = TempDir::new().unwrap();
        let record = temp.path().join("env.txt");
        let home = temp.path().join("home");
        let bin = temp.path().join("bin");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 2.1.325; exit 0; fi\necho \"HOME=$HOME\" > '{}'\necho \"CONFIG=${{CLAUDE_CONFIG_DIR-unset}}\" >> '{}'\n",
            record.display(),
            record.display()
        );
        install_executable_fixture(&bin.join("claude"), &script);
        let roots = Roots {
            cwd: cwd.clone(),
            canonical_cwd: cwd.clone(),
            home: home.clone(),
            config_dir: home.join(".claude"),
            config_dir_is_explicit: false,
            state_file: home.join(".claude.json"),
            project_file: cwd.join(".mcp.json"),
            managed_file: None,
        };
        let context = FixedContext {
            cwd: cwd.to_string_lossy().into_owned(),
            home: home.to_string_lossy().into_owned(),
            config_dir: None,
            path: bin.to_string_lossy().into_owned(),
        };
        run_mcp(&context, "agent:s", &roots, &["list".to_string()])
            .await
            .unwrap();
        let recorded = fs::read_to_string(&record).unwrap();
        assert!(recorded.contains(&format!("HOME={}", home.display())));
        assert!(recorded.contains("CONFIG=unset"), "{recorded}");
    }
}
