//! Shared helpers for the multi-address agent model.
//!
//! Both the agent (when assembling its advertised endpoints) and the server
//! (when accepting a registration or synthesising a legacy list) need the same
//! rules for normalising, de-duplicating, ordering, and capping addresses.

use crate::protocol::{AgentAddress, NetworkType};

/// Maximum number of advertised addresses per agent. Beyond this we drop the
/// lowest-priority entries to keep payloads and probe fan-out bounded.
pub const MAX_ADDRESSES: usize = 10;

/// Normalise a WebSocket URL for equality comparison during de-duplication.
///
/// Lower-cases the scheme+host, trims a trailing slash, and collapses the
/// well-known default port so `ws://host:80/ws` and `ws://host/ws` compare
/// equal. This is a best-effort textual normalisation, not a full URL parse.
#[must_use]
pub fn normalize_url(url: &str) -> String {
    let trimmed = url.trim();
    // Split off scheme so we only lower-case the scheme + authority, never a
    // case-sensitive path/query.
    let (scheme, rest) = match trimmed.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => (String::new(), trimmed),
    };

    // Separate authority from path.
    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, ""),
    };

    let mut authority = authority.to_ascii_lowercase();
    // Drop default ports so they don't defeat de-duplication.
    let default_port = match scheme.as_str() {
        "ws" | "http" => Some(":80"),
        "wss" | "https" => Some(":443"),
        _ => None,
    };
    if let Some(dp) = default_port {
        if let Some(stripped) = authority.strip_suffix(dp) {
            authority = stripped.to_string();
        }
    }

    let path = path.trim_end_matches('/');

    if scheme.is_empty() {
        format!("{authority}{path}")
    } else {
        format!("{scheme}://{authority}{path}")
    }
}

/// Fill in a default priority for any address left at the zero sentinel, then
/// de-duplicate by normalised URL (first occurrence wins), sort by priority
/// (ascending — lowest connects first), and cap to [`MAX_ADDRESSES`].
///
/// Returns the finalised list and the number of entries dropped by the cap so
/// callers can log a warning.
#[must_use]
pub fn finalize_addresses(mut addresses: Vec<AgentAddress>) -> (Vec<AgentAddress>, usize) {
    for addr in &mut addresses {
        if addr.priority == 0 {
            addr.priority = addr.network_type.default_priority();
        }
    }

    let mut seen = std::collections::HashSet::new();
    let mut deduped: Vec<AgentAddress> = Vec::with_capacity(addresses.len());
    for addr in addresses {
        if seen.insert(normalize_url(&addr.url)) {
            deduped.push(addr);
        }
    }

    // Stable sort keeps the original relative order for equal priorities.
    deduped.sort_by_key(|a| a.priority);

    let dropped = deduped.len().saturating_sub(MAX_ADDRESSES);
    deduped.truncate(MAX_ADDRESSES);
    (deduped, dropped)
}

/// Build a single-entry address list from the legacy `ip_address`/`port`/
/// `connect_url` fields, for agents that predate the `addresses` field.
///
/// Prefers `connect_url` (an explicit public endpoint, treated as a tunnel);
/// otherwise constructs `ws://{ip}:{port}/ws` and labels it LAN. Returns an
/// empty list only when there is genuinely nothing to advertise.
#[must_use]
pub fn legacy_to_addresses(
    ip_address: &str,
    port: u16,
    connect_url: Option<&str>,
) -> Vec<AgentAddress> {
    let mut out = Vec::new();
    if let Some(url) = connect_url {
        if !url.trim().is_empty() {
            out.push(AgentAddress {
                url: url.to_string(),
                label: Some("Tunnel".to_string()),
                network_type: NetworkType::Tunnel,
                priority: NetworkType::Tunnel.default_priority(),
            });
        }
    }
    if !ip_address.trim().is_empty() && port != 0 {
        out.push(AgentAddress {
            url: format!("ws://{ip_address}:{port}/ws"),
            label: Some("Direct".to_string()),
            network_type: NetworkType::Lan,
            priority: NetworkType::Lan.default_priority(),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(url: &str, nt: NetworkType, priority: i32) -> AgentAddress {
        AgentAddress {
            url: url.to_string(),
            label: None,
            network_type: nt,
            priority,
        }
    }

    #[test]
    fn normalize_collapses_default_ports_and_trailing_slash() {
        assert_eq!(
            normalize_url("ws://Host:80/ws/"),
            normalize_url("ws://host/ws")
        );
        assert_eq!(normalize_url("wss://H:443/ws"), normalize_url("wss://h/ws"));
        assert_ne!(
            normalize_url("ws://host:8080/ws"),
            normalize_url("ws://host/ws")
        );
    }

    #[test]
    fn finalize_dedups_by_normalized_url() {
        let (out, dropped) = finalize_addresses(vec![
            addr("ws://host:80/ws", NetworkType::Lan, 10),
            addr("ws://HOST/ws/", NetworkType::Vpn, 20),
        ]);
        assert_eq!(out.len(), 1);
        assert_eq!(dropped, 0);
        // First occurrence wins.
        assert_eq!(out.first().unwrap().network_type, NetworkType::Lan);
    }

    #[test]
    fn finalize_assigns_default_priority_then_sorts() {
        let (out, _) = finalize_addresses(vec![
            addr("wss://tunnel/ws", NetworkType::Tunnel, 0),
            addr("ws://192.168.1.5:8080/ws", NetworkType::Lan, 0),
        ]);
        // LAN default priority (10) sorts before Tunnel (30).
        assert_eq!(out.first().unwrap().network_type, NetworkType::Lan);
        assert_eq!(out.first().unwrap().priority, 10);
        assert_eq!(out.get(1).unwrap().priority, 30);
    }

    #[test]
    fn finalize_caps_at_max_and_reports_dropped() {
        let many: Vec<AgentAddress> = (0..MAX_ADDRESSES + 3)
            .map(|i| {
                let priority = i32::try_from(i).unwrap() + 1;
                addr(&format!("ws://h{i}:9/ws"), NetworkType::Custom, priority)
            })
            .collect();
        let (out, dropped) = finalize_addresses(many);
        assert_eq!(out.len(), MAX_ADDRESSES);
        assert_eq!(dropped, 3);
    }

    #[test]
    fn legacy_prefers_connect_url_then_constructs_direct() {
        let out = legacy_to_addresses("10.0.0.5", 8080, Some("wss://a.example.com/ws"));
        assert_eq!(out.len(), 2);
        assert_eq!(out.first().unwrap().network_type, NetworkType::Tunnel);
        assert_eq!(out.get(1).unwrap().url, "ws://10.0.0.5:8080/ws");
    }

    #[test]
    fn legacy_empty_when_nothing_to_advertise() {
        assert!(legacy_to_addresses("", 0, None).is_empty());
        assert!(legacy_to_addresses("", 0, Some("  ")).is_empty());
    }
}
