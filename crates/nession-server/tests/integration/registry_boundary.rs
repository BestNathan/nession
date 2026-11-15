//! #3498 SC-04: the Server-owned credential and import-authorization boundary.
//!
//! The Server is the only owner of registry secrets and Project/Session/tenant
//! access policy. This test supplies both through the crate's traits and shows
//! that a cross-tenant import is refused before any registry request or
//! credential-provider call, with no local tag or ready blob written.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use nession_erofs::blob::store::BlobStore;
use nession_erofs::catalog::tag;
use nession_erofs::oci::Platform;
use nession_erofs::registry::{
    pull_image, ImportRequest, ImportScope, RegistryClient, RegistryConfig, RegistryCredential,
    RegistryCredentialProvider, RegistryError, RegistryImportAuthorizer, RemoteReference,
};
use nession_server::db::Database;

struct ServerSecret {
    calls: AtomicUsize,
    credential: RegistryCredential,
}

impl ServerSecret {
    fn new(credential: RegistryCredential) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            credential,
        }
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

impl RegistryCredentialProvider for ServerSecret {
    fn credential_for(
        &self,
        _authority: &nession_erofs::registry::RegistryAuthority,
        _repository: &str,
    ) -> Option<RegistryCredential> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Some(self.credential.clone())
    }
}

struct TenantPolicy {
    allowed_prefix: &'static str,
}

impl RegistryImportAuthorizer for TenantPolicy {
    fn authorize_import(&self, scope: &ImportScope<'_>) -> Result<(), RegistryError> {
        if scope.local_repository.starts_with(self.allowed_prefix) {
            Ok(())
        } else {
            Err(RegistryError::ImportDenied(
                scope.local_repository.to_string(),
            ))
        }
    }
}

fn platform() -> Platform {
    Platform {
        os: "linux".to_string(),
        architecture: "amd64".to_string(),
        os_features: Some(vec!["erofs".to_string()]),
        ..Platform::default()
    }
}

#[tokio::test]
async fn server_owned_registry_boundary_denies_cross_tenant_import_before_io() {
    let directory = tempfile::tempdir().expect("temp dir");
    let database_path = directory
        .path()
        .join("server.db")
        .to_string_lossy()
        .into_owned();
    let database = Database::new(&database_path).await.expect("database");
    nession_erofs::catalog::migrate(database.connection())
        .await
        .expect("catalog schema");
    let store = BlobStore::new(directory.path().join("store")).expect("blob store");

    let provider = Arc::new(ServerSecret::new(
        RegistryCredential::new("robot", "server-owned-secret").expect("server credential"),
    ));
    let config = RegistryConfig::new("http://127.0.0.1:9").expect("loopback registry config");
    let client = RegistryClient::new(config, provider.clone()).expect("registry client");
    let policy = TenantPolicy {
        allowed_prefix: "tenant-a/",
    };
    let request = ImportRequest {
        repository: "upstream/private".to_string(),
        reference: RemoteReference::Tag("v1".to_string()),
        platform: platform(),
        local_repository: "tenant-b/private".to_string(),
        local_tag: "v1".to_string(),
        expectation: nession_erofs::catalog::tag::TagExpectation::Absent,
    };
    let error = pull_image(&client, database.connection(), &store, &request, &policy, 1)
        .await
        .expect_err("cross-tenant import must be denied");
    assert!(matches!(error, RegistryError::ImportDenied(_)));
    assert_eq!(
        provider.calls(),
        0,
        "a denied import must not touch the Server secret source"
    );
    assert_eq!(store.usage().expect("usage").blobs, 0);
    assert!(
        tag::get_tag(database.connection(), "tenant-b/private", "v1")
            .await
            .expect("tag")
            .is_none()
    );
    assert!(!format!("{client:?}").contains("server-owned-secret"));
}
