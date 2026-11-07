# #2274: main-owned, unprivileged disposable Claude Code/Qwen Developer.
# No source tree, runtime credential, native Session or Store token is copied
# into this image. Only a pinned numeric CLI version is installed at build.
FROM node:24-bookworm
ARG CLAUDE_CODE_VERSION
# The pinned package fetches its platform-native CLI in its own postinstall;
# --ignore-scripts keeps npm from running it implicitly, so run only that
# installed package's postinstall explicitly.
RUN set -eux; \
    echo "$CLAUDE_CODE_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.-]+)?$'; \
    apt-get update; \
    apt-get install -y --no-install-recommends git ripgrep ca-certificates; \
    rm -rf /var/lib/apt/lists/*; \
    npm install -g --ignore-scripts --no-audit --no-fund "@anthropic-ai/claude-code@$CLAUDE_CODE_VERSION"; \
    cd "$(npm root -g)/@anthropic-ai/claude-code" && node install.cjs && cd /; \
    claude --help | grep -q -- '--restricted'; \
    git --version; \
    rg --version
