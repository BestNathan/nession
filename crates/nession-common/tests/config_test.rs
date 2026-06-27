use nession_common::config::ServerConfig;

#[test]
fn test_server_config_parsing() {
    let toml_str = r#"
        listen_address = "0.0.0.0:8443"
        tls_cert_path = "/path/to/cert.pem"
        tls_key_path = "/path/to/key.pem"
        auth_token = "secret_token_123"
        heartbeat_timeout_secs = 30
        db_path = "./nession-server.db"
    "#;

    let config: ServerConfig = toml::from_str(toml_str).unwrap();
    assert_eq!(config.listen_address, "0.0.0.0:8443");
    assert_eq!(config.heartbeat_timeout_secs, 30);
    assert_eq!(config.db_path, "./nession-server.db");
}

#[test]
fn test_server_config_defaults() {
    let toml_str = r#"
        listen_address = "0.0.0.0:8443"
        tls_cert_path = "/path/to/cert.pem"
        tls_key_path = "/path/to/key.pem"
        auth_token = "secret_token_123"
    "#;

    let config: ServerConfig = toml::from_str(toml_str).unwrap();
    assert_eq!(config.heartbeat_timeout_secs, 30); // default
    assert_eq!(config.db_path, nession_common::paths::server_db_path().to_string_lossy().as_ref()); // default
}
