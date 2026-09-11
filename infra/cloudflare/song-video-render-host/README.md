# Song-video render host

This is the concrete configuration for the first bounded, operator-supervised
render on the selected U.2 execution path, the retained pinned-input FFmpeg
Docker image. It prepares that run; it does not deploy anything or authorize a
live transaction.

The host executes exactly one dispatch from the existing render attempt
records. Given a plan id, `scripts/song-video-render-host.ts` loads the attempt
at `started`/`submitting` with no recorded evidence, loads the plan's frozen
interval and the sealed source from the same rows the workflow froze, renders
with the pinned engine, writes the attempt's assigned output address once, and
seals the accepted master through the existing render store. It never retries:
an execution that cannot be concluded exits pending and is left for
reconciliation.

## Required inputs

The instance must provide `ffmpeg` and `ffprobe` exactly 6.1.1 on `PATH`; the
engine refuses a drifted tool before it touches media, and a different decoder
can produce a different sample count. Bun 1.4 runs the workspace scripts from
the checkout. The image reference and its digest are recorded in
`config.example.json`; the operator supplies the retained pinned-input FFmpeg
image there at deployment time.

## Configuration

Copy `config.example.json` to a private location and fill the placeholders. No
secret belongs in this directory. The environment variables are exactly those
in the example; the database URL, account id, bucket and R2 credentials are
private operator configuration.

## Invocation

Run one job at a time, against one plan, with a fresh container:

```sh
docker run --rm \
  --env-file /private/render-host.env \
  <retained-pinned-ffmpeg-image> \
  bun scripts/song-video-render-host.ts
```

Set `SONG_VIDEO_RENDER_PLAN_ID` and, when a plan has more than one dispatched
attempt, `SONG_VIDEO_RENDER_ATTEMPT_ID`. Exit 0 with an accepted or refused
outcome, exit 2 when the execution stayed pending. A pending attempt is not
retried by running the command again; it is resolved by reconciliation.

## What this does not authorize

Host, cost ceiling, window and execution each still require their separate
approval. Stream ingestion, the live derivative registration and phone
acceptance remain separate authorized operations. The renderer writes the
master; it does not publish.
