use anyhow::Result;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use tokio::task;

/// Buffer shared between the PTY reader thread and `read_output` callers.
///
/// The reader thread pushes bytes into `data` and notifies via `cvar`
/// whenever new data (or EOF / error) arrives. `read_output` waits on
/// `cvar` with a bounded timeout.
struct ReadBuffer {
    /// Queued bytes ready for consumption.
    data: VecDeque<u8>,
    /// Set when the reader thread has exited (child closed or error).
    eof: bool,
    /// Last error observed by the reader thread (if any).
    error: Option<String>,
}

/// PTY control mode for real-time terminal I/O with tmux sessions.
///
/// Unlike command mode ([`TmuxManager`]), which sends discrete tmux commands,
/// `PtySession` provides a raw terminal pipe to an attached tmux session —
/// suitable for streaming keystrokes and screen updates to/from a remote
/// client over WebSocket.
///
/// Architecture: a dedicated background thread continuously reads from the
/// PTY master and buffers output into an internal ring buffer. `read_output`
/// consumes that buffer. `write_input` writes directly on a blocking thread.
/// This keeps all PTY blocking confined to dedicated OS threads, never
/// starving the tokio worker pool or deadlocking on shared mutexes.
pub struct PtySession {
    /// The master side of the PTY, kept for resize + writer cloning.
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Writer half, taken once at attach time and shared for writes.
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    /// Child handle so we can wait / kill it on close.
    child: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send>>>>,
    /// Shared read buffer fed by the background reader thread.
    read_buf: Arc<(Mutex<ReadBuffer>, Condvar)>,
    /// Session name this PTY is attached to.
    session_name: String,
    /// Whether the session has been closed.
    closed: Arc<Mutex<bool>>,
    /// Handle to the reader thread so we can join it on close.
    reader_handle: Arc<Mutex<Option<thread::JoinHandle<()>>>>,
}

impl PtySession {
    /// Internal helper: open a PTY and spawn a command on its slave side.
    async fn spawn_inner(
        cmd: CommandBuilder,
        session_name: String,
        width: u16,
        height: u16,
    ) -> Result<Self> {
        let pty_system = native_pty_system();

        let size = PtySize {
            rows: height,
            cols: width,
            pixel_width: 0,
            pixel_height: 0,
        };

        let pair = pty_system.openpty(size)?;

        let pair_master = pair.master;
        let pair_slave = pair.slave;

        pair_master.resize(size)?;

        // Take the writer once (portable-pty's `take_writer` consumes the
        // write slot). Readers are cloned on demand for the background
        // reader thread.
        let writer = pair_master.take_writer()?;

        // Spawn the child on the slave side of the PTY.
        let child = pair_slave.spawn_command(cmd)?;
        // The slave side is no longer needed once the child is spawned.
        drop(pair_slave);

        let master = Arc::new(Mutex::new(pair_master));
        let read_buf = Arc::new((
            Mutex::new(ReadBuffer {
                data: VecDeque::new(),
                eof: false,
                error: None,
            }),
            Condvar::new(),
        ));

        // Spawn a dedicated OS thread to continuously drain the PTY.
        let reader_buf_clone = Arc::clone(&read_buf);
        let reader_master_clone = Arc::clone(&master);
        let reader_handle = thread::Builder::new()
            .name(format!("nession-pty-reader-{}", session_name))
            .spawn(move || {
                // Clone a reader from the master once, then loop reading
                // 4 KiB chunks. The lock on `master` is held only for the
                // duration of the clone.
                let mut reader = match reader_master_clone
                    .lock()
                    .ok()
                    .and_then(|m| m.try_clone_reader().ok())
                {
                    Some(r) => r,
                    None => {
                        let (lock, cvar) = &*reader_buf_clone;
                        let mut buf = lock.lock().expect("read_buf poisoned");
                        buf.error = Some("failed to clone PTY reader".into());
                        buf.eof = true;
                        cvar.notify_all();
                        return;
                    }
                };
                // Drop the master lock — the reader we hold is independent.
                drop(reader_master_clone);

                let mut chunk = [0u8; 4096];
                loop {
                    let n = match reader.read(&mut chunk) {
                        Ok(0) => {
                            // EOF
                            let (lock, cvar) = &*reader_buf_clone;
                            let mut buf = lock.lock().expect("read_buf poisoned");
                            buf.eof = true;
                            cvar.notify_all();
                            return;
                        }
                        Ok(n) => n,
                        Err(e) => {
                            let (lock, cvar) = &*reader_buf_clone;
                            let mut buf = lock.lock().expect("read_buf poisoned");
                            buf.error = Some(e.to_string());
                            buf.eof = true;
                            cvar.notify_all();
                            return;
                        }
                    };
                    let (lock, cvar) = &*reader_buf_clone;
                    let mut buf = lock.lock().expect("read_buf poisoned");
                    buf.data.extend(&chunk[..n]);
                    cvar.notify_all();
                }
            })
            .expect("failed to spawn PTY reader thread");

        Ok(Self {
            master,
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(Some(child))),
            read_buf,
            session_name,
            closed: Arc::new(Mutex::new(false)),
            reader_handle: Arc::new(Mutex::new(Some(reader_handle))),
        })
    }

    /// Attach to a tmux session by spawning `tmux attach-session` inside a PTY.
    ///
    /// The child process inherits the slave side of the PTY; the master side
    /// is retained here for read/write/resize operations.
    pub async fn attach(session_name: &str, width: u16, height: u16) -> Result<Self> {
        let mut cmd = CommandBuilder::new("tmux");
        cmd.args(&["attach-session", "-t", session_name]);
        // tmux requires TERM to be set when attaching via PTY
        cmd.env("TERM", "xterm-256color");
        Self::spawn_inner(cmd, session_name.to_string(), width, height).await
    }

    /// Create a PtySession with an arbitrary command.
    ///
    /// This is primarily useful for testing without requiring a real tmux
    /// session. In production code, prefer [`attach`].
    pub async fn spawn_command(
        program: &str,
        args: &[&str],
        width: u16,
        height: u16,
    ) -> Result<Self> {
        let mut cmd = CommandBuilder::new(program);
        cmd.args(args);
        let session_name = format!("[test:{}]", program);
        Self::spawn_inner(cmd, session_name, width, height).await
    }

    /// Read terminal output from the PTY's stdout.
    ///
    /// Returns:
    /// - `Ok(n > 0)` — `n` bytes were copied into `buf`.
    /// - `Ok(0)` — true EOF (the child exited).
    /// - `Err(PtyError::Timeout)` — no data within `timeout_ms`; caller
    ///   should retry.
    /// - `Err(other)` — an I/O error occurred.
    ///
    /// Runs entirely in `spawn_blocking` against the internal read buffer,
    /// so it never blocks a tokio worker longer than the timeout.
    pub async fn read_output(&self, buf: &mut [u8], timeout_ms: u64) -> Result<usize> {
        let read_buf = Arc::clone(&self.read_buf);
        let ptr_addr = buf.as_mut_ptr() as usize;
        let len = buf.len();
        let n = task::spawn_blocking(move || {
            let (lock, cvar) = &*read_buf;
            let mut guard = lock.lock().expect("read_buf poisoned");

            // Wait for data or EOF, bounded by timeout.
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
            while guard.data.is_empty() && !guard.eof {
                let now = std::time::Instant::now();
                if now >= deadline {
                    break;
                }
                let wait_result = cvar
                    .wait_timeout(guard, deadline - now)
                    .expect("condvar poisoned");
                guard = wait_result.0;
            }

            if let Some(err) = guard.error.as_ref() {
                if guard.data.is_empty() {
                    return Err(anyhow::anyhow!("PTY reader error: {}", err));
                }
            }

            // Distinguish true EOF from a timeout-with-no-data.
            // If data is empty AND not EOF, we simply timed out — return
            // a specific error so the caller can retry rather than
            // treating this as stream end.
            if guard.data.is_empty() {
                if guard.eof {
                    return Ok(0); // true EOF
                } else {
                    return Err(anyhow::anyhow!("PTY_READ_TIMEOUT"));
                }
            }

            let to_copy = guard.data.len().min(len);
            if to_copy > 0 {
                let ptr = ptr_addr as *mut u8;
                let slice = unsafe { std::slice::from_raw_parts_mut(ptr, len) };
                for i in 0..to_copy {
                    slice[i] = guard.data.pop_front().unwrap();
                }
            }
            Ok(to_copy)
        })
        .await??;
        Ok(n)
    }

    /// Write terminal input to the PTY's stdin.
    pub async fn write_input(&self, data: &[u8]) -> Result<usize> {
        let writer = Arc::clone(&self.writer);
        let data = data.to_vec();
        let n = task::spawn_blocking(move || {
            let mut guard = writer.lock().expect("writer lock poisoned");
            guard.write_all(&data)?;
            guard.flush()?;
            Ok::<usize, anyhow::Error>(data.len())
        })
        .await??;
        Ok(n)
    }

    /// Resize the terminal. Sends SIGWINCH to the child via the PTY master.
    pub async fn resize(&self, width: u16, height: u16) -> Result<()> {
        let master = Arc::clone(&self.master);
        let size = PtySize {
            rows: height,
            cols: width,
            pixel_width: 0,
            pixel_height: 0,
        };
        task::spawn_blocking(move || {
            let guard = master.lock().expect("master lock poisoned");
            guard.resize(size)?;
            Ok::<(), anyhow::Error>(())
        })
        .await??;
        Ok(())
    }

    /// Clean up the PTY connection: terminate the child and mark the session
    /// as closed. Idempotent.
    pub async fn close(&self) -> Result<()> {
        let already = {
            let mut closed = self.closed.lock().expect("closed lock poisoned");
            if *closed {
                true
            } else {
                *closed = true;
                false
            }
        };
        if already {
            return Ok(());
        }

        let child = Arc::clone(&self.child);
        let reader_handle = Arc::clone(&self.reader_handle);
        task::spawn_blocking(move || {
            // Kill the child first so the reader thread sees EOF.
            let mut child_guard = child.lock().expect("child lock poisoned");
            if let Some(mut c) = child_guard.take() {
                let _ = c.kill();
                let _ = c.wait();
            }
            drop(child_guard);

            // Join the reader thread (it should exit soon after the child dies).
            let mut handle_guard = reader_handle
                .lock()
                .expect("reader_handle lock poisoned");
            if let Some(h) = handle_guard.take() {
                let _ = h.join();
            }
        })
        .await?;
        Ok(())
    }

    /// The tmux session name this PTY is attached to.
    pub fn session_name(&self) -> &str {
        &self.session_name
    }

    /// Whether `close()` has been called.
    pub async fn is_closed(&self) -> bool {
        *self.closed.lock().expect("closed lock poisoned")
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let already = {
            let mut closed = match self.closed.lock() {
                Ok(c) => c,
                Err(p) => p.into_inner(),
            };
            if *closed {
                true
            } else {
                *closed = true;
                false
            }
        };
        if already {
            return;
        }

        // Best-effort kill of the child, then join the reader thread.
        if let Ok(mut child_guard) = self.child.lock() {
            if let Some(mut c) = child_guard.take() {
                let _ = c.kill();
            }
        }
        // We intentionally do NOT join the reader thread in Drop: joining
        // blocks, and Drop must not block. The thread will observe EOF
        // once the child's slave side is closed by the kernel on process
        // exit, and will clean itself up.
    }
}
