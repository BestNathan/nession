use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Duration, Utc};
use nession_protocol::contracts::p2p::v1::CredentialScope;
use rand::Rng;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone)]
pub struct P2PConnectionInfo {
    pub agent_id: String,
    pub session_id: String,
    pub agent_ip: String,
    pub agent_port: u16,
    pub token: String,
    /// What this credential authorizes (#1013).
    ///
    /// The Server's ledger kept only *who* a token was for, which was enough
    /// while nothing validated it. A verifier needs *what it may do* as well,
    /// and this is the record that travels to the Agent in `agent.p2p.grant`.
    pub scope: CredentialScope,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ConnectionTokenData {
    pub agent_id: String,
    pub session_id: String,
    pub agent_ip: String,
    pub agent_port: u16,
    pub scope: CredentialScope,
}

pub struct ConnectionBroker {
    tokens: Arc<RwLock<HashMap<String, P2PConnectionInfo>>>,
    token_expiry_secs: i64,
}

impl ConnectionBroker {
    pub fn new(token_expiry_secs: u64) -> Self {
        Self {
            tokens: Arc::new(RwLock::new(HashMap::new())),
            token_expiry_secs: token_expiry_secs as i64,
        }
    }

    /// Mint a credential and return the **whole record**, not just the token.
    ///
    /// The Server has to do two things with it and in this order: hand it to the
    /// Agent that will verify it (`agent.p2p.grant`), and only then give the
    /// token to the client. A function returning the token alone would make the
    /// first step impossible without a second lookup, and the ordering
    /// impossible to enforce at the call site — which is where it belongs,
    /// because a client that dials the instant it holds a token must find the
    /// verifier already holding the record.
    ///
    /// Expired entries are swept here rather than by a background task: minting
    /// is the only moment the map grows, so it is the only moment it can need
    /// shrinking, and a task would be a lifecycle to own for nothing.
    pub async fn mint(
        &self,
        agent_id: &str,
        session_id: &str,
        agent_ip: &str,
        agent_port: u16,
        scope: CredentialScope,
    ) -> P2PConnectionInfo {
        let now = Utc::now();
        let expires_at = now + Duration::seconds(self.token_expiry_secs);

        let info = P2PConnectionInfo {
            agent_id: agent_id.to_string(),
            session_id: session_id.to_string(),
            agent_ip: agent_ip.to_string(),
            agent_port,
            token: Self::generate_random_token(),
            scope,
            created_at: now,
            expires_at,
        };

        let mut tokens = self.tokens.write().await;
        tokens.retain(|_, held| held.expires_at >= now);
        tokens.insert(info.token.clone(), info.clone());

        info
    }

    pub async fn validate_and_consume_token(&self, token: &str) -> Option<ConnectionTokenData> {
        let mut tokens = self.tokens.write().await;
        let now = Utc::now();

        if let Some(info) = tokens.get(token) {
            // Check if token has expired
            if info.expires_at < now {
                tokens.remove(token);
                return None;
            }

            // Token is valid - consume it (remove from map)
            let info = tokens.remove(token)?;

            Some(ConnectionTokenData {
                agent_id: info.agent_id,
                session_id: info.session_id,
                agent_ip: info.agent_ip,
                agent_port: info.agent_port,
                scope: info.scope,
            })
        } else {
            None
        }
    }

    pub async fn cleanup_expired_tokens(&self) -> usize {
        let mut tokens = self.tokens.write().await;
        let now = Utc::now();
        let before_count = tokens.len();

        tokens.retain(|_, info| info.expires_at >= now);

        let after_count = tokens.len();
        before_count - after_count
    }

    fn generate_random_token() -> String {
        let mut rng = rand::thread_rng();
        let random_bytes: [u8; 32] = rng.gen();
        general_purpose::URL_SAFE_NO_PAD.encode(random_bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scope() -> CredentialScope {
        CredentialScope::for_attach("dev-work")
    }

    #[tokio::test]
    async fn test_generate_connection_token() {
        let broker = ConnectionBroker::new(300); // 5 minute expiry

        let info = broker
            .mint(
                "agent_123",
                "agent_123:dev-work",
                "192.168.1.10",
                8080,
                scope(),
            )
            .await;

        assert!(!info.token.is_empty());
        assert!(info.token.len() >= 32); // Should be a secure random token
    }

    /// What a credential authorizes survives the ledger.
    ///
    /// The Server's map is the issuer's record and the Agent's is the
    /// verifier's; this is the one hop between them that is not on the wire, so
    /// a scope dropped here would reach the Agent as the deny-by-default
    /// `CredentialScope::default()` and refuse everything.
    #[tokio::test]
    async fn the_scope_survives_the_ledger() {
        let broker = ConnectionBroker::new(300);

        let info = broker
            .mint(
                "agent_123",
                "agent_123:dev-work",
                "192.168.1.10",
                8080,
                CredentialScope::for_relay("dev-work"),
            )
            .await;

        let data = broker
            .validate_and_consume_token(&info.token)
            .await
            .expect("just minted");

        assert_eq!(data.scope, CredentialScope::for_relay("dev-work"));
        assert!(
            !data.scope.files,
            "a relay credential carries no file access"
        );
    }

    #[tokio::test]
    async fn test_validate_connection_token() {
        let broker = ConnectionBroker::new(300);

        let info = broker
            .mint(
                "agent_123",
                "agent_123:dev-work",
                "192.168.1.10",
                8080,
                scope(),
            )
            .await;

        let data = broker
            .validate_and_consume_token(&info.token)
            .await
            .expect("valid");
        assert_eq!(data.agent_id, "agent_123");
        assert_eq!(data.session_id, "agent_123:dev-work");
        assert_eq!(data.agent_ip, "192.168.1.10");
        assert_eq!(data.agent_port, 8080);
    }

    #[tokio::test]
    async fn test_token_single_use() {
        let broker = ConnectionBroker::new(300);

        let info = broker
            .mint(
                "agent_123",
                "agent_123:dev-work",
                "192.168.1.10",
                8080,
                scope(),
            )
            .await;

        // First validation should succeed
        assert!(broker
            .validate_and_consume_token(&info.token)
            .await
            .is_some());

        // Second validation should fail (token consumed)
        assert!(broker
            .validate_and_consume_token(&info.token)
            .await
            .is_none());
    }

    #[tokio::test]
    async fn test_invalid_token() {
        let broker = ConnectionBroker::new(300);

        let info = broker
            .validate_and_consume_token("invalid_token_12345")
            .await;
        assert!(info.is_none());
    }

    #[tokio::test]
    async fn test_cleanup_expired_tokens() {
        // Use very short expiry for testing
        let broker = ConnectionBroker::new(1); // 1 second expiry

        let info = broker
            .mint(
                "agent_123",
                "agent_123:dev-work",
                "192.168.1.10",
                8080,
                scope(),
            )
            .await;

        // Wait for token to expire
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        // Cleanup should remove expired tokens
        let removed = broker.cleanup_expired_tokens().await;
        assert_eq!(removed, 1);

        // Token should no longer be valid
        assert!(broker
            .validate_and_consume_token(&info.token)
            .await
            .is_none());
    }

    /// Minting sweeps what has expired, so the ledger cannot grow without bound.
    ///
    /// The only moment it grows is a mint, so it is the only moment it can need
    /// shrinking — and a broker that never swept would hold every credential
    /// ever issued for the process's lifetime, which is a slow leak rather than
    /// a visible one.
    #[tokio::test]
    async fn minting_sweeps_what_has_expired() {
        let broker = ConnectionBroker::new(1);
        let expired = broker
            .mint("agent_123", "agent_123:old", "192.168.1.10", 8080, scope())
            .await;

        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        let fresh = broker
            .mint("agent_123", "agent_123:new", "192.168.1.10", 8080, scope())
            .await;

        let tokens = broker.tokens.read().await;
        assert_eq!(tokens.len(), 1, "the expired entry must be gone");
        assert!(tokens.contains_key(&fresh.token));
        assert!(!tokens.contains_key(&expired.token));
    }

    #[tokio::test]
    async fn test_multiple_tokens_same_agent() {
        let broker = ConnectionBroker::new(300);

        let first = broker
            .mint(
                "agent_123",
                "agent_123:session1",
                "192.168.1.10",
                8080,
                scope(),
            )
            .await;

        let second = broker
            .mint(
                "agent_123",
                "agent_123:session2",
                "192.168.1.10",
                8080,
                scope(),
            )
            .await;

        // Both tokens should be valid
        let data1 = broker
            .validate_and_consume_token(&first.token)
            .await
            .expect("first");
        assert_eq!(data1.session_id, "agent_123:session1");

        let data2 = broker
            .validate_and_consume_token(&second.token)
            .await
            .expect("second");
        assert_eq!(data2.session_id, "agent_123:session2");
    }
}
