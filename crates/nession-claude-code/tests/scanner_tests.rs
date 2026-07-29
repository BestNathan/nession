use nession_claude_code::scanner;
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tempfile::TempDir;

fn setup_claude_dir(files: &[(&str, &str)]) -> TempDir {
    let dir = TempDir::new().unwrap();
    for (rel_path, content) in files {
        let full = dir.path().join(rel_path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = fs::File::create(&full).unwrap();
        f.write_all(content.as_bytes()).unwrap();
    }
    dir
}

#[test]
fn scan_valid_claude_dir() {
    let dir = setup_claude_dir(&[
        ("settings.json", "{}"),
        ("CLAUDE.md", "# Instructions"),
        ("agents/coder.md", "# Coder agent"),
        ("agents/reviewer.md", "# Reviewer agent"),
        ("skills/my-skill/skill.md", "# My skill"),
        ("keybindings.json", "{}"),
        // These should be filtered out:
        ("credentials.json", "SECRET"),
        ("config.yaml", "yaml: true"),
        ("random.txt", "ignored"),
    ]);

    let categories = scanner::scan_claude_dir(dir.path());

    assert_eq!(categories.len(), 4, "Should have 4 categories");

    let settings = categories.iter().find(|c| c.name == "Settings").unwrap();
    assert_eq!(settings.files.len(), 2);
    let paths: Vec<&str> = settings.files.iter().map(|f| f.path.as_str()).collect();
    assert!(paths.contains(&"settings.json"));
    assert!(paths.contains(&"keybindings.json"));

    let instructions = categories
        .iter()
        .find(|c| c.name == "Instructions")
        .unwrap();
    assert_eq!(instructions.files.len(), 1);
    assert_eq!(instructions.files[0].path, "CLAUDE.md");

    let agents = categories.iter().find(|c| c.name == "Agents").unwrap();
    assert_eq!(agents.files.len(), 2);

    let skills = categories.iter().find(|c| c.name == "Skills").unwrap();
    assert_eq!(skills.files.len(), 1);

    for cat in &categories {
        for f in &cat.files {
            assert_ne!(f.path, "credentials.json");
        }
    }
}

#[test]
fn empty_dir_returns_empty_categories() {
    let dir = TempDir::new().unwrap();
    let categories = scanner::scan_claude_dir(dir.path());
    assert!(categories.is_empty());
}

#[test]
fn missing_dir_returns_empty() {
    let categories = scanner::scan_claude_dir(&PathBuf::from("/nonexistent/path_xyz"));
    assert!(categories.is_empty());
}

#[test]
fn content_type_detection() {
    let dir = setup_claude_dir(&[
        ("settings.json", "{\"key\": \"value\"}"),
        ("CLAUDE.md", "# markdown"),
    ]);

    let categories = scanner::scan_claude_dir(dir.path());
    let settings = categories.iter().find(|c| c.name == "Settings").unwrap();
    assert_eq!(settings.files[0].content_type, "json");

    let instructions = categories
        .iter()
        .find(|c| c.name == "Instructions")
        .unwrap();
    assert_eq!(instructions.files[0].content_type, "markdown");
}
