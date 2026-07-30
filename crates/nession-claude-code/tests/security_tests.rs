use nession_claude_code::security;

#[test]
fn rejects_path_traversal() {
    assert!(!security::is_path_allowed("../../../etc/passwd"));
    assert!(!security::is_path_allowed("agents/../../secret.txt"));
    assert!(!security::is_path_allowed("/absolute/path"));
}

#[test]
fn rejects_blacklisted_files() {
    assert!(!security::is_path_allowed("credentials.json"));
}

#[test]
fn allows_valid_paths() {
    assert!(security::is_path_allowed("settings.json"));
    assert!(security::is_path_allowed("CLAUDE.md"));
    assert!(security::is_path_allowed("agents/coder.md"));
    assert!(security::is_path_allowed("skills/dev/skill.md"));
}

#[test]
fn rejects_disallowed_extensions() {
    assert!(!security::is_path_allowed("config.yaml"));
    assert!(!security::is_path_allowed("secret.env"));
    assert!(!security::is_path_allowed("data.toml"));
}

#[test]
fn filename_extraction() {
    assert_eq!(security::filename("agents/coder.md"), "coder.md");
    assert_eq!(security::filename("settings.json"), "settings.json");
}

#[test]
fn claude_home_dir_exists_or_none() {
    // Just ensure it doesn't panic
    let _ = security::claude_home_dir();
}
