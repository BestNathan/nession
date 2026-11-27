//! #4682 SC-01: persistent named profiles through the real CLI.
//!
//! Create/list/current/show/use/set/remove, secure credential setup and
//! explicit import, observed across successive processes; offline inspection
//! makes zero connections; invalid/duplicate names and malformed config reject
//! without state mutation; concurrent updates lose no unrelated profiles.

#![allow(clippy::expect_used, clippy::unwrap_used, clippy::indexing_slicing)]

use super::profile_support::{
    add_profile, combined, run, run_with_stdin, set_credential, Endpoint, Home,
};

#[test]
fn the_profile_lifecycle_round_trips_across_processes() {
    let home = Home::new();

    // First add selects; the endpoint arrives as the global --server-url.
    add_profile(&home, "home", "wss://home.example/ws");
    let store = home.store_text().expect("store created");
    assert!(store.contains("current_profile = \"home\""));

    // A later add never changes the selection.
    add_profile(&home, "local", "ws://127.0.0.1:8080");
    let store = home.store_text().unwrap();
    assert!(store.contains("current_profile = \"home\""));
    assert!(store.contains("[profiles.local]"));

    // list/current/show are separate processes observing the same store.
    let output = run(home.nession().args(["profile", "list"]));
    assert!(output.status.success());
    let text = combined(&output);
    assert!(text.contains("home") && text.contains("local"), "{text}");
    assert!(text.contains("Current profile: home"), "{text}");

    let output = run(home.nession().args(["profile", "current"]));
    assert!(output.status.success());
    assert!(combined(&output).contains("Current profile: home"));

    let output = run(home.nession().args(["profile", "show", "local"]));
    assert!(output.status.success());
    let text = combined(&output);
    assert!(text.contains("ws://127.0.0.1:8080"), "{text}");
    assert!(text.contains("selected: no"), "{text}");

    // use changes only the client selection.
    let output = run(home.nession().args(["profile", "use", "local"]));
    assert!(output.status.success());
    assert!(home
        .store_text()
        .unwrap()
        .contains("current_profile = \"local\""));

    // set replaces the endpoint (the documented replacement operation).
    let output = run(home.nession().args([
        "profile",
        "set",
        "local",
        "--server-url",
        "ws://127.0.0.1:9090",
    ]));
    assert!(output.status.success(), "{}", combined(&output));
    assert!(home.store_text().unwrap().contains("ws://127.0.0.1:9090"));

    // Removing a non-current profile works; removing current needs --force.
    let output = run(home.nession().args(["profile", "remove", "home"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert!(!home.store_text().unwrap().contains("[profiles.home]"));

    let output = run(home.nession().args(["profile", "remove", "local"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("--force"));
    assert!(home.store_text().unwrap().contains("[profiles.local]"));

    let output = run(home
        .nession()
        .args(["profile", "remove", "local", "--force"]));
    assert!(output.status.success());
    let store = home.store_text().unwrap();
    assert!(!store.contains("[profiles.local]"));
    assert!(
        !store.contains("current_profile"),
        "selection cleared, not reassigned"
    );

    let output = run(home.nession().args(["profile", "current"]));
    assert!(output.status.success());
    assert!(combined(&output).contains("No profile selected"));
}

#[test]
fn offline_inspection_makes_zero_connections() {
    let home = Home::new();
    let endpoint = Endpoint::start(super::profile_support::Auth::Accept);
    add_profile(&home, "home", &endpoint.url());

    for args in [
        vec!["profile", "list"],
        vec!["profile", "current"],
        vec!["profile", "show", "home"],
    ] {
        let output = run(home.nession().args(&args));
        assert!(output.status.success(), "{args:?}: {}", combined(&output));
    }
    assert!(
        endpoint.was_not_dialled(),
        "offline inspection must never connect"
    );
}

#[test]
fn a_duplicate_add_fails_without_overwrite() {
    let home = Home::new();
    add_profile(&home, "home", "ws://first:1/ws");
    let output =
        run(home
            .nession()
            .args(["profile", "add", "home", "--server-url", "ws://second:2/ws"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("already exists"));
    let store = home.store_text().unwrap();
    assert!(store.contains("ws://first:1/ws"));
    assert!(!store.contains("second"));
}

#[test]
fn invalid_names_and_urls_reject_without_mutation() {
    let home = Home::new();
    for name in ["../evil", "has space", "-lead", ""] {
        let output =
            run(home
                .nession()
                .args(["profile", "add", name, "--server-url", "ws://host/ws"]));
        assert!(!output.status.success(), "{name:?} must be refused");
    }
    for url in [
        "http://host/ws",
        "ws://user:pass@host/ws",
        "ws://host/ws?token=x",
        "",
    ] {
        let output = run(home
            .nession()
            .args(["profile", "add", "home", "--server-url", url]));
        assert!(!output.status.success(), "{url:?} must be refused");
    }
    assert!(home.store_text().is_none(), "no mutation on rejection");

    // add without --server-url is refused with guidance.
    let output = run(home.nession().args(["profile", "add", "home"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("--server-url"));
}

#[test]
fn a_malformed_or_unsupported_store_is_never_overwritten() {
    for bad in [
        "this is not toml {{{".to_string(),
        "schema_version = 99\n".to_string(),
        "schema_version = 1\ncurrent_profile = \"ghost\"\n".to_string(),
        "schema_version = 1\n[profiles.home]\nserver_url = \"ws://h/ws\"\nauth_token = \"x\"\n"
            .to_string(),
    ] {
        let home = Home::new();
        std::fs::write(home.store_path(), &bad).unwrap();
        for args in [
            vec!["profile", "list"],
            vec!["profile", "add", "home", "--server-url", "ws://h/ws"],
            vec!["profile", "use", "home"],
        ] {
            let output = run(home.nession().args(&args));
            assert!(!output.status.success(), "{args:?} on {bad:?}");
        }
        assert_eq!(home.store_text().unwrap(), bad, "bytes must survive");
    }
}

#[test]
fn concurrent_adds_preserve_every_profile() {
    let home = Home::new();
    let children: Vec<_> = (0..8)
        .map(|index| {
            home.nession()
                .args([
                    "profile",
                    "add",
                    &format!("p{index}"),
                    "--server-url",
                    &format!("ws://host-{index}/ws"),
                ])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("spawn add")
        })
        .collect();
    for child in children {
        let output = child.wait_with_output().expect("wait add");
        assert!(output.status.success(), "{}", combined(&output));
    }
    let store = home.store_text().unwrap();
    for index in 0..8 {
        assert!(
            store.contains(&format!("[profiles.p{index}]")),
            "p{index} lost"
        );
    }
    // Exactly one current selection emerged from the race.
    assert_eq!(store.matches("current_profile = ").count(), 1);
}

#[test]
fn concurrent_bootstrap_adds_converge_on_one_selection() {
    let home = Home::new();
    home.write_agent_config("ws://agent-endpoint:9/ws");
    let children: Vec<_> = (0..6)
        .map(|_| {
            home.nession()
                .args(["profile", "import-agent"])
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("spawn import")
        })
        .collect();
    let mut successes = 0;
    for child in children {
        let output = child.wait_with_output().expect("wait import");
        if output.status.success() {
            successes += 1;
        } else {
            assert!(combined(&output).contains("already exists"));
        }
    }
    assert_eq!(successes, 1, "exactly one import may create the profile");
    let store = home.store_text().unwrap();
    assert_eq!(store.matches("[profiles.agent]").count(), 1);
    assert!(store.contains("current_profile = \"agent\""));
}

#[test]
fn credential_set_stdin_rotates_and_clears_without_secret_leakage() {
    let home = Home::new();
    add_profile(&home, "home", "ws://host:9/ws");

    set_credential(&home, "home", "canary-one-4682");
    let store = home.store_text().unwrap();
    assert!(store.contains("credential_ref = \"home\""));
    assert!(store.contains("credential_backend = \"file\""));
    assert!(
        !store.contains("canary-one-4682"),
        "no secret in profile TOML"
    );
    let credential = std::fs::read_to_string(home.credential_path("home")).unwrap();
    assert!(credential.contains("canary-one-4682"));

    // Rotation replaces the bytes.
    let output = run_with_stdin(
        home.nession()
            .args(["profile", "credential", "set", "home", "--stdin"]),
        "canary-two-4682",
    );
    assert!(output.status.success());
    assert!(combined(&output).contains("Rotated"));
    let credential = std::fs::read_to_string(home.credential_path("home")).unwrap();
    assert!(credential.contains("canary-two-4682"));
    assert!(!credential.contains("canary-one-4682"));

    // Clear deletes the bytes and returns the profile to unset.
    let output = run(home
        .nession()
        .args(["profile", "credential", "clear", "home"]));
    assert!(output.status.success());
    assert!(!home.credential_path("home").exists());
    let store = home.store_text().unwrap();
    assert!(!store.contains("credential_ref"));

    let output = run(home
        .nession()
        .args(["profile", "credential", "clear", "home"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("no stored credential"));

    // An empty credential is refused; no-auth is a separate explicit setting.
    let output = run_with_stdin(
        home.nession()
            .args(["profile", "credential", "set", "home", "--stdin"]),
        "\n",
    );
    assert!(!output.status.success());
    assert!(combined(&output).contains("empty credential"));

    // A secret is never accepted as argv for the credential command.
    let output =
        run(home
            .nession()
            .args(["profile", "credential", "set", "home", "canary-as-argv"]));
    assert!(!output.status.success(), "positional secret must not parse");
}

#[test]
fn import_agent_is_explicit_endpoint_only_and_never_overwrites() {
    let home = Home::new();
    home.write_agent_config("ws://agent-endpoint:9/ws");

    let output = run(home.nession().args(["profile", "import-agent"]));
    assert!(output.status.success(), "{}", combined(&output));
    let text = combined(&output);
    assert!(text.contains("Endpoint only"), "{text}");
    let store = home.store_text().unwrap();
    assert!(store.contains("ws://agent-endpoint:9/ws"));
    assert!(store.contains("current_profile = \"agent\""));
    assert!(!store.contains("daemon-auth-canary-4682"));
    assert!(!store.contains("daemon-agent-canary-4682"));
    assert!(!store.contains("auth_token"));

    // A second import refuses to overwrite.
    let output = run(home.nession().args(["profile", "import-agent"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("already exists"));

    // A named import creates another profile without changing the selection.
    let output = run(home
        .nession()
        .args(["profile", "import-agent", "--name", "other"]));
    assert!(output.status.success());
    let store = home.store_text().unwrap();
    assert!(store.contains("[profiles.other]"));
    assert!(store.contains("current_profile = \"agent\""));

    // An explicit --config imports from that file; a missing one fails closed.
    let custom = home.path().join("custom-agent.toml");
    std::fs::write(&custom, "server_url = \"ws://custom:7/ws\"\n").unwrap();
    let output = run(home.nession().args([
        "profile",
        "import-agent",
        "--name",
        "custom",
        "--config",
        custom.to_str().unwrap(),
    ]));
    assert!(output.status.success());
    assert!(home.store_text().unwrap().contains("ws://custom:7/ws"));

    let output = run(home.nession().args([
        "profile",
        "import-agent",
        "--name",
        "missing",
        "--config",
        home.path().join("absent.toml").to_str().unwrap(),
    ]));
    assert!(!output.status.success());
    assert!(!home.store_text().unwrap().contains("[profiles.missing]"));
}

#[test]
fn set_endpoint_invalidates_the_bound_credential() {
    let home = Home::new();
    add_profile(&home, "home", "ws://first:1/ws");
    set_credential(&home, "home", "bound-canary");
    assert!(home.credential_path("home").exists());

    let output =
        run(home
            .nession()
            .args(["profile", "set", "home", "--server-url", "ws://second:2/ws"]));
    assert!(output.status.success(), "{}", combined(&output));
    assert!(combined(&output).contains("invalidated"));
    assert!(
        !home.credential_path("home").exists(),
        "owned bytes deleted"
    );
    let store = home.store_text().unwrap();
    assert!(!store.contains("credential_ref"));
    assert!(!store.contains("bound-canary"));

    // --no-auth alone also deletes the bound credential and marks no-auth.
    set_credential(&home, "home", "another-canary");
    let output = run(home.nession().args(["profile", "set", "home", "--no-auth"]));
    assert!(output.status.success());
    assert!(!home.credential_path("home").exists());
    assert!(home.store_text().unwrap().contains("no_auth = true"));

    // set with nothing to change is refused.
    let output = run(home.nession().args(["profile", "set", "home"]));
    assert!(!output.status.success());
    assert!(combined(&output).contains("nothing to set"));
}

#[test]
fn use_and_show_of_unknown_profiles_fail_closed() {
    let home = Home::new();
    let output = run(home.nession().args(["profile", "use", "ghost"]));
    assert!(!output.status.success());
    let output = run(home.nession().args(["profile", "show", "ghost"]));
    assert!(!output.status.success());
    assert!(home.store_text().is_none());
}
