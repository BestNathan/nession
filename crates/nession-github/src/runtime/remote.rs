//! Remote URL parsing and the branch-upstream → origin → sole-remote policy.

use nession_git::RepositoryContext;

use crate::protocol::{GithubRemoteChoiceV1, GithubRepositoryRefV1};

/// The hosting identity derived from a Git remote.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubIdentity {
    pub host: String,
    pub owner: String,
    pub repo: String,
}

impl GithubIdentity {
    pub fn source_url(&self) -> String {
        format!("https://{}/{}/{}", self.host, self.owner, self.repo)
    }

    pub fn choice(&self, remote_name: &str) -> GithubRemoteChoiceV1 {
        GithubRemoteChoiceV1 {
            remote_name: remote_name.to_string(),
            host: self.host.clone(),
            owner: self.owner.clone(),
            repo: self.repo.clone(),
        }
    }

    pub fn reference(&self, remote_name: &str) -> GithubRepositoryRefV1 {
        GithubRepositoryRefV1 {
            host: self.host.clone(),
            owner: self.owner.clone(),
            repo: self.repo.clone(),
            remote_name: remote_name.to_string(),
            source_url: self.source_url(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteUrlError {
    Unsupported,
    Malformed,
}

/// Parse the remote forms GitHub itself documents.
///
/// Credential-bearing URLs are **recognized and stripped**: the identity is
/// host/owner/repo, and the credential never reaches a DTO, cache key or log.
/// Unknown schemes, hosts with a path that is not exactly `owner/repo`, and
/// aliases are rejected rather than guessed at.
pub fn parse_remote_url(raw: &str) -> Result<GithubIdentity, RemoteUrlError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.contains(char::is_whitespace) {
        return Err(RemoteUrlError::Malformed);
    }

    // scp-like `user@host:owner/repo.git`. Split before the URL parser: this
    // form is not a URL, and treating it as one is how an alias slips through.
    if !trimmed.contains("://") {
        let Some((authority, path)) = trimmed.split_once(':') else {
            return Err(RemoteUrlError::Unsupported);
        };
        let host = authority.rsplit('@').next().unwrap_or(authority);
        return parse_host_and_path(host, path);
    }

    let url = reqwest::Url::parse(trimmed).map_err(|_| RemoteUrlError::Malformed)?;
    if url.scheme() != "https" && url.scheme() != "ssh" {
        return Err(RemoteUrlError::Unsupported);
    }
    let host = url.host_str().ok_or(RemoteUrlError::Malformed)?;
    let path = url.path().trim_start_matches('/');
    parse_host_and_path(host, path)
}

fn parse_host_and_path(host: &str, path: &str) -> Result<GithubIdentity, RemoteUrlError> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.contains('/') {
        return Err(RemoteUrlError::Malformed);
    }
    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut segments = path.split('/');
    let owner = segments.next().unwrap_or_default();
    let repo = segments.next().unwrap_or_default();
    if owner.is_empty()
        || repo.is_empty()
        || segments.next().is_some()
        || !valid_segment(owner)
        || !valid_segment(repo)
    {
        return Err(RemoteUrlError::Malformed);
    }
    Ok(GithubIdentity {
        host,
        owner: owner.to_string(),
        repo: repo.to_string(),
    })
}

fn valid_segment(segment: &str) -> bool {
    segment != "."
        && segment != ".."
        && segment
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// The remote names and identities discovered for one Session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GithubRemote {
    pub remote_name: String,
    pub identity: GithubIdentity,
}

/// What discovery resolved.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Selection {
    Selected(GithubRemote),
    NoRemote,
    Ambiguous(Vec<GithubRemote>),
    HostNotAllowed(Vec<GithubRemote>),
}

/// Apply the fallback policy:
/// current branch's upstream remote → `origin` → sole remote.
///
/// A requested `remote_name` is re-resolved against the context the Agent just
/// read; a name that no longer resolves is `Ambiguous` with the current choices,
/// so the UI can ask for a new selection rather than silently switching.
pub fn discover(context: &RepositoryContext) -> Vec<GithubRemote> {
    let mut github_remotes: Vec<GithubRemote> = Vec::new();
    for remote in &context.remotes {
        let url = if !remote.fetch_url.is_empty() {
            &remote.fetch_url
        } else {
            &remote.push_url
        };
        if let Ok(identity) = parse_remote_url(url) {
            github_remotes.push(GithubRemote {
                remote_name: remote.name.clone(),
                identity,
            });
        }
    }
    github_remotes
}

pub fn select_remote(context: &RepositoryContext, requested: Option<&str>) -> Selection {
    let github_remotes = discover(context);
    let rejected_hosts = github_remotes
        .iter()
        .any(|remote| remote.identity.host != "github.com");

    if let Some(name) = requested {
        return match github_remotes
            .iter()
            .find(|remote| remote.remote_name == name)
            .cloned()
        {
            Some(remote) if remote.identity.host == "github.com" => Selection::Selected(remote),
            Some(_) => Selection::HostNotAllowed(github_remotes),
            None if github_remotes.is_empty() && !rejected_hosts => Selection::NoRemote,
            None => Selection::Ambiguous(github_remotes),
        };
    }

    if github_remotes.is_empty() {
        return if rejected_hosts {
            Selection::HostNotAllowed(Vec::new())
        } else {
            Selection::NoRemote
        };
    }

    // The upstream's remote name is the longest remote prefix of the upstream
    // ref: remote names may contain `/`, so splitting on the first slash is a
    // guess that would select the wrong remote.
    if let Some(upstream) = &context.upstream {
        let mut candidates: Vec<&GithubRemote> = github_remotes
            .iter()
            .filter(|remote| upstream.starts_with(&format!("{}/", remote.remote_name)))
            .collect();
        candidates.sort_by_key(|remote| std::cmp::Reverse(remote.remote_name.len()));
        if let Some(remote) = candidates.first() {
            if remote.identity.host != "github.com" {
                return Selection::HostNotAllowed(github_remotes);
            }
            return Selection::Selected((*remote).clone());
        }
    }

    if let Some(origin) = github_remotes
        .iter()
        .find(|remote| remote.remote_name == "origin")
    {
        if origin.identity.host != "github.com" {
            return Selection::HostNotAllowed(github_remotes);
        }
        return Selection::Selected(origin.clone());
    }

    let allowed: Vec<GithubRemote> = github_remotes
        .iter()
        .filter(|remote| remote.identity.host == "github.com")
        .cloned()
        .collect();
    match allowed.len() {
        0 => Selection::HostNotAllowed(github_remotes),
        1 => match allowed.into_iter().next() {
            Some(remote) => Selection::Selected(remote),
            None => Selection::HostNotAllowed(github_remotes),
        },
        _ => Selection::Ambiguous(allowed),
    }
}

/// The choices a selection response carries, sorted by remote name for a
/// stable UI.
pub fn choices(remotes: &[GithubRemote]) -> Vec<GithubRemoteChoiceV1> {
    let mut choices: Vec<GithubRemoteChoiceV1> = remotes
        .iter()
        .map(|remote| remote.identity.choice(&remote.remote_name))
        .collect();
    choices.sort_by(|a, b| a.remote_name.cmp(&b.remote_name));
    choices
}

/// The exact PR head identity rule. A fork's head repository must match the
/// selected repository owner/repo, and the head ref must equal the branch;
/// absence or ambiguity is not a match.
pub fn branch_relation(
    selected: &GithubIdentity,
    head_owner: &str,
    head_repo: &str,
    head_ref: &str,
    branch: &str,
) -> bool {
    !head_owner.is_empty()
        && head_owner.eq_ignore_ascii_case(&selected.owner)
        && head_repo.eq_ignore_ascii_case(&selected.repo)
        && head_ref == branch
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo(name: &str, fetch: &str) -> nession_git::GitRemote {
        nession_git::GitRemote {
            name: name.into(),
            fetch_url: fetch.into(),
            push_url: fetch.into(),
        }
    }

    fn repo_context(
        remotes: Vec<nession_git::GitRemote>,
        upstream: Option<&str>,
    ) -> RepositoryContext {
        RepositoryContext {
            root: "/repo".into(),
            branch: Some("feature/x".into()),
            upstream: upstream.map(str::to_string),
            remotes,
        }
    }

    #[test]
    fn parses_https_ssh_scp_and_strips_credentials() {
        for (url, expected) in [
            (
                "https://github.com/acme/repo.git",
                ("github.com", "acme", "repo"),
            ),
            (
                "https://user:token@github.com/acme/repo",
                ("github.com", "acme", "repo"),
            ),
            (
                "git@github.com:acme/repo.git",
                ("github.com", "acme", "repo"),
            ),
            (
                "ssh://git@github.com:22/acme/repo.git",
                ("github.com", "acme", "repo"),
            ),
        ] {
            let identity = parse_remote_url(url).unwrap();
            assert_eq!(
                (
                    identity.host.as_str(),
                    identity.owner.as_str(),
                    identity.repo.as_str()
                ),
                expected,
                "{url}"
            );
        }
    }

    #[test]
    fn rejects_unknown_schemes_aliases_and_non_repo_paths() {
        for url in [
            "http://github.com/acme/repo.git",
            "git://github.com/acme/repo.git",
            "github-work:acme/repo.git",
            "https://github.com/acme",
            "https://github.com/acme/repo/extra",
            "https://github.com/../repo",
            "https://gitlab.com/acme/repo.git",
        ] {
            let parsed = parse_remote_url(url);
            assert!(
                parsed.is_err() || parsed.unwrap().host != "github.com",
                "{url}"
            );
        }
    }

    #[test]
    fn upstream_remote_wins_over_origin() {
        let context = repo_context(
            vec![
                repo("origin", "https://github.com/origin/repo.git"),
                repo("upstream", "https://github.com/upstream/repo.git"),
            ],
            Some("upstream/main"),
        );
        match select_remote(&context, None) {
            Selection::Selected(remote) => assert_eq!(remote.remote_name, "upstream"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn origin_is_the_fallback_and_a_sole_remote_is_unambiguous() {
        let context = repo_context(
            vec![
                repo("fork", "https://github.com/fork/repo.git"),
                repo("origin", "https://github.com/acme/repo.git"),
            ],
            None,
        );
        match select_remote(&context, None) {
            Selection::Selected(remote) => assert_eq!(remote.remote_name, "origin"),
            other => panic!("unexpected {other:?}"),
        }
        let context = repo_context(vec![repo("mine", "https://github.com/acme/repo.git")], None);
        match select_remote(&context, None) {
            Selection::Selected(remote) => assert_eq!(remote.remote_name, "mine"),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn two_github_remotes_without_origin_or_upstream_are_ambiguous() {
        let context = repo_context(
            vec![
                repo("a", "https://github.com/a/repo.git"),
                repo("b", "https://github.com/b/repo.git"),
            ],
            None,
        );
        assert!(matches!(
            select_remote(&context, None),
            Selection::Ambiguous(_)
        ));
    }

    #[test]
    fn requested_remote_is_re_resolved_and_a_stale_one_is_not_silently_replaced() {
        let context = repo_context(
            vec![
                repo("origin", "https://github.com/acme/repo.git"),
                repo("upstream", "https://github.com/up/repo.git"),
            ],
            None,
        );
        match select_remote(&context, Some("upstream")) {
            Selection::Selected(remote) => assert_eq!(remote.remote_name, "upstream"),
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            select_remote(&context, Some("gone")),
            Selection::Ambiguous(_)
        ));
    }

    #[test]
    fn a_no_remote_repository_is_not_an_error() {
        assert_eq!(
            select_remote(&repo_context(Vec::new(), None), None),
            Selection::NoRemote
        );
        let context = repo_context(
            vec![repo("origin", "https://gitlab.com/acme/repo.git")],
            None,
        );
        assert!(matches!(
            select_remote(&context, None),
            Selection::HostNotAllowed(_)
        ));
    }

    #[test]
    fn branch_relation_requires_the_exact_head_repository_and_ref() {
        let selected = GithubIdentity {
            host: "github.com".into(),
            owner: "acme".into(),
            repo: "repo".into(),
        };
        assert!(branch_relation(
            &selected,
            "acme",
            "repo",
            "feature/x",
            "feature/x"
        ));
        assert!(!branch_relation(
            &selected,
            "fork",
            "repo",
            "feature/x",
            "feature/x"
        ));
        assert!(!branch_relation(
            &selected,
            "acme",
            "other",
            "feature/x",
            "feature/x"
        ));
        assert!(!branch_relation(
            &selected,
            "acme",
            "repo",
            "feature/x",
            "feature/y"
        ));
    }
}
