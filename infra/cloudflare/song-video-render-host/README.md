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
dependencies are required. The pinned artifact is recorded once in
`pinned-ffmpeg.env` beside this file: the source image and layer digests, the
download URL and its SHA-256. Both the image build below and the CI real-media
jobs read that file, and the build fails closed if the fetched layer does not
match the recorded digest.

## Configuration

Copy `config.example.json` to a private location and fill the placeholders. No
secret belongs in this directory. The environment variables are exactly those
in the example; the database URL, account id, bucket and R2 credentials are
private operator configuration.

## R2 credentials

The master writer and the output store touch only the attempt's assigned
output key, including the seal's re-read of the verified version. The media
reader touches only the render inputs: the sealed source video and the
canonical song. `SONG_VIDEO_RENDER_R2_ACCESS_KEY_ID` and
`SONG_VIDEO_RENDER_R2_SECRET_ACCESS_KEY` sign every request unless the optional
`SONG_VIDEO_RENDER_R2_INPUT_ACCESS_KEY_ID` and
`SONG_VIDEO_RENDER_R2_INPUT_SECRET_ACCESS_KEY` are set, in which case the media
reader signs with the input pair instead. That lets an operator give the inputs
a read-only credential and scope the output credential to the master prefix,
so the host cannot write any input object. Setting only one half of the input
pair is refused at startup; it never falls back to the output pair.

R2 temporary access credentials also carry a session token. Set
`SONG_VIDEO_RENDER_R2_SESSION_TOKEN` with the output pair and
`SONG_VIDEO_RENDER_R2_INPUT_SESSION_TOKEN` with the input pair; each is signed
as `x-amz-security-token` on that pair's requests. An input session token
without its pair is refused.

## Running

Two runnable paths are provided. The mounted-checkout invocation checks the
runtime and tool versions and then runs the entry point as-is:

```sh
infra/cloudflare/song-video-render-host/run-host.sh
```

The image path builds a wrapper on a pinned Bun runtime and installs the
digest-verified FFmpeg 6.1.1 binaries from `pinned-ffmpeg.env`, failing closed
without a matching artifact:

```sh
docker build -t song-video-render-host infra/cloudflare/song-video-render-host

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

## Measuring one song

Setting `SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID` and
`SONG_VIDEO_RENDER_MEASURE_AUDIO_REVISION` runs one targeted measurement instead
of rendering. It claims only that song revision's pending canonical timing,
with the same 300-second lease and `SKIP LOCKED` claim the loop uses, measures
it, prints one JSON line and exits. No other pending timing is read or changed,
and no render attempt is claimed. The outcome is `measured` with
`duration_samples`, `failed` with `failure_code`, `not_claimed` when the
revision is absent, already concluded, leased or locked, or `deferred` when the
prober was unavailable and the revision stays pending. It exits 0, or 2 when
deferred. Only a read credential is needed: the input pair when set, otherwise
the output pair. Naming only one of the two variables, or combining them with
`SONG_VIDEO_RENDER_PLAN_ID` or `SONG_VIDEO_RENDER_ATTEMPT_ID`, is refused at
startup.

## What this does not authorize

Host, cost ceiling, window and execution each still require their separate
approval. Stream ingestion, the live derivative registration and phone
acceptance remain separate authorized operations. The renderer writes the
master; it does not publish.
