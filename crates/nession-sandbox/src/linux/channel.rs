//! The trusted host-side channel for one Linux sandbox execution.
//!
//! It owns two jobs:
//!
//! 1. **Launch barrier.** The in-sandbox bridge connects before it starts the
//!    user's shell and waits. The Agent verifies the namespace/cgroup/seccomp
//!    facts and only then writes `GO`; user code cannot run in a window where a
//!    required control is missing.
//! 2. **Restricted-network proxy.** The same Unix socket serves SOCKS5 and
//!    HTTP `CONNECT` tunnels. Every accepted connection is authenticated by
//!    `SO_PEERCRED`: its host PID must be the bridge process of this execution.
//!    A socket path alone is not an identity.
//!
//! Calls are blocking and bounded; the Agent runs preparation on a blocking
//! task, never on an async worker.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use crate::error::{Result, SandboxError};
use crate::linux::verify::BridgeFacts;
use crate::network::{EgressDenial, EgressRules};

const HELLO_PREFIX: &str = "NESSON-SANDBOX-1";
const MAX_PROXY_CONNECTIONS: usize = 64;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TUNNEL_IDLE_TIMEOUT: Duration = Duration::from_secs(3600);

/// One accepted control connection, already classified as the bridge.
pub struct ControlPeer {
    execution_id_ok: bool,
    pid: u32,
    facts: Option<BridgeFacts>,
    stream: UnixStream,
}

impl ControlPeer {
    /// The bridge's host PID, authenticated by the kernel's peer credentials.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Whether the hello named this execution.
    pub fn execution_id_ok(&self) -> bool {
        self.execution_id_ok
    }

    /// Facts the bridge reported before user code started.
    pub fn facts(&self) -> Option<&BridgeFacts> {
        self.facts.as_ref()
    }
}

/// The host side of one execution's channel.
pub struct Channel {
    host_socket: PathBuf,
    shutdown: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
    control_rx: Option<mpsc::Receiver<ControlPeer>>,
    bridge_pid: Arc<AtomicU32>,
    proxy_rules: Option<Arc<EgressRules>>,
    accepted: Arc<AtomicBool>,
}

impl Channel {
    /// Bind the channel socket inside `directory` and start accepting.
    ///
    /// `proxy_rules` makes this a restricted-network channel; `None` accepts
    /// only the control connection.
    pub fn start(
        execution_id: &str,
        directory: &Path,
        proxy_rules: Option<Arc<EgressRules>>,
    ) -> Result<Self> {
        std::fs::create_dir_all(directory).map_err(|error| {
            SandboxError::Prepare(format!(
                "create channel directory {}: {error}",
                directory.display()
            ))
        })?;
        let host_socket = directory.join("channel.sock");
        let _ = std::fs::remove_file(&host_socket);
        let listener = UnixListener::bind(&host_socket).map_err(|error| {
            SandboxError::Prepare(format!("bind {}: {error}", host_socket.display()))
        })?;
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) =
            std::fs::set_permissions(&host_socket, std::fs::Permissions::from_mode(0o600))
        {
            let _ = std::fs::remove_file(&host_socket);
            return Err(SandboxError::Prepare(format!(
                "restrict channel socket permissions: {error}"
            )));
        }
        listener.set_nonblocking(true).map_err(|error| {
            SandboxError::Prepare(format!("make channel listener nonblocking: {error}"))
        })?;

        let (control_tx, control_rx) = mpsc::channel();
        let shutdown = Arc::new(AtomicBool::new(false));
        let bridge_pid = Arc::new(AtomicU32::new(0));
        let accepted = Arc::new(AtomicBool::new(false));
        let execution_id = execution_id.to_string();
        let thread_shutdown = Arc::clone(&shutdown);
        let thread_bridge_pid = Arc::clone(&bridge_pid);
        let thread_accepted = Arc::clone(&accepted);
        let thread_rules = proxy_rules.clone();
        let thread = std::thread::Builder::new()
            .name("nession-sandbox-channel".to_string())
            .spawn(move || {
                accept_loop(
                    listener,
                    &execution_id,
                    &control_tx,
                    &thread_shutdown,
                    &thread_bridge_pid,
                    &thread_accepted,
                    thread_rules,
                );
            })
            .map_err(|error| SandboxError::Prepare(format!("start channel thread: {error}")))?;

        Ok(Self {
            host_socket,
            shutdown,
            thread: Some(thread),
            control_rx: Some(control_rx),
            bridge_pid,
            proxy_rules,
            accepted,
        })
    }

    /// The host path the bridge's channel is bind-mounted from.
    pub fn host_socket(&self) -> &Path {
        &self.host_socket
    }

    /// Whether this channel serves restricted-network tunnels.
    pub fn has_proxy(&self) -> bool {
        self.proxy_rules.is_some()
    }

    /// Wait for the bridge's control connection.
    pub fn wait_for_control(&self, timeout: Duration) -> Result<ControlPeer> {
        let receiver = self.control_rx.as_ref().ok_or_else(|| {
            SandboxError::Verify("control channel is already released".to_string())
        })?;
        receiver.recv_timeout(timeout).map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => SandboxError::Verify(format!(
                "the sandbox init did not connect within {timeout:?}"
            )),
            mpsc::RecvTimeoutError::Disconnected => {
                SandboxError::Verify("channel closed before the sandbox init connected".to_string())
            }
        })
    }

    /// Record the verified bridge PID and release the launch barrier.
    pub fn release(&mut self, mut peer: ControlPeer) -> Result<()> {
        if !peer.execution_id_ok {
            let _ = peer.stream.write_all(b"DENY\n");
            return Err(SandboxError::Verify(
                "the sandbox init named a different execution".to_string(),
            ));
        }
        self.bridge_pid.store(peer.pid, Ordering::SeqCst);
        peer.stream
            .write_all(b"GO\n")
            .and_then(|()| peer.stream.flush())
            .map_err(|error| {
                SandboxError::Verify(format!("release the launch barrier: {error}"))
            })?;
        // The control stream ends here; the bridge owns its side.
        Ok(())
    }

    /// Refuse the launch barrier. The caller still kills the Session.
    pub fn deny(&self, mut peer: ControlPeer) {
        let _ = peer.stream.write_all(b"DENY\n");
        let _ = peer.stream.flush();
    }

    /// Observed tunnel count, for evidence only.
    pub fn accepted_any(&self) -> bool {
        self.accepted.load(Ordering::SeqCst)
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::SeqCst);
        // Wake a blocking accept in the thread by connecting to it. The
        // listener is nonblocking, so the loop also observes `shutdown`.
        let _ = UnixStream::connect(&self.host_socket);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        let _ = std::fs::remove_file(&self.host_socket);
    }
}

#[allow(clippy::too_many_arguments)]
fn accept_loop(
    listener: UnixListener,
    execution_id: &str,
    control_tx: &mpsc::Sender<ControlPeer>,
    shutdown: &AtomicBool,
    bridge_pid: &AtomicU32,
    accepted: &AtomicBool,
    proxy_rules: Option<Arc<EgressRules>>,
) {
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _address)) => {
                accepted.store(true, Ordering::SeqCst);
                if let Err(error) = classify(
                    stream,
                    execution_id,
                    control_tx,
                    bridge_pid,
                    proxy_rules.as_ref(),
                ) {
                    tracing::debug!("sandbox channel connection refused: {error}");
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => {
                tracing::warn!("sandbox channel accept failed: {error}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

fn classify(
    stream: UnixStream,
    execution_id: &str,
    control_tx: &mpsc::Sender<ControlPeer>,
    bridge_pid: &AtomicU32,
    proxy_rules: Option<&Arc<EgressRules>>,
) -> io::Result<()> {
    let pid = peer_pid(&stream)?;
    stream.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    stream.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;

    let mut first = [0u8; 1];
    stream.peek(&mut first)?;
    if first[0] == b'N' {
        let mut reader = BufReader::new(stream);
        let mut hello = String::new();
        reader.read_line(&mut hello)?;
        let hello = hello.trim_end();
        let named = hello
            .strip_prefix(HELLO_PREFIX)
            .map(str::trim)
            .is_some_and(|named| named == execution_id);
        let mut facts_line = String::new();
        let facts = match reader.read_line(&mut facts_line) {
            Ok(0) => None,
            Ok(_) => serde_json::from_str::<BridgeFacts>(facts_line.trim_end()).ok(),
            Err(_) => None,
        };
        let stream = reader.into_inner();
        let peer = ControlPeer {
            execution_id_ok: named,
            pid,
            facts,
            stream,
        };
        control_tx
            .send(peer)
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "control receiver is gone"))?;
        return Ok(());
    }

    let Some(rules) = proxy_rules else {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "this execution has no network channel",
        ));
    };
    let expected = bridge_pid.load(Ordering::SeqCst);
    if expected == 0 || pid != expected {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "proxy peer is not this execution's bridge",
        ));
    }
    let Some(slot) = reserve_proxy_slot() else {
        return Err(io::Error::new(
            io::ErrorKind::WouldBlock,
            "proxy connection limit reached",
        ));
    };
    let rules = Arc::clone(rules);
    std::thread::Builder::new()
        .name("nession-sandbox-proxy".to_string())
        .spawn(move || {
            let _slot = slot;
            serve_proxy(stream, &rules);
        })
        .map_err(|error| io::Error::other(error.to_string()))?;
    Ok(())
}

/// `SO_PEERCRED` returns the peer's PID in the receiver's PID namespace.
fn peer_pid(stream: &UnixStream) -> io::Result<u32> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `credentials` and `length` are valid for the call; the socket is
    // owned by this process.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    u32::try_from(credentials.pid)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "negative peer pid"))
}

/// Serve one restricted-network connection: SOCKS5 or HTTP `CONNECT`.
fn serve_proxy(mut client: UnixStream, rules: &EgressRules) {
    let _ = client.set_read_timeout(Some(HANDSHAKE_TIMEOUT));
    let _ = client.set_write_timeout(Some(HANDSHAKE_TIMEOUT));
    let mut first = [0u8; 1];
    let Ok(1) = client.read(&mut first) else {
        return;
    };
    let first = first.first().copied().unwrap_or_default();
    let result = if first == 0x05 {
        socks5_connect(&mut client, rules)
    } else {
        http_connect(&mut client, rules, first)
    };
    match result {
        Ok((mut upstream, leftover)) => {
            let _ = client.set_read_timeout(Some(TUNNEL_IDLE_TIMEOUT));
            let _ = client.set_write_timeout(Some(TUNNEL_IDLE_TIMEOUT));
            let _ = upstream.set_read_timeout(Some(TUNNEL_IDLE_TIMEOUT));
            let _ = upstream.set_write_timeout(Some(TUNNEL_IDLE_TIMEOUT));
            tunnel(client, upstream, leftover);
        }
        Err(error) => {
            tracing::debug!("sandbox proxy refused a destination: {error}");
        }
    }
}

fn socks5_connect(
    client: &mut UnixStream,
    rules: &EgressRules,
) -> std::result::Result<(TcpStream, Vec<u8>), EgressDenial> {
    let mut header = [0u8; 1];
    if read_exact(client, &mut header).is_err() || header[0] == 0 {
        return Err(EgressDenial::NotAllowed);
    }
    let mut methods = vec![0u8; header[0] as usize];
    if read_exact(client, &mut methods).is_err() || !methods.contains(&0x00) {
        let _ = client.write_all(&[0x05, 0xff]);
        return Err(EgressDenial::NotAllowed);
    }
    if client.write_all(&[0x05, 0x00]).is_err() {
        return Err(EgressDenial::NotAllowed);
    }

    let mut request = [0u8; 3];
    if read_exact(client, &mut request).is_err() || request[0] != 0x05 {
        return Err(EgressDenial::NotAllowed);
    }
    if request[1] != 0x01 {
        // BIND and UDP ASSOCIATE are not part of the V1 contract.
        let _ = client.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
        return Err(EgressDenial::NotAllowed);
    }

    let target = match request[3] {
        0x01 => {
            let mut octets = [0u8; 4];
            if read_exact(client, &mut octets).is_err() {
                return Err(EgressDenial::NotAllowed);
            }
            Target::Ip(IpAddr::from(octets))
        }
        0x04 => {
            let mut octets = [0u8; 16];
            if read_exact(client, &mut octets).is_err() {
                return Err(EgressDenial::NotAllowed);
            }
            Target::Ip(IpAddr::from(octets))
        }
        0x03 => {
            let mut length = [0u8; 1];
            if read_exact(client, &mut length).is_err() {
                return Err(EgressDenial::NotAllowed);
            }
            let mut name = vec![0u8; length[0] as usize];
            if read_exact(client, &mut name).is_err() {
                return Err(EgressDenial::NotAllowed);
            }
            match String::from_utf8(name) {
                Ok(name) => Target::Domain(name),
                Err(_) => {
                    let _ = client.write_all(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
                    return Err(EgressDenial::NotAllowed);
                }
            }
        }
        _ => {
            let _ = client.write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            return Err(EgressDenial::NotAllowed);
        }
    };
    let mut port_bytes = [0u8; 2];
    if read_exact(client, &mut port_bytes).is_err() {
        return Err(EgressDenial::NotAllowed);
    }
    let port = u16::from_be_bytes(port_bytes);

    match connect_target(&target, port, rules) {
        Ok(upstream) => {
            let _ = client.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            Ok((upstream, Vec::new()))
        }
        Err(denial) => {
            let reply = match denial {
                EgressDenial::DeniedByRule | EgressDenial::NotAllowed => 0x02,
                EgressDenial::PrivateAddress => 0x02,
                EgressDenial::Unresolvable => 0x04,
            };
            let _ = client.write_all(&[0x05, reply, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            Err(denial)
        }
    }
}

fn http_connect(
    client: &mut UnixStream,
    rules: &EgressRules,
    first: u8,
) -> std::result::Result<(TcpStream, Vec<u8>), EgressDenial> {
    // Read the request line and headers, starting with the byte already read.
    let mut head = vec![first];
    let mut buffer = [0u8; 1024];
    const MAX_HEAD: usize = 16 * 1024;
    loop {
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
        if head.len() > MAX_HEAD {
            let _ = client.write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\n\r\n");
            return Err(EgressDenial::NotAllowed);
        }
        match client.read(&mut buffer) {
            Ok(0) => return Err(EgressDenial::NotAllowed),
            Ok(read) => {
                let chunk = buffer.get(..read).ok_or(EgressDenial::NotAllowed)?;
                head.extend_from_slice(chunk);
            }
            Err(_) => return Err(EgressDenial::NotAllowed),
        }
    }

    let end = head
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|position| position + 4)
        .ok_or(EgressDenial::NotAllowed)?;
    let (header_bytes, leftover) = head.split_at(end);
    let text = String::from_utf8_lossy(header_bytes);
    let request_line = text.lines().next().unwrap_or_default();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default();
    let authority = parts.next().unwrap_or_default();
    if method != "CONNECT" {
        let _ = client.write_all(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n");
        return Err(EgressDenial::NotAllowed);
    }
    let Some((host, port)) = split_authority(authority) else {
        let _ = client.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
        return Err(EgressDenial::NotAllowed);
    };
    let target = match host.parse::<IpAddr>() {
        Ok(ip) => Target::Ip(ip),
        Err(_) => Target::Domain(host.to_string()),
    };
    match connect_target(&target, port, rules) {
        Ok(upstream) => {
            let _ = client.write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n");
            Ok((upstream, leftover.to_vec()))
        }
        Err(denial) => {
            let _ = client.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n");
            Err(denial)
        }
    }
}

fn split_authority(authority: &str) -> Option<(&str, u16)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let end = rest.find(']')?;
        let host = rest.get(..end)?;
        let port = rest.get(end + 1..)?.strip_prefix(':')?;
        return Some((host, port.parse().ok()?));
    }
    let (host, port) = authority.rsplit_once(':')?;
    if host.is_empty() {
        return None;
    }
    Some((host, port.parse().ok()?))
}

enum Target {
    Domain(String),
    Ip(IpAddr),
}

fn connect_target(
    target: &Target,
    port: u16,
    rules: &EgressRules,
) -> std::result::Result<TcpStream, EgressDenial> {
    match target {
        Target::Ip(ip) => {
            rules.authorize_ip(*ip, port)?;
            connect_validated(SocketAddr::new(*ip, port))
        }
        Target::Domain(host) => {
            rules.authorize_host(host, port)?;
            let addresses = (host.as_str(), port)
                .to_socket_addrs()
                .map_err(|_| EgressDenial::Unresolvable)?;
            let mut last = EgressDenial::Unresolvable;
            for address in addresses {
                match rules.authorize_ip(address.ip(), port) {
                    Ok(()) => match connect_validated(address) {
                        Ok(stream) => return Ok(stream),
                        Err(denial) => last = denial,
                    },
                    Err(denial) => last = denial,
                }
            }
            Err(last)
        }
    }
}

fn connect_validated(address: SocketAddr) -> std::result::Result<TcpStream, EgressDenial> {
    // Connect to the already-validated address. There is no second DNS
    // resolution between the check and the connect, so rebinding cannot move
    // the connection to a different address.
    TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(|_| EgressDenial::Unresolvable)
}

fn read_exact(stream: &mut UnixStream, buffer: &mut [u8]) -> io::Result<()> {
    stream.read_exact(buffer)
}

fn tunnel(mut client: UnixStream, mut upstream: TcpStream, leftover: Vec<u8>) {
    if !leftover.is_empty() && upstream.write_all(&leftover).is_err() {
        return;
    }
    let Ok(mut client_read) = client.try_clone() else {
        return;
    };
    let Ok(mut upstream_write) = upstream.try_clone() else {
        return;
    };
    let forward = std::thread::spawn(move || {
        let _ = io::copy(&mut client_read, &mut upstream_write);
        let _ = upstream_write.shutdown(std::net::Shutdown::Write);
    });
    let _ = io::copy(&mut upstream, &mut client);
    let _ = client.shutdown(std::net::Shutdown::Write);
    let _ = forward.join();
}

/// Global in-flight proxy connection bound, so one execution cannot spawn an
/// unbounded number of worker threads.
static PROXY_CONNECTIONS: Mutex<usize> = Mutex::new(0);

fn reserve_proxy_slot() -> Option<ProxySlot> {
    let Ok(mut count) = PROXY_CONNECTIONS.lock() else {
        return None;
    };
    if *count >= MAX_PROXY_CONNECTIONS {
        return None;
    }
    *count += 1;
    Some(ProxySlot)
}

struct ProxySlot;

impl Drop for ProxySlot {
    fn drop(&mut self) {
        let Ok(mut count) = PROXY_CONNECTIONS.lock() else {
            return;
        };
        if *count > 0 {
            *count -= 1;
        }
    }
}
