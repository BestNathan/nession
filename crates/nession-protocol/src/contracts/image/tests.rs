use super::v1::*;

fn source(url: &str, reference: &str) -> ImageSource {
    ImageSource::GitHub {
        repository_url: url.to_string(),
        reference: reference.to_string(),
    }
}

#[test]
fn public_github_https_repository_urls_normalize() {
    assert_eq!(
        normalize_github_repository_url("https://github.com/BestNathan/nession").unwrap(),
        "https://github.com/BestNathan/nession"
    );
    assert_eq!(
        normalize_github_repository_url("  https://github.com/BestNathan/nession.git/  ").unwrap(),
        "https://github.com/BestNathan/nession"
    );
}

#[test]
fn private_ssh_http_and_ambiguous_repository_urls_are_refused() {
    for (url, expected) in [
        ("", "repository_url must not be empty"),
        (
            "git@github.com:BestNathan/nession.git",
            "repository_url must not contain credentials or userinfo",
        ),
        (
            "ssh://git@github.com/BestNathan/nession.git",
            "repository_url must not contain credentials or userinfo",
        ),
        (
            "http://github.com/BestNathan/nession",
            "repository_url must be https://github.com/<owner>/<repo>; private, ssh and git protocols are not supported",
        ),
        (
            "https://github.com/BestNathan",
            "repository_url must be https://github.com/<owner>/<repo>; private, ssh and git protocols are not supported",
        ),
        (
            "https://github.com/BestNathan/nession/tree/main",
            "repository_url must be https://github.com/<owner>/<repo>; private, ssh and git protocols are not supported",
        ),
        (
            "https://user:token@github.com/BestNathan/nession",
            "repository_url must not contain credentials or userinfo",
        ),
        (
            "https://github.com/BestNathan/nession?ref=main",
            "repository_url must be https://github.com/<owner>/<repo>; private, ssh and git protocols are not supported",
        ),
    ] {
        let error = normalize_github_repository_url(url).unwrap_err();
        assert_eq!(error.message(), expected, "{url}");
    }
}

#[test]
fn a_branch_or_full_commit_ref_is_normalized_and_ambiguous_refs_are_refused() {
    assert_eq!(
        normalize_source_ref(" feature/EROFS ").unwrap(),
        ("feature/EROFS".to_string(), None)
    );
    let sha = "a".repeat(40);
    assert_eq!(
        normalize_source_ref(&sha).unwrap(),
        (sha.clone(), Some(sha.clone()))
    );
    for invalid in [
        "",
        "-x",
        "/x",
        "x/",
        "x..y",
        "x//y",
        "x@{y",
        "x\\y",
        "x~y",
        "x:y",
        "HEAD",
        ".hidden",
        "x/.hidden",
        "x.lock",
        "x.lock/y",
    ] {
        assert!(
            normalize_source_ref(invalid).is_err(),
            "ref {invalid:?} must be refused"
        );
    }
}

#[test]
fn local_directory_sources_must_be_absolute_without_parent_segments() {
    assert_eq!(
        normalize_local_path("/var/lib/nession/base/glibc").unwrap(),
        "/var/lib/nession/base/glibc"
    );
    for (path, expected) in [
        ("", "local directory path must not be empty"),
        ("relative/path", "local directory path must be absolute"),
        (
            "/var/lib/../etc",
            "local directory path must not contain '..'",
        ),
        (
            "/var/lib/\u{7f}bad",
            "local directory path contains forbidden control characters",
        ),
    ] {
        let error = normalize_local_path(path).unwrap_err();
        assert_eq!(error.message(), expected, "{path:?}");
    }
}

#[test]
fn aliases_and_digests_have_one_unambiguous_shape() {
    assert_eq!(normalize_alias("latest").unwrap(), "latest");
    assert_eq!(normalize_alias("base-glibc_2").unwrap(), "base-glibc_2");
    for invalid in ["", "-latest", "Latest", "sha256:abc", "a b", "a/b"] {
        assert!(normalize_alias(invalid).is_err(), "alias {invalid:?}");
    }
    let digest = format!("sha256:{}", "0".repeat(64));
    assert_eq!(normalize_image_digest(&digest).unwrap(), digest);
    for invalid in [
        String::new(),
        format!("sha256:{}", "0".repeat(63)),
        format!("sha256:{}", "A".repeat(64)),
        "md5:abc".to_string(),
    ] {
        assert!(normalize_image_digest(&invalid).is_err(), "{invalid}");
    }
}

#[test]
fn packaging_identity_is_exactly_v1_deterministic() {
    let packaging = ImagePackaging::default();
    validate_packaging(&packaging).unwrap();
    let mut changed = packaging.clone();
    changed.compression = "lz4hc".to_string();
    assert!(validate_packaging(&changed).is_err());
    let mut changed = packaging.clone();
    changed.block_size = 8192;
    assert!(validate_packaging(&changed).is_err());
    let mut changed = packaging;
    changed.fixed_timestamp = 1;
    assert!(validate_packaging(&changed).is_err());
    assert!(ImagePackaging::default().is_v1_deterministic());
}

#[test]
fn normalize_image_source_carries_the_requested_commit_for_a_pinned_ref() {
    let sha = "b".repeat(40);
    let normalized =
        normalize_image_source(&source("https://github.com/BestNathan/nession.git", &sha)).unwrap();
    assert_eq!(normalized.kind(), "github");
    assert_eq!(
        normalized.source(),
        source("https://github.com/BestNathan/nession", &sha)
    );
}

#[test]
fn image_list_pagination_defaults_keep_the_legacy_bound_and_reports_next_offset() {
    let default_page: ImageListPayload = serde_json::from_value(serde_json::json!({})).unwrap();
    assert_eq!(default_page.offset, 0);
    assert_eq!(default_page.limit, IMAGE_LIST_DEFAULT_LIMIT);
    assert_eq!(default_page.query, "");

    let explicit: ImageListPayload =
        serde_json::from_value(serde_json::json!({ "offset": 200, "limit": 20, "query": "node" }))
            .unwrap();
    assert_eq!(explicit.offset, 200);
    assert_eq!(explicit.limit, 20);
    assert_eq!(explicit.query, "node");

    let reply = ImageListResponsePayload {
        images: Vec::new(),
        total: 235,
        next_offset: Some(200),
        error: None,
    };
    let value = serde_json::to_value(reply).unwrap();
    assert_eq!(value["total"], 235);
    assert_eq!(value["next_offset"], 200);
    assert!(value.get("error").is_none());

    let older_reply: ImageListResponsePayload =
        serde_json::from_value(serde_json::json!({ "images": [] })).unwrap();
    assert_eq!(older_reply.total, 0);
    assert_eq!(older_reply.next_offset, None);
}

#[test]
fn access_requires_exactly_one_consumer_and_keeps_project_compatibility() {
    let project: ImageAccessPayload = serde_json::from_value(serde_json::json!({
        "project_id": "project-00000000-0000-0000-0000-000000000001",
        "digest": format!("sha256:{}", "a".repeat(64)),
    }))
    .unwrap();
    assert_eq!(
        project.consumer().unwrap(),
        ImageAccessConsumer::Project("project-00000000-0000-0000-0000-000000000001")
    );

    let session: ImageAccessPayload = serde_json::from_value(serde_json::json!({
        "session_id": "agent-1:work",
        "digest": format!("sha256:{}", "b".repeat(64)),
    }))
    .unwrap();
    assert_eq!(
        session.consumer().unwrap(),
        ImageAccessConsumer::Session("agent-1:work")
    );

    for value in [
        serde_json::json!({ "digest": format!("sha256:{}", "c".repeat(64)) }),
        serde_json::json!({
            "project_id": "project-00000000-0000-0000-0000-000000000001",
            "session_id": "agent-1:work",
            "digest": format!("sha256:{}", "d".repeat(64)),
        }),
    ] {
        let payload: ImageAccessPayload = serde_json::from_value(value).unwrap();
        assert_eq!(
            payload.consumer().unwrap_err().message(),
            "server.image.access requires exactly one of project_id or session_id"
        );
    }
}
