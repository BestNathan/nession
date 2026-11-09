//! The in-sandbox init and bridge.
//!
//! It runs as PID 1 in the sandbox's PID namespace, before any user code:
//!
//! 1. binds the sandbox-local proxy endpoint (restricted mode);
//! 2. connects to the trusted host channel and reports the facts it can see
//!    from inside the sandbox;
//! 3. waits for `GO` from the host — the launch barrier;
//! 4. spawns the user's shell, forwards signals, and reaps orphans.
//!
//! It is dispatched as a hidden subcommand of the Agent binary
//! ([`SUBCOMMAND`]), so no second artifact must be installed inside the
//! sandbox. The binary is bind-mounted read-only at a fixed path.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::Duration;

use crate::facts::BridgeFacts;

/// The hidden subcommand that dispatches here.
pub const SUBCOMMAND: &str = "__nession-sandbox-bridge";

const HELLO_PREFIX: &str = "NESSON-SANDBOX-1";
const RELEASE_TIMEOUT: Duration = Duration::from_secs(60);
const TUNNEL_IDLE_TIMEOUT: Duration = Duration::from_secs(3600);

/// True when the process was started as the sandbox bridge.
pub fn is_bridge_invocation(arguments: &[String]) -> bool {
    arguments
        .get(1)
        .is_some_and(|argument| argument == SUBCOMMAND)
}

/// Run from the process arguments. Returns the process exit code.
pub fn run_from_std_args() -> i32 {
    let arguments: Vec<String> = std::env::args().collect();
    run(arguments.get(2..).unwrap_or_default())
}

struct BridgeArgs {
    channel: PathBuf,
    execution_id: String,
    proxy_listen: Option<SocketAddr>,
    visible_probes: Vec<String>,
    hidden_probes: Vec<String>,
    command: Vec<String>,
}

fn parse(arguments: &[String]) -> Result<BridgeArgs, String> {
    let mut channel = None;
    let mut execution_id = None;
    let mut proxy_listen = None;
    let mut visible_probes = Vec::new();
    let mut hidden_probes = Vec::new();
    let mut command = Vec::new();
    let mut index = 0;
    while index < arguments.len() {
        let Some(argument) = arguments.get(index) else {
            break;
        };
        match argument.as_str() {
            "--channel" => {
                index += 1;
                channel = arguments.get(index).cloned();
            }
            "--execution-id" => {
                index += 1;
                execution_id = arguments.get(index).cloned();
            }
            "--proxy-listen" => {
                index += 1;
                let value = arguments
                    .get(index)
                    .ok_or_else(|| "--proxy-listen needs an address".to_string())?;
                proxy_listen = Some(
                    value
                        .parse()
                        .map_err(|error| format!("invalid --proxy-listen: {error}"))?,
                );
            }
            "--probe-visible" => {
                index += 1;
                visible_probes.push(
                    arguments
                        .get(index)
                        .ok_or_else(|| "--probe-visible needs a path".to_string())?
                        .clone(),
                );
            }
            "--probe-hidden" => {
                index += 1;
                hidden_probes.push(
                    arguments
                        .get(index)
                        .ok_or_else(|| "--probe-hidden needs a path".to_string())?
                        .clone(),
                );
            }
            "--" => {
                command = arguments.get(index + 1..).unwrap_or_default().to_vec();
                break;
            }
            other => return Err(format!("unknown sandbox bridge argument `{other}`")),
        }
        index += 1;
    }
    let channel = channel.ok_or_else(|| "--channel is required".to_string())?;
    let execution_id = execution_id.ok_or_else(|| "--execution-id is required".to_string())?;
    if command.is_empty() {
        return Err("a command after `--` is required".to_string());
    }
    Ok(BridgeArgs {
        channel: PathBuf::from(channel),
        execution_id,
        proxy_listen,
        visible_probes,
        hidden_probes,
        command,
    })
}

/// Run the bridge. Never returns before the child finishes or the barrier is
/// refused.
pub fn run(arguments: &[String]) -> i32 {
    let args = match parse(arguments) {
        Ok(args) => args,
        Err(error) => {
            eprintln!("nession-sandbox-bridge: {error}");
            return 125;
        }
    };

    // Bind first: a proxy that cannot listen must refuse the launch before the
    // user's shell exists.
    let listener = match args.proxy_listen {
        Some(address) => match TcpListener::bind(address) {
            Ok(listener) => Some(listener),
            Err(error) => {
                eprintln!("nession-sandbox-bridge: bind proxy {address}: {error}");
                return 125;
            }
        },
        None => None,
    };

    let mut channel = match UnixStream::connect(&args.channel) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!(
                "nession-sandbox-bridge: connect to the host channel {}: {error}",
                args.channel.display()
            );
            return 125;
        }
    };
    let _ = channel.set_read_timeout(Some(RELEASE_TIMEOUT));
    let _ = channel.set_write_timeout(Some(RELEASE_TIMEOUT));

    let facts = collect_facts(&args.visible_probes, &args.hidden_probes);
    let facts_json = match serde_json::to_string(&facts) {
        Ok(json) => json,
        Err(error) => {
            eprintln!("nession-sandbox-bridge: serialize facts: {error}");
            return 125;
        }
    };
    let hello = format!("{HELLO_PREFIX} {}\n{facts_json}\n", args.execution_id);
    if channel.write_all(hello.as_bytes()).is_err() || channel.flush().is_err() {
        eprintln!("nession-sandbox-bridge: the host channel refused the hello");
        return 125;
    }

    // Wait for the launch barrier. The host verifies the facts above and only
    // then sends GO; DENY, EOF or a timeout means no user code may run.
    let mut reply = String::new();
    let mut reader = BufReader::new(channel);
    match reader.read_line(&mut reply) {
        Ok(0) => return 125,
        Ok(_) if reply.trim_end() == "GO" => {}
        Ok(_) => return 125,
        Err(_) => return 125,
    }
    drop(reader);

    if let Some(listener) = listener {
        let channel_path = args.channel.clone();
        if let Err(error) = std::thread::Builder::new()
            .name("nession-sandbox-proxy".to_string())
            .spawn(move || proxy_accept_loop(listener, channel_path))
        {
            eprintln!("nession-sandbox-bridge: start proxy: {error}");
            return 125;
        }
    }

    let Some(program) = args.command.first() else {
        return 126;
    };
    let mut command = Command::new(program);
    command.args(args.command.get(1..).unwrap_or_default());
    command
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            eprintln!("nession-sandbox-bridge: spawn {program}: {error}");
            return 126;
        }
    };
    let child_pid = match i32::try_from(child.id()) {
        Ok(pid) => pid,
        Err(_) => return 126,
    };
    CHILD_PID.store(child_pid, Ordering::SeqCst);
    install_signal_forwarding();
    reap_until(child_pid)
}

/// The bridge's own PID as seen from inside the namespace.
fn collect_facts(visible: &[String], hidden: &[String]) -> BridgeFacts {
    let mut facts = BridgeFacts {
        ns_pid: std::process::id(),
        ..BridgeFacts::default()
    };
    for name in ["mnt", "pid", "user", "ipc", "uts", "net", "cgroup"] {
        let path = format!("/proc/self/ns/{name}");
        if let Ok(target) = std::fs::read_link(&path) {
            facts
                .namespaces
                .insert(name.to_string(), target.to_string_lossy().into_owned());
        }
    }
    if let Ok(cgroup) = std::fs::read_to_string("/proc/self/cgroup") {
        facts.cgroup = cgroup
            .lines()
            .find(|line| line.starts_with("0::"))
            .unwrap_or_default()
            .to_string();
    }
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            if let Some(value) = line.strip_prefix("Seccomp:") {
                facts.seccomp = value.trim().to_string();
            }
            if let Some(value) = line.strip_prefix("NoNewPrivs:") {
                facts.no_new_privs = value.trim().to_string();
            }
        }
    }
    for path in visible {
        match std::path::Path::new(path).try_exists() {
            Ok(true) => facts.visible.push(path.clone()),
            Ok(false) => facts
                .probe_errors
                .push(format!("visible probe {path} is absent")),
            Err(error) => facts
                .probe_errors
                .push(format!("visible probe {path}: {error}")),
        }
    }
    for path in hidden {
        match std::path::Path::new(path).try_exists() {
            Ok(false) => facts.hidden.push(path.clone()),
            Ok(true) => facts
                .probe_errors
                .push(format!("hidden probe {path} is visible")),
            Err(error) => facts
                .probe_errors
                .push(format!("hidden probe {path}: {error}")),
        }
    }
    facts
}

static CHILD_PID: AtomicI32 = AtomicI32::new(0);

extern "C" fn forward_signal(signal: libc::c_int) {
    let pid = CHILD_PID.load(Ordering::SeqCst);
    if pid > 0 {
        // SAFETY: kill is async-signal-safe and the PID is our own child.
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

fn install_signal_forwarding() {
    let handler = forward_signal as *const () as libc::sighandler_t;
    for signal in [libc::SIGHUP, libc::SIGTERM, libc::SIGINT, libc::SIGQUIT] {
        // SAFETY: installing a handler for a signal that only calls kill().
        unsafe {
            libc::signal(signal, handler);
        }
    }
}

fn reap_until(child_pid: i32) -> i32 {
    loop {
        let mut status: libc::c_int = 0;
        // SAFETY: waitpid with a valid status pointer and pid -1.
        let pid = unsafe { libc::waitpid(-1, &mut status, 0) };
        if pid < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            if error.raw_os_error() == Some(libc::ECHILD) {
                return 0;
            }
            return 1;
        }
        if pid == child_pid {
            return decode_status(status);
        }
        // Any other child is an orphan reparented to this init; reaping it is
        // the reason this process exists as PID 1.
    }
}

fn decode_status(status: libc::c_int) -> i32 {
    let signal = status & 0x7f;
    if signal == 0 {
        (status >> 8) & 0xff
    } else {
        128 + signal
    }
}

fn proxy_accept_loop(listener: TcpListener, channel: PathBuf) {
    for client in listener.incoming() {
        let Ok(client) = client else {
            continue;
        };
        let channel = channel.clone();
        let _ = std::thread::Builder::new()
            .name("nession-sandbox-proxy-conn".to_string())
            .spawn(move || bridge_connection(client, &channel));
    }
}

fn bridge_connection(mut client: TcpStream, channel: &PathBuf) {
    let Ok(mut host) = UnixStream::connect(channel) else {
        return;
    };
    let _ = client.set_read_timeout(Some(TUNNEL_IDLE_TIMEOUT));
    let _ = client.set_write_timeout(Some(TUNNEL_IDLE_TIMEOUT));
    let _ = host.set_read_timeout(Some(TUNNEL_IDLE_TIMEOUT));
    let _ = host.set_write_timeout(Some(TUNNEL_IDLE_TIMEOUT));
    let Ok(mut client_read) = client.try_clone() else {
        return;
    };
    let Ok(mut host_write) = host.try_clone() else {
        return;
    };
    let forward = std::thread::spawn(move || {
        let _ = std::io::copy(&mut client_read, &mut host_write);
        let _ = host_write.shutdown(std::net::Shutdown::Write);
    });
    let _ = std::io::copy(&mut host, &mut client);
    let _ = client.shutdown(std::net::Shutdown::Write);
    let _ = forward.join();
}
