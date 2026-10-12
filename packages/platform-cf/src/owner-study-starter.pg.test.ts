// Outside successor: genuine maintained0001..0254 ledger, populated ordinary
// baseline lesson and real restricted guest LOGIN. No external private packet.
// No public activation/provider/checkpoint acceptance is implied by these cases.
import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { projectStudySessionItemV2 } from "./study-v2-item-projection.ts";
import {
  accountNew,
  bytesBase64Url,
  completed,
  confirmGuest,
  counts,
  disclosure,
  editFixture,
  financialFingerprint,
  fixture,
  hash,
  lostCommitClient,
  origin,
  pendingGuest,
  pgUrl,
  policy,
  q,
  rejected,
  reserve,
  run,
  seedGuest,
  translation,
} from "./owner-study-starter.pg-fixture.ts";

const suite = pgUrl ? describe : describe.skip;
suite("private owner-aware guest Study starter genuine PostgreSQL", () => {
  test("ordinary account lesson keeps the exact public shared projection before and after guest schema/guards", async () => {
    await fixture(async (f) => {
      const after = await run(
        f.accountStore.getSession({
          accountId: "study-account",
          communityId: "study-community",
          sessionId: f.accountOriginal.session_id,
        }),
      );
      expect(after).toEqual(f.accountOriginal);
      expect(f.accountOriginal.items).toHaveLength(4);
      for (const [ordinal, item] of f.accountOriginal.items.entries()) {
        expect(item).toEqual({
          object: "study_session_item_v2",
          session_item_id: `ordinary-before-guest_item_${ordinal + 1}`,
          ordinal,
          exercise_review_key: `study-say-it-back:study-post:unit-${ordinal + 1}`,
          exercise_version_id: `exercise-${ordinal + 1}`,
          exercise_type: "say_it_back",
          exercise_variant: "spoken-recall-v2",
          line: {
            post_id: "study-post",
            audio_revision: 1,
            lyrics_revision: 1,
            lyric_line_id: `line-${ordinal + 1}`,
            study_unit_id: `unit-${ordinal + 1}`,
            line_version: 1,
            line_source_hash: hash(f.lines[ordinal] ?? ""),
          },
          languages: { learning_language: "en", target_language: null },
          learner_band: null,
          language_profile_revision: null,
          presentation: {
            kind: "say_it_back",
            reference_text: f.lines[ordinal],
            capture: "microphone_audio",
          },
          answer_visibility: "always_visible",
          feedback_release: "every_graded_attempt",
          grader_policy_revision: "script_aware_token_phonetic_v2",
          feedback_policy_revision: "spoken-feedback-v1",
          quality_policy_revision: "accepted-source-v1",
          maximum_attempts: 3,
        });
      }
      const fresh = await accountNew(f, "ordinary-after-guest");
      const owned = await run(
        f.store.getSession({
          access: {
            kind: "account",
            accountId: "study-account",
            sessionBinding: "fixture-ordinary-authenticated-context",
          },
          communityId: "study-community",
          sessionId: fresh.session_id,
        }),
      );
      expect(owned?.source.kind).toBe("account");
      expect(owned?.session).toEqual(fresh);
      expect(JSON.stringify(fresh)).not.toContain("private_grader");
      expect(fresh.items.map((item) => item.language_profile_revision)).toEqual([1, 1, 1, 1]);
    });
  }, 30000);

  test("real restricted guest captures source-only prepared rows with null actors, original reservation clocks and no money/provider effects", async () => {
    await fixture(async (f) => {
      for (const table of [
        "guest_credentials",
        "participation_owners",
        "study_sessions_v2",
        "study_review_items",
        "study_session_items_v2",
        "study_attempts_v2",
        "study_presentations_v2",
        "study_lesson_item_state_v2",
        "learner_audio_artifacts",
      ]) {
        await expect(f.guest.query(`SELECT * FROM ${q(table)} LIMIT 1`)).rejects.toMatchObject({
          code: "42501",
        });
        await expect(f.guest.query(`DELETE FROM ${q(table)}`)).rejects.toMatchObject({
          code: "42501",
        });
      }
      await expect(
        f.guest.query("SELECT guest_study_prepared_rows_v1('study-community','study-post')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.guest.query("SELECT require_guest_study_composition_v1()"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.guest.query("SELECT lock_learner_audio_sources_private_v1('{}')"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        f.guest.query(`CREATE TABLE ${q(f.schema)}.foreign_source(id text)`),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(f.guest.query("SET ROLE postgres")).rejects.toMatchObject({
        code: "42501",
      });
      const proof = await seedGuest(f, 1),
        r = await reserve(f, proof.access, "source-capture");
      const before = await counts(f),
        money = await financialFingerprint(f);
      const outcome = completed(await run(f.store.startSession(r.input)));
      expect(outcome.result.source).toEqual({
        kind: "guest",
        ownerId: proof.ownerId,
      });
      expect(outcome.result.session.session_id).toBe(r.originalSession);
      expect(outcome.result.session.actor).toEqual({ kind: "guest" });
      expect(outcome.result.session.reward_mode).toBe("practice_only");
      expect(outcome.result.session.reward_terms).toBeNull();
      expect(outcome.result.session.participation).toEqual({
        state: "practice_only",
      });
      expect(outcome.result.session.items).toHaveLength(4);
      expect(
        outcome.result.session.items.every(
          (item) => item.maximum_attempts === 3 && item.learner_band === null,
        ),
      ).toBe(true);
      expect(outcome.result.session.lesson.presentation_cap).toBe(12);
      const stored = (
        await f.admin.query(
          `SELECT s.account_id,s.persona_id,s.participation_owner_id,s.participation_owner_kind,
        s.guest_disclosure_version,s.guest_disclosure_accepted,s.guest_start_operation_id,
        s.created_at=r.created_at AS original_created,s.expires_at=r.reservation_expires_at AS original_expiry,
        s.session_id=r.session_id AS original_candidate,s.guest_resource_reservation_id=r.reservation_id AS exact_reservation,
        extract(epoch FROM s.expires_at-s.created_at)::int AS duration
        FROM study_sessions_v2 s JOIN guest_resource_session_reservations r ON r.reservation_id=s.guest_resource_reservation_id WHERE s.session_id=$1`,
          [r.originalSession],
        )
      ).rows[0];
      expect(stored).toEqual({
        account_id: null,
        persona_id: null,
        participation_owner_id: proof.ownerId,
        participation_owner_kind: "guest",
        guest_disclosure_version: disclosure.version,
        guest_disclosure_accepted: true,
        guest_start_operation_id: outcome.outcomeId,
        original_created: true,
        original_expiry: true,
        original_candidate: true,
        exact_reservation: true,
        duration: 86400,
      });
      const after = await counts(f);
      expect(after.accounts).toBe(before.accounts);
      expect(after.personas).toBe(before.personas);
      expect(after.memberships).toBe(before.memberships);
      expect(after.calls).toBe(0);
      expect(after.sessions).toBe(1);
      expect(after.items).toBe(4);
      expect(after.operations).toBe(1);
      expect(await financialFingerprint(f)).toEqual(money);
      expect(JSON.stringify(outcome.result)).not.toContain("private_grader");
      const selected = (
        await f.admin.query(
          `SELECT e.exercise_version_id,e.exercise_review_key,e.exercise_type,e.exercise_variant,e.post_id,
        e.audio_revision,e.lyrics_revision,e.lyric_line_id,e.study_unit_id,e.line_version,e.line_source_hash,e.learning_language,e.target_language,
        e.learner_band,1 AS language_profile_revision,e.presentation,e.answer_visibility,e.feedback_release,e.grader_policy_revision,e.feedback_policy_revision,e.quality_policy_revision
        FROM study_exercise_versions e WHERE exercise_version_id=ANY($1::text[]) ORDER BY exercise_review_key`,
          [outcome.result.session.items.map((i) => i.exercise_version_id)],
        )
      ).rows;
      expect(outcome.result.session.items).toEqual(
        selected.map((row, i) => projectStudySessionItemV2(row, r.originalSession, i)),
      );
      expect(
        (
          await f.admin.query("SELECT state FROM participation_owners WHERE owner_id=$1", [
            proof.ownerId,
          ])
        ).rows,
      ).toEqual([{ state: "established" }]);
    });
  }, 30000);

  test("original-key absence is read-only pending and completed lookup/read bind the original immutable resource source", async () => {
    await fixture(async (f) => {
      const proof = await seedGuest(f, 1),
        before = await counts(f);
      const lookup = {
        access: proof.access,
        sourceOwnerId: proof.ownerId,
        communityId: "study-community",
        postId: "study-post",
        idempotencyKey: "missing-original",
      };
      expect(await run(f.store.findStartOperation(lookup))).toEqual({
        state: "pending_confirmation",
        session: null,
      });
      expect(await counts(f)).toEqual(before);
      const r = await reserve(f, proof.access, "original-key");
      const started = completed(await run(f.store.startSession(r.input)));
      expect(
        await run(
          f.store.findStartOperation({
            ...lookup,
            idempotencyKey: r.input.idempotencyKey,
          }),
        ),
      ).toEqual({ state: "completed", session: started.result.session });
      expect(
        await run(
          f.store.getSession({
            access: proof.access,
            communityId: "study-community",
            sessionId: r.originalSession,
          }),
        ),
      ).toEqual(started.result);
      const other = await seedGuest(f, 2);
      expect(
        await run(
          f.store.getSession({
            access: other.access,
            communityId: "study-community",
            sessionId: r.originalSession,
          }),
        ),
      ).toBeNull();
      expect(
        await run(
          f.store.getSession({
            access: {
              kind: "account",
              accountId: "study-account",
              sessionBinding: "fixture-account-context",
            },
            communityId: "study-community",
            sessionId: r.originalSession,
          }),
        ),
      ).toBeNull();
      expect(
        await run(
          f.store.getSession({
            access: proof.access,
            communityId: "study-community",
            sessionId: "missing-session",
          }),
        ),
      ).toBeNull();
    });
  }, 30000);

  test("same-key replay preserves original session/capture when new draws, catalogue or configured disclosure change; changed hash conflicts", async () => {
    await fixture(async (f) => {
      const proof = await seedGuest(f, 1),
        r = await reserve(f, proof.access, "replay");
      const first = completed(await run(f.store.startSession(r.input))),
        before = await counts(f);
      await f.admin.query(
        "UPDATE study_exercise_versions SET retired_at=clock_timestamp() WHERE post_id='study-post'",
      );
      const newConfig = f.storeFor({}, null, {
        version: "later-disclosure-version",
        text: "Synthetic changed policy, no new capture allowed.",
      });
      expect(
        await run(
          newConfig.startSession({
            ...r.input,
            sessionId: "another-random-candidate",
            createdAt: "2030-01-01T00:00:00.000Z",
          }),
        ),
      ).toEqual(first);
      const changed = {
        ...r.input,
        requestHash: hash("changed-body"),
        operation: { ...r.input.operation, requestHash: hash("changed-body") },
      };
      expect(await rejected(f.store.startSession(changed))).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "idempotency-conflict",
      });
      expect(await counts(f)).toEqual(before);
    });
  }, 30000);

  test("concurrent same-key starts return one reservation-original session and one durable outcome", async () => {
    await fixture(async (f) => {
      const proof = await seedGuest(f, 1),
        r = await reserve(f, proof.access, "concurrent");
      const replies = await Promise.all([
        run(f.store.startSession(r.input)),
        run(f.store.startSession({ ...r.input, sessionId: "second-unused-draw" })),
      ]);
      expect(replies[1]).toEqual(replies[0]);
      expect(completed(replies[0]!).result.session.session_id).toBe(r.originalSession);
      const after = await counts(f);
      expect(after.sessions).toBe(1);
      expect(after.operations).toBe(1);
      expect(after.items).toBe(4);
      expect(after.calls).toBe(0);
    });
  }, 30000);

  test("compatible band-only helper retains null-band source cards and the inherited three-attempt/twenty-presentation limits", async () => {
    await fixture(async (f) => {
      for (let i = 1; i <= 4; i++) await translation(f, i, "ar", "B1");
      const proof = await seedGuest(f, 1),
        r = await reserve(f, proof.access, "helper");
      const value = completed(
        await run(
          f.store.startSession({
            ...r.input,
            learnerBand: "B1",
            targetLanguage: null,
          }),
        ),
      ).result.session;
      expect(value.languages.target_language).toBe("ar");
      expect(value.learner_band).toBe("B1");
      expect(value.items).toHaveLength(8);
      expect(value.items.filter((i) => i.exercise_type === "say_it_back")).toHaveLength(4);
      expect(
        value.items
          .filter((i) => i.exercise_type === "translation_choice")
          .every((i) => i.languages.target_language === "ar" && i.learner_band === "B1"),
      ).toBe(true);
      expect(
        value.items
          .filter((i) => i.exercise_type === "say_it_back")
          .every((i) => i.learner_band === null && i.languages.target_language === null),
      ).toBe(true);
      expect(value.items.every((i) => i.maximum_attempts === 3)).toBe(true);
      expect(value.lesson.presentation_cap).toBe(20);
      expect((await counts(f)).calls).toBe(0);
    });
  }, 30000);

  test("partial independent helper groups cannot pool into a lesson or persist a partial graph", async () => {
    await fixture(async (f) => {
      await f.admin.query(
        "UPDATE study_exercise_versions SET retired_at=clock_timestamp() WHERE exercise_version_id IN('exercise-3','exercise-4')",
      );
      await translation(f, 1, "ar", "B1");
      await translation(f, 2, "zh", "A1");
      const proof = await seedGuest(f, 1),
        r = await reserve(f, proof.access, "incompatible"),
        before = await counts(f);
      expect(await rejected(f.store.startSession(r.input))).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "resource-policy-unavailable",
      });
      expect(await counts(f)).toEqual(before);
    });
  }, 30000);

  test("public visibility, accepted prepared profile and stems are actual source gates with no partial capture", async () => {
    for (const condition of ["private", "profile", "stems"] as const)
      await fixture(async (f) => {
        const proof = await seedGuest(f, 1),
          r = await reserve(f, proof.access, `source-${condition}`),
          before = await counts(f);
        if (condition === "private")
          await editFixture(
            f.admin,
            "UPDATE posts SET visibility='members_only' WHERE post_id='study-post'",
          );
        if (condition === "profile")
          await editFixture(
            f.admin,
            "UPDATE study_language_profiles SET source_hash=$1 WHERE post_id='study-post'",
            [hash("wrong accepted lyrics")],
          );
        if (condition === "stems")
          await editFixture(f.admin, "DELETE FROM media_song_stems WHERE slot='vocal_audio'");
        expect(await rejected(f.store.startSession(r.input))).toMatchObject({
          _tag: "GuestParticipationStoreRejected",
          reason: condition === "private" ? "not-found" : "resource-policy-unavailable",
        });
        expect(await counts(f)).toEqual(before);
      });
  }, 45000);

  test("actual current origin/root/revocation/DB lease refuse stale captured access without rows or provider work", async () => {
    await fixture(async (f) => {
      const proof = await seedGuest(f, 1),
        r = await reserve(f, proof.access, "proof"),
        before = await counts(f);
      expect(
        await rejected(
          f.store.startSession({
            ...r.input,
            access: { ...proof.access, origin: "https://another.example" },
          }),
        ),
      ).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "proof-revoked",
      });
      expect(
        await rejected(
          f.store.startSession({
            ...r.input,
            access: {
              ...proof.access,
              ownerId: "owner_00000000-0000-0000-0000-000000000999",
            },
          }),
        ),
      ).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "owner-mismatch",
      });
      const successor = bytesBase64Url(randomBytes(16)),
        successorDigest = hash(randomBytes(32));
      await f.admin.query("SELECT issue_guest_rotation_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9)", [
        origin,
        [proof.credentialId],
        proof.credentialId,
        proof.ownerId,
        "rotate-proof",
        hash("rotate-proof"),
        "rotate-proof-op",
        successor,
        successorDigest,
      ]);
      const verified = (
        await f.admin.query(
          "SELECT read_guest_browser_proof_snapshot_v1($1,$2::jsonb,'[]',FALSE) AS snapshot",
          [origin, JSON.stringify([{ credentialId: successor, digest: successorDigest }])],
        )
      ).rows[0]?.snapshot;
      await f.admin.query("SELECT acknowledge_guest_rotation_v1($1,$2::text[],$3,$4,$5)", [
        origin,
        verified.provedCredentials.map((p: { credentialId: string }) => p.credentialId),
        proof.credentialId,
        successor,
        proof.ownerId,
      ]);
      expect(await rejected(f.store.startSession(r.input))).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "proof-revoked",
      });
      await editFixture(
        f.admin,
        "UPDATE guest_credentials SET session_until=clock_timestamp()-INTERVAL '1 second' WHERE credential_id=$1",
        [successor],
      );
      expect(
        await rejected(
          f.store.startSession({
            ...r.input,
            access: { ...proof.access, credentialId: successor },
          }),
        ),
      ).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "lease-expired",
      });
      expect(await counts(f)).toEqual(before);
    });
  }, 30000);

  test("new capture needs matching held policy/units/reservation and accepted current disclosure", async () => {
    for (const condition of [
      "missing-policy",
      "changed-policy",
      "units",
      "reservation",
      "disclosure-false",
      "disclosure-stale",
    ] as const)
      await fixture(async (f) => {
        const proof = await seedGuest(f, 1),
          r = await reserve(f, proof.access, condition, condition === "units" ? 1 : 20),
          before = await counts(f);
        const store =
          condition === "missing-policy"
            ? f.storeFor({}, null)
            : condition === "changed-policy"
              ? f.storeFor({}, { ...policy, maximumProviderCallCostMicros: "1001" })
              : f.store;
        const input =
          condition === "reservation"
            ? { ...r.input, resourceReservationId: "absent-reservation" }
            : condition === "disclosure-false"
              ? {
                  ...r.input,
                  disclosure: { version: disclosure.version, accepted: false },
                }
              : condition === "disclosure-stale"
                ? {
                    ...r.input,
                    disclosure: { version: "stale-disclosure", accepted: true },
                  }
                : r.input;
        expect(await rejected(store.startSession(input))).toMatchObject({
          _tag: "GuestParticipationStoreRejected",
          reason: "resource-policy-unavailable",
        });
        expect(await counts(f)).toEqual(before);
      });
  }, 90000);

  test("converged original credential provenance stays on its alias child while capture uses the immutable canonical source", async () => {
    await fixture(async (f) => {
      const first = await pendingGuest(f, 1),
        second = await pendingGuest(f, 2),
        proof = await confirmGuest(f, second, [first, second]);
      expect(proof.ownerId).toBe(first.ownerId);
      // Source/credential convergence and resource reservation do not
      // register audio work or manufacture root/child deletion fences.
      expect(
        (
          await f.admin.query(
            "SELECT owner_id FROM learner_audio_owner_fences WHERE owner_id=ANY($1::text[]) ORDER BY owner_id",
            [[first.ownerId, second.ownerId]],
          )
        ).rows,
      ).toEqual([]);
      const r = await reserve(f, proof.access, "alias-root");
      const result = completed(await run(f.store.startSession(r.input)));
      expect(result.result.session.owner_id).toBe(first.ownerId);
      expect(
        (
          await f.admin.query("SELECT owner_id FROM guest_credentials WHERE credential_id=$1", [
            second.credentialId,
          ])
        ).rows,
      ).toEqual([{ owner_id: second.ownerId }]);
      expect(
        (
          await f.admin.query(
            "SELECT source_owner_id,canonical_owner_id FROM guest_empty_owner_aliases",
          )
        ).rows,
      ).toEqual([{ source_owner_id: second.ownerId, canonical_owner_id: first.ownerId }]);
      expect(
        (
          await f.admin.query(
            "SELECT owner_id FROM learner_audio_owner_fences WHERE owner_id=ANY($1::text[]) ORDER BY owner_id",
            [[first.ownerId, second.ownerId]],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await f.admin.query(
            "SELECT owner_id,state FROM participation_owners WHERE owner_id=ANY($1::text[]) ORDER BY owner_id",
            [[first.ownerId, second.ownerId]],
          )
        ).rows,
      ).toEqual([
        { owner_id: first.ownerId, state: "established" },
        { owner_id: second.ownerId, state: "aliased_empty" },
      ]);
    });
  }, 30000);

  test("live durable deletion blocks new capture while accepted same-key snapshot and read-only reconciliation remain", async () => {
    await fixture(async (f) => {
      const proof = await seedGuest(f, 1),
        original = await reserve(f, proof.access, "before-delete");
      const accepted = completed(await run(f.store.startSession(original.input)));
      const blocked = await reserve(f, proof.access, "during-delete");
      await f.admin.query(
        "SELECT prepare_learner_audio_delete_private_v1($1,$2,$3,$4,$5::text[],$6,100,$7)",
        [
          proof.ownerId,
          "delete-key",
          hash("delete-key"),
          "delete-command",
          [proof.ownerId],
          "delete-batch",
          "not_stored",
        ],
      );
      const before = await counts(f);
      expect(await rejected(f.store.startSession(blocked.input))).toMatchObject({
        _tag: "GuestParticipationStoreRejected",
        reason: "deletion-in-progress",
      });
      expect(await run(f.store.startSession(original.input))).toEqual(accepted);
      expect(
        await run(
          f.store.findStartOperation({
            access: proof.access,
            sourceOwnerId: proof.ownerId,
            communityId: "study-community",
            postId: "study-post",
            idempotencyKey: original.input.idempotencyKey,
          }),
        ),
      ).toEqual({ state: "completed", session: accepted.result.session });
      expect(await counts(f)).toEqual(before);
    });
  }, 30000);

  test("lost actual COMMIT acknowledgement preserves adapter uncertainty and reconciles one original session without redraw", async () => {
    await fixture(async (f) => {
      const proof = await seedGuest(f, 1),
        r = await reserve(f, proof.access, "unknown-commit"),
        fault = lostCommitClient();
      const unknown = await rejected(
        f
          .storeFor({
            clientFactory: fault.clientFactory,
            logger: { info: () => undefined, error: () => undefined },
          })
          .startSession(r.input),
      );
      expect(fault.observed()).toBe(true);
      expect(unknown).toMatchObject({
        _tag: "ControlPlaneTransactionOutcomeUnknown",
        phase: "commit",
      });
      const visible = await run(
        f.store.findStartOperation({
          access: proof.access,
          sourceOwnerId: proof.ownerId,
          communityId: "study-community",
          postId: "study-post",
          idempotencyKey: r.input.idempotencyKey,
        }),
      );
      expect(visible.state).toBe("completed");
      if (visible.state !== "completed") throw new Error("Real committed original session missing");
      expect(visible.session.session_id).toBe(r.originalSession);
      const recovery = completed(
        await run(
          f.store.startSession({
            ...r.input,
            sessionId: "new-draw-after-unknown",
          }),
        ),
      );
      expect(recovery.result.session).toEqual(visible.session);
      const after = await counts(f);
      expect(after.sessions).toBe(1);
      expect(after.operations).toBe(1);
      expect(after.items).toBe(4);
      expect(after.calls).toBe(0);
    });
  }, 30000);

  test("missing restrictive RLS/deferred definer/source inventory fails readiness and successful checkpoint remains unavailable", async () => {
    for (const condition of ["policy", "deferred", "inventory"] as const)
      await fixture(async (f) => {
        const proof = await seedGuest(f, 1),
          r = await reserve(f, proof.access, `readiness-${condition}`),
          before = await counts(f);
        if (condition === "policy")
          await f.admin.query("DROP POLICY guest_raw_account_gate_v1 ON study_sessions_v2");
        if (condition === "deferred")
          await f.admin.query(
            "ALTER FUNCTION validate_study_command_audio_source_v1() SECURITY INVOKER",
          );
        if (condition === "inventory")
          await f.admin.query(
            "CREATE TABLE unreviewed_guest_history(owner_id TEXT REFERENCES participation_owners(owner_id))",
          );
        expect(await rejected(f.store.startSession(r.input))).toMatchObject({
          _tag: "GuestParticipationStoreRejected",
          reason: condition === "inventory" ? "authority-conflict" : "resource-policy-unavailable",
        });
        expect(await counts(f)).toEqual(before);
        await expect(
          f.admin.query("SELECT require_guest_resource_success_checkpoint_v1($1,$2,$3,$4,0)", [
            "invented-checkpoint",
            "invented-call",
            r.reservationId,
            proof.ownerId,
          ]),
        ).rejects.toMatchObject({ code: "GP006" });
      });
  }, 45000);
});
