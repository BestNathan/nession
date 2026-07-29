use serde::Serialize;

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

pub fn scan_claude_dir(root: &std::path::Path) -> Vec<ConfigCategory> {
    let _ = root;
    vec![]
}
