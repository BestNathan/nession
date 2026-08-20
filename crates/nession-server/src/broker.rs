use base64::{engine::general_purpose, Engine as _};
use chrono::{DateTime, Duration, Utc};
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
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
pub struct ConnectionTokenData {
    pub agent_id: String,
    pub session_id: String,
    pub agent_ip: String,
    pub agent_port: u16,
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

    pub async fn generate_p2p_token(
        &self,
        agent_id: &str,
        session_id: &str,
        agent_ip: &str,
        agent_port: u16,
    ) -> String {
        let token = Self::generate_random_token();
        let now = Utc::now();
        let expires_at = now + Duration::seconds(self.token_expiry_secs);

        let connection_info = P2PConnectionInfo {
            agent_id: agent_id.to_string(),
            session_id: session_id.to_string(),
            agent_ip: agent_ip.to_string(),
            agent_port,
            token: token.clone(),
            created_at: now,
            expires_at,
        };

        let mut tokens = self.tokens.write().await;
        tokens.insert(token.clone(), connection_info);

        token
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

    #[tokio::test]
    async fn test_generate_connection_token() {
        let broker = ConnectionBroker::new(300); // 5 minute expiry

        let token = broker
            .generate_p2p_token("agent_123", "agent_123:dev-work", "192.168.1.10", 8080)
            .await;

        assert!(!token.is_empty());
        assert!(token.len() >= 32); // Should be a secure random token
    }

    #[tokio::test]
    async fn test_validate_connection_token() {
        let broker = ConnectionBroker::new(300);

        let token = broker
            .generate_p2p_token("agent_123", "agent_123:dev-work", "192.168.1.10", 8080)
            .await;

        let info = broker.validate_and_consume_token(&token).await;
        assert!(info.is_some());

        let info = info.unwrap();
        assert_eq!(info.agent_id, "agent_123");
        assert_eq!(info.session_id, "agent_123:dev-work");
        assert_eq!(info.agent_ip, "192.168.1.10");
        assert_eq!(info.agent_port, 8080);
    }

    #[tokio::test]
    async fn test_token_single_use() {
        let broker = ConnectionBroker::new(300);

        let token = broker
            .generate_p2p_token("agent_123", "agent_123:dev-work", "192.168.1.10", 8080)
            .await;

        // First validation should succeed
        let info1 = broker.validate_and_consume_token(&token).await;
        assert!(info1.is_some());

        // Second validation should fail (token consumed)
        let info2 = broker.validate_and_consume_token(&token).await;
        assert!(info2.is_none());
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

        let _token = broker
            .generate_p2p_token("agent_123", "agent_123:dev-work", "192.168.1.10", 8080)
            .await;

        // Wait for token to expire
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        // Cleanup should remove expired tokens
        let removed = broker.cleanup_expired_tokens().await;
        assert_eq!(removed, 1);

        // Token should no longer be valid
        let info = broker.validate_and_consume_token(&_token).await;
        assert!(info.is_none());
    }

    #[tokio::test]
    async fn test_multiple_tokens_same_agent() {
        let broker = ConnectionBroker::new(300);

        let token1 = broker
            .generate_p2p_token("agent_123", "agent_123:session1", "192.168.1.10", 8080)
            .await;

        let token2 = broker
            .generate_p2p_token("agent_123", "agent_123:session2", "192.168.1.10", 8080)
            .await;

        // Both tokens should be valid
        let info1 = broker.validate_and_consume_token(&token1).await;
        assert!(info1.is_some());
        assert_eq!(info1.unwrap().session_id, "agent_123:session1");

        let info2 = broker.validate_and_consume_token(&token2).await;
        assert!(info2.is_some());
        assert_eq!(info2.unwrap().session_id, "agent_123:session2");
    }
}
