//! A small, auth-scoped, short-lived read cache with in-flight deduplication.
//!
//! The key is supplied by the extension and includes the Session, resolved
//! repository/remote/branch and auth fingerprint. It is never persisted and
//! never shared across identities.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::Mutex;

use crate::runtime::client::GithubError;

const TTL: Duration = Duration::from_secs(15);
const MAX_ENTRIES: usize = 128;

struct Entry {
    value: Value,
    expires: Instant,
}

#[derive(Default)]
pub struct GithubCache {
    entries: Mutex<HashMap<String, Entry>>,
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl GithubCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return a cached value, or run `fetch` once for concurrent callers of the
    /// same key. `refresh` skips the cache read but still publishes the new
    /// answer. Errors are never cached.
    pub async fn get_or_fetch<F, Fut>(
        &self,
        key: &str,
        refresh: bool,
        fetch: F,
    ) -> Result<Value, GithubError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Value, GithubError>>,
    {
        if !refresh {
            if let Some(value) = self.read(key).await {
                return Ok(value);
            }
        }

        let lock = {
            let mut locks = self.locks.lock().await;
            locks
                .entry(key.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        // A concurrent caller of the same key may have filled the cache while
        // this one waited. Re-check before making a second network request.
        if !refresh {
            if let Some(value) = self.read(key).await {
                return Ok(value);
            }
        }

        let value = fetch().await?;
        self.write(key, value.clone()).await;
        Ok(value)
    }

    async fn read(&self, key: &str) -> Option<Value> {
        let mut entries = self.entries.lock().await;
        let now = Instant::now();
        entries.retain(|_, entry| entry.expires > now);
        entries.get(key).map(|entry| entry.value.clone())
    }

    async fn write(&self, key: &str, value: Value) {
        let mut entries = self.entries.lock().await;
        let now = Instant::now();
        entries.retain(|_, entry| entry.expires > now);
        if entries.len() >= MAX_ENTRIES {
            if let Some(oldest) = entries
                .iter()
                .min_by_key(|(_, entry)| entry.expires)
                .map(|(key, _)| key.clone())
            {
                entries.remove(&oldest);
            }
        }
        entries.insert(
            key.to_string(),
            Entry {
                value,
                expires: now + TTL,
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn caches_a_value_and_refresh_bypasses_it() {
        let cache = GithubCache::new();
        let first = cache
            .get_or_fetch("a", false, || async { Ok(serde_json::json!({"n": 1})) })
            .await
            .unwrap();
        assert_eq!(first["n"], 1);
        let second = cache
            .get_or_fetch("a", false, || async { Ok(serde_json::json!({"n": 2})) })
            .await
            .unwrap();
        assert_eq!(second["n"], 1);
        let refreshed = cache
            .get_or_fetch("a", true, || async { Ok(serde_json::json!({"n": 3})) })
            .await
            .unwrap();
        assert_eq!(refreshed["n"], 3);
    }

    #[tokio::test]
    async fn concurrent_callers_share_one_fetch() {
        let cache = Arc::new(GithubCache::new());
        let calls = Arc::new(tokio::sync::Mutex::new(0u32));
        let mut tasks = Vec::new();
        for _ in 0..4 {
            let cache = Arc::clone(&cache);
            let calls = Arc::clone(&calls);
            tasks.push(tokio::spawn(async move {
                cache
                    .get_or_fetch("a", false, || async move {
                        *calls.lock().await += 1;
                        Ok(serde_json::json!({"ok": true}))
                    })
                    .await
                    .unwrap();
            }));
        }
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(*calls.lock().await, 1);
    }
}
