//! `nession profile import-agent [--name <name>] [--config <path>]`.
//!
//! Explicit, endpoint-only import of an Agent's configured `server_url`.
//! Daemon credentials (`auth_token`, `agent_token`) are never copied or
//! derived. A later Agent change never overwrites the client selection or
//! credentials — there is no continuous sync. The imported profile is
//! selected only when no current selection exists.

use anyhow::{bail, Context, Result};

use crate::profile::{self, store, AgentEndpointRead, DEFAULT_IMPORTED_PROFILE};

pub fn run(name: Option<String>, config: Option<String>) -> Result<()> {
    let loc = super::location()?;
    super::ensure_writable(&loc)?;
    let name = name.unwrap_or_else(|| DEFAULT_IMPORTED_PROFILE.to_string());
    profile::validate_profile_name(&name)?;
    let path = match config {
        Some(path) => std::path::PathBuf::from(path),
        None => nession_common::paths::agent_config_path()
            .context("failed to determine the Agent config path")?,
    };
    let endpoint = match profile::read_agent_endpoint_for_bootstrap(&path)? {
        AgentEndpointRead::Endpoint(url) => url,
        AgentEndpointRead::Absent => bail!(
            "no Agent config at {}; nothing to import. Configure an Agent \
             (`nession config agent init`) or add a profile explicitly: \
             nession profile add {name} --server-url <url>.",
            path.display()
        ),
        AgentEndpointRead::NoExplicitEndpoint => bail!(
            "the Agent config at {} does not explicitly configure server_url; nothing to \
             import. AgentConfig defaults are never an import source.",
            path.display()
        ),
    };

    let selected = store::mutate(&loc, |file| {
        if file.profiles.contains_key(&name) {
            bail!(
                "profile {name:?} already exists; import never overwrites. Remove it first \
                 (`nession profile remove {name}`) or choose another --name."
            );
        }
        file.profiles.insert(
            name.clone(),
            profile::ProfileEntry {
                server_url: endpoint.clone(),
                credential_ref: None,
                credential_backend: None,
                no_auth: false,
            },
        );
        let selects = file.current_profile.is_none();
        if selects {
            file.current_profile = Some(name.clone());
        }
        Ok(selects)
    })?;

    println!("Imported the Agent endpoint into profile '{name}' ({endpoint}).");
    println!("  Endpoint only: no daemon credential (auth_token/agent_token) was copied.");
    println!(
        "  credential: unset. Set one: nession profile credential set {name} (or mark no-auth: \
         nession profile set {name} --no-auth)."
    );
    if selected {
        println!("  Selected as the current profile (no prior selection).");
    } else {
        println!("  The existing current selection was not changed.");
    }
    Ok(())
}
