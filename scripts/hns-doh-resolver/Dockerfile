# hnsd — Handshake SPV resolver.
#
# This role deliberately does NOT reuse the hns-chain-observer hsd node. That node
# backs namespace verification; attaching a public-facing resolver workload to it
# would put the verifier's chain observation and an abusable public service in the
# same failure domain. hnsd is an SPV client: it syncs headers only, so it costs
# minutes and megabytes rather than a second full chain copy on a disk that is
# already ~74% used.
FROM alpine:3.21@sha256:56fa17d2a7e7f168a043a2712e63aed1f8543aeafdcee47c58dcffe38ed51099 AS build

ARG HNSD_VERSION=2.0.0
ARG HNSD_TARBALL_SHA256=90e4a0e78fab92d5232df288ef55fbed32cebd0651b16e6bc257dbed85a44c6b

# bash is required: hnsd's autogen.sh carries a bash shebang and build-base does
# not provide one.
RUN apk add --no-cache autoconf automake bash build-base libtool unbound-dev wget

WORKDIR /opt/hnsd
RUN wget -q "https://github.com/handshake-org/hnsd/archive/refs/tags/v${HNSD_VERSION}.tar.gz" \
      -O /tmp/hnsd.tar.gz \
    && echo "${HNSD_TARBALL_SHA256}  /tmp/hnsd.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/hnsd.tar.gz --strip-components=1 -C /opt/hnsd \
    && ./autogen.sh \
    && ./configure --prefix=/usr/local \
    && make -j"$(nproc)" \
    && strip hnsd \
    && rm -rf /tmp/hnsd.tar.gz

FROM alpine:3.21@sha256:56fa17d2a7e7f168a043a2712e63aed1f8543aeafdcee47c58dcffe38ed51099

# bind-tools supplies dig for the container healthcheck. busybox's nslookup
# cannot target a non-standard port, and a bare port check would not prove that
# the SPV chain is actually synced and answering.
RUN apk add --no-cache bind-tools unbound-libs \
    && addgroup -g 1000 -S hnsd \
    && adduser -u 1000 -S -G hnsd -H -s /sbin/nologin hnsd

COPY --from=build /opt/hnsd/hnsd /usr/local/bin/hnsd
COPY --chmod=0555 docker-entrypoint.sh /usr/local/bin/hnsd-resolver-entrypoint
COPY --chmod=0555 healthcheck.sh /usr/local/bin/hnsd-resolver-healthcheck

USER hnsd
VOLUME ["/var/lib/hnsd"]

ENTRYPOINT ["/usr/local/bin/hnsd-resolver-entrypoint"]
