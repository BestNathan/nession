# Main-owned, disposable Agent / Development runtime, without any source code
# or privileged credential copied into the image. #1997.
FROM node:24-bookworm
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ripgrep; \
    rm -rf /var/lib/apt/lists/*; \
    test -x /usr/bin/rg; \
    /usr/bin/rg --version
