mod agent_view;
pub mod client_registry;
pub mod command_broker;
mod handler;

// `server_descriptors` is generated in `handler` because the handlers it
// describes are that module's private methods; it is re-exported here so
// `protocol::server_manifest` can build the manifest without opening the module.
pub(crate) use handler::server_descriptors;
pub mod web_client_registry;
mod websocket;

pub use client_registry::ClientRegistry;
pub use handler::{
    ConnectionHandler, ConnectionHandlerConfig, ConnectionHandlerDeps, HandlerAction,
};
pub use web_client_registry::WebClientRegistry;
pub use websocket::WebSocketServer;
