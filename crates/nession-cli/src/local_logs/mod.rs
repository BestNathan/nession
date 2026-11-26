//! `nession agent logs` / `nession server logs`.
//!
//! Read-only local log discovery and reading. The two leaves differ only in
//! the component they name; [`run`] owns the shared behavior: scope
//! resolution, source discovery, bounded tail, filtering and follow
//! (#4600). No Server connection, credential, daemon, network call or
//! installation mutation is involved.

pub mod discovery;
pub mod follow;
pub mod format;
pub mod query;
pub mod resolve;
pub mod service;
pub mod tail;

use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use nession_common::logging::LogComponent;

use crate::args::LogsArgs;
use crate::local_logs::format::LineFormat;
use crate::local_logs::query::{LogQuery, LogSource};
use crate::local_logs::resolve::LogScope;

/// Run one `logs` leaf.
pub async fn run(component: LogComponent, args: LogsArgs) -> Result<()> {
    let query = LogQuery::build(component, &args)?;
    let scope = resolve::resolve(component, args.pid_file.clone())?;
    for note in &scope.notes {
        eprintln!("nession logs: {note}");
    }

    match query.source {
        LogSource::Runtime => {
            let dir = scope.log_dir(component);
            let files = discovery::runtime_log_files(&dir, component)
                .with_context(|| format!("cannot list runtime logs in {}", dir.display()))?;
            run_file_source(component, dir, files, &query, LineFormat::Runtime).await
        }
        LogSource::Startup => {
            let dir = component.startup_dir_under(&scope.home);
            let files = discovery::startup_log_files(&dir)
                .with_context(|| format!("cannot list startup logs in {}", dir.display()))?;
            run_file_source(component, dir, files, &query, LineFormat::Raw).await
        }
        LogSource::Service => run_service(component, &scope, &query).await,
    }
}

async fn run_file_source(
    component: LogComponent,
    dir: PathBuf,
    files: Vec<PathBuf>,
    query: &LogQuery,
    format: LineFormat,
) -> Result<()> {
    if query.path_only {
        print_paths(&dir, &files, query.source);
        return Ok(());
    }
    if files.is_empty() {
        eprintln!(
            "nession logs: no {} log files for the {} under {}; the component has not written \
             any there.",
            query.source.as_str(),
            component.as_str(),
            dir.display()
        );
        return Ok(());
    }

    // Snapshot the newest file before reading, so follow starts exactly where
    // the tail stopped instead of re-reading or skipping appended lines.
    let start = files.last().and_then(|path| {
        std::fs::metadata(path)
            .ok()
            .map(|metadata| (path.clone(), metadata.len()))
    });

    let output = tail::read_tail_capped(
        &files,
        query,
        format,
        start.as_ref().map(|(path, offset)| (path, *offset)),
    )?;
    for line in output.lines {
        println!("{line}");
    }
    report_stats(&output.stats, query.source);

    if query.follow {
        let provider_dir = dir.clone();
        let provider = move || match format {
            LineFormat::Runtime => discovery::runtime_log_files(&provider_dir, component),
            LineFormat::Raw => discovery::startup_log_files(&provider_dir),
        };
        let stats = follow::follow_rolling(
            query.clone(),
            format,
            provider,
            start,
            Box::new(|line| println!("{line}")),
            wait_for_stop(query.until),
        )
        .await
        .context("log follow failed")?;
        report_stats(&stats, query.source);
    }
    Ok(())
}

async fn run_service(component: LogComponent, scope: &LogScope, query: &LogQuery) -> Result<()> {
    let source = service::resolve(component, &scope.home)?;
    match source {
        service::ServiceLogSource::Journal { unit } => {
            if query.path_only {
                println!("journalctl --user -u {unit}");
                return Ok(());
            }
            service::run_journal(query, &unit).await
        }
        service::ServiceLogSource::Files { files, legacy } => {
            if legacy {
                eprintln!(
                    "nession logs: warning: this registration uses the historical shared capture \
                     path; reinstall the service to move it under {}.",
                    component.service_dir_under(&scope.home).display()
                );
            }
            if query.path_only {
                if files.is_empty() {
                    println!("{}", component.service_dir_under(&scope.home).display());
                    eprintln!("nession logs: no service capture files were found.");
                } else {
                    for path in &files {
                        println!("{}", path.display());
                    }
                }
                return Ok(());
            }
            if files.is_empty() {
                eprintln!(
                    "nession logs: no service capture files were found under {}.",
                    component.service_dir_under(&scope.home).display()
                );
                return Ok(());
            }
            let output = tail::read_tail(&files, query, LineFormat::Raw)?;
            for line in output.lines {
                println!("{line}");
            }
            report_stats(&output.stats, query.source);
            if query.follow {
                let listed = files.clone();
                let stats = follow::follow_fixed(
                    query.clone(),
                    LineFormat::Raw,
                    move || Ok(listed.clone()),
                    files,
                    Box::new(|line| println!("{line}")),
                    wait_for_stop(query.until),
                )
                .await
                .context("service log follow failed")?;
                report_stats(&stats, query.source);
            }
            Ok(())
        }
    }
}

fn print_paths(dir: &std::path::Path, files: &[PathBuf], source: LogSource) {
    if files.is_empty() {
        println!("{}", dir.display());
        eprintln!(
            "nession logs: no {} log files exist under {} yet.",
            source.as_str(),
            dir.display()
        );
    } else {
        for path in files {
            println!("{}", path.display());
        }
    }
}

fn report_stats(stats: &tail::TailStats, source: LogSource) {
    if stats.skipped_unparsed > 0 {
        eprintln!(
            "nession logs: {} {} record(s) skipped: they do not carry the timestamp/severity/\
             target the requested filter needs.",
            stats.skipped_unparsed,
            source.as_str()
        );
    }
    if stats.truncated_lines > 0 {
        eprintln!(
            "nession logs: {} oversized line(s) were truncated.",
            stats.truncated_lines
        );
    }
    if stats.truncated_records > 0 {
        eprintln!(
            "nession logs: {} oversized record(s) were truncated.",
            stats.truncated_records
        );
    }
    if stats.orphaned_records > 0 {
        eprintln!(
            "nession logs: {} record fragment(s) had no header; older retained files may \
             have been deleted, so the history has a gap there.",
            stats.orphaned_records
        );
    }
}

/// Resolve when a follow stops: Ctrl-C, or the `--until` cutoff, whichever is
/// first. Ctrl-C ends only this reader.
async fn wait_for_stop(until: Option<DateTime<Utc>>) {
    match until {
        None => {
            let _ = tokio::signal::ctrl_c().await;
        }
        Some(until) => {
            let wait = (until - Utc::now()).to_std().unwrap_or(Duration::ZERO);
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = tokio::time::sleep(wait) => {}
            }
        }
    }
}
