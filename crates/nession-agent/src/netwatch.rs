//! Network change detection for dynamic address re-advertisement.
//!
//! Spawns a platform-specific watcher task that listens for network
//! interface changes and re-scans advertised addresses. Events are
//! debounced with a 2-second window before triggering a re-scan.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tracing::{debug, error, info, warn};

use crate::config::AgentConfig;
use crate::connection::ServerClientHandle;
use crate::netdetect::build_advertised_addresses;

/// Debounce window: wait this long after the last network event before
/// re-scanning. Coalesces bursts (WiFi association, VPN setup).
const DEBOUNCE_WINDOW: Duration = Duration::from_secs(2);

/// Spawn the network watcher task. Runs for the lifetime of the agent.
///
/// `handle` — used to send `agent.address_update` messages to the server.
/// `config` — reference to the agent config.
/// `port` — the agent WebSocket server port.
pub fn spawn_watcher(handle: ServerClientHandle, config: AgentConfig, port: u16) {
    tokio::spawn(async move {
        info!("Network watcher started (debounce: {:?})", DEBOUNCE_WINDOW);

        let last_addresses: Arc<Mutex<Option<Vec<_>>>> = Arc::new(Mutex::new(None));

        let mut events = match platform_watch() {
            Some(stream) => stream,
            None => {
                info!(
                    "Network watching not supported on this platform; \
                     addresses will be static"
                );
                return;
            }
        };

        loop {
            if events.recv().await.is_none() {
                info!("Network watcher stream ended");
                break;
            }

            debug!(
                "Network change event received; debouncing {:?}",
                DEBOUNCE_WINDOW
            );

            // Debounce: drain any additional events within the window.
            loop {
                match tokio::time::timeout(DEBOUNCE_WINDOW, events.recv()).await {
                    Ok(Some(())) => {
                        debug!("Additional network event during debounce; resetting");
                        continue;
                    }
                    Ok(None) => {
                        info!("Network watcher stream ended during debounce");
                        return;
                    }
                    Err(_) => {
                        // Timeout — no more events, re-scan now.
                        break;
                    }
                }
            }

            info!("Network change debounced; re-scanning addresses");
            let new_addrs = build_advertised_addresses(&config, port);

            if new_addrs.is_empty() {
                warn!("Address re-scan returned empty; keeping previous addresses");
                continue;
            }

            // Skip if unchanged.
            {
                let guard = last_addresses.lock().await;
                if let Some(ref old) = *guard {
                    if *old == new_addrs {
                        debug!("Addresses unchanged after re-scan; skipping update");
                        continue;
                    }
                }
            }

            info!("Network addresses changed: {} address(es)", new_addrs.len());

            match handle.send_address_update(new_addrs.clone()).await {
                Ok(()) => {
                    let mut guard = last_addresses.lock().await;
                    *guard = Some(new_addrs);
                }
                Err(e) => {
                    error!("Failed to send address update: {:#}", e);
                }
            }
        }
    });
}

// ── macOS watcher ──

#[cfg(target_os = "macos")]
mod platform {
    use system_configuration::core_foundation::array::CFArray;
    use system_configuration::core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use system_configuration::core_foundation::string::CFString;
    use system_configuration::dynamic_store::{
        SCDynamicStore, SCDynamicStoreBuilder, SCDynamicStoreCallBackContext,
    };
    use tracing::{info, warn};

    pub(super) struct WatcherEvents {
        rx: tokio::sync::mpsc::UnboundedReceiver<()>,
    }

    impl WatcherEvents {
        pub(super) async fn recv(&mut self) -> Option<()> {
            self.rx.recv().await
        }
    }

    /// Callback invoked by the CoreFoundation run loop when watched
    /// keys change. Forwards the event to the tokio channel.
    fn store_callback(
        _store: SCDynamicStore,
        _changed_keys: CFArray<CFString>,
        info: &mut tokio::sync::mpsc::UnboundedSender<()>,
    ) {
        let _ = info.send(());
    }

    pub(super) fn platform_watch() -> Option<WatcherEvents> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();

        // Spawn a dedicated thread that owns the SCDynamicStore and runs
        // the CoreFoundation run loop. The store and run loop must live
        // on the same thread.
        std::thread::spawn(move || {
            let callback_context = SCDynamicStoreCallBackContext {
                callout: store_callback,
                info: tx,
            };

            let store = SCDynamicStoreBuilder::new("nession-netwatch")
                .callback_context(callback_context)
                .build();

            // Watch for interface and global network changes using
            // pattern matching on System Configuration keys.
            let watch_keys: CFArray<CFString> = CFArray::from_CFTypes(&[]);
            let watch_patterns = CFArray::from_CFTypes(&[
                CFString::from("State:/Network/Interface/.*"),
                CFString::from("State:/Network/Global/IPv4"),
                CFString::from("State:/Network/Global/IPv6"),
            ]);

            if !store.set_notification_keys(&watch_keys, &watch_patterns) {
                warn!(
                    "Failed to set SCDynamicStore notification keys; \
                     network watching disabled"
                );
                return;
            }

            let run_loop_source = store.create_run_loop_source();
            let run_loop = CFRunLoop::get_current();
            run_loop.add_source(&run_loop_source, unsafe { kCFRunLoopCommonModes });

            info!("SCDynamicStore run loop started on dedicated thread");
            CFRunLoop::run_current();
        });

        Some(WatcherEvents { rx })
    }
}

// ── Linux watcher ──
//
// TODO(#91): Replace polling with rtnetlink event-driven watching.
//            Use rtnetlink::new_connection() + multicast group join
//            to receive RTNLGRP_IPV4_IFADDR / RTNLGRP_IPV6_IFADDR /
//            RTNLGRP_LINK events. Blocked on: verifying API against
//            netlink-proto 0.11 / netlink-packet-route 0.20 on a
//            Linux machine — APIs changed across versions and the
//            cfg-gated code can't be compiled on macOS.

#[cfg(target_os = "linux")]
mod platform {
    use std::time::Duration;
    use tokio::sync::mpsc;
    use tracing::warn;

    /// Poll interval for address re-detection on Linux.
    const POLL_INTERVAL: Duration = Duration::from_secs(30);

    pub(super) struct WatcherEvents {
        rx: mpsc::UnboundedReceiver<()>,
    }

    impl WatcherEvents {
        pub(super) async fn recv(&mut self) -> Option<()> {
            self.rx.recv().await
        }
    }

    pub(super) fn platform_watch() -> Option<WatcherEvents> {
        let (tx, rx) = mpsc::unbounded_channel();

        tokio::spawn(async move {
            warn!(
                "Linux network watching uses polling (interval: {:?}); \
                 event-driven rtnetlink support pending — see #91",
                POLL_INTERVAL
            );
            let mut ticker = tokio::time::interval(POLL_INTERVAL);
            ticker.tick().await; // skip immediate first tick
            loop {
                ticker.tick().await;
                if tx.send(()).is_err() {
                    break;
                }
            }
        });

        Some(WatcherEvents { rx })
    }
}

// ── Unsupported platform fallback ──

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod platform {
    pub(super) struct WatcherEvents;

    impl WatcherEvents {
        pub(super) async fn recv(&mut self) -> Option<()> {
            None
        }
    }

    pub(super) fn platform_watch() -> Option<WatcherEvents> {
        None
    }
}

use platform::platform_watch;
