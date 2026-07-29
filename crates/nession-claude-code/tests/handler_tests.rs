use nession_claude_code::security;
use std::fs;
use tempfile::TempDir;

#[test]
fn full_scan_and_read_flow() {
    let dir = TempDir::new().unwrap();
    let claude = dir.path().join(".claude");
    fs::create_dir_all(claude.join("agents")).unwrap();
    fs::create_dir_all(claude.join("skills/my-skill")).unwrap();

    fs::write(claude.join("settings.json"), r#"{"theme": "dark"}"#).unwrap();
    fs::write(claude.join("CLAUDE.md"), "# Hello\n\nInstructions here.").unwrap();
    fs::write(claude.join("agents/coder.md"), "# Coder Agent").unwrap();
    fs::write(claude.join("skills/my-skill/skill.md"), "# My Skill").unwrap();

    let categories = nession_claude_code::scanner::scan_claude_dir(&claude);
    assert!(!categories.is_empty(), "Should find config files");

    // Verify no credentials.json leak
    for cat in &categories {
        for f in &cat.files {
            assert!(
                !f.path.contains("credentials"),
                "credentials.json must not appear"
            );
        }
    }
}

#[test]
fn pagination_logic() {
    let content = "A".repeat(5000);
    let limit = 1000;

    let offset = 0;
    let chunk = &content[offset..std::cmp::min(offset + limit, content.len())];
    assert_eq!(chunk.len(), 1000);

    let offset = 1000;
    let chunk = &content[offset..std::cmp::min(offset + limit, content.len())];
    assert_eq!(chunk.len(), 1000);

    let offset = 4900;
    let chunk = &content[offset..std::cmp::min(offset + limit, content.len())];
    assert_eq!(chunk.len(), 100);

    let has_more = offset + limit < content.len();
    assert!(!has_more);
}

#[test]
fn file_too_large_detection() {
    assert!(500_000 <= security::MAX_FILE_SIZE);
    assert!(2_000_000 > security::MAX_FILE_SIZE);
}
