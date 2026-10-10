//! Server's canonical protocol route declaration and derived policy/manifest.
use super::*;
use crate::protocol::server_routes;
use crate::server::execution::ExecutionPolicy::{Inline, Key, Ordered, Query};
use crate::server::execution::ResourceKey;

// ── The Protocol Units this server serves ──
//
// One invocation, three artefacts: `server_descriptors()` (the manifest's
// half), `SERVER_WIRES` (what the message loop tests) and `dispatch_server()`
// (the routing half). A unit cannot be advertised without a handler, or handled
// without being advertised, because there is one list.
//
// The ids are the *operations*, not the wire types. Where an operation has a
// provider on each side — `session.create` is served by this server for a
// browser and by the agent for this server — both declare the same id and each
// declares its own wire projection, which is exactly the model: one contract,
// several providers, `ContractSupport.wire` carrying the difference.

/// The session a payload names by its parts, as the registry names it.
///
/// `server.session.create` is the unit that does this: it takes an `agent_id`
/// and a `name` and joins them, because the session does not exist yet and
/// there is no id to take. The join is written as the registry writes it
/// (`{agent_id}:{name}`), which is what makes it the *same key* as
/// [`session_by_id`] produces for the same session — the property the key lane
/// exists for, and the one its test pins.
pub(super) fn session_by_parts(payload: &Value) -> ResourceKey {
    let agent_id = payload
        .get("agent_id")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    ResourceKey::Session(format!("{agent_id}:{name}"))
}

/// The session a payload names by its joined id, as the registry names it.
///
/// `server.session.kill` and the two `session.env.*` units take the `session_id`
/// the registry hands out, which is already `agent_id:session_name`.
///
/// A payload with neither part in it produces the empty key rather than an
/// error, and that is deliberate: the frame is still dispatched, still counted,
/// and still answered — with the refusal its handler has always produced —
/// while a classifier that refused to produce a key would have to decide what
/// lane a malformed mutation runs on, and there is no honest answer to that.
/// Every such frame shares one queue, which is a queue of frames that are about
/// to be refused.
pub(super) fn session_by_id(payload: &Value) -> ResourceKey {
    ResourceKey::Session(
        payload
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    )
}

/// The env file a payload names, qualified by the side of the fleet it lives on.
///
/// `source` decides the spelling, because an agent's `staging.env` and the
/// Server's `staging.env` are two files with one name: a key that ignored the
/// source would serialise two unrelated writes, and the variant would be
/// carrying half of what it says it carries.
pub(super) fn env_file_key(payload: &Value) -> ResourceKey {
    let name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let agent_source = payload.get("source").and_then(Value::as_str) == Some("agent");
    if agent_source {
        let agent_id = payload
            .get("agent_id")
            .and_then(Value::as_str)
            .unwrap_or_default();
        ResourceKey::Env(format!("{agent_id}:{name}"))
    } else {
        ResourceKey::Env(name.to_string())
    }
}

server_routes!(handler, msg, payload;
    "server.agent.register" => "server.agent.register" => 1 => Ordered => handler.handle_agent_register(msg).await,
    // `control.heartbeat` is deliberately **not** an arm here. It is a control
    // message, not an operation: nothing answers it (the agent used to read an
    // acknowledgement on a wire of its own, and that is gone because control
    // has no acknowledgement), and an arm would put it in the manifest as a
    // unit the server offers. It is handled in `handle_protocol_message`, ahead
    // of the relay path — see the match there for why the position matters.
    "server.agent.session-update" => "server.agent.session-update" => 1 => Inline => handler.handle_agent_session_update(msg).await,
    "server.agent.command-response" => "server.agent.command-response" => 1 => Inline => handler.handle_agent_command_response(msg).await,
    "server.agent.git-invalidated" => "server.agent.git-invalidated" => 1 => Inline => handler.handle_agent_git_invalidated(msg).await,
    "server.agent.terminal-resize" => "server.agent.terminal-resize" => 1 => Inline => handler.handle_agent_terminal_resize(msg).await,
    "server.agent.address-update" => "server.agent.address-update" => 1 => Inline => handler.handle_agent_address_update(msg).await,
    "server.auth" => "server.auth" => 1 => Ordered => handler.handle_client_auth(msg).await,
    "server.agent.list" => "server.agent.list" => 1 => Query => handler.handle_client_agents_list(msg).await,
    "server.session.list" => "server.session.list" => 1 => Query => handler.handle_client_sessions_list(msg).await,
    "server.session.attach" => "server.session.attach" => 1 => Ordered => handler.handle_client_session_attach(msg).await,
    "server.session.relay.begin" => "server.session.relay.begin" => 1 => Ordered => handler.handle_client_session_relay_begin(msg).await,
    // `server.session.relay.end` is intercepted by the relay function
    // (`relay_bidirectional_via_channel`) and never reaches the dispatcher
    // during active relay. It is declared here anyway, because the Server does
    // serve it — the relay loop is the handler — and a manifest that omitted it
    // would understate what this peer answers. `Ordered`, because it is the
    // other half of the mode transition: leaving relay mode must be as
    // deterministic as entering it.
    "server.session.relay.end" => "server.session.relay.end" => 1 => Ordered => Ok(HandlerAction::Reply(None)),
    // The keyed mutations (`#961-E`). Each carries the resource it mutates,
    // read from its own payload: the session ones by the session they name, the
    // env ones by the file. Create and kill name one session two ways and must
    // land on one key — see `session_by_parts` / `session_by_id`.
    "server.session.create" => "server.session.create" => 1 => Key(session_by_parts(payload)) => handler.handle_client_session_create(msg).await,
    "server.session.kill" => "server.session.kill" => 1 => Key(session_by_id(payload)) => handler.handle_client_session_kill(msg).await,
    "server.session.capture-preview" => "server.session.capture-preview" => 1 => Query => handler.handle_client_session_capture_preview(msg).await,
    "server.env.list" => "server.env.list" => 1 => Query => handler.handle_client_env_list(msg).await,
    "server.env.get" => "server.env.get" => 1 => Query => handler.handle_client_env_get(msg).await,
    "server.env.write" => "server.env.write" => 1 => Key(env_file_key(payload)) => handler.handle_client_env_write(msg).await,
    "server.env.delete" => "server.env.delete" => 1 => Key(env_file_key(payload)) => handler.handle_client_env_delete(msg).await,
    "server.session.env.apply" => "server.session.env.apply" => 1 => Key(session_by_id(payload)) => handler.handle_client_session_env_apply(msg).await,
    "server.session.env.unset" => "server.session.env.unset" => 1 => Key(session_by_id(payload)) => handler.handle_client_session_env_unset(msg).await,
    "server.session.env.active" => "server.session.env.active" => 1 => Query => handler.handle_client_session_env_active(msg).await,
    "server.session.env.query" => "server.session.env.query" => 1 => Query => handler.handle_client_session_env_query(msg).await,
    "server.info" => "server.info" => 1 => Query => handler.handle_client_server_info(msg).await,
    "server.agent.rename" => "server.agent.rename" => 1 => Inline => handler.handle_client_agent_rename(msg).await,
    "server.agent.delete" => "server.agent.delete" => 1 => Inline => handler.handle_client_agent_delete(msg).await,
    "server.commands.list" => "server.commands.list" => 1 => Query => handler.handle_client_commands_list(msg).await,
    "server.commands.add" => "server.commands.add" => 1 => Inline => handler.handle_client_commands_add(msg).await,
    "server.commands.remove" => "server.commands.remove" => 1 => Inline => handler.handle_client_commands_remove(msg).await,
    "server.commands.update" => "server.commands.update" => 1 => Inline => handler.handle_client_commands_update(msg).await,
);

