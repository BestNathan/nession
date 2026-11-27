//! Follow (tail -f) over rolling files and fixed service captures.
//!
//! Both loops are identity/offset based, not `inotify` based: every tick
//! re-enumerates the source, compares the newest path and the open file's
//! identity, and reads only bytes after the recorded offset. That covers
//! creation, rotation-by-rename, replacement and truncation without a busy
//! loop and without re-reading history (#4600 SC-03).
//!
//! Cancellation is the reader's own: the command awaits Ctrl-C and stops this
//! loop only. It never signals the daemon.

use std::fs::{File, Metadata};
use std::io::{self, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::local_logs::format::{parse_raw_header, parse_runtime_header, LineFormat, RecordHeader};
use crate::local_logs::query::LogQuery;
use crate::local_logs::tail::{TailStats, MAX_LINE_BYTES, MAX_RECORD_BYTES};

/// Poll interval. Fast enough to feel live, slow enough not to spin.
pub const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// How long a complete-looking record waits for possible continuation lines
/// before it is printed.
const IDLE_FLUSH: Duration = Duration::from_millis(120);

/// Run the rolling-file follow until `shutdown` resolves.
pub async fn follow_rolling<F, S>(
    query: LogQuery,
    format: LineFormat,
    provider: F,
    start: Option<(PathBuf, u64)>,
    sink: Box<dyn FnMut(String) + Send>,
    shutdown: S,
) -> io::Result<TailStats>
where
    F: Fn() -> io::Result<Vec<PathBuf>>,
    S: std::future::Future<Output = ()>,
{
    let mut emitter = Emitter::new(query, format, sink);
    let mut current: Option<Stream> = None;
    let mut start = start;
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
        }
        let files = match provider() {
            Ok(files) => files,
            Err(error) => {
                eprintln!("nession logs: cannot list the log directory: {error}");
                Vec::new()
            }
        };
        let Some(newest) = files.last().cloned() else {
            // No readable file name right now. A still-open handle is drained
            // so writes that raced a deletion/rename are not lost.
            if let Some(stream) = current.as_mut() {
                read_stream(stream, &mut emitter);
            }
            emitter.flush_if_idle();
            continue;
        };
        match current.as_mut() {
            None => {
                let from_end = match start.take() {
                    Some((path, offset)) if path == newest => Some(offset),
                    // A different newest file appeared between the initial
                    // tail and this loop: read it from its beginning, because
                    // the tail never saw it.
                    Some(_) => Some(0),
                    // No initial tail (no files existed): the first file that
                    // appears is new, so its beginning is history we have not
                    // printed.
                    None => Some(0),
                };
                match Stream::open(&newest, from_end) {
                    Ok(stream) => current = Some(stream),
                    Err(error) => {
                        eprintln!("nession logs: cannot open {}: {error}", newest.display());
                        continue;
                    }
                }
            }
            Some(stream) => {
                let replaced = newest != stream.path;
                let path_identity = std::fs::metadata(&stream.path)
                    .ok()
                    .and_then(|metadata| file_identity(&metadata));
                let same_identity = match (path_identity, stream.identity) {
                    (Some(current), Some(open)) => current == open,
                    // A platform without file identity cannot tell replacement
                    // apart from the same file; never reopen on a guess.
                    _ => true,
                };
                if replaced {
                    // A rename inside the directory keeps the same inode.
                    // Follow it under its new name instead of reopening and
                    // re-reading history.
                    let newest_identity = std::fs::metadata(&newest)
                        .ok()
                        .and_then(|metadata| file_identity(&metadata));
                    if newest_identity.is_some() && newest_identity == stream.identity {
                        read_stream(stream, &mut emitter);
                        stream.path = newest;
                        emitter.flush_if_idle();
                        continue;
                    }
                }
                if replaced || !same_identity {
                    if path_identity.is_none() {
                        eprintln!(
                            "nession logs: {} is no longer present (retention deletion?); \
                             continuing with {}",
                            stream.path.display(),
                            newest.display()
                        );
                    }
                    // Drain what the open handle still has, then move on.
                    read_stream(stream, &mut emitter);
                    finish_partial(stream, &mut emitter);
                    emitter.flush(true);
                    // The next file is read from its beginning: nothing in it
                    // was part of the initial tail (it is newer, or it is a
                    // replacement at the same path).
                    match Stream::open(&newest, Some(0)) {
                        Ok(next) => {
                            if replaced {
                                eprintln!("nession logs: switched to {}", newest.display());
                            }
                            current = Some(next);
                        }
                        Err(error) => {
                            eprintln!("nession logs: cannot open {}: {error}", newest.display());
                            current = None;
                        }
                    }
                } else {
                    read_stream(stream, &mut emitter);
                }
            }
        }
        emitter.flush_if_idle();
    }
    if let Some(stream) = current.as_mut() {
        read_stream(stream, &mut emitter);
        finish_partial(stream, &mut emitter);
    }
    emitter.flush(true);
    Ok(emitter.stats)
}

/// Follow a fixed set of raw capture files (macOS service stdout/stderr).
///
/// `provider` may return new files; each is followed independently from its
/// current end at first sight. Interleaving between two streams is by read
/// order, not a synthetic timestamp merge.
pub async fn follow_fixed<F, S>(
    query: LogQuery,
    format: LineFormat,
    provider: F,
    initial: Vec<PathBuf>,
    sink: Box<dyn FnMut(String) + Send>,
    shutdown: S,
) -> io::Result<TailStats>
where
    F: Fn() -> io::Result<Vec<PathBuf>>,
    S: std::future::Future<Output = ()>,
{
    let mut emitter = Emitter::new(query, format, sink);
    let mut streams: Vec<Stream> = Vec::new();
    // Files the initial tail already printed start at their end; only files
    // that appear afterwards are read from the beginning.
    for path in initial {
        match Stream::open(&path, None) {
            Ok(stream) => streams.push(stream),
            Err(error) => eprintln!("nession logs: cannot open {}: {error}", path.display()),
        }
    }
    tokio::pin!(shutdown);
    loop {
        tokio::select! {
            _ = &mut shutdown => break,
            _ = tokio::time::sleep(POLL_INTERVAL) => {}
        }
        let listed = provider().unwrap_or_default();
        for path in listed {
            if !streams.iter().any(|stream| stream.path == path) {
                // A file that appeared after the initial tail is read from
                // its beginning; nothing in it was printed yet.
                match Stream::open(&path, Some(0)) {
                    Ok(stream) => streams.push(stream),
                    Err(error) => {
                        eprintln!("nession logs: cannot open {}: {error}", path.display())
                    }
                }
            }
        }
        for stream in &mut streams {
            let path_identity = std::fs::metadata(&stream.path)
                .ok()
                .and_then(|metadata| file_identity(&metadata));
            let replaced = match (path_identity, stream.identity) {
                (Some(current), Some(open)) => current != open,
                _ => false,
            };
            if replaced {
                read_stream(stream, &mut emitter);
                finish_partial(stream, &mut emitter);
                emitter.flush(true);
                match Stream::open(&stream.path, Some(0)) {
                    Ok(replacement) => *stream = replacement,
                    Err(error) => {
                        eprintln!(
                            "nession logs: cannot reopen {}: {error}",
                            stream.path.display()
                        )
                    }
                }
            } else {
                read_stream(stream, &mut emitter);
            }
        }
        emitter.flush_if_idle();
    }
    for stream in &mut streams {
        read_stream(stream, &mut emitter);
        finish_partial(stream, &mut emitter);
    }
    emitter.flush(true);
    Ok(emitter.stats)
}

/// Emit an unterminated final line when the file will receive no more writes
/// (rotation/replacement/shutdown), so a complete write without a trailing
/// newline is not lost. During ordinary idle polling it is kept buffered.
fn finish_partial(stream: &mut Stream, emitter: &mut Emitter) {
    if stream.partial.is_empty() {
        return;
    }
    let mut line = String::from_utf8_lossy(&std::mem::take(&mut stream.partial)).into_owned();
    if line.ends_with('\r') {
        line.pop();
    }
    if std::mem::take(&mut stream.partial_truncated) {
        line.push_str(&format!(
            "... [nession logs: line truncated at {MAX_LINE_BYTES} bytes]"
        ));
        emitter.stats.truncated_lines += 1;
    }
    emitter.push_line(line);
    emitter.flush(true);
}

struct Stream {
    path: PathBuf,
    file: File,
    offset: u64,
    identity: Option<(u64, u64)>,
    partial: Vec<u8>,
    partial_truncated: bool,
}

impl Stream {
    /// Open `path`; `from_end` seeks to the current EOF when `Some`.
    fn open(path: &Path, from_end: Option<u64>) -> io::Result<Self> {
        let mut file = File::open(path)?;
        let metadata = file.metadata()?;
        let identity = file_identity(&metadata);
        let offset = match from_end {
            Some(offset) => offset.min(metadata.len()),
            None => metadata.len(),
        };
        file.seek(SeekFrom::Start(offset))?;
        Ok(Self {
            path: path.to_path_buf(),
            file,
            offset,
            identity,
            partial: Vec::new(),
            partial_truncated: false,
        })
    }
}

fn read_stream(stream: &mut Stream, emitter: &mut Emitter) {
    let metadata = match stream.file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => {
            eprintln!(
                "nession logs: cannot stat {}: {error}",
                stream.path.display()
            );
            return;
        }
    };
    if metadata.len() < stream.offset {
        eprintln!(
            "nession logs: {} was truncated; continuing from its start",
            stream.path.display()
        );
        if stream.file.seek(SeekFrom::Start(0)).is_err() {
            return;
        }
        stream.offset = 0;
        stream.partial.clear();
        emitter.flush(true);
    }
    let mut remaining = metadata.len() - stream.offset;
    while remaining > 0 {
        let want = usize::try_from(remaining.min(64 * 1024)).unwrap_or(64 * 1024);
        let mut buffer = vec![0u8; want];
        match stream.file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                stream.offset += read as u64;
                remaining = remaining.saturating_sub(read as u64);
                stream
                    .partial
                    .extend_from_slice(buffer.get(..read).unwrap_or(&buffer));
                drain_complete_lines(stream, emitter);
            }
            Err(error) => {
                eprintln!(
                    "nession logs: cannot read {}: {error}",
                    stream.path.display()
                );
                break;
            }
        }
    }
}

fn drain_complete_lines(stream: &mut Stream, emitter: &mut Emitter) {
    while let Some(position) = stream.partial.iter().position(|byte| *byte == b'\n') {
        let raw: Vec<u8> = stream.partial.drain(..=position).collect();
        let line = raw.get(..raw.len().saturating_sub(1)).unwrap_or(&raw);
        let mut line = String::from_utf8_lossy(line).into_owned();
        if line.ends_with('\r') {
            line.pop();
        }
        if stream.partial_truncated {
            line.push_str(&format!(
                "... [nession logs: line truncated at {MAX_LINE_BYTES} bytes]"
            ));
            stream.partial_truncated = false;
            emitter.stats.truncated_lines += 1;
        }
        emitter.push_line(line);
    }
    if stream.partial.len() > MAX_LINE_BYTES {
        let excess = stream.partial.len() - MAX_LINE_BYTES;
        stream.partial.drain(..excess);
        stream.partial_truncated = true;
    }
}

/// Whether a requested filter needs a field this record does not carry.
pub(crate) fn missing_filter_field(query: &LogQuery, header: &RecordHeader) -> bool {
    (header.timestamp.is_none() && (query.since.is_some() || query.until.is_some()))
        || (header.level.is_none() && query.level.is_some())
        || (header.target.is_none() && query.target.is_some())
}

struct Emitter {
    query: LogQuery,
    format: LineFormat,
    /// Header + continuation lines of the record being assembled.
    pending: Vec<String>,
    pending_bytes: usize,
    last_line_at: Instant,
    stats: TailStats,
    sink: Box<dyn FnMut(String) + Send>,
}

impl Emitter {
    fn new(query: LogQuery, format: LineFormat, sink: Box<dyn FnMut(String) + Send>) -> Self {
        Self {
            query,
            format,
            pending: Vec::new(),
            pending_bytes: 0,
            last_line_at: Instant::now(),
            stats: TailStats::default(),
            sink,
        }
    }

    fn push_line(&mut self, line: String) {
        self.last_line_at = Instant::now();
        if self.format == LineFormat::Raw {
            self.pending.push(line);
            self.flush(true);
            return;
        }
        if parse_runtime_header(&line).is_some() {
            self.flush(true);
            self.pending.push(line);
            self.pending_bytes = self.pending.last().map_or(0, String::len);
        } else if self.pending_bytes + line.len() > MAX_RECORD_BYTES {
            self.stats.truncated_records += 1;
        } else {
            self.pending_bytes += line.len();
            self.pending.push(line);
        }
    }

    fn flush_if_idle(&mut self) {
        if self.pending.is_empty() {
            return;
        }
        if self.last_line_at.elapsed() >= IDLE_FLUSH {
            self.flush(true);
        }
    }

    fn flush(&mut self, force: bool) {
        if self.pending.is_empty() {
            return;
        }
        if !force && self.last_line_at.elapsed() < IDLE_FLUSH {
            return;
        }
        let lines = std::mem::take(&mut self.pending);
        self.pending_bytes = 0;
        let header = match self.format {
            LineFormat::Runtime => lines.first().and_then(|line| parse_runtime_header(line)),
            LineFormat::Raw => lines.first().map(|line| parse_raw_header(line)),
        }
        .unwrap_or_else(RecordHeader::untimed);
        let matched = if !self.query.needs_header() {
            true
        } else if missing_filter_field(&self.query, &header) {
            self.stats.skipped_unparsed += 1;
            false
        } else {
            self.query.matches(&header)
        };
        if matched {
            self.stats.emitted += 1;
            for line in lines {
                (self.sink)(line);
            }
        }
        // A follow past the requested tail keeps streaming; `--tail` bounds
        // only the initial history, not the append stream.
    }
}

#[cfg(unix)]
fn file_identity(metadata: &Metadata) -> Option<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Some((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_identity(_metadata: &Metadata) -> Option<(u64, u64)> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn query(tail: usize) -> LogQuery {
        LogQuery {
            component: nession_common::logging::LogComponent::Agent,
            source: crate::local_logs::query::LogSource::Runtime,
            tail,
            follow: true,
            since: None,
            until: None,
            level: None,
            target: None,
            path_only: false,
        }
    }

    fn line(message: &str) -> String {
        format!("2026-11-26T10:00:00.000000Z  INFO app: {message}\n")
    }

    #[tokio::test]
    async fn appends_are_followed_and_cancellation_stops_only_the_reader() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nession-agent");
        std::fs::write(&path, line("before")).unwrap();
        let start = (path.clone(), std::fs::metadata(&path).unwrap().len());

        let output = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_output = Arc::clone(&output);
        let (stop, wait) = tokio::sync::oneshot::channel();
        let provider_path = path.clone();
        let provider_dir = dir.path().to_path_buf();
        let follow = tokio::spawn(follow_rolling(
            query(10),
            LineFormat::Runtime,
            move || {
                crate::local_logs::discovery::runtime_log_files(
                    &provider_dir,
                    nession_common::logging::LogComponent::Agent,
                )
            },
            Some(start),
            Box::new(move |line| sink_output.lock().unwrap().push(line)),
            async {
                let _ = wait.await;
            },
        ));
        let _ = provider_path;

        tokio::time::sleep(Duration::from_millis(200)).await;
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            file.write_all(line("after").as_bytes()).unwrap();
            file.flush().unwrap();
        }
        tokio::time::sleep(Duration::from_millis(450)).await;
        let _ = stop.send(());
        let stats = follow.await.unwrap().unwrap();

        let lines = output.lock().unwrap().clone();
        assert_eq!(stats.emitted, 1, "{lines:?}");
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("after"), "{lines:?}");
        assert!(
            !lines.iter().any(|line| line.contains("before")),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn a_file_created_after_the_follow_started_is_read_from_its_start() {
        let dir = tempfile::tempdir().unwrap();
        let output = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_output = Arc::clone(&output);
        let (stop, wait) = tokio::sync::oneshot::channel();
        let provider_dir = dir.path().to_path_buf();
        let follow = tokio::spawn(follow_rolling(
            query(10),
            LineFormat::Runtime,
            move || {
                crate::local_logs::discovery::runtime_log_files(
                    &provider_dir,
                    nession_common::logging::LogComponent::Agent,
                )
            },
            None,
            Box::new(move |line| sink_output.lock().unwrap().push(line)),
            async {
                let _ = wait.await;
            },
        ));

        tokio::time::sleep(Duration::from_millis(250)).await;
        std::fs::write(
            dir.path().join("nession-agent.2026-11-26"),
            line("first line of a new file"),
        )
        .unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        let _ = stop.send(());
        follow.await.unwrap().unwrap();

        let lines = output.lock().unwrap().clone();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("first line of a new file"), "{lines:?}");
    }

    #[tokio::test]
    async fn a_partial_line_waits_for_its_newline() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nession-agent");
        std::fs::write(&path, "").unwrap();
        let start = (path.clone(), 0);

        let output = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_output = Arc::clone(&output);
        let (stop, wait) = tokio::sync::oneshot::channel();
        let provider_path = path.clone();
        let follow = tokio::spawn(follow_rolling(
            query(10),
            LineFormat::Runtime,
            move || Ok(vec![provider_path.clone()]),
            Some(start),
            Box::new(move |line| sink_output.lock().unwrap().push(line)),
            async {
                let _ = wait.await;
            },
        ));

        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(b"2026-11-26T10:00:00Z INFO app: half")
            .unwrap();
        file.flush().unwrap();
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert!(
            output.lock().unwrap().is_empty(),
            "an unterminated line must not be emitted"
        );

        file.write_all(b" done\n").unwrap();
        file.flush().unwrap();
        tokio::time::sleep(Duration::from_millis(350)).await;
        let _ = stop.send(());
        follow.await.unwrap().unwrap();
        let lines = output.lock().unwrap().clone();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("half done"), "{lines:?}");
    }

    #[tokio::test]
    async fn rotation_switches_to_the_new_file_without_duplicates() {
        let dir = tempfile::tempdir().unwrap();
        let old_name = "nession-agent.2026-11-25";
        let new_name = "nession-agent.2026-11-26";
        let old = dir.path().join(old_name);
        std::fs::write(&old, line("old file")).unwrap();
        let start = (old.clone(), std::fs::metadata(&old).unwrap().len());

        let output = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_output = Arc::clone(&output);
        let (stop, wait) = tokio::sync::oneshot::channel();
        let provider_dir = dir.path().to_path_buf();
        let follow = tokio::spawn(follow_rolling(
            query(10),
            LineFormat::Runtime,
            move || {
                crate::local_logs::discovery::runtime_log_files(
                    &provider_dir,
                    nession_common::logging::LogComponent::Agent,
                )
            },
            Some(start),
            Box::new(move |line| sink_output.lock().unwrap().push(line)),
            async {
                let _ = wait.await;
            },
        ));

        tokio::time::sleep(Duration::from_millis(250)).await;
        std::fs::write(dir.path().join(new_name), line("new file")).unwrap();
        tokio::time::sleep(Duration::from_millis(400)).await;
        let _ = stop.send(());
        follow.await.unwrap().unwrap();

        let lines = output.lock().unwrap().clone();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("new file"), "{lines:?}");
    }

    #[tokio::test]
    async fn truncation_is_detected_and_read_from_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nession-agent");
        std::fs::write(&path, line("before truncation")).unwrap();
        let start = (path.clone(), std::fs::metadata(&path).unwrap().len());

        let output = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_output = Arc::clone(&output);
        let (stop, wait) = tokio::sync::oneshot::channel();
        let provider_path = path.clone();
        let follow = tokio::spawn(follow_rolling(
            query(10),
            LineFormat::Runtime,
            move || Ok(vec![provider_path.clone()]),
            Some(start),
            Box::new(move |line| sink_output.lock().unwrap().push(line)),
            async {
                let _ = wait.await;
            },
        ));

        tokio::time::sleep(Duration::from_millis(200)).await;
        std::fs::write(&path, line("after truncation")).unwrap();
        tokio::time::sleep(Duration::from_millis(450)).await;
        let _ = stop.send(());
        follow.await.unwrap().unwrap();

        let lines = output.lock().unwrap().clone();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("after truncation"), "{lines:?}");
    }

    #[tokio::test]
    async fn a_replaced_file_is_reopened_without_reading_the_old_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nession-agent");
        std::fs::write(&path, line("old content")).unwrap();
        let start = (path.clone(), std::fs::metadata(&path).unwrap().len());

        let output = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_output = Arc::clone(&output);
        let (stop, wait) = tokio::sync::oneshot::channel();
        let provider_path = path.clone();
        let follow = tokio::spawn(follow_rolling(
            query(10),
            LineFormat::Runtime,
            move || Ok(vec![provider_path.clone()]),
            Some(start),
            Box::new(move |line| sink_output.lock().unwrap().push(line)),
            async {
                let _ = wait.await;
            },
        ));

        tokio::time::sleep(Duration::from_millis(250)).await;
        std::fs::remove_file(&path).unwrap();
        std::fs::write(&path, line("replacement content")).unwrap();
        tokio::time::sleep(Duration::from_millis(450)).await;
        let _ = stop.send(());
        follow.await.unwrap().unwrap();

        let lines = output.lock().unwrap().clone();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("replacement content"), "{lines:?}");
        assert!(
            !lines.iter().any(|line| line.contains("old content")),
            "{lines:?}"
        );
    }

    #[tokio::test]
    async fn filters_apply_to_followed_records() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nession-agent");
        std::fs::write(&path, "").unwrap();
        let start = (path.clone(), 0);
        let mut filtered = query(10);
        filtered.level = Some(crate::local_logs::query::LogLevel::Warn);

        let output = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink_output = Arc::clone(&output);
        let (stop, wait) = tokio::sync::oneshot::channel();
        let provider_path = path.clone();
        let follow = tokio::spawn(follow_rolling(
            filtered,
            LineFormat::Runtime,
            move || Ok(vec![provider_path.clone()]),
            Some(start),
            Box::new(move |line| sink_output.lock().unwrap().push(line)),
            async {
                let _ = wait.await;
            },
        ));

        tokio::time::sleep(Duration::from_millis(200)).await;
        {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .unwrap();
            file.write_all(line("info message").as_bytes()).unwrap();
            file.write_all(b"2026-11-26T10:00:01Z WARN app: warn message\n")
                .unwrap();
            file.flush().unwrap();
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
        let _ = stop.send(());
        follow.await.unwrap().unwrap();

        let lines = output.lock().unwrap().clone();
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(lines[0].contains("warn message"), "{lines:?}");
    }
}
