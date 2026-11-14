//! OCI Image Config, including standard runtime defaults and rootfs.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::UnknownFields;

/// The standard OCI Image Config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImageConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default)]
    pub architecture: String,
    #[serde(default)]
    pub os: String,
    #[serde(
        rename = "os.version",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub os_version: Option<String>,
    #[serde(
        rename = "os.features",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub os_features: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(default)]
    pub config: RuntimeConfig,
    pub rootfs: RootFs,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub history: Vec<History>,
    #[serde(flatten)]
    pub extra: UnknownFields,
}

impl ImageConfig {
    /// Whether `os.features` contains the `erofs` marker.
    pub fn supports_erofs(&self) -> bool {
        self.os_features
            .as_deref()
            .is_some_and(|features| features.iter().any(|feature| feature == "erofs"))
    }

    /// The standard Config environment defaults.
    pub fn env(&self) -> &[String] {
        self.config.env.as_deref().unwrap_or_default()
    }
}

/// Standard runtime configuration carried by the OCI Config.
///
/// The OCI Image Spec spells these JSON keys with an initial capital
/// (`Env`, `Entrypoint`, `Cmd`, `WorkingDir`, ...), unlike the descriptor and
/// manifest objects. They are not camel-cased here.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeConfig {
    #[serde(rename = "User", default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(
        rename = "ExposedPorts",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub exposed_ports: Option<BTreeMap<String, serde_json::Value>>,
    #[serde(rename = "Env", default, skip_serializing_if = "Option::is_none")]
    pub env: Option<Vec<String>>,
    #[serde(
        rename = "Entrypoint",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub entrypoint: Option<Vec<String>>,
    #[serde(rename = "Cmd", default, skip_serializing_if = "Option::is_none")]
    pub cmd: Option<Vec<String>>,
    #[serde(rename = "Volumes", default, skip_serializing_if = "Option::is_none")]
    pub volumes: Option<Vec<String>>,
    #[serde(
        rename = "WorkingDir",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub working_dir: Option<String>,
    #[serde(rename = "Labels", default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
    #[serde(
        rename = "StopSignal",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub stop_signal: Option<String>,
    #[serde(
        rename = "ArgsEscaped",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub args_escaped: Option<bool>,
    #[serde(flatten)]
    pub extra: UnknownFields,
}

/// The Config rootfs descriptor list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootFs {
    #[serde(rename = "type")]
    pub fs_type: String,
    pub diff_ids: Vec<String>,
    #[serde(flatten)]
    pub extra: UnknownFields,
}

/// One Config history entry.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct History {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub empty_layer: Option<bool>,
    #[serde(flatten)]
    pub extra: UnknownFields,
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONFIG: &str = r#"{
      "created": "2026-11-14T00:00:00Z",
      "architecture": "amd64",
      "os": "linux",
      "os.features": ["erofs"],
      "variant": "v1",
      "config": {
        "Env": ["PATH=/usr/bin", "LANG=C"],
        "Entrypoint": ["/bin/sh"],
        "Cmd": ["-c", "true"],
        "WorkingDir": "/work",
        "x-runtime-extension": {"kept": true}
      },
      "rootfs": {
        "type": "layers",
        "diff_ids": ["sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]
      },
      "x-config-extension": "kept"
    }"#;

    #[test]
    fn standard_config_fields_and_unknown_extensions_parse() {
        let config: ImageConfig = serde_json::from_str(CONFIG).unwrap();
        assert_eq!(config.architecture, "amd64");
        assert_eq!(config.os, "linux");
        assert!(config.supports_erofs());
        assert_eq!(
            config.env(),
            &["PATH=/usr/bin".to_string(), "LANG=C".to_string()]
        );
        assert_eq!(config.config.working_dir.as_deref(), Some("/work"));
        assert_eq!(
            config.extra.get("x-config-extension"),
            Some(&serde_json::Value::String("kept".to_string()))
        );
        assert!(config.config.extra.contains_key("x-runtime-extension"));
    }

    #[test]
    fn rootfs_type_and_diff_ids_use_the_standard_names() {
        let config: ImageConfig = serde_json::from_str(CONFIG).unwrap();
        assert_eq!(config.rootfs.fs_type, "layers");
        assert_eq!(config.rootfs.diff_ids.len(), 1);
        let serialized = serde_json::to_value(&config).unwrap();
        assert_eq!(serialized["rootfs"]["type"], "layers");
        assert!(serialized["rootfs"].get("diff_ids").is_some());
        assert_eq!(serialized["os.features"][0], "erofs");
    }
}
