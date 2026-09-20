use super::v1::*;

#[test]
fn test_env_source_as_str() {
    assert_eq!(EnvSource::Server.as_str(), "server");
    assert_eq!(EnvSource::Agent.as_str(), "agent");
}

#[test]
fn test_env_source_serde() {
    let s: EnvSource = serde_json::from_str("\"server\"").unwrap();
    assert_eq!(s, EnvSource::Server);
    let s: EnvSource = serde_json::from_str("\"agent\"").unwrap();
    assert_eq!(s, EnvSource::Agent);
}

#[test]
fn test_env_file_ref_serde() {
    let r = EnvFileRef {
        name: "test.env".to_string(),
        source: EnvSource::Server,
        agent_id: None,
    };
    let json = serde_json::to_string(&r).unwrap();
    let deserialized: EnvFileRef = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.name, "test.env");
    assert_eq!(deserialized.source, EnvSource::Server);
    assert!(deserialized.agent_id.is_none());
}

#[test]
fn test_env_file_ref_with_agent_id() {
    let r = EnvFileRef {
        name: "test.env".to_string(),
        source: EnvSource::Agent,
        agent_id: Some("agent-1".to_string()),
    };
    let json = serde_json::to_string(&r).unwrap();
    let deserialized: EnvFileRef = serde_json::from_str(&json).unwrap();
    assert_eq!(deserialized.agent_id, Some("agent-1".to_string()));
}
