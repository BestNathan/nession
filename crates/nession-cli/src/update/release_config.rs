//! Release-scoped server configuration paths.
//!
//! `config server init` persists the *generated defaults* as absolute paths
//! (`<home>/server/server.db`, `<home>/server/images/{blobs,build}`). When a
//! newer release archives the Current home, those strings keep pointing at the
//! Current root while the state itself moves under `versions/<old>/`. Starting
//! the archived release would then create or read the wrong database (#3232
//! F1).
//!
//! This module owns the distinction the requirement asks for:
//!
//! - a value equal to the generated default under the Current home is a
//!   generated value and moves to the same default under the archived home;
//! - an absolute path outside the Current home is the operator's explicit
//!   external declaration and is left untouched;
//! - a relative, empty, or Current-home path that is *not* one of the generated
//!   defaults cannot be relocated safely. Archiving is refused with an
//!   actionable message instead of silently reading Current data.
//!
//! The inverse (archive → Current) uses the same function with the homes
//! swapped. The transaction normally restores the exact original text from its
//! journal; the inverse keeps the classifier honest for diagnostics.

use anyhow::{bail, Context, Result};
use nession_common::paths;
use std::path::{Path, PathBuf};
use toml_edit::DocumentMut;

/// Which persisted server fields are release-owned durable paths.
type DefaultPath = fn(&Path) -> PathBuf;

const PATH_FIELDS: [(&str, DefaultPath); 3] = [
    ("db_path", paths::server_db_path_under),
    ("image_blob_dir", paths::server_image_blob_dir_under),
    ("image_build_dir", paths::server_image_build_dir_under),
];

/// What the archive rewrite did to one field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldAction {
    /// A generated default was moved to the archived home's default.
    Rewritten,
    /// An explicit external path was kept verbatim.
    Retained,
    /// The value already named the archived home.
    AlreadyScoped,
}

/// The per-field outcome of a successful config rewrite.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RewriteReport {
    pub actions: Vec<(&'static str, FieldAction)>,
}

impl RewriteReport {
    pub fn rewritten(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.actions
            .iter()
            .filter(|(_, action)| *action == FieldAction::Rewritten)
            .map(|(field, _)| *field)
    }

    pub fn retained(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.actions
            .iter()
            .filter(|(_, action)| *action == FieldAction::Retained)
            .map(|(field, _)| *field)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Decision {
    Rewrite,
    External,
    AlreadyScoped,
}

/// Rewrite the release-owned paths in a persisted server config.
///
/// `from_home` is the home whose generated defaults the file may contain;
/// `to_home` is the release home whose defaults replace them. The returned
/// text preserves unrelated keys, comments and formatting.
pub fn rewrite_server_config_for_archive(
    content: &str,
    from_home: &Path,
    to_home: &Path,
) -> Result<(String, RewriteReport)> {
    let mut document: DocumentMut = content
        .parse()
        .context("the persisted server config is not valid TOML; refusing to archive it")?;
    let mut report = RewriteReport::default();

    for (field, default_under) in PATH_FIELDS {
        let Some(item) = document.get(field) else {
            continue;
        };
        let Some(value) = item.as_str() else {
            bail!(
                "server config field `{field}` is not a string path; refusing to archive Current \
                 until it is repaired"
            );
        };
        let from_default = default_under(from_home);
        let to_default = default_under(to_home);
        let decision = classify(value, &from_default, &to_default, from_home, to_home)
            .with_context(|| format!("server config field `{field}` cannot be archived safely"))?;
        match decision {
            Decision::Rewrite => {
                let rendered = to_default.to_string_lossy().into_owned();
                *document
                    .get_mut(field)
                    .expect("the field was read from this document") = toml_edit::value(rendered);
                report.actions.push((field, FieldAction::Rewritten));
            }
            Decision::External => report.actions.push((field, FieldAction::Retained)),
            Decision::AlreadyScoped => report.actions.push((field, FieldAction::AlreadyScoped)),
        }
    }

    Ok((document.to_string(), report))
}

fn classify(
    value: &str,
    from_default: &Path,
    to_default: &Path,
    from_home: &Path,
    to_home: &Path,
) -> Result<Decision> {
    if value.trim().is_empty() {
        bail!("the path is empty");
    }
    let path = Path::new(value);
    if path == to_default || path.starts_with(to_home) {
        return Ok(Decision::AlreadyScoped);
    }
    if path == from_default {
        return Ok(Decision::Rewrite);
    }
    if !path.is_absolute() {
        bail!(
            "the relative path `{value}` cannot be relocated with the release; \
             use an absolute path or leave the generated default"
        );
    }
    if path.starts_with(from_home) {
        bail!(
            "the path `{value}` is inside the Current home but is not a generated default; \
             move it outside {home} or restore the generated default before upgrading",
            home = from_home.display()
        );
    }
    Ok(Decision::External)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn homes() -> (PathBuf, PathBuf) {
        (
            PathBuf::from("/home/operator/.nession"),
            PathBuf::from("/home/operator/.nession/versions/0.35.0"),
        )
    }

    fn generated_config(home: &Path) -> String {
        format!(
            "listen_address = \"127.0.0.1:19090\"\n\
             db_path = \"{}\"\n\
             image_blob_dir = \"{}\"\n\
             image_build_dir = \"{}\"\n\
             auth_token = \"secret\"\n",
            paths::server_db_path_under(home).display(),
            paths::server_image_blob_dir_under(home).display(),
            paths::server_image_build_dir_under(home).display(),
        )
    }

    #[test]
    fn generated_defaults_move_with_the_release() {
        let (current, archive) = homes();
        let (rewritten, report) =
            rewrite_server_config_for_archive(&generated_config(&current), &current, &archive)
                .unwrap();

        assert_eq!(
            report.rewritten().collect::<Vec<_>>(),
            vec!["db_path", "image_blob_dir", "image_build_dir"]
        );
        for field in ["db_path", "image_blob_dir", "image_build_dir"] {
            assert!(
                !rewritten.contains(&format!("= \"{}\"", current.join("server").display())),
                "{field} still points at Current:\n{rewritten}"
            );
        }
        assert!(rewritten.contains(&paths::server_db_path_under(&archive).display().to_string()));
        assert!(rewritten.contains(
            &paths::server_image_blob_dir_under(&archive)
                .display()
                .to_string()
        ));
        assert!(rewritten.contains(
            &paths::server_image_build_dir_under(&archive)
                .display()
                .to_string()
        ));
        assert!(
            rewritten.contains("auth_token = \"secret\""),
            "unrelated keys survive"
        );
    }

    #[test]
    fn explicit_external_paths_are_kept_verbatim() {
        let (current, archive) = homes();
        let config = "db_path = \"/srv/nession/server.db\"\n\
                      image_blob_dir = \"/srv/nession/blobs\"\n\
                      image_build_dir = \"/srv/nession/build\"\n";
        let (rewritten, report) =
            rewrite_server_config_for_archive(config, &current, &archive).unwrap();

        assert_eq!(report.retained().count(), 3);
        assert!(report.rewritten().next().is_none());
        assert!(rewritten.contains("/srv/nession/server.db"));
        assert!(rewritten.contains("/srv/nession/blobs"));
        assert!(rewritten.contains("/srv/nession/build"));
    }

    #[test]
    fn a_custom_path_inside_the_current_home_is_refused() {
        let (current, archive) = homes();
        let config = format!(
            "db_path = \"{}\"\n",
            current.join("server/custom.db").display()
        );
        let error = rewrite_server_config_for_archive(&config, &current, &archive).unwrap_err();
        let message = format!("{error:#}");
        assert!(message.contains("inside the Current home"), "{message}");
    }

    #[test]
    fn relative_and_empty_paths_are_refused() {
        let (current, archive) = homes();
        for value in ["nession.db", "", "~/nession.db"] {
            let config = format!("db_path = \"{value}\"\n");
            let error = rewrite_server_config_for_archive(&config, &current, &archive).unwrap_err();
            assert!(
                format!("{error:#}").contains("cannot be archived safely"),
                "value {value:?} must be refused: {error:#}"
            );
        }
    }

    #[test]
    fn a_non_string_path_is_refused() {
        let (current, archive) = homes();
        let error =
            rewrite_server_config_for_archive("db_path = 42\n", &current, &archive).unwrap_err();
        assert!(format!("{error:#}").contains("not a string path"));
    }

    #[test]
    fn invalid_toml_is_refused_before_archiving() {
        let (current, archive) = homes();
        let error =
            rewrite_server_config_for_archive("db_path = [unterminated\n", &current, &archive)
                .unwrap_err();
        assert!(format!("{error:#}").contains("not valid TOML"));
    }

    #[test]
    fn an_already_archived_value_is_not_rewritten_again() {
        let (current, archive) = homes();
        let config = generated_config(&archive);
        let (rewritten, report) =
            rewrite_server_config_for_archive(&config, &current, &archive).unwrap();
        assert_eq!(report.rewritten().count(), 0);
        assert_eq!(rewritten, config);
    }

    #[test]
    fn a_path_that_merely_shares_a_prefix_is_external() {
        let (current, archive) = homes();
        let sibling = current.with_file_name(".nession-other");
        let config = format!(
            "db_path = \"{}\"\n",
            paths::server_db_path_under(&sibling).display()
        );
        let (_, report) = rewrite_server_config_for_archive(&config, &current, &archive).unwrap();
        assert_eq!(report.retained().count(), 1);
    }
}
