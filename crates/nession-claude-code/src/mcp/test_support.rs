//! A minimal in-process MCP HTTP endpoint for the discovery and Connect tests
//! (#3600).
//!
//! It answers the legacy handshake this client actually sends, records the
//! request headers and JSON-RPC methods it saw, and refuses to invent any
//! capability it was not asked about. Tests own its lifetime and abort it.

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

pub struct FakeMcp {
    pub addr: SocketAddr,
    pub seen: Arc<Mutex<Vec<SeenRequest>>>,
    task: JoinHandle<()>,
}

pub struct SeenRequest {
    pub authorization: Option<String>,
    pub method: Option<String>,
}

impl Drop for FakeMcp {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl FakeMcp {
    pub async fn start() -> Self {
        Self::start_with_auth(None).await
    }

    pub async fn start_requiring(token: &str) -> Self {
        Self::start_with_auth(Some(token.to_string())).await
    }

    async fn start_with_auth(required_auth: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&seen);
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let mut raw = Vec::new();
                let mut chunk = [0u8; 4096];
                let Some((headers_end, body_length)) =
                    read_headers(&mut socket, &mut raw, &mut chunk).await
                else {
                    continue;
                };
                while raw.len() < headers_end + 4 + body_length {
                    let read = socket.read(&mut chunk).await.unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    raw.extend_from_slice(chunk.get(..read).unwrap_or(&[]));
                }
                let request_line = String::from_utf8_lossy(&raw)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .to_string();
                let body = raw
                    .get(headers_end + 4..headers_end + 4 + body_length)
                    .map(|body| String::from_utf8_lossy(body).into_owned())
                    .unwrap_or_default();
                let payload: Option<Value> = serde_json::from_str(&body).ok();
                let authorization = String::from_utf8_lossy(&raw)
                    .lines()
                    .find(|line| line.to_ascii_lowercase().starts_with("authorization:"))
                    .map(|line| line["authorization:".len()..].trim().to_string());
                let method = payload
                    .as_ref()
                    .and_then(|payload| payload.get("method"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                recorded.lock().await.push(SeenRequest {
                    authorization: authorization.clone(),
                    method: method.clone(),
                });

                if let Some(required) = required_auth.as_deref() {
                    let presented = authorization
                        .as_deref()
                        .and_then(|header| header.strip_prefix("Bearer "));
                    if presented != Some(required) {
                        let _ = socket
                            .write_all(
                                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                        continue;
                    }
                }

                if request_line.starts_with("DELETE") {
                    let _ = socket
                        .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                        .await;
                    continue;
                }
                let response = match method.as_deref() {
                    Some("initialize") => {
                        let id = payload
                            .as_ref()
                            .and_then(|payload| payload.get("id"))
                            .cloned()
                            .unwrap_or(json!(1));
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "protocolVersion": "2025-03-26",
                                "capabilities": {"tools": {}},
                                "serverInfo": {"name": "fake-mcp", "version": "1"}
                            }
                        })
                    }
                    Some("tools/list") => {
                        let id = payload
                            .as_ref()
                            .and_then(|payload| payload.get("id"))
                            .cloned()
                            .unwrap_or(json!(2));
                        json!({
                            "jsonrpc": "2.0",
                            "id": id,
                            "result": {
                                "tools": [{
                                    "name": "echo",
                                    "description": "Echo a value",
                                    "inputSchema": {"type": "object"}
                                }]
                            }
                        })
                    }
                    _ => {
                        let _ = socket
                            .write_all(
                                b"HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                            )
                            .await;
                        continue;
                    }
                };
                let body = serde_json::to_vec(&response).unwrap();
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nMcp-Session-Id: fake-session\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(&body).await;
            }
        });
        Self { addr, seen, task }
    }

    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }

    pub async fn methods(&self) -> Vec<String> {
        self.seen
            .lock()
            .await
            .iter()
            .filter_map(|request| request.method.clone())
            .collect()
    }

    pub async fn authorizations(&self) -> Vec<String> {
        self.seen
            .lock()
            .await
            .iter()
            .filter_map(|request| request.authorization.clone())
            .collect()
    }
}

async fn read_headers(
    socket: &mut tokio::net::TcpStream,
    raw: &mut Vec<u8>,
    chunk: &mut [u8; 4096],
) -> Option<(usize, usize)> {
    loop {
        if let Some(end) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
            let headers = String::from_utf8_lossy(&raw[..end]).into_owned();
            let length = headers
                .lines()
                .find_map(|line| {
                    let lower = line.to_ascii_lowercase();
                    lower
                        .strip_prefix("content-length:")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            return Some((end, length));
        }
        let read = socket.read(chunk).await.ok()?;
        if read == 0 {
            return None;
        }
        raw.extend_from_slice(chunk.get(..read).unwrap_or(&[]));
    }
}

/// Install fake executables without the test process holding a writable
/// descriptor to the inode that parallel tests may execute (#4178).
/// Forking while the executable is write-open can otherwise cause ETXTBSY.
pub fn install_executable_fixture(path: &std::path::Path, body: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let source = path.with_extension("source");
        std::fs::write(&source, body).unwrap();
        let copy = std::process::Command::new("cp")
            .arg(&source)
            .arg(path)
            .output()
            .unwrap();
        assert!(
            copy.status.success(),
            "cannot install fake executable: {}",
            String::from_utf8_lossy(&copy.stderr)
        );
        std::fs::remove_file(&source).unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(not(unix))]
    std::fs::write(path, body).unwrap();
}

/// A tiny stdio MCP fixture: answers initialize and one tools/list, then waits
/// to be killed by the probe.
pub fn stdio_fixture(directory: &std::path::Path) -> std::path::PathBuf {
    let path = directory.join("fake-mcp-stdio.sh");
    install_executable_fixture(
        &path,
        "#!/bin/sh\nread _line\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"capabilities\":{\"tools\":{}}}}'\nread _line\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[{\"name\":\"echo\"}]}}'\nsleep 30\n",
    );
    path
}

/// A fake `claude` CLI for Connect preflight tests: it supports `--version`
/// and refuses nothing, because the preflight under test never writes.
pub fn claude_fixture(directory: &std::path::Path) -> std::path::PathBuf {
    let path = directory.join("claude");
    install_executable_fixture(
        &path,
        "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '2.1.325 (Claude Code)'; exit 0; fi\nexit 0\n",
    );
    path
}

#[cfg(unix)]
#[test]
fn fake_claude_preflight_executes_after_parallel_fixture_installation() {
    let runs = (0..12)
        .map(|_| {
            std::thread::spawn(|| {
                for _ in 0..3 {
                    let temp = tempfile::tempdir().unwrap();
                    let claude = claude_fixture(temp.path());
                    let output = std::process::Command::new(claude)
                        .arg("--version")
                        .output()
                        .unwrap();
                    assert!(output.status.success());
                    assert_eq!(
                        String::from_utf8_lossy(&output.stdout).trim(),
                        "2.1.325 (Claude Code)"
                    );
                }
            })
        })
        .collect::<Vec<_>>();
    for run in runs {
        run.join().unwrap();
    }
}

/// The header map a Connect test uses for the fake endpoint.
pub fn bearer(token: &str) -> BTreeMap<String, String> {
    BTreeMap::from([("Authorization".to_string(), format!("Bearer {token}"))])
}

/// A `McpCli` that performs the mutation on the real fixture files.
///
/// It is the same contract the native adapter exposes — argv in, success or
/// failure out — so the mutation, readback, conflict and rollback paths are
/// exercised without a `claude` binary. It deliberately implements only the
/// two verbs this capability uses.
pub struct FileCli {
    pub calls: Mutex<Vec<Vec<String>>>,
    fail_adds: std::sync::atomic::AtomicUsize,
}

impl FileCli {
    pub fn new() -> Self {
        Self {
            calls: Mutex::new(Vec::new()),
            fail_adds: std::sync::atomic::AtomicUsize::new(0),
        }
    }

    /// Fail the next add, then behave normally so a rollback can succeed.
    pub fn failing_add() -> Self {
        let cli = Self::new();
        cli.fail_adds.store(1, std::sync::atomic::Ordering::SeqCst);
        cli
    }

    /// Fail a fixed number of adds, for a failure plus a failed rollback.
    pub fn fail_next_adds(&self, count: usize) {
        self.fail_adds
            .store(count, std::sync::atomic::Ordering::SeqCst);
    }

    pub async fn recorded(&self) -> Vec<Vec<String>> {
        self.calls.lock().await.clone()
    }
}

#[async_trait::async_trait]
impl super::cli::McpCli for FileCli {
    async fn run(
        &self,
        _context: &dyn crate::session_context::SessionContext,
        _session_id: &str,
        roots: &super::config::Roots,
        arguments: &[String],
    ) -> Result<super::cli::CliOutput, String> {
        self.calls.lock().await.push(arguments.to_vec());
        let verb = arguments.first().map(String::as_str).unwrap_or_default();
        match verb {
            "add-json" => {
                let should_fail = self
                    .fail_adds
                    .fetch_update(
                        std::sync::atomic::Ordering::SeqCst,
                        std::sync::atomic::Ordering::SeqCst,
                        |remaining| remaining.checked_sub(1),
                    )
                    .is_ok();
                if should_fail {
                    return Ok(super::cli::CliOutput {
                        success: false,
                        stdout: String::new(),
                        stderr: "simulated add failure".to_string(),
                        timed_out: false,
                        truncated: false,
                    });
                }
                let scope = arguments
                    .get(2)
                    .ok_or_else(|| "missing scope".to_string())?;
                let name = arguments.get(3).ok_or_else(|| "missing name".to_string())?;
                let raw: Value = serde_json::from_str(
                    arguments
                        .get(4)
                        .ok_or_else(|| "missing definition".to_string())?,
                )
                .map_err(|error| error.to_string())?;
                upsert(roots, scope, name, raw)?;
            }
            "remove" => {
                let name = arguments.get(1).ok_or_else(|| "missing name".to_string())?;
                let scope = arguments
                    .get(3)
                    .ok_or_else(|| "missing scope".to_string())?;
                remove(roots, scope, name)?;
            }
            _ => {}
        }
        Ok(super::cli::CliOutput {
            success: true,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            truncated: false,
        })
    }
}

fn upsert(roots: &super::config::Roots, scope: &str, name: &str, raw: Value) -> Result<(), String> {
    let (path, mut document) = read_document(roots, scope)?;
    let servers = scope_servers_mut(&mut document, roots, scope)?;
    servers.insert(name.to_string(), raw);
    write_json(&path, &Value::Object(document))
}

fn remove(roots: &super::config::Roots, scope: &str, name: &str) -> Result<(), String> {
    let (path, mut document) = read_document(roots, scope)?;
    if let Ok(servers) = scope_servers_mut(&mut document, roots, scope) {
        servers.remove(name);
    }
    write_json(&path, &Value::Object(document))
}

fn read_document(
    roots: &super::config::Roots,
    scope: &str,
) -> Result<(std::path::PathBuf, serde_json::Map<String, Value>), String> {
    let path = if scope == "project" {
        roots.project_file.clone()
    } else {
        roots.state_file.clone()
    };
    let document = read_object(&path)?;
    Ok((path, document))
}

fn scope_servers_mut<'a>(
    document: &'a mut serde_json::Map<String, Value>,
    roots: &super::config::Roots,
    scope: &str,
) -> Result<&'a mut serde_json::Map<String, Value>, String> {
    if scope == "project" {
        return document
            .entry("mcpServers".to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| "mcpServers is not an object".to_string());
    }
    let key = roots.canonical_cwd.to_string_lossy().into_owned();
    let projects = document
        .entry("projects".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "projects is not an object".to_string())?;
    let project = projects
        .entry(key)
        .or_insert_with(|| json!({"mcpServers": {}}))
        .as_object_mut()
        .ok_or_else(|| "project entry is not an object".to_string())?;
    project
        .entry("mcpServers".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| "mcpServers is not an object".to_string())
}

fn read_object(path: &std::path::Path) -> Result<serde_json::Map<String, Value>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .map_err(|error| error.to_string())?
            .as_object()
            .cloned()
            .ok_or_else(|| "configuration is not an object".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Map::new()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_json(path: &std::path::Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(
        path,
        serde_json::to_string_pretty(value).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}
