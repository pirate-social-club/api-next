# Reproducible renderer evidence image.
#
# Every input is immutable: the base image is digest-pinned, package indexes come
# from a fixed snapshot.debian.org timestamp rather than a rolling mirror, and the
# FFmpeg version is pinned exactly. A drifted upstream fails the build instead of
# silently changing the renderer under test.
FROM oven/bun@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6

ARG DEBIAN_SNAPSHOT=20260901T000000Z
ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1

RUN set -eux; \
  printf '%s\n' \
    'Types: deb' \
    "URIs: https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}/" \
    'Suites: trixie trixie-updates' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    '' \
    'Types: deb' \
    "URIs: https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}/" \
    'Suites: trixie-security' \
    'Components: main' \
    'Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg' \
    > /etc/apt/sources.list.d/debian.sources; \
  apt-get -o Acquire::Check-Valid-Until=false update; \
  DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
    "ffmpeg=${FFMPEG_VERSION}"; \
  installed="$(dpkg-query -W -f='${Version}' ffmpeg)"; \
  test "${installed}" = "${FFMPEG_VERSION}"; \
  printf 'ffmpeg_package=%s\ndebian_snapshot=%s\n' "${installed}" "${DEBIAN_SNAPSHOT}" \
    > /etc/renderer-image-facts; \
  rm -rf /var/lib/apt/lists/*

USER bun
