//! Add, update and remove one Claude MCP definition in a local or project
//! scope (#3600).
//!
//! ## The merge preserves what the caller did not send
//!
//! Claude's CLI has no "update" operation: `add-json` refuses an existing name,
//! so an update is a remove followed by an add. Keeping the original entry and
//! merging the requested fields into it is what preserves fields this view
//! does not model (`timeout`, `alwaysLoad`, `oauth`) and the secret values the
//! caller never read back. A failed add rolls the original back.
//!
//! ## Conflict detection is optimistic and non-secret
//!
//! The request may carry the fingerprint the client saw. A mismatch means
//! another writer changed the entry; the answer is `conflict`, never an
//! overwrite. The fingerprint covers the non-secret structure only — see
//! [`super::sanitize::fingerprint`] for why.
//!
//! ## Success is the readback
//!
//! A zero exit from the CLI is not the answer. The mutated scope is re-read and
//! the resulting entry is returned. A running Claude session is not reloaded;
//! `reload_required` states that separately.

use std::collections::BTreeMap;

use serde_json::{json, Map, Value};

use crate::protocol::mcp_mutate::v1::{
    McpDefinitionV1, McpMutateRequestV1, McpMutateResponseV1, McpMutationStateV1, McpMutationV1,
    McpWriteScopeV1,
};
use crate::protocol::mcp_servers::v1::{McpScopeV1, McpTransportV1};
use crate::session_context::SessionContext;

use super::cli::{self, Availability};
use super::config::{self, RawDefinition, Roots};
use super::sanitize;

/// Issue one mutation.
pub async fn mutate(
    context: &dyn SessionContext,
    session_id: &str,
    request: McpMutateRequestV1,
) -> McpMutateResponseV1 {
    mutate_with_cli(context, session_id, request, &cli::NativeCli).await
}

pub(crate) async fn mutate_with_cli(
    context: &dyn SessionContext,
    session_id: &str,
    request: McpMutateRequestV1,
    cli_runner: &dyn cli::McpCli,
) -> McpMutateResponseV1 {
    let scope = request.scope;
    let roots = match config::resolve_roots(context, session_id).await {
        Ok(roots) => roots,
        Err(error) => {
            return McpMutateResponseV1::with_error(
                McpMutationStateV1::Error,
                scope,
                error.message(),
            )
        }
    };

    if scope == McpWriteScopeV1::Project && !request.confirm_project_write {
        return McpMutateResponseV1::with_error(
            McpMutationStateV1::Invalid,
            scope,
            "project_write_unconfirmed",
        );
    }

    let cli = match cli::detect(context, session_id, &roots).await {
        Availability::Available(cli) => cli,
        Availability::Unavailable(reason) => {
            return McpMutateResponseV1::with_error(
                McpMutationStateV1::UnsupportedVersion,
                scope,
                reason,
            )
        }
    };

    let before = config::inventory(&roots);
    if before.managed_exclusive {
        return fail_with(
            McpMutationStateV1::PolicyBlocked,
            scope,
            Some(cli.version_text),
            "enterprise_exclusive",
            &before.servers,
            None,
        );
    }
    if before.sources.iter().any(|source| {
        source.state == crate::protocol::mcp_servers::v1::McpSourceStateV1::Error
            && matches!(source.scope, Some(source_scope) if source_scope == scope.scope() || source_scope == McpScopeV1::Managed)
    }) {
        return fail_with(
            McpMutationStateV1::Error,
            scope,
            Some(cli.version_text),
            "configuration_unreadable",
            &before.servers,
            None,
        );
    }

    let scope_value = scope.scope();
    let name = definition_name(&request);
    let existing = config::definitions_in_scope(&roots, scope_value)
        .into_iter()
        .find(|definition| definition.name == name);
    if name.is_empty() {
        return fail_with(
            McpMutationStateV1::Invalid,
            scope,
            Some(cli.version_text),
            "missing_name",
            &before.servers,
            None,
        );
    }
    let other_effective = before
        .servers
        .iter()
        .find(|entry| entry.effective && entry.name == name && entry.scope != scope_value)
        .map(|entry| entry.scope);

    let new_raw = match request.operation {
        McpMutationV1::Remove => None,
        McpMutationV1::Add | McpMutationV1::Update => {
            let Some(definition) = request.definition.as_ref() else {
                return fail_with(
                    McpMutationStateV1::Invalid,
                    scope,
                    Some(cli.version_text),
                    "missing_definition",
                    &before.servers,
                    other_effective,
                );
            };
            if request
                .name
                .as_deref()
                .is_some_and(|name| name != definition.name)
            {
                return fail_with(
                    McpMutationStateV1::Invalid,
                    scope,
                    Some(cli.version_text),
                    "name_mismatch",
                    &before.servers,
                    other_effective,
                );
            }
            if let Err(error) = validate_definition(definition) {
                return fail_with(
                    McpMutationStateV1::Invalid,
                    scope,
                    Some(cli.version_text),
                    &error,
                    &before.servers,
                    other_effective,
                );
            }
            match merge_definition(existing.as_ref(), definition) {
                Ok(raw) => Some(raw),
                Err(error) => {
                    return fail_with(
                        McpMutationStateV1::Invalid,
                        scope,
                        Some(cli.version_text),
                        &error,
                        &before.servers,
                        other_effective,
                    )
                }
            }
        }
    };

    match request.operation {
        McpMutationV1::Add => {
            if existing.is_some() && !request.confirm_replace {
                return fail_with(
                    McpMutationStateV1::Conflict,
                    scope,
                    Some(cli.version_text),
                    "entry_already_exists",
                    &before.servers,
                    other_effective,
                );
            }
            if other_effective.is_some() && !request.confirm_replace {
                return fail_with(
                    McpMutationStateV1::Conflict,
                    scope,
                    Some(cli.version_text),
                    "same_name_in_another_scope",
                    &before.servers,
                    other_effective,
                );
            }
        }
        McpMutationV1::Update => {
            let Some(existing) = existing.as_ref() else {
                return fail_with(
                    McpMutationStateV1::NotFound,
                    scope,
                    Some(cli.version_text),
                    "entry_not_found",
                    &before.servers,
                    other_effective,
                );
            };
            if let Some(expected) = request.expected_fingerprint.as_deref() {
                if expected != sanitize::fingerprint(&existing.entry) {
                    return fail_with(
                        McpMutationStateV1::Conflict,
                        scope,
                        Some(cli.version_text),
                        "entry_changed_since_read",
                        &before.servers,
                        other_effective,
                    );
                }
            }
            if other_effective.is_some() && !request.confirm_replace {
                return fail_with(
                    McpMutationStateV1::Conflict,
                    scope,
                    Some(cli.version_text),
                    "same_name_in_another_scope",
                    &before.servers,
                    other_effective,
                );
            }
        }
        McpMutationV1::Remove => {
            let Some(existing) = existing.as_ref() else {
                return fail_with(
                    McpMutationStateV1::NotFound,
                    scope,
                    Some(cli.version_text),
                    "entry_not_found",
                    &before.servers,
                    other_effective,
                );
            };
            if let Some(expected) = request.expected_fingerprint.as_deref() {
                if expected != sanitize::fingerprint(&existing.entry) {
                    return fail_with(
                        McpMutationStateV1::Conflict,
                        scope,
                        Some(cli.version_text),
                        "entry_changed_since_read",
                        &before.servers,
                        other_effective,
                    );
                }
            }
        }
    }

    let secrets = request
        .definition
        .as_ref()
        .map(definition_secrets)
        .unwrap_or_default();
    let target = WriteTarget {
        scope,
        name: &name,
        secrets: &secrets,
    };
    let outcome = match request.operation {
        McpMutationV1::Add => {
            let Some(raw) = new_raw.as_ref() else {
                return fail_with(
                    McpMutationStateV1::Invalid,
                    scope,
                    Some(cli.version_text),
                    "missing_definition",
                    &before.servers,
                    other_effective,
                );
            };
            if existing.is_some() {
                // `confirm_replace` on add is a replacement, and `add-json`
                // refuses an existing name, so the old entry is removed first
                // with the same rollback as an update.
                let original = existing.as_ref().map(|definition| definition.entry.clone());
                replace_definition(
                    context, session_id, &roots, &target, raw, original, cli_runner,
                )
                .await
            } else {
                write_definition(context, session_id, &roots, &target, raw, cli_runner).await
            }
        }
        McpMutationV1::Update => {
            let original = existing.as_ref().map(|definition| definition.entry.clone());
            let Some(raw) = new_raw.as_ref() else {
                return fail_with(
                    McpMutationStateV1::Invalid,
                    scope,
                    Some(cli.version_text),
                    "missing_definition",
                    &before.servers,
                    other_effective,
                );
            };
            replace_definition(
                context, session_id, &roots, &target, raw, original, cli_runner,
            )
            .await
        }
        McpMutationV1::Remove => {
            remove_definition(context, session_id, &roots, &target, cli_runner).await
        }
    };
    if let Err((state, error)) = outcome {
        return fail_with(
            state,
            scope,
            Some(cli.version_text),
            &error,
            &before.servers,
            other_effective,
        );
    }

    // The readback is the answer.
    let after = config::inventory(&roots);
    let scoped: Vec<_> = after
        .servers
        .iter()
        .filter(|entry| entry.scope == scope_value)
        .cloned()
        .collect();
    let entry = after
        .servers
        .iter()
        .find(|entry| entry.name == definition_name(&request) && entry.scope == scope_value)
        .cloned();
    let effective_scope = after
        .servers
        .iter()
        .find(|entry| entry.name == definition_name(&request) && entry.effective)
        .map(|entry| entry.scope);
    McpMutateResponseV1 {
        state: McpMutationStateV1::Ok,
        scope,
        entry,
        servers: scoped,
        effective_scope,
        claude_version: Some(cli.version_text),
        reload_required: true,
        error: None,
    }
}

fn definition_name(request: &McpMutateRequestV1) -> String {
    request
        .name
        .clone()
        .or_else(|| {
            request
                .definition
                .as_ref()
                .map(|definition| definition.name.clone())
        })
        .unwrap_or_default()
}

fn fail_with(
    state: McpMutationStateV1,
    scope: McpWriteScopeV1,
    claude_version: Option<String>,
    error: &str,
    servers: &[crate::protocol::mcp_servers::v1::McpServerEntryV1],
    effective_scope: Option<McpScopeV1>,
) -> McpMutateResponseV1 {
    let mut response = McpMutateResponseV1::with_error(state, scope, error);
    response.claude_version = claude_version;
    response.servers = servers
        .iter()
        .filter(|entry| entry.scope == scope.scope())
        .cloned()
        .collect();
    response.effective_scope = effective_scope;
    response
}

fn scope_flag(scope: McpWriteScopeV1) -> &'static str {
    match scope {
        McpWriteScopeV1::Local => "local",
        McpWriteScopeV1::Project => "project",
    }
}

fn definition_secrets(definition: &McpDefinitionV1) -> Vec<String> {
    definition
        .env
        .iter()
        .chain(definition.headers.iter())
        .filter_map(|pair| pair.value.clone())
        .chain(definition.args.iter().cloned())
        .collect()
}

fn validate_definition(definition: &McpDefinitionV1) -> Result<(), String> {
    if !sanitize::valid_server_name(&definition.name) {
        return Err("invalid_name".to_string());
    }
    let pairs = definition.env.len() + definition.headers.len();
    if pairs > sanitize::MAX_PAIRS {
        return Err(format!(
            "too_many_pairs: at most {pairs_allowed}",
            pairs_allowed = sanitize::MAX_PAIRS
        ));
    }
    for pair in &definition.env {
        if !sanitize::valid_env_name(&pair.name) {
            return Err(format!("invalid_env_name: {}", pair.name));
        }
        if let Some(value) = &pair.value {
            if !sanitize::valid_env_value(value) {
                return Err(format!("invalid_env_value: {}", pair.name));
            }
        }
    }
    for pair in &definition.headers {
        if !sanitize::valid_header_name(&pair.name) {
            return Err(format!("invalid_header_name: {}", pair.name));
        }
        if let Some(value) = &pair.value {
            if !sanitize::valid_header_value(value) {
                return Err(format!("invalid_header_value: {}", pair.name));
            }
        }
    }
    if definition.args.len() > 64 {
        return Err("too_many_args".to_string());
    }
    for argument in &definition.args {
        if argument.contains('\0') || argument.len() > 4096 {
            return Err("invalid_argument".to_string());
        }
    }
    match definition.transport {
        McpTransportV1::Http | McpTransportV1::Sse => {
            if let Some(url) = definition.url.as_deref() {
                if url.len() > sanitize::MAX_URL_BYTES {
                    return Err("url_too_long".to_string());
                }
                let parsed = url::Url::parse(url).map_err(|_| "invalid_url".to_string())?;
                if !matches!(parsed.scheme(), "http" | "https") {
                    return Err("invalid_url_scheme".to_string());
                }
                if parsed.host_str().is_none() {
                    return Err("invalid_url".to_string());
                }
                if !parsed.username().is_empty() || parsed.password().is_some() {
                    return Err("url_userinfo_not_allowed".to_string());
                }
            }
        }
        McpTransportV1::Ws => {
            if let Some(url) = definition.url.as_deref() {
                if url.len() > sanitize::MAX_URL_BYTES {
                    return Err("url_too_long".to_string());
                }
                let parsed = url::Url::parse(url).map_err(|_| "invalid_url".to_string())?;
                if !matches!(parsed.scheme(), "ws" | "wss") {
                    return Err("invalid_url_scheme".to_string());
                }
                if parsed.host_str().is_none() {
                    return Err("invalid_url".to_string());
                }
                if !parsed.username().is_empty() || parsed.password().is_some() {
                    return Err("url_userinfo_not_allowed".to_string());
                }
            }
        }
        McpTransportV1::Stdio => {
            if let Some(command) = definition.command.as_deref() {
                if command.trim().is_empty() || command.len() > sanitize::MAX_COMMAND_BYTES {
                    return Err("invalid_command".to_string());
                }
                if command.contains('\0') {
                    return Err("invalid_command".to_string());
                }
            }
        }
        McpTransportV1::Unknown => return Err("unsupported_transport".to_string()),
    }
    Ok(())
}

fn merged_pairs(
    existing: Option<&Map<String, Value>>,
    pairs: &[crate::protocol::mcp_mutate::v1::McpKeyValueV1],
    replace: bool,
) -> BTreeMap<String, String> {
    let mut merged: BTreeMap<String, String> = if replace {
        BTreeMap::new()
    } else {
        existing
            .map(|existing| {
                existing
                    .iter()
                    .filter_map(|(name, value)| {
                        value
                            .as_str()
                            .map(|value| (name.clone(), value.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    };
    for pair in pairs {
        if let Some(value) = &pair.value {
            merged.insert(pair.name.clone(), value.clone());
        } else if replace {
            continue;
        }
    }
    merged
}

fn merge_definition(
    existing: Option<&RawDefinition>,
    definition: &McpDefinitionV1,
) -> Result<Value, String> {
    let mut raw = match (existing, definition) {
        (Some(existing), _) => existing
            .entry
            .as_object()
            .cloned()
            .ok_or_else(|| "existing_entry_is_not_an_object".to_string())?,
        (None, _) => Map::new(),
    };
    let transport = match definition.transport {
        McpTransportV1::Http => "http",
        McpTransportV1::Sse => "sse",
        McpTransportV1::Ws => "ws",
        McpTransportV1::Stdio => "stdio",
        McpTransportV1::Unknown => return Err("unsupported_transport".to_string()),
    };
    raw.insert("type".to_string(), json!(transport));

    let existing_env = raw.get("env").and_then(Value::as_object).cloned();
    let existing_headers = raw.get("headers").and_then(Value::as_object).cloned();
    match definition.transport {
        McpTransportV1::Http | McpTransportV1::Sse | McpTransportV1::Ws => {
            raw.remove("command");
            raw.remove("args");
            raw.remove("env");
            if let Some(url) = definition.url.as_deref() {
                raw.insert("url".to_string(), json!(url));
            }
            let headers = merged_pairs(
                existing_headers.as_ref(),
                &definition.headers,
                definition.replace_headers || existing.is_none(),
            );
            if headers.is_empty() {
                raw.remove("headers");
            } else {
                raw.insert(
                    "headers".to_string(),
                    Value::Object(
                        headers
                            .into_iter()
                            .map(|(name, value)| (name, Value::String(value)))
                            .collect(),
                    ),
                );
            }
        }
        McpTransportV1::Stdio => {
            raw.remove("url");
            raw.remove("headers");
            if let Some(command) = definition.command.as_deref() {
                raw.insert("command".to_string(), json!(command));
            }
            if definition.replace_args || existing.is_none() {
                raw.insert("args".to_string(), json!(definition.args));
            }
            let env = merged_pairs(
                existing_env.as_ref(),
                &definition.env,
                definition.replace_env || existing.is_none(),
            );
            if env.is_empty() {
                raw.remove("env");
            } else {
                raw.insert(
                    "env".to_string(),
                    Value::Object(
                        env.into_iter()
                            .map(|(name, value)| (name, Value::String(value)))
                            .collect(),
                    ),
                );
            }
        }
        McpTransportV1::Unknown => {}
    }
    let value = Value::Object(raw);
    // The merged result is what Claude will load, so the required fields are
    // checked here: an update that leaves the existing URL/command intact is
    // valid, while an add that supplied neither is not.
    match definition.transport {
        McpTransportV1::Http | McpTransportV1::Sse | McpTransportV1::Ws => {
            let url = value.get("url").and_then(Value::as_str).unwrap_or_default();
            if url.trim().is_empty() {
                return Err("missing_url".to_string());
            }
        }
        McpTransportV1::Stdio => {
            let command = value
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if command.trim().is_empty() {
                return Err("missing_command".to_string());
            }
        }
        McpTransportV1::Unknown => {}
    }
    let size = serde_json::to_string(&value)
        .map(|text| text.len())
        .unwrap_or(0);
    if size > sanitize::MAX_DEFINITION_BYTES {
        return Err("definition_too_large".to_string());
    }
    // The CLI rejects a JSON object whose name is reserved before it writes,
    // but our own vocabulary is the one the form shows; both must agree.
    if !sanitize::valid_server_name(&definition.name) {
        return Err("invalid_name".to_string());
    }
    Ok(value)
}

/// What one write addresses: one name, one scope, and the values to redact
/// from diagnostics. Bundled because the CLI helpers need all three and a
/// seven-argument function is the point where a reader loses track.
struct WriteTarget<'a> {
    scope: McpWriteScopeV1,
    name: &'a str,
    secrets: &'a [String],
}

async fn write_definition(
    context: &dyn SessionContext,
    session_id: &str,
    roots: &Roots,
    target: &WriteTarget<'_>,
    raw: &Value,
    cli_runner: &dyn cli::McpCli,
) -> Result<(), (McpMutationStateV1, String)> {
    let arguments = vec![
        "add-json".to_string(),
        "--scope".to_string(),
        scope_flag(target.scope).to_string(),
        target.name.to_string(),
        serde_json::to_string(raw)
            .map_err(|error| (McpMutationStateV1::Error, format!("encode_failed: {error}")))?,
    ];
    run_cli(
        context,
        session_id,
        roots,
        &arguments,
        target.secrets,
        cli_runner,
    )
    .await
}

async fn remove_definition(
    context: &dyn SessionContext,
    session_id: &str,
    roots: &Roots,
    target: &WriteTarget<'_>,
    cli_runner: &dyn cli::McpCli,
) -> Result<(), (McpMutationStateV1, String)> {
    let arguments = vec![
        "remove".to_string(),
        target.name.to_string(),
        "--scope".to_string(),
        scope_flag(target.scope).to_string(),
    ];
    run_cli(
        context,
        session_id,
        roots,
        &arguments,
        target.secrets,
        cli_runner,
    )
    .await
}

async fn replace_definition(
    context: &dyn SessionContext,
    session_id: &str,
    roots: &Roots,
    target: &WriteTarget<'_>,
    raw: &Value,
    original: Option<Value>,
    cli_runner: &dyn cli::McpCli,
) -> Result<(), (McpMutationStateV1, String)> {
    remove_definition(context, session_id, roots, target, cli_runner).await?;
    if let Err((state, error)) =
        write_definition(context, session_id, roots, target, raw, cli_runner).await
    {
        // Put the original back. A rollback that also fails is reported with
        // both failures rather than leaving the caller believing the entry is
        // intact.
        if let Some(original) = original {
            if let Err((_, rollback)) =
                write_definition(context, session_id, roots, target, &original, cli_runner).await
            {
                return Err((state, format!("{error}; rollback_failed: {rollback}")));
            }
            return Err((state, format!("{error}; original_restored")));
        }
        return Err((state, error));
    }
    Ok(())
}

async fn run_cli(
    context: &dyn SessionContext,
    session_id: &str,
    roots: &Roots,
    arguments: &[String],
    secrets: &[String],
    cli_runner: &dyn cli::McpCli,
) -> Result<(), (McpMutationStateV1, String)> {
    match cli_runner.run(context, session_id, roots, arguments).await {
        Ok(output) if output.success => Ok(()),
        Ok(output) => {
            let message = sanitize::redact_text(
                format!("{}{}", output.stdout, output.stderr).trim(),
                secrets,
            );
            let state = if message.contains("already exists") {
                McpMutationStateV1::Conflict
            } else if message.contains("enterprise MCP configuration")
                || message.contains("enterprise policy")
            {
                McpMutationStateV1::PolicyBlocked
            } else {
                McpMutationStateV1::Error
            };
            Err((
                state,
                if message.is_empty() {
                    "claude_cli_failed".to_string()
                } else {
                    message
                },
            ))
        }
        Err(error) => Err((McpMutationStateV1::Error, error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::mcp_mutate::v1::{McpKeyValueV1, McpMutationV1};
    use crate::session_context::SessionClaudeConfig;
    use async_trait::async_trait;
    use std::fs;
    use tempfile::TempDir;

    fn definition(name: &str, transport: McpTransportV1) -> McpDefinitionV1 {
        McpDefinitionV1 {
            name: name.to_string(),
            transport,
            url: Some("https://example.invalid/mcp".to_string()),
            command: None,
            args: Vec::new(),
            env: Vec::new(),
            headers: Vec::new(),
            replace_env: false,
            replace_headers: false,
            replace_args: false,
        }
    }

    fn request(
        operation: McpMutationV1,
        scope: McpWriteScopeV1,
        definition: Option<McpDefinitionV1>,
    ) -> McpMutateRequestV1 {
        McpMutateRequestV1 {
            session_id: "agent:s".to_string(),
            operation,
            scope,
            name: None,
            definition,
            expected_fingerprint: None,
            confirm_project_write: true,
            confirm_replace: false,
        }
    }

    #[test]
    fn a_remote_definition_rejects_userinfo_and_a_missing_url() {
        let mut remote = definition("remote", McpTransportV1::Http);
        remote.url = Some("https://user:pass@example.invalid/mcp".to_string());
        assert_eq!(
            validate_definition(&remote),
            Err("url_userinfo_not_allowed".to_string())
        );
        remote.url = None;
        assert_eq!(
            merge_definition(None, &remote).map(|_| ()),
            Err("missing_url".to_string())
        );
    }

    #[test]
    fn a_stdio_definition_requires_a_command_and_valid_env_names() {
        let mut stdio = definition("local", McpTransportV1::Stdio);
        stdio.url = None;
        assert_eq!(
            merge_definition(None, &stdio).map(|_| ()),
            Err("missing_command".to_string())
        );
        stdio.command = Some("tool".to_string());
        stdio.env = vec![McpKeyValueV1 {
            name: "BAD-NAME".to_string(),
            value: Some("v".to_string()),
        }];
        assert_eq!(
            validate_definition(&stdio),
            Err("invalid_env_name: BAD-NAME".to_string())
        );
    }

    #[test]
    fn reserved_names_are_rejected_by_the_adapter() {
        let reserved = definition("workspace", McpTransportV1::Http);
        assert_eq!(
            validate_definition(&reserved),
            Err("invalid_name".to_string())
        );
    }

    #[test]
    fn merge_preserves_unmodelled_fields_and_secret_values() {
        let existing = RawDefinition {
            name: "github".to_string(),
            scope: McpScopeV1::Local,
            source: "state".to_string(),
            entry: json!({
                "type": "http",
                "url": "https://old.invalid/mcp",
                "timeout": 600000,
                "headers": {"Authorization": "Bearer old-secret"}
            }),
            approval: crate::protocol::mcp_servers::v1::McpApprovalV1::NotRequired,
        };
        let mut update = definition("github", McpTransportV1::Http);
        update.url = Some("https://new.invalid/mcp".to_string());
        update.headers = vec![McpKeyValueV1 {
            name: "Authorization".to_string(),
            value: None,
        }];
        let merged = merge_definition(Some(&existing), &update).unwrap();
        assert_eq!(merged["url"], "https://new.invalid/mcp");
        assert_eq!(merged["timeout"], 600000);
        assert_eq!(merged["headers"]["Authorization"], "Bearer old-secret");
    }

    #[test]
    fn replace_headers_removes_names_the_caller_did_not_resend() {
        let existing = RawDefinition {
            name: "github".to_string(),
            scope: McpScopeV1::Local,
            source: "state".to_string(),
            entry: json!({
                "type": "http",
                "url": "https://old.invalid/mcp",
                "headers": {"Authorization": "Bearer old", "X-Trace": "on"}
            }),
            approval: crate::protocol::mcp_servers::v1::McpApprovalV1::NotRequired,
        };
        let mut update = definition("github", McpTransportV1::Http);
        update.replace_headers = true;
        update.headers = vec![McpKeyValueV1 {
            name: "X-Trace".to_string(),
            value: Some("off".to_string()),
        }];
        let merged = merge_definition(Some(&existing), &update).unwrap();
        assert_eq!(merged["headers"]["X-Trace"], "off");
        assert!(merged["headers"].get("Authorization").is_none());
    }

    struct FixedContext {
        cwd: String,
        home: String,
        path: String,
    }

    #[async_trait]
    impl SessionContext for FixedContext {
        async fn session_cwd(&self, _session_id: &str) -> Option<String> {
            Some(self.cwd.clone())
        }
        async fn session_claude_config(&self, _session_id: &str) -> Option<SessionClaudeConfig> {
            Some(SessionClaudeConfig {
                home: Some(self.home.clone()),
                ..SessionClaudeConfig::default()
            })
        }
        async fn session_claude_active(&self, _session_id: &str) -> Option<bool> {
            None
        }
        async fn session_claude_binding(
            &self,
            _session_id: &str,
        ) -> Option<crate::binding::Binding> {
            None
        }
        async fn session_environment_variable(
            &self,
            _session_id: &str,
            name: &str,
        ) -> Option<Option<String>> {
            (name == "PATH").then(|| Some(self.path.clone()))
        }
    }

    fn cli_fixture() -> (TempDir, FixedContext, std::path::PathBuf) {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let bin = temp.path().join("bin");
        let cwd = temp.path().join("project");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&bin).unwrap();
        fs::create_dir_all(&cwd).unwrap();
        crate::mcp::test_support::install_executable_fixture(
            &bin,
            "claude",
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 2.1.325; exit 0; fi\nexit 0\n",
        );
        let context = FixedContext {
            cwd: cwd.to_string_lossy().into_owned(),
            home: home.to_string_lossy().into_owned(),
            path: bin.to_string_lossy().into_owned(),
        };
        (temp, context, cwd)
    }

    #[tokio::test]
    async fn project_writes_require_the_shared_file_confirmation() {
        let (_temp, context, _cwd) = cli_fixture();
        let mut request = request(
            McpMutationV1::Add,
            McpWriteScopeV1::Project,
            Some(definition("fixture", McpTransportV1::Http)),
        );
        request.confirm_project_write = false;
        let response = mutate(&context, "agent:s", request).await;
        assert_eq!(response.state, McpMutationStateV1::Invalid);
        assert_eq!(response.error.as_deref(), Some("project_write_unconfirmed"));
    }

    fn local_document(context: &FixedContext) -> serde_json::Value {
        let state_file = std::path::Path::new(&context.home).join(".claude.json");
        serde_json::from_str(&std::fs::read_to_string(state_file).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn add_update_and_remove_are_proven_by_the_readback() {
        let (_temp, context, _cwd) = cli_fixture();
        let cli = crate::mcp::test_support::FileCli::new();

        let add = mutate_with_cli(
            &context,
            "agent:s",
            request(
                McpMutationV1::Add,
                McpWriteScopeV1::Local,
                Some(definition("github", McpTransportV1::Http)),
            ),
            &cli,
        )
        .await;
        assert_eq!(add.state, McpMutationStateV1::Ok, "{add:?}");
        assert!(cli
            .recorded()
            .await
            .iter()
            .any(|arguments| arguments.first().map(String::as_str) == Some("add-json")));
        assert_eq!(
            add.entry.as_ref().unwrap().url.as_deref(),
            Some("https://example.invalid/mcp")
        );
        assert!(add.reload_required);

        let mut update = definition("github", McpTransportV1::Http);
        update.url = Some("https://updated.invalid/mcp".to_string());
        let updated = mutate_with_cli(
            &context,
            "agent:s",
            request(McpMutationV1::Update, McpWriteScopeV1::Local, Some(update)),
            &cli,
        )
        .await;
        assert_eq!(updated.state, McpMutationStateV1::Ok, "{updated:?}");
        assert_eq!(
            updated.entry.as_ref().unwrap().url.as_deref(),
            Some("https://updated.invalid/mcp")
        );
        let document = local_document(&context);
        assert!(
            document["projects"].is_object(),
            "the local scope survives the update: {document}"
        );

        let removed = mutate_with_cli(
            &context,
            "agent:s",
            {
                let mut request = request(McpMutationV1::Remove, McpWriteScopeV1::Local, None);
                request.name = Some("github".to_string());
                request
            },
            &cli,
        )
        .await;
        assert_eq!(removed.state, McpMutationStateV1::Ok, "{removed:?}");
        assert!(removed.entry.is_none());
        assert!(removed.servers.is_empty());
    }

    #[tokio::test]
    async fn a_same_name_conflict_needs_an_explicit_replacement() {
        let (_temp, context, _cwd) = cli_fixture();
        let cli = crate::mcp::test_support::FileCli::new();
        let _ = mutate_with_cli(
            &context,
            "agent:s",
            request(
                McpMutationV1::Add,
                McpWriteScopeV1::Local,
                Some(definition("github", McpTransportV1::Http)),
            ),
            &cli,
        )
        .await;

        let conflict = mutate_with_cli(
            &context,
            "agent:s",
            request(
                McpMutationV1::Add,
                McpWriteScopeV1::Local,
                Some(definition("github", McpTransportV1::Http)),
            ),
            &cli,
        )
        .await;
        assert_eq!(conflict.state, McpMutationStateV1::Conflict, "{conflict:?}");

        let mut replace = request(
            McpMutationV1::Add,
            McpWriteScopeV1::Local,
            Some(definition("github", McpTransportV1::Http)),
        );
        replace.confirm_replace = true;
        let replaced = mutate_with_cli(&context, "agent:s", replace, &cli).await;
        assert_eq!(replaced.state, McpMutationStateV1::Ok, "{replaced:?}");
    }

    #[tokio::test]
    async fn an_external_change_is_a_conflict_not_an_overwrite() {
        let (_temp, context, _cwd) = cli_fixture();
        let cli = crate::mcp::test_support::FileCli::new();
        let _ = mutate_with_cli(
            &context,
            "agent:s",
            request(
                McpMutationV1::Add,
                McpWriteScopeV1::Local,
                Some(definition("github", McpTransportV1::Http)),
            ),
            &cli,
        )
        .await;

        let mut update = request(
            McpMutationV1::Update,
            McpWriteScopeV1::Local,
            Some(definition("github", McpTransportV1::Http)),
        );
        update.expected_fingerprint = Some("not-the-current-fingerprint".to_string());
        let response = mutate_with_cli(&context, "agent:s", update, &cli).await;
        assert_eq!(response.state, McpMutationStateV1::Conflict, "{response:?}");
        assert_eq!(response.error.as_deref(), Some("entry_changed_since_read"));
    }

    #[tokio::test]
    async fn a_failed_update_restores_the_original_entry() {
        let (_temp, context, _cwd) = cli_fixture();
        let cli = crate::mcp::test_support::FileCli::new();
        let _ = mutate_with_cli(
            &context,
            "agent:s",
            request(
                McpMutationV1::Add,
                McpWriteScopeV1::Local,
                Some(definition("github", McpTransportV1::Http)),
            ),
            &cli,
        )
        .await;

        let failing = crate::mcp::test_support::FileCli::failing_add();
        let mut update = definition("github", McpTransportV1::Http);
        update.url = Some("https://must-not-stick.invalid/mcp".to_string());
        let response = mutate_with_cli(
            &context,
            "agent:s",
            request(McpMutationV1::Update, McpWriteScopeV1::Local, Some(update)),
            &failing,
        )
        .await;
        assert_eq!(response.state, McpMutationStateV1::Error, "{response:?}");
        assert!(response
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("original_restored"));
        let document = local_document(&context);
        let raw = document["projects"]
            .as_object()
            .and_then(|projects| projects.values().next())
            .and_then(|project| project["mcpServers"]["github"].as_object())
            .expect("the original entry is back");
        assert_eq!(raw["url"], "https://example.invalid/mcp");
    }

    #[tokio::test]
    async fn removing_an_absent_entry_is_not_found() {
        let (_temp, context, _cwd) = cli_fixture();
        let cli = crate::mcp::test_support::FileCli::new();
        let mut request = request(McpMutationV1::Remove, McpWriteScopeV1::Local, None);
        request.name = Some("missing".to_string());
        let response = mutate_with_cli(&context, "agent:s", request, &cli).await;
        assert_eq!(response.state, McpMutationStateV1::NotFound);
    }

    #[tokio::test]
    async fn a_project_add_writes_the_shared_file_and_reads_it_back() {
        let (_temp, context, cwd) = cli_fixture();
        let cli = crate::mcp::test_support::FileCli::new();
        let response = mutate_with_cli(
            &context,
            "agent:s",
            request(
                McpMutationV1::Add,
                McpWriteScopeV1::Project,
                Some(definition("shared", McpTransportV1::Http)),
            ),
            &cli,
        )
        .await;
        assert_eq!(response.state, McpMutationStateV1::Ok, "{response:?}");
        assert_eq!(response.entry.unwrap().scope, McpScopeV1::Project);
        let document: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(cwd.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(document["mcpServers"]["shared"]["type"], "http");
    }

    async fn invalid(
        context: &FixedContext,
        request: McpMutateRequestV1,
        cli: &crate::mcp::test_support::FileCli,
    ) -> McpMutationStateV1 {
        mutate_with_cli(context, "agent:s", request, cli)
            .await
            .state
    }

    #[tokio::test]
    async fn invalid_requests_are_rejected_before_any_write() {
        let (_temp, context, _cwd) = cli_fixture();
        let cli = crate::mcp::test_support::FileCli::new();

        let mut missing_name = request(McpMutationV1::Remove, McpWriteScopeV1::Local, None);
        missing_name.name = None;
        assert_eq!(
            invalid(&context, missing_name, &cli).await,
            McpMutationStateV1::Invalid
        );
        assert_eq!(
            invalid(
                &context,
                request(McpMutationV1::Add, McpWriteScopeV1::Local, None),
                &cli
            )
            .await,
            McpMutationStateV1::Invalid
        );
        let mut mismatch = request(
            McpMutationV1::Add,
            McpWriteScopeV1::Local,
            Some(definition("github", McpTransportV1::Http)),
        );
        mismatch.name = Some("other".to_string());
        assert_eq!(
            invalid(&context, mismatch, &cli).await,
            McpMutationStateV1::Invalid
        );
        assert_eq!(
            invalid(
                &context,
                request(
                    McpMutationV1::Add,
                    McpWriteScopeV1::Local,
                    Some(definition("workspace", McpTransportV1::Http)),
                ),
                &cli
            )
            .await,
            McpMutationStateV1::Invalid
        );
        let mut bad_env = definition("github", McpTransportV1::Stdio);
        bad_env.url = None;
        bad_env.command = Some("tool".to_string());
        bad_env.env = vec![McpKeyValueV1 {
            name: "BAD-NAME".to_string(),
            value: Some("x".to_string()),
        }];
        assert_eq!(
            invalid(
                &context,
                request(McpMutationV1::Add, McpWriteScopeV1::Local, Some(bad_env)),
                &cli
            )
            .await,
            McpMutationStateV1::Invalid
        );
        let mut bad_header = definition("github", McpTransportV1::Http);
        bad_header.headers = vec![McpKeyValueV1 {
            name: "Bad Header".to_string(),
            value: Some("x".to_string()),
        }];
        assert_eq!(
            invalid(
                &context,
                request(McpMutationV1::Add, McpWriteScopeV1::Local, Some(bad_header)),
                &cli
            )
            .await,
            McpMutationStateV1::Invalid
        );
        let mut bad_scheme = definition("github", McpTransportV1::Http);
        bad_scheme.url = Some("ftp://example.invalid/mcp".to_string());
        assert_eq!(
            invalid(
                &context,
                request(McpMutationV1::Add, McpWriteScopeV1::Local, Some(bad_scheme)),
                &cli
            )
            .await,
            McpMutationStateV1::Invalid
        );
        let mut too_large = definition("github", McpTransportV1::Stdio);
        too_large.url = None;
        too_large.command = Some("tool".to_string());
        too_large.args = (0..64)
            .map(|index| format!("{index}:{}", "x".repeat(4096)))
            .collect();
        assert_eq!(
            invalid(
                &context,
                request(McpMutationV1::Add, McpWriteScopeV1::Local, Some(too_large)),
                &cli
            )
            .await,
            McpMutationStateV1::Invalid
        );
    }

    #[tokio::test]
    async fn an_unreadable_target_configuration_is_an_error() {
        let (temp, context, _cwd) = cli_fixture();
        let _ = temp;
        std::fs::write(
            std::path::Path::new(&context.home).join(".claude.json"),
            "{not json",
        )
        .unwrap();
        let cli = crate::mcp::test_support::FileCli::new();
        let response = mutate_with_cli(
            &context,
            "agent:s",
            request(
                McpMutationV1::Add,
                McpWriteScopeV1::Local,
                Some(definition("github", McpTransportV1::Http)),
            ),
            &cli,
        )
        .await;
        assert_eq!(response.state, McpMutationStateV1::Error);
        assert_eq!(response.error.as_deref(), Some("configuration_unreadable"));
    }

    #[tokio::test]
    async fn a_name_in_another_scope_needs_conflict_confirmation() {
        let (temp, context, _cwd) = cli_fixture();
        let state_file = std::path::Path::new(&context.home).join(".claude.json");
        std::fs::write(
            &state_file,
            serde_json::to_string(&serde_json::json!({
                "mcpServers": {"github": {"type": "http", "url": "https://user.invalid/mcp"}}
            }))
            .unwrap(),
        )
        .unwrap();
        let cli = crate::mcp::test_support::FileCli::new();
        let conflict = mutate_with_cli(
            &context,
            "agent:s",
            request(
                McpMutationV1::Add,
                McpWriteScopeV1::Local,
                Some(definition("github", McpTransportV1::Http)),
            ),
            &cli,
        )
        .await;
        assert_eq!(conflict.state, McpMutationStateV1::Conflict);
        assert_eq!(conflict.effective_scope, Some(McpScopeV1::User));

        let mut replace = request(
            McpMutationV1::Add,
            McpWriteScopeV1::Local,
            Some(definition("github", McpTransportV1::Http)),
        );
        replace.confirm_replace = true;
        let replaced = mutate_with_cli(&context, "agent:s", replace, &cli).await;
        assert_eq!(replaced.state, McpMutationStateV1::Ok, "{replaced:?}");
        let _ = temp;
    }

    #[tokio::test]
    async fn updating_an_absent_entry_is_not_found_and_a_failed_add_is_an_error() {
        let (_temp, context, _cwd) = cli_fixture();
        let cli = crate::mcp::test_support::FileCli::new();
        let missing = mutate_with_cli(
            &context,
            "agent:s",
            request(
                McpMutationV1::Update,
                McpWriteScopeV1::Local,
                Some(definition("github", McpTransportV1::Http)),
            ),
            &cli,
        )
        .await;
        assert_eq!(missing.state, McpMutationStateV1::NotFound);
        let failing = crate::mcp::test_support::FileCli::failing_add();
        let failed = mutate_with_cli(
            &context,
            "agent:s",
            request(
                McpMutationV1::Add,
                McpWriteScopeV1::Local,
                Some(definition("github", McpTransportV1::Http)),
            ),
            &failing,
        )
        .await;
        assert_eq!(failed.state, McpMutationStateV1::Error);
        assert!(failed
            .error
            .as_deref()
            .unwrap_or_default()
            .contains("simulated add failure"));
    }

    #[tokio::test]
    async fn an_unobservable_session_context_is_an_error_not_a_default_home() {
        let (_temp, context, _cwd) = cli_fixture();
        struct Unknown;
        #[async_trait]
        impl SessionContext for Unknown {
            async fn session_cwd(&self, _session_id: &str) -> Option<String> {
                None
            }
            async fn session_claude_config(
                &self,
                _session_id: &str,
            ) -> Option<SessionClaudeConfig> {
                None
            }
            async fn session_claude_active(&self, _session_id: &str) -> Option<bool> {
                None
            }
            async fn session_claude_binding(
                &self,
                _session_id: &str,
            ) -> Option<crate::binding::Binding> {
                None
            }
        }
        let response = mutate(
            &Unknown,
            "agent:s",
            request(
                McpMutationV1::Add,
                McpWriteScopeV1::Local,
                Some(definition("fixture", McpTransportV1::Http)),
            ),
        )
        .await;
        assert_eq!(response.state, McpMutationStateV1::Error);
        assert!(response.error.unwrap().contains("unavailable"));
        let _ = context;
    }
}
