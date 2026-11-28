//! First-hop installer bridge contract (#4660 SC-05/SC-06): the official
//! `scripts/install.sh` downloads the release archive exactly once and hands
//! the verified staged artifact to the canonical target installer, which never
//! re-downloads it. A live Agent/Server is refused by the read-only preflight
//! before any asset transfer. These are controlled cold-cache fixtures: the
//! httptest expectations count full asset GETs empirically (one for a committed
//! first-hop bridge, zero for a live-writer refusal).
//!
//! The real built `nession` binary is the target; the Current installation is a
//! fake old CLI (v1.0.1-shaped: supports `install`, lacks the upgrade contract)
//! so the shell takes the verified-target MIGRATE path. All state lives in a
//! temporary HOME/install/runtime; no production home or credentials.

use anyhow::{Context, Result};
use httptest::matchers::{all_of, request};
use httptest::{responders::status_code, Expectation, Server};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

const OLD_VERSION: &str = "1.0.1";

fn target_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

fn platform_string() -> String {
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "amd64"
    };
    format!("{os}-{arch}")
}

fn install_script() -> PathBuf {
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../scripts/install.sh"
    ))
}

fn sha256_file(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    let bytes = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn make_executable(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o755))
            .with_context(|| format!("chmod {}", path.display()))?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}

/// A fake old Current CLI: supports `install`, reports v1.0.1, does NOT
/// advertise the upgrade contract. `agent|server status` reports a live process
/// only when `FAKE_LIVE` is set (read-only preflight probe).
fn write_fake_old_cli(dir: &Path) -> Result<()> {
    let script = "#!/bin/sh\n\
        case \"$1\" in\n\
        \x20 --upgrade-contract) exit 2 ;;\n\
        \x20 --version) echo \"nession 1.0.1\" ;;\n\
        \x20 install) exit 0 ;;\n\
        \x20 agent|server) if [ \"$2\" = status ]; then if [ -n \"${FAKE_LIVE:-}\" ]; then echo \"Status: running\"; echo \"PID: 99999\"; else echo \"Status: not running\"; fi; exit 0; fi; exit 2 ;;\n\
        \x20 *) exit 2 ;;\n\
        esac\n";
    for name in ["nession", "nession-agent", "nession-server"] {
        let path = dir.join(name);
        fs::write(&path, script).with_context(|| format!("write {}", path.display()))?;
        make_executable(&path)?;
    }
    Ok(())
}

/// A real target tarball: the built `nession` binary (advertises the upgrade
/// contract for the target version) plus placeholder agent/server binaries.
fn make_target_tarball(dir: &Path) -> Result<(PathBuf, String, String)> {
    let bin_dir = dir.join("target-binaries");
    fs::create_dir_all(&bin_dir).context("create target-binaries")?;
    fs::copy(env!("CARGO_BIN_EXE_nession"), bin_dir.join("nession"))
        .context("copy target nession")?;
    for name in ["nession-agent", "nession-server"] {
        let path = bin_dir.join(name);
        fs::write(&path, "#!/bin/sh\nexit 0\n")
            .with_context(|| format!("write {}", path.display()))?;
        make_executable(&path)?;
    }
    let asset = format!("nession-{}-{}.tar.gz", target_version(), platform_string());
    let tarball = dir.join(&asset);
    let status = Command::new("tar")
        .arg("-czf")
        .arg(&tarball)
        .arg("-C")
        .arg(&bin_dir)
        .args(["nession", "nession-agent", "nession-server"])
        .status()
        .context("run tar")?;
    anyhow::ensure!(status.success(), "tar must build the target tarball");
    let checksum = sha256_file(&tarball)?;
    Ok((tarball, asset, checksum))
}

/// An Agent-only incident fixture: config/identity/token, an empty Server tree
/// (images/{blobs,build}+logs only, no DB/config) and an empty EROFS store.
fn write_agent_only_home(home: &Path) -> Result<()> {
    fs::write(
        home.join("agent-config.toml"),
        "server_url = \"ws://127.0.0.1:19099/ws\"\nauth_token = \"\"\n",
    )
    .context("write agent config")?;
    fs::create_dir_all(home.join("agent")).context("create agent dir")?;
    fs::write(home.join("agent/identity"), "agent-4660-bridge-identity\n")
        .context("write identity")?;
    fs::write(
        home.join("agent-config.token"),
        "fixture-token-not-a-real-secret\n",
    )
    .context("write token")?;
    for sub in [
        "server/images/blobs",
        "server/images/build",
        "server/logs",
        "erofs",
    ] {
        fs::create_dir_all(home.join(sub)).with_context(|| format!("create {sub}"))?;
    }
    Ok(())
}

struct Bridge {
    _root: tempfile::TempDir,
    home: PathBuf,
    install_dir: PathBuf,
    runtime: PathBuf,
}

fn bridge_fixture() -> Result<Bridge> {
    let root = tempfile::tempdir().context("tempdir")?;
    let home = root.path().join("home");
    let install_dir = root.path().join("install");
    let runtime = root.path().join("runtime");
    for dir in [&home, &install_dir, &runtime] {
        fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    write_fake_old_cli(&install_dir)?;
    write_agent_only_home(&home)?;
    Ok(Bridge {
        _root: root,
        home,
        install_dir,
        runtime,
    })
}

fn run_installer(bridge: &Bridge, release_base: &str, extra: &[(&str, &str)]) -> Result<Output> {
    let mut command = Command::new("sh");
    command
        .arg(install_script())
        .arg("--version")
        .arg(target_version())
        .arg("--dir")
        .arg(&bridge.install_dir)
        .env("NESSION_HOME", &bridge.home)
        .env("NESSION_INSTALL_DIR", &bridge.install_dir)
        .env("NESSION_RUNTIME_DIR", &bridge.runtime)
        .env("NESSION_RELEASE_BASE_URL", release_base)
        // The shell requires an API base alongside a mirror base for an existing
        // installation; the target's local-artifact path makes no API call.
        .env("NESSION_UPDATE_API_URL", release_base)
        .env("NESSION_NO_UPDATE_CHECK", "1")
        .env_remove("NESSION_VERSION")
        .env_remove("NESSION_VERSION_DISPATCHED")
        .env_remove("GITHUB_TOKEN")
        .env_remove("GH_TOKEN");
    for (key, value) in extra {
        command.env(key, value);
    }
    command.output().context("run install.sh")
}

fn joined(output: &Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// SC-06: a committed first-hop bridge transfers the full asset exactly once
/// (the shell download); the target installs the handed-off local artifact with
/// zero further asset GETs. The Agent-only fixture commits with honest coverage.
#[test]
fn first_hop_bridge_transfers_the_asset_exactly_once() -> Result<()> {
    let bridge = bridge_fixture()?;
    let (tarball, asset, checksum) = make_target_tarball(bridge._root.path())?;
    let tarball_bytes = fs::read(&tarball).context("read tarball")?;
    let ver = target_version();
    let asset_path = format!("/releases/download/v{ver}/{asset}");
    let checksums_path = format!("/releases/download/v{ver}/checksums.txt");

    let server = Server::run();
    server.expect(
        Expectation::matching(all_of![request::method("GET"), request::path(asset_path)])
            .times(1)
            .respond_with(status_code(200).body(tarball_bytes)),
    );
    server.expect(
        Expectation::matching(all_of![
            request::method("GET"),
            request::path(checksums_path)
        ])
        .times(1)
        .respond_with(status_code(200).body(format!("{checksum}  {asset}\n"))),
    );
    let release_base = format!("{}releases/download", server.url("/"));

    let output = run_installer(&bridge, &release_base, &[])?;
    let text = joined(&output);
    assert!(
        output.status.success(),
        "Agent-only bridge must commit (exit 0): {text}"
    );
    assert!(
        text.contains("nession-install-result-v1 outcome=committed result=ok"),
        "authoritative committed result line: {text}"
    );
    assert!(
        !text.contains("was not snapshotted into the archive"),
        "no synthetic archive-directory requirement: {text}"
    );

    // The archive carries honest schema-2 coverage; the Agent-only fixture is
    // state-complete (no false missing from the empty Server tree / empty CAS).
    let archive = bridge.home.join("versions").join(OLD_VERSION);
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(archive.join("manifest.json")).context("read manifest")?)
            .context("parse manifest")?;
    assert_eq!(manifest["schema"], 2);
    assert_eq!(
        manifest["state_complete"], true,
        "gaps: {}",
        manifest["gaps"]
    );
    // Current is the verified target binary.
    assert_eq!(
        sha256_file(&bridge.install_dir.join("nession"))?,
        sha256_file(Path::new(env!("CARGO_BIN_EXE_nession")))?,
        "Current must be the verified target"
    );
    // Identity retained at Current.
    assert_eq!(
        fs::read_to_string(bridge.home.join("agent/identity")).context("read identity")?,
        "agent-4660-bridge-identity\n"
    );
    // httptest verifies the .times(1) asset expectation on drop.
    Ok(())
}

/// SC-05: a live Agent detected by the read-only preflight refuses the upgrade
/// before any asset transfer — zero full asset GETs, Current unchanged.
#[test]
fn live_writer_preflight_refuses_with_zero_asset_gets() -> Result<()> {
    let bridge = bridge_fixture()?;
    let (_tarball, asset, _checksum) = make_target_tarball(bridge._root.path())?;
    let ver = target_version();
    let asset_path = format!("/releases/download/v{ver}/{asset}");
    let old_cli_digest = sha256_file(&bridge.install_dir.join("nession"))?;

    let server = Server::run();
    // Any asset GET would violate the preflight contract.
    server.expect(
        Expectation::matching(all_of![request::method("GET"), request::path(asset_path)])
            .times(0)
            .respond_with(status_code(200).body(Vec::new())),
    );
    let release_base = format!("{}releases/download", server.url("/"));

    let output = run_installer(&bridge, &release_base, &[("FAKE_LIVE", "1")])?;
    let text = joined(&output);
    assert!(
        !output.status.success(),
        "a live Agent must refuse the upgrade: {text}"
    );
    assert!(
        text.contains("live agent was detected before download"),
        "read-only preflight refusal diagnostic: {text}"
    );
    // Current unchanged.
    assert_eq!(
        sha256_file(&bridge.install_dir.join("nession"))?,
        old_cli_digest,
        "Current must be unchanged on a live-writer refusal"
    );
    assert!(
        !bridge.home.join("versions").join(OLD_VERSION).exists(),
        "no archive on a preflight refusal"
    );
    // httptest verifies the .times(0) asset expectation on drop.
    Ok(())
}
