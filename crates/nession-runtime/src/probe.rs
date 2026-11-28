//! The canonical browser reachability probe contract (#4618).
//!
//! One owner for the reserved path, the fixed response marker and the CORS
//! shape that both the Server and the Agent serve on their *existing* HTTP
//! listener. The probe is credential-free and identity-free: a `204` states
//! only that this HTTP path responded — never peer identity, WS upgrade/auth
//! readiness, or Session authority. It allocates no pending-auth slot, touches
//! no database, tmux or business protocol, and carries no body.
//!
//! The browser measures reachability with a `GET` (credentials omitted,
//! `cache: no-store`, `redirect: error`) and validates the marker header so a
//! generic proxy/SPA `204` is never mistaken for a Nession probe. This module
//! owns the response side of that contract; the browser scheduler owns the
//! request side.

use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};

/// Reserved probe path on every Nession HTTP listener. Configured MCP paths
/// must not claim it (see `nession_common::config::McpConfig::validate_for_host`),
/// and the routers mount it ahead of the WebSocket upgrade fallback.
pub const PROBE_PATH: &str = "/probe";

/// Fixed response marker header name. Exposed through CORS so a cross-origin
/// browser `fetch` can read it and distinguish a Nession probe from any other
/// `204` the path might return.
pub const PROBE_MARKER_HEADER: &str = "Nession-Probe";

/// The only marker value this contract version emits.
pub const PROBE_MARKER_VALUE: &str = "v1";

const MARKER_HEADER_NAME: HeaderName = HeaderName::from_static("nession-probe");
const EXPOSE_HEADERS: HeaderName = HeaderName::from_static("access-control-expose-headers");
const ALLOW_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-allow-private-network");
const REQUEST_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-request-private-network");

/// Whether a configured route path would collide with the reserved probe path.
///
/// Trailing slashes are normalised so `/probe/` cannot shadow `/probe` either.
#[must_use]
pub fn is_reserved_probe_path(path: &str) -> bool {
    path.trim_end_matches('/') == PROBE_PATH
}

/// Derive the default probe URL for an advertised WebSocket ingress.
///
/// The probe lives on the *same* HTTP listener and authority as the WS upgrade,
/// at the reserved root path. Only the scheme is mapped (`ws`→`http`,
/// `wss`→`https`); the authority is preserved verbatim and the path is the
/// reserved probe path. A reverse proxy that prefixes the WS path must either
/// forward `/probe` on the same authority or the operator must advertise an
/// explicit `probe_url` — this helper never invents a host or follows a
/// redirect. Returns `None` for a URL with no recognised scheme/authority.
#[must_use]
pub fn default_probe_url(ws_url: &str) -> Option<String> {
    let (scheme, rest) = ws_url.trim().split_once("://")?;
    let http_scheme = match scheme.to_ascii_lowercase().as_str() {
        "ws" | "http" => "http",
        "wss" | "https" => "https",
        _ => return None,
    };
    let authority = rest.split('/').next().unwrap_or(rest);
    if authority.is_empty() {
        return None;
    }
    Some(format!("{http_scheme}://{authority}{PROBE_PATH}"))
}

/// How a listener answers the browser Origin on the probe route.
///
/// The Server echoes an Origin its existing allowlist already approved (the
/// probe handler applies the same `origin_policy_allows` gate as the WS
/// upgrade). The Agent P2P listener has no Origin allowlist — its WS upgrade
/// admits any Origin — so the credential-free probe uses a wildcard. Neither
/// ever sets `Access-Control-Allow-Credentials`: the browser omits credentials
/// by contract, and a credentialed wildcard is forbidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeOriginPolicy {
    /// Echo the request Origin (already approved by the caller's allowlist).
    EchoApproved,
    /// Allow any Origin without credentials (Agent P2P model).
    Any,
}

fn apply_origin(response: &mut Response, headers: &HeaderMap, policy: ProbeOriginPolicy) {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        // A non-browser client (CLI, Agent, native transport) sends no Origin;
        // the marker is still readable without CORS.
        return;
    };
    let h = response.headers_mut();
    match policy {
        ProbeOriginPolicy::Any => {
            h.insert(
                header::ACCESS_CONTROL_ALLOW_ORIGIN,
                HeaderValue::from_static("*"),
            );
        }
        ProbeOriginPolicy::EchoApproved => {
            if let Ok(value) = HeaderValue::from_str(origin) {
                h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
                h.insert(header::VARY, HeaderValue::from_static("Origin"));
            }
        }
    }
}

/// The `204 No Content` probe success response: no body, `no-store`, the fixed
/// marker, and CORS exposure of that marker.
#[must_use]
pub fn probe_success(headers: &HeaderMap, policy: ProbeOriginPolicy) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    {
        let h = response.headers_mut();
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        h.insert(
            MARKER_HEADER_NAME,
            HeaderValue::from_static(PROBE_MARKER_VALUE),
        );
        h.insert(
            EXPOSE_HEADERS,
            HeaderValue::from_static(PROBE_MARKER_HEADER),
        );
    }
    apply_origin(&mut response, headers, policy);
    response
}

/// The OPTIONS preflight response for the probe route.
///
/// A simple credential-free GET needs no preflight, but a public page probing a
/// private-network Agent triggers Chromium's Private Network Access preflight;
/// answering it here (scoped to this credential-free route only) preserves that
/// mechanism rather than bypassing it. The probe grants no authority, so the
/// preflight approves only `GET` and never credentials.
#[must_use]
pub fn probe_preflight(headers: &HeaderMap, policy: ProbeOriginPolicy) -> Response {
    let mut response = StatusCode::NO_CONTENT.into_response();
    {
        let h = response.headers_mut();
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET"),
        );
        h.insert(
            header::ACCESS_CONTROL_MAX_AGE,
            HeaderValue::from_static("600"),
        );
        if headers
            .get(REQUEST_PRIVATE_NETWORK)
            .is_some_and(|v| v.as_bytes() == b"true")
        {
            h.insert(ALLOW_PRIVATE_NETWORK, HeaderValue::from_static("true"));
        }
    }
    apply_origin(&mut response, headers, policy);
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (k, v) in pairs {
            map.insert(
                HeaderName::from_bytes(k.as_bytes()).unwrap(),
                HeaderValue::from_str(v).unwrap(),
            );
        }
        map
    }

    #[test]
    fn success_is_204_no_store_with_marker_and_exposure() {
        let response = probe_success(&HeaderMap::new(), ProbeOriginPolicy::Any);
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        let h = response.headers();
        assert_eq!(h.get(header::CACHE_CONTROL).unwrap(), "no-store");
        assert_eq!(h.get(MARKER_HEADER_NAME).unwrap(), "v1");
        assert_eq!(h.get(EXPOSE_HEADERS).unwrap(), "Nession-Probe");
        // No Origin request → no ACAO, and never credentials.
        assert!(h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
        assert!(h.get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());
    }

    #[test]
    fn any_policy_uses_wildcard_without_credentials() {
        let response = probe_success(
            &headers(&[("origin", "https://app.example.com")]),
            ProbeOriginPolicy::Any,
        );
        let h = response.headers();
        assert_eq!(h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(), "*");
        assert!(h.get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS).is_none());
    }

    #[test]
    fn echo_policy_reflects_approved_origin_and_varies() {
        let response = probe_success(
            &headers(&[("origin", "https://app.example.com")]),
            ProbeOriginPolicy::EchoApproved,
        );
        let h = response.headers();
        assert_eq!(
            h.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
            "https://app.example.com"
        );
        assert_eq!(h.get(header::VARY).unwrap(), "Origin");
    }

    #[test]
    fn preflight_approves_get_and_private_network_only_when_requested() {
        let plain = probe_preflight(&HeaderMap::new(), ProbeOriginPolicy::Any);
        assert_eq!(plain.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            plain
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_METHODS)
                .unwrap(),
            "GET"
        );
        assert!(plain.headers().get(ALLOW_PRIVATE_NETWORK).is_none());

        let pna = probe_preflight(
            &headers(&[("access-control-request-private-network", "true")]),
            ProbeOriginPolicy::Any,
        );
        assert_eq!(pna.headers().get(ALLOW_PRIVATE_NETWORK).unwrap(), "true");
    }

    #[test]
    fn reserved_path_matches_with_and_without_trailing_slash() {
        assert!(is_reserved_probe_path("/probe"));
        assert!(is_reserved_probe_path("/probe/"));
        assert!(!is_reserved_probe_path("/mcp"));
        assert!(!is_reserved_probe_path("/probe/extra"));
        assert!(!is_reserved_probe_path("/ws"));
    }

    #[test]
    fn default_probe_url_maps_scheme_and_keeps_authority() {
        assert_eq!(
            default_probe_url("ws://192.168.1.5:8080/ws").as_deref(),
            Some("http://192.168.1.5:8080/probe")
        );
        assert_eq!(
            default_probe_url("wss://agent.example.com/prefix/ws").as_deref(),
            Some("https://agent.example.com/probe")
        );
        assert_eq!(
            default_probe_url("https://host:443/probe").as_deref(),
            Some("https://host:443/probe")
        );
        assert!(default_probe_url("ftp://host/ws").is_none());
        assert!(default_probe_url("ws:///ws").is_none());
        assert!(default_probe_url("not-a-url").is_none());
    }
}
