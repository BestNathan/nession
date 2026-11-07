//! `nession config agent set` — edit one typed key in the selected config.

use crate::configuration::{self, ConfigSelection, ConfigTarget};
use anyhow::Result;

pub fn run(key: &str, value: &str, config: Option<String>) -> Result<()> {
    let selection = ConfigSelection::resolve(ConfigTarget::Agent, config)?;
    configuration::set(ConfigTarget::Agent, &selection, key, value)
}
