use nession_agent::config::AgentConfig;

#[test]
fn test_agent_config_defaults() {
    let config = AgentConfig::default();
    assert!(config.agent_id.starts_with("agent-"));
    assert_eq!(config.server_url, "ws://localhost:8443");
    assert_eq!(config.auth_token, "");
    assert_eq!(config.listen_address, "0.0.0.0:8080");
    assert!(config.tls_cert_path.is_none());
    assert!(config.tls_key_path.is_none());
    assert_eq!(config.heartbeat_interval_secs, 10);
    assert_eq!(config.session_poll_interval_secs, 5);
    assert!(config.advertise_address.is_none());
    assert!(config.connect_url.is_none());
}

#[test]
fn test_agent_config_parsing_minimal() {
    let toml = r#"
agent_id = "my-agent"
server_url = "wss://server.example.com"
auth_token = "secret123"
"#;
    let config: AgentConfig = toml::from_str(toml).unwrap();
    assert_eq!(config.agent_id, "my-agent");
    assert_eq!(config.server_url, "wss://server.example.com");
    assert_eq!(config.auth_token, "secret123");
    assert_eq!(config.listen_address, "0.0.0.0:8080"); // default
    assert_eq!(config.heartbeat_interval_secs, 10); // default
}

#[test]
fn test_agent_config_parsing_full() {
    let toml = r#"
agent_id = "prod-agent"
server_url = "wss://nession.example.com"
auth_token = "prod-token"
listen_address = "0.0.0.0:9090"
tls_cert_path = "/etc/nession/cert.pem"
tls_key_path = "/etc/nession/key.pem"
heartbeat_interval_secs = 15
session_poll_interval_secs = 3
advertise_address = "agent.example.com"
connect_url = "wss://agent.example.com/ws"
"#;
    let config: AgentConfig = toml::from_str(toml).unwrap();
    assert_eq!(config.agent_id, "prod-agent");
    assert_eq!(config.listen_address, "0.0.0.0:9090");
    assert_eq!(
        config.tls_cert_path,
        Some("/etc/nession/cert.pem".to_string())
    );
    assert_eq!(
        config.tls_key_path,
        Some("/etc/nession/key.pem".to_string())
    );
    assert_eq!(config.heartbeat_interval_secs, 15);
    assert_eq!(config.session_poll_interval_secs, 3);
    assert_eq!(
        config.advertise_address,
        Some("agent.example.com".to_string())
    );
    assert_eq!(
        config.connect_url,
        Some("wss://agent.example.com/ws".to_string())
    );
}

#[test]
fn test_agent_config_parsing_optional_fields_none() {
    let toml = r#"
agent_id = "agent-1"
server_url = "ws://localhost:8443"
auth_token = ""
"#;
    let config: AgentConfig = toml::from_str(toml).unwrap();
    assert!(config.tls_cert_path.is_none());
    assert!(config.tls_key_path.is_none());
    assert!(config.advertise_address.is_none());
    assert!(config.connect_url.is_none());
}
