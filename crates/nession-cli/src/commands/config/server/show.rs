//! `nession config server show` — render the selected config with secrets masked.

use crate::configuration::{self, ConfigSelection, ConfigTarget};
use anyhow::Result;

pub fn run(config: Option<String>) -> Result<()> {
    let selection = ConfigSelection::resolve(ConfigTarget::Server, config)?;
    configuration::show(ConfigTarget::Server, &selection)
}
