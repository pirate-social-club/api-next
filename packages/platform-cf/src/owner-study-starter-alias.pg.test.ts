// Outside proposal. Root adopts with actual0254 alias-aware access helper and
// genuine fixture suffix. Isolated read-only recovery proof, no paid capture.
import { describe, expect, test } from "bun:test";
import {
  confirmGuest,
  editFixture,
  type Fixture,
  financialFingerprint,
  fixture,
  hash,
  origin,
  pendingGuest,
  pgUrl,
  q,
  rejected,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";

const suite = pgUrl ? describe : describe.skip;
async function retainedState(f: Fixture) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "participation_owners",
    "guest_credentials",
    "guest_empty_owner_aliases",
    "participation_owner_clocks",
    "guest_learning_preferences",
    "guest_participation_operations",
    "guest_secret_issuance_operations",
    "guest_attachment_intents",
    "study_sessions_v2",
    "study_review_items",
    "study_session_items_v2",
    "study_spoken_answer_commands",
    "learner_audio_artifacts",
    "study_attempts_v2",
    "study_presentations_v2",
    "study_lesson_item_state_v2",
    "guest_resource_session_reservations",
    "guest_resource_provider_calls",
    "guest_resource_release_receipts",
    "learner_audio_owner_fences",
    "learner_audio_delete_commands",
    "learner_audio_delete_sources",
    "learner_audio_delete_target_artifacts",
    "learner_audio_object_names",
    "learner_audio_upload_attempts",
    "learner_audio_delete_batches",
    "learner_audio_delete_batch_items",
    "learner_audio_deleted_objects",
  ]) {
    result[table] = (
      await f.admin.query(
        `SELECT count(*)::INT AS n,encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::TEXT),'[]'::JSONB)::TEXT,'UTF8')),'hex') AS digest FROM ${q(table)} t`,
      )
    ).rows;
  }
  return result;
}
async function aliasWithRetainedAbort(f: Fixture) {
  const canonical = await pendingGuest(f, 1);
  const original = await pendingGuest(f, 2);
  // Known abort is a real immutable row, not absence, a timeout or a GET fence.
  // There is no resource/session history; actual convergence permits this one
  // retained aborted fact and forbids established sources or uncertain starts.
  await f.admin.query(
    `WITH observed AS(SELECT clock_timestamp() AS at)
    INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,resource_scope,idempotency_key,request_hash,state,created_at,resolved_at)
    SELECT 'aborted-original-start',$1,'study_start',guest_study_start_resource_scope_v1('study-community','study-post'),'aborted-original-key',$2,'known_aborted',observed.at,observed.at FROM observed`,
    [original.ownerId, hash("aborted-original-request")],
  );
  const proved = await confirmGuest(f, canonical, [canonical, original]);
  expect(proved.ownerId).toBe(canonical.ownerId);
  expect(
    (
      await f.admin.query("SELECT state FROM participation_owners WHERE owner_id=$1", [
        original.ownerId,
      ])
    ).rows,
  ).toEqual([{ state: "aliased_empty" }]);
  expect(
    (
      await f.admin.query(
        "SELECT canonical_owner_id FROM guest_empty_owner_aliases WHERE source_owner_id=$1",
        [original.ownerId],
      )
    ).rows,
  ).toEqual([{ canonical_owner_id: canonical.ownerId }]);
  return {
    proved,
    original,
    lookup: {
      access: proved.access,
      sourceOwnerId: original.ownerId,
      communityId: "study-community",
      postId: "study-post",
      idempotencyKey: "aborted-original-key",
    },
  };
}
suite("original empty-alias start lookup authority", () => {
  test("proved canonical root reads original known abort and absence without changing any retained history or economics", async () => {
    await fixture(async (f) => {
      const { lookup } = await aliasWithRetainedAbort(f);
      const before = await retainedState(f);
      const money = await financialFingerprint(f);
      expect(await run(f.store.findStartOperation(lookup))).toEqual({
        state: "not_started",
        session: null,
      });
      expect(
        await run(f.store.findStartOperation({ ...lookup, idempotencyKey: "absent-original-key" })),
      ).toEqual({ state: "pending_confirmation", session: null });
      // Actual restricted LOGIN has only the reviewed four entrypoints.
      await expect(
        f.guest.query("SELECT * FROM guest_participation_operations"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.guest.query("SELECT require_guest_study_learning_access_v1($1::JSONB,$2)", [
          JSON.stringify(lookup.access),
          lookup.sourceOwnerId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      expect(await retainedState(f)).toEqual(before);
      expect(await financialFingerprint(f)).toEqual(money);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::INT AS n FROM guest_participation_operations WHERE source_owner_id=$1 AND idempotency_key='absent-original-key'",
            [lookup.sourceOwnerId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    });
  }, 30000);
  test("unrelated root, wrong origin, expired DB lease and revoked proof cannot read aliased original facts", async () => {
    await fixture(async (f) => {
      const { lookup } = await aliasWithRetainedAbort(f);
      const other = await seedGuest(f, 3);
      for (const [selectedAccess, reason] of [
        [other.access, "owner-mismatch"],
        [{ ...lookup.access, origin: "https://name.example" }, "proof-revoked"],
      ] as const) {
        const before = await retainedState(f);
        expect(
          await rejected(f.store.findStartOperation({ ...lookup, access: selectedAccess })),
        ).toMatchObject({ _tag: "GuestParticipationStoreRejected", reason });
        expect(await retainedState(f)).toEqual(before);
      }
      // Deliberately historical disposable fixture clock, not an expiry writer
      // or evidence that the normal protocol permits shortening a lease.
      await editFixture(
        f.admin,
        "UPDATE guest_credentials SET session_until=clock_timestamp()-INTERVAL '1 minute' WHERE credential_id=$1",
        [lookup.access.credentialId],
      );
      const expired = await retainedState(f);
      expect(await rejected(f.store.findStartOperation(lookup))).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "lease-expired",
      });
      expect(await retainedState(f)).toEqual(expired);
      // Legitimate zero-history cleanup records revocation; original abort stays.
      await f.admin.query(
        "SELECT cleanup_guest_authority_v1($1,ARRAY[$2]::TEXT[],'{}',NULL,ARRAY[$2]::TEXT[],'{}')",
        [origin, lookup.access.credentialId],
      );
      const revoked = await retainedState(f);
      expect(await rejected(f.store.findStartOperation(lookup))).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "proof-revoked",
      });
      expect(await retainedState(f)).toEqual(revoked);
    });
  }, 30000);
});
