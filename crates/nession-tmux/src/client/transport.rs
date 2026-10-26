//! The transport seam under [`super::TmuxClient`].
//!
//! The client owns framing, command dispatch and event ordering; a transport
//! owns only "spawn a process (or take a byte-stream pair) and hand back its
//! stdin/stdout". Two transports implement that seam over the *same* Control
//! Mode grammar:
//!
//! - [`PipeTransport`]: `tmux -C attach` with separate stdin/stdout pipes. The
//!   production default.
//! - [`PtyTransport`]: `tmux -CC attach` on a PTY. `-CC` makes the client's
//!   stdin tty the protocol fd and brackets the stream with terminal framing
//!   (`DCS ESC P 1000 p` … `ST ESC \`) that is not part of the Control Mode
//!   grammar, so this transport removes it before the client's byte framing
//!   sees it.
//!
//! Both spawn through [`TmuxCommand`] — the single owner of `-S <private
//! socket>` addressing and inherited-env scrubbing — so neither transport adds
//! a second tmux process grammar. A failed `-CC` launch is an error; it never
//! falls back to `-C`.

use std::process::Stdio;

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::process::{Child, ChildStdin, ChildStdout};

use crate::process::TmuxCommand;

/// How long [`ClientChild::reap`] waits for an exiting control client.
///
/// The detach was already written; this only bounds how long a caller waits
/// for the process to acknowledge it. A tmux client that has not exited by
/// then is left for the transport's own drop (closing the byte stream) rather
/// than SIGKILLed: Homebrew tmux 3.6b can crash its server when a control
/// client is killed (observed, see `ControlModeSession::close`).
const REAP_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

/// One attached control client's byte streams.
///
/// `child` is present for a real process and absent for an in-memory wire (the
/// deterministic tests). The client never inspects the process; it only reaps
/// it on close so a detached tmux does not linger as a zombie.
pub struct ClientIo {
    pub reader: Box<dyn AsyncRead + Unpin + Send>,
    pub writer: Box<dyn AsyncWrite + Unpin + Send>,
    pub child: Option<ClientChild>,
}

/// The process behind one attachment, in the transport's own terms.
pub enum ClientChild {
    Pipe(Child),
    #[cfg(unix)]
    Pty(PtyChild),
}

#[cfg(unix)]
pub struct PtyChild {
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl ClientChild {
    /// The attached process's pid, for the drop-path detach (#1011).
    pub fn pid(&self) -> Option<u32> {
        match self {
            Self::Pipe(child) => child.id(),
            #[cfg(unix)]
            Self::Pty(pty) => pty.child.process_id(),
        }
    }

    /// Wait (bounded) for the process to exit after the detach was written.
    ///
    /// `portable_pty::Child::wait` is blocking, so the PTY arm polls the
    /// non-blocking `try_wait` instead of moving the child to a blocking
    /// thread. Neither arm kills: the detach plus closing the byte stream is
    /// what ends the client.
    pub async fn reap(mut self) {
        match &mut self {
            Self::Pipe(child) => {
                let _ = tokio::time::timeout(REAP_TIMEOUT, child.wait()).await;
            }
            #[cfg(unix)]
            Self::Pty(pty) => {
                let deadline = tokio::time::Instant::now() + REAP_TIMEOUT;
                while tokio::time::Instant::now() < deadline {
                    match pty.child.try_wait() {
                        Ok(Some(_)) | Err(_) => return,
                        Ok(None) => {}
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
                }
            }
        }
    }
}

/// Which Control Mode transport a client attaches over.
///
/// `Pipe` is the production default (`TmuxClient::connect`). A PTY attach
/// carries the client's tty size, which tmux turns into the **shared** window's
/// size (`window-size latest`) — pass the size the window is already at unless
/// moving it is intended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlTransport {
    /// `tmux -C attach` over separate stdin/stdout pipes.
    Pipe,
    /// `tmux -CC attach` over a PTY.
    #[cfg(unix)]
    Pty { cols: u16, rows: u16 },
}

/// `tmux -C attach` over separate stdin/stdout pipes.
///
/// `-C` (not `-CC`) is the initial production default: it needs no PTY and the
/// control-mode grammar is identical. The PTY transport is a separate deliverable
/// (#2307 SC-02), not a substitution made here.
pub struct PipeTransport;

impl PipeTransport {
    /// Spawn one control attachment to `session_name` on the caller's private
    /// socket.
    pub fn connect(tmux: &TmuxCommand, session_name: &str) -> Result<ClientIo> {
        let mut child = tmux
            .tokio()
            .args(["-C", "attach", "-t", session_name])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("failed to spawn tmux -C attach -t {session_name}"))?;
        let stdin: ChildStdin = child
            .stdin
            .take()
            .context("control child stdin was not piped")?;
        let stdout: ChildStdout = child
            .stdout
            .take()
            .context("control child stdout was not piped")?;
        Ok(ClientIo {
            reader: Box::new(stdout),
            writer: Box::new(stdin),
            child: Some(ClientChild::Pipe(child)),
        })
    }
}

/// The terminal framing `tmux -CC` wraps the protocol stream in.
///
/// With `-CC`, tmux starts the stream with the DCS introducer
/// `ESC P 1000 p` (“enter passthrough”) and ends it with ST `ESC \`. Neither is
/// a Control Mode record: passed to [`read_control_line`](super::framing)
/// untouched, the introducer corrupts the welcome pair's first line and the
/// closing ST looks like a record truncated by EOF. This transport removes the
/// introducer and the *closing* ST, and normalises the `CRLF` tmux writes as a
/// line ending (measured on 3.6b: every protocol line, including a capture
/// body's, ends `\r\n`).
///
/// The closing ST is the only `ESC \` that may be removed. A capture body
/// carries raw escapes (`capture-pane -e`), and an OSC-8 hyperlink in the pane
/// terminates with a real ST — dropping every pair would silently corrupt the
/// snapshot. So an `ESC \` is held until the next byte proves it is data, and
/// only a pair with nothing after it is treated as framing.
struct PtyFraming<R> {
    inner: R,
    /// Filtered bytes waiting for the caller.
    ready: Vec<u8>,
    /// A `CR` held back because it may be the first half of the tty's `CRLF`.
    pending_cr: bool,
    /// An `ESC` held back because it may be the first half of `ST`.
    pending_esc: bool,
    /// An `ESC \` pair that may be the stream's closing ST framing. It is
    /// emitted if any byte follows it (a capture body can carry a real ST, as
    /// an OSC-8 hyperlink terminator does) and dropped at the end of the wire.
    held_st: bool,
    dcs: DcsState,
    inner_done: bool,
}

const DCS_INTRODUCER: &[u8] = b"\x1bP1000p";
const READ_SCRATCH: usize = 8 * 1024;

enum DcsState {
    /// The stream may still start with the introducer; `matched` bytes agree.
    Matching { matched: usize },
    /// Past the introducer (matched, absent, or diverged).
    Done,
}

impl<R> PtyFraming<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            ready: Vec::new(),
            pending_cr: false,
            pending_esc: false,
            held_st: false,
            dcs: DcsState::Matching { matched: 0 },
            inner_done: false,
        }
    }

    fn filter(&mut self, input: &[u8]) {
        for &byte in input {
            match self.dcs {
                DcsState::Done => self.filter_byte(byte),
                DcsState::Matching { matched } => self.advance_dcs(byte, matched),
            }
        }
    }

    fn advance_dcs(&mut self, byte: u8, matched: usize) {
        if DCS_INTRODUCER.get(matched) == Some(&byte) {
            let next = matched.saturating_add(1);
            self.dcs = if next == DCS_INTRODUCER.len() {
                DcsState::Done
            } else {
                DcsState::Matching { matched: next }
            };
            return;
        }
        // Diverged (or never started): release the held bytes and pass this
        // one through the normal filter. A stream without the introducer is
        // still a valid `-CC` stream on a tmux that does not emit it.
        if let Some(held) = DCS_INTRODUCER.get(..matched) {
            for &held_byte in held {
                self.filter_byte(held_byte);
            }
        }
        self.dcs = DcsState::Done;
        self.filter_byte(byte);
    }

    fn filter_byte(&mut self, byte: u8) {
        // A byte after a held ST means the pair was data, not the closing
        // framing: release it and process this byte normally.
        if self.held_st {
            self.ready.extend_from_slice(b"\x1b\\");
            self.held_st = false;
        }
        if self.pending_cr {
            self.pending_cr = false;
            if byte == b'\n' {
                self.ready.push(b'\n');
                return;
            }
            self.ready.push(b'\r');
        }
        if self.pending_esc {
            self.pending_esc = false;
            if byte == b'\\' {
                self.held_st = true;
                return;
            }
            self.ready.push(b'\x1b');
        }
        match byte {
            b'\r' => self.pending_cr = true,
            b'\x1b' => self.pending_esc = true,
            _ => self.ready.push(byte),
        }
    }

    /// End of the wire: release whatever the filter was still holding.
    fn finish(&mut self) {
        if let DcsState::Matching { matched } = self.dcs {
            if let Some(held) = DCS_INTRODUCER.get(..matched) {
                self.ready.extend_from_slice(held);
            }
            self.dcs = DcsState::Done;
        }
        // A held ST at EOF is the closing terminal framing; anything else held
        // is data that must not be lost.
        self.held_st = false;
        if std::mem::take(&mut self.pending_cr) {
            self.ready.push(b'\r');
        }
        if std::mem::take(&mut self.pending_esc) {
            self.ready.push(b'\x1b');
        }
    }
}

impl<R: AsyncRead + Unpin> AsyncRead for PtyFraming<R> {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        use std::task::Poll;

        let this = self.get_mut();
        loop {
            if !this.ready.is_empty() {
                let take = this.ready.len().min(buf.remaining());
                let Some(chunk) = this.ready.get(..take) else {
                    return Poll::Ready(Err(std::io::Error::other(
                        "PTY framing buffer length out of range",
                    )));
                };
                buf.put_slice(chunk);
                this.ready.drain(..take);
                return Poll::Ready(Ok(()));
            }
            if this.inner_done {
                return Poll::Ready(Ok(()));
            }
            let mut scratch = [0u8; READ_SCRATCH];
            let mut read_buf = tokio::io::ReadBuf::new(&mut scratch);
            match std::pin::Pin::new(&mut this.inner).poll_read(cx, &mut read_buf) {
                Poll::Pending => return Poll::Pending,
                Poll::Ready(Err(err)) => return Poll::Ready(Err(err)),
                Poll::Ready(Ok(())) => {
                    let filled = read_buf.filled();
                    if filled.is_empty() {
                        this.inner_done = true;
                        this.finish();
                    } else {
                        this.filter(filled);
                    }
                }
            }
        }
    }
}

#[cfg(unix)]
mod unix {
    use super::{ClientChild, ClientIo, PtyChild, PtyFraming, Result, TmuxCommand, READ_SCRATCH};
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use anyhow::{bail, Context as _};
    use tokio::io::unix::AsyncFd;
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

    /// `tmux -CC attach` over a PTY.
    ///
    /// tmux uses the client's stdin tty as the protocol fd and expects it to be
    /// raw. The slave is put into raw mode *before* the child starts, not left
    /// to tmux: with `ECHO` still on, every command this client writes would be
    /// echoed back on the same master and read as protocol noise.
    pub struct PtyTransport;

    impl PtyTransport {
        /// Open a PTY, spawn one `-CC` attachment to `session_name`, and return
        /// its streams.
        pub fn connect(
            tmux: &TmuxCommand,
            session_name: &str,
            cols: u16,
            rows: u16,
        ) -> Result<ClientIo> {
            let pty = portable_pty::native_pty_system()
                .openpty(portable_pty::PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .context("failed to open a PTY for tmux -CC")?;

            set_raw(pty.master.as_ref())?;

            let mut command = tmux.pty();
            command.args(["-CC", "attach", "-t", session_name]);
            let child = pty
                .slave
                .spawn_command(command)
                .with_context(|| format!("failed to spawn tmux -CC attach -t {session_name}"))?;
            // The parent must not keep the slave open: its EOF is what tells
            // tmux the controlling side is gone.
            drop(pty.slave);

            let master_fd = pty
                .master
                .as_raw_fd()
                .context("the PTY master has no file descriptor")?;
            let read_fd = duplicate_nonblocking(master_fd)?;
            let write_fd = duplicate_nonblocking(master_fd)?;

            // The two descriptors above are the master now. The original is
            // dropped with `pty`: `dup` shares the open file description, so
            // the device stays open until both are closed.
            Ok(ClientIo {
                reader: Box::new(PtyFraming::new(AsyncFdIo::new(read_fd)?)),
                writer: Box::new(AsyncFdIo::new(write_fd)?),
                child: Some(ClientChild::Pty(PtyChild { child })),
            })
        }
    }

    /// Put the PTY's line discipline into raw mode.
    fn set_raw(master: &dyn portable_pty::MasterPty) -> Result<()> {
        let Some(fd) = master.as_raw_fd() else {
            bail!("the PTY master has no file descriptor");
        };
        let mut termios: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(fd, &mut termios) } != 0 {
            bail!(
                "failed to read the PTY's termios: {}",
                io::Error::last_os_error()
            );
        }
        unsafe { libc::cfmakeraw(&mut termios) };
        if unsafe { libc::tcsetattr(fd, libc::TCSANOW, &termios) } != 0 {
            bail!(
                "failed to put the PTY into raw mode: {}",
                io::Error::last_os_error()
            );
        }
        Ok(())
    }

    /// `dup` the master fd and make the copy non-blocking for tokio.
    fn duplicate_nonblocking(fd: RawFd) -> Result<OwnedFd> {
        let duplicated = unsafe { libc::dup(fd) };
        if duplicated < 0 {
            bail!(
                "failed to duplicate the PTY master: {}",
                io::Error::last_os_error()
            );
        }
        // SAFETY: `dup` returned a new owned descriptor; nothing else closes it.
        let owned = unsafe { OwnedFd::from_raw_fd(duplicated) };
        let flags = unsafe { libc::fcntl(owned.as_raw_fd(), libc::F_GETFL) };
        if flags < 0 {
            bail!(
                "failed to read the PTY master's flags: {}",
                io::Error::last_os_error()
            );
        }
        if unsafe { libc::fcntl(owned.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
            bail!(
                "failed to make the PTY master non-blocking: {}",
                io::Error::last_os_error()
            );
        }
        Ok(owned)
    }

    /// Non-blocking async I/O over one PTY master descriptor.
    ///
    /// The descriptor is already `O_NONBLOCK`; `AsyncFd` provides readiness and
    /// `try_io` clears it when the kernel says `EAGAIN`.
    struct AsyncFdIo {
        fd: AsyncFd<OwnedFd>,
    }

    impl AsyncFdIo {
        fn new(fd: OwnedFd) -> io::Result<Self> {
            Ok(Self {
                fd: AsyncFd::new(fd)?,
            })
        }
    }

    impl AsyncRead for AsyncFdIo {
        fn poll_read(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            let this = self.get_mut();
            let mut scratch = [0u8; READ_SCRATCH];
            loop {
                let mut guard = match this.fd.poll_read_ready(cx) {
                    Poll::Ready(Ok(guard)) => guard,
                    Poll::Ready(Err(err)) => return Poll::Ready(Err(err)),
                    Poll::Pending => return Poll::Pending,
                };
                let fd = guard.get_ref().as_raw_fd();
                match guard.try_io(|_| read_fd(fd, &mut scratch)) {
                    Ok(Ok(0)) => return Poll::Ready(Ok(())),
                    Ok(Ok(read)) => {
                        let take = read.min(buf.remaining());
                        let Some(bytes) = scratch.get(..take) else {
                            return Poll::Ready(Err(io::Error::other(
                                "PTY read length out of range",
                            )));
                        };
                        buf.put_slice(bytes);
                        return Poll::Ready(Ok(()));
                    }
                    // A master whose slave is gone reports EIO, not EOF.
                    Ok(Err(err)) if err.raw_os_error() == Some(libc::EIO) => {
                        return Poll::Ready(Ok(()));
                    }
                    Ok(Err(err)) if err.kind() == io::ErrorKind::WouldBlock => continue,
                    Ok(Err(err)) => return Poll::Ready(Err(err)),
                    Err(_would_block) => continue,
                }
            }
        }
    }

    impl AsyncWrite for AsyncFdIo {
        fn poll_write(
            self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            data: &[u8],
        ) -> Poll<io::Result<usize>> {
            let this = self.get_mut();
            loop {
                let mut guard = match this.fd.poll_write_ready(cx) {
                    Poll::Ready(Ok(guard)) => guard,
                    Poll::Ready(Err(err)) => return Poll::Ready(Err(err)),
                    Poll::Pending => return Poll::Pending,
                };
                let fd = guard.get_ref().as_raw_fd();
                match guard.try_io(|_| write_fd(fd, data)) {
                    Ok(Ok(written)) => return Poll::Ready(Ok(written)),
                    Ok(Err(err)) if err.kind() == io::ErrorKind::WouldBlock => continue,
                    Ok(Err(err)) => return Poll::Ready(Err(err)),
                    Err(_would_block) => continue,
                }
            }
        }

        fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            // Writes are unbuffered `write(2)` calls: a completed `poll_write`
            // is already at the pty.
            Poll::Ready(Ok(()))
        }

        fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
            Poll::Ready(Ok(()))
        }
    }

    fn read_fd(fd: RawFd, scratch: &mut [u8]) -> io::Result<usize> {
        let read = unsafe { libc::read(fd, scratch.as_mut_ptr().cast(), scratch.len()) };
        if read < 0 {
            return Err(io::Error::last_os_error());
        }
        usize::try_from(read).map_err(|_| io::Error::other("negative PTY read length"))
    }

    fn write_fd(fd: RawFd, data: &[u8]) -> io::Result<usize> {
        let written = unsafe { libc::write(fd, data.as_ptr().cast(), data.len()) };
        if written < 0 {
            return Err(io::Error::last_os_error());
        }
        usize::try_from(written).map_err(|_| io::Error::other("negative PTY write length"))
    }
}

#[cfg(unix)]
pub use unix::PtyTransport;

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::process::TmuxCommand;

    #[tokio::test]
    async fn the_cc_terminal_framing_never_reaches_the_protocol_stream() {
        use tokio::io::AsyncReadExt;
        use tokio::io::AsyncWriteExt;

        // A `-CC` stream: DCS introducer, CRLF-terminated records, ST at exit.
        // Every one of these breaks the Control Mode framing if passed through.
        let (mut wire, framing) = tokio::io::duplex(4096);
        let mut reader = PtyFraming::new(framing);
        let producer = tokio::spawn(async move {
            // Split the introducer across writes: a tty does not deliver it
            // whole.
            wire.write_all(b"\x1bP10").await.expect("first half");
            wire.write_all(b"00p%begin 1 0 0\r\n%end 1 0 0\r\n")
                .await
                .expect("welcome");
            wire.write_all(b"%output %0 hi\r\n").await.expect("output");
            wire.write_all(b"\x1b\\").await.expect("ST");
            drop(wire);
        });

        let mut stream = Vec::new();
        reader
            .read_to_end(&mut stream)
            .await
            .expect("read the stream");
        producer.await.expect("the producer ends");

        assert_eq!(
            stream, b"%begin 1 0 0\n%end 1 0 0\n%output %0 hi\n",
            "the introducer, the trailing ST and the tty's CRLF must all be \
             removed before the client's byte framing"
        );
    }

    #[tokio::test]
    async fn only_the_streams_own_framing_is_removed() {
        use tokio::io::AsyncReadExt;
        use tokio::io::AsyncWriteExt;

        // A `-CC` stream may carry a *real* `ESC \` inside a capture body: a
        // pane with an OSC-8 hyperlink ends its sequence with ST, and
        // `capture-pane -e` writes the body verbatim inside its response block
        // (measured against tmux 3.6b). Only the stream's closing ST is
        // framing, so only that one may be dropped. A bare CR before a non-LF,
        // and a trailing CR at EOF, are data too.
        let (mut wire, framing) = tokio::io::duplex(4096);
        let mut reader = PtyFraming::new(framing);
        let writer = tokio::spawn(async move {
            wire.write_all(b"%begin 1 0 0\n%end 1 0 0\n")
                .await
                .expect("welcome");
            wire.write_all(b"%begin 2 1 0\nA\x1b]8;;u\x1b\\L\x1b]8;;\x1b\\B\n%end 2 1 0\n")
                .await
                .expect("a capture body with OSC-8 hyperlinks");
            wire.write_all(b"%output %0 a\rZ\n").await.expect("output");
            wire.write_all(b"%output %0 tail\r")
                .await
                .expect("trailing CR");
            wire.write_all(b"\x1b\\").await.expect("closing framing");
            drop(wire);
        });

        let mut stream = Vec::new();
        reader
            .read_to_end(&mut stream)
            .await
            .expect("read the stream");
        writer.await.expect("the writer ends");

        assert_eq!(
            stream,
            b"%begin 1 0 0\n%end 1 0 0\n%begin 2 1 0\nA\x1b]8;;u\x1b\\L\x1b]8;;\x1b\\B\n%end 2 1 0\n\
              %output %0 a\rZ\n%output %0 tail\r",
            "a body's ST pairs, a CR before a non-LF and a trailing CR are data; \
             only the closing ST is framing"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_cc_child_that_exits_immediately_is_a_lost_source() {
        // The launch succeeded (the fixture exists and was spawned) but tmux
        // died without a welcome pair. That is not a connect error — it is
        // source loss, and the stream must say so instead of hanging.
        use crate::client::{ControlTransport, TmuxClient, TmuxEvent};
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::testing::FakeTmux::new(dir.path(), "exit 1");

        let mut client = TmuxClient::connect_with(
            &fake.command(),
            "nession-fake-sess",
            ControlTransport::Pty { cols: 80, rows: 24 },
        )
        .expect("the fixture exists, so the PTY spawn succeeds");
        let mut events = client.take_events().expect("the test owns the events");
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), events.recv())
            .await
            .expect("the source must report its loss")
            .expect("the event stream stays open");
        assert!(
            matches!(event, TmuxEvent::SourceLost { .. }),
            "an immediate -CC death must be stated as source loss, got {event:?}"
        );
        client.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_real_pty_cc_attach_handshakes_and_answers_a_command() {
        // Through a real PTY, with the fake playing tmux: the DCS introducer,
        // the CRLF line endings, the stdin protocol fd and the raw termios all
        // have to hold together for the client to see a welcome pair and a
        // reply. Runs on macOS too, which the real-tmux integration tests do
        // not.
        use crate::client::{ControlCommand, ControlTransport, TmuxClient, TmuxEvent};
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::testing::FakeTmux::new(
            dir.path(),
            "case \"$1\" in \
             -CC) printf '\\033P1000p'; \
                  printf '%%begin 1 0 0\\r\\n%%end 1 0 0\\r\\n'; \
                  IFS= read -r line; \
                  printf '%%begin 2 1 0\\r\\n%%end 2 1 0\\r\\n'; \
                  exit 0;; \
             *) exit 0;; esac",
        );

        let mut client = TmuxClient::connect_with(
            &fake.command(),
            "nession-fake-sess",
            ControlTransport::Pty { cols: 80, rows: 24 },
        )
        .expect("the fake accepts the -CC attach");
        let mut events = client.take_events().expect("the test owns the events");

        assert_eq!(
            tokio::time::timeout(std::time::Duration::from_secs(5), events.recv())
                .await
                .expect("the welcome pair must arrive through the PTY framing")
                .expect("the event stream stays open"),
            TmuxEvent::Handshaken,
        );
        let reply = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            client.command(ControlCommand::RefreshClient),
        )
        .await
        .expect("the command must be answered")
        .expect("the fake answers with %end");
        assert_eq!(reply, b"");
        let calls = fake
            .wait_for_calls(1, std::time::Duration::from_secs(5))
            .await;
        assert_eq!(
            calls.first(),
            Some(&vec![
                "-CC".to_string(),
                "attach".to_string(),
                "-t".to_string(),
                "nession-fake-sess".to_string(),
            ]),
            "the PTY child is the injected tmux attaching over -CC: {calls:?}"
        );
        client.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_pipe_child_that_exits_immediately_is_a_lost_source() {
        // The same statement for the production transport: a spawn that
        // succeeded and a child that died before the welcome pair is source
        // loss, not a hang.
        use crate::client::{ControlTransport, TmuxClient, TmuxEvent};
        let dir = tempfile::tempdir().expect("tempdir");
        let fake = crate::testing::FakeTmux::new(dir.path(), "exit 1");

        let mut client =
            TmuxClient::connect_with(&fake.command(), "nession-fake-sess", ControlTransport::Pipe)
                .expect("the fixture exists, so the pipe spawn succeeds");
        let mut events = client.take_events().expect("the test owns the events");
        let event = tokio::time::timeout(std::time::Duration::from_secs(5), events.recv())
            .await
            .expect("the source must report its loss")
            .expect("the event stream stays open");
        assert!(
            matches!(event, TmuxEvent::SourceLost { .. }),
            "an immediate -C death must be stated as source loss, got {event:?}"
        );
        client.close().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_missing_tmux_is_an_error_on_both_transports_and_never_a_fallback() {
        use crate::client::{ControlTransport, TmuxClient};
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = TmuxCommand::new(
            dir.path()
                .join("missing-tmux")
                .to_string_lossy()
                .into_owned(),
            dir.path().join("tmux.sock"),
        );
        let dep = missing;

        for transport in [
            ControlTransport::Pipe,
            ControlTransport::Pty { cols: 80, rows: 24 },
        ] {
            let result = TmuxClient::connect_with(&dep, "nession-sess", transport);
            assert!(
                result.is_err(),
                "{transport:?} must report the failed launch, not fall back"
            );
        }
    }
}
