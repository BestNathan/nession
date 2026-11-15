//! Public, read-only MCP Tool catalog from the actual registered handlers.
//! This is a build-time exporter, not a running MCP endpoint.
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let catalog = nession_mcp::tools::registry()?;
    let tools = catalog.list();
    let document = serde_json::json!({
        "schema_version": 1,
        "tools": tools,
        "protocol_versions": nession_mcp::protocol::SUPPORTED_PROTOCOL_VERSIONS
    });
    println!("{}", serde_json::to_string(&document)?);
    Ok(())
}
