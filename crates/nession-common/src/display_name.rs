//! Display Name validation and normalisation for agent identity.
//!
//! Rules (from requirements):
//! - Max 64 characters (Unicode, counted by `char` count not byte length)
//! - Unicode allowed (including CJK, emoji)
//! - ASCII control characters (0x00–0x1F, 0x7F) are forbidden
//! - Leading/trailing whitespace is trimmed
//! - Empty after trim → fallback to hostname

/// Maximum display name length in characters.
pub const MAX_DISPLAY_NAME_LEN: usize = 64;

/// Validate and normalise a raw display name string.
///
/// Returns `Ok(Some(normalized))` on success, `Ok(None)` when the string is
/// empty after trimming (caller should fall back to hostname), or `Err(msg)`
/// when the string contains forbidden characters.
pub fn validate_display_name(raw: &str) -> Result<Option<String>, String> {
    let trimmed = raw.trim();

    if trimmed.is_empty() {
        return Ok(None);
    }

    // Reject ASCII control characters (including DEL at 0x7F)
    if trimmed.contains(|c: char| c.is_ascii_control()) {
        return Err("display_name contains forbidden control characters".to_string());
    }

    // Truncate at character boundary (not byte boundary)
    let normalized: String = trimmed.chars().take(MAX_DISPLAY_NAME_LEN).collect();

    if normalized.is_empty() {
        return Ok(None);
    }

    Ok(Some(normalized))
}

/// Resolve the effective display name: override > config > hostname.
#[must_use]
pub fn effective_display_name(
    stored: Option<&str>,
    config: Option<&str>,
    hostname: &str,
) -> String {
    if let Some(s) = stored {
        if !s.is_empty() {
            return s.to_string();
        }
    }
    if let Some(c) = config {
        if !c.is_empty() {
            return c.to_string();
        }
    }
    hostname.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_normal() {
        assert_eq!(
            validate_display_name("my-dev-box").unwrap(),
            Some("my-dev-box".to_string())
        );
    }

    #[test]
    fn test_validate_unicode() {
        assert_eq!(
            validate_display_name("🏠 家庭服务器").unwrap(),
            Some("🏠 家庭服务器".to_string())
        );
    }

    #[test]
    fn test_validate_trim_whitespace() {
        assert_eq!(
            validate_display_name("  hello  ").unwrap(),
            Some("hello".to_string())
        );
    }

    #[test]
    fn test_validate_empty() {
        assert_eq!(validate_display_name("").unwrap(), None);
        assert_eq!(validate_display_name("   ").unwrap(), None);
    }

    #[test]
    fn test_validate_control_chars() {
        assert!(validate_display_name("hello\x00world").is_err());
        assert!(validate_display_name("hello\x1bworld").is_err());
        assert!(validate_display_name("hello\x7fworld").is_err());
    }

    #[test]
    fn test_validate_truncate() {
        let long = "a".repeat(100);
        let result = validate_display_name(&long).unwrap().unwrap();
        assert_eq!(result.chars().count(), MAX_DISPLAY_NAME_LEN);
    }

    #[test]
    fn test_effective_display_name_stored_wins() {
        let name = effective_display_name(Some("stored"), Some("config"), "host");
        assert_eq!(name, "stored");
    }

    #[test]
    fn test_effective_display_name_config_fallback() {
        let name = effective_display_name(None, Some("config"), "host");
        assert_eq!(name, "config");
    }

    #[test]
    fn test_effective_display_name_hostname_fallback() {
        let name = effective_display_name(None, None, "host");
        assert_eq!(name, "host");
    }

    #[test]
    fn test_effective_display_name_empty_stored_falls_back() {
        let name = effective_display_name(Some(""), Some("config"), "host");
        assert_eq!(name, "config");
    }
}
