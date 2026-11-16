//! Referenced multi-blob EROFS Composite Images (#3697).
//!
//! Unlike the flattened Compose path (#3696), a referenced build does not
//! copy file data. It runs the pinned `mkfs.erofs` rebuild mode over the
//! already-pinned source EROFS images, producing one metadata EROFS whose
//! chunk indexes point at the original source blobs as external devices. The
//! Composite descriptor (see [`crate::oci::composite`]) records that exact
//! closure and the Manifest/Config identity is built around it.
//!
//! Fail-closed rules:
//!
//! - every source is verified against its pinned descriptor before packaging;
//! - conflicting paths across sources are refused before publication;
//! - overlay whiteouts, special files and symlinks escaping the composed root
//!   are refused;
//! - a source whose layout cannot be referenced (for example inline file
//!   data) makes the rebuild fail with an explicit compatibility diagnostic;
//! - the metadata image must carry the EROFS `chunked_file` + `device_table`
//!   features and declare exactly the expected number of extra devices;
//! - the published Manifest has its own identity and the backing blobs remain
//!   reachable through the Composite descriptor edges.

use anyhow::{Context, Result};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::compose::{entry_is_whiteout, validate_symlink_target, verify_layer_file};
use super::import::{validate_erofs_file, MAX_IMPORT_BYTES};
use super::{
    compose, BuildObserver, BuiltImage, ComposeImageMetadata, ComposeSourceProvenance, MkfsRunner,
    Packaging, ProcessControl, ReferencedImageMetadata, Stage, TreeStats, MAX_SNAPSHOT_BYTES,
    MAX_SNAPSHOT_ENTRIES,
};
use crate::blob::store::{BlobDigest, BlobStore};
use crate::oci::annotation::{
    COMPOSE_FORMAT_REFERENCED_V1, MEDIA_TYPE_COMPOSITE, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS,
    MEDIA_TYPE_MANIFEST,
};
use crate::oci::composite::{
    validate_composite_manifest_config, CompositeDescriptor, MAX_COMPOSITE_DEVICES,
};
use crate::oci::config::{ImageConfig, RootFs, RuntimeConfig};
use crate::oci::descriptor::{Descriptor, Platform};
use crate::oci::manifest::Manifest;
use crate::oci::{to_bytes, RawDocument};
use serde_json::Map;

/// The in-progress referenced metadata image. Never published while incomplete.
pub const REFERENCED_IMAGE_FILE: &str = "referenced.erofs.part";
/// The private source extraction root inside a build directory.
const REFERENCED_SOURCES_DIR: &str = "referenced-sources";

/// The EROFS superblock `feature_incompat` offset.
const EROFS_INCOMPAT_OFFSET: usize = 1104;
/// The EROFS superblock extra-device count offset (`__le16`), superblock-relative 86.
const EROFS_EXTRA_DEVICES_OFFSET: usize = 1110;
/// `EROFS_FEATURE_INCOMPAT_CHUNKED_FILE`.
const EROFS_FEATURE_INCOMPAT_CHUNKED_FILE: u32 = 0x0000_0004;
/// `EROFS_FEATURE_INCOMPAT_DEVICE_TABLE`.
const EROFS_FEATURE_INCOMPAT_DEVICE_TABLE: u32 = 0x0000_0008;

/// One verified, pinned source Image for a referenced Composite.
#[derive(Debug, Clone)]
pub struct ReferencedSourceInput {
    pub path: PathBuf,
    pub layer: Descriptor,
    pub repository: String,
    pub reference: String,
    pub manifest_digest: String,
    pub platform: Platform,
    pub config: ImageConfig,
}

impl ReferencedSourceInput {
    fn as_compose_input(&self) -> compose::ComposeSourceInput {
        compose::ComposeSourceInput {
            path: self.path.clone(),
            layer: self.layer.clone(),
            repository: self.repository.clone(),
            reference: self.reference.clone(),
            manifest_digest: self.manifest_digest.clone(),
            destination: String::new(),
            platform: self.platform.clone(),
            config: self.config.clone(),
        }
    }
}

/// One referenced Composite build request.
pub struct ReferencedBuildRequest<'a> {
    pub build_dir: &'a Path,
    pub sources: &'a [ReferencedSourceInput],
    pub packaging: &'a Packaging,
    pub control: &'a ProcessControl,
    pub observer: &'a dyn BuildObserver,
}

/// The result of one referenced Composite build.
#[derive(Debug, Clone)]
pub struct ReferencedImage {
    pub built: BuiltImage,
    pub metadata: BlobDigest,
    pub descriptor: BlobDigest,
    pub descriptor_doc: CompositeDescriptor,
}

/// The deterministic referenced Composite composer.
pub struct ErofsReferencedComposer {
    pub extractor: Arc<dyn compose::ErofsExtractor>,
    pub mkfs: Arc<dyn MkfsRunner>,
    pub blobs: BlobStore,
    pub work_root: PathBuf,
}

impl ErofsReferencedComposer {
    pub fn new(
        extractor: Arc<dyn compose::ErofsExtractor>,
        mkfs: Arc<dyn MkfsRunner>,
        blobs: BlobStore,
        work_root: impl Into<PathBuf>,
    ) -> Result<Self> {
        let work_root = work_root.into();
        fs::create_dir_all(&work_root).with_context(|| {
            format!(
                "failed to create referenced compose directory {}",
                work_root.display()
            )
        })?;
        Ok(Self {
            extractor,
            mkfs,
            blobs,
            work_root,
        })
    }

    /// Execute one referenced Composite build inside `request.build_dir`.
    pub fn run(&self, request: ReferencedBuildRequest<'_>) -> Result<ReferencedImage> {
        request.packaging.validate()?;
        validate_sources(request.sources)?;
        fs::create_dir_all(request.build_dir).with_context(|| {
            format!(
                "failed to create build directory {}",
                request.build_dir.display()
            )
        })?;

        for source in request.sources {
            verify_layer_file(&source.path, &source.layer).with_context(|| {
                format!(
                    "referenced source {}:{} is not the pinned verified EROFS layer",
                    source.repository, source.reference
                )
            })?;
        }
        let stats = self.validate_union(&request)?;
        request.observer.stage(Stage::Validating);
        request.observer.progress(&stats);

        if request.control.is_canceled() {
            anyhow::bail!("build was canceled");
        }
        request.observer.stage(Stage::Packaging);
        let image = request.build_dir.join(REFERENCED_IMAGE_FILE);
        match fs::remove_file(&image) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("failed to remove {}", image.display()));
            }
        }
        let source_paths = request
            .sources
            .iter()
            .map(|source| source.path.as_path())
            .collect::<Vec<_>>();
        let args = referenced_mkfs_command(&image, &source_paths, request.packaging);
        self.mkfs.run(&args, request.control).with_context(|| {
            "mkfs.erofs rebuild failed; a referenced Composite requires source images whose file \
             data is block-addressed (inline-data layouts are not reference-compatible)"
        })?;
        let size = fs::metadata(&image)
            .with_context(|| format!("mkfs.erofs produced no image at {}", image.display()))?
            .len();
        if size == 0 || size > MAX_IMPORT_BYTES {
            anyhow::bail!("mkfs.erofs produced an invalid referenced metadata image size {size}");
        }
        validate_metadata_image(&image, request.sources.len())?;
        if request.control.is_canceled() {
            anyhow::bail!("build was canceled");
        }
        request.observer.stage(Stage::Publishing);
        if request.control.is_canceled() {
            anyhow::bail!("build was canceled");
        }
        let metadata_result = self.blobs.put_file(&image)?;
        self.blobs.verify(&metadata_result.digest)?;
        // The durable CAS copy is authoritative; the build-directory partial
        // is scratch and is released after a successful publication.
        let _ = fs::remove_file(&image);
        let metadata_blob = metadata_result.clone();
        let metadata = Descriptor {
            media_type: MEDIA_TYPE_EROFS.to_string(),
            digest: metadata_result.digest.clone(),
            size: metadata_result.size_bytes,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        };
        let devices = request
            .sources
            .iter()
            .map(|source| source.layer.clone())
            .collect::<Vec<_>>();
        let platform = request
            .sources
            .first()
            .map(|source| source.platform.clone())
            .context("a referenced Composite requires at least one source")?;
        let descriptor_doc = CompositeDescriptor::new(&platform, &metadata, &devices)?;
        let descriptor_document = descriptor_doc.to_document()?;
        let descriptor_blob = self.blobs.put_bytes(descriptor_document.bytes())?;
        if descriptor_blob.digest != descriptor_document.digest() {
            anyhow::bail!("Composite descriptor bytes do not publish under their own digest");
        }
        let descriptor = Descriptor {
            media_type: MEDIA_TYPE_COMPOSITE.to_string(),
            digest: descriptor_blob.digest.clone(),
            size: descriptor_blob.size_bytes,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        };

        let inputs = request
            .sources
            .iter()
            .map(ReferencedSourceInput::as_compose_input)
            .collect::<Vec<_>>();
        let mut runtime = compose::compose_runtime(&inputs)?;
        let provenance = referenced_provenance(request.sources);
        let annotations = compose::compose_annotations(
            runtime.annotations.clone(),
            &provenance,
            COMPOSE_FORMAT_REFERENCED_V1,
        )?;
        runtime.annotations = annotations.clone();
        let (config_document, manifest_document) = referenced_documents(
            &descriptor_doc,
            &descriptor,
            &platform,
            &runtime,
            &annotations,
        )?;
        let size_bytes = metadata
            .size
            .saturating_add(descriptor_blob.size_bytes)
            .saturating_add(config_document.size()?)
            .saturating_add(manifest_document.size()?)
            .saturating_add(devices.iter().map(|device| device.size).sum::<u64>());
        let manifest_digest = manifest_document.digest().to_string();

        Ok(ReferencedImage {
            built: BuiltImage {
                blob: metadata_result,
                source_sha: None,
                packaging: request.packaging.clone(),
                compose: Some(ComposeImageMetadata {
                    runtime,
                    sources: provenance,
                    referenced: Some(ReferencedImageMetadata {
                        descriptor,
                        metadata,
                        devices,
                        config: config_document,
                        manifest: manifest_document,
                        manifest_digest,
                        size_bytes,
                    }),
                }),
            },
            metadata: metadata_blob,
            descriptor: descriptor_blob,
            descriptor_doc,
        })
    }

    fn validate_union(&self, request: &ReferencedBuildRequest<'_>) -> Result<TreeStats> {
        request.observer.stage(Stage::Snapshotting);
        let scratch_root = request.build_dir.join(REFERENCED_SOURCES_DIR);
        if scratch_root.exists() {
            fs::remove_dir_all(&scratch_root)?;
        }
        fs::create_dir_all(&scratch_root)?;
        let mut seen: HashMap<PathBuf, (String, bool)> = HashMap::new();
        let mut stats = TreeStats::default();
        for (position, source) in request.sources.iter().enumerate() {
            if request.control.is_canceled() {
                anyhow::bail!("build was canceled");
            }
            let label = format!("{}:{}", source.repository, source.reference);
            let scratch = scratch_root.join(format!("source-{position}"));
            self.extractor
                .extract(&source.path, &scratch, request.control)
                .with_context(|| format!("referenced source {label} could not be extracted"))?;
            collect_union(&scratch, &scratch, &label, &mut seen, &mut stats)?;
            fs::remove_dir_all(&scratch).ok();
        }
        fs::remove_dir_all(&scratch_root).ok();
        Ok(stats)
    }
}

fn validate_sources(sources: &[ReferencedSourceInput]) -> Result<()> {
    if sources.is_empty() {
        anyhow::bail!("a referenced Composite requires at least one source Image");
    }
    if sources.len() > MAX_COMPOSITE_DEVICES {
        anyhow::bail!(
            "a referenced Composite accepts at most {MAX_COMPOSITE_DEVICES} source Images"
        );
    }
    let mut digests = HashSet::new();
    let mut identities = HashSet::new();
    for source in sources {
        if source.layer.media_type != MEDIA_TYPE_EROFS {
            anyhow::bail!(
                "referenced source {}:{} is not a raw EROFS image",
                source.repository,
                source.reference
            );
        }
        if !digests.insert(source.layer.digest.as_str()) {
            anyhow::bail!(
                "referenced source {}:{} repeats an existing device blob {}",
                source.repository,
                source.reference,
                source.layer.digest
            );
        }
        if !identities.insert((
            source.repository.as_str(),
            source.reference.as_str(),
            source.manifest_digest.as_str(),
        )) {
            anyhow::bail!(
                "referenced source {}:{} appears more than once",
                source.repository,
                source.reference
            );
        }
        if let Some(first) = sources.first() {
            if first.platform.os != source.platform.os
                || first.platform.architecture != source.platform.architecture
                || first.platform.variant != source.platform.variant
            {
                anyhow::bail!(
                    "referenced source {}:{} targets {}/{} variant {:?}, not the first source's {}/{} variant {:?}",
                    source.repository,
                    source.reference,
                    source.platform.os,
                    source.platform.architecture,
                    source.platform.variant,
                    first.platform.os,
                    first.platform.architecture,
                    first.platform.variant
                );
            }
        }
    }
    Ok(())
}

fn collect_union(
    root: &Path,
    current: &Path,
    label: &str,
    seen: &mut HashMap<PathBuf, (String, bool)>,
    stats: &mut TreeStats,
) -> Result<()> {
    let mut entries = fs::read_dir(current)?.collect::<std::io::Result<Vec<_>>>()?;
    entries.sort_by_key(std::fs::DirEntry::file_name);
    for entry in entries {
        let path = entry.path();
        stats.entries = stats.entries.saturating_add(1);
        if stats.entries > MAX_SNAPSHOT_ENTRIES {
            anyhow::bail!("referenced Composite sources exceed the entry bound");
        }
        let relative = path
            .strip_prefix(root)
            .map_err(|_| anyhow::anyhow!("referenced source path escaped its root"))?;
        if entry_is_whiteout(&path) {
            anyhow::bail!(
                "referenced source {label} contains overlay whiteout metadata /{}",
                relative.display()
            );
        }
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() {
            let target = fs::read_link(&path)?;
            validate_symlink_target(&target, &path, root)?;
            record_path(seen, relative, label, false)?;
        } else if metadata.is_dir() {
            record_path(seen, relative, label, true)?;
            collect_union(root, &path, label, seen, stats)?;
        } else if metadata.is_file() {
            stats.files = stats.files.saturating_add(1);
            stats.bytes = stats.bytes.saturating_add(metadata.len());
            if stats.bytes > MAX_SNAPSHOT_BYTES {
                anyhow::bail!("referenced Composite sources exceed the byte bound");
            }
            record_path(seen, relative, label, false)?;
        } else {
            anyhow::bail!(
                "referenced source {label} contains a special file /{}",
                relative.display()
            );
        }
    }
    Ok(())
}

fn record_path(
    seen: &mut HashMap<PathBuf, (String, bool)>,
    relative: &Path,
    label: &str,
    directory: bool,
) -> Result<()> {
    match seen.get(relative) {
        Some((existing, existing_directory)) if *existing_directory && directory => {
            // Shared parent directories merge; a leaf or a file-vs-directory
            // mismatch is a conflict.
            let _ = existing;
        }
        Some((existing, _)) => {
            anyhow::bail!(
                "referenced sources {existing} and {label} both own /{}",
                relative.display()
            );
        }
        None => {
            seen.insert(relative.to_path_buf(), (label.to_string(), directory));
        }
    }
    Ok(())
}

/// The exact `mkfs.erofs` argv a referenced Composite emits.
pub fn referenced_mkfs_command(
    image: &Path,
    sources: &[&Path],
    packaging: &Packaging,
) -> Vec<String> {
    let mut args = vec![
        "-T".to_string(),
        packaging.fixed_timestamp.to_string(),
        "-U".to_string(),
        packaging.fixed_uuid.clone(),
        "-b".to_string(),
        packaging.block_size.to_string(),
        "--all-root".to_string(),
        "--chunksize".to_string(),
        crate::oci::composite::COMPOSITE_CHUNK_SIZE.to_string(),
    ];
    args.push(image.to_string_lossy().into_owned());
    for source in sources {
        args.push(source.to_string_lossy().into_owned());
    }
    args
}

/// Verify that a metadata image carries the referenced-device features and
/// declares exactly the expected backing devices.
pub fn validate_metadata_image(path: &Path, expected_devices: usize) -> Result<u64> {
    use std::io::{Read, Seek, SeekFrom};
    let size = validate_erofs_file(path)?;
    let mut file = fs::File::open(path)
        .with_context(|| format!("cannot open referenced metadata {}", path.display()))?;
    file.seek(SeekFrom::Start(EROFS_INCOMPAT_OFFSET as u64))?;
    let mut incompat_bytes = [0_u8; 4];
    file.read_exact(&mut incompat_bytes)
        .context("referenced metadata is shorter than its superblock")?;
    let incompat = u32::from_le_bytes(incompat_bytes);
    file.seek(SeekFrom::Start(EROFS_EXTRA_DEVICES_OFFSET as u64))?;
    let mut extra_bytes = [0_u8; 2];
    file.read_exact(&mut extra_bytes)
        .context("referenced metadata has no extra-device field")?;
    let required = EROFS_FEATURE_INCOMPAT_CHUNKED_FILE | EROFS_FEATURE_INCOMPAT_DEVICE_TABLE;
    if incompat & required != required {
        anyhow::bail!(
            "referenced metadata lacks the chunked_file/device_table features (incompat 0x{incompat:08X})"
        );
    }
    let extra = u16::from_le_bytes(extra_bytes);
    if usize::from(extra) != expected_devices {
        anyhow::bail!(
            "referenced metadata declares {extra} extra devices, expected {expected_devices}"
        );
    }
    Ok(size)
}

/// Referenced provenance preserves the declared layer/device order.
fn referenced_provenance(sources: &[ReferencedSourceInput]) -> Vec<ComposeSourceProvenance> {
    sources
        .iter()
        .map(|source| ComposeSourceProvenance {
            repository: source.repository.clone(),
            reference: source.reference.clone(),
            manifest_digest: source.manifest_digest.clone(),
            layer_digest: source.layer.digest.clone(),
            size_bytes: source.layer.size,
            destination: String::new(),
        })
        .collect()
}

fn referenced_documents(
    composite: &CompositeDescriptor,
    descriptor: &Descriptor,
    platform: &Platform,
    runtime: &crate::build::ComposeRuntime,
    annotations: &std::collections::BTreeMap<String, String>,
) -> Result<(RawDocument, RawDocument)> {
    let mut os_features = platform.os_features.clone().unwrap_or_default();
    if !os_features.iter().any(|feature| feature == "erofs") {
        os_features.push("erofs".to_string());
    }
    let closure = composite.closure()?;
    let diff_ids = closure
        .iter()
        .map(|descriptor| descriptor.digest.clone())
        .collect::<Vec<_>>();
    let config = ImageConfig {
        created: None,
        author: None,
        architecture: platform.architecture.clone(),
        os: platform.os.clone(),
        os_version: platform.os_version.clone(),
        os_features: Some(os_features),
        variant: platform.variant.clone(),
        config: RuntimeConfig {
            env: (!runtime.env.is_empty()).then(|| runtime.env.clone()),
            entrypoint: runtime.entrypoint.clone(),
            cmd: runtime.cmd.clone(),
            working_dir: runtime.working_dir.clone(),
            ..RuntimeConfig::default()
        },
        rootfs: RootFs {
            fs_type: crate::oci::composite::COMPOSITE_ROOTFS_TYPE.to_string(),
            diff_ids,
            extra: Map::new(),
        },
        history: Vec::new(),
        extra: Map::new(),
    };
    let config_document = RawDocument::from_bytes(to_bytes(&config)?);
    let manifest = Manifest {
        schema_version: 2,
        media_type: Some(MEDIA_TYPE_MANIFEST.to_string()),
        config: Descriptor {
            media_type: MEDIA_TYPE_CONFIG.to_string(),
            digest: config_document.digest().to_string(),
            size: config_document.size()?,
            urls: None,
            annotations: None,
            platform: None,
            artifact_type: None,
            data: None,
            extra: Map::new(),
        },
        layers: vec![descriptor.clone()],
        subject: None,
        artifact_type: None,
        annotations: (!annotations.is_empty()).then(|| annotations.clone()),
        extra: Map::new(),
    };
    validate_composite_manifest_config(&manifest, &config, composite, descriptor)?;
    Ok((
        config_document,
        RawDocument::from_bytes(to_bytes(&manifest)?),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::compose::SOURCE_ANNOTATIONS_KEY;
    use crate::build::NoopObserver;
    use crate::oci::annotation::ImageKind;
    use crate::oci::config::RuntimeConfig;
    use std::sync::Mutex;
    use tempfile::tempdir;

    #[derive(Default)]
    struct FakeExtractor {
        calls: Mutex<usize>,
    }

    impl compose::ErofsExtractor for FakeExtractor {
        fn extract(
            &self,
            image: &Path,
            destination: &Path,
            _control: &ProcessControl,
        ) -> Result<()> {
            *self.calls.lock().unwrap() += 1;
            fs::create_dir_all(destination)?;
            let name = image.file_name().unwrap().to_string_lossy().into_owned();
            if name.contains("node") {
                fs::create_dir_all(destination.join("usr/bin"))?;
                fs::write(destination.join("usr/bin/node"), b"NODE".repeat(256))?;
            }
            if name.contains("dsh") {
                fs::create_dir_all(destination.join("srv/dsh"))?;
                fs::write(destination.join("srv/dsh/index.js"), b"DSH!".repeat(256))?;
            }
            if name.contains("conflict") {
                fs::create_dir_all(destination.join("usr/bin"))?;
                fs::write(destination.join("usr/bin/node"), b"CONFLICT")?;
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeMkfs {
        calls: Mutex<Vec<Vec<String>>>,
        devices: Mutex<usize>,
    }

    impl MkfsRunner for FakeMkfs {
        fn run(&self, args: &[String], _control: &ProcessControl) -> Result<()> {
            self.calls.lock().unwrap().push(args.to_vec());
            let chunksize = args
                .iter()
                .position(|arg| arg == "--chunksize")
                .expect("chunksize argument");
            let image = Path::new(args.get(chunksize + 2).unwrap());
            // Write a minimal superblock carrying the referenced features and
            // the expected extra-device count.
            let mut bytes = vec![0_u8; 2048];
            bytes[crate::build::import::EROFS_MAGIC_OFFSET
                ..crate::build::import::EROFS_MAGIC_OFFSET + 4]
                .copy_from_slice(&crate::build::import::EROFS_MAGIC_BYTES);
            let incompat = (EROFS_FEATURE_INCOMPAT_CHUNKED_FILE
                | EROFS_FEATURE_INCOMPAT_DEVICE_TABLE)
                .to_le_bytes();
            bytes[EROFS_INCOMPAT_OFFSET..EROFS_INCOMPAT_OFFSET + 4].copy_from_slice(&incompat);
            let devices = u16::try_from(self.device_count()).unwrap().to_le_bytes();
            bytes[EROFS_EXTRA_DEVICES_OFFSET..EROFS_EXTRA_DEVICES_OFFSET + 2]
                .copy_from_slice(&devices);
            fs::write(image, bytes)?;
            Ok(())
        }
    }

    impl FakeMkfs {
        fn device_count(&self) -> usize {
            *self.devices.lock().unwrap()
        }
    }

    fn config(env: &str) -> ImageConfig {
        ImageConfig {
            created: None,
            author: None,
            architecture: "amd64".to_string(),
            os: "linux".to_string(),
            os_version: None,
            os_features: Some(vec!["erofs".to_string()]),
            variant: None,
            config: RuntimeConfig {
                env: Some(vec![env.to_string()]),
                ..RuntimeConfig::default()
            },
            rootfs: RootFs {
                fs_type: "layers".to_string(),
                diff_ids: Vec::new(),
                extra: Map::new(),
            },
            history: Vec::new(),
            extra: Map::new(),
        }
    }

    fn source(root: &Path, name: &str, _digest_hex: char) -> ReferencedSourceInput {
        let path = root.join(name);
        let mut bytes = vec![0_u8; 2048];
        bytes[crate::build::import::EROFS_MAGIC_OFFSET
            ..crate::build::import::EROFS_MAGIC_OFFSET + 4]
            .copy_from_slice(&crate::build::import::EROFS_MAGIC_BYTES);
        bytes.extend_from_slice(name.as_bytes());
        fs::write(&path, &bytes).unwrap();
        let size = bytes.len() as u64;
        ReferencedSourceInput {
            path: path.clone(),
            layer: Descriptor {
                media_type: MEDIA_TYPE_EROFS.to_string(),
                digest: crate::digest::file_digest(&path).unwrap(),
                size,
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            },
            repository: "nession/test".to_string(),
            reference: name.to_string(),
            manifest_digest: format!("sha256:{}", "d".repeat(64)),
            platform: Platform::for_consumer("linux", "amd64", None),
            config: config("PATH=/usr/bin"),
        }
    }

    fn composer(root: &Path) -> (ErofsReferencedComposer, Arc<FakeExtractor>, Arc<FakeMkfs>) {
        let extractor = Arc::new(FakeExtractor::default());
        let mkfs = Arc::new(FakeMkfs::default());
        let composer = ErofsReferencedComposer::new(
            extractor.clone(),
            mkfs.clone(),
            BlobStore::new(root.join("blobs")).unwrap(),
            root.join("work"),
        )
        .unwrap();
        (composer, extractor, mkfs)
    }

    #[test]
    fn a_referenced_composite_records_a_distinct_manifest_and_closure() {
        let root = tempdir().unwrap();
        let node = source(root.path(), "node.erofs", 'a');
        let dsh = source(root.path(), "dsh.erofs", 'b');
        let (composer, _extractor, mkfs) = composer(root.path());
        *mkfs.devices.lock().unwrap() = 2;
        let packaging = Packaging::default();
        let control = ProcessControl::new();
        let built = composer
            .run(ReferencedBuildRequest {
                build_dir: &root.path().join("build"),
                sources: &[node.clone(), dsh.clone()],
                packaging: &packaging,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap();
        let referenced = built
            .built
            .compose
            .as_ref()
            .and_then(|compose| compose.referenced.as_ref())
            .expect("referenced metadata");
        assert_ne!(referenced.manifest_digest, built.metadata.digest);
        assert_ne!(referenced.manifest_digest, built.descriptor.digest);
        assert_eq!(
            built.descriptor_doc.closure().unwrap().len(),
            3,
            "metadata plus two backing devices"
        );
        assert_eq!(
            built
                .descriptor_doc
                .devices
                .iter()
                .map(|device| device.digest.as_str())
                .collect::<Vec<_>>(),
            vec![node.layer.digest.as_str(), dsh.layer.digest.as_str()]
        );
        let manifest = crate::oci::parse_manifest(referenced.manifest.bytes())
            .unwrap()
            .1;
        let config = crate::oci::parse_config(referenced.config.bytes())
            .unwrap()
            .1;
        crate::oci::validate_composite_manifest_config(
            &manifest,
            &config,
            &built.descriptor_doc,
            &referenced.descriptor,
        )
        .unwrap();
        assert_eq!(
            manifest
                .annotations
                .as_ref()
                .unwrap()
                .get(crate::oci::annotation::ANNOTATION_COMPOSE_FORMAT),
            Some(&COMPOSE_FORMAT_REFERENCED_V1.to_string())
        );
        assert_eq!(config.rootfs.diff_ids.len(), 3);
        assert!(config.rootfs.diff_ids[1..].contains(&node.layer.digest));
    }

    #[test]
    fn conflicting_paths_and_unsupported_layouts_fail_before_publication() {
        let root = tempdir().unwrap();
        let node = source(root.path(), "node.erofs", 'a');
        let dsh = source(root.path(), "dsh.erofs", 'b');
        let (composer, _extractor, mkfs) = composer(root.path());
        *mkfs.devices.lock().unwrap() = 2;
        let packaging = Packaging::default();
        let control = ProcessControl::new();
        let run = |sources: &[ReferencedSourceInput]| {
            composer.run(ReferencedBuildRequest {
                build_dir: &root.path().join("build"),
                sources,
                packaging: &packaging,
                control: &control,
                observer: &NoopObserver,
            })
        };
        let conflict = source(root.path(), "conflict.erofs", 'c');
        let error = run(&[node.clone(), conflict]).unwrap_err();
        assert!(format!("{error:#}").contains("both own"), "{error:#}");
        let _ = dsh;
        assert_eq!(composer.blobs.usage().unwrap().blobs, 0);

        // Same source digest twice is refused before any tool runs.
        let error = run(&[node.clone(), node]).unwrap_err();
        assert!(
            format!("{error:#}").contains("repeats an existing device"),
            "{error:#}"
        );
    }

    #[test]
    fn the_declared_device_count_must_match_the_built_metadata() {
        let root = tempdir().unwrap();
        let node = source(root.path(), "node.erofs", 'a');
        let dsh = source(root.path(), "dsh.erofs", 'b');
        let (composer, _extractor, mkfs) = composer(root.path());
        *mkfs.devices.lock().unwrap() = 1;
        let packaging = Packaging::default();
        let control = ProcessControl::new();
        let error = composer
            .run(ReferencedBuildRequest {
                build_dir: &root.path().join("build"),
                sources: &[node, dsh],
                packaging: &packaging,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("declares 1 extra devices, expected 2"),
            "{error:#}"
        );
    }

    /// The real toolchain proof: two block-addressed source EROFS images are
    /// referenced by one metadata image whose bytes are a small fraction of
    /// the sources. Repeat builds produce the same metadata and descriptor
    /// identities. A source with inline file data is refused by the pinned
    /// rebuild with an explicit compatibility diagnostic. Executed by the
    /// #3697 staging acceptance Case on a host with erofs-utils.
    #[test]
    #[ignore = "requires erofs-utils; executed by the #3697 acceptance Case"]
    fn real_referenced_composite_reuses_source_bytes_deterministically() {
        let root = tempdir().unwrap();
        let mkfs = Arc::new(crate::build::ProcessMkfsRunner::default());
        let packaging = Packaging::default();
        let mut sources = Vec::new();
        for (name, file, bytes) in [
            ("node.erofs", "usr/bin/node", b"NODE".repeat(4096)),
            ("dsh.erofs", "srv/dsh/index.js", b"DSH!".repeat(4096)),
        ] {
            let tree = root.path().join(format!("{name}-tree"));
            let path = tree.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, &bytes).unwrap();
            let image = root.path().join(name);
            mkfs.run(
                &crate::build::compose::compose_mkfs_command(&image, &tree, &packaging),
                &ProcessControl::new(),
            )
            .unwrap();
            let size = fs::metadata(&image).unwrap().len();
            sources.push(ReferencedSourceInput {
                path: image.clone(),
                layer: Descriptor {
                    media_type: MEDIA_TYPE_EROFS.to_string(),
                    digest: crate::digest::file_digest(&image).unwrap(),
                    size,
                    urls: None,
                    annotations: None,
                    platform: None,
                    artifact_type: None,
                    data: None,
                    extra: Map::new(),
                },
                repository: "nession/test".to_string(),
                reference: name.to_string(),
                manifest_digest: format!("sha256:{}", "e".repeat(64)),
                platform: Platform::for_consumer("linux", "amd64", None),
                config: config("PATH=/usr/bin"),
            });
        }
        let composer = ErofsReferencedComposer::new(
            Arc::new(compose::ProcessErofsExtractor::default()),
            mkfs.clone(),
            BlobStore::new(root.path().join("blobs")).unwrap(),
            root.path().join("work"),
        )
        .unwrap();
        let control = ProcessControl::new();
        let run = |build_dir: &Path| {
            composer.run(ReferencedBuildRequest {
                build_dir,
                sources: &sources,
                packaging: &packaging,
                control: &control,
                observer: &NoopObserver,
            })
        };
        let first = run(&root.path().join("build-a")).unwrap();
        let second = run(&root.path().join("build-b")).unwrap();
        assert_eq!(first.metadata.digest, second.metadata.digest);
        assert_eq!(first.descriptor.digest, second.descriptor.digest);
        assert_eq!(
            first
                .descriptor_doc
                .devices
                .iter()
                .map(|device| device.digest.as_str())
                .collect::<Vec<_>>(),
            sources
                .iter()
                .map(|source| source.layer.digest.as_str())
                .collect::<Vec<_>>()
        );
        assert_eq!(
            validate_metadata_image(&first.metadata.path, 2).unwrap(),
            first.metadata.size_bytes
        );
        let source_bytes = sources.iter().map(|source| source.layer.size).sum::<u64>();
        assert!(
            first.metadata.size_bytes < source_bytes / 2,
            "the metadata image reuses source bytes"
        );

        // Default v1 packaging may inline small file tails; such a source is
        // not reference-compatible and must fail closed.
        let inline_tree = root.path().join("inline-tree");
        fs::create_dir_all(inline_tree.join("bin")).unwrap();
        fs::write(inline_tree.join("bin/tiny"), b"tiny").unwrap();
        let inline_image = root.path().join("inline.erofs");
        mkfs.run(
            &crate::build::mkfs_command(&inline_image, &inline_tree, &packaging),
            &ProcessControl::new(),
        )
        .unwrap();
        let inline_size = fs::metadata(&inline_image).unwrap().len();
        let inline_source = ReferencedSourceInput {
            path: inline_image.clone(),
            layer: Descriptor {
                media_type: MEDIA_TYPE_EROFS.to_string(),
                digest: crate::digest::file_digest(&inline_image).unwrap(),
                size: inline_size,
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            },
            repository: "nession/test".to_string(),
            reference: "inline.erofs".to_string(),
            manifest_digest: format!("sha256:{}", "f".repeat(64)),
            platform: Platform::for_consumer("linux", "amd64", None),
            config: config("PATH=/usr/bin"),
        };
        let error = composer
            .run(ReferencedBuildRequest {
                build_dir: &root.path().join("build-inline"),
                sources: &[inline_source],
                packaging: &packaging,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap_err();
        let text = format!("{error:#}");
        assert!(
            text.contains("reference-compatible") || text.contains("unsupported datalayout"),
            "{text}"
        );
    }

    #[test]
    fn the_mkfs_argv_is_fixed_and_deterministic() {
        let args = referenced_mkfs_command(
            Path::new("/tmp/meta.erofs"),
            &[Path::new("/tmp/a.erofs"), Path::new("/tmp/b.erofs")],
            &Packaging::default(),
        );
        assert_eq!(
            args,
            vec![
                "-T",
                "0",
                "-U",
                "11111111-1111-4111-8111-111111111111",
                "-b",
                "4096",
                "--all-root",
                "--chunksize",
                "4096",
                "/tmp/meta.erofs",
                "/tmp/a.erofs",
                "/tmp/b.erofs",
            ]
        );
    }

    #[test]
    fn advisory_kind_conflicts_fail_closed() {
        let root = tempdir().unwrap();
        let mut node = source(root.path(), "node.erofs", 'a');
        let mut dsh = source(root.path(), "dsh.erofs", 'b');
        node.config.extra.insert(
            SOURCE_ANNOTATIONS_KEY.to_string(),
            serde_json::json!({"io.nession.kind": "base_runtime"}),
        );
        dsh.config.extra.insert(
            SOURCE_ANNOTATIONS_KEY.to_string(),
            serde_json::json!({"io.nession.kind": "tool"}),
        );
        let (composer, _extractor, mkfs) = composer(root.path());
        *mkfs.devices.lock().unwrap() = 2;
        let packaging = Packaging::default();
        let control = ProcessControl::new();
        let error = composer
            .run(ReferencedBuildRequest {
                build_dir: &root.path().join("build"),
                sources: &[node, dsh],
                packaging: &packaging,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("disagree on io.nession.kind"),
            "{error:#}"
        );
        assert_eq!(
            ImageKind::BaseRuntime.as_str(),
            "base_runtime",
            "the advisory kind vocabulary stays stable"
        );
    }
}
