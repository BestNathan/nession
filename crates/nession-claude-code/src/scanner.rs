use crate::security;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
pub struct ConfigCategory {
    pub name: String,
    pub icon: Option<String>,
    pub files: Vec<ConfigFile>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigFile {
    pub path: String,
    pub size: usize,
    pub content_type: String,
}

const CATEGORIES: &[(&str, &[&str], Option<&str>)] = &[
    (
        "Settings",
        &["settings.json", "keybindings.json"],
        Some("settings"),
    ),
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

fn match_pattern(patterns: &[&str], rel_path: &str, filename: &str) -> bool {
    patterns.iter().any(|pattern| {
        // Exact filename match
        if *pattern == filename {
            return true;
        }

        if pattern.contains("**") {
            // Recursive glob: split on "**"
            // e.g., "skills/**/*.md" → prefix="skills/", suffix may contain "*"
            if let Some((prefix, suffix)) = pattern.split_once("**") {
                if !rel_path.starts_with(prefix) {
                    return false;
                }
                let remaining = &rel_path[prefix.len()..];
                // Handle the suffix after "**" (e.g., "/*.md")
                return match_suffix_glob(suffix, remaining);
            }
        }

        if pattern.contains('*') {
            // Simple glob: split on "*"
            // e.g., "agents/*.md" → prefix="agents/", suffix=".md"
            // The `*` must not match across directory boundaries (no `/`)
            if let Some((prefix, suffix)) = pattern.split_once('*') {
                if !rel_path.starts_with(prefix) || !rel_path.ends_with(suffix) {
                    return false;
                }
                let mid_start = prefix.len();
                let mid_end = rel_path.len().saturating_sub(suffix.len());
                if mid_end <= mid_start {
                    return true;
                }
                let mid = &rel_path[mid_start..mid_end];
                return !mid.contains('/');
            }
        }

        false
    })
}

/// Match a path component against a suffix pattern that may contain a `*`.
/// e.g., suffix="/*.md", remaining="my-skill/skill.md" → true
///       suffix="/*.md", remaining="skill.md" → true
fn match_suffix_glob(suffix: &str, remaining: &str) -> bool {
    if suffix.is_empty() {
        return true;
    }
    if !suffix.contains('*') {
        return remaining == suffix;
    }
    // Extract the fixed suffix tail (after the last `*`), e.g., ".md"
    // and check that the remaining path ends with it.
    // The `**` already handled recursive matching, so we only need
    // to verify the file extension from the suffix pattern.
    if let Some((_, suffix_tail)) = suffix.split_once('*') {
        remaining.ends_with(suffix_tail)
    } else {
        remaining == suffix
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
}
