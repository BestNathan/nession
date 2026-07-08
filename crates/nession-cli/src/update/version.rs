//! SemVer parsing and comparison.

use semver::Version;

#[derive(Debug, PartialEq, Eq)]
pub enum VersionStatus {
    UpToDate,
    UpdateAvailable { current: Version, latest: Version },
    DevelopmentVersion { current: String, latest: Version },
}

pub fn parse_semver(raw: &str) -> Option<Version> {
    let stripped = raw.strip_prefix('v').unwrap_or(raw);
    Version::parse(stripped).ok()
}

pub fn compare_versions(current_raw: &str, latest: &Version) -> VersionStatus {
    match parse_semver(current_raw) {
        Some(current) if current == *latest => VersionStatus::UpToDate,
        Some(current) if current < *latest => VersionStatus::UpdateAvailable {
            current,
            latest: latest.clone(),
        },
        Some(_current) => VersionStatus::DevelopmentVersion {
            current: current_raw.to_string(),
            latest: latest.clone(),
        },
        None => VersionStatus::DevelopmentVersion {
            current: current_raw.to_string(),
            latest: latest.clone(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_with_v_prefix() {
        let v = parse_semver("v0.5.0").unwrap();
        assert_eq!(v.major, 0);
        assert_eq!(v.minor, 5);
        assert_eq!(v.patch, 0);
    }

    #[test]
    fn parse_without_v_prefix() {
        let v = parse_semver("1.2.3").unwrap();
        assert_eq!(v.to_string(), "1.2.3");
    }

    #[test]
    fn parse_dev_version_returns_none() {
        // "0.4.0-dev" is valid semver (pre-release tag).
        // It should parse successfully, not return None.
        let v = parse_semver("0.4.0-dev");
        assert!(v.is_some());
    }

    #[test]
    fn parse_prerelease_is_valid_semver() {
        let v = parse_semver("v1.0.0-beta.1").unwrap();
        assert!(v.pre.as_str() == "beta.1");
    }

    #[test]
    fn compare_up_to_date() {
        let latest = Version::new(0, 4, 2);
        let status = compare_versions("0.4.2", &latest);
        assert_eq!(status, VersionStatus::UpToDate);
    }

    #[test]
    fn compare_update_available() {
        let latest = Version::new(0, 5, 0);
        let status = compare_versions("0.4.2", &latest);
        assert!(matches!(status, VersionStatus::UpdateAvailable { .. }));
    }

    #[test]
    fn compare_development_version() {
        let latest = Version::new(0, 4, 2);
        let status = compare_versions("0.5.0", &latest);
        assert!(matches!(status, VersionStatus::DevelopmentVersion { .. }));
    }

    #[test]
    fn compare_dev_string_treated_as_dev() {
        let latest = Version::new(0, 4, 2);
        // "0.5.0-dev" parses as 0.5.0 with pre-release "dev", which is > 0.4.2,
        // so it should return DevelopmentVersion.
        let status = compare_versions("0.5.0-dev", &latest);
        assert!(matches!(status, VersionStatus::DevelopmentVersion { .. }));
    }

    #[test]
    fn parse_v_prefix_prerelease() {
        let v = parse_semver("v0.5.0-rc.1").unwrap();
        assert_eq!(v.major, 0);
        assert_eq!(v.minor, 5);
        assert_eq!(v.patch, 0);
        assert_eq!(v.pre.as_str(), "rc.1");
    }

    #[test]
    fn parse_unknown_marker_returns_none() {
        assert!(parse_semver("unknown").is_none());
    }
}
