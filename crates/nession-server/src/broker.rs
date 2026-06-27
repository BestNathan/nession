use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;
use chrono::{DateTime, Utc, Duration};
use rand::Rng;
use base64::{Engine as _, engine::general_purpose};

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
