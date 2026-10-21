FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

ARG HSD_VERSION=8.0.0
ARG HSD_COMMIT=9f013c1cb7f92edf94db69fbd69daf34adf655fb
ARG HSD_TARBALL_SHA256=5280829508c38d96f2eeddcdb0d0fecf07990161d7d6f5495dae7ccb84c21818
ARG HSD_PACKAGE_LOCK_SHA256=326531bb17d526d002e88d1011ae2d1ea92909767dc05b7088adcf3c4b0184d7

RUN apk add --no-cache g++ gcc gmp-dev make python3 tar unbound-dev wget

WORKDIR /opt/hsd
RUN wget -q "https://github.com/handshake-org/hsd/releases/download/v${HSD_VERSION}/hsd-${HSD_VERSION}.tar.gz" \
      -O /tmp/hsd.tar.gz \
    && echo "${HSD_TARBALL_SHA256}  /tmp/hsd.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/hsd.tar.gz --strip-components=2 -C /opt/hsd hsd-${HSD_VERSION}/hsd \
    && wget -q "https://raw.githubusercontent.com/handshake-org/hsd/${HSD_COMMIT}/package-lock.json" \
      -O /opt/hsd/package-lock.json \
    && echo "${HSD_PACKAGE_LOCK_SHA256}  /opt/hsd/package-lock.json" | sha256sum -c - \
    && npm ci --omit=dev \
    && rm -rf /tmp/hsd.tar.gz /root/.npm

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2

RUN apk add --no-cache gmp libstdc++ unbound-libs

WORKDIR /opt/hsd
COPY --from=build --chown=node:node /opt/hsd /opt/hsd
COPY --chmod=0555 docker-entrypoint.sh /usr/local/bin/hsd-observer-entrypoint
COPY --chmod=0555 healthcheck.mjs /usr/local/bin/hsd-observer-healthcheck

USER node
VOLUME ["/var/lib/hsd"]

ENTRYPOINT ["/usr/local/bin/hsd-observer-entrypoint"]
