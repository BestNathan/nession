//! Runtime usage suggestions for `image` consumers.
//!
//! The canonical implementation lives in [`crate::oci::usage`]: it reads only
//! the standard OCI Manifest/Config and the advisory Nession annotations, so it
//! is available without the catalog/CAS feature set. This module keeps the
//! `nession_erofs::image::usage` path for catalog consumers (the Server and the
//! crate's own inspect tests).

pub use crate::oci::usage::{
    parse_config_env, resolve_path_prepend, validate_env_name, ImageEnvDefault, ImageRuntimeUsage,
    MAX_IMAGE_ENV_ENTRIES, MAX_IMAGE_ENV_KEY_BYTES, MAX_IMAGE_ENV_TOTAL_BYTES,
    MAX_IMAGE_ENV_VALUE_BYTES,
};
