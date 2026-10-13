// Genuine native closed original Account checkpoints. No fabricated producer,
// CP, finalizer row, query result or local reimplementation of the jobs cycle.
import { expect, test } from "bun:test";
import type { ControlledAccountSpokenProtocol } from "@pirate/application/controlled-account-spoken";
import { Effect, Schema } from "effect";
import { makeControlledAccountSpokenRecovery } from "../../../packages/platform-cf/src/controlled-account-spoken-recovery.ts";
import { makeControlledAccountStudyV2Store } from "../../../packages/platform-cf/src/controlled-account-study-store.ts";
import {
  dropCommitAcknowledgement,
  fixture,
  harness,
  pgUrl,
  q,
  rejected,
  run,
  stopBeforeFinalize,
  type Fixture,
} from "../../../packages/platform-cf/src/account-study-producer.pg-fixture.ts";
import { runStudySourceRecoveryCycle } from "./study-source-recovery-cycle.ts";

const pgTest = pgUrl === undefined ? test.skip : test;
const Original = Schema.Struct({
  command_ref: Schema.NonEmptyString,
  command_state: Schema.Literals(["reserved", "completed"]),
  io_state: Schema.Literal("closed"),
  storage_disposition: Schema.Literal("stored"),
  cleanup_required: Schema.Literal(false),
  provider_state: Schema.Literal("succeeded"),
  payload_sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  attempts: Schema.Int,
});
async function originalRows(f: Fixture) {
  const rows = (
    await f.admin.query(`SELECT c.command_ref,command.state AS command_state,
    u.io_state,u.storage_disposition,u.cleanup_required,p.state AS provider_state,cp.payload_sha256,
    (SELECT count(*)::integer FROM study_attempts_v2 a WHERE a.session_item_id=c.session_item_id) AS attempts
    FROM learner_audio_account_producer_captures c
    JOIN learner_audio_account_spoken_checkpoints cp USING(upload_attempt_id)
    JOIN learner_audio_upload_attempts u USING(upload_attempt_id)
    JOIN learner_audio_account_provider_calls p USING(upload_attempt_id)
    JOIN study_spoken_answer_commands command ON command.command_id=c.command_ref
    ORDER BY cp.persisted_at,c.upload_attempt_id`)
  ).rows;
  return Schema.decodeUnknownSync(Schema.Array(Original), { onExcessProperty: "error" })(rows);
}
async function moneyFingerprint(f: Fixture) {
  const snapshot: Record<string, unknown> = {};
  for (const table of [
    "activity_qualifications",
    "song_streak_days",
    "community_streak_days",
    "megapot_pool_shares",
    "megapot_ticket_inventory",
    "reward_ledger_credits",
  ])
    snapshot[table] = (
      await f.admin.query(`SELECT count(*)::integer AS n,
      encode(sha256(convert_to(COALESCE(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text,'UTF8')),'hex') AS hash
      FROM ${q(table)} t`)
    ).rows;
  return snapshot;
}

pgTest(
  "first real Account finalizer COMMIT acknowledgement loss stops later candidate and Guest/expiry in this tick",
  async () => {
    await fixture(async (f) => {
      const objects = new Map<string, Uint8Array>();
      let puts = 0;
      const normal = harness(f, {
        put: async (key, bytes) => {
          puts++;
          objects.set(key, new Uint8Array(bytes));
          return { size: bytes.byteLength };
        },
      });
      const finance = await moneyFingerprint(f);
      // Actual reservation/provider/grade/CP/claim/PUT/settlement completes. The
      // existing approved wrapper refuses BEFORE native finalization, keeping
      // real ready facts rather than inserting or editing any producer row.
      const firstInput = await normal.input(
        await normal.start("strict-cron-first"),
        "strict-cron-first-answer",
      );
      expect(
        await rejected(normal.submit(firstInput, stopBeforeFinalize(normal.protocol))),
      ).toMatchObject({ _tag: "StudyV2StoreFailed", reason: "unavailable" });
      await normal.drain();
      const secondInput = await normal.input(
        await normal.start("strict-cron-second"),
        "strict-cron-second-answer",
      );
      expect(
        await rejected(normal.submit(secondInput, stopBeforeFinalize(normal.protocol))),
      ).toMatchObject({ _tag: "StudyV2StoreFailed", reason: "unavailable" });
      await normal.drain();
      const before = await originalRows(f);
      expect(before).toHaveLength(2);
      const first = before[0],
        second = before[1];
      if (first === undefined || second === undefined)
        throw new Error("Two genuine original checkpoints required");
      expect(first.command_ref).not.toBe(second.command_ref);
      expect(before.map((row) => ({ state: row.command_state, attempts: row.attempts }))).toEqual([
        { state: "reserved", attempts: 0 },
        { state: "reserved", attempts: 0 },
      ]);
      // Observe the actual native scan order; do not guess candidate order from
      // IDs or monkey-patch its query results.
      const scan = (
        await f.admin.query(`SELECT value#>>'{success,commandId}' AS command_id
      FROM jsonb_array_elements(list_closed_account_spoken_checkpoints_private_v1(25)) WITH ORDINALITY AS rows(value,ordinal)
      ORDER BY ordinal`)
      ).rows;
      expect(scan).toEqual([{ command_id: first.command_ref }, { command_id: second.command_ref }]);
      expect(normal.calls()).toBe(2);
      expect(puts).toBe(2);
      expect(objects.size).toBe(2);
      const idsBefore = normal.ids();
      // Arm only on the actual final command-complete UPDATE, then drop only a
      // successfully completed backend COMMIT acknowledgement. The scan/read
      // transactions cannot consume this fault; no result or write is faked.
      const lost = dropCommitAcknowledgement("SET state='completed', result_snapshot=");
      const faultStore = makeControlledAccountStudyV2Store(
        f.runtime({ clientFactory: lost.clientFactory }),
      );
      const observed: string[] = [];
      const finalize: ControlledAccountSpokenProtocol["finalize"] = Effect.fn(
        "strictCronFixture.actualFinalizer",
      )(function* (
        capture: Parameters<ControlledAccountSpokenProtocol["finalize"]>[0],
        success: Parameters<ControlledAccountSpokenProtocol["finalize"]>[1],
        archive: Parameters<ControlledAccountSpokenProtocol["finalize"]>[2],
      ) {
        observed.push(success.commandId);
        return yield* faultStore.finalize(capture, success, archive);
      });
      const account = makeControlledAccountSpokenRecovery(f.runtime(), finalize);
      let guestStageCalls = 0,
        expiryStageCalls = 0;
      const result = await run(
        Effect.result(
          runStudySourceRecoveryCycle({
            account: account.recover(),
            guest: {
              // These are only downstream execution observers, never mocked DB
              // results or claimed successful Guest/release authority.
              closed: Effect.sync(() => {
                guestStageCalls++;
                return { examined: 0, completed: 0, pending: 0, skipped: 0 };
              }),
              releaseNext: () =>
                Effect.sync(() => {
                  expiryStageCalls++;
                  return { state: "idle" as const };
                }),
              maximumReleases: 1,
            },
          }),
        ),
      );
      expect(lost.observed()).toBe(true);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure).toMatchObject({
          _tag: "StudyV2StoreFailed",
          reason: "outcome-unknown",
        });
      expect(observed).toEqual([first.command_ref]);
      expect(guestStageCalls).toBe(0);
      expect(expiryStageCalls).toBe(0);
      const after = await originalRows(f);
      expect(after).toEqual([{ ...first, command_state: "completed", attempts: 1 }, second]);
      expect(normal.calls()).toBe(2);
      expect(puts).toBe(2);
      expect(normal.ids()).toBe(idsBefore);
      expect(objects.size).toBe(2);
      expect(await moneyFingerprint(f)).toEqual(finance);
      // A fresh later tick may observe the acknowledged-independent first receipt
      // and finalize ONLY the still-reserved second. Neither original is retried
      // inside the uncertain tick; no provider or R2 capability enters cron.
      const next = makeControlledAccountSpokenRecovery(f.runtime(), normal.store.finalize);
      expect(await run(next.recover())).toEqual({
        claimed: 1,
        recovered: 1,
        storageFailures: 0,
        fenced: 0,
      });
      expect(await originalRows(f)).toEqual([
        { ...first, command_state: "completed", attempts: 1 },
        { ...second, command_state: "completed", attempts: 1 },
      ]);
      expect(await run(next.recover())).toEqual({
        claimed: 0,
        recovered: 0,
        storageFailures: 0,
        fenced: 0,
      });
      expect(normal.calls()).toBe(2);
      expect(puts).toBe(2);
      expect(normal.ids()).toBe(idsBefore);
      expect(guestStageCalls).toBe(0);
      expect(expiryStageCalls).toBe(0);
      expect(await moneyFingerprint(f)).toEqual(finance);
      await normal.drain();
    });
  },
  90000,
);
