//! `nession config agent show` — render the selected config with secrets masked.

use crate::configuration::{self, ConfigSelection, ConfigTarget};
use anyhow::Result;

pub fn run(config: Option<String>) -> Result<()> {
    let selection = ConfigSelection::resolve(ConfigTarget::Agent, config)?;
    configuration::show(ConfigTarget::Agent, &selection)
}
