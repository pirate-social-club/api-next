# Runnable image for the operator-supervised song-video render host.
#
# The retained pinned-input FFmpeg image remains the selected execution input.
# This Dockerfile is the runnable wrapper used when a mounted checkout is not
# practical: it starts from a pinned Bun runtime and installs FFmpeg from the
# operator-supplied tarball, verified by digest, so a drifted or substituted
# tool cannot be baked in silently. The checkout is mounted at /app.
#
# Build (a network fetch and digest are required; the build fails closed
# without them):
#   docker build \
#     --build-arg FFMPEG_TARBALL_URL=<pinned 6.1.1 tarball URL> \
#     --build-arg FFMPEG_TARBALL_SHA256=<sha256 of that tarball> \
#     -t song-video-render-host infra/cloudflare/song-video-render-host
#
# Run (one job at a time, private environment file):
#   docker run --rm --env-file /private/render-host.env \
#     -v "$PWD:/app" -w /app song-video-render-host

FROM oven/bun:1.4.0-debian

ARG FFMPEG_TARBALL_URL
ARG FFMPEG_TARBALL_SHA256

RUN test -n "$FFMPEG_TARBALL_URL" && test -n "$FFMPEG_TARBALL_SHA256" \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
 && curl -fsSL "$FFMPEG_TARBALL_URL" -o /tmp/ffmpeg.tar.xz \
 && echo "$FFMPEG_TARBALL_SHA256  /tmp/ffmpeg.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/ffmpeg \
 && tar -xJf /tmp/ffmpeg.tar.xz -C /opt/ffmpeg --strip-components=1 \
 && ln -s /opt/ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
 && ln -s /opt/ffmpeg/ffprobe /usr/local/bin/ffprobe \
 && rm -f /tmp/ffmpeg.tar.xz \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

CMD ["bun", "scripts/song-video-render-host.ts"]
