// Outside draft. Uses genuine maintained0001..0254 fixture plus exact adopted
// successor, real ordinary baseline actor and restricted Guest LOGIN. No provider
// dispatch/checkpoint settlement/new endpoint activation is implied. No tests run.
import { describe, expect, test } from "bun:test";
import {
  completed,
  counts,
  editFixture,
  financialFingerprint,
  fixture,
  hash,
  pgUrl,
  policy,
  rejected,
  reserve,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";
const suite = pgUrl ? describe : describe.skip;
suite("immutable guest spoken paid-call plan", () => {
  test(
    "four spoken cards capture 12 graded slots plus 12 rerecord calls without changing public lesson",
    async () =>
      fixture(async (f) => {
        const access = await seedGuest(f, 71),
          r = await reserve(f, access.access, "plan-capture", 24);
        const session = completed(await run(f.store.startSession(r.input)));
        expect(session.result.session.items).toHaveLength(4);
        const stored = (
          await f.admin.query(
            "SELECT guest_spoken_call_plan AS plan,guest_resource_reservation_id FROM study_sessions_v2 WHERE session_id=$1",
            [r.originalSession],
          )
        ).rows[0];
        expect(stored.plan).toEqual({
          policy_revision: "study_spoken_rerecord_v1",
          graded_presentation_cap: 12,
          ungraded_rerecord_per_presentation: 1,
          maximum_paid_calls: 24,
        });
        const before = await counts(f),
          finance = await financialFingerprint(f);
        for (const enabled of [true, false])
          await f.admin.query("SELECT require_guest_spoken_resource_plan_v1($1,$2,$3,$4)", [
            access.ownerId,
            r.originalSession,
            r.reservationId,
            enabled,
          ]);
        expect(await counts(f)).toEqual(before);
        expect(await financialFingerprint(f)).toEqual(finance);
        await expect(
          f.guest.query("SELECT require_guest_spoken_resource_plan_v1($1,$2,$3,true)", [
            access.ownerId,
            r.originalSession,
            r.reservationId,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          f.admin.query(
            "UPDATE study_sessions_v2 SET guest_spoken_call_plan=NULL WHERE session_id=$1",
            [r.originalSession],
          ),
        ).rejects.toMatchObject({ code: "GP003" });
        await expect(
          f.admin.query("SELECT require_guest_spoken_resource_plan_v1($1,$2,$3,true)", [
            access.ownerId,
            r.originalSession,
            "foreign-reservation",
          ]),
        ).rejects.toMatchObject({ code: "GP006" });
        await expect(
          f.admin.query("SELECT require_guest_spoken_resource_plan_v1($1,$2,$3,NULL)", [
            access.ownerId,
            r.originalSession,
            r.reservationId,
          ]),
        ).rejects.toMatchObject({ code: "GP006" });
        // Fixture-only historical mutable-state seed. No claim of runtime expiry or
        // release authority: immutable identity/captured plan/original clocks stay put.
        await editFixture(
          f.admin,
          "UPDATE guest_resource_session_reservations SET state='expired',remaining_units=0,released_at=clock_timestamp() WHERE reservation_id=$1",
          [r.reservationId],
        );
        const expiredBefore = await counts(f);
        await f.admin.query("SELECT require_guest_spoken_resource_plan_v1($1,$2,$3,true)", [
          access.ownerId,
          r.originalSession,
          r.reservationId,
        ]);
        expect(await counts(f)).toEqual(expiredBefore);
      }),
    30000,
  );
  test(
    "pre-plan historical NULL remains readable but cannot authorize a paid call or be silently backfilled",
    async () =>
      fixture(async (f) => {
        const access = await seedGuest(f, 72),
          r = await reserve(f, access.access, "legacy-plan", 24);
        const original = completed(await run(f.store.startSession(r.input)));
        // Explicit historical fixture seed ONLY. No production backfill/proof forged.
        await editFixture(
          f.admin,
          "UPDATE study_sessions_v2 SET guest_spoken_call_plan=NULL WHERE session_id=$1",
          [r.originalSession],
        );
        const before = await counts(f),
          finance = await financialFingerprint(f);
        await expect(
          f.admin.query("SELECT require_guest_spoken_resource_plan_v1($1,$2,$3,true)", [
            access.ownerId,
            r.originalSession,
            r.reservationId,
          ]),
        ).rejects.toMatchObject({ code: "GP006" });
        expect(
          completed(
            await run(f.store.startSession({ ...r.input, sessionId: "ignored-fresh-candidate" })),
          ),
        ).toEqual(original);
        expect(await counts(f)).toEqual(before);
        expect(await financialFingerprint(f)).toEqual(finance);
        expect(
          (
            await f.admin.query(
              "SELECT guest_spoken_call_plan AS plan FROM study_sessions_v2 WHERE session_id=$1",
              [r.originalSession],
            )
          ).rows[0].plan,
        ).toBeNull();
        // A NEW INSERT cannot exploit the historical nullable storage branch. Guard
        // rejects missing plan before unrelated new identity/FK checks can run.
        await expect(
          f.admin.query(
            `INSERT INTO study_sessions_v2 SELECT(jsonb_populate_record(NULL::study_sessions_v2,to_jsonb(s)||jsonb_build_object('session_id','new-missing-plan','guest_spoken_call_plan',NULL))).* FROM study_sessions_v2 s WHERE session_id=$1`,
            [r.originalSession],
          ),
        ).rejects.toMatchObject({ code: "GP003" });
      }),
    30000,
  );
  test(
    "40-call reservation retains owner rolling60, exact money, same-key and not-invoked accounting",
    async () =>
      fixture(async (f) => {
        const access = await seedGuest(f, 73);
        const request = async (key: string, units: number) =>
          (
            await f.admin.query(
              "SELECT reserve_guest_resource_session_v1($1,$2::jsonb,$3,$4,$5,$6,$7::jsonb) AS reply",
              [
                access.ownerId,
                JSON.stringify({
                  sourceOwnerId: access.ownerId,
                  kind: "study_start",
                  idempotencyKey: key,
                  requestHash: hash(key),
                }),
                `session-${key}`,
                units,
                String(units * 1000),
                "plan-budget-edge",
                JSON.stringify(policy),
              ],
            )
          ).rows[0].reply;
        const first = await request("forty", 40);
        expect(first.result.state).toBe("reserved");
        expect(first.result.remainingUnits).toBe(40);
        expect(await request("forty", 40)).toEqual(first);
        await expect(request("forty-one", 41)).rejects.toMatchObject({ code: "22023" });
        expect((await request("over-sixty", 21)).result.state).toBe("budget_refused");
        expect((await request("exact-sixty", 20)).result.state).toBe("reserved");
        const usage = async () =>
          (
            await f.admin.query(
              "SELECT owner_calls::text,owner_cost::text FROM guest_resource_usage_v1(ARRAY[$1]::text[],clock_timestamp())",
              [access.ownerId],
            )
          ).rows[0];
        expect(await usage()).toEqual({ owner_calls: "60", owner_cost: "60000" });
        const op = {
          sourceOwnerId: access.ownerId,
          kind: "study_answer",
          idempotencyKey: "paid-rerecord-or-grade",
          requestHash: hash("paid-rerecord-or-grade"),
        };
        const paid = async () =>
          (
            await f.admin.query(
              "SELECT reserve_guest_provider_call_v1($1,$2::jsonb,$3,$4,1,'1000',$5) AS reply",
              [
                access.ownerId,
                JSON.stringify(op),
                "session-forty",
                first.outcome_id,
                policy.costPolicyVersion,
              ],
            )
          ).rows[0].reply;
        const call = await paid();
        expect(call.result.state).toBe("reserved");
        expect((await paid()).result.state).toBe("unknown");
        expect(await usage()).toEqual({ owner_calls: "60", owner_cost: "60000" });
        const finish = () =>
          f.admin.query(
            "SELECT complete_guest_provider_call_v1($1,$2::jsonb,$3,$4,'not_invoked',NULL,NULL)",
            [access.ownerId, JSON.stringify(op), first.outcome_id, call.outcome_id],
          );
        await finish();
        await finish();
        expect((await paid()).state).toBe("known_aborted");
        expect(await usage()).toEqual({ owner_calls: "60", owner_cost: "60000" });
        expect(
          (
            await f.admin.query(
              "SELECT remaining_units FROM guest_resource_session_reservations WHERE reservation_id=$1",
              [first.outcome_id],
            )
          ).rows[0].remaining_units,
        ).toBe(40);
      }),
    30000,
  );
  test(
    "the old 20-unit cap cannot admit a new four-spoken-card plan",
    async () =>
      fixture(async (f) => {
        const access = await seedGuest(f, 74),
          r = await reserve(f, access.access, "underreserved-plan", 20),
          before = await counts(f);
        expect(await rejected(f.store.startSession(r.input))).toMatchObject({
          _tag: "GuestParticipationStoreRejected",
          reason: "resource-policy-unavailable",
        });
        expect(await counts(f)).toEqual(before);
      }),
    30000,
  );
  test(
    "ten genuinely prepared spoken cards capture forty calls and retain twenty lesson presentations",
    async () =>
      fixture(async (f) => {
        const extended = [...f.lines];
        for (let n = 5; n <= 10; n++) {
          const line = `Fixture spoken source line ${n}`,
            digest = hash(line);
          extended.push(line);
          const copy = async (table: string, where: string, patch: Record<string, unknown>) =>
            editFixture(
              f.admin,
              `INSERT INTO ${table} SELECT(jsonb_populate_record(NULL::${table},to_jsonb(source)||$1::jsonb)).* FROM ${table} source WHERE ${where}`,
              [JSON.stringify(patch)],
            );
          await copy("localization_lyric_line_occurrences", "lyric_line_id='line-1'", {
            lyric_line_id: `line-${n}`,
          });
          await copy(
            "localization_lyric_line_versions",
            "lyric_line_id='line-1' AND line_version=1",
            { lyric_line_id: `line-${n}`, canonical_text: line, source_hash: digest },
          );
          await copy("localization_study_units", "study_unit_id='unit-1'", {
            study_unit_id: `unit-${n}`,
            normalized_source_hash: digest,
          });
          await copy(
            "localization_lyric_line_study_units",
            "lyric_line_id='line-1' AND line_version=1",
            { lyric_line_id: `line-${n}`, study_unit_id: `unit-${n}` },
          );
          await copy(
            "localization_lyrics_revision_lines",
            "lyric_line_id='line-1' AND lyrics_revision=1",
            { lyric_line_id: `line-${n}`, ordinal: n, source_hash: digest },
          );
          await copy(
            "study_language_profile_units",
            "study_unit_id='unit-1' AND language_profile_revision=1",
            { study_unit_id: `unit-${n}` },
          );
          await copy("study_exercise_versions", "exercise_version_id='exercise-1'", {
            exercise_version_id: `exercise-${n}`,
            lyric_line_id: `line-${n}`,
            line_source_hash: digest,
            exercise_review_key: `study-say-it-back:study-post:unit-${n}`,
            study_unit_id: `unit-${n}`,
            generation_run_id: `study-run-${n}`,
            request_hash: hash(`exercise-${n}`),
            raw_result_digest: digest,
            presentation: {
              kind: "say_it_back",
              reference_text: line,
              capture: "microphone_audio",
            },
            private_grader: {
              kind: "source_token_phonetic_v2",
              reference_text: line,
              tokenizer_policy_revision: "script_aware_token_phonetic_v2",
            },
          });
        }
        const lyrics = extended.join("\n"),
          lyricsHash = hash(lyrics);
        await editFixture(
          f.admin,
          "UPDATE media_song_lyrics_revisions SET lyrics_text=$1,lyrics_sha256=$2 WHERE submission_id='study-submission' AND lyrics_revision=1",
          [lyrics, lyricsHash],
        );
        await editFixture(
          f.admin,
          "UPDATE study_language_profiles SET source_hash=$1,request_hash=$1 WHERE community_id='study-community' AND post_id='study-post' AND lyrics_revision=1 AND language_profile_revision=1",
          [lyricsHash],
        );
        const access = await seedGuest(f, 75),
          r = await reserve(f, access.access, "ten-card-plan", 40);
        const result = completed(await run(f.store.startSession(r.input)));
        expect(result.result.session.items).toHaveLength(10);
        expect(result.result.session.items.every((i) => i.exercise_type === "say_it_back")).toBe(
          true,
        );
        expect(result.result.session.lesson.presentation_cap).toBe(20);
        const stored = (
          await f.admin.query(
            "SELECT guest_spoken_call_plan AS plan FROM study_sessions_v2 WHERE session_id=$1",
            [r.originalSession],
          )
        ).rows[0].plan;
        expect(stored).toEqual({
          policy_revision: "study_spoken_rerecord_v1",
          graded_presentation_cap: 20,
          ungraded_rerecord_per_presentation: 1,
          maximum_paid_calls: 40,
        });
        await f.admin.query("SELECT require_guest_spoken_resource_plan_v1($1,$2,$3,true)", [
          access.ownerId,
          r.originalSession,
          r.reservationId,
        ]);
      }),
    30000,
  );
});
