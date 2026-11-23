//! A loopback GitHub API double for this crate's unit tests.
//!
//! Each test queues one [`FakeResponse`] per expected request. The raw request
//! text is recorded so a test can assert the `Authorization` header a
//! Session-addressed call actually carried (#4080). Nothing here reaches the
//! network or needs a real credential.

use std::sync::{Arc, Mutex};

use reqwest::Url;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub(crate) struct FakeResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl FakeResponse {
    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Self {
            status,
            headers: vec![("content-type".into(), "application/json".into())],
            body: body.to_string(),
        }
    }

    pub fn empty(status: u16) -> Self {
        Self {
            status,
            headers: Vec::new(),
            body: String::new(),
        }
    }
}

pub(crate) struct FakeGithub {
    pub base: Url,
    pub requests: Arc<Mutex<Vec<String>>>,
}

impl FakeGithub {
    /// Every request this fake served, in arrival order.
    pub fn recorded(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

pub(crate) async fn fake_github(responses: Vec<FakeResponse>) -> FakeGithub {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = Arc::clone(&requests);
    tokio::spawn(async move {
        for response in responses {
            let Ok((mut stream, _)) = listener.accept().await else {
                break;
            };
            let mut buffer = vec![0u8; 8192];
            let read = stream.read(&mut buffer).await.unwrap_or(0);
            let request = String::from_utf8_lossy(&buffer[..read]).to_string();
            recorded.lock().unwrap().push(request);
            let reason = match response.status {
                200 => "OK",
                302 => "Found",
                401 => "Unauthorized",
                403 => "Forbidden",
                404 => "Not Found",
                _ => "Error",
            };
            let mut head = format!(
                "HTTP/1.1 {} {reason}\r\nconnection: close\r\n",
                response.status
            );
            for (name, value) in &response.headers {
                head.push_str(&format!("{name}: {value}\r\n"));
            }
            head.push_str(&format!("content-length: {}\r\n\r\n", response.body.len()));
            let _ = stream.write_all(head.as_bytes()).await;
            let _ = stream.write_all(response.body.as_bytes()).await;
            let _ = stream.shutdown().await;
        }
    });
    FakeGithub {
        base: Url::parse(&format!("http://{address}/")).unwrap(),
        requests,
    }
}
