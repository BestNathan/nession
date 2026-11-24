// A no-op optimization, never a replacement for source-backed MCP schemas.
// The independent published snapshot validator establishes the last-good
// semantic digest before this bounded GitHub compare can authorize reuse.
import {validMcpPublication} from './mcp-reconcile.mjs';

const SHA=/^[a-f0-9]{40}$/;
const BOUNDED_FILES=300;
const BOUNDED_COMMITS=100;
const sourceInputs=new Set([
  'Cargo.toml','Cargo.lock','rust-toolchain.toml','rust-toolchain',
  'pages/scripts/build.mjs','pages/scripts/build-data.mjs','pages/scripts/mcp-semantic.mjs',
  'pages/scripts/mcp-reconcile.mjs','pages/scripts/mcp-upstream.mjs',
  'pages/scripts/mcp-export-gate.mjs',
]);
export function affectsMcpSource(filename){
  return typeof filename==='string'&&(
    filename.startsWith('crates/nession-mcp/')||
    filename.startsWith('crates/nession-protocol/')||
    filename.startsWith('.cargo/')||
    sourceInputs.has(filename)
  );
}
export function canReusePublishedMcp({previous,stable,mainSha,comparison=null}){
  if(!validMcpPublication(previous)||!SHA.test(mainSha||'')||
     !stable||previous.upstream.stable.version!==stable.version||
     previous.upstream.stable.sha!==stable.sha||
     previous.upstream.stable.changelog_sha256!==stable.changelog_sha256)
    return false;
  const oldSha=previous.source.sha;
  if(oldSha===mainSha)return true;
  // GitHub compare may be truncated for large release batches. No
  // complete/authenticated file inventory => compile and reconcile instead.
  if(!comparison||comparison.status!=='ahead'||
     comparison.base_commit?.sha!==oldSha||
     comparison.head_commit?.sha!==mainSha||
     !Number.isSafeInteger(comparison.ahead_by)||comparison.ahead_by<1||
     comparison.ahead_by>=BOUNDED_COMMITS||
     !Number.isSafeInteger(comparison.total_commits)||
     comparison.total_commits<1||comparison.total_commits>=BOUNDED_COMMITS||
     comparison.ahead_by!==comparison.total_commits||
     !Array.isArray(comparison.files)||comparison.files.length>=BOUNDED_FILES)
    return false;
  return comparison.files.every(file=>
    typeof file?.filename==='string'&&
    !affectsMcpSource(file.filename)&&
    (file.previous_filename===undefined||
      (typeof file.previous_filename==='string'&&
        !affectsMcpSource(file.previous_filename))));
}
