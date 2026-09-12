# Runnable image for the operator-supervised song-video render host.
#
# This Dockerfile is the runnable wrapper used when a mounted checkout is not
# practical: it starts from a pinned Bun runtime and installs the FFmpeg 6.1.1
# binaries recorded in pinned-ffmpeg.env, verified by digest, so a drifted or
# substituted tool cannot be baked in silently. The checkout is mounted at /app.
#
# Build (the pin is checked in beside this file; no build arguments):
#   docker build -t song-video-render-host infra/cloudflare/song-video-render-host
#
# Run (one job at a time, private environment file):
#   docker run --rm --env-file /private/render-host.env \
#     -v "$PWD:/app" -w /app song-video-render-host

FROM oven/bun:1.4.0-debian

COPY pinned-ffmpeg.env /tmp/pinned-ffmpeg.env

RUN set -eu; \
    . /tmp/pinned-ffmpeg.env; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl jq; \
    token="$(curl -fsSL "$FFMPEG_TOKEN_URL" | jq -r .token)"; \
    curl -fsSL -H "Authorization: Bearer $token" "$FFMPEG_LAYER_URL" -o /tmp/ffmpeg-layer.tar.gz; \
    echo "$FFMPEG_LAYER_SHA256  /tmp/ffmpeg-layer.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/ffmpeg; \
    tar -xzf /tmp/ffmpeg-layer.tar.gz -C /opt/ffmpeg ffmpeg ffprobe; \
    chmod 0755 /opt/ffmpeg/ffmpeg /opt/ffmpeg/ffprobe; \
    ln -s /opt/ffmpeg/ffmpeg /usr/local/bin/ffmpeg; \
    ln -s /opt/ffmpeg/ffprobe /usr/local/bin/ffprobe; \
    rm -f /tmp/ffmpeg-layer.tar.gz /tmp/pinned-ffmpeg.env; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

CMD ["bun", "scripts/song-video-render-host.ts"]
