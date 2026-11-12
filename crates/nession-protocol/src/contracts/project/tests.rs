//! Contract and validation tests for `project` v1 (#3021).
//!
//! The Server persists only what [`validate_project_draft`] accepts, so these
//! tests are the negative fixture set for SC-01/SC-02: invalid URL, ref, path
//! and identity data must be rejected deterministically, while a Project with
//! no Agent, no Git source and no location must remain valid.

use super::v1::*;

fn location(agent_id: &str, path: &str) -> ProjectLocation {
    ProjectLocation {
        agent_id: agent_id.to_string(),
        path: path.to_string(),
    }
}

fn source(repository_url: &str, reference: &str) -> ProjectSource {
    ProjectSource {
        repository_url: repository_url.to_string(),
        reference: reference.to_string(),
    }
}

#[test]
fn a_name_only_project_is_valid() {
    let normalized = validate_project_draft("  Notes  ", None, None, &[], None, None).unwrap();
    assert_eq!(normalized.name, "Notes");
    assert!(normalized.description.is_none());
    assert!(normalized.source.is_none());
    assert!(normalized.locations.is_empty());
    assert!(normalized.session_defaults.is_none());
    assert!(normalized.image_digest.is_none());
}

#[test]
fn a_create_payload_with_only_a_name_deserializes() {
    let payload: ProjectCreatePayload =
        serde_json::from_value(serde_json::json!({ "name": "Notes" })).unwrap();
    assert_eq!(payload.name, "Notes");
    assert!(payload.description.is_none());
    assert!(payload.source.is_none());
    assert!(payload.locations.is_empty());
    assert!(payload.session_defaults.is_none());
    assert!(payload.image_digest.is_none());
}

#[test]
fn source_locations_defaults_and_digest_round_trip() {
    let draft = ProjectCreatePayload {
        name: "Nession".to_string(),
        description: Some("Workspace for Nession".to_string()),
        source: Some(source("git@github.com:BestNathan/nession.git", "main")),
        locations: vec![
            location("agent-a", "/Users/nathan/code/nession"),
            location("agent-b", "/workspace/nession"),
        ],
        session_defaults: Some(ProjectSessionDefaults {
            shell: Some("/bin/zsh".to_string()),
            env_profile_ids: vec!["dev".to_string(), "prod".to_string()],
            sandbox_policy_ref: Some("sandbox/default".to_string()),
        }),
        image_digest: Some(format!("sha256:{}", "a".repeat(64))),
    };

    let normalized = validate_project_draft(
        &draft.name,
        draft.description.as_deref(),
        draft.source.as_ref(),
        &draft.locations,
        draft.session_defaults.as_ref(),
        draft.image_digest.as_deref(),
    )
    .unwrap();
    assert_eq!(normalized.source, draft.source);
    assert_eq!(normalized.locations, draft.locations);
    assert_eq!(normalized.session_defaults, draft.session_defaults);

    let project = Project {
        project_id: "project-123e4567-e89b-42d3-a456-426614174000".to_string(),
        name: normalized.name,
        description: normalized.description,
        source: normalized.source,
        locations: normalized.locations,
        session_defaults: normalized.session_defaults,
        image_digest: normalized.image_digest,
        created_at: 10,
        updated_at: 20,
    };
    let json = serde_json::to_value(&project).unwrap();
    assert_eq!(json["source"]["ref"], "main");
    assert_eq!(json["locations"][0]["agent_id"], "agent-a");
    let decoded: Project = serde_json::from_value(json).unwrap();
    assert_eq!(decoded, project);
}

#[test]
fn names_descriptions_and_locations_are_trimmed() {
    let normalized = validate_project_draft(
        "  Spaced  ",
        Some("  Description  "),
        None,
        &[location("  agent-a  ", "/srv/work")],
        None,
        None,
    )
    .unwrap();
    assert_eq!(normalized.name, "Spaced");
    assert_eq!(normalized.description.as_deref(), Some("Description"));
    assert_eq!(normalized.locations[0].agent_id, "agent-a");
}

#[test]
fn multiple_locations_on_offline_agents_are_accepted() {
    // The Project stores desired references only. Whether the Agent is online
    // (or even known) is an observation, never a persistence precondition.
    let normalized = validate_project_draft(
        "Distributed",
        None,
        None,
        &[
            location("offline-agent", "/srv/one"),
            location("unknown-agent", "C:\\work\\two"),
        ],
        None,
        None,
    )
    .unwrap();
    assert_eq!(normalized.locations.len(), 2);
}

#[test]
fn invalid_repository_urls_are_rejected_deterministically() {
    for (url, expected) in [
        ("", ProjectValidationError::EmptyRepositoryUrl),
        ("   ", ProjectValidationError::EmptyRepositoryUrl),
        ("https://", ProjectValidationError::RepositoryUrlInvalid),
        (
            "http://example.com/repo",
            ProjectValidationError::RepositoryUrlInvalid,
        ),
        (
            "file:///tmp/repo",
            ProjectValidationError::RepositoryUrlInvalid,
        ),
        (
            "example.com/repo",
            ProjectValidationError::RepositoryUrlInvalid,
        ),
        (
            "https://example.com/repo with space",
            ProjectValidationError::RepositoryUrlInvalid,
        ),
    ] {
        let error = validate_project_draft("P", None, Some(&source(url, "main")), &[], None, None)
            .unwrap_err();
        assert_eq!(error, expected, "repository URL `{url}`");
    }
}

#[test]
fn accepted_repository_urls_cover_https_ssh_git_and_scp_forms() {
    for url in [
        "https://github.com/BestNathan/nession.git",
        "ssh://git@example.com/repo.git",
        "git://example.com/repo.git",
        "git@github.com:BestNathan/nession.git",
    ] {
        validate_project_draft("P", None, Some(&source(url, "main")), &[], None, None)
            .unwrap_or_else(|error| panic!("`{url}` should be accepted: {error}"));
    }
}

#[test]
fn invalid_source_refs_are_rejected_deterministically() {
    for (reference, expected) in [
        ("", ProjectValidationError::EmptySourceRef),
        ("   ", ProjectValidationError::EmptySourceRef),
        ("has space", ProjectValidationError::SourceRefInvalid),
        ("feature..branch", ProjectValidationError::SourceRefInvalid),
        ("branch~1", ProjectValidationError::SourceRefInvalid),
        ("branch^", ProjectValidationError::SourceRefInvalid),
        ("branch:name", ProjectValidationError::SourceRefInvalid),
        ("branch?", ProjectValidationError::SourceRefInvalid),
        ("branch*", ProjectValidationError::SourceRefInvalid),
        ("a//b", ProjectValidationError::SourceRefInvalid),
        ("/leading", ProjectValidationError::SourceRefInvalid),
        (".hidden", ProjectValidationError::SourceRefInvalid),
        ("trailing.", ProjectValidationError::SourceRefInvalid),
        ("trailing.lock", ProjectValidationError::SourceRefInvalid),
        ("a@{b", ProjectValidationError::SourceRefInvalid),
    ] {
        let error = validate_project_draft(
            "P",
            None,
            Some(&source("https://example.com/repo.git", reference)),
            &[],
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(error, expected, "source ref `{reference}`");
    }

    // A full commit SHA is a valid ref.
    let full_sha = "0123456789abcdef0123456789abcdef01234567";
    validate_project_draft(
        "P",
        None,
        Some(&source("https://example.com/repo.git", full_sha)),
        &[],
        None,
        None,
    )
    .unwrap();
}

#[test]
fn relative_parent_and_control_locations_are_rejected() {
    let cases = [
        (
            location("agent-a", "relative/path"),
            ProjectValidationError::LocationPathMustBeAbsolute { index: 0 },
        ),
        (
            location("agent-a", "/srv/../etc"),
            ProjectValidationError::LocationPathHasParentSegment { index: 0 },
        ),
        (
            location("agent-a", "/srv/\u{0}/work"),
            ProjectValidationError::LocationPathHasControlCharacters { index: 0 },
        ),
        (
            location("", "/srv/work"),
            ProjectValidationError::EmptyAgentId { index: 0 },
        ),
        (
            location("bad agent", "/srv/work"),
            ProjectValidationError::AgentIdHasControlCharacters { index: 0 },
        ),
    ];
    for (location, expected) in cases {
        let error = validate_project_draft("P", None, None, &[location], None, None).unwrap_err();
        assert_eq!(error, expected);
    }
}

#[test]
fn duplicate_locations_are_rejected() {
    let error = validate_project_draft(
        "P",
        None,
        None,
        &[
            location("agent-a", "/srv/work"),
            location("agent-a", "/srv/work"),
        ],
        None,
        None,
    )
    .unwrap_err();
    assert_eq!(
        error,
        ProjectValidationError::DuplicateLocation { index: 1 }
    );
}

#[test]
fn duplicate_env_profile_ids_are_rejected() {
    let defaults = ProjectSessionDefaults {
        shell: None,
        env_profile_ids: vec!["dev".to_string(), "dev".to_string()],
        sandbox_policy_ref: None,
    };
    let error = validate_project_draft("P", None, None, &[], Some(&defaults), None).unwrap_err();
    assert_eq!(
        error,
        ProjectValidationError::DuplicateEnvProfileId { index: 1 }
    );
}

#[test]
fn invalid_image_digests_are_rejected() {
    for digest in [
        "sha256:",
        "sha256:abc",
        "sha256:ABCDEF",
        "md5:0123456789abcdef0123456789abcdef",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
    ] {
        let error = validate_project_draft("P", None, None, &[], None, Some(digest)).unwrap_err();
        assert_eq!(
            error,
            ProjectValidationError::InvalidImageDigest,
            "{digest}"
        );
    }
    validate_project_draft(
        "P",
        None,
        None,
        &[],
        None,
        Some(&format!("sha256:{}", "0123456789abcdef".repeat(4))),
    )
    .unwrap();
}

#[test]
fn control_characters_are_rejected_in_names_and_descriptions() {
    assert_eq!(
        validate_project_draft("bad\u{1b}name", None, None, &[], None, None).unwrap_err(),
        ProjectValidationError::NameHasControlCharacters
    );
    assert_eq!(
        validate_project_draft("P", Some("bad\u{0}description"), None, &[], None, None)
            .unwrap_err(),
        ProjectValidationError::DescriptionHasControlCharacters
    );
    // Newlines and tabs are ordinary plain text.
    validate_project_draft(
        "P",
        Some("line one\nline two\tindented"),
        None,
        &[],
        None,
        None,
    )
    .unwrap();
}

#[test]
fn project_identities_match_the_server_minted_shape() {
    assert!(is_valid_project_id(
        "project-123e4567-e89b-42d3-a456-426614174000"
    ));
    for invalid in [
        "",
        "project-",
        "123e4567-e89b-42d3-a456-426614174000",
        "project-123E4567-e89b-42d3-a456-426614174000",
        "project-123e4567e89b42d3a456426614174000",
        "project-123e4567-e89b-42d3-a456-42661417400z",
        "project-123e4567-e89b-42d3-a456-4266141740000",
    ] {
        assert!(!is_valid_project_id(invalid), "{invalid}");
    }
}

#[test]
fn bounds_are_reported_with_their_limit() {
    let long_name = "n".repeat(PROJECT_NAME_MAX_CHARS + 1);
    assert_eq!(
        validate_project_draft(&long_name, None, None, &[], None, None).unwrap_err(),
        ProjectValidationError::NameTooLong {
            max: PROJECT_NAME_MAX_CHARS
        }
    );

    let long_description = "d".repeat(PROJECT_DESCRIPTION_MAX_CHARS + 1);
    assert_eq!(
        validate_project_draft("P", Some(&long_description), None, &[], None, None).unwrap_err(),
        ProjectValidationError::DescriptionTooLong {
            max: PROJECT_DESCRIPTION_MAX_CHARS
        }
    );
}
