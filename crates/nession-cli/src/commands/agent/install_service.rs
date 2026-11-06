//! `nession agent install-service` — install the user-level boot service.

use anyhow::Result;

pub fn run(config: Option<String>, pid_file: Option<String>) -> Result<()> {
    crate::service::install_service(config, pid_file)
}
