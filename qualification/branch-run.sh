#!/usr/bin/env bash
# Branch render-host qualification runner (revision 3, adoption terms, rehearsal
# amendments). Usage: branch-run.sh <phase>. Every phase stops on the first
# failed check. Secrets live only under $PRIV (0700); evidence under $EV.
set -euo pipefail
cd "$(dirname "$0")/.."
LANE=$PWD
PRIV=${QUAL_PRIVATE_DIR:?QUAL_PRIVATE_DIR is required}
EV=${QUAL_EVIDENCE_DIR:?QUAL_EVIDENCE_DIR is required}
export QUAL_PRIVATE_DIR=$PRIV
DB=pirate-staging; BRANCH=video-render-qualification-20260922
MERGED_AT=2026-09-23T08:38:58Z; MAIN_SHA=310599ccb799a829d546ff2b2251a7dd2f268075
HARD_DEADLINE=2026-09-26T00:00:00Z
IMG=song-video-render-host:qual-20260922-aa7a99f1
IMG_ID=sha256:7dfb20c68964eb0ae202e7a83cf25268a7d04b28879e7918fa3a03f6d0b93aec
REF_DIGEST=$EV/../reference-catalog-digest-f5419495.json
SONG=media-post-media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b
SONG_SHA=51afd9db7bb1e0be27c0d1fd4c55741d0570027dd6c20a6f087388e971c62d08
SONG_KEY=immutable/media-operation-5f474b7a-6b47-4e86-b585-e65cf2cc3e3b/audio/1
SOURCE_KEY=immutable/media-operation-video-qualification-20260921-01/video/1
MASTER_PREFIX=immutable/song-video-masters/song-video-plan:qualification-20260921-01/
CLIP_START=1440000; CLIP_DURATION=480000
STATE=$EV/state.env
mkdir -p "$EV"; install -d -m 700 "$PRIV"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$EV/run.log"; }
fail() { log "STOP: $*"; exit 1; }
state() { echo "$1=$2" >> "$STATE"; }
load() { [ -f "$STATE" ] && . "$STATE" || true; }
ops() { infisical run --env=staging --path=/services/api-next/operator --silent -- "$@"; }
rt() { infisical run --env=staging --path=/services/api-next --silent -- "$@"; }
snap() { QUAL_DATABASE_URL="$(cat "$PRIV/host-data.url")" bun qualification/table-snapshot.ts > "$EV/snap-$1.json"; }
manifest() { local step=$1 from=$2 to=$3; local tables; tables=$(python3 -c "import json;print(' '.join(json.load(open('qualification/manifests.json'))['manifests']['$step']['tables']))"); bun qualification/snapshot-diff.ts "$EV/snap-$from.json" "$EV/snap-$to.json" $tables > "$EV/diff-$step.json" || fail "manifest $step: table outside manifest"; log "manifest $step ok: $(python3 -c "import json;print([(c['table'],(c['before'] or {}).get('rows'),(c['after'] or {}).get('rows')) for c in json.load(open('$EV/diff-$step.json'))['changed']])")"; }
cost() { load; python3 -c "import datetime as d;c=d.datetime.fromisoformat('$BRANCH_CREATED_AT'.replace('Z','+00:00'));h=(d.datetime.now(d.timezone.utc)-c).total_seconds()/3600;print(f'elapsed {h:.2f} h, estimated cluster cost US\${h*5/730:.4f} at rate 5/month (estimate; invoice is authoritative)')" | tee -a "$EV/run.log"; }
sessions() { bun qualification/branch-helpers.ts sql host-data.url "SELECT usename, application_name, count(*)::int AS n FROM pg_stat_activity WHERE usename IS NOT NULL GROUP BY 1,2 ORDER BY 1,2" > "$EV/sessions-$1-reviewed.json"; load; python3 - "$EV/sessions-$1-reviewed.json" "$HOST_BASE" <<'PY' || fail "unexpected session on branch ($1)"
import json,sys
rows=json.load(open(sys.argv[1])); host=sys.argv[2]
provider={('pscale_admin',''),('pscale_admin','Patroni heartbeat'),('pscale_admin','Patroni restapi'),('pscale_exporter','')}
unexpected=[r for r in rows if (r['usename'],r['application_name']) not in provider|{(host,'')}]
own=sum(r['n'] for r in rows if r['usename']==host)
print('sessions:',rows,'unexpected:',unexpected,'own:',own)
sys.exit(1 if unexpected or own!=1 else 0)
PY
}
host() { local envfile=$1; shift; docker run --rm --network host -v "$LANE:/app" -w /app --env-file "$PRIV/$envfile.env" "$@" "$IMG" bun scripts/song-video-render-host.ts; }

case "${1:-}" in
preflight)
  log "phase preflight"
  [ "$(docker image inspect $IMG --format '{{.Id}}')" = "$IMG_ID" ] || fail "image digest differs"
  git fetch -q origin; [ -z "$(git diff --name-only $MAIN_SHA HEAD -- . ':!qualification')" ] || fail "lane tree differs from $MAIN_SHA"
  pscale backup list $DB main --format json > "$EV/backups.json"
  python3 - "$EV/backups.json" "$MERGED_AT" "${QUAL_BACKUP_ID:-}" > "$EV/backup-selected.json" <<'PY' || fail "no eligible backup yet"
import json,sys,datetime as d
merged=d.datetime.fromisoformat(sys.argv[2].replace('Z','+00:00'))
bs=[b for b in json.load(open(sys.argv[1])) if b.get('state')=='success' and b.get('completed_at') and d.datetime.fromisoformat(b['completed_at'].replace('Z','+00:00'))>merged and d.datetime.fromisoformat(b['expires_at'].replace('Z','+00:00'))>d.datetime.now(d.timezone.utc)]
# An explicitly named backup (the owner-directed manual backup) must itself meet the same rules.
if sys.argv[3]: bs=[b for b in bs if b['id']==sys.argv[3]]
bs.sort(key=lambda b:b['completed_at'])
if not bs: sys.exit(1)
b=bs[0]; print(json.dumps({k:b[k] for k in ('id','name','created_at','completed_at','expires_at','size')}))
PY
  BACKUP_ID=$(python3 -c "import json;print(json.load(open('$EV/backup-selected.json'))['id'])")
  log "backup $(cat $EV/backup-selected.json)"
  python3 -c "import datetime as d;n=d.datetime.now(d.timezone.utc);import sys;sys.exit(0 if n+d.timedelta(hours=4)<d.datetime.fromisoformat('$HARD_DEADLINE'.replace('Z','+00:00')) else 1)" || fail "not enough time before the deletion deadline"
  ops sh -c 'QUAL_CHECK_URL="$CONTROL_PLANE_POSTGRES_ADMIN_URL" bun qualification/song-checks.ts' > "$EV/song-checks-main.json" || fail "song checks on main"
  [ -f "$EV/capture.mp4" ] || docker run --rm -v "$EV:/out" --entrypoint ffmpeg "$IMG" -loglevel error -f lavfi -i "testsrc=size=320x480:rate=30:duration=12" -f lavfi -i "sine=frequency=220:duration=12" -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart /out/capture.mp4
  log "source video sha256 $(sha256sum "$EV/capture.mp4" | cut -c1-64)"
  state BACKUP_ID "$BACKUP_ID"; log "preflight ok";;
create)
  load; [ -n "${BACKUP_ID:-}" ] || fail "run preflight first"
  pscale branch list $DB --format json | python3 -c "import json,sys;sys.exit(1 if any(b['name']=='$BRANCH' for b in json.load(sys.stdin)) else 0)" || fail "branch already exists"
  log "phase create: restoring $BACKUP_ID into $BRANCH at PS_5_AWS_ARM"
  pscale branch create $DB $BRANCH --restore "$BACKUP_ID" --cluster-size PS_5_AWS_ARM --wait --format json > "$EV/branch-create.json"
  pscale branch show $DB $BRANCH --format json > "$EV/branch-show.json"
  BRANCH_ID=$(python3 -c "import json;print(json.load(open('$EV/branch-show.json'))['id'])")
  CREATED=$(python3 -c "import json;print(json.load(open('$EV/branch-show.json'))['created_at'])")
  DELETE_BY=$(python3 -c "import datetime as d;c=d.datetime.fromisoformat('$CREATED'.replace('Z','+00:00'));h=d.datetime.fromisoformat('$HARD_DEADLINE'.replace('Z','+00:00'));print(min(c+d.timedelta(hours=72),h).strftime('%Y-%m-%dT%H:%M:%SZ'))")
  state BRANCH_ID "$BRANCH_ID"; state BRANCH_CREATED_AT "$CREATED"; state DELETE_BY "$DELETE_BY"
  log "branch $BRANCH id $BRANCH_ID created $CREATED; delete by $DELETE_BY"; cost;;
branch-host-role)
  # A restored PlanetScale branch has no login for the source table owner, so
  # exact table grants cannot be issued here. This data-only role is confined
  # to the disposable branch. Staging main still requires exact grants.
  load; [ -n "${BRANCH_ID:-}" ] || fail "no branch"
  [ ! -e "$EV/role-host-data.json" ] || fail "branch data role already recorded"
  pscale role create $DB $BRANCH qual-render-host-data --inherited-roles pg_read_all_data,pg_write_all_data --ttl 12h --format json | bun qualification/branch-helpers.ts save-role host-data > "$EV/role-host-data.json"
  HOST_BASE=$(python3 -c "import json;print(json.load(open('$EV/role-host-data.json'))['base_username'])")
  [ "$(python3 -c "import json;print(json.load(open('$EV/role-host-data.json'))['branch_suffix'])")" = "$BRANCH_ID" ] || fail "host data role not on the qualification branch"
  [[ $HOST_BASE =~ ^pscale_api_[a-z0-9]+$ ]] || fail "host data role name unexpected"
  bun qualification/branch-helpers.ts sql host-data.url "SELECT r.rolname, r.rolsuper, r.rolinherit, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls, r.rolcanlogin,
    has_database_privilege(r.rolname,current_database(),'CREATE') AS database_create,
    has_schema_privilege(r.rolname,'api_next','CREATE') AS schema_create,
    (SELECT coalesce(json_agg(p.rolname ORDER BY p.rolname),'[]'::json) FROM pg_auth_members m JOIN pg_roles p ON p.oid=m.roleid WHERE m.member=r.oid) AS inherited_roles,
    (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='api_next' AND c.relowner=r.oid) AS owned_objects
    FROM pg_roles r WHERE r.rolname='$HOST_BASE'" > "$EV/role-host-data-readback.json"
  bun qualification/branch-role-policy.ts "$EV/role-host-data-readback.json" "$HOST_BASE" || fail "branch data role has unexpected privileges"
  state HOST_BASE "$HOST_BASE"
  log "branch host data-only role verified";;
branch-preflight)
  load
  [ -n "${HOST_BASE:-}" ] && [ -f "$EV/role-host-data-readback.json" ] || fail "branch host role is not verified"
  bun qualification/branch-role-policy.ts "$EV/role-host-data-readback.json" "$HOST_BASE" > "$EV/role-host-data-policy.json" || fail "branch host role policy changed"
  bun qualification/branch-helpers.ts sql host-data.url "SELECT version, checksum FROM api_next.schema_migrations ORDER BY version" > "$EV/branch-ledger.json"
  git show $MAIN_SHA:db/postgres/migrations/checksums.json > "$EV/expected-checksums.json"
  python3 - "$EV" <<'PY' || fail "branch ledger differs from $MAIN_SHA"
import json,sys
e=sys.argv[1]; led={r['version']:r['checksum'] for r in json.load(open(e+'/branch-ledger.json'))}; exp=json.load(open(e+'/expected-checksums.json'))
exp=exp.get('migrations',exp) if isinstance(exp,dict) else exp
print('ledger entries',len(led),'expected',len(exp),'equal',led==exp); sys.exit(0 if led==exp else 1)
PY
  QUAL_DATABASE_URL="$(cat "$PRIV/host-data.url")" bun qualification/catalog-digest.ts > "$EV/branch-catalog-digest.json"
  python3 -c "import json;a=json.load(open('$EV/branch-catalog-digest.json'));b=json.load(open('$REF_DIGEST'));d=[k for k in b['digests'] if a['digests'].get(k)!=b['digests'][k]];print('catalog differing objects:',d,'missing',a['missing']);import sys;sys.exit(1 if d or a['missing'] else 0)" || fail "catalog digest differs"
  QUAL_CHECK_URL="$(cat "$PRIV/host-data.url")" bun qualification/song-checks.ts > "$EV/song-checks-branch.json" || fail "song checks on branch"
  python3 -c "import json;f=json.load(open('$EV/song-checks-branch.json'))['facts'];import sys;sys.exit(0 if f['timings']==0 and f['render_attempts']==0 else 1)" || fail "branch timings or attempts not empty"
  rt bun qualification/isolation-check.ts "$BRANCH_ID" --require-hyperdrive > "$EV/isolation-runtime.json" || fail "isolation (runtime path)"
  ops bun qualification/isolation-check.ts "$BRANCH_ID" > "$EV/isolation-operator.json" || fail "isolation (operator path)"
  sessions preflight
  log "branch preflight ok";;
sequence)
  load
  ops bun qualification/branch-helpers.ts mint input object-read-only 7200 --object "$SOURCE_KEY" --object "$SONG_KEY" > "$EV/mint-input.json" 2>&1 < /dev/null || fail "mint input"
  export QUAL_DATABASE_URL="$(cat "$PRIV/host-data.url")"
  snap A
  bun qualification/render-qualification.ts request-timing --song-post $SONG > "$EV/step-timing-request.json" || fail "timing request"
  snap B; manifest timing_request A B
  bun qualification/render-qualification.ts eligibility --song-post $SONG --audio-revision 1 > "$EV/step-eligibility.json" || fail "eligibility"
  bun qualification/branch-helpers.ts host-env measure host-data.url input - SONG_VIDEO_RENDER_MEASURE_SONG_POST_ID=$SONG SONG_VIDEO_RENDER_MEASURE_AUDIO_REVISION=1 > /dev/null
  host measure > "$EV/step-measure.json" || fail "measurement exited non-zero"
  python3 -c "import json;d=json.load(open('$EV/step-measure.json'));import sys;sys.exit(0 if d['status']=='measured' else 1)" || fail "measurement status $(cat $EV/step-measure.json)"
  snap C; manifest measurement B C
  bun qualification/render-qualification.ts verify-timing --song-post $SONG --audio-revision 1 --expect-sha256 $SONG_SHA --min-samples $((CLIP_START+CLIP_DURATION)) --expect-prober ffmpeg-6.1.1-song-video-v1 > "$EV/step-verify-timing.json" || fail "timing verification"
  log "timing ready: $(python3 -c "import json;print(json.load(open('$EV/step-verify-timing.json'))['row']['duration_samples'])")"
  snap D0
  ops bun qualification/branch-helpers.ts mint upload object-read-write 3600 --object "$SOURCE_KEY" > "$EV/mint-upload.json" || fail "mint upload"
  bun qualification/branch-helpers.ts upload-env upload > /dev/null
  set -a; . "$PRIV/upload.env"; set +a
  bun qualification/render-qualification.ts upload-source --account 08a4c22cf52e2ecae883e36f80a33f4a --bucket pirate-media-immutable-staging --file "$EV/capture.mp4" > "$EV/step-upload.json" || fail "source upload"
  unset QUAL_R2_ACCESS_KEY_ID QUAL_R2_SECRET_ACCESS_KEY QUAL_R2_SESSION_TOKEN
  ETAG=$(python3 -c "import json;print(json.load(open('$EV/step-upload.json'))['etag'])")
  bun qualification/render-qualification.ts create-fixture --song-post $SONG --file "$EV/capture.mp4" --etag "$ETAG" --clip-start $CLIP_START --clip-duration $CLIP_DURATION > "$EV/step-fixture.json" || fail "fixture creation"
  snap D; manifest fixture D0 D
  PLAN=$(python3 -c "import json;print(json.load(open('$EV/step-fixture.json'))['attempt']['planId'])"); ATT=$(python3 -c "import json;print(json.load(open('$EV/step-fixture.json'))['attempt']['attemptId'])")
  [ "$ATT" = "$(python3 -c "import json;print(json.load(open('qualification/manifests.json'))['identities']['attempt_id'])")" ] || fail "attempt id $ATT differs from the bound id"
  sessions before-render
  ops bun qualification/branch-helpers.ts mint output object-read-write 7200 --prefix "$MASTER_PREFIX" > "$EV/mint-output.json" || fail "mint output"
  bun qualification/branch-helpers.ts host-env render host-data.url input output SONG_VIDEO_RENDER_PLAN_ID=$PLAN SONG_VIDEO_RENDER_ATTEMPT_ID=$ATT SONG_VIDEO_RENDER_HOST_ID=song-video-render-host-qualification-20260921-01 > /dev/null
  set +e; host render > "$EV/step-render.json" 2> "$EV/step-render.err"; RC=$?; set -e
  log "render exit $RC: $(cat $EV/step-render.json)"
  snap E; manifest render D E
  sessions after-render
  [ $RC = 0 ] && python3 -c "import json;import sys;sys.exit(0 if json.load(open('$EV/step-render.json'))['status']=='accepted' else 1)" || fail "render did not conclude accepted"
  bun qualification/branch-helpers.ts sql host-data.url "SELECT a.state, a.execution_phase, m.master_sha256, m.master_byte_length::text, m.verified_object_key, m.verified_object_etag FROM api_next.media_song_video_render_attempts a JOIN api_next.media_song_video_masters m ON m.attempt_id=a.attempt_id" > "$EV/render-rows.json"
  log "sequence complete"; cost;;
verify-evidence)
  # Option A: the branch may be deleted only after this passes. It checks that
  # the evidence a completed run must hold exists and parses; it does not seal.
  load
  missing=""
  for f in backup-selected.json branch-show.json role-host-data.json role-host-data-readback.json role-host-data-policy.json \
           branch-ledger.json branch-catalog-digest.json song-checks-branch.json isolation-runtime.json isolation-operator.json \
           snap-A.json snap-B.json snap-C.json snap-D0.json snap-D.json snap-E.json \
           diff-timing_request.json diff-measurement.json diff-fixture.json diff-render.json \
           step-measure.json step-verify-timing.json step-upload.json step-fixture.json step-render.json render-rows.json; do
    [ -s "$EV/$f" ] && python3 -c "import json;json.load(open('$EV/$f'))" 2>/dev/null || missing="$missing $f"
  done
  [ -z "$missing" ] || fail "evidence missing or unparseable:$missing"
  log "evidence verified before deletion";;
delete)
  load; [ -n "${BRANCH_ID:-}" ] || fail "no branch recorded"
  rt bun qualification/isolation-check.ts "$BRANCH_ID" --require-hyperdrive > "$EV/isolation-before-delete.json" || fail "isolation before delete"
  cost
  pscale branch delete $DB $BRANCH --force > "$EV/branch-delete.txt" 2>&1 || fail "branch delete"
  if pscale branch show $DB $BRANCH --format json > /dev/null 2>&1; then fail "branch still visible after delete"; fi
  pscale branch list $DB --format json | python3 -c "import json,sys;sys.exit(1 if any(b['name']=='$BRANCH' for b in json.load(sys.stdin)) else 0)" || fail "branch still listed"
  rm -f "$PRIV"/*.url; log "branch deleted and confirmed absent";;
seal)
  # Final action, after deletion or after an early stop: removes the private
  # material, then hashes and verifies whatever evidence exists. Nothing is
  # written into the evidence folder after the checksums are computed.
  rm -rf -- "$PRIV"
  log "sealing evidence"
  (cd "$EV" && rm -f SHA256SUMS && sha256sum $(ls | grep -v -E '^SHA256SUMS$') > SHA256SUMS && sha256sum -c --quiet SHA256SUMS) || { echo "STOP: seal failed" >&2; exit 1; }
  echo "evidence sealed and verified: $(ls "$EV" | grep -vc '^SHA256SUMS$') files, SHA256SUMS $(sha256sum "$EV/SHA256SUMS" | cut -c1-64)";;
*) echo "usage: branch-run.sh preflight|create|branch-host-role|branch-preflight|sequence|verify-evidence|delete|seal"; exit 2;;
esac
