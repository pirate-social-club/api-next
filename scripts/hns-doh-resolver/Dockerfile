# hnsd — Handshake SPV resolver.
#
# This role deliberately does NOT reuse the hns-chain-observer hsd node. That node
# backs namespace verification; attaching a public-facing resolver workload to it
# would put the verifier's chain observation and an abusable public service in the
# same failure domain. hnsd is an SPV client: it syncs headers only, so it costs
# minutes and megabytes rather than a second full chain copy on a disk that is
# already ~74% used.
FROM alpine:3.21@sha256:56fa17d2a7e7f168a043a2712e63aed1f8543aeafdcee47c58dcffe38ed51099 AS build

ARG UNBOUND_VERSION=1.26.2
ARG UNBOUND_TARBALL_SHA256=d8ee7aa6bbb3ff1be7d9e57637d0d0ec2f18273a8efff1a0afe2c665858b96f7

ARG HNSD_VERSION=2.0.0
ARG HNSD_TARBALL_SHA256=90e4a0e78fab92d5232df288ef55fbed32cebd0651b16e6bc257dbed85a44c6b

# bash is required: hnsd's autogen.sh carries a bash shebang and build-base does
# not provide one.
# Alpine 3.21's unbound-libs 1.22.0-r1 lacks the 2026 security fixes. Build the
# reviewed upstream library on the same libc; do not mix edge APKs or retain
# the old APK library as a fallback. Both compilations deliberately use one job.
RUN apk add --no-cache autoconf automake bash build-base libtool expat-dev libevent-dev openssl-dev wget

WORKDIR /opt/unbound
RUN wget -q "https://nlnetlabs.nl/downloads/unbound/unbound-${UNBOUND_VERSION}.tar.gz" \
      -O /tmp/unbound.tar.gz \
    && echo "${UNBOUND_TARBALL_SHA256}  /tmp/unbound.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/unbound.tar.gz --strip-components=1 -C /opt/unbound \
    && ./configure --prefix=/usr/local --with-libunbound-only --disable-static \
         --enable-pie --enable-relro-now --disable-rpath \
         --with-libevent --with-pthreads --with-ssl=/usr \
         --without-pythonmodule --without-pyunbound --without-libnghttp2 \
    && make -j1 \
    && make -j1 test \
    && make install \
    && strip /usr/local/lib/libunbound.so.* \
    && rm -rf /tmp/unbound.tar.gz

# This diagnostic calls the library actually resolved in the final runtime.
RUN printf '#include <stdio.h>\n#include <unbound.h>\nint main(void) { puts(ub_version()); return 0; }\n' > /tmp/unbound-version.c \
    && cc /tmp/unbound-version.c -I/usr/local/include -L/usr/local/lib \
         -lunbound -o /usr/local/bin/hnsd-unbound-version

# v2.0.0 writes its temporary checkpoint to a relative path under musl, so
# checkpoints never persist. Apply only the upstream store.c fix; copying it
# after the Unbound stage keeps that stage's cached layers valid.
COPY hnsd-store-checkpoint-path.patch /tmp/hnsd-store-checkpoint-path.patch
WORKDIR /opt/hnsd
RUN wget -q "https://github.com/handshake-org/hnsd/archive/refs/tags/v${HNSD_VERSION}.tar.gz" \
      -O /tmp/hnsd.tar.gz \
    && echo "${HNSD_TARBALL_SHA256}  /tmp/hnsd.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/hnsd.tar.gz --strip-components=1 -C /opt/hnsd \
    && patch -p1 < /tmp/hnsd-store-checkpoint-path.patch \
    && ./autogen.sh \
    && ./configure --prefix=/usr/local --with-unbound=/usr/local \
    && make -j1 \
    && strip hnsd \
    && rm -rf /tmp/hnsd.tar.gz /tmp/hnsd-store-checkpoint-path.patch

FROM alpine:3.21@sha256:56fa17d2a7e7f168a043a2712e63aed1f8543aeafdcee47c58dcffe38ed51099

# bind-tools supplies dig for the container healthcheck. busybox's nslookup
# cannot target a non-standard port, and a bare port check would not prove that
# the SPV chain is actually synced and answering.
RUN apk add --no-cache bind-tools expat libevent libssl3 libcrypto3 \
    && addgroup -g 1000 -S hnsd \
    && adduser -u 1000 -S -G hnsd -H -s /sbin/nologin hnsd

COPY --from=build /usr/local/lib/ /usr/local/lib/
COPY --from=build /usr/local/bin/hnsd-unbound-version /usr/local/bin/hnsd-unbound-version
COPY --from=build /opt/hnsd/hnsd /usr/local/bin/hnsd
RUN test ! -e /usr/lib/libunbound.so.8 \
    && test "$(hnsd-unbound-version)" = "1.26.2"
COPY docker-entrypoint.sh /usr/local/bin/hnsd-resolver-entrypoint
COPY healthcheck.sh /usr/local/bin/hnsd-resolver-healthcheck
RUN chmod 0555 /usr/local/bin/hnsd-resolver-entrypoint /usr/local/bin/hnsd-resolver-healthcheck

USER hnsd
VOLUME ["/var/lib/hnsd"]

ENTRYPOINT ["/usr/local/bin/hnsd-resolver-entrypoint"]
