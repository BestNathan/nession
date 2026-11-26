//! Which home and which instance a `logs` read belongs to (#4600 SC-02).
//!
//! The selected home is `$NESSION_HOME` or the documented default. A *live*
//! process may have resolved a different home; its identity records the home
//! and log directory it actually used. The read follows that record — never a
//! default presented as live state — and an explicitly selected home that
//! conflicts with the live instance is refused rather than silently ignored.
//!
//! This module never writes: state files are constructed without
//! `ensure_runtime_dir`, and no state record is cleaned or migrated.

use anyhow::{bail, Result};
use nession_common::logging::LogComponent;
use nession_common::paths;
use std::path::{Path, PathBuf};

use crate::lifecycle::pid_file::{self, ProcessIdentity, StateFiles};

/// A verified live instance discovered from a state file.
#[derive(Debug, Clone)]
pub struct LiveScope {
    pub pid: u32,
    pub state_file: String,
    /// The runtime log directory the process recorded, if it recorded one.
    pub log_dir: Option<PathBuf>,
    /// The home the process recorded, if it recorded one.
    pub home: Option<PathBuf>,
}

/// The resolved read scope.
#[derive(Debug, Clone)]
pub struct LogScope {
    /// The home this invocation selected (env or default).
    pub selected_home: PathBuf,
    /// The home whose history will be read.
    pub home: PathBuf,
    /// A live instance, when one was verified.
    pub live: Option<LiveScope>,
    /// Whether `home` is proven for the live instance (or there is no live
    /// instance and the selected home is simply the history root).
    pub home_verified: bool,
    /// Explanations to print to stderr (never stdout).
    pub notes: Vec<String>,
}

impl LogScope {
    /// The runtime log directory for `component` under the resolved scope.
    pub fn log_dir(&self, component: LogComponent) -> PathBuf {
        match self
            .live
            .as_ref()
            .and_then(|live| live.log_dir.clone())
            .filter(|dir| dir.starts_with(&self.home))
        {
            Some(dir) => dir,
            None => component.logs_dir_under(&self.home),
        }
    }
}

/// Resolve the scope for a read-only `logs` command.
pub fn resolve(component: LogComponent, pid_file: Option<String>) -> Result<LogScope> {
    let selected_home = paths::nession_home()?;
    let explicit_home = std::env::var(paths::NESSION_HOME_ENV)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from);
    let mut pre_notes = Vec::new();

    let state_component = match component {
        LogComponent::Agent => pid_file::Component::Agent,
        LogComponent::Server => pid_file::Component::Server,
    };
    let live = match read_only_state_files(&pid_file, state_component) {
        Ok(files) => {
            let inspection = pid_file::Inspection::of(&files);
            inspection.live().map(|(record, identity)| LiveIdentity {
                identity,
                state_file: record.path.clone(),
            })
        }
        Err(error) => {
            pre_notes.push(format!(
                "cannot inspect daemon state files ({error}); reading the selected home"
            ));
            None
        }
    };

    let mut scope = resolve_from(component, selected_home, explicit_home.as_deref(), live)?;
    pre_notes.append(&mut scope.notes);
    scope.notes = pre_notes;
    Ok(scope)
}

/// A live identity plus the state file that proved it.
#[derive(Debug, Clone)]
pub struct LiveIdentity {
    pub identity: ProcessIdentity,
    pub state_file: String,
}

/// The pure resolution half, testable without process state or environment.
pub fn resolve_from(
    component: LogComponent,
    selected_home: PathBuf,
    explicit_home: Option<&Path>,
    live: Option<LiveIdentity>,
) -> Result<LogScope> {
    let mut notes = Vec::new();
    let Some(LiveIdentity {
        identity,
        state_file,
    }) = live
    else {
        return Ok(LogScope {
            selected_home: selected_home.clone(),
            home: selected_home,
            live: None,
            home_verified: true,
            notes,
        });
    };

    if let Some(recorded) = identity.home.as_deref() {
        let recorded = PathBuf::from(recorded);
        if let Some(explicit) = explicit_home {
            if explicit != recorded {
                bail!(
                    "the live {component} process (pid {}) recorded NESSION_HOME={} but this \
                     command selects NESSION_HOME={}.\n\
                     Fix: unset NESSION_HOME, or point it at {} to read that instance's logs.",
                    identity.pid,
                    recorded.display(),
                    explicit.display(),
                    recorded.display(),
                    component = component.as_str()
                );
            }
        }
        let expected = component.logs_dir_under(&recorded);
        let log_dir = identity
            .log_dir
            .as_deref()
            .map(PathBuf::from)
            .filter(|dir| dir == &expected);
        if log_dir.is_none() && identity.log_dir.is_some() {
            notes.push(format!(
                "the live {component} process recorded log directory {} which is not the \
                 canonical {}; its location is unverified",
                identity.log_dir.as_deref().unwrap_or(""),
                expected.display(),
                component = component.as_str()
            ));
        } else if log_dir.is_none() {
            notes.push(format!(
                "the live {component} process did not record its log directory; \
                 reading {} is unverified",
                expected.display(),
                component = component.as_str()
            ));
        }
        return Ok(LogScope {
            selected_home,
            home: recorded,
            live: Some(LiveScope {
                pid: identity.pid,
                state_file,
                log_dir,
                home: identity.home.clone().map(PathBuf::from),
            }),
            home_verified: true,
            notes,
        });
    }

    // A legacy identity: it proves a live instance but not where that instance
    // logs. Show the selected home separately and say it is unverified.
    notes.push(format!(
        "the live {component} process (pid {}) predates log-scope recording; reading the \
         selected home {} — its log directory is unverified",
        identity.pid,
        selected_home.display(),
        component = component.as_str()
    ));
    if let Some(explicit) = explicit_home {
        notes.push(format!("selected NESSION_HOME={}", explicit.display()));
    }
    Ok(LogScope {
        selected_home: selected_home.clone(),
        home: selected_home,
        live: Some(LiveScope {
            pid: identity.pid,
            state_file,
            log_dir: None,
            home: None,
        }),
        home_verified: false,
        notes,
    })
}

/// The `Logs:` line `status` prints for a live identity.
///
/// Only a directory that is exactly the canonical one under the recorded home
/// is presented as recorded evidence; anything else is explicitly unknown so a
/// default is never advertised as live state (#4600 SC-02).
pub fn describe_status_logs(component: LogComponent, identity: &ProcessIdentity) -> String {
    let canonical = identity
        .home
        .as_deref()
        .map(|home| component.logs_dir_under(Path::new(home)));
    match (identity.log_dir.as_deref(), canonical.as_deref()) {
        (Some(log_dir), Some(canonical)) if Path::new(log_dir) == canonical => {
            format!("Logs: {log_dir} (recorded by the running process)")
        }
        (Some(log_dir), Some(_)) => format!(
            "Logs: unknown (recorded {log_dir} is not the canonical location under the \
             recorded home); use `nession {} logs` to read the selected home",
            component.as_str()
        ),
        (Some(log_dir), None) => format!(
            "Logs: unknown (recorded {log_dir} without a recorded home); use `nession {} \
             logs` to read the selected home",
            component.as_str()
        ),
        (None, Some(home)) => format!(
            "Logs: unknown (the running process did not record its log directory); \
             recorded home: {}",
            home.display()
        ),
        (None, None) => format!(
            "Logs: unknown (the running process predates log-scope recording); \
             use `nession {} logs` to read the selected home",
            component.as_str()
        ),
    }
}

/// The state locations to inspect without creating the runtime directory.
///
/// `StateFiles::from_cli` calls `ensure_runtime_dir`, which is a write. A
/// read-only command must not create state just to look for it.
fn read_only_state_files(
    explicit: &Option<String>,
    component: pid_file::Component,
) -> Result<StateFiles> {
    if let Some(path) = explicit.clone() {
        return Ok(StateFiles::explicit(path));
    }
    let (current, legacy) = match component {
        pid_file::Component::Agent => (paths::agent_pid_path(), paths::legacy_agent_pid_path()),
        pid_file::Component::Server => (paths::server_pid_path(), paths::legacy_server_pid_path()),
    };
    Ok(StateFiles {
        current: current?.to_string_lossy().into_owned(),
        legacy: legacy.ok().map(|path| path.to_string_lossy().into_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::pid_file::ConfigRecord;

    fn identity(home: Option<&str>, log_dir: Option<&str>) -> ProcessIdentity {
        ProcessIdentity {
            pid: 1234,
            started_at: 1_700_000_000,
            kind: pid_file::Component::Agent,
            config_source: ConfigRecord::Unknown,
            release_version: None,
            log_dir: log_dir.map(ToString::to_string),
            home: home.map(ToString::to_string),
        }
    }

    #[test]
    fn no_live_instance_reads_the_selected_home() {
        let home = PathBuf::from("/selected");
        let scope = resolve_from(LogComponent::Agent, home.clone(), None, None).unwrap();
        assert_eq!(scope.home, home);
        assert!(scope.home_verified);
        assert!(scope.notes.is_empty());
    }

    #[test]
    fn a_verified_live_identity_selects_its_recorded_home_and_logs() {
        let recorded = "/recorded";
        let log_dir = "/recorded/agent/logs";
        let scope = resolve_from(
            LogComponent::Agent,
            PathBuf::from("/selected"),
            None,
            Some(LiveIdentity {
                identity: identity(Some(recorded), Some(log_dir)),
                state_file: "/run/agent.pid".to_string(),
            }),
        )
        .unwrap();
        assert_eq!(scope.home, PathBuf::from(recorded));
        assert_eq!(scope.log_dir(LogComponent::Agent), PathBuf::from(log_dir));
        assert!(scope.home_verified);
        assert!(scope.notes.is_empty(), "{:?}", scope.notes);
    }

    #[test]
    fn an_explicit_home_conflicting_with_the_live_instance_is_refused() {
        let error = resolve_from(
            LogComponent::Agent,
            PathBuf::from("/selected"),
            Some(Path::new("/selected")),
            Some(LiveIdentity {
                identity: identity(Some("/recorded"), Some("/recorded/agent/logs")),
                state_file: "/run/agent.pid".to_string(),
            }),
        )
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains("recorded NESSION_HOME=/recorded"),
            "{message}"
        );
        assert!(
            message.contains("selects NESSION_HOME=/selected"),
            "{message}"
        );
    }

    #[test]
    fn an_explicit_home_matching_the_live_instance_is_accepted() {
        let scope = resolve_from(
            LogComponent::Agent,
            PathBuf::from("/recorded"),
            Some(Path::new("/recorded")),
            Some(LiveIdentity {
                identity: identity(Some("/recorded"), Some("/recorded/agent/logs")),
                state_file: "/run/agent.pid".to_string(),
            }),
        )
        .unwrap();
        assert_eq!(scope.home, PathBuf::from("/recorded"));
    }

    #[test]
    fn a_legacy_identity_is_explicitly_unverified() {
        let scope = resolve_from(
            LogComponent::Agent,
            PathBuf::from("/selected"),
            Some(Path::new("/selected")),
            Some(LiveIdentity {
                identity: identity(None, None),
                state_file: "/run/agent.pid".to_string(),
            }),
        )
        .unwrap();
        assert!(!scope.home_verified);
        assert_eq!(scope.home, PathBuf::from("/selected"));
        assert_eq!(scope.selected_home, PathBuf::from("/selected"));
        let text = scope.notes.join("\n");
        assert!(text.contains("unverified"), "{text}");
        assert!(text.contains("selected home"), "{text}");
    }

    #[test]
    fn status_reports_only_a_canonical_recorded_log_directory() {
        let verified = identity(Some("/home/me"), Some("/home/me/agent/logs"));
        let line = describe_status_logs(LogComponent::Agent, &verified);
        assert_eq!(
            line,
            "Logs: /home/me/agent/logs (recorded by the running process)"
        );

        let non_canonical = identity(Some("/home/me"), Some("/elsewhere/logs"));
        let line = describe_status_logs(LogComponent::Agent, &non_canonical);
        assert!(line.contains("unknown"), "{line}");
        assert!(line.contains("not the canonical"), "{line}");

        let legacy = identity(None, None);
        let line = describe_status_logs(LogComponent::Agent, &legacy);
        assert!(line.contains("unknown"), "{line}");
        assert!(line.contains("predates"), "{line}");

        let missing_dir = identity(Some("/home/me"), None);
        let line = describe_status_logs(LogComponent::Server, &missing_dir);
        assert!(line.contains("did not record"), "{line}");
        assert!(line.contains("/home/me"), "{line}");
    }

    #[test]
    fn a_non_canonical_recorded_log_directory_is_not_trusted() {
        let scope = resolve_from(
            LogComponent::Agent,
            PathBuf::from("/selected"),
            None,
            Some(LiveIdentity {
                identity: identity(Some("/recorded"), Some("/elsewhere/logs")),
                state_file: "/run/agent.pid".to_string(),
            }),
        )
        .unwrap();
        assert_eq!(scope.home, PathBuf::from("/recorded"));
        assert_eq!(
            scope.log_dir(LogComponent::Agent),
            PathBuf::from("/recorded/agent/logs")
        );
        assert!(
            scope.notes.join("\n").contains("not the canonical"),
            "{:?}",
            scope.notes
        );
    }
}
