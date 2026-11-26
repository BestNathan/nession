//! `nession agent logs` — read-only access to the Agent's local log history.
//!
//! The leaf owns only the component; discovery, filtering, tail, follow and
//! source selection are shared with `server logs` in [`crate::local_logs`].

use crate::args::LogsArgs;
use anyhow::Result;

pub async fn run(options: LogsArgs) -> Result<()> {
    crate::local_logs::run(nession_common::logging::LogComponent::Agent, options).await
}
