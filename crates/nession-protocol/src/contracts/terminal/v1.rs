use serde::{Deserialize, Serialize};

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalInputPayload {
    pub session_name: String,
    /// Base64-encoded binary data.
    pub data: String,
    /// Controller generation at send time (#1095). Absent for legacy senders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_generation: Option<u64>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalResizePayload {
    pub session_name: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub control_generation: Option<u64>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalOutputPayload {
    pub session_name: String,
    /// Base64-encoded binary data.
    pub data: String,
    /// Monotonic stream identity (#1094). Omitted until a provider assigns seq.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_epoch: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_seq: Option<u64>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalControlAcquirePayload {
    pub session_name: String,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalControlAcquireResponse {
    pub session_name: String,
    pub generation: u64,
    /// `controller` or `observer` for this client after the operation.
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_client_id: Option<String>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalControlChangedPayload {
    pub session_name: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controller_client_id: Option<String>,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TerminalStreamEventPayload {
    Output {
        session_name: String,
        stream_epoch: u64,
        stream_seq: u64,
        data: String,
    },
    Resize {
        session_name: String,
        stream_epoch: u64,
        stream_seq: u64,
        cols: u16,
        rows: u16,
    },
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalStreamResumePayload {
    pub session_name: String,
    pub stream_epoch: u64,
    pub after_seq: u64,
}

#[cfg_attr(feature = "codegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema))]
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerminalStreamResumeResponse {
    pub session_name: String,
    pub stream_epoch: u64,
    /// False when `stream_epoch` does not match the live session timeline (#1094).
    pub epoch_match: bool,
    pub events: Vec<TerminalStreamEventPayload>,
}
