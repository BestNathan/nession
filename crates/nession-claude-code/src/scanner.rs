use crate::security;
use std::path::Path;

use crate::protocol::list::v1::{ConfigCategory, ConfigFile};

const CATEGORIES: &[(&str, &[&str], Option<&str>)] = &[
    (
        "Settings",
        &["settings.json", "keybindings.json"],
        Some("settings"),
    ),
    // More specific than Instructions: a Markdown topic named CLAUDE.md in
    // a memory directory is a memory file, not project instructions.
    // Auto Memory lives under the global config root, not <cwd>/.claude/.
    ("Memory", &["projects/*/memory/**/*.md"], Some("brain")),
    ("Instructions", &["CLAUDE.md"], Some("file-text")),
    ("Agents", &["agents/*.md"], Some("bot")),
    ("Skills", &["skills/**/*.md"], Some("puzzle")),
    ("History", &["projects/*/"], Some("history")),
];

pub fn scan_claude_dir(root: &std::path::Path) -> Vec<ConfigCategory> {
    let mut categories = new_categories();
    scan_dir(root, root, &mut categories);
    categories.retain(|c| !c.files.is_empty());
    for cat in &mut categories {
        cat.files.sort_by(|a, b| a.path.cmp(&b.path));
    }
    categories
}

fn new_categories() -> Vec<ConfigCategory> {
    CATEGORIES
        .iter()
        .map(|(name, _, icon)| ConfigCategory {
            name: name.to_string(),
            icon: icon.map(ToString::to_string),
            files: Vec::new(),
        })
        .collect()
}

fn scan_dir(root: &Path, current: &Path, categories: &mut Vec<ConfigCategory>) {
    let entries = match std::fs::read_dir(current) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let rel = match path.strip_prefix(root) {
            Ok(r) => r,
            Err(_) => continue,
        };
        let rel_str = rel.to_string_lossy().to_string();

        if path.is_dir() {
            scan_dir(root, &path, categories);
            continue;
        }

        if !security::is_path_allowed(&rel_str) {
            continue;
        }

        let filename = security::filename(&rel_str);
        let matched = CATEGORIES
            .iter()
            .find(|(_, patterns, _)| match_pattern(patterns, &rel_str, filename));

        if let Some((cat_name, _, _)) = matched {
            let size = std::fs::metadata(&path)
                .map(|m| usize::try_from(m.len()).unwrap_or(0))
                .unwrap_or(0);
            let content_type = detect_content_type(filename);

            if let Some(cat) = categories.iter_mut().find(|c| c.name == *cat_name) {
                cat.files.push(ConfigFile {
                    path: rel_str.clone(),
                    size,
                    content_type: content_type.to_string(),
                });
            }
        }
    }
}

// Match the fixed set of Claude file-layout patterns by path component.
// A single '*' cannot cross a directory boundary; '**' matches directories.
// The component-aware match is necessary for projects/*/memory/**/*.md:
// the project name must not accidentally consume the memory/ boundary.
fn match_pattern(patterns: &[&str], rel_path: &str, filename: &str) -> bool {
    patterns.iter().any(|pattern| {
        if *pattern == filename {
            return true;
        }
        let pattern_parts: Vec<_> = pattern.split('/').collect();
        let path_parts: Vec<_> = rel_path.split('/').collect();
        match_path_parts(&pattern_parts, &path_parts)
    })
}

fn match_path_parts(pattern: &[&str], path: &[&str]) -> bool {
    let Some((&head, tail)) = pattern.split_first() else {
        return path.is_empty();
    };

    if head == "**" {
        return match_path_parts(tail, path)
            || (!path.is_empty() && match_path_parts(pattern, &path[1..]));
    }

    let Some((&component, remaining)) = path.split_first() else {
        return false;
    };
    match_path_component(head, component) && match_path_parts(tail, remaining)
}

fn match_path_component(pattern: &str, component: &str) -> bool {
    match pattern.split_once('*') {
        Some((prefix, suffix)) => {
            !component.is_empty()
                && component.starts_with(prefix)
                && component.ends_with(suffix)
                && component.len() >= prefix.len() + suffix.len()
        }
        None => pattern == component,
    }
}

fn detect_content_type(filename: &str) -> &str {
    if filename.ends_with(".json") {
        "json"
    } else if filename.ends_with(".jsonl") {
        "jsonl"
    } else if filename.ends_with(".md") {
        "markdown"
    } else {
        "text"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_pattern_simple_filename() {
        assert!(match_pattern(
            &["settings.json"],
            "settings.json",
            "settings.json"
        ));
        assert!(!match_pattern(
            &["settings.json"],
            "other.json",
            "other.json"
        ));
    }

    #[test]
    fn match_pattern_star_glob() {
        assert!(match_pattern(
            &["agents/*.md"],
            "agents/coder.md",
            "coder.md"
        ));
        assert!(!match_pattern(
            &["agents/*.md"],
            "agents/subdir/coder.md",
            "coder.md"
        ));
        assert!(!match_pattern(
            &["agents/*.md"],
            "skills/coder.md",
            "coder.md"
        ));
    }

    #[test]
    fn match_pattern_doublestar_glob() {
        assert!(match_pattern(
            &["skills/**/*.md"],
            "skills/my-skill/skill.md",
            "skill.md"
        ));
        assert!(match_pattern(
            &["skills/**/*.md"],
            "skills/skill.md",
            "skill.md"
        ));
        assert!(match_pattern(
            &["skills/**/*.md"],
            "skills/a/b/c/skill.md",
            "skill.md"
        ));
        assert!(!match_pattern(
            &["skills/**/*.md"],
            "other/skill.md",
            "skill.md"
        ));
    }

    #[test]
    fn auto_memory_paths_are_scoped_to_their_project_memory_directory() {
        let pattern = &["projects/*/memory/**/*.md"];
        assert!(match_pattern(
            pattern,
            "projects/-repo/memory/MEMORY.md",
            "MEMORY.md"
        ));
        assert!(match_pattern(
            pattern,
            "projects/-repo/memory/CLAUDE.md",
            "CLAUDE.md"
        ));
        assert!(match_pattern(
            pattern,
            "projects/-repo/memory/feedback.md",
            "feedback.md"
        ));
        assert!(match_pattern(
            pattern,
            "projects/-repo/memory/topics/nested.md",
            "nested.md"
        ));
        assert!(!match_pattern(
            pattern,
            "projects/-repo/notes.md",
            "notes.md"
        ));
        assert!(!match_pattern(
            pattern,
            "projects/-repo/session/memory/MEMORY.md",
            "MEMORY.md"
        ));
        assert!(!match_pattern(
            pattern,
            "projects/-repo/memory/secret.json",
            "secret.json"
        ));
        assert!(!match_pattern(pattern, "projects/-repo/memory/", ""));
    }

    // --- Inlined from tests/scanner_tests.rs ---

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
            ("projects/-first/memory/MEMORY.md", "# First project memory"),
            ("projects/-first/memory/CLAUDE.md", "# Topic with an instruction-like name"),
            ("projects/-first/memory/feedback.md", "# Feedback"),
            ("projects/-first/memory/topics/nested.md", "# Nested"),
            ("projects/-second/memory/MEMORY.md", "# Second project memory"),
            // These should be filtered out:
            ("credentials.json", "SECRET"),
            ("config.yaml", "yaml: true"),
            ("random.txt", "ignored"),
            ("projects/-first/other.md", "not memory"),
            ("projects/-first/memory/private.json", "not markdown"),
        ]);

        let categories = scan_claude_dir(dir.path());

        assert_eq!(categories.len(), 5, "Should have 5 categories");

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

        let memory = categories.iter().find(|c| c.name == "Memory").unwrap();
        assert_eq!(memory.files.len(), 5);
        let memory_paths: Vec<&str> = memory.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(
            memory_paths,
            vec![
                "projects/-first/memory/CLAUDE.md",
                "projects/-first/memory/MEMORY.md",
                "projects/-first/memory/feedback.md",
                "projects/-first/memory/topics/nested.md",
                "projects/-second/memory/MEMORY.md",
            ]
        );
        assert!(memory.files.iter().all(|f| f.content_type == "markdown"));
        assert!(memory.files.iter().all(|f| security::is_path_allowed(&f.path)));

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
        let categories = scan_claude_dir(dir.path());
        assert!(categories.is_empty());
    }

    #[test]
    fn missing_dir_returns_empty() {
        let categories = scan_claude_dir(&PathBuf::from("/nonexistent/path_xyz"));
        assert!(categories.is_empty());
    }

    #[test]
    fn content_type_detection() {
        let dir = setup_claude_dir(&[
            ("settings.json", "{\"key\": \"value\"}"),
            ("CLAUDE.md", "# markdown"),
        ]);

        let categories = scan_claude_dir(dir.path());
        let settings = categories.iter().find(|c| c.name == "Settings").unwrap();
        assert_eq!(settings.files[0].content_type, "json");

        let instructions = categories
            .iter()
            .find(|c| c.name == "Instructions")
            .unwrap();
        assert_eq!(instructions.files[0].content_type, "markdown");
    }

    // --- Inlined from tests/handler_tests.rs (full_scan_and_read_flow) ---

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

        let categories = scan_claude_dir(&claude);
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
}
