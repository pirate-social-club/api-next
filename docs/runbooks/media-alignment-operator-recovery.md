# Recovering unavailable song alignment

This command requests the existing operator recovery for a published song whose
exact alignment projection is unavailable. It requires PostgreSQL administrator
authority and derives the audit principal from `session_user`. It grants no
browser or moderator permission.

Review the unavailable projection, consumed attempt and retained publication
lineage first. One recovery identity is allowed per exact publication. The
consumed attempt is never reset. Supply a JSON request containing exactly:

```json
{
  "communityId": "community-id",
  "submissionId": "submission-id",
  "actorUserId": "account-id",
  "personaId": "persona-id",
  "idempotencyKey": "reviewed-alignment-recovery-id",
  "evidenceRef": "review/alignment-recovery-evidence",
  "expectedWorkflowRevision": 2,
  "expected": {
    "postId": "media-post-operation-id",
    "audioRevision": 1,
    "analysisRevision": 1,
    "lyricsRevision": 1,
    "canonicalAudioSha256": "replace-with-exact-64-lowercase-hex-hash",
    "lyricsSha256": "replace-with-exact-64-lowercase-hex-hash"
  }
}
```

Supply `CONTROL_PLANE_POSTGRES_ADMIN_URL` through the authorized secret runner.
Never put credentials in the request, command line, logs or evidence. Preview
without writes:

```sh
bun scripts/media-alignment-operator-recovery.ts --request /path/to/request.json
```

Compare every returned lineage field to the request. The submission must be
published, alignment unavailable and persona unchanged. A previous recovery is
allowed only for an exact idempotent replay. After separate execution approval:

```sh
bun scripts/media-alignment-operator-recovery.ts --request /path/to/request.json --execute
```

The transaction checks exact lineage, records operator evidence, advances the
Workflow revision and creates a replacement outbox. Identical replay returns
the original result. Changed input under the same key conflicts. A different
key cannot create another recovery for the same projection.

The command makes no provider call, but delivery of its outbox can cause an
alignment-recovery provider attempt. Live approval must include that consequence
and budget. A committed request is not completion: observe the outbox, Workflow,
recovery action, processing attempt, alignment projection, artifact binding and
Karaoke readiness until a durable result exists.

If output is lost, repeat the identical request. Never use a new key for an
uncertain result or manually reset attempts, recovery rows or projections.
