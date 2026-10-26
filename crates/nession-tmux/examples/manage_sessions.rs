//! Create, list and kill sessions on an explicitly addressed tmux server.
//!
//! ```bash
//! cargo run -p nession-tmux --example manage_sessions -- /tmp/my-app/tmux.sock
//! ```

use nession_tmux::{NewSession, TmuxCommand, TmuxOps};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let socket = std::env::args()
        .nth(1)
        .ok_or_else(|| anyhow::anyhow!("usage: manage_sessions <absolute-socket>"))?;
    let command = TmuxCommand::new("tmux", socket);
    command.validate()?;
    let ops = TmuxOps::new(command);
    let name = format!("sdk-example-{}", std::process::id());

    ops.new_session(&NewSession {
        name: name.clone(),
        working_dir: "/tmp".to_string(),
        width: 80,
        height: 24,
        env: vec![("SDK_EXAMPLE".to_string(), "1".to_string())],
    })
    .await?;
    println!("created {name}");

    for session in ops.list_sessions().await? {
        println!(
            "session: {} ({}x{}, {} window(s), {} attached)",
            session.name,
            session.width,
            session.height,
            session.window_count,
            session.attached_clients
        );
    }

    ops.kill_session(&name).await?;
    println!("killed {name}");
    Ok(())
}
