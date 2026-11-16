//! Flattened immutable EROFS Image Composition (#3696).
//!
//! One Compose build consumes already-published, immutable source Images and
//! produces one self-contained raw EROFS layer plus a standard Config/Manifest.
//! The result has no runtime dependency on the source blobs.
//!
//! The mechanical recipe is deliberately conservative:
//!
//! 1. every source file is re-verified against its pinned descriptor and the
//!    raw EROFS magic before any bytes are read;
//! 2. `fsck.erofs --extract` extracts each source into a private directory
//!    (no FUSE, no privilege, no execution of image content);
//! 3. the trees are merged under validated disjoint destination prefixes with
//!    fail-closed conflict, whiteout and symlink checks;
//! 4. the merged tree is scanned once for bounds and a deterministic manifest,
//!    then packaged by the existing pinned `mkfs.erofs`;
//! 5. only after the whole chain succeeds are the bytes published into the CAS.
//!
//! A Compose build produces a different result identity from every source: the
//! output layer digest is the physical digest of the flattened bytes, while the
//! source provenance is recorded as deterministic Manifest annotations.

use anyhow::{Context, Result};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use super::import::validate_erofs_file;
use super::{
    manifest_tree, packaged_image_path, snapshot_dir, write_checkpoint, BuildObserver, BuiltImage,
    ComposeImageMetadata, ComposeRuntime, ComposeSnapshotSource, ComposeSourceProvenance,
    MkfsRunner, Packaging, ProcessControl, ResumePoint, SnapshotCheckpoint, SnapshotSource, Stage,
    TreeManifest, SNAPSHOT_CHECKPOINT_VERSION,
};
use crate::blob::store::{BlobDigest, BlobStore};
use crate::digest::file_digest;
use crate::oci::annotation::{
    ANNOTATION_COMPOSE_FORMAT, ANNOTATION_COMPOSE_SOURCES, ANNOTATION_KIND,
    ANNOTATION_MOUNT_DEFAULT, ANNOTATION_PATH_PREPEND, COMPOSE_FORMAT_FLATTENED_V1,
    MEDIA_TYPE_EROFS,
};
use crate::oci::config::ImageConfig;
use crate::oci::descriptor::{Descriptor, Platform};

/// The maximum source Images one Compose build accepts. Kept equal to the
/// Protocol Kernel's `IMAGE_COMPOSE_MAX_SOURCES`.
pub const MAX_COMPOSE_SOURCES: usize = 16;

/// One verified, pinned source Image handed to the mechanical composer.
#[derive(Debug, Clone)]
pub struct ComposeSourceInput {
    /// Verified local raw EROFS file (regular, non-symlink, inside the
    /// Server-authorized blob store).
    pub path: PathBuf,
    /// The exact pinned EROFS descriptor. The file is re-hashed against it.
    pub layer: Descriptor,
    /// Catalog Repository/reference the source was resolved from.
    pub repository: String,
    pub reference: String,
    /// The immutable Manifest revision the source was resolved to.
    pub manifest_digest: String,
    /// Empty names the composed root; otherwise a normalized absolute prefix.
    pub destination: String,
    pub platform: Platform,
    /// The source Config's standard runtime projection.
    pub config: ImageConfig,
}

/// One Compose execution request.
pub struct ComposeBuildRequest<'a> {
    /// The durable build directory this execution owns.
    pub build_dir: &'a Path,
    pub sources: &'a [ComposeSourceInput],
    pub packaging: &'a Packaging,
    pub resume: ResumePoint,
    pub control: &'a ProcessControl,
    pub observer: &'a dyn BuildObserver,
}

/// The result of one Compose execution.
#[derive(Debug, Clone)]
pub struct ComposedImage {
    pub built: BuiltImage,
    pub tree: TreeManifest,
    pub checkpoint: SnapshotCheckpoint,
}

/// Extracts one already-verified raw EROFS image into a private directory.
///
/// Production uses the pinned `fsck.erofs`; tests inject a deterministic fake
/// so conflict, determinism and failure policy are exercised without Linux.
pub trait ErofsExtractor: Send + Sync {
    fn extract(&self, image: &Path, destination: &Path, control: &ProcessControl) -> Result<()>;
}

/// The pinned `fsck.erofs` extraction helper.
#[derive(Debug, Clone)]
pub struct ProcessErofsExtractor {
    pub binary: PathBuf,
}

impl Default for ProcessErofsExtractor {
    fn default() -> Self {
        Self {
            binary: PathBuf::from("fsck.erofs"),
        }
    }
}

impl ErofsExtractor for ProcessErofsExtractor {
    fn extract(&self, image: &Path, destination: &Path, control: &ProcessControl) -> Result<()> {
        if !is_executable(&self.binary) {
            anyhow::bail!(
                "EROFS extraction helper {} is not available; a flattened Compose build requires it",
                self.binary.display()
            );
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create Compose extraction root {}",
                    parent.display()
                )
            })?;
        }
        if destination.exists() {
            fs::remove_dir_all(destination).with_context(|| {
                format!(
                    "failed to reset Compose extraction directory {}",
                    destination.display()
                )
            })?;
        }
        let mut command = std::process::Command::new(&self.binary);
        command
            .arg(format!("--extract={}", destination.display()))
            .arg("--no-preserve-owner")
            .arg("--preserve-perms")
            .arg(image)
            .env("LC_ALL", "C");
        control.execute(
            &mut command,
            &format!("{} extract {}", self.binary.display(), image.display()),
        )?;
        let metadata = fs::symlink_metadata(destination).with_context(|| {
            format!(
                "EROFS extractor produced no directory at {}",
                destination.display()
            )
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            anyhow::bail!(
                "EROFS extractor produced {} which is not a real directory",
                destination.display()
            );
        }
        Ok(())
    }
}

/// Whether `path` is an executable file, resolving a bare name through `PATH`.
fn is_executable(path: &Path) -> bool {
    let resolved = if path.is_absolute() || path.components().count() > 1 {
        Some(path.to_path_buf())
    } else {
        std::env::var_os("PATH").and_then(|value| {
            std::env::split_paths(&value)
                .map(|directory| directory.join(path))
                .find(|candidate| candidate.is_file())
        })
    };
    resolved.is_some_and(|candidate| {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::metadata(&candidate)
                .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
        }
        #[cfg(not(unix))]
        {
            candidate.is_file()
        }
    })
}

/// The one deterministic flattened Compose build.
pub struct ErofsComposer {
    pub extractor: Arc<dyn ErofsExtractor>,
    pub mkfs: Arc<dyn MkfsRunner>,
    pub blobs: BlobStore,
    pub work_root: PathBuf,
}

impl ErofsComposer {
    pub fn new(
        extractor: Arc<dyn ErofsExtractor>,
        mkfs: Arc<dyn MkfsRunner>,
        blobs: BlobStore,
        work_root: impl Into<PathBuf>,
    ) -> Result<Self> {
        let work_root = work_root.into();
        fs::create_dir_all(&work_root).with_context(|| {
            format!(
                "failed to create image compose directory {}",
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

    /// Execute one Compose build inside `request.build_dir`.
    pub fn run(&self, request: ComposeBuildRequest<'_>) -> Result<ComposedImage> {
        request.packaging.validate()?;
        if request.sources.is_empty() {
            anyhow::bail!("a compose build requires at least one source Image");
        }
        if request.sources.len() > MAX_COMPOSE_SOURCES {
            anyhow::bail!("a compose build accepts at most {MAX_COMPOSE_SOURCES} source Images");
        }
        fs::create_dir_all(request.build_dir).with_context(|| {
            format!(
                "failed to create build directory {}",
                request.build_dir.display()
            )
        })?;
        let provenance = compose_provenance(request.sources)?;
        let mut runtime = compose_runtime(request.sources)?;
        runtime.annotations = compose_annotations(
            runtime.annotations,
            &provenance,
            COMPOSE_FORMAT_FLATTENED_V1,
        )?;
        let expected = SnapshotSource::Compose {
            sources: provenance
                .iter()
                .map(|source| ComposeSnapshotSource {
                    repository: source.repository.clone(),
                    reference: source.reference.clone(),
                    manifest_digest: source.manifest_digest.clone(),
                    layer_digest: source.layer_digest.clone(),
                    destination: source.destination.clone(),
                })
                .collect(),
        };
        let checkpoint = match request.resume {
            ResumePoint::Packaging => {
                let Some(checkpoint) =
                    super::verify_snapshot(request.build_dir, &expected, request.packaging)?
                else {
                    anyhow::bail!(
                        "no validated compose snapshot checkpoint exists; this build cannot resume from packaging"
                    );
                };
                checkpoint
            }
            ResumePoint::Source => self.prepare_snapshot(&request, expected)?,
        };
        let tree = manifest_tree(&snapshot_dir(request.build_dir))?;
        if tree.digest != checkpoint.manifest
            || tree.stats.entries != checkpoint.entries
            || tree.stats.files != checkpoint.files
            || tree.stats.bytes != checkpoint.bytes
        {
            anyhow::bail!("compose snapshot does not match its checkpoint");
        }
        let blob = self.package(&request)?;
        Ok(ComposedImage {
            built: BuiltImage {
                blob,
                source_sha: None,
                packaging: request.packaging.clone(),
                compose: Some(ComposeImageMetadata {
                    runtime,
                    sources: provenance,
                    referenced: None,
                }),
            },
            tree,
            checkpoint,
        })
    }

    fn prepare_snapshot(
        &self,
        request: &ComposeBuildRequest<'_>,
        expected: SnapshotSource,
    ) -> Result<SnapshotCheckpoint> {
        let snapshot = snapshot_dir(request.build_dir);
        if snapshot.exists() {
            // Every source is immutable and pinned, so re-extraction is
            // deterministic. A partially written scratch tree is never reused.
            fs::remove_dir_all(&snapshot).with_context(|| {
                format!("failed to reset compose snapshot {}", snapshot.display())
            })?;
        }
        fs::create_dir_all(&snapshot)?;
        let scratch_root = request.build_dir.join("compose-sources");
        if scratch_root.exists() {
            fs::remove_dir_all(&scratch_root)?;
        }
        fs::create_dir_all(&scratch_root)?;

        request.observer.stage(Stage::Snapshotting);
        for (position, source) in request.sources.iter().enumerate() {
            if request.control.is_canceled() {
                anyhow::bail!("build was canceled");
            }
            let label = format!("{}:{}", source.repository, source.reference);
            verify_source_file(source).with_context(|| {
                format!("compose source {label} is not the pinned verified EROFS layer")
            })?;
            let scratch = scratch_root.join(format!("source-{position}"));
            self.extractor
                .extract(&source.path, &scratch, request.control)
                .with_context(|| format!("compose source {label} could not be extracted"))?;
            let destination = destination_relative(&source.destination)?;
            merge_tree(
                &scratch,
                &snapshot,
                &snapshot.join(&destination),
                &snapshot,
                &label,
            )
            .with_context(|| {
                format!(
                    "compose source {label} conflicts at destination {:?}",
                    source.destination
                )
            })?;
            fs::remove_dir_all(&scratch).ok();
        }
        fs::remove_dir_all(&scratch_root).ok();

        request.observer.stage(Stage::Validating);
        let manifest = manifest_tree(&snapshot)?;
        request.observer.progress(&manifest.stats);
        let checkpoint = SnapshotCheckpoint {
            version: SNAPSHOT_CHECKPOINT_VERSION,
            source: expected,
            packaging: request.packaging.clone(),
            pinned_sha: None,
            manifest: manifest.digest,
            entries: manifest.stats.entries,
            files: manifest.stats.files,
            bytes: manifest.stats.bytes,
        };
        write_checkpoint(request.build_dir, &checkpoint)?;
        request.observer.snapshot_ready(&checkpoint);
        Ok(checkpoint)
    }

    fn package(&self, request: &ComposeBuildRequest<'_>) -> Result<BlobDigest> {
        if request.control.is_canceled() {
            anyhow::bail!("build was canceled");
        }
        request.observer.stage(Stage::Packaging);
        let image = packaged_image_path(request.build_dir);
        super::discard_packaged_image(request.build_dir)?;
        let args =
            compose_mkfs_command(&image, &snapshot_dir(request.build_dir), request.packaging);
        self.mkfs.run(&args, request.control)?;
        let metadata = fs::metadata(&image)
            .with_context(|| format!("mkfs.erofs produced no image at {}", image.display()))?;
        if metadata.len() == 0 {
            anyhow::bail!("mkfs.erofs produced an empty image");
        }
        if request.control.is_canceled() {
            anyhow::bail!("build was canceled");
        }
        request.observer.stage(Stage::Publishing);
        if request.control.is_canceled() {
            anyhow::bail!("build was canceled");
        }
        let blob = self.blobs.put_file(&image)?;
        self.blobs.verify(&blob.digest)?;
        Ok(blob)
    }
}

/// The exact `mkfs.erofs` argv a flattened Compose emits.
///
/// `--all-root` makes ownership independent of the build host user;
/// `-E noinline_data` keeps every file data block addressable so a later
/// referenced composition can reuse these bytes.
pub fn compose_mkfs_command(image: &Path, root: &Path, packaging: &Packaging) -> Vec<String> {
    let mut args = vec![
        "-T".to_string(),
        packaging.fixed_timestamp.to_string(),
        "-U".to_string(),
        packaging.fixed_uuid.clone(),
        "-b".to_string(),
        packaging.block_size.to_string(),
        "--all-root".to_string(),
        "-E".to_string(),
        "noinline_data".to_string(),
    ];
    if packaging.compression != "none" {
        args.push("-z".to_string());
        args.push(packaging.compression.clone());
    }
    args.push(image.to_string_lossy().into_owned());
    args.push(root.to_string_lossy().into_owned());
    args
}

pub(crate) fn verify_source_file(source: &ComposeSourceInput) -> Result<()> {
    verify_layer_file(&source.path, &source.layer)
}

/// Verify one local EROFS file against a pinned descriptor.
pub(crate) fn verify_layer_file(path: &Path, layer: &Descriptor) -> Result<()> {
    if layer.media_type != MEDIA_TYPE_EROFS {
        anyhow::bail!(
            "source layer media type {:?} is not {MEDIA_TYPE_EROFS}",
            layer.media_type
        );
    }
    let metadata = fs::symlink_metadata(path)
        .with_context(|| format!("source image {} is unreadable", path.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        anyhow::bail!(
            "source image {} must be a regular file, not a symlink",
            path.display()
        );
    }
    if metadata.len() != layer.size {
        anyhow::bail!(
            "source image {} is {} bytes, its pinned descriptor claims {}",
            path.display(),
            metadata.len(),
            layer.size
        );
    }
    let actual = file_digest(path)
        .with_context(|| format!("source image {} cannot be verified", path.display()))?;
    if actual != layer.digest {
        anyhow::bail!(
            "source image {} hashes to {actual}, its pinned descriptor claims {}",
            path.display(),
            layer.digest
        );
    }
    validate_erofs_file(path).context("source image is not a raw EROFS image")?;
    Ok(())
}

/// The canonical, deterministically ordered provenance of a Compose build.
pub(crate) fn compose_provenance(
    sources: &[ComposeSourceInput],
) -> Result<Vec<ComposeSourceProvenance>> {
    let mut provenance = sources
        .iter()
        .map(|source| ComposeSourceProvenance {
            repository: source.repository.clone(),
            reference: source.reference.clone(),
            manifest_digest: source.manifest_digest.clone(),
            layer_digest: source.layer.digest.clone(),
            size_bytes: source.layer.size,
            destination: source.destination.clone(),
        })
        .collect::<Vec<_>>();
    provenance.sort_by(|left, right| {
        left.destination
            .cmp(&right.destination)
            .then_with(|| left.repository.cmp(&right.repository))
            .then_with(|| left.reference.cmp(&right.reference))
    });
    for pair in provenance.windows(2) {
        let (Some(left), Some(right)) = (pair.first(), pair.get(1)) else {
            continue;
        };
        if left.destination.is_empty() && right.destination.is_empty() {
            anyhow::bail!("two compose sources cannot both claim the composed root");
        }
        if right.destination == left.destination {
            anyhow::bail!(
                "compose sources {:?} and {:?} share destination {:?}",
                left.reference,
                right.reference,
                right.destination
            );
        }
        if !left.destination.is_empty()
            && right
                .destination
                .strip_prefix(&left.destination)
                .is_some_and(|rest| rest.starts_with('/'))
        {
            anyhow::bail!(
                "compose destinations {:?} and {:?} overlap",
                left.destination,
                right.destination
            );
        }
    }
    Ok(provenance)
}

/// Merge source Configs with a fail-closed deterministic rule.
pub(crate) fn compose_runtime(sources: &[ComposeSourceInput]) -> Result<ComposeRuntime> {
    let mut env: BTreeMap<String, String> = BTreeMap::new();
    let mut entrypoint: Option<Vec<String>> = None;
    let mut cmd: Option<Vec<String>> = None;
    let mut working_dir: Option<String> = None;
    let mut kind: Option<String> = None;
    let mut mount_default: Option<String> = None;
    let mut path_prepend: Option<String> = None;

    for source in sources {
        let label = format!("{}:{}", source.repository, source.reference);
        if source.platform.architecture.trim().is_empty() || source.platform.os.trim().is_empty() {
            anyhow::bail!("compose source {label} has no platform os/architecture");
        }
        if let Some(reference) = sources.first() {
            if reference.platform.os != source.platform.os
                || reference.platform.architecture != source.platform.architecture
                || reference.platform.variant != source.platform.variant
            {
                anyhow::bail!(
                    "compose source {label} targets {}/{} variant {:?}, not the first source's {}/{} variant {:?}",
                    source.platform.os,
                    source.platform.architecture,
                    source.platform.variant,
                    reference.platform.os,
                    reference.platform.architecture,
                    reference.platform.variant
                );
            }
        }
        for variable in source.config.env() {
            let Some((name, value)) = variable.split_once('=') else {
                anyhow::bail!("compose source {label} Env entry {variable:?} is not KEY=VALUE");
            };
            if name.is_empty() {
                anyhow::bail!("compose source {label} Env entry {variable:?} has an empty name");
            }
            match env.get(name) {
                Some(existing) if existing != value => {
                    anyhow::bail!(
                        "compose sources disagree on Env {name}: {existing:?} versus {value:?}"
                    );
                }
                _ => {
                    env.insert(name.to_string(), value.to_string());
                }
            }
        }
        merge_optional(
            &mut entrypoint,
            source.config.config.entrypoint.clone(),
            &format!("compose sources disagree on Entrypoint for {label}"),
        )?;
        merge_optional(
            &mut cmd,
            source.config.config.cmd.clone(),
            &format!("compose sources disagree on Cmd for {label}"),
        )?;
        merge_optional(
            &mut working_dir,
            source.config.config.working_dir.clone(),
            &format!("compose sources disagree on WorkingDir for {label}"),
        )?;

        let annotations = source_annotations(&source.config)?;
        merge_optional(
            &mut kind,
            annotations.get(ANNOTATION_KIND).cloned(),
            &format!("compose sources disagree on {ANNOTATION_KIND}"),
        )?;
        merge_optional(
            &mut mount_default,
            annotations.get(ANNOTATION_MOUNT_DEFAULT).cloned(),
            &format!("compose sources disagree on {ANNOTATION_MOUNT_DEFAULT}"),
        )?;
        merge_optional(
            &mut path_prepend,
            annotations.get(ANNOTATION_PATH_PREPEND).cloned(),
            &format!("compose sources disagree on {ANNOTATION_PATH_PREPEND}"),
        )?;
    }

    let mut annotations = BTreeMap::new();
    if let Some(kind) = kind {
        annotations.insert(ANNOTATION_KIND.to_string(), kind);
    }
    if let Some(mount_default) = mount_default {
        annotations.insert(ANNOTATION_MOUNT_DEFAULT.to_string(), mount_default);
    }
    if let Some(path_prepend) = path_prepend {
        annotations.insert(ANNOTATION_PATH_PREPEND.to_string(), path_prepend);
    }
    Ok(ComposeRuntime {
        env: env
            .into_iter()
            .map(|(name, value)| format!("{name}={value}"))
            .collect(),
        entrypoint,
        cmd,
        working_dir,
        annotations,
    })
}

/// Attach the Compose format and pinned source provenance to advisory
/// annotations.
pub(crate) fn compose_annotations(
    mut annotations: BTreeMap<String, String>,
    provenance: &[ComposeSourceProvenance],
    format: &str,
) -> Result<BTreeMap<String, String>> {
    annotations.insert(ANNOTATION_COMPOSE_FORMAT.to_string(), format.to_string());
    annotations.insert(
        ANNOTATION_COMPOSE_SOURCES.to_string(),
        serde_json::to_string(provenance).context("compose provenance could not be encoded")?,
    );
    Ok(annotations)
}

fn merge_optional<T: PartialEq>(
    slot: &mut Option<T>,
    value: Option<T>,
    conflict: &str,
) -> Result<()> {
    let Some(value) = value else {
        return Ok(());
    };
    match slot {
        Some(existing) if existing != &value => anyhow::bail!("{conflict}"),
        Some(_) => {}
        None => *slot = Some(value),
    }
    Ok(())
}

/// Reparse a source image's advisory annotations from its Config extensions?
///
/// The standard Config does not carry annotations; the Manifest does. The
/// Server adapter reads the Manifest annotations and passes them through the
/// Config's `extra` under the reserved `io.nession.source.annotations` key? No:
/// the caller supplies them separately. Here we read the advisory projection
/// the Server copies into `Config.extra` so the crate stays wire-free.
fn source_annotations(config: &ImageConfig) -> Result<BTreeMap<String, String>> {
    let Some(value) = config.extra.get(SOURCE_ANNOTATIONS_KEY) else {
        return Ok(BTreeMap::new());
    };
    let annotations: BTreeMap<String, String> = serde_json::from_value(value.clone())
        .context("compose source annotations are not a string map")?;
    Ok(annotations)
}

/// The reserved Config extension key carrying a source Manifest's advisory
/// annotations into the mechanical composer without a wire dependency.
pub const SOURCE_ANNOTATIONS_KEY: &str = "io.nession.source.annotations";

fn destination_relative(destination: &str) -> Result<PathBuf> {
    let trimmed = destination.trim();
    if trimmed.is_empty() || trimmed == "/" {
        return Ok(PathBuf::new());
    }
    if !trimmed.starts_with('/') {
        anyhow::bail!("compose destination {trimmed:?} must be absolute");
    }
    let mut relative = PathBuf::new();
    for segment in trimmed[1..].split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            anyhow::bail!("compose destination {trimmed:?} is not normalized");
        }
        relative.push(segment);
    }
    Ok(relative)
}

fn merge_tree(
    from: &Path,
    root: &Path,
    to: &Path,
    composed_root: &Path,
    label: &str,
) -> Result<()> {
    if entry_is_whiteout(from) {
        anyhow::bail!(
            "compose source {label} contains overlay whiteout metadata {}",
            display_relative(from, root)
        );
    }
    let metadata = fs::symlink_metadata(from)
        .with_context(|| format!("source entry {} is unreadable", from.display()))?;
    if metadata.file_type().is_symlink() {
        let target = fs::read_link(from)?;
        validate_symlink_target(&target, to, composed_root)?;
        if fs::symlink_metadata(to).is_ok() {
            anyhow::bail!(
                "compose source {label} would overwrite {}",
                display_relative(to, root)
            );
        }
        create_symlink(&target, to)?;
        return Ok(());
    }
    if metadata.is_dir() {
        match fs::symlink_metadata(to) {
            Ok(existing) if existing.is_dir() && !existing.file_type().is_symlink() => {}
            Ok(_) => anyhow::bail!(
                "compose source {label} needs directory {} but a non-directory exists",
                display_relative(to, root)
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir_all(to)?;
            }
            Err(error) => {
                return Err(error).with_context(|| format!("cannot inspect {}", to.display()));
            }
        }
        let mut entries = fs::read_dir(from)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            merge_tree(
                &entry.path(),
                root,
                &to.join(entry.file_name()),
                composed_root,
                label,
            )?;
        }
        return Ok(());
    }
    if metadata.is_file() {
        if fs::symlink_metadata(to).is_ok() {
            anyhow::bail!(
                "compose source {label} would overwrite {}",
                display_relative(to, root)
            );
        }
        fs::copy(from, to).with_context(|| {
            format!(
                "failed to copy compose source file {} to {}",
                from.display(),
                to.display()
            )
        })?;
        fs::set_permissions(to, metadata.permissions())?;
        return Ok(());
    }
    anyhow::bail!(
        "compose source {label} contains a special file {}",
        display_relative(from, root)
    )
}

pub(crate) fn entry_is_whiteout(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(".wh."))
}

pub(crate) fn display_relative(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .map(|relative| format!("/{}", relative.display()))
        .unwrap_or_else(|_| path.display().to_string())
}

pub(crate) fn validate_symlink_target(
    target: &Path,
    link: &Path,
    composed_root: &Path,
) -> Result<()> {
    if target.as_os_str().is_empty() {
        anyhow::bail!("compose source contains an empty symlink target");
    }
    let text = target.to_string_lossy();
    if text.chars().any(char::is_control) {
        anyhow::bail!("compose source symlink target contains control characters");
    }
    if target.is_absolute() {
        // The target is resolved inside the composed filesystem, never on the
        // build host. It must still be a normalized absolute path.
        for component in target.components() {
            match component {
                Component::RootDir | Component::Normal(_) => {}
                _ => anyhow::bail!(
                    "compose source symlink target {text:?} is not a normalized absolute path"
                ),
            }
        }
        return Ok(());
    }
    let parent = link.parent().unwrap_or(composed_root);
    let resolved = normalize_without_fs(&parent.join(target));
    if !resolved.starts_with(composed_root) {
        anyhow::bail!("compose source symlink target {text:?} escapes the composed root");
    }
    Ok(())
}

fn normalize_without_fs(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[cfg(unix)]
fn create_symlink(target: &Path, link: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, link)
        .with_context(|| format!("failed to recreate symlink {}", link.display()))
}

#[cfg(not(unix))]
fn create_symlink(_target: &Path, _link: &Path) -> Result<()> {
    anyhow::bail!("symlinks in a compose source are not supported on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::build::NoopObserver;
    use crate::oci::annotation::{ImageKind, ANNOTATION_COMPOSE_FORMAT, ANNOTATION_KIND};
    use crate::oci::config::{RootFs, RuntimeConfig};
    use serde_json::Map;
    use std::sync::Mutex;
    use tempfile::tempdir;

    #[derive(Default)]
    struct FakeExtractor {
        calls: Mutex<Vec<(PathBuf, PathBuf)>>,
    }

    impl ErofsExtractor for FakeExtractor {
        fn extract(
            &self,
            image: &Path,
            destination: &Path,
            _control: &ProcessControl,
        ) -> Result<()> {
            self.calls
                .lock()
                .unwrap()
                .push((image.to_path_buf(), destination.to_path_buf()));
            // The fixture image name selects the tree. A real EROFS image is
            // produced by the pinned `#[ignore]` integration proof.
            fs::create_dir_all(destination)?;
            let name = image.file_name().unwrap().to_string_lossy().into_owned();
            if name.contains("base") {
                fs::create_dir_all(destination.join("usr/bin"))?;
                fs::write(destination.join("usr/bin/sh"), b"#!/bin/sh\n")?;
                fs::write(destination.join("root-marker"), b"base")?;
                set_mode(&destination.join("usr/bin/sh"), 0o755);
            }
            if name.contains("tool") {
                fs::create_dir_all(destination.join("bin"))?;
                fs::write(destination.join("bin/tool"), b"tool")?;
                set_mode(&destination.join("bin/tool"), 0o755);
            }
            Ok(())
        }
    }

    fn set_mode(path: &Path, mode: u32) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    }

    #[derive(Default)]
    struct FakeMkfs {
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl MkfsRunner for FakeMkfs {
        fn run(&self, args: &[String], _control: &ProcessControl) -> Result<()> {
            self.calls.lock().unwrap().push(args.to_vec());
            let image = Path::new(args.get(args.len() - 2).unwrap());
            let root = Path::new(args.last().unwrap());
            let mut bytes = Vec::new();
            collect_bytes(root, &mut bytes)?;
            fs::write(image, bytes)?;
            Ok(())
        }
    }

    fn collect_bytes(current: &Path, out: &mut Vec<u8>) -> Result<()> {
        let mut entries = fs::read_dir(current)?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let path = entry.path();
            out.extend_from_slice(entry.file_name().to_string_lossy().as_bytes());
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.is_dir() {
                collect_bytes(&path, out)?;
            } else if metadata.is_file() {
                out.extend_from_slice(&fs::read(&path)?);
            } else if metadata.file_type().is_symlink() {
                out.extend_from_slice(fs::read_link(&path)?.to_string_lossy().as_bytes());
            }
        }
        Ok(())
    }

    fn config(env: &[&str], entrypoint: Option<&[&str]>) -> ImageConfig {
        ImageConfig {
            created: None,
            author: None,
            architecture: "amd64".to_string(),
            os: "linux".to_string(),
            os_version: None,
            os_features: Some(vec!["erofs".to_string()]),
            variant: None,
            config: RuntimeConfig {
                env: (!env.is_empty())
                    .then(|| env.iter().map(|value| (*value).to_string()).collect()),
                entrypoint: entrypoint
                    .map(|values| values.iter().map(|value| (*value).to_string()).collect()),
                ..RuntimeConfig::default()
            },
            rootfs: RootFs {
                fs_type: "layers".to_string(),
                diff_ids: vec![
                    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                        .to_string(),
                ],
                extra: Map::new(),
            },
            history: Vec::new(),
            extra: Map::new(),
        }
    }

    fn source(
        root: &Path,
        name: &str,
        destination: &str,
        config: ImageConfig,
    ) -> ComposeSourceInput {
        let path = root.join(name);
        let mut bytes = vec![0_u8; 2048];
        bytes[crate::build::import::EROFS_MAGIC_OFFSET
            ..crate::build::import::EROFS_MAGIC_OFFSET + 4]
            .copy_from_slice(&crate::build::import::EROFS_MAGIC_BYTES);
        bytes.extend_from_slice(name.as_bytes());
        fs::write(&path, bytes).unwrap();
        let digest = file_digest(&path).unwrap();
        let size = fs::metadata(&path).unwrap().len();
        ComposeSourceInput {
            path,
            layer: Descriptor {
                media_type: MEDIA_TYPE_EROFS.to_string(),
                digest,
                size,
                urls: None,
                annotations: None,
                platform: None,
                artifact_type: None,
                data: None,
                extra: Map::new(),
            },
            repository: "nession/test".to_string(),
            reference: "latest".to_string(),
            manifest_digest: format!("sha256:{}", "b".repeat(64)),
            destination: destination.to_string(),
            platform: Platform {
                architecture: "amd64".to_string(),
                os: "linux".to_string(),
                os_features: Some(vec!["erofs".to_string()]),
                ..Platform::default()
            },
            config,
        }
    }

    fn composer(root: &Path) -> (ErofsComposer, Arc<FakeExtractor>, Arc<FakeMkfs>) {
        let extractor = Arc::new(FakeExtractor::default());
        let mkfs = Arc::new(FakeMkfs::default());
        let composer = ErofsComposer::new(
            extractor.clone(),
            mkfs.clone(),
            BlobStore::new(root.join("blobs")).unwrap(),
            root.join("work"),
        )
        .unwrap();
        (composer, extractor, mkfs)
    }

    #[test]
    fn two_sources_at_disjoint_prefixes_flatten_deterministically() {
        let root = tempdir().unwrap();
        let sources = [
            source(
                root.path(),
                "base.erofs",
                "",
                config(&["PATH=/usr/bin", "A=1"], None),
            ),
            source(
                root.path(),
                "tool.erofs",
                "/opt/tool",
                config(&["PATH=/usr/bin", "A=1"], None),
            ),
        ];
        let (composer, _extractor, mkfs) = composer(root.path());
        let packaging = Packaging::default();
        let control = ProcessControl::new();
        let run = |build_dir: &Path| {
            composer.run(ComposeBuildRequest {
                build_dir,
                sources: &sources,
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
        };
        let first = run(&root.path().join("build-1")).unwrap();
        let second = run(&root.path().join("build-2")).unwrap();
        assert_eq!(first.built.blob.digest, second.built.blob.digest);
        assert_eq!(first.tree.stats.files, 3);
        // Root source marker plus the prefixed tool marker.
        assert_eq!(
            fs::read(root.path().join("build-1/snapshot/opt/tool/bin/tool")).unwrap(),
            b"tool"
        );
        assert_eq!(
            fs::read(root.path().join("build-1/snapshot/root-marker")).unwrap(),
            b"base"
        );
        let calls = mkfs.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        assert!(calls[0].contains(&"--all-root".to_string()));
        assert!(calls[0].contains(&"noinline_data".to_string()));
        let metadata = first.built.compose.expect("compose metadata");
        assert_eq!(metadata.runtime.env, vec!["A=1", "PATH=/usr/bin"]);
        assert_eq!(
            metadata.runtime.annotations.get(ANNOTATION_COMPOSE_FORMAT),
            Some(&COMPOSE_FORMAT_FLATTENED_V1.to_string())
        );
        assert_eq!(metadata.sources.len(), 2);
    }

    #[test]
    fn overlapping_or_escaping_sources_fail_before_any_publication() {
        let root = tempdir().unwrap();
        let base = source(root.path(), "base.erofs", "", config(&[], None));
        let (compose_builder, _, _) = composer(root.path());
        let packaging = Packaging::default();
        let control = ProcessControl::new();
        let error = compose_builder
            .run(ComposeBuildRequest {
                build_dir: &root.path().join("overlap"),
                sources: &[base.clone(), base],
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("cannot both claim the composed root"),
            "{error:#}"
        );
        // No output blob was published.
        assert_eq!(compose_builder.blobs.usage().unwrap().blobs, 0);
    }

    #[test]
    fn conflicting_env_or_commands_fail_closed() {
        let root = tempdir().unwrap();
        let first = source(root.path(), "base.erofs", "", config(&["A=1"], None));
        let second = source(
            root.path(),
            "tool.erofs",
            "/opt/tool",
            config(&["A=2"], None),
        );
        let (compose_builder, _, _) = composer(root.path());
        let packaging = Packaging::default();
        let control = ProcessControl::new();
        let error = compose_builder
            .run(ComposeBuildRequest {
                build_dir: &root.path().join("conflict"),
                sources: &[first, second],
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("disagree on Env A"),
            "{error:#}"
        );

        let root = tempdir().unwrap();
        let first = source(
            root.path(),
            "base.erofs",
            "",
            config(&[], Some(&["/bin/sh"])),
        );
        let second = source(
            root.path(),
            "tool.erofs",
            "/opt/tool",
            config(&[], Some(&["/bin/tool"])),
        );
        let (compose_builder, _, _) = composer(root.path());
        let error = compose_builder
            .run(ComposeBuildRequest {
                build_dir: &root.path().join("commands"),
                sources: &[first, second],
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("disagree on Entrypoint"),
            "{error:#}"
        );
    }

    #[test]
    fn a_source_file_that_does_not_match_its_pinned_descriptor_is_refused() {
        let root = tempdir().unwrap();
        let mut source = source(root.path(), "base.erofs", "", config(&[], None));
        fs::write(&source.path, b"tampered").unwrap();
        source.layer.size = 8;
        let (compose_builder, _, _) = composer(root.path());
        let packaging = Packaging::default();
        let control = ProcessControl::new();
        let error = compose_builder
            .run(ComposeBuildRequest {
                build_dir: &root.path().join("tampered"),
                sources: &[source],
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap_err();
        assert!(format!("{error:#}").contains("hashes to"), "{error:#}");
        assert_eq!(compose_builder.blobs.usage().unwrap().blobs, 0);
    }

    #[test]
    fn a_verified_snapshot_resumes_packaging_without_sources() {
        let root = tempdir().unwrap();
        let sources = [source(root.path(), "base.erofs", "", config(&[], None))];
        let (composer, _extractor, _mkfs) = composer(root.path());
        let packaging = Packaging::default();
        let control = ProcessControl::new();
        let build_dir = root.path().join("resume");
        let first = composer
            .run(ComposeBuildRequest {
                build_dir: &build_dir,
                sources: &sources,
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap();
        fs::remove_file(&sources[0].path).unwrap();
        let second = composer
            .run(ComposeBuildRequest {
                build_dir: &build_dir,
                sources: &sources,
                packaging: &packaging,
                resume: ResumePoint::Packaging,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap();
        assert_eq!(first.built.blob.digest, second.built.blob.digest);
    }

    #[test]
    fn an_advisory_kind_is_retained_only_when_sources_agree() {
        let root = tempdir().unwrap();
        let mut first = source(root.path(), "base.erofs", "", config(&[], None));
        first.config.extra.insert(
            SOURCE_ANNOTATIONS_KEY.to_string(),
            serde_json::json!({"io.nession.kind": "directory"}),
        );
        let (composer, _, _) = composer(root.path());
        let packaging = Packaging::default();
        let control = ProcessControl::new();
        let built = composer
            .run(ComposeBuildRequest {
                build_dir: &root.path().join("kind"),
                sources: &[first.clone()],
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap();
        let metadata = built.built.compose.expect("compose metadata");
        assert_eq!(
            metadata.runtime.annotations.get(ANNOTATION_KIND),
            Some(&ImageKind::Directory.as_str().to_string())
        );
        assert_eq!(built.tree.stats.files, 2);

        let mut second = source(root.path(), "tool.erofs", "/opt/tool", config(&[], None));
        second.config.extra.insert(
            SOURCE_ANNOTATIONS_KEY.to_string(),
            serde_json::json!({"io.nession.kind": "tool"}),
        );
        let error = composer
            .run(ComposeBuildRequest {
                build_dir: &root.path().join("kind-conflict"),
                sources: &[first, second],
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
            .unwrap_err();
        assert!(
            format!("{error:#}").contains("disagree on io.nession.kind"),
            "{error:#}"
        );
    }

    /// The real toolchain proof: two raw EROFS source images are extracted by
    /// `fsck.erofs`, merged at disjoint prefixes and packaged by `mkfs.erofs`.
    /// Deterministic digest on repeat build and the EROFS superblock magic are
    /// asserted. Executed by the #3696 staging acceptance Case on a Linux host
    /// with erofs-utils installed; ignored in ordinary unit runs.
    #[test]
    #[ignore = "requires erofs-utils; executed by the #3696 acceptance Case"]
    fn real_erofs_compose_is_deterministic_and_mountable_metadata() {
        let root = tempdir().unwrap();
        let mkfs = Arc::new(crate::build::ProcessMkfsRunner::default());
        let base_dir = root.path().join("base-src");
        let tool_dir = root.path().join("tool-src");
        fs::create_dir_all(base_dir.join("usr/bin")).unwrap();
        fs::create_dir_all(tool_dir.join("bin")).unwrap();
        fs::write(base_dir.join("usr/bin/sh"), b"#!/bin/sh\n").unwrap();
        fs::write(tool_dir.join("bin/tool"), b"tool-binary\n").unwrap();
        set_mode(&base_dir.join("usr/bin/sh"), 0o755);
        set_mode(&tool_dir.join("bin/tool"), 0o755);
        let packaging = Packaging::default();
        let mut sources = Vec::new();
        for (name, dir, destination) in [
            ("base.erofs", &base_dir, ""),
            ("tool.erofs", &tool_dir, "/opt/tool"),
        ] {
            let image = root.path().join(name);
            mkfs.run(
                &crate::build::mkfs_command(&image, dir, &packaging),
                &ProcessControl::new(),
            )
            .unwrap();
            let digest = file_digest(&image).unwrap();
            let size = fs::metadata(&image).unwrap().len();
            sources.push(ComposeSourceInput {
                path: image,
                layer: Descriptor {
                    media_type: MEDIA_TYPE_EROFS.to_string(),
                    digest,
                    size,
                    urls: None,
                    annotations: None,
                    platform: None,
                    artifact_type: None,
                    data: None,
                    extra: Map::new(),
                },
                repository: "nession/test".to_string(),
                reference: "latest".to_string(),
                manifest_digest: format!("sha256:{}", "c".repeat(64)),
                destination: destination.to_string(),
                platform: Platform {
                    architecture: "amd64".to_string(),
                    os: "linux".to_string(),
                    os_features: Some(vec!["erofs".to_string()]),
                    ..Platform::default()
                },
                config: config(&[], None),
            });
        }
        let composer = ErofsComposer::new(
            Arc::new(ProcessErofsExtractor::default()),
            mkfs,
            BlobStore::new(root.path().join("blobs")).unwrap(),
            root.path().join("work"),
        )
        .unwrap();
        let control = ProcessControl::new();
        let run = |build_dir: &Path| {
            composer.run(ComposeBuildRequest {
                build_dir,
                sources: &sources,
                packaging: &packaging,
                resume: ResumePoint::Source,
                control: &control,
                observer: &NoopObserver,
            })
        };
        let first = run(&root.path().join("build-a")).unwrap();
        let second = run(&root.path().join("build-b")).unwrap();
        assert_eq!(first.built.blob.digest, second.built.blob.digest);
        let image = fs::read(&first.built.blob.path).unwrap();
        assert_eq!(
            image.get(1024..1028),
            Some([0xe2_u8, 0xe1, 0xf5, 0xe0].as_slice()),
            "EROFS superblock magic"
        );
    }

    #[test]
    fn symlink_and_whiteout_fixtures_are_validated_before_packaging() {
        let root = tempdir().unwrap();
        let source = source(root.path(), "base.erofs", "", config(&[], None));
        let staging = root.path().join("staging");
        fs::create_dir_all(staging.join("safe")).unwrap();
        fs::write(staging.join("safe/dir"), b"").unwrap();
        let link = staging.join("safe/link");
        std::os::unix::fs::symlink("../dir", &link).unwrap();
        validate_symlink_target(Path::new("../dir"), &link, &staging).unwrap();
        let escape = staging.join("safe/escape");
        std::os::unix::fs::symlink("../../../../etc/passwd", &escape).unwrap();
        assert!(
            validate_symlink_target(Path::new("../../../../etc/passwd"), &escape, &staging)
                .is_err()
        );
        // Absolute links are filesystem-internal and stay allowed.
        validate_symlink_target(Path::new("/usr/bin/env"), &link, &staging).unwrap();
        assert!(entry_is_whiteout(Path::new("/x/.wh.deleted")));
        assert!(!entry_is_whiteout(Path::new("/x/whiteout")));
        let _ = source;
    }
}
