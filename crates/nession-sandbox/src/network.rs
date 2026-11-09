//! Target-oriented network rules.
//!
//! The rule language is the shared contract: exact host or IP with an optional
//! port, leading `*.` wildcards that match strict subdomains only, and deny
//! precedence. The proxy resolves a hostname once, validates every effective
//! address, and connects to the validated address — so the rules cannot be
//! defeated by a second resolution between check and connect.
//!
//! Host-local, private, link-local and metadata addresses are always refused
//! in V1 (`private_network: deny` has no re-permitting value). An allow rule
//! naming such an address is therefore a policy that denies it at connect
//! time, not an escalation path.

use std::net::{IpAddr, Ipv4Addr};

use crate::error::{Result, SandboxError};

/// One host in an egress rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuleHost {
    /// A DNS name. `wildcard` is the leading `*.` form and matches
    /// subdomains, never the base domain itself.
    Domain { name: String, wildcard: bool },
    /// An IPv4/IPv6 literal.
    Ip(IpAddr),
}

/// One parsed egress rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkRule {
    pub host: RuleHost,
    /// `None` matches every port.
    pub port: Option<u16>,
}

impl NetworkRule {
    fn matches_domain(&self, domain: &str) -> bool {
        match &self.host {
            RuleHost::Domain {
                name,
                wildcard: false,
            } => name == domain,
            RuleHost::Domain {
                name,
                wildcard: true,
            } => domain
                .strip_suffix(name.as_str())
                .is_some_and(|prefix| prefix.ends_with('.') && prefix.len() > 1),
            RuleHost::Ip(_) => false,
        }
    }

    fn matches_ip(&self, ip: IpAddr) -> bool {
        matches!(&self.host, RuleHost::Ip(rule_ip) if *rule_ip == ip)
    }

    fn matches_port(&self, port: u16) -> bool {
        self.port.is_none_or(|rule_port| rule_port == port)
    }
}

/// The parsed allow/deny sets of `network.egress`.
#[derive(Debug, Clone, Default)]
pub struct EgressRules {
    pub allow: Vec<NetworkRule>,
    pub deny: Vec<NetworkRule>,
}

/// Why a destination was refused. The reason is recorded as evidence; it is
/// not a message the sandboxed client can use to probe the policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EgressDenial {
    /// No allow rule matched the target.
    NotAllowed,
    /// A deny rule matched the target.
    DeniedByRule,
    /// The effective address is loopback/private/link-local/metadata.
    PrivateAddress,
    /// The target could not be resolved at all.
    Unresolvable,
}

impl std::fmt::Display for EgressDenial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let text = match self {
            Self::NotAllowed => "destination is not in the allow list",
            Self::DeniedByRule => "destination is in the deny list",
            Self::PrivateAddress => "destination resolves to a private or host-local address",
            Self::Unresolvable => "destination did not resolve",
        };
        f.write_str(text)
    }
}

impl EgressRules {
    /// Parse the contract's string rules. Called by policy compilation, so a
    /// malformed rule fails before any host resource exists.
    pub fn parse(allow: &[String], deny: &[String]) -> Result<Self> {
        Ok(Self {
            allow: allow
                .iter()
                .map(|rule| parse_rule(rule))
                .collect::<Result<Vec<_>>>()?,
            deny: deny
                .iter()
                .map(|rule| parse_rule(rule))
                .collect::<Result<Vec<_>>>()?,
        })
    }

    /// Decide whether a *name* (SOCKS5 DOMAINNAME target) may be resolved and
    /// contacted on `port`.
    ///
    /// The allow decision is about the name; the caller still has to validate
    /// every address the name resolves to with [`authorize_ip`].
    pub fn authorize_host(&self, host: &str, port: u16) -> std::result::Result<(), EgressDenial> {
        let domain = normalize_domain(host).ok_or(EgressDenial::NotAllowed)?;
        if self
            .deny
            .iter()
            .any(|rule| rule.matches_domain(&domain) && rule.matches_port(port))
        {
            return Err(EgressDenial::DeniedByRule);
        }
        if self
            .allow
            .iter()
            .any(|rule| rule.matches_domain(&domain) && rule.matches_port(port))
        {
            Ok(())
        } else {
            Err(EgressDenial::NotAllowed)
        }
    }

    /// Decide whether one *effective address* may be connected to.
    ///
    /// Deny rules win, the address must be explicitly allowed as an IP
    /// literal, and private/host-local addresses are refused unconditionally.
    pub fn authorize_ip(&self, ip: IpAddr, port: u16) -> std::result::Result<(), EgressDenial> {
        if is_forbidden_address(ip) {
            return Err(EgressDenial::PrivateAddress);
        }
        if self
            .deny
            .iter()
            .any(|rule| rule.matches_ip(ip) && rule.matches_port(port))
        {
            return Err(EgressDenial::DeniedByRule);
        }
        if self
            .allow
            .iter()
            .any(|rule| rule.matches_ip(ip) && rule.matches_port(port))
        {
            return Ok(());
        }
        // A name allow rule authorizes an address only through
        // `authorize_host` for that name; an IP literal cannot borrow it.
        Err(EgressDenial::NotAllowed)
    }
}

/// Parse one rule string.
pub fn parse_rule(raw: &str) -> Result<NetworkRule> {
    let rule = raw.trim();
    if rule.is_empty() {
        return Err(invalid("an egress rule is empty"));
    }
    if rule.contains('/') || rule.contains("://") || rule.contains('@') {
        return Err(invalid(&format!(
            "egress rule `{raw}` must be a host or IP with an optional port, not a URL"
        )));
    }

    let (host_part, port) = split_host_port(rule)?;
    let host = parse_host(host_part)?;
    Ok(NetworkRule { host, port })
}

fn split_host_port(rule: &str) -> Result<(&str, Option<u16>)> {
    if let Some(rest) = rule.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(invalid(&format!("egress rule `{rule}` has no closing `]`")));
        };
        let host = &rest[..end];
        let after = &rest[end + 1..];
        let port = match after.strip_prefix(':') {
            Some(port) => Some(parse_port(port, rule)?),
            None if after.is_empty() => None,
            None => {
                return Err(invalid(&format!(
                    "egress rule `{rule}` has trailing characters after `]`"
                )));
            }
        };
        return Ok((host, port));
    }

    // A bare IPv6 literal contains several colons; without brackets there is
    // no unambiguous port, so the whole string is the address.
    let colon_count = rule.bytes().filter(|byte| *byte == b':').count();
    if colon_count > 1 {
        return Ok((rule, None));
    }
    match rule.rsplit_once(':') {
        Some((host, port)) => Ok((host, Some(parse_port(port, rule)?))),
        None => Ok((rule, None)),
    }
}

fn parse_port(port: &str, rule: &str) -> Result<u16> {
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(invalid(&format!(
            "egress rule `{rule}` has a non-numeric port"
        )));
    }
    let port: u16 = port
        .parse()
        .map_err(|_| invalid(&format!("egress rule `{rule}` port is out of range")))?;
    if port == 0 {
        return Err(invalid(&format!("egress rule `{rule}` uses port 0")));
    }
    Ok(port)
}

fn parse_host(host: &str) -> Result<RuleHost> {
    if host.is_empty() {
        return Err(invalid("an egress rule names no host"));
    }
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Ok(RuleHost::Ip(ip));
    }
    if host
        .bytes()
        .all(|byte| byte.is_ascii_digit() || byte == b'.')
    {
        return Err(invalid(&format!(
            "egress rule host `{host}` looks like an IP address but does not parse as one"
        )));
    }

    let (wildcard, domain) = match host.strip_prefix("*.") {
        Some(rest) => (true, rest),
        None => (false, host),
    };
    if domain.contains('*') {
        return Err(invalid(&format!(
            "egress rule host `{host}` may only use a leading `*.` wildcard"
        )));
    }
    let domain = normalize_domain(domain).ok_or_else(|| {
        invalid(&format!(
            "egress rule host `{host}` is not a valid DNS name"
        ))
    })?;
    if wildcard && !domain.contains('.') {
        return Err(invalid(&format!(
            "egress rule host `{host}` needs a base domain under the wildcard"
        )));
    }
    Ok(RuleHost::Domain {
        name: domain,
        wildcard,
    })
}

/// Lower-case a DNS name and reject anything that is not a plausible host
/// name. A single trailing dot (the FQDN spelling) is accepted and removed.
pub fn normalize_domain(raw: &str) -> Option<String> {
    let trimmed = raw.strip_suffix('.').unwrap_or(raw);
    if trimmed.is_empty() || trimmed.len() > 253 {
        return None;
    }
    let mut out = String::with_capacity(trimmed.len());
    for label in trimmed.split('.') {
        if label.is_empty() || label.len() > 63 {
            return None;
        }
        if label.starts_with('-') || label.ends_with('-') {
            return None;
        }
        if !label
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
        {
            return None;
        }
        if !out.is_empty() {
            out.push('.');
        }
        out.push_str(&label.to_ascii_lowercase());
    }
    Some(out)
}

/// Addresses V1 never allows, regardless of the allow list.
pub fn is_forbidden_address(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_forbidden_v4(v4),
        IpAddr::V6(v6) => {
            if v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
                || matches!(v6.segments(), [0x2001, 0x0db8, ..])
            {
                return true;
            }
            // IPv4-mapped addresses must answer the IPv4 question, otherwise
            // `::ffff:127.0.0.1` would be a loopback bypass.
            match v6.to_ipv4_mapped() {
                Some(v4) => is_forbidden_v4(v4),
                None => false,
            }
        }
    }
}

fn is_forbidden_v4(v4: Ipv4Addr) -> bool {
    let octets = v4.octets();
    v4.is_loopback()
        || v4.is_private()
        || v4.is_link_local()
        || v4.is_multicast()
        || v4.is_unspecified()
        || v4.is_broadcast()
        || v4.is_documentation()
        // 100.64.0.0/10 — carrier-grade NAT, not covered by `is_private`.
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
}

fn invalid(message: &str) -> SandboxError {
    SandboxError::InvalidPolicy(message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(allow: &[&str], deny: &[&str]) -> EgressRules {
        EgressRules::parse(
            &allow.iter().map(ToString::to_string).collect::<Vec<_>>(),
            &deny.iter().map(ToString::to_string).collect::<Vec<_>>(),
        )
        .expect("test rules are valid")
    }

    #[test]
    fn exact_domains_match_only_themselves() {
        let rules = rules(&["api.example.com:443"], &[]);
        assert_eq!(rules.authorize_host("api.example.com", 443), Ok(()));
        assert_eq!(
            rules.authorize_host("api.example.com", 8443),
            Err(EgressDenial::NotAllowed)
        );
        assert_eq!(
            rules.authorize_host("other.example.com", 443),
            Err(EgressDenial::NotAllowed)
        );
    }

    #[test]
    fn wildcards_match_subdomains_never_the_base() {
        let rules = rules(&["*.example.com:443"], &[]);
        assert_eq!(rules.authorize_host("a.example.com", 443), Ok(()));
        assert_eq!(rules.authorize_host("a.b.example.com", 443), Ok(()));
        assert_eq!(
            rules.authorize_host("example.com", 443),
            Err(EgressDenial::NotAllowed)
        );
        assert_eq!(
            rules.authorize_host("badexample.com", 443),
            Err(EgressDenial::NotAllowed)
        );
    }

    #[test]
    fn deny_precedes_allow() {
        let rules = rules(&["*.example.com"], &["secret.example.com"]);
        assert_eq!(
            rules.authorize_host("secret.example.com", 443),
            Err(EgressDenial::DeniedByRule)
        );
        assert_eq!(rules.authorize_host("public.example.com", 443), Ok(()));
    }

    #[test]
    fn ip_literals_need_an_ip_rule() {
        let rules = rules(&["example.com", "10.0.0.7"], &[]);
        assert_eq!(
            rules.authorize_ip("93.184.216.34".parse().unwrap(), 443),
            Err(EgressDenial::NotAllowed)
        );
        assert_eq!(
            rules.authorize_ip("10.0.0.7".parse().unwrap(), 443),
            Err(EgressDenial::PrivateAddress)
        );
    }

    #[test]
    fn host_local_and_metadata_addresses_are_always_refused() {
        let rules = rules(
            &[
                "169.254.169.254:80",
                "127.0.0.1:80",
                "[::1]:80",
                "100.64.1.1",
            ],
            &[],
        );
        for target in [
            "169.254.169.254",
            "127.0.0.1",
            "::1",
            "100.64.1.1",
            "::ffff:127.0.0.1",
        ] {
            let ip: IpAddr = target.parse().unwrap();
            assert_eq!(
                rules.authorize_ip(ip, 80),
                Err(EgressDenial::PrivateAddress),
                "{target} must be refused"
            );
        }
    }

    #[test]
    fn malformed_rules_fail_closed() {
        for rule in [
            "",
            "http://example.com",
            "*.com:0",
            "999.1.1.1",
            "exa mple.com",
            "a.*.example.com",
            "*.",
            "example.com:http",
            "[::1",
            "example.com/",
            "user@example.com",
        ] {
            assert!(
                parse_rule(rule).is_err(),
                "`{rule}` must be rejected, not interpreted"
            );
        }
    }

    #[test]
    fn ipv6_rules_keep_bracketed_ports() {
        let rule = parse_rule("[2001:db8::1]:8443").expect("bracketed IPv6 with port");
        assert_eq!(rule.port, Some(8443));
        assert!(matches!(rule.host, RuleHost::Ip(IpAddr::V6(_))));
        let bare = parse_rule("2001:db8::1").expect("bare IPv6");
        assert_eq!(bare.port, None);
    }

    #[test]
    fn fqdn_and_case_are_normalized() {
        let rules = rules(&["API.Example.COM."], &[]);
        assert_eq!(rules.authorize_host("api.example.com", 443), Ok(()));
        assert_eq!(rules.authorize_host("Api.Example.Com.", 443), Ok(()));
    }
}
