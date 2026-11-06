//! `nession config server init` — write the selected config file's defaults.

use crate::configuration::{self, ConfigSelection, ConfigTarget};
use anyhow::Result;

pub fn run(force: bool, config: Option<String>) -> Result<()> {
    let selection = ConfigSelection::resolve(ConfigTarget::Server, config)?;
    configuration::init(ConfigTarget::Server, &selection, force)
}
