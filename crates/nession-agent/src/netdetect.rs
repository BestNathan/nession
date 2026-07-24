//! Local network-interface detection for agent address advertisement.
//!
//! Enumerates the host's non-loopback interfaces and turns each usable IP into
//! an [`AgentAddress`], classifying it as LAN or VPN. This is a one-shot scan
//! at startup (Non-Goal: dynamic refresh — restart the agent to re-detect).

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::config::{AdvertiseAddress, AgentConfig};
use nession_common::address::{finalize_addresses, legacy_to_addresses};
use nession_common::protocol::{AgentAddress, NetworkType};
use tracing::{info, warn};

/// Classify an IP into a coarse [`NetworkType`] for labelling.
///
/// RFC 1918 / CGNAT / unique-local ranges map to LAN; other private-ish overlay
/// ranges (notably the Tailscale 100.64/10 CGNAT block is common for VPNs, but
/// we can't distinguish it reliably from carrier NAT) are treated as LAN too.
/// Anything globally routable is LAN-labelled as well here because we can't
/// know it's public without more context — the caller decides tunnels via
/// config. In practice detected NIC addresses are LAN/VPN; genuine public
/// endpoints come from `advertise_addresses`.
fn classify(ip: IpAddr) -> NetworkType {
    match ip {
        IpAddr::V4(v4) => classify_v4(v4),
        IpAddr::V6(v6) => classify_v6(v6),
    }
}

fn classify_v4(ip: Ipv4Addr) -> NetworkType {
    // RFC 1918 private ranges → LAN.
    if ip.is_private() {
        return NetworkType::Lan;
    }
    // CGNAT 100.64.0.0/10 is frequently a VPN overlay (e.g. Tailscale).
    let octets = ip.octets();
    if octets[0] == 100 && (64..=127).contains(&octets[1]) {
        return NetworkType::Vpn;
    }
    // Link-local 169.254/16 → LAN (rarely useful, filtered earlier anyway).
    if ip.is_link_local() {
        return NetworkType::Lan;
    }
    // Otherwise assume LAN — detected NIC addresses are, by construction, on a
    // local interface. Genuinely public endpoints are declared via config.
    NetworkType::Lan
}

fn classify_v6(ip: Ipv6Addr) -> NetworkType {
    let segments = ip.segments();
    // Unique-local fc00::/7 → LAN.
    if (segments[0] & 0xfe00) == 0xfc00 {
        return NetworkType::Lan;
    }
    // Link-local fe80::/10 → LAN.
    if (segments[0] & 0xffc0) == 0xfe80 {
        return NetworkType::Lan;
    }
    NetworkType::Lan
}

/// Whether an address is worth advertising. Skips loopback, link-local, and
/// the IPv4 unspecified address; those never let a remote client connect.
fn is_advertisable(ip: IpAddr) -> bool {
    if ip.is_loopback() || ip.is_unspecified() {
        return false;
    }
    match ip {
        IpAddr::V4(v4) => !v4.is_link_local(),
        // IPv6 link-local needs a scope id we don't carry in a URL, so skip it.
        IpAddr::V6(v6) => (v6.segments()[0] & 0xffc0) != 0xfe80,
    }
}

/// Format an IP + port into a WebSocket URL, bracketing IPv6 literals.
fn ws_url(ip: IpAddr, port: u16) -> String {
    match ip {
        IpAddr::V4(_) => format!("ws://{ip}:{port}/ws"),
        IpAddr::V6(_) => format!("ws://[{ip}]:{port}/ws"),
    }
}

/// Detect all advertisable local addresses and turn them into [`AgentAddress`]
/// entries using the given listen `port`.
///
/// Returns an empty vec on enumeration failure (logged by the caller) — the
/// agent still registers and clients fall back to relay.
#[must_use]
pub fn detect_local_addresses(port: u16) -> Vec<AgentAddress> {
    let interfaces = match if_addrs::get_if_addrs() {
        Ok(ifs) => ifs,
        Err(e) => {
            tracing::warn!("failed to enumerate network interfaces: {e}");
            return Vec::new();
        }
    };

    interfaces
        .into_iter()
        .filter(|iface| !iface.is_loopback())
        .map(|iface| {
            let ip = iface.ip();
            (iface.name, ip)
        })
        .filter(|(_, ip)| is_advertisable(*ip))
        .map(|(name, ip)| {
            let network_type = classify(ip);
            AgentAddress {
                url: ws_url(ip, port),
                label: Some(label_for(&name, network_type)),
                network_type,
                priority: network_type.default_priority(),
            }
        })
        .collect()
}

/// Build a short label combining the interface name and its category.
fn label_for(iface_name: &str, network_type: NetworkType) -> String {
    let type_label = match network_type {
        NetworkType::Lan => "LAN",
        NetworkType::Vpn => "VPN",
        NetworkType::Tunnel => "Tunnel",
        NetworkType::Public => "Public",
        NetworkType::Custom => "Custom",
    };
    format!("{type_label} ({iface_name})")
}

/// Assemble the agent's advertised P2P endpoints.
///
/// Combines:
/// 1. Config-declared `advertise_addresses` (tunnels/ingress/custom).
/// 2. Auto-detected non-loopback NIC addresses (unless disabled).
/// 3. Legacy `connect_url` / `advertise_address`+port as fallback.
///
/// The combined list is finalised: de-duplicated by normalised URL
/// (config wins over detected), sorted by priority, capped.
#[must_use]
pub fn build_advertised_addresses(config: &AgentConfig, port: u16) -> Vec<AgentAddress> {
    let mut candidates: Vec<AgentAddress> = Vec::new();

    candidates.extend(
        config
            .advertise_addresses
            .iter()
            .cloned()
            .map(AdvertiseAddress::into_agent_address),
    );

    if config.disable_address_autodetect {
        info!("Address auto-detection disabled by config");
    } else {
        candidates.extend(detect_local_addresses(port));
    }

    if let Some(url) = config.connect_url.as_deref() {
        candidates.extend(legacy_to_addresses("", 0, Some(url)));
    }
    if let Some(ip) = config.advertise_address.as_deref() {
        candidates.extend(legacy_to_addresses(ip, port, None));
    }

    let (finalised, dropped) = finalize_addresses(candidates);
    if dropped > 0 {
        warn!(
            "Advertised address list exceeded the cap; dropped {} lowest-priority entr{}",
            dropped,
            if dropped == 1 { "y" } else { "ies" }
        );
    }
    finalised
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_rfc1918_as_lan() {
        assert_eq!(classify("192.168.1.5".parse().unwrap()), NetworkType::Lan);
        assert_eq!(classify("10.0.0.9".parse().unwrap()), NetworkType::Lan);
        assert_eq!(classify("172.16.4.1".parse().unwrap()), NetworkType::Lan);
    }

    #[test]
    fn classifies_cgnat_as_vpn() {
        assert_eq!(classify("100.64.1.2".parse().unwrap()), NetworkType::Vpn);
        assert_eq!(classify("100.127.255.1".parse().unwrap()), NetworkType::Vpn);
    }

    #[test]
    fn classifies_ula_v6_as_lan() {
        assert_eq!(classify("fd00::1".parse().unwrap()), NetworkType::Lan);
    }

    #[test]
    fn skips_loopback_and_link_local() {
        assert!(!is_advertisable("127.0.0.1".parse().unwrap()));
        assert!(!is_advertisable("::1".parse().unwrap()));
        assert!(!is_advertisable("169.254.1.1".parse().unwrap()));
        assert!(!is_advertisable("fe80::1".parse().unwrap()));
        assert!(is_advertisable("192.168.1.5".parse().unwrap()));
    }

    #[test]
    fn ws_url_brackets_ipv6() {
        let v4: IpAddr = "192.168.1.5".parse().unwrap();
        let v6: IpAddr = "fd00::1".parse().unwrap();
        assert_eq!(ws_url(v4, 8080), "ws://192.168.1.5:8080/ws");
        assert_eq!(ws_url(v6, 8080), "ws://[fd00::1]:8080/ws");
    }

    #[test]
    fn label_for_lan() {
        assert_eq!(label_for("eth0", NetworkType::Lan), "LAN (eth0)");
    }

    #[test]
    fn label_for_vpn() {
        assert_eq!(label_for("utun0", NetworkType::Vpn), "VPN (utun0)");
    }

    #[test]
    fn label_for_tunnel() {
        assert_eq!(label_for("tun0", NetworkType::Tunnel), "Tunnel (tun0)");
    }

    #[test]
    fn label_for_public() {
        assert_eq!(label_for("en0", NetworkType::Public), "Public (en0)");
    }

    #[test]
    fn label_for_custom() {
        assert_eq!(label_for("wg0", NetworkType::Custom), "Custom (wg0)");
    }

    #[test]
    fn classify_v4_below_cgnat_range() {
        // 100.63.x.x is below the CGNAT block (100.64/10)
        assert_eq!(
            classify("100.63.255.255".parse().unwrap()),
            NetworkType::Lan
        );
    }

    #[test]
    fn classify_v4_above_cgnat_range() {
        // 100.128.x.x is above the CGNAT block
        assert_eq!(classify("100.128.0.1".parse().unwrap()), NetworkType::Lan);
    }

    #[test]
    fn classify_v4_link_local() {
        assert_eq!(classify("169.254.1.1".parse().unwrap()), NetworkType::Lan);
    }

    #[test]
    fn classify_v4_public() {
        // 8.8.8.8 is a public IP
        assert_eq!(classify("8.8.8.8".parse().unwrap()), NetworkType::Lan);
    }

    #[test]
    fn classify_v6_link_local_is_lan() {
        assert_eq!(classify("fe80::1".parse().unwrap()), NetworkType::Lan);
    }

    #[test]
    fn classify_v6_global_is_lan() {
        // Global unicast addresses are classified as LAN by default
        assert_eq!(classify("2001:db8::1".parse().unwrap()), NetworkType::Lan);
    }

    #[test]
    fn is_advertisable_skips_unspecified() {
        assert!(!is_advertisable("0.0.0.0".parse().unwrap()));
        assert!(!is_advertisable("::".parse().unwrap()));
    }

    #[test]
    fn is_advertisable_accepts_private_v4() {
        assert!(is_advertisable("10.0.0.1".parse().unwrap()));
        assert!(is_advertisable("172.16.0.1".parse().unwrap()));
        assert!(is_advertisable("192.168.0.1".parse().unwrap()));
    }

    #[test]
    fn is_advertisable_accepts_global_v6() {
        assert!(is_advertisable("2001:db8::1".parse().unwrap()));
    }

    #[test]
    fn detect_local_addresses_returns_vec() {
        // Should not panic. May return empty in CI with no NICs.
        let addrs = detect_local_addresses(19090);
        // If we get addresses, they should have valid fields
        for addr in &addrs {
            assert!(addr.url.starts_with("ws://"));
            assert!(addr.label.is_some());
        }
    }
}
