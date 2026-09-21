use async_trait::async_trait;
use nession_protocol::{IdentityError, ProtocolDescriptor};
use serde_json::Value;

/// Agent-side extension: provides one or more Protocol Units, and serves them
/// when the server relays a call.
///
/// ## Why this declares descriptors and not message types
///
/// It used to expose `message_types() -> &'static [&'static str]`, and the
/// registry built its routing table from that list while the provider's own
/// `handle_command` matched on *separately written* suffixes. Nothing tied the
/// two together: a provider could advertise a message type it never handled, or
/// handle one it never advertised, and no check existed because there was no
/// single source to check against.
///
/// Declaring [`ProtocolDescriptor`]s removes the failure rather than detecting
/// it. The registry derives the wire routes **from these declarations**, so the
/// advertised set and the routed set are the same list by construction — there
/// is no second list to drift from.
///
/// ## Why it is fallible
///
/// A provider that cannot name its own contracts is a composition mistake, and
/// the design asks for it to fail there (`invalid manifest declaration ->
/// error`) rather than panic in whichever thread happened to build the registry.
#[async_trait]
pub trait AgentExtension: Send + Sync {
    /// Unique extension name (e.g. `"git"`), used to attribute declarations in
    /// composition errors.
    fn name(&self) -> &'static str;

    /// The Protocol Units this extension provides.
    fn descriptors(&self) -> Result<Vec<ProtocolDescriptor>, IdentityError>;

    /// Serve one call. `command` is the wire message type **verbatim** — the
    /// wire *is* the protocol id, so there is no namespace left to strip and
    /// the registry passes `msg_type` through unchanged.
    async fn handle_command(&self, command: &str, payload: Value) -> anyhow::Result<Value>;
}
