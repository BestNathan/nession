#!/usr/bin/env node
// Canonical packaging guard for the EROFS runtime tools (#3178).
//
// Invariant:
//   - both final Server images (from-source and prebuilt) install `git` and
//     copy the pinned `mkfs.erofs`;
//   - both final Agent images install `fuse3`/`fuse-overlayfs` and copy the
//     pinned `erofsfuse` (which also provides `fusermount3` through `fuse3`);
//   - the two variants of each role share one `runtime-tools` definition and
//     all four share one pinned `erofs-utils-builder` definition;
//   - the unrelated UI image carries none of these tools.
//
// Every Dockerfile read is rooted at this script's own repository checkout
// (the pre-commit runner exports a tree without `.git`), never at the caller's
// cwd. A violation exits 1; an unreadable input exits 2 so a broken guard is
// never a green skip.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const BUILD_SCRIPT = 'deploy/build-erofs-utils.sh';
const BUILDER_STAGE = 'erofs-utils-builder';
const RUNTIME_STAGE = 'runtime-tools';
const FINAL_STAGE = 'runtime';
const RUNTIME_BASE = 'debian:bookworm-slim';

export const IMAGES = [
  { file: 'Dockerfile.server', role: 'server', variant: 'from-source' },
  { file: 'Dockerfile.server.prebuilt', role: 'server', variant: 'prebuilt' },
  { file: 'Dockerfile.agent', role: 'agent', variant: 'from-source' },
  { file: 'Dockerfile.agent.prebuilt', role: 'agent', variant: 'prebuilt' },
];

const ROLE_CONTRACT = {
  server: {
    packages: ['git'],
    artifacts: ['mkfs.erofs'],
    binaries: ['git', 'mkfs.erofs'],
  },
  agent: {
    packages: ['git', 'bubblewrap', 'fuse3', 'fuse-overlayfs'],
    artifacts: ['erofsfuse'],
    binaries: ['git', 'erofsfuse', 'fusermount3', 'fuse-overlayfs'],
  },
};

const UNRELATED_IMAGE = 'Dockerfile.ui.prebuilt';
const UNRELATED_FORBIDDEN = ['mkfs.erofs', 'erofsfuse', 'fuse-overlayfs'];
const BUILDER_PACKAGES = [
  'build-essential',
  'autoconf',
  'automake',
  'libtool',
  'pkg-config',
  'libfuse3-dev',
  'ca-certificates',
  'curl',
];

/** Join Dockerfile line continuations and drop comment/blank lines. */
function instructions(text) {
  const result = [];
  let current = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!current && (line.trim() === '' || line.trim().startsWith('#'))) continue;
    if (line.endsWith('\\')) {
      current += line.slice(0, -1) + ' ';
      continue;
    }
    current += line;
    if (current.trim()) result.push(normalize(current));
    current = '';
  }
  if (current.trim()) result.push(normalize(current));
  return result;
}

function normalize(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/** Parse a Dockerfile into ordered stages with their instructions. */
function parseStages(text) {
  const stages = [];
  let current = null;
  for (const instruction of instructions(text)) {
    const match = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?$/i.exec(instruction);
    if (match) {
      current = {
        from: match[1],
        name: (match[2] ?? '').toLowerCase(),
        instructions: [],
      };
      stages.push(current);
      continue;
    }
    if (current) current.instructions.push(instruction);
  }
  return stages;
}

function aptPackages(stage) {
  const packages = new Set();
  for (const instruction of stage.instructions) {
    if (!/^RUN\s/i.test(instruction)) continue;
    for (const command of instruction.replace(/^RUN\s+/i, '').split(/&&|;/)) {
      const match = /\bapt-get\s+install\b(.*)$/.exec(command);
      if (!match) continue;
      for (const token of match[1].trim().split(/\s+/)) {
        if (!token || token.startsWith('-')) continue;
        packages.add(token);
      }
    }
  }
  return packages;
}

function copiesFrom(stage, from, destination) {
  const prefix = `COPY --from=${from} `;
  return stage.instructions.some((instruction) => {
    if (!instruction.startsWith(prefix)) return false;
    return instruction.endsWith(` ${destination}`);
  });
}

function hasCommandProbe(stage, binaries) {
  return stage.instructions.some((instruction) => {
    if (!/^RUN\s+command\s+-v\b/.test(instruction)) return false;
    const probed = instruction.replace(/^RUN\s+command\s+-v\s+/, '').split(/\s+/);
    return binaries.every((binary) => probed.includes(binary));
  });
}

function stageNamed(stages, name, file, errors) {
  const matches = stages.filter((stage) => stage.name === name);
  if (matches.length !== 1) {
    errors.push(`${file}: expected exactly one \`${name}\` stage, found ${matches.length}`);
    return null;
  }
  return matches[0];
}

function checkBuildScript(text) {
  const errors = [];
  const require = (pattern, message) => {
    if (!pattern.test(text)) errors.push(`${BUILD_SCRIPT}: ${message}`);
  };
  require(/set -euo pipefail/, 'must fail closed (`set -euo pipefail`)');
  require(/EROFS_UTILS_VERSION=['"]\d+\.\d+(?:\.\d+)?['"]/, 'must pin EROFS_UTILS_VERSION');
  require(
    /EROFS_UTILS_SHA256=['"][0-9a-f]{64}['"]/,
    'must pin the release tarball with a full SHA-256',
  );
  require(
    /erofs-utils-\$\{EROFS_UTILS_VERSION\}\.tar\.gz/,
    'must download the tarball named by the pinned version',
  );
  require(/sha256sum -c/, 'must verify the pinned SHA-256 before building');
  require(/--enable-fuse/, 'must build erofsfuse (`--enable-fuse`)');
  require(/install -m 0755 mkfs\/mkfs\.erofs \/usr\/local\/bin\/mkfs\.erofs/, 'must install mkfs.erofs to /usr/local/bin');
  require(/install -m 0755 fuse\/erofsfuse \/usr\/local\/bin\/erofsfuse/, 'must install erofsfuse to /usr/local/bin');
  return errors;
}

/**
 * Check an explicit file map. Exported for the deterministic self-test; the
 * CLI below is the only production caller.
 */
export function checkFiles(files) {
  const errors = [];
  const parsed = new Map();

  for (const { file } of IMAGES) {
    const text = files.get(file);
    if (typeof text !== 'string') {
      errors.push(`${file}: missing Dockerfile`);
      continue;
    }
    parsed.set(file, parseStages(text));
  }

  for (const { file, role } of IMAGES) {
    const stages = parsed.get(file);
    if (!stages) continue;
    const contract = ROLE_CONTRACT[role];

    const builder = stageNamed(stages, BUILDER_STAGE, file, errors);
    const runtimeTools = stageNamed(stages, RUNTIME_STAGE, file, errors);
    if (!builder || !runtimeTools) continue;

    if (builder.from !== RUNTIME_BASE) {
      errors.push(`${file}: \`${BUILDER_STAGE}\` must use ${RUNTIME_BASE}, found ${builder.from}`);
    }
    if (runtimeTools.from !== RUNTIME_BASE) {
      errors.push(`${file}: \`${RUNTIME_STAGE}\` must use ${RUNTIME_BASE}, found ${runtimeTools.from}`);
    }
    const builderPackages = aptPackages(builder);
    for (const pkg of BUILDER_PACKAGES) {
      if (!builderPackages.has(pkg)) {
        errors.push(`${file}: \`${BUILDER_STAGE}\` apt install must include \`${pkg}\``);
      }
    }
    const copiesScript = builder.instructions.some(
      (instruction) => instruction === `COPY ${BUILD_SCRIPT} /usr/local/bin/build-erofs-utils.sh`,
    );
    if (!copiesScript) {
      errors.push(`${file}: \`${BUILDER_STAGE}\` must COPY ${BUILD_SCRIPT} into /usr/local/bin`);
    }
    if (!builder.instructions.some((instruction) => instruction.includes('/usr/local/bin/build-erofs-utils.sh') && /^RUN\b/.test(instruction))) {
      errors.push(`${file}: \`${BUILDER_STAGE}\` must run /usr/local/bin/build-erofs-utils.sh`);
    }

    const packages = aptPackages(runtimeTools);
    for (const pkg of contract.packages) {
      if (!packages.has(pkg)) {
        errors.push(`${file}: \`${RUNTIME_STAGE}\` apt install must include \`${pkg}\``);
      }
    }
    for (const artifact of contract.artifacts) {
      if (!copiesFrom(runtimeTools, BUILDER_STAGE, `/usr/local/bin/${artifact}`)) {
        errors.push(`${file}: \`${RUNTIME_STAGE}\` must COPY ${artifact} from \`${BUILDER_STAGE}\``);
      }
    }
    if (!hasCommandProbe(runtimeTools, contract.binaries)) {
      errors.push(
        `${file}: \`${RUNTIME_STAGE}\` must probe \`command -v ${contract.binaries.join(' ')}\``,
      );
    }

    const final = stages.at(-1);
    if (!final || final.name !== FINAL_STAGE) {
      errors.push(`${file}: the last stage must be named \`${FINAL_STAGE}\``);
    } else if (final.from.toLowerCase() !== RUNTIME_STAGE) {
      errors.push(`${file}: the final stage must extend \`${RUNTIME_STAGE}\`, found ${final.from}`);
    } else {
      for (const instruction of final.instructions) {
        if (!/^RUN\b/.test(instruction)) continue;
        if (/\bapt-get\s+(purge|remove|autoremove)\b/.test(instruction) &&
            contract.packages.some((pkg) => new RegExp(`\\b${pkg}\\b`).test(instruction))) {
          errors.push(`${file}: the final stage must not remove required runtime packages`);
        }
        for (const artifact of contract.artifacts) {
          if (instruction.includes(`/usr/local/bin/${artifact}`) && /\brm\b/.test(instruction)) {
            errors.push(`${file}: the final stage must not remove /usr/local/bin/${artifact}`);
          }
        }
      }
    }
  }

  // One builder definition and one runtime-tools definition per role. This is
  // what lets a smoke build of either variant prove the other one too, and it
  // stops the two release paths from drifting apart.
  const builderBodies = IMAGES.map(({ file }) => {
    const stage = parsed.get(file)?.find((candidate) => candidate.name === BUILDER_STAGE);
    return stage ? stage.instructions.join('\n') : null;
  });
  if (builderBodies.some((body) => body === null) || new Set(builderBodies).size !== 1) {
    errors.push(`all four Dockerfiles must share one byte-identical \`${BUILDER_STAGE}\` stage`);
  }
  for (const role of ['server', 'agent']) {
    const variants = IMAGES.filter((image) => image.role === role);
    const bodies = variants.map(({ file }) => {
      const stage = parsed.get(file)?.find((candidate) => candidate.name === RUNTIME_STAGE);
      return stage ? stage.instructions.join('\n') : null;
    });
    if (bodies.some((body) => body === null) || new Set(bodies).size !== 1) {
      errors.push(
        `${variants.map(({ file }) => file).join(' and ')} must share one byte-identical \`${RUNTIME_STAGE}\` stage`,
      );
    }
  }

  const script = files.get(BUILD_SCRIPT);
  if (typeof script !== 'string') {
    errors.push(`${BUILD_SCRIPT}: missing pinned build script`);
  } else {
    errors.push(...checkBuildScript(script));
  }

  // The UI image serves static files; runtime test/build tooling must stay out.
  const unrelated = files.get(UNRELATED_IMAGE);
  if (typeof unrelated === 'string') {
    for (const forbidden of UNRELATED_FORBIDDEN) {
      if (unrelated.includes(forbidden)) {
        errors.push(`${UNRELATED_IMAGE}: must not carry EROFS runtime tool \`${forbidden}\``);
      }
    }
  }

  return errors;
}

const CLI_FILES = [...IMAGES.map((image) => image.file), BUILD_SCRIPT, UNRELATED_IMAGE];

function loadFiles() {
  const files = new Map();
  for (const file of CLI_FILES) {
    try {
      files.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8'));
    } catch (error) {
      process.stderr.write(`[ERROR] cannot read ${file}: ${error.message}\n`);
      process.exitCode = 2;
    }
  }
  return files;
}

function replaceOnce(text, needle, replacement) {
  if (!text.includes(needle)) throw new Error(`self-test mutation is stale: missing ${needle}`);
  return text.replace(needle, replacement);
}

function selfTest(files) {
  const baseline = checkFiles(files);
  const failures = baseline.map((error) => `baseline must pass: ${error}`);
  const mutations = [
    ['server loses git', 'Dockerfile.server', (text) => replaceOnce(text, 'gettext-base git', 'gettext-base'), 'apt install must include `git`'],
    ['server loses mkfs.erofs copy', 'Dockerfile.server', (text) => text.replace(
      /COPY --from=erofs-utils-builder \/usr\/local\/bin\/mkfs\.erofs \/usr\/local\/bin\/mkfs\.erofs\n/,
      '',
    ), 'must COPY mkfs.erofs'],
    ['server loses runtime probe', 'Dockerfile.server', (text) => replaceOnce(text, 'RUN command -v git mkfs.erofs', 'RUN true'), 'must probe `command -v git mkfs.erofs`'],
    ['server runtime base drifts', 'Dockerfile.server', (text) => replaceOnce(text, 'FROM debian:bookworm-slim AS runtime-tools', 'FROM debian:trixie-slim AS runtime-tools'), 'must use debian:bookworm-slim'],
    ['prebuilt server stops extending runtime-tools', 'Dockerfile.server.prebuilt', (text) => replaceOnce(text, 'FROM runtime-tools AS runtime', 'FROM debian:bookworm-slim AS runtime'), 'final stage must extend `runtime-tools`'],
    ['agent loses fuse3', 'Dockerfile.agent', (text) => replaceOnce(text, 'bubblewrap fuse3 fuse-overlayfs', 'bubblewrap fuse-overlayfs'), 'apt install must include `fuse3`'],
    ['agent loses erofsfuse copy', 'Dockerfile.agent', (text) => text.replace(
      /COPY --from=erofs-utils-builder \/usr\/local\/bin\/erofsfuse \/usr\/local\/bin\/erofsfuse\n/,
      '',
    ), 'must COPY erofsfuse'],
    ['prebuilt agent loses command probe', 'Dockerfile.agent.prebuilt', (text) => replaceOnce(text, 'RUN command -v git erofsfuse fusermount3 fuse-overlayfs', 'RUN true'), 'must probe `command -v git erofsfuse fusermount3 fuse-overlayfs`'],
    ['build script stops verifying the checksum', BUILD_SCRIPT, (text) => replaceOnce(text, 'sha256sum -c -', 'true'), 'must verify the pinned SHA-256'],
    ['build script stops building erofsfuse', BUILD_SCRIPT, (text) => replaceOnce(text, '--enable-fuse', '--disable-fuse'), 'must build erofsfuse'],
    ['UI image gains sandbox tooling', UNRELATED_IMAGE, (text) => `${text}\nRUN apt-get install -y fuse3 erofsfuse\n`, 'must not carry EROFS runtime tool'],
  ];

  for (const [name, file, mutate, expected] of mutations) {
    const mutated = new Map(files);
    try {
      mutated.set(file, mutate(files.get(file)));
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
      continue;
    }
    const errors = checkFiles(mutated);
    if (!errors.some((error) => error.startsWith(`${file}:`) && error.includes(expected))) {
      failures.push(`${name}: mutation escaped the guard (expected "${expected}")`);
    }
  }
  if (failures.length > 0) {
    process.stderr.write(failures.map((failure) => `[ERROR] ${failure}`).join('\n') + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`runtime-image-tools self-test: ${mutations.length} negative mutations rejected\n`);
}

const files = loadFiles();
if (process.exitCode === 2) {
  // An unreadable input is an ERROR, never a pass.
} else if (process.argv.includes('--self-test')) {
  selfTest(files);
} else {
  const errors = checkFiles(files);
  if (errors.length > 0) {
    process.stderr.write(errors.map((error) => `[ERROR] ${error}`).join('\n') + '\n');
    process.exitCode = 1;
  } else {
    process.stdout.write(
      'runtime-image-tools: both Server and both Agent Dockerfiles carry the pinned EROFS build/mount tools; the UI image carries none\n',
    );
  }
}
