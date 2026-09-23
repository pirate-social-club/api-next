#!/usr/bin/env bash
# Targeted canonical-timing measurement of the anchor song on staging main,
# before the phone run (PHONE-RUN-HOST-OPERATIONS.md operations 1 and 2).
# Secrets stay under $PRIV (0700); evidence under $EV.
set -euo pipefail
cd "$(dirname "$0")/.."
PRIV=${QUAL_PRIVATE_DIR:?}; EV=${QUAL_EVIDENCE_DIR:?}; export QUAL_PRIVATE_DIR=$PRIV
IMG=song-video-render-host:qual-20260922-aa7a99f1
SONG=media-post-media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b
SONG_SHA=51afd9db7bb1e0be27c0d1fd4c55741d0570027dd6c20a6f087388e971c62d08
SONG_KEY=immutable/media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b/audio/1
mkdir -p "$EV"; install -d -m 700 "$PRIV"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$EV/run.log"; }
fail() { log "STOP: $*"; exit 1; }
ops() { infisical run --env=staging --path=/services/api-next/operator --silent -- "$@"; }
# Admin (table owner) URL for the maintained timing request and read-only checks.
ops bun -e 'const u=new URL(process.env.CONTROL_PLANE_POSTGRES_ADMIN_URL);u.searchParams.delete("sslrootcert");u.searchParams.set("options","-c search_path=api_next");require("fs").writeFileSync(process.env.QUAL_PRIVATE_DIR+"/admin.url",u.toString(),{mode:0o600})'
# Restricted render-host URL from the keyring.
secret-tool lookup role-id 6t4pvc4cefrg | bun -e 'const u=new URL((await Bun.stdin.text()).trim());u.searchParams.delete("sslrootcert");u.searchParams.set("options","-c search_path=api_next");require("fs").writeFileSync(process.env.QUAL_PRIVATE_DIR+"/host.url",u.toString(),{mode:0o600})'
[ -s "$PRIV/host.url" ] || fail "render-host credential missing from keyring"
bun qualification/branch-helpers.ts sql host.url "SELECT current_user, pg_has_role(current_user,'postgres','MEMBER') AS postgres_member" > "$EV/host-identity.json"
python3 -c "import json;r=json.load(open('$EV/host-identity.json'))[0];import sys;sys.exit(0 if r['current_user']=='pscale_api_6t4pvc4cefrg' and not r['postgres_member'] else 1)" || fail "host identity"
bun qualification/branch-helpers.ts sql admin.url "SELECT song_post_id, audio_revision::int, state, duration_samples::text, attempts, canonical_audio_sha256 FROM media_song_canonical_timings ORDER BY song_post_id" > "$EV/timings-before.json"
export QUAL_DATABASE_URL="$(cat "$PRIV/admin.url")"
bun qualification/render-qualification.ts request-timing --song-post $SONG > "$EV/step-timing-request.json" || fail "timing request"
log "timing request: $(python3 -c "import json;print(json.load(open('$EV/step-timing-request.json'))['timing'])")"
bun qualification/render-qualification.ts eligibility --song-post $SONG --audio-revision 1 > "$EV/step-eligibility.json" || fail "eligibility: another timing row exists"
ops bun qualification/branch-helpers.ts mint input object-read-only 3600 --object "$SONG_KEY" > "$EV/mint-input.json" || fail "mint"
bun qualification/branch-helpers.ts host-env measure host.url input - SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID=$SONG SONG_VIDEO_RENDER_MEASURE_AUDIO_REVISION=1 > /dev/null
docker run --rm --network host -v "$PWD:/app" -w /app --env-file "$PRIV/measure.env" "$IMG" bun scripts/song-video-render-host.ts > "$EV/step-measure.raw" 2>&1 || fail "host exited non-zero"
tail -n 1 "$EV/step-measure.raw" > "$EV/step-measure.json"
python3 -c "import json;d=json.load(open('$EV/step-measure.json'));import sys;sys.exit(0 if d['status']=='measured' else 1)" || fail "measurement: $(cat "$EV/step-measure.json")"
bun qualification/render-qualification.ts verify-timing --song-post $SONG --audio-revision 1 --expect-sha256 $SONG_SHA --min-samples 1920000 --expect-prober ffmpeg-6.1.1-song-video-v1 > "$EV/step-verify-timing.json" || fail "timing verification"
bun qualification/branch-helpers.ts sql admin.url "SELECT song_post_id, audio_revision::int, state, duration_samples::text, attempts, canonical_audio_sha256 FROM media_song_canonical_timings ORDER BY song_post_id" > "$EV/timings-after.json"
rm -rf -- "$PRIV"
log "measured: $(cat "$EV/step-measure.json")"
(cd "$EV" && sha256sum $(ls | grep -v '^SHA256SUMS$') > SHA256SUMS && sha256sum -c --quiet SHA256SUMS)
echo "evidence sealed: $(sha256sum "$EV/SHA256SUMS" | cut -c1-16)"
