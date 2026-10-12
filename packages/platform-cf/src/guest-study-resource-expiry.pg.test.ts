// Authored/unexecuted native proposal. Genuine maintained0001..0256 fixture,
// actual257/258+root-chosen expiry migration via maintained runner, no outside SQL.
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { Schema } from "effect";
import { runPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import { makeControlPlaneGuestStudyResourceExpiry } from "./guest-study-resource-expiry.ts";
import {
  archiveFixture,
  type ArchiveFixture as CheckpointFixture,
} from "./owner-spoken-archive.pg-fixture.ts";
import { dispatch } from "./owner-spoken-checkpoint-test-session.ts";
import { makeOwnerSpokenFencedArchiveStage } from "./owner-spoken-fenced-archive.ts";
import {
  completed,
  editFixture,
  financialFingerprint,
  hash,
  pgUrl,
  policy,
  q,
  reserve,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import type { PostgresMigration } from "./postgres-migrations.ts";

const pgTest = pgUrl ? test : test.skip;
const signature = "release_next_guest_study_resource_remainder_v1()";
async function expiryFixture(use: (f: CheckpointFixture) => Promise<void>) {
  const raw = process.env.GUEST_STUDY_RESOURCE_EXPIRY_NATIVE_INPUTS_JSON;
  if (!raw) throw new Error("Root exact actual expiry source/version inventory required");
  const inputs = Schema.decodeUnknownSync(
    Schema.Struct({
      expiryMigration: Schema.String.check(Schema.isPattern(/^\d{4}_.+\.sql$/u)),
      hashes: Schema.Record(
        Schema.String,
        Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
      ),
    }),
    { onExcessProperty: "error" },
  )(JSON.parse(raw));
  const last = Number(inputs.expiryMigration.slice(0, 4));
  if (last <= 258)
    throw new Error("Root must assign an actual successor; proposal reserves no ordinal");
  const directory = new URL("../../../db/postgres/migrations/", import.meta.url);
  const manifest = Schema.decodeUnknownSync(
    Schema.Struct({
      algorithm: Schema.Literal("sha256"),
      migrations: Schema.Record(
        Schema.String,
        Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
      ),
    }),
    { onExcessProperty: "error" },
  )(JSON.parse(await readFile(new URL("checksums.json", directory), "utf8")));
  const names = (await readdir(directory))
    .filter((n) => /^\d{4}_.+\.sql$/u.test(n) && Number(n.slice(0, 4)) <= last)
    .sort();
  expect(names.map((n) => Number(n.slice(0, 4)))).toEqual(
    Array.from({ length: last }, (_, i) => i + 1),
  );
  expect(names.at(-1)).toBe(inputs.expiryMigration);
  const all: PostgresMigration[] = [];
  for (const version of names) {
    const sql = await readFile(new URL(version, directory), "utf8"),
      checksum = hash(sql),
      number = Number(version.slice(0, 4));
    if (number <= 247) {
      if (manifest.migrations[version] === undefined)
        throw new Error("Immutable historical hash missing");
      expect(checksum).toBe(manifest.migrations[version]);
    }
    if (number >= 254) {
      if (inputs.hashes[version] === undefined)
        throw new Error("Actual private native input hash missing");
      expect(checksum).toBe(inputs.hashes[version]);
    }
    all.push({ version, sql, checksum });
  }
  await archiveFixture(async (f) => {
    if (!pgUrl) throw new Error("Owned native PG URL missing");
    const scoped = new URL(pgUrl);
    scoped.searchParams.set("options", `-c search_path=${f.schema}`);
    await runPostgresMigrations({
      connectionString: scoped.toString(),
      migrations: all,
      expectedLedger: all.slice(0, 257),
    });
    // Actual install BEFORE this fixture grants the new controlled leaf.
    expect(
      (
        await f.admin.query(
          `SELECT p.prosecdef AS sd,p.proowner=c.relowner AS owned,
    p.pronamespace=c.relnamespace AS namespace,
    p.proconfig @> ARRAY[format('search_path=pg_catalog, %I, pg_temp',n.nspname)] AS pinned,
    EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS exposed
    FROM pg_proc p CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE p.oid=$1::regprocedure AND c.oid='participation_owners'::regclass`,
          [signature],
        )
      ).rows,
    ).toEqual([{ sd: true, owned: true, namespace: true, pinned: true, exposed: false }]);
    await expect(
      f.guest.query("SELECT release_next_guest_study_resource_remainder_v1()"),
    ).rejects.toMatchObject({ code: "42501" });
    await f.admin.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${q(f.role)}`);
    await use(f);
  });
}
const store = (f: CheckpointFixture) =>
  makeControlPlaneGuestStudyResourceExpiry(makeDirectPostgresControlPlaneLayer(f.guestUrl));
async function expireCapturedFixture(f: CheckpointFixture, sessionId: string) {
  // Disposable historical-time seed ONLY. No product clock mutation is granted.
  // Keep actual immutable session/reservation clock correlation and24h span;
  // leave active lesson/capture/command/original lease/provider-call facts intact.
  await editFixture(
    f.admin,
    "UPDATE guest_resource_session_reservations SET created_at=created_at-INTERVAL '25 hours',reservation_expires_at=reservation_expires_at-INTERVAL '25 hours' WHERE session_id=$1",
    [sessionId],
  );
  await editFixture(
    f.admin,
    "UPDATE study_sessions_v2 SET created_at=created_at-INTERVAL '25 hours',expires_at=expires_at-INTERVAL '25 hours' WHERE session_id=$1",
    [sessionId],
  );
}
async function tryReserve(f: CheckpointFixture, owner: string, key: string) {
  return (
    await f.admin.query(
      "SELECT reserve_guest_resource_session_v1($1,$2::jsonb,$3,24,'24000',$4,$5::jsonb) AS reply",
      [
        owner,
        JSON.stringify({
          sourceOwnerId: owner,
          kind: "study_start",
          idempotencyKey: key,
          requestHash: hash(key),
        }),
        `expiry-${key}`,
        `expiry-edge-${owner}`,
        JSON.stringify(policy),
      ],
    )
  ).rows[0].reply;
}
pgTest(
  "two actual abandoned captured sessions release unspent holds and restore original owner admission capacity",
  () =>
    expiryFixture(async (f) => {
      const guest = await seedGuest(f, 91),
        a = await reserve(f, guest.access, "abandoned-a", 24),
        b = await reserve(f, guest.access, "abandoned-b", 24);
      completed(await run(f.store.startSession(a.input)));
      completed(await run(f.store.startSession(b.input)));
      expect((await tryReserve(f, guest.ownerId, "blocked-before-expiry")).result.state).toBe(
        "rate_limited",
      );
      await expireCapturedFixture(f, a.originalSession);
      await expireCapturedFixture(f, b.originalSession);
      const original = (
          await f.admin.query(
            "SELECT session_id,created_at,expires_at,guest_start_operation_id,guest_spoken_call_plan,status FROM study_sessions_v2 WHERE participation_owner_id=$1 ORDER BY session_id",
            [guest.ownerId],
          )
        ).rows,
        finance = await financialFingerprint(f);
      const expiry = store(f);
      expect((await run(expiry.releaseNext())).state).toBe("released");
      expect((await run(expiry.releaseNext())).state).toBe("released");
      expect(await run(expiry.releaseNext())).toEqual({ state: "idle" });
      expect((await tryReserve(f, guest.ownerId, "new-capacity")).result.state).toBe("reserved");
      expect(
        (
          await f.admin.query(
            "SELECT session_id,created_at,expires_at,guest_start_operation_id,guest_spoken_call_plan,status FROM study_sessions_v2 WHERE participation_owner_id=$1 ORDER BY session_id",
            [guest.ownerId],
          )
        ).rows,
      ).toEqual(original);
      expect(await financialFingerprint(f)).toEqual(finance);
    }),
  30000,
);
pgTest(
  "expired remainder release keeps reserved/unknown calls held at all ages and accepts the same late checkpoint",
  () =>
    expiryFixture(async (f) => {
      const d = await dispatch(f, 92);
      await expireCapturedFixture(f, d.input.sessionId);
      await f.admin.query(
        "SELECT complete_guest_provider_call_v1($1,$2::jsonb,$3,$4,'unknown',NULL,NULL)",
        [
          d.guest.ownerId,
          JSON.stringify(d.input.operation),
          d.initial.reservationId,
          (
            await f.admin.query(
              "SELECT provider_call_id FROM guest_study_spoken_captures WHERE command_id=$1",
              [d.input.commandId],
            )
          ).rows[0].provider_call_id,
        ],
      );
      const captures = (
        await f.admin.query(
          "SELECT to_jsonb(c) AS capture FROM guest_study_spoken_captures c WHERE command_id=$1",
          [d.input.commandId],
        )
      ).rows;
      expect(await run(store(f).releaseNext())).toEqual({
        state: "released",
        terminalState: "expired",
      });
      expect(
        (
          await f.admin.query(
            "SELECT owner_active::int AS active,owner_calls::text AS calls,owner_cost::text AS cost FROM guest_resource_usage_v1(ARRAY[$1]::text[],clock_timestamp()+INTERVAL '25 hours')",
            [d.guest.ownerId],
          )
        ).rows,
      ).toEqual([{ active: 0, calls: "1", cost: "1000" }]);
      expect(
        (
          await f.admin.query(
            "SELECT disposition FROM guest_resource_provider_calls WHERE source_owner_id=$1",
            [d.guest.ownerId],
          )
        ).rows,
      ).toEqual([{ disposition: "unknown" }]);
      const accepted = await run(d.checkpoint.persistBeforeArchive(d.success));
      expect(accepted.state).toBe("completed");
      expect(await run(d.checkpoint.persistBeforeArchive(d.success))).toEqual(accepted);
      expect(
        (
          await f.admin.query(
            "SELECT to_jsonb(c) AS capture FROM guest_study_spoken_captures c WHERE command_id=$1",
            [d.input.commandId],
          )
        ).rows,
      ).toEqual(captures);
      expect(
        (
          await f.admin.query(
            "SELECT state,remaining_units FROM guest_resource_session_reservations WHERE reservation_id=$1",
            [d.initial.reservationId],
          )
        ).rows,
      ).toEqual([{ state: "expired", remaining_units: 0 }]);
      const cp = accepted.state === "completed" ? accepted.result.checkpointId : null;
      if (cp === null) throw new Error("Original accepted checkpoint required");
      const background: Promise<unknown>[] = [];
      let puts = 0;
      const archive = makeOwnerSpokenFencedArchiveStage(
        makeDirectPostgresControlPlaneLayer(f.guestUrl),
        {
          put: async () => {
            puts++;
            throw new Error("Not-stored provider policy must not PUT");
          },
        },
        (task) => background.push(task),
      );
      const disposition = await run(
        archive.store({
          source: d.success.source,
          operation: d.success.operation,
          artifactId: d.success.result.artifactId,
          resourceReservationId: d.success.resourceReservationId,
          deletionFenceRevision: d.success.deletionFenceRevision,
          audio: d.audio,
          contentType: d.success.result.audioContentType,
          contentDigest: d.success.result.audioDigest,
        }),
      );
      const ack = await run(
        d.owner.persistSuccessfulSpokenResult({
          access: d.guest.access,
          checkpoint: { ...d.success, result: { ...d.success.result, archive: disposition } },
        }),
      );
      expect(ack.state).toBe("completed");
      const answer = await run(
        d.owner.completeSpokenAnswer({
          access: d.guest.access,
          checkpointId: cp,
          source: d.success.source,
          operation: d.success.operation,
        }),
      );
      if (answer.state !== "completed")
        throw new Error("Original late accepted continuation required");
      expect(answer.result.answer.outcome).toBe("correct");
      expect(answer.result.participation).toEqual({ state: "practice_only" });
      expect(
        await run(
          d.owner.completeSpokenAnswer({
            access: d.guest.access,
            checkpointId: cp,
            source: d.success.source,
            operation: d.success.operation,
          }),
        ),
      ).toEqual(answer);
      await Promise.all(background);
      expect(puts).toBe(0);
      expect(d.providerInvocations()).toBe(1);
    }),
  30000,
);
pgTest(
  "actual uncaptured expiry absence stays held; no native abort producer or absence inference is invented",
  () =>
    expiryFixture(async (f) => {
      const guest = await seedGuest(f, 93),
        r = await reserve(f, guest.access, "uncaptured-positive-abort", 24);
      await editFixture(
        f.admin,
        "UPDATE guest_resource_session_reservations SET created_at=created_at-INTERVAL '25 hours',reservation_expires_at=reservation_expires_at-INTERVAL '25 hours' WHERE reservation_id=$1",
        [r.reservationId],
      );
      const expiry = store(f);
      expect(await run(expiry.releaseNext())).toEqual({ state: "idle" });
      expect(
        (
          await f.admin.query(
            "SELECT state,remaining_units FROM guest_resource_session_reservations WHERE reservation_id=$1",
            [r.reservationId],
          )
        ).rows,
      ).toEqual([{ state: "active", remaining_units: 24 }]);
      // Current runtime has no native producer that proves this standalone plan
      // aborted. The SQL positive-witness branch is structurally guarded, but this
      // case claims ONLY actual absence remains held; it creates no synthetic abort.
      expect(await run(expiry.releaseNext())).toEqual({ state: "idle" });
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::int AS n FROM guest_participation_operations WHERE source_owner_id=$1 AND operation_kind='study_start'",
            [guest.ownerId],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    }),
  30000,
);
