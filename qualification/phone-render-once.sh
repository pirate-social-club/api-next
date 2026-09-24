#!/usr/bin/env bash
# One approved Pixel submission, one targeted render invocation. Never retry a
# claimed attempt after an uncertain exit; inspect its persisted state instead.
set -euo pipefail
cd "$(dirname "$0")/.."

SUBMISSION=media-submission-1c796a72-05b6-4886-ba8e-0e9d28fe80b9
SONG=media-post-media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b
SONG_KEY=immutable/media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b/audio/1
IMAGE=song-video-render-host:qual-20260922-aa7a99f1
IMAGE_ID=sha256:7dfb20c68964eb0ae202e7a83cf25268a7d04b28879e7918fa3a03f6d0b93aec
EVIDENCE=${PHONE_RENDER_EVIDENCE_DIR:?set the named evidence directory}
PRIVATE=$(mktemp -d /tmp/video-phone-render-20260924.XXXXXXXX)
chmod 700 "$PRIVATE"
export QUAL_PRIVATE_DIR=$PRIVATE
cleanup() { rm -r -- "$PRIVATE"; }
trap cleanup EXIT
mkdir -p "$EVIDENCE"

if [ "$(docker image inspect "$IMAGE" --format '{{.Id}}')" != "$IMAGE_ID" ]; then
  echo "STOP: render image identity changed" >&2
  exit 1
fi
if [ -n "$(git diff --name-only HEAD origin/main -- scripts/song-video-render-host.ts scripts/song-video-render-host-r2.ts packages/platform-cf/src/song-video-interval-repository.ts)" ]; then
  echo "STOP: mounted render code differs from API main" >&2
  exit 1
fi

secret-tool lookup role-id 6t4pvc4cefrg | bun -e '
  const raw=(await Bun.stdin.text()).trim();
  if(!raw.startsWith("postgres://") && !raw.startsWith("postgresql://")) throw Error("render credential unavailable");
  const url=new URL(raw);
  url.searchParams.delete("sslrootcert");
  url.searchParams.set("options","-c search_path=api_next");
  require("node:fs").writeFileSync(
    process.env.QUAL_PRIVATE_DIR+"/host.url",url.toString(),{mode:0o600},
  );
' 
bun qualification/branch-helpers.ts sql host.url \
  "SELECT current_user, pg_has_role(current_user,'postgres','MEMBER') AS postgres_member" \
  > "$EVIDENCE/host-identity.json"
python3 - "$EVIDENCE/host-identity.json" <<'PY'
import json,sys
rows=json.load(open(sys.argv[1]))
if len(rows)!=1 or rows[0]['current_user']!='pscale_api_6t4pvc4cefrg' or rows[0]['postgres_member']:
    raise SystemExit('STOP: render-host role identity changed')
PY

bun qualification/branch-helpers.ts sql host.url \
  "SELECT s.status,s.phase,s.video_state_snapshot->'approvedHolds' AS approved_holds,
          s.video_state_snapshot->'video'->>'immutableRef' AS source_ref,
          p.plan_id,p.song_post_id,p.clip_start_samples::text,p.clip_duration_samples::text,
          a.attempt_id,a.state AS attempt_state,a.execution_phase,a.execution_claim_id,
          a.dispatch_output_key
   FROM media_post_submissions s
   JOIN media_song_video_render_plans p ON p.submission_id=s.submission_id
   JOIN media_song_video_render_attempts a ON a.plan_id=p.plan_id
   WHERE s.submission_id='$SUBMISSION' ORDER BY a.generation" \
  > "$EVIDENCE/render-preflight.json"

read -r PLAN ATTEMPT SOURCE_KEY OUTPUT_KEY < <(python3 - "$EVIDENCE/render-preflight.json" <<'PY'
import json,sys
rows=json.load(open(sys.argv[1]))
if len(rows)!=1: raise SystemExit('STOP: expected exactly one render attempt')
r=rows[0]
if r['status']!='processing' or r['phase']!='render' or 'safety' not in r['approved_holds']:
    raise SystemExit('STOP: submission is not approved for render')
if r['attempt_state']!='started' or r['execution_phase'] not in ('submitting','submitted') or r['execution_claim_id'] is not None:
    raise SystemExit('STOP: render attempt is not freshly claimable')
if r['song_post_id']!='media-post-media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b' or int(r['clip_start_samples'])!=0 or int(r['clip_duration_samples'])!=720000:
    raise SystemExit('STOP: frozen song interval differs')
plan='song-video-plan:media-submission-1c796a72-05b6-4886-ba8e-0e9d28fe80b9'
source=r['source_ref']
prefix=f'immutable/song-video-masters/{plan}/'
if r['plan_id']!=plan or not source.startswith('media://immutable/') or not r['dispatch_output_key'].startswith(prefix):
    raise SystemExit('STOP: source or output binding differs')
print(plan,r['attempt_id'],source.removeprefix('media://'),r['dispatch_output_key'])
PY
)

if [ "${1:-}" = preflight ]; then
  echo "Targeted render ready: $PLAN / $ATTEMPT; no host claim made"
  exit 0
fi
if [ "${1:-}" != execute ]; then
  echo "usage: phone-render-once.sh preflight|execute" >&2
  exit 2
fi
if [ -e "$EVIDENCE/render-started.marker" ]; then
  echo "STOP: this one-shot runner was already started" >&2
  exit 1
fi
date -u +%Y-%m-%dT%H:%M:%SZ > "$EVIDENCE/render-started.marker"

infisical run --env staging --path /services/api-next/operator --silent -- \
  bun qualification/branch-helpers.ts mint input object-read-only 3600 \
  --object "$SOURCE_KEY" --object "$SONG_KEY" > "$EVIDENCE/mint-input.json"
infisical run --env staging --path /services/api-next/operator --silent -- \
  bun qualification/branch-helpers.ts mint output object-read-write 3600 \
  --prefix "immutable/song-video-masters/$PLAN/" > "$EVIDENCE/mint-output.json"
bun qualification/branch-helpers.ts host-env render host.url input output \
  "SONG_VIDEO_RENDER_PLAN_ID=$PLAN" \
  "SONG_VIDEO_RENDER_ATTEMPT_ID=$ATTEMPT" \
  "SONG_VIDEO_RENDER_HOST_ID=phone-acceptance-20260924" \
  > "$EVIDENCE/host-env-keys.json"

set +e
docker run --rm --network host -v "$PWD:/app" -w /app \
  --env-file "$PRIVATE/render.env" "$IMAGE" \
  bun scripts/song-video-render-host.ts \
  > "$EVIDENCE/render.stdout" 2> "$EVIDENCE/render.stderr"
RESULT=$?
set -e
echo "$RESULT" > "$EVIDENCE/render.exit-code"
bun qualification/branch-helpers.ts sql host.url \
  "SELECT a.attempt_id,a.state,a.execution_phase,a.execution_claim_id,
          m.master_sha256,m.master_byte_length::text,m.verified_object_key
   FROM media_song_video_render_attempts a
   LEFT JOIN media_song_video_masters m ON m.attempt_id=a.attempt_id
   WHERE a.attempt_id='$ATTEMPT'" > "$EVIDENCE/render-readback.json"
(cd "$EVIDENCE" && sha256sum render* mint-* host-* > SHA256SUMS && sha256sum -c --quiet SHA256SUMS)
if [ "$RESULT" -ne 0 ]; then
  echo "STOP: host exit $RESULT; claim may be unresolved; do not rerun" >&2
  exit 1
fi
python3 - "$EVIDENCE/render-readback.json" <<'PY'
import json,sys
rows=json.load(open(sys.argv[1]))
if len(rows)!=1 or rows[0]['state'] not in ('sealed','accepted') or not rows[0]['master_sha256']:
    raise SystemExit('STOP: host returned zero but persisted master is not proven')
PY
echo "Targeted render completed once; evidence checksums verified"
