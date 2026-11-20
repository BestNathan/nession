//! #4160: trusted generic single-tool, multi-platform OCI release adapter.
//! Tool-specific code and executable probes never run with Registry write credentials.
use anyhow::{ensure, Context, Result};
use nession_erofs::oci::annotation::{
    ANNOTATION_KIND, ANNOTATION_PATH_PREPEND, MEDIA_TYPE_CONFIG, MEDIA_TYPE_EROFS,
    MEDIA_TYPE_MANIFEST, MEDIA_TYPE_INDEX,
};
use nession_erofs::oci::{Descriptor, Index, Platform, parse_index, parse_manifest, to_bytes, validate_index};
use nession_erofs::registry::{
    push_image, RegistryAuthority, RegistryClient, RegistryConfig, RegistryCredential,
    RegistryCredentialProvider, RegistryError, RemoteReference,
};
use nession_erofs::{
    image_documents, validate_erofs_file, BlobStore, ErofsBuilder, Packaging,
    ProcessGitRunner, ProcessMkfsRunner,
};
use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

const FINGERPRINT_KEY: &str = "io.nession.toolchain.build-fingerprint";
const SOURCE_SHA_KEY: &str = "io.nession.toolchain.catalog-sha";
const REMOTE_REPOSITORY: &str = "bestnathan/nession-toolchain";

struct Credentials { actor: String, token: String }
impl RegistryCredentialProvider for Credentials {
    fn credential_for(&self, authority: &RegistryAuthority, repository: &str) -> Option<RegistryCredential> {
        (authority.scheme == "https" && authority.host == "ghcr.io" && repository == REMOTE_REPOSITORY)
            .then(|| RegistryCredential::new(self.actor.clone(), self.token.clone()).ok()).flatten()
    }
}
fn client() -> Result<RegistryClient> {
    ensure!(env::var("GITHUB_REPOSITORY").as_deref() == Ok("BestNathan/nession"), "wrong GHCR owner");
    let token=env::var("GHCR_TOKEN").context("missing GHCR_TOKEN")?;
    let actor=env::var("GHCR_ACTOR").context("missing GHCR_ACTOR")?;
    ensure!(!token.is_empty() && !actor.is_empty(), "empty credentials");
    let mut config=RegistryConfig::new("https://ghcr.io")?;
    config.allowed_redirect_hosts=vec!["pkg-containers.githubusercontent.com".to_string()];
    Ok(RegistryClient::new(config,Arc::new(Credentials{actor,token}))?)
}

#[derive(Clone)]
struct Release { tool: String, version: String, fingerprint: String, source_sha: String, targets: Vec<Platform> }
impl Release {
    fn from_env() -> Result<Self> {
        let tool=env::var("TOOLCHAIN_TOOL")?;
        let version=env::var("TOOLCHAIN_VERSION")?;
        let fingerprint=env::var("TOOLCHAIN_FINGERPRINT")?;
        let source_sha=env::var("TOOLCHAIN_CATALOG_SHA")?;
        for v in [&tool,&version] {
            ensure!(!v.is_empty() && v.len()<=101 && !v.contains("..") && v.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'.' || c==b'_' || c==b'-'),"invalid tool/version");
        }
        ensure!(fingerprint.starts_with("sha256:") && fingerprint.len()==71
            && fingerprint[7..].bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),"invalid fingerprint");
        ensure!(source_sha.len()==40 && source_sha.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),"invalid source SHA");
        let raw=env::var("TOOLCHAIN_TARGETS")?;
        let mut seen=BTreeSet::new();
        let mut targets=Vec::new();
        for name in raw.split(',') {
            ensure!(matches!(name,"linux/amd64"|"linux/arm64"),"unsupported target {name}");
            ensure!(seen.insert(name),"duplicate target");
            let (os,arch)=name.split_once('/').context("bad target")?;
            targets.push(Platform::for_consumer(os,arch,None));
        }
        ensure!(!targets.is_empty() && targets.len()<=8,"invalid target count");
        Ok(Self{tool,version,fingerprint,source_sha,targets})
    }
    fn tag(&self)->String {format!("{}-{}",self.tool,self.version)}
    fn reference(&self)->Result<RemoteReference> {Ok(RemoteReference::parse(&self.tag())?)}
    fn image_ref(&self)->String {format!("ghcr.io/{REMOTE_REPOSITORY}:{}",self.tag())}
}
fn annotations(r:&Release)->BTreeMap<String,String> {
    BTreeMap::from([
        (ANNOTATION_KIND.to_string(),"tool".to_string()),
        (ANNOTATION_PATH_PREPEND.to_string(),"bin".to_string()),
        (FINGERPRINT_KEY.to_string(),r.fingerprint.clone()),
        (SOURCE_SHA_KEY.to_string(),r.source_sha.clone()),
    ])
}
fn expected_platform_names(r:&Release)->BTreeSet<String> {
    r.targets.iter().map(|p| format!("{}/{}",p.os,p.architecture)).collect()
}
fn target_dir(p:&Platform)->String {format!("{}-{}",p.os,p.architecture)}
fn write_output(name:&str,value:&str)->Result<()> {
    if let Ok(path)=env::var("GITHUB_OUTPUT") {
        let mut file=fs::OpenOptions::new().create(true).append(true).open(path)?;
        writeln!(file,"{name}={value}")?;
    }
    Ok(())
}
fn extract(image:&Path,dest:&Path)->Result<()> {
    fs::create_dir_all(dest)?;
    let output=Command::new("fsck.erofs").arg(format!("--extract={}",dest.display())).arg(image).output().context("fsck.erofs")?;
    ensure!(output.status.success(),"EROFS extraction failed: {}",String::from_utf8_lossy(&output.stderr));
    Ok(())
}
fn compare_trees(source:&Path,dest:&Path)->Result<()> {
    let a=fs::read_dir(source)?.map(|x|x.map(|y|y.file_name())).collect::<std::io::Result<BTreeSet<_>>>()?;
    let b=fs::read_dir(dest)?.map(|x|x.map(|y|y.file_name())).collect::<std::io::Result<BTreeSet<_>>>()?;
    ensure!(a==b,"EROFS extracted tree entries changed");
    for entry in a {
        let left=source.join(&entry);
        let right=dest.join(&entry);
        let lm=fs::symlink_metadata(&left)?;
        let rm=fs::symlink_metadata(&right)?;
        ensure!(lm.is_dir()==rm.is_dir(),"EROFS object type mismatch");
        if lm.is_dir() { compare_trees(&left,&right)?; }
        else {
            ensure!(lm.is_file() && rm.is_file(),"special file or symlink is forbidden");
            ensure!(lm.permissions().mode() & 0o777==rm.permissions().mode() & 0o777,"file mode changed");
            ensure!(fs::read(&left)?==fs::read(&right)?,"file bytes changed");
        }
    }
    Ok(())
}
async fn fetch_root(c:&RegistryClient,r:&Release)->Result<Option<(String,Index)>> {
    let remote=match c.fetch_manifest(REMOTE_REPOSITORY,&r.reference()?).await {
        Ok(v)=>v,
        Err(RegistryError::NotFound(_))=>return Ok(None),
        Err(err)=>return Err(err.into()),
    };
    ensure!(remote.media_type==MEDIA_TYPE_INDEX,"root tag must address OCI Index");
    let (_,index)=parse_index(remote.document.bytes())?;
    validate_index(&index)?;
    Ok(Some((remote.digest,index)))
}
async fn check_remote(c:&RegistryClient,r:&Release,download:Option<&Path>)->Result<Option<String>> {
    let Some((root_digest,index))=fetch_root(c,r).await? else {return Ok(None)};
    if index.annotations.as_ref().and_then(|a|a.get(FINGERPRINT_KEY))!=Some(&r.fingerprint) {return Ok(None)}
    let observed=index.manifests.iter().map(|m| {
        m.platform.as_ref().map(|p|format!("{}/{}",p.os,p.architecture)).unwrap_or_default()
    }).collect::<BTreeSet<_>>();
    if observed!=expected_platform_names(r) {return Ok(None)}
    for descriptor in &index.manifests {
        let platform=descriptor.platform.as_ref().context("child has no platform")?;
        let remote=c.fetch_manifest(REMOTE_REPOSITORY,&RemoteReference::Digest(descriptor.digest.clone())).await?;
        ensure!(remote.digest==descriptor.digest && remote.media_type==MEDIA_TYPE_MANIFEST,"child Manifest identity mismatch");
        ensure!(remote.document.bytes().len() as u64 == descriptor.size,"child Manifest size mismatch");
        let (_,manifest)=parse_manifest(remote.document.bytes())?;
        ensure!(manifest.annotations.as_ref().and_then(|a|a.get(FINGERPRINT_KEY))==Some(&r.fingerprint),"child recipe fingerprint mismatch");
        ensure!(manifest.layers.len()==1 && manifest.layers[0].media_type==MEDIA_TYPE_EROFS,"unexpected EROFS layer");
        ensure!(manifest.config.media_type==MEDIA_TYPE_CONFIG,"invalid config");
        let config=c.fetch_config(REMOTE_REPOSITORY,&manifest.config).await?;
        ensure!(config.digest()==manifest.config.digest,"config hash mismatch");
        if let Some(out)=download {
            let store=BlobStore::new(out.join(format!("cas-{}",target_dir(platform))))?;
            c.download_blob(&store,REMOTE_REPOSITORY,&manifest.layers[0]).await?;
            store.verify_named_size(&manifest.layers[0].digest,manifest.layers[0].size)?;
            extract(&store.path_for(&manifest.layers[0].digest)?,&out.join(target_dir(platform)))?;
        } else {
            let probe=tempfile::tempdir()?;
            let store=BlobStore::new(probe.path().join("probe-cas"))?;
            match c.download_blob(&store,REMOTE_REPOSITORY,&manifest.layers[0]).await {
                Err(RegistryError::NotFound(_))=>return Ok(None),
                Err(error)=>return Err(error.into()),
                Ok(())=>{},
            }
            store.verify_named_size(&manifest.layers[0].digest,manifest.layers[0].size)?;
        }
    }
    Ok(Some(root_digest))
}
#[tokio::main]
async fn main()->Result<()> {
    let mode=env::args().nth(1).context("expected probe, local, publish or readback")?;
    ensure!(matches!(mode.as_str(),"probe"|"local"|"publish"|"readback"),"invalid mode");
    let r=Release::from_env()?;
    if mode=="probe" {
        let remote=check_remote(&client()?,&r,None).await?;
        write_output("skip",if remote.is_some(){"true"}else{"false"})?;
        if let Some(digest)=remote {println!("already published and verified: {}@{}",r.image_ref(),digest);}
        else {println!("release fingerprint missing or remote incomplete: {}",r.image_ref());}
        return Ok(());
    }
    if mode=="readback" {
        let expected=env::var("TOOLCHAIN_EXPECTED_DIGEST")?;
        let dest=PathBuf::from(env::var("TOOLCHAIN_READBACK_DIR")?);
        ensure!(!dest.exists(),"readback output must not preexist");
        let digest=check_remote(&client()?,&r,Some(&dest)).await?
            .context("remote image missing or fingerprint/platform set differs")?;
        ensure!(digest==expected,"remote tag does not match pushed immutable Index digest");
        println!("Independent OCI Index/Manifest/Config/EROFS readback PASS: {}@{}",r.image_ref(),digest);
        return Ok(());
    }
    let source=PathBuf::from(env::var("TOOLCHAIN_ROOTFS")?);
    ensure!(source.is_dir(),"prepared rootfs parent absent");
    let tmp=tempfile::tempdir()?;
    let store=BlobStore::new(tmp.path().join("cas"))?;
    let builder=ErofsBuilder::new(
        Arc::new(ProcessGitRunner::default()),
        Arc::new(ProcessMkfsRunner::default()),store.clone(),tmp.path().join("build"))?;
    let mut manifests=Vec::new();
    for platform in &r.targets {
        let payload=source.join(target_dir(platform));
        ensure!(payload.is_dir(),"prepared {} rootfs is missing",target_dir(platform));
        let built=builder.build_local(&payload,&Packaging::default())?;
        ensure!(validate_erofs_file(&built.blob.path)?==built.blob.size_bytes,"bad EROFS layer");
        let layer=Descriptor {
            media_type:MEDIA_TYPE_EROFS.to_string(),digest:built.blob.digest.clone(),size:built.blob.size_bytes,
            urls:None,annotations:None,platform:None,artifact_type:None,data:None,extra:serde_json::Map::new(),
        };
        let (config,manifest)=image_documents(&layer,platform,&[],&annotations(&r))?;
        ensure!(store.put_bytes(config.bytes())?.digest==config.digest(),"Config identity changed");
        ensure!(store.put_bytes(manifest.bytes())?.digest==manifest.digest(),"Manifest identity changed");
        let unpacked=tmp.path().join(format!("unpacked-{}",target_dir(platform)));
        extract(&built.blob.path,&unpacked)?;
        compare_trees(&payload,&unpacked)?;
        manifests.push(Descriptor {
            media_type:MEDIA_TYPE_MANIFEST.to_string(),digest:manifest.digest().to_string(),size:manifest.size()?,
            urls:None,annotations:None,platform:Some(platform.clone()),artifact_type:None,data:None,extra:serde_json::Map::new(),
        });
        println!("Native EROFS/OCI built {}/{} manifest={} layer={}",platform.os,platform.architecture,manifest.digest(),layer.digest);
    }
    let index=Index {
        schema_version:2,media_type:Some(MEDIA_TYPE_INDEX.to_string()),manifests,
        annotations:Some(annotations(&r)),extra:serde_json::Map::new(),
    };
    validate_index(&index)?;
    let bytes=to_bytes(&index)?;
    let index_blob=store.put_bytes(&bytes)?;
    println!("Complete Toolchain OCI Index {}@{} platforms={:?}",r.image_ref(),index_blob.digest,expected_platform_names(&r));
    if mode=="local" {return Ok(())}
    let c=client()?;
    // Tag is a mutable pointer. Main Workflow must serialize per tool/version and
    // reject a stale catalog source immediately before this operation.
    if let Some((digest,_))=fetch_root(&c,&r).await? {
        if digest==index_blob.digest {
            println!("Already published identical OCI Index");
            write_output("digest",&digest)?;
            return Ok(());
        }
    }
    let result=push_image(&c,&store,REMOTE_REPOSITORY,&r.reference()?,&index_blob.digest).await?;
    ensure!(result.digest==index_blob.digest,"Registry Push digest mismatch");
    println!("GHCR publish: uploaded={} reused={} manifests={}",result.blobs_uploaded,result.blobs_reused,result.manifests_uploaded);
    write_output("digest",&result.digest)?;
    if let Ok(path)=env::var("GITHUB_STEP_SUMMARY"){
        let mut f=fs::OpenOptions::new().append(true).create(true).open(path)?;
        writeln!(f,"### Toolchain Release\n- OCI: `{}`\n- Index: `{}`\n- Recipe Fingerprint: `{}`\n- Source SHA: `{}`\n- Run: {} attempt: {}\n",
            r.image_ref(),result.digest,r.fingerprint,r.source_sha,env::var("GITHUB_RUN_ID").unwrap_or_default(),env::var("GITHUB_RUN_ATTEMPT").unwrap_or_default())?;
    }
    Ok(())
}
