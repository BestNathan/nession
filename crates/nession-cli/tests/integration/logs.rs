#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

//! `nession agent|server logs` through the real CLI in an isolated home
//! (#4600 SC-01/02/04).
//!
//! Every case owns a temporary `NESSION_HOME` and `NESSION_RUNTIME_DIR`; no
//! production path, daemon or network is touched.

use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use tempfile::TempDir;

fn nession(home: &TempDir) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_nession"));
    command
        .env("NESSION_NO_UPDATE_CHECK", "1")
        .env("NESSION_HOME", home.path())
        .env("NESSION_RUNTIME_DIR", home.path().join("runtime"))
        .env_remove("NESSION_SERVER_URL")
        .env_remove("NESSION_AUTH_TOKEN");
    command
}

fn stdout(output: &Output) -> String {
    String::from_utf8_lossy(&output.stdout).into_owned()
}

fn stderr(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr).into_owned()
}

fn run(home: &TempDir, args: &[&str]) -> Output {
    nession(home).args(args).output().expect("run nession logs")
}

fn log_line(second: u32, level: &str, target: &str, message: &str) -> String {
    format!("2026-11-26T10:00:{second:02}.000000Z  {level} {target}: {message}")
}

fn write_runtime_log(home: &TempDir, component: &str, name: &str, lines: &[String]) {
    let dir = home.path().join(component).join("logs");
    std::fs::create_dir_all(&dir).unwrap();
    let mut content = lines.join("\n");
    if !lines.is_empty() {
        content.push('\n');
    }
    std::fs::write(dir.join(name), content).unwrap();
}

#[test]
fn both_leaves_expose_the_same_documented_options() {
    for leaf in ["agent", "server"] {
        let output = run_for_help(leaf);
        assert!(output.status.success(), "{leaf} logs --help failed");
        let help = stdout(&output);
        for option in [
            "--tail",
            "--follow",
            "--since",
            "--until",
            "--level",
            "--target",
            "--path",
            "--source",
            "--pid-file",
        ] {
            assert!(
                help.contains(option),
                "{leaf} logs help lacks {option}: {help}"
            );
        }
        assert!(
            help.contains("100"),
            "default tail must be documented: {help}"
        );
        for source in ["runtime", "startup", "service"] {
            assert!(
                help.contains(source),
                "{leaf} help lacks source {source}: {help}"
            );
        }
    }
}

fn run_for_help(leaf: &str) -> Output {
    let directory = tempfile::tempdir().unwrap();
    run(&directory, &[leaf, "logs", "--help"])
}

#[test]
fn the_default_tail_is_one_hundred_matching_lines_and_zero_is_allowed() {
    let home = tempfile::tempdir().unwrap();
    let lines: Vec<String> = (0..150)
        .map(|index| log_line(index % 60, "INFO", "app", &format!("record {index}")))
        .collect();
    write_runtime_log(&home, "agent", "nession-agent.2026-11-26", &lines);

    let output = run(&home, &["agent", "logs"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let text = stdout(&output);
    let printed: Vec<&str> = text.lines().collect();
    assert_eq!(printed.len(), 100, "default tail must be 100");
    assert!(printed[0].contains("record 50"), "{}", printed[0]);
    assert!(printed[99].contains("record 149"), "{}", printed[99]);
    assert!(!printed[0].contains("record 49"));

    let output = run(&home, &["agent", "logs", "-n", "0"]);
    assert!(output.status.success());
    assert!(stdout(&output).is_empty(), "{}", stdout(&output));
}

#[test]
fn filters_run_before_the_tail() {
    let home = tempfile::tempdir().unwrap();
    let lines: Vec<String> = (0..40)
        .map(|index| {
            log_line(
                index % 60,
                if index % 2 == 0 { "INFO" } else { "WARN" },
                if index % 5 == 0 {
                    "nession_agent::ws"
                } else {
                    "nession_agent::other"
                },
                &format!("record {index}"),
            )
        })
        .collect();
    write_runtime_log(&home, "agent", "nession-agent", &lines);

    let output = run(&home, &["agent", "logs", "-n", "3", "--level", "warn"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let text = stdout(&output);
    let printed: Vec<&str> = text.lines().collect();
    assert_eq!(printed.len(), 3, "{printed:?}");
    assert!(
        printed.iter().all(|line| line.contains(" WARN ")),
        "{printed:?}"
    );
    assert!(printed[2].contains("record 39"), "{printed:?}");

    let output = run(
        &home,
        &["agent", "logs", "-n", "2", "--target", "nession_agent::ws"],
    );
    let text = stdout(&output);
    let printed: Vec<&str> = text.lines().collect();
    assert_eq!(printed.len(), 2, "{printed:?}");
    assert!(
        printed
            .iter()
            .all(|line| line.contains("nession_agent::ws:")),
        "{printed:?}"
    );
}

#[test]
fn time_bounds_accept_utc_and_offsets() {
    let home = tempfile::tempdir().unwrap();
    let lines = vec![
        "2026-11-26T09:00:00.000000Z  INFO app: early".to_string(),
        "2026-11-26T10:00:00.000000Z  INFO app: middle".to_string(),
        "2026-11-26T11:00:00.000000Z  INFO app: late".to_string(),
    ];
    write_runtime_log(&home, "agent", "nession-agent", &lines);

    let output = run(
        &home,
        &[
            "agent",
            "logs",
            "--since",
            "2026-11-26T11:00:00+01:00",
            "--until",
            "2026-11-26T10:30:00Z",
        ],
    );
    assert!(output.status.success(), "{}", stderr(&output));
    let printed = stdout(&output);
    assert!(printed.contains("middle"), "{printed}");
    assert!(!printed.contains("early"), "{printed}");
    assert!(!printed.contains("late"), "{printed}");
}

#[test]
fn path_only_prints_locations_without_content() {
    let home = tempfile::tempdir().unwrap();
    write_runtime_log(
        &home,
        "agent",
        "nession-agent.2026-11-26",
        &[log_line(1, "INFO", "app", "do-not-print-me")],
    );

    let output = run(&home, &["agent", "logs", "--path"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let printed = stdout(&output);
    assert!(
        printed.contains("nession-agent.2026-11-26"),
        "the resolved file must be printed: {printed}"
    );
    assert!(!printed.contains("do-not-print-me"), "{printed}");

    // Missing history: the directory is the resolved location, and the
    // absence is stated on stderr (not indistinguishable from an error).
    let empty = tempfile::tempdir().unwrap();
    let output = run(&empty, &["server", "logs", "--path"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let printed = stdout(&output);
    assert!(printed.contains("server/logs"), "{printed}");
    assert!(
        stderr(&output).contains("no runtime log files"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn missing_history_is_not_an_error() {
    let home = tempfile::tempdir().unwrap();
    let output = run(&home, &["server", "logs"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(stdout(&output).is_empty());
    assert!(
        stderr(&output).contains("no runtime log files"),
        "{}",
        stderr(&output)
    );
}

#[test]
fn invalid_combinations_are_refused_explicitly() {
    let home = tempfile::tempdir().unwrap();
    let cases: &[&[&str]] = &[
        &["agent", "logs", "--path", "--follow"],
        &["agent", "logs", "--path", "-n", "5"],
        &["agent", "logs", "--source", "startup", "--level", "warn"],
        &["agent", "logs", "--source", "startup", "--target", "x"],
        &["server", "logs", "--source", "service"],
        &[
            "agent",
            "logs",
            "--since",
            "2026-11-26T13:00:00Z",
            "--until",
            "2026-11-26T12:00:00Z",
        ],
    ];
    for argv in cases {
        let output = run(&home, argv);
        assert!(
            !output.status.success(),
            "{argv:?} must be refused: {} {}",
            stdout(&output),
            stderr(&output)
        );
        assert!(
            !stderr(&output).is_empty(),
            "{argv:?} must explain the refusal"
        );
    }
}

#[cfg(unix)]
#[test]
fn a_permission_failure_is_not_reported_as_empty_history() {
    use std::os::unix::fs::PermissionsExt;
    let home = tempfile::tempdir().unwrap();
    write_runtime_log(
        &home,
        "agent",
        "nession-agent",
        &[log_line(1, "INFO", "app", "unreadable")],
    );
    let logs = home.path().join("agent").join("logs");
    std::fs::set_permissions(&logs, std::fs::Permissions::from_mode(0o000)).unwrap();
    // Root can still read the directory; the distinction only exists for
    // ordinary users, so skip the assertion there.
    if std::fs::read_dir(&logs).is_ok() {
        std::fs::set_permissions(&logs, std::fs::Permissions::from_mode(0o700)).unwrap();
        return;
    }
    let output = run(&home, &["agent", "logs"]);
    std::fs::set_permissions(&logs, std::fs::Permissions::from_mode(0o700)).unwrap();

    assert!(!output.status.success(), "a permission failure must fail");
    let error = stderr(&output).to_ascii_lowercase();
    assert!(error.contains("permission denied"), "{error}");
}

#[test]
fn logs_does_not_recover_a_pending_install_transaction() {
    let home = tempfile::tempdir().unwrap();
    write_runtime_log(
        &home,
        "agent",
        "nession-agent",
        &[log_line(1, "INFO", "app", "history")],
    );
    let journal = home.path().join(".install-transaction.json");
    std::fs::write(&journal, "not a valid journal\n").unwrap();

    let output = run(&home, &["agent", "logs"]);
    assert!(
        output.status.success(),
        "read-only logs must not fail on a pending journal: {}",
        stderr(&output)
    );
    assert!(stdout(&output).contains("history"));
    assert!(
        stderr(&output).contains("install transaction journal exists"),
        "the pending boundary must be reported: {}",
        stderr(&output)
    );
    assert_eq!(
        std::fs::read_to_string(&journal).unwrap(),
        "not a valid journal\n",
        "logs must not mutate or remove the journal"
    );
}

#[test]
fn unrelated_files_and_symlinks_are_excluded() {
    let home = tempfile::tempdir().unwrap();
    write_runtime_log(
        &home,
        "agent",
        "nession-agent.2026-11-26",
        &[log_line(1, "INFO", "app", "included")],
    );
    let logs = home.path().join("agent").join("logs");
    std::fs::write(
        logs.join("nession-agent.out"),
        "nession-agent.out: excluded\n",
    )
    .unwrap();
    std::fs::write(logs.join("notes.txt"), "notes.txt: excluded\n").unwrap();
    std::fs::write(
        logs.join("nession-server.2026-11-26"),
        "nession-server: excluded\n",
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(
        logs.join("nession-agent.2026-11-26"),
        logs.join("nession-agent.2026-11-27"),
    )
    .unwrap();

    let output = run(&home, &["agent", "logs", "-n", "20"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let printed = stdout(&output);
    assert!(printed.contains("included"), "{printed}");
    assert!(!printed.contains("excluded"), "{printed}");
}

#[test]
fn runtime_names_across_rotations_are_read_oldest_first() {
    let home = tempfile::tempdir().unwrap();
    write_runtime_log(
        &home,
        "agent",
        "nession-agent.2026-11-24",
        &[log_line(1, "INFO", "app", "oldest")],
    );
    write_runtime_log(
        &home,
        "agent",
        "nession-agent.2026-11-25-23",
        &[log_line(2, "INFO", "app", "hourly")],
    );
    write_runtime_log(
        &home,
        "agent",
        "nession-agent.2026-11-26",
        &[log_line(3, "INFO", "app", "newest")],
    );

    let output = run(&home, &["agent", "logs", "-n", "10"]);
    let text = stdout(&output);
    let printed: Vec<&str> = text.lines().collect();
    assert_eq!(printed.len(), 3, "{printed:?}");
    assert!(printed[0].contains("oldest"));
    assert!(printed[1].contains("hourly"));
    assert!(printed[2].contains("newest"));
}

#[test]
fn the_startup_source_is_raw_and_rejects_parsed_filters() {
    let home = tempfile::tempdir().unwrap();
    let startup = home.path().join("agent").join("logs").join("startup");
    std::fs::create_dir_all(&startup).unwrap();
    std::fs::write(
        startup.join("startup.log"),
        "2026-11-26T10:00:00.000Z agent config: malformed agent config\n\
         2026-11-26T10:05:00.000Z agent readiness: missed deadline\n",
    )
    .unwrap();

    let output = run(&home, &["agent", "logs", "--source", "startup", "-n", "1"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let printed = stdout(&output);
    assert!(printed.contains("missed deadline"), "{printed}");
    assert!(!printed.contains("malformed"), "{printed}");
}

#[test]
fn a_malformed_config_leaves_a_retrievable_startup_diagnostic() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(
        home.path().join("agent-config.toml"),
        "[agent\nthis is not toml\n",
    )
    .unwrap();

    let output = run(&home, &["agent", "start", "--foreground"]);
    assert!(!output.status.success(), "the start must fail");
    assert!(
        stderr(&output).contains("failed to parse agent config"),
        "{}",
        stderr(&output)
    );

    let output = run(&home, &["agent", "logs", "--source", "startup", "-n", "20"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let printed = stdout(&output);
    assert!(printed.contains("config:"), "{printed}");
    assert!(printed.contains("failed to parse"), "{printed}");
}

#[test]
fn an_unusable_log_directory_states_startup_capture_unavailability() {
    let home = tempfile::tempdir().unwrap();
    // A file where the logs directory should be makes every log-path
    // operation, including the startup capture beside it, fail.
    std::fs::write(home.path().join("agent"), "not a directory").unwrap();

    let output = run(&home, &["agent", "start", "--foreground"]);
    assert!(!output.status.success(), "the start must fail");
    let error = stderr(&output);
    assert!(
        error.contains("startup diagnostics"),
        "the failure must state the capture outcome: {error}"
    );
}

#[test]
fn logs_is_read_only_and_does_not_create_runtime_state() {
    let home = tempfile::tempdir().unwrap();
    write_runtime_log(
        &home,
        "agent",
        "nession-agent.2026-11-26",
        &[log_line(1, "INFO", "app", "read-only")],
    );
    std::fs::write(
        home.path().join("agent-config.toml"),
        "agent_id = \"protected\"\n",
    )
    .unwrap();
    let runtime = home.path().join("runtime");
    assert!(!runtime.exists());

    let before: Vec<(PathBuf, u64, std::time::SystemTime)> = collect(home.path());
    let output = run(&home, &["agent", "logs"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let after: Vec<(PathBuf, u64, std::time::SystemTime)> = collect(home.path());

    assert_eq!(
        before, after,
        "logs must not modify config, identity or log roots"
    );
    assert!(
        !runtime.exists(),
        "logs must not create the runtime directory just to look for a daemon"
    );
}

fn collect(root: &Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    let mut entries = Vec::new();
    collect_into(root, &mut entries);
    entries.sort();
    entries
}

fn collect_into(root: &Path, entries: &mut Vec<(PathBuf, u64, std::time::SystemTime)>) {
    let Ok(read) = std::fs::read_dir(root) else {
        return;
    };
    for entry in read.flatten() {
        let path = entry.path();
        let metadata = entry.metadata().unwrap();
        if metadata.is_dir() {
            collect_into(&path, entries);
        } else {
            entries.push((path, metadata.len(), metadata.modified().unwrap()));
        }
    }
}

#[cfg(unix)]
fn write_executable(path: &Path, body: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

#[cfg(unix)]
fn archive(home: &TempDir, version: &str, cli_body: &str) -> PathBuf {
    let root = home.path().join("versions").join(version).join("bin");
    std::fs::create_dir_all(&root).unwrap();
    write_executable(&root.join("nession"), cli_body);
    write_executable(&root.join("nession-agent"), "#!/bin/sh\nexit 0\n");
    write_executable(&root.join("nession-server"), "#!/bin/sh\nexit 0\n");
    root
}

#[cfg(target_os = "linux")]
fn linux_service_home(home: &TempDir, unit_home: &Path) -> PathBuf {
    let unit_dir = home.path().join(".config/systemd/user");
    std::fs::create_dir_all(&unit_dir).unwrap();
    std::fs::write(
        unit_dir.join("nession-agent.service"),
        format!(
            "[Service]\nEnvironment=\"NESSION_HOME={}\"\nExecStart=/usr/bin/nession agent start --foreground\n",
            unit_home.display()
        ),
    )
    .unwrap();
    unit_dir
}

#[cfg(target_os = "linux")]
fn fake_journalctl(home: &TempDir) -> PathBuf {
    let bin = home.path().join("fake-bin");
    std::fs::create_dir_all(&bin).unwrap();
    write_executable(
        &bin.join("journalctl"),
        "#!/bin/sh\necho \"JOURNAL-LINE $*\"\n",
    );
    bin
}

#[cfg(target_os = "linux")]
fn linux_service_command(home: &TempDir, bin: &Path) -> Command {
    let mut command = nession(home);
    command.env("HOME", home.path()).env(
        "PATH",
        format!(
            "{}:{}",
            bin.display(),
            std::env::var("PATH").unwrap_or_default()
        ),
    );
    command
}

#[cfg(target_os = "linux")]
#[test]
fn the_journal_adapter_reads_only_a_registered_user_unit() {
    let home = tempfile::tempdir().unwrap();
    linux_service_home(&home, home.path());
    let bin = fake_journalctl(&home);

    let output = linux_service_command(&home, &bin)
        .args(["agent", "logs", "--source", "service", "-n", "5"])
        .output()
        .expect("run logs");
    assert!(
        output.status.success(),
        "stdout: {} stderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let printed = String::from_utf8_lossy(&output.stdout).into_owned();
    assert!(printed.contains("JOURNAL-LINE"), "{printed}");
    assert!(
        printed.contains("--user -u nession-agent.service"),
        "the adapter must pass the verified user unit: {printed}"
    );
}

#[cfg(target_os = "linux")]
#[test]
fn a_service_registered_for_another_home_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let other = home.path().join("other-home");
    linux_service_home(&home, &other);
    let bin = fake_journalctl(&home);

    let output = linux_service_command(&home, &bin)
        .args(["agent", "logs", "--source", "service"])
        .output()
        .expect("run logs");
    assert!(
        !output.status.success(),
        "a conflicting home must be refused"
    );
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("NESSION_HOME"), "{error}");
    assert!(error.contains("Refusing"), "{error}");
}

#[cfg(target_os = "linux")]
#[test]
fn an_absent_service_registration_is_reported() {
    let home = tempfile::tempdir().unwrap();
    let bin = fake_journalctl(&home);

    let output = linux_service_command(&home, &bin)
        .args(["agent", "logs", "--source", "service"])
        .output()
        .expect("run logs");
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("not installed"), "{error}");
}

#[cfg(target_os = "linux")]
#[test]
fn a_missing_journalctl_is_reported() {
    let home = tempfile::tempdir().unwrap();
    linux_service_home(&home, home.path());
    let empty_bin = home.path().join("empty-bin");
    std::fs::create_dir_all(&empty_bin).unwrap();

    let output = linux_service_command(&home, &empty_bin)
        .args(["agent", "logs", "--source", "service"])
        .output()
        .expect("run logs");
    assert!(!output.status.success());
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(error.contains("journalctl"), "{error}");
}

#[cfg(target_os = "linux")]
#[test]
fn a_failing_journal_reports_its_cause() {
    let home = tempfile::tempdir().unwrap();
    linux_service_home(&home, home.path());
    let bin = home.path().join("failing-bin");
    std::fs::create_dir_all(&bin).unwrap();
    write_executable(
        &bin.join("journalctl"),
        "#!/bin/sh\necho 'journal: permission denied' >&2\nexit 1\n",
    );

    let output = linux_service_command(&home, &bin)
        .args(["agent", "logs", "--source", "service"])
        .output()
        .expect("run logs");
    assert!(!output.status.success());
    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(combined.contains("permission denied"), "{combined}");
    assert!(combined.contains("failed"), "{combined}");
}

#[cfg(unix)]
#[test]
fn a_selected_release_with_logs_support_runs_its_own_reader() {
    let home = tempfile::tempdir().unwrap();
    archive(
        &home,
        "0.35.0",
        "#!/bin/sh\necho \"ARCHIVE-RAN $*\"\nexit 0\n",
    );

    let output = run(&home, &["+0.35.0", "agent", "logs", "-n", "1"]);
    assert!(output.status.success(), "{}", stderr(&output));
    assert!(
        stdout(&output).contains("ARCHIVE-RAN agent logs"),
        "{}",
        stdout(&output)
    );
}

#[cfg(unix)]
#[test]
fn a_selected_release_without_logs_support_is_read_directly_not_current() {
    let home = tempfile::tempdir().unwrap();
    archive(
        &home,
        "0.34.0",
        "#!/bin/sh\ncase \"$*\" in *--help*) exit 2;; esac\necho \"ARCHIVE-RAN $*\"\nexit 0\n",
    );
    let archive_logs = home.path().join("versions/0.34.0/agent/logs");
    std::fs::create_dir_all(&archive_logs).unwrap();
    std::fs::write(
        archive_logs.join("nession-agent.2026-11-24"),
        "2026-11-24T09:00:00Z INFO app: archive history line\n",
    )
    .unwrap();

    let output = run(&home, &["+0.34.0", "agent", "logs", "-n", "10"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let printed = stdout(&output);
    assert!(printed.contains("archive history line"), "{printed}");
    assert!(
        !printed.contains("ARCHIVE-RAN"),
        "the unsupported release must not execute the command: {printed}"
    );
    assert!(
        stderr(&output).contains("predates"),
        "the diagnostic must say why it read directly: {}",
        stderr(&output)
    );
}

#[cfg(unix)]
#[test]
fn server_logs_dispatch_is_symmetric_for_an_old_archive() {
    let home = tempfile::tempdir().unwrap();
    archive(
        &home,
        "0.34.0",
        "#!/bin/sh\ncase \"$*\" in *--help*) exit 2;; esac\necho \"ARCHIVE-RAN $*\"\nexit 0\n",
    );
    let archive_logs = home.path().join("versions/0.34.0/server/logs");
    std::fs::create_dir_all(&archive_logs).unwrap();
    std::fs::write(
        archive_logs.join("nession-server.2026-11-24"),
        "2026-11-24T09:00:00Z INFO app: server archive history\n",
    )
    .unwrap();

    let output = run(&home, &["+0.34.0", "server", "logs", "-n", "10"]);
    assert!(output.status.success(), "{}", stderr(&output));
    let printed = stdout(&output);
    assert!(printed.contains("server archive history"), "{printed}");
    assert!(!printed.contains("ARCHIVE-RAN"), "{printed}");
    assert!(stderr(&output).contains("predates"), "{}", stderr(&output));
}
