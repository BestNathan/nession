//! `nession profile test [<name>]` — bounded real connection/authentication.
//!
//! Reports success, auth denial, connection refusal or timeout with sanitized
//! diagnostics. Never changes the selection, never falls back to another
//! profile/Server, never prints a credential.

use anyhow::{bail, Result};
use std::time::Duration;

use crate::connection;

/// The whole connect+authenticate budget for one test.
const TEST_BUDGET: Duration = Duration::from_secs(10);

pub async fn run(name: Option<String>) -> Result<()> {
    let ctx = connection::resolve_profile_for_test(name).await?;
    let Some(profile) = ctx.profile.clone() else {
        bail!("profile test resolved no named profile");
    };
    let endpoint = connection::sanitized_endpoint(&ctx.server_url);

    let outcome = tokio::time::timeout(
        TEST_BUDGET,
        connection::connect(&ctx.server_url, &ctx.auth_token),
    )
    .await;
    match outcome {
        Err(_elapsed) => bail!(
            "profile '{profile}': connection to {endpoint} timed out after {}s. Is the Server \
             running and reachable? Inspect the profile: nession profile show {profile}",
            TEST_BUDGET.as_secs()
        ),
        Ok(Err(error)) => {
            if let Some(client_error) = error.downcast_ref::<nession_client::ClientError>() {
                match client_error {
                    nession_client::ClientError::Auth { message } => bail!(
                        "profile '{profile}': authentication failed at {endpoint}: {message}. \
                         Check the credential: nession profile credential set {profile}"
                    ),
                    nession_client::ClientError::Connect { source, .. } => bail!(
                        "profile '{profile}': connection failed at {endpoint}: {source}. \
                         Is the Server running? Inspect the profile: nession profile show \
                         {profile}"
                    ),
                    other => bail!("profile '{profile}': connection failed at {endpoint}: {other}"),
                }
            }
            bail!("profile '{profile}': connection failed at {endpoint}: {error:#}");
        }
        Ok(Ok(client)) => {
            client.close().await.ok();
            println!("profile '{profile}': connected and authenticated to {endpoint}.");
            Ok(())
        }
    }
}
