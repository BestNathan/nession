//! `nession agent uninstall-service` — remove the boot service (never stops
//! a running Agent).

use anyhow::Result;

pub fn run() -> Result<()> {
    crate::service::uninstall_service()
}
