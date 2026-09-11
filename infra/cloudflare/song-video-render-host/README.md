# Song-video render host

This is the concrete configuration for the first bounded, operator-supervised
render on the selected U.2 execution path, the retained pinned-input FFmpeg
Docker image. It prepares that run; it does not deploy anything or authorize a
live transaction.

The host runs as a supervised loop over the existing render attempt records. On
each pass `scripts/song-video-render-host.ts` first measures songs waiting for
an authoritative duration, then claims one waiting attempt atomically before
FFmpeg runs — a compare-and-set on the attempt row with `SKIP LOCKED`, so two
hosts or a restarted host cannot both execute it and no pass takes more than
one row. It then loads the plan's frozen interval and the sealed source from the
same rows the workflow froze, renders with the pinned engine, writes the
attempt's assigned output address once, and seals the accepted master through
the existing render store. It never retries: an execution that cannot be
concluded is reported pending and left claimed for reconciliation.

## Required inputs

The instance must provide `ffmpeg` and `ffprobe` exactly 6.1.1 on `PATH`; the
engine refuses a drifted tool before it touches media, and a different decoder
can produce a different sample count. Bun 1.4 and the checkout's installed
dependencies are required. The image reference and its digest are recorded in
`config.example.json`; the operator supplies the retained pinned-input FFmpeg
image there at deployment time.

## Configuration

Copy `config.example.json` to a private location and fill the placeholders. No
secret belongs in this directory. The environment variables are exactly those
in the example; the database URL, account id, bucket and R2 credentials are
private operator configuration.

## Running

Two runnable paths are provided. The mounted-checkout invocation checks the
runtime and tool versions and then runs the entry point as-is:

```sh
infra/cloudflare/song-video-render-host/run-host.sh
```

The image path builds a wrapper on a pinned Bun runtime and installs FFmpeg
from an operator-supplied tarball, verified by digest, failing closed without
one:

```sh
docker build \
  --build-arg FFMPEG_TARBALL_URL=<pinned 6.1.1 tarball URL> \
  --build-arg FFMPEG_TARBALL_SHA256=<sha256 of that tarball> \
  -t song-video-render-host infra/cloudflare/song-video-render-host

docker run --rm --env-file /private/render-host.env \
  -v "$PWD:/app" -w /app song-video-render-host
```

Start the host before publishing; the media-processor Worker dispatches an
attempt and waits on it. Without `SONG_VIDEO_RENDER_PLAN_ID` the loop measures
pending songs, claims the oldest waiting attempt, renders it, and repeats until
SIGINT or SIGTERM, printing one JSON line per concluded attempt. The optional
`SONG_VIDEO_RENDER_POLL_MS` bounds the idle wait (1000 to 600000, default
15000). Setting `SONG_VIDEO_RENDER_PLAN_ID`, with `SONG_VIDEO_RENDER_ATTEMPT_ID`
when a plan has more than one attempt, runs one targeted pass instead: exit 0
with an accepted or refused outcome, `not_claimed` and exit 0 when another host
holds the claim or the attempt is concluded, and exit 2 when that execution
stayed pending. A pending attempt is never retried by another pass; it is
resolved by reconciliation.

## What this does not authorize

Host, cost ceiling, window and execution each still require their separate
approval. Stream ingestion, the live derivative registration and phone
acceptance remain separate authorized operations. The renderer writes the
master; it does not publish.
