use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientAuthPayload {
    #[serde(default)]
    pub auth_token: String,
    #[serde(default)]
    pub client_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponsePayload {
    pub status: String,
    pub message: String,
    pub client_id: String,
}
