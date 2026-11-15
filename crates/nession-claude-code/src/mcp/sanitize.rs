//! Redaction, validation and stable fingerprints for the Claude MCP view
//! (#3600).
//!
//! Everything a protocol response can carry passes through here first. The
//! rule the module exists to make hard to break: **a secret value never leaves
//! this process**. Header/env values are represented by their names, a URL
//! loses its userinfo/query values/fragment, and an argv loses values that
//! follow a credential flag or carry a credential-shaped key.
//!
//! It is deliberately not part of a contract module: these are decisions about
//! what is safe to say, and they are applied to both protocol answers and
//! subprocess diagnostics.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde_json::Value;
use url::Url;

/// Reserved by Claude Code itself; `claude mcp add` refuses them.
const RESERVED_NAMES: &[&str] = &[
    "workspace",
    "claude-in-chrome",
    "computer-use",
    "claude-preview",
    "claude-browser",
];

/// Flags whose next argument is a credential and must not be echoed.
const SECRET_FLAGS: &[&str] = &[
    "--token",
    "--api-key",
    "--apikey",
    "--password",
    "--passwd",
    "--secret",
    "--auth",
    "--authorization",
    "-H",
    "--header",
    "-e",
    "--env",
    "--client-secret",
];

/// Names that make a `key=value` argument a credential.
const SECRET_KEY_FRAGMENTS: &[&str] = &[
    "token",
    "secret",
    "password",
    "passwd",
    "api-key",
    "api_key",
    "apikey",
    "authorization",
    "auth",
    "bearer",
    "credential",
];

/// A per-entry ceiling; larger definitions are refused before any write.
pub const MAX_DEFINITION_BYTES: usize = 32 * 1024;
/// A per-value ceiling for env/header values.
pub const MAX_VALUE_BYTES: usize = 8 * 1024;
/// The number of env/header pairs one definition may carry.
pub const MAX_PAIRS: usize = 64;
/// A URL longer than this is a configuration mistake, not a server.
pub const MAX_URL_BYTES: usize = 2048;
/// The command path ceiling.
pub const MAX_COMMAND_BYTES: usize = 1024;
/// The largest argv echoed in a sanitised listing.
pub const MAX_SANITIZED_ARGS: usize = 32;

/// Whether a server name is one `claude mcp add` will accept.
///
/// Claude's CLI accepts letters, digits, hyphens and underscores in a name and
/// refuses its own reserved names. Enforcing both here means a rejected write
/// is a field error on the form rather than a CLI error after the fact.
pub fn valid_server_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return false;
    }
    !RESERVED_NAMES.contains(&name.to_ascii_lowercase().as_str())
}

/// Whether an environment variable name is one a shell can export.
pub fn valid_env_name(name: &str) -> bool {
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return false;
    }
    name.len() <= 128 && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// RFC 7230 token, which is what an HTTP header name may be.
pub fn valid_header_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'!' | b'#'
                        | b'$'
                        | b'%'
                        | b'&'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'.'
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'|'
                        | b'~'
                )
        })
}

/// Whether a value is safe to place in a header map.
///
/// CR/LF would be header injection; NUL is rejected by every layer below.
pub fn valid_header_value(value: &str) -> bool {
    value.len() <= MAX_VALUE_BYTES && !value.contains(['\r', '\n', '\0'])
}

pub fn valid_env_value(value: &str) -> bool {
    value.len() <= MAX_VALUE_BYTES && !value.contains('\0')
}

/// A URL as the view may show it.
///
/// Everything that can carry a credential is removed: userinfo is dropped,
/// query **values** become `***` (keys stay, so the shape is legible), and the
/// fragment is dropped. A URL that does not parse is truncated at `?`/`#` and
/// has any `user:pass@` component removed, because showing an unparseable
/// secret is worse than showing an approximate shape.
pub fn sanitize_url(raw: &str) -> String {
    if let Ok(mut url) = Url::parse(raw) {
        let _ = url.set_username("");
        let _ = url.set_password(None);
        if url.query().is_some() {
            let pairs: Vec<String> = url
                .query_pairs()
                .map(|(key, _value)| format!("{key}=***"))
                .collect();
            if pairs.is_empty() {
                url.set_query(None);
            } else {
                url.set_query(Some(&pairs.join("&")));
            }
        }
        url.set_fragment(None);
        return url.to_string();
    }
    let trimmed = raw.split(['?', '#']).next().unwrap_or(raw);
    if let Some(scheme_end) = trimmed.find("://") {
        if let Some(at) = trimmed.rfind('@') {
            if at > scheme_end + 3 {
                return format!("{}://***@{}", &trimmed[..scheme_end], &trimmed[at + 1..]);
            }
        }
    }
    // No scheme: redact a `user:password@`-shaped prefix up to the last `@`
    // since nothing else can tell us where the credential starts.
    if let Some(at) = trimmed.rfind('@') {
        let start = trimmed[..at]
            .rfind(char::is_whitespace)
            .map(|index| index + 1)
            .unwrap_or(0);
        if start < at {
            return format!("{}***{}", &trimmed[..start], &trimmed[at..]);
        }
    }
    trimmed.to_string()
}

/// Whether an argument key names a credential.
fn looks_secret(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    SECRET_KEY_FRAGMENTS
        .iter()
        .any(|fragment| lower.contains(fragment))
}

/// Mask the value half of `KEY=value` / `KEY: value`, keeping the key.
fn redact_pair(argument: &str) -> String {
    let split = argument
        .char_indices()
        .find(|(_, c)| *c == '=' || *c == ':');
    match split {
        Some((index, separator)) => {
            let key = &argument[..index];
            if looks_secret(key) || key.eq_ignore_ascii_case("authorization") {
                format!("{key}{separator} ***")
            } else if argument[index + 1..].starts_with(" Bearer ") {
                format!("{key}{separator} Bearer ***")
            } else {
                argument.to_string()
            }
        }
        None => {
            if argument.starts_with("Bearer ") {
                "Bearer ***".to_string()
            } else {
                argument.to_string()
            }
        }
    }
}

/// One argv element, masked where it can carry a credential.
///
/// `previous` is the preceding flag: a credential flag makes the whole next
/// argument a secret, whatever it looks like.
pub fn redact_argument(previous: Option<&str>, argument: &str) -> String {
    if previous.is_some_and(|flag| {
        SECRET_FLAGS
            .iter()
            .any(|candidate| flag.eq_ignore_ascii_case(candidate))
    }) {
        return match argument
            .char_indices()
            .find(|(_, c)| *c == '=' || *c == ':')
        {
            Some((index, separator)) if index > 0 => {
                format!("{}{} ***", &argument[..index], separator)
            }
            _ => "***".to_string(),
        };
    }
    redact_pair(argument)
}

/// The argv a view may show: bounded, masked, and never the command itself.
pub fn sanitized_args(args: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    let mut previous: Option<String> = None;
    for (index, arg) in args.iter().enumerate() {
        if index >= MAX_SANITIZED_ARGS {
            out.push("…".to_string());
            break;
        }
        let Some(argument) = arg.as_str() else {
            out.push("***".to_string());
            previous = None;
            continue;
        };
        out.push(redact_argument(previous.as_deref(), argument));
        previous = Some(argument.to_string());
    }
    out
}

/// Remove known secrets from a subprocess diagnostic.
///
/// The secrets are values the caller itself put in the request, so this is an
/// exact replacement rather than a heuristic. Short values are ignored: a
/// one-character "secret" is the token `a`, and replacing every `a` would
/// destroy the message without protecting anything.
pub fn redact_text(text: &str, secrets: &[String]) -> String {
    let mut redacted = text.to_string();
    let mut unique: BTreeSet<&str> = BTreeSet::new();
    for secret in secrets {
        if secret.len() >= 4 {
            unique.insert(secret.as_str());
        }
    }
    for secret in unique {
        redacted = redacted.replace(secret, "***");
    }
    let mut out: String = redacted.chars().take(4096).collect();
    if redacted.chars().count() > 4096 {
        out.push('…');
    }
    out
}

/// A stable, non-secret fingerprint of one entry.
///
/// Secret values are excluded on purpose. Including them would make the
/// fingerprint an equality oracle over credentials; excluding them means an
/// external edit that only changes a secret is not detected as a conflict —
/// which is the safe failure, because the merge path preserves values the
/// caller did not supply.
pub fn fingerprint(entry: &Value) -> String {
    let projection = json_projection(entry);
    let serialized = serde_json::to_string(&projection).unwrap_or_default();
    format!("{:016x}", fnv1a(serialized.as_bytes()))
}

fn args_of(entry: &Value) -> Vec<Value> {
    entry
        .get("args")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// The non-secret structure that identifies an entry's behaviour.
fn json_projection(entry: &Value) -> Value {
    let env_names: Vec<String> = object_keys(entry.get("env"));
    let header_names: Vec<String> = object_keys(entry.get("headers"));
    let sanitized = sanitized_args(&args_of(entry));
    serde_json::json!({
        "type": entry.get("type").cloned().unwrap_or(Value::Null),
        "url": entry.get("url").and_then(Value::as_str).map(sanitize_url),
        "command": entry.get("command").cloned().unwrap_or(Value::Null),
        "args": sanitized,
        "env": env_names,
        "headers": header_names,
    })
}

fn object_keys(value: Option<&Value>) -> Vec<String> {
    let mut keys: Vec<String> = value
        .and_then(Value::as_object)
        .map(|map| map.keys().cloned().collect())
        .unwrap_or_default();
    keys.sort();
    keys
}

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// A comparable endpoint key for "same name, different endpoint" detection.
///
/// Implements the equivalence Claude documents: scheme and host case are
/// ignored, a default port is absent, and a trailing slash is irrelevant. Path,
/// query and a non-default port make two servers distinct.
pub fn endpoint_key(entry: &Value) -> String {
    if let Some(raw) = entry.get("url").and_then(Value::as_str) {
        if let Ok(mut url) = Url::parse(raw) {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_fragment(None);
            if url.path() != "/" {
                let trimmed = url.path().trim_end_matches('/').to_string();
                url.set_path(&trimmed);
            }
            return format!("url:{url}");
        }
        return format!("url:{raw}");
    }
    let command = entry
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let args: Vec<String> = args_of(entry)
        .iter()
        .filter_map(|arg| arg.as_str().map(str::to_string))
        .collect();
    format!("command:{command}\u{0}{}", args.join("\u{0}"))
}

/// Names referenced through Claude's `${VAR}` / `${VAR:-default}` expansion.
pub fn referenced_vars(value: &str) -> Vec<String> {
    let mut names = Vec::new();
    let mut rest = value;
    while let Some(start) = rest.find("${") {
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            break;
        };
        let name = after[..end]
            .split(":-")
            .next()
            .unwrap_or_default()
            .trim()
            .to_string();
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
        rest = &after[end + 1..];
    }
    names
}

/// Expand `${VAR}` and `${VAR:-default}` using an observed environment.
///
/// Returns the names that were referenced and not observed (and had no
/// default). Claude keeps the literal reference in that case; for a discovery
/// connection a literal `${VAR}` in a URL or header is nearly always a failure,
/// so the caller reports those names rather than sending a request that cannot
/// succeed.
pub fn expand(value: &str, environment: &HashMap<String, String>) -> Result<String, Vec<String>> {
    let mut missing = Vec::new();
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    loop {
        let Some(start) = rest.find("${") else {
            out.push_str(rest);
            break;
        };
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find('}') else {
            out.push_str(&rest[start..]);
            break;
        };
        let expression = &after[..end];
        let (name, default) = match expression.split_once(":-") {
            Some((name, default)) => (name.trim(), Some(default)),
            None => (expression.trim(), None),
        };
        match environment.get(name) {
            Some(found) => out.push_str(found),
            None => match default {
                Some(default) => out.push_str(default),
                None => {
                    missing.push(name.to_string());
                    out.push_str(&rest[start..start + 2 + end + 1]);
                }
            },
        }
        rest = &after[end + 1..];
    }
    if missing.is_empty() {
        Ok(out)
    } else {
        Err(missing)
    }
}

/// Every literal value the caller supplied, for diagnostic redaction.
pub fn supplied_values(
    url: Option<&str>,
    args: &[String],
    env: &[(String, Option<String>)],
    headers: &[(String, Option<String>)],
) -> Vec<String> {
    let mut secrets = Vec::new();
    if let Some(header_value) = headers.iter().find_map(|(_, value)| value.clone()) {
        secrets.push(header_value);
    }
    for (_, value) in env {
        if let Some(value) = value {
            secrets.push(value.clone());
        }
    }
    secrets.extend(args.iter().cloned());
    if let Some(url) = url {
        if let Ok(parsed) = Url::parse(url) {
            if let Some(password) = parsed.password() {
                secrets.push(password.to_string());
            }
        }
    }
    secrets
}

/// The header/env maps as a name→value lookup, without ever serialising it.
pub fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(key, value)| {
                    value.as_str().map(|value| (key.clone(), value.to_string()))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn server_names_follow_the_cli_grammar_and_its_reservations() {
        assert!(valid_server_name("github"));
        assert!(valid_server_name("my-server_2"));
        assert!(!valid_server_name(""));
        assert!(!valid_server_name("my server"));
        assert!(!valid_server_name("a/b"));
        assert!(!valid_server_name("workspace"));
        assert!(!valid_server_name("Workspace"));
        assert!(!valid_server_name(&"x".repeat(65)));
    }

    #[test]
    fn env_and_header_names_are_the_grammars_their_transports_use() {
        assert!(valid_env_name("API_KEY"));
        assert!(valid_env_name("_private"));
        assert!(!valid_env_name("1API"));
        assert!(!valid_env_name("A-B"));
        assert!(valid_header_name("Authorization"));
        assert!(valid_header_name("X-Api_Key.1"));
        assert!(!valid_header_name("Bad Header"));
        assert!(!valid_header_name(""));
    }

    #[test]
    fn a_url_never_shows_userinfo_query_values_or_a_fragment() {
        let sanitized = sanitize_url("https://user:pass@example.invalid/mcp?token=abc&x=1#frag");
        assert_eq!(sanitized, "https://example.invalid/mcp?token=***&x=***");
        assert!(!sanitized.contains("pass"));
        assert!(!sanitized.contains("abc"));
    }

    #[test]
    fn an_unparseable_url_is_approximated_without_its_credentials() {
        let sanitized = sanitize_url("not a url user:secret@host/path?token=abc");
        assert!(!sanitized.contains("secret"));
        assert!(!sanitized.contains("abc"));
    }

    #[test]
    fn argv_credentials_are_masked_by_flag_and_by_key() {
        assert_eq!(redact_argument(Some("--token"), "abc123"), "***");
        assert_eq!(
            redact_argument(Some("-H"), "Authorization: Bearer abc123"),
            "Authorization: ***"
        );
        assert_eq!(redact_argument(None, "API_KEY=abc123"), "API_KEY= ***");
        assert_eq!(
            redact_argument(None, "--config=/etc/server.json"),
            "--config=/etc/server.json"
        );
        assert_eq!(redact_argument(None, "Bearer abc123"), "Bearer ***");
    }

    #[test]
    fn a_sanitized_arg_list_is_bounded_and_masks_values() {
        let args: Vec<Value> = (0..40)
            .map(|index| json!(format!("--token=value{index}")))
            .collect();
        let sanitized = sanitized_args(&args);
        assert_eq!(sanitized.len(), MAX_SANITIZED_ARGS + 1);
        assert_eq!(sanitized[0], "--token= ***");
        assert_eq!(sanitized.last().unwrap(), "…");
    }

    #[test]
    fn diagnostics_lose_exact_secret_values_but_keep_their_message() {
        let redacted = redact_text(
            "invalid header Authorization: Bearer s3cr3t-value",
            &["s3cr3t-value".to_string()],
        );
        assert_eq!(redacted, "invalid header Authorization: Bearer ***");
    }

    #[test]
    fn fingerprints_are_stable_and_ignore_secret_values() {
        let first = json!({
            "type": "http",
            "url": "https://example.invalid/mcp",
            "headers": {"Authorization": "Bearer one"}
        });
        let second = json!({
            "type": "http",
            "url": "https://example.invalid/mcp",
            "headers": {"Authorization": "Bearer two"}
        });
        assert_eq!(fingerprint(&first), fingerprint(&first));
        assert_eq!(fingerprint(&first), fingerprint(&second));
        let changed = json!({
            "type": "http",
            "url": "https://example.invalid/other",
            "headers": {"Authorization": "Bearer one"}
        });
        assert_ne!(fingerprint(&first), fingerprint(&changed));
    }

    #[test]
    fn endpoint_equivalence_ignores_case_default_ports_and_trailing_slashes() {
        let a = json!({"type": "http", "url": "https://MCP.Example.invalid:443/mcp/"});
        let b = json!({"type": "http", "url": "https://mcp.example.invalid/mcp"});
        assert_eq!(endpoint_key(&a), endpoint_key(&b));
        let c = json!({"type": "http", "url": "https://mcp.example.invalid:8443/mcp"});
        assert_ne!(endpoint_key(&a), endpoint_key(&c));
    }

    #[test]
    fn variable_references_are_found_once_each() {
        assert_eq!(
            referenced_vars("Bearer ${TOKEN} and ${TOKEN} plus ${MISSING:-fallback}"),
            vec!["TOKEN".to_string(), "MISSING".to_string()]
        );
    }

    #[test]
    fn expansion_uses_observed_values_and_reports_absent_names() {
        let mut env = HashMap::new();
        env.insert("TOKEN".to_string(), "abc".to_string());
        assert_eq!(
            expand("Bearer ${TOKEN}", &env),
            Ok("Bearer abc".to_string())
        );
        assert_eq!(
            expand("${MISSING:-fallback}", &env),
            Ok("fallback".to_string())
        );
        assert_eq!(expand("${MISSING}", &env), Err(vec!["MISSING".to_string()]));
    }
}
