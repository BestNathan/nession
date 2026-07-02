use nession_server::broker::ConnectionBroker;

#[tokio::test]
async fn test_generate_connection_token() {
    let broker = ConnectionBroker::new(300); // 5 minute expiry

    let token = broker
        .generate_p2p_token("agent_123", "agent_123:dev-work", "192.168.1.10", 8080)
        .await;

    assert!(!token.is_empty());
    assert!(token.len() >= 32); // Should be a secure random token
}

#[tokio::test]
async fn test_validate_connection_token() {
    let broker = ConnectionBroker::new(300);

    let token = broker
        .generate_p2p_token("agent_123", "agent_123:dev-work", "192.168.1.10", 8080)
        .await;

    let info = broker.validate_and_consume_token(&token).await;
    assert!(info.is_some());

    let info = info.unwrap();
    assert_eq!(info.agent_id, "agent_123");
    assert_eq!(info.session_id, "agent_123:dev-work");
    assert_eq!(info.agent_ip, "192.168.1.10");
    assert_eq!(info.agent_port, 8080);
}

#[tokio::test]
async fn test_token_single_use() {
    let broker = ConnectionBroker::new(300);

    let token = broker
        .generate_p2p_token("agent_123", "agent_123:dev-work", "192.168.1.10", 8080)
        .await;

    // First validation should succeed
    let info1 = broker.validate_and_consume_token(&token).await;
    assert!(info1.is_some());

    // Second validation should fail (token consumed)
    let info2 = broker.validate_and_consume_token(&token).await;
    assert!(info2.is_none());
}

#[tokio::test]
async fn test_invalid_token() {
    let broker = ConnectionBroker::new(300);

    let info = broker
        .validate_and_consume_token("invalid_token_12345")
        .await;
    assert!(info.is_none());
}

#[tokio::test]
async fn test_cleanup_expired_tokens() {
    // Use very short expiry for testing
    let broker = ConnectionBroker::new(1); // 1 second expiry

    let _token = broker
        .generate_p2p_token("agent_123", "agent_123:dev-work", "192.168.1.10", 8080)
        .await;

    // Wait for token to expire
    tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

    // Cleanup should remove expired tokens
    let removed = broker.cleanup_expired_tokens().await;
    assert_eq!(removed, 1);

    // Token should no longer be valid
    let info = broker.validate_and_consume_token(&_token).await;
    assert!(info.is_none());
}

#[tokio::test]
async fn test_multiple_tokens_same_agent() {
    let broker = ConnectionBroker::new(300);

    let token1 = broker
        .generate_p2p_token("agent_123", "agent_123:session1", "192.168.1.10", 8080)
        .await;

    let token2 = broker
        .generate_p2p_token("agent_123", "agent_123:session2", "192.168.1.10", 8080)
        .await;

    // Both tokens should be valid
    let info1 = broker.validate_and_consume_token(&token1).await;
    assert!(info1.is_some());
    assert_eq!(info1.unwrap().session_id, "agent_123:session1");

    let info2 = broker.validate_and_consume_token(&token2).await;
    assert!(info2.is_some());
    assert_eq!(info2.unwrap().session_id, "agent_123:session2");
}
