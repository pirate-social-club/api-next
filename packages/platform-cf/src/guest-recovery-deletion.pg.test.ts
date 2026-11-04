import { expect, test } from "bun:test";
import { Effect } from "effect";
import { recoveryDeletionFixture as fixture } from "./guest-recovery-deletion.pg-fixture.ts";
import { dispatch } from "./owner-spoken-checkpoint-test-session.ts";
import { makeOwnerSpokenFencedArchiveStage } from "./owner-spoken-fenced-archive.ts";
import {
  editFixture,
  financialFingerprint,
  hash,
  origin,
  pgUrl,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const pgTest = pgUrl ? test : test.skip;
// Recovery has four fields; a learning lease is not recovery authority.
const recoveryAccess = (access: Awaited<ReturnType<typeof seedGuest>>["access"]) => ({
  kind: "guest" as const,
  ownerId: access.ownerId,
  credentialId: access.credentialId,
  origin: access.origin,
});
const operation = (ownerId: string, key: string) => ({
  sourceOwnerId: ownerId,
  kind: "learner_audio_deletion" as const,
  idempotencyKey: key,
  requestHash: hash(key),
});
const completed = <A>(
  value:
    | { state: "completed"; result: A }
    | { state: "known_aborted" }
    | { state: "pending_confirmation" },
) => {
  if (value.state !== "completed") throw new Error("Acknowledged original result required");
  return value.result;
};

pgTest(
  "actual recovery proof permits retention and deletion after explicit fixture lease ageing; revoked and foreign proof refuse",
  () =>
    fixture(async (f) => {
      const g = await seedGuest(f, 801),
        finance = await financialFingerprint(f);
      // Only a disposable clock fixture: identity/digest/state are unchanged. This
      // models elapsed learning time; it does not credit one hour of wall-clock wait.
      await editFixture(
        f.admin,
        "UPDATE guest_credentials SET session_until=clock_timestamp()-INTERVAL '1 second' WHERE credential_id=$1",
        [g.credentialId],
      );
      const modeOp = {
        ...operation(g.ownerId, "aged-retention"),
        kind: "learning_retention" as const,
      };
      const retained = await run(
        f.retention.set({ access: recoveryAccess(g.access), operation: modeOp, mode: "ephemeral" }),
      );
      expect(completed(retained).mode).toBe("ephemeral");
      expect(
        await run(
          f.retention.set({
            access: recoveryAccess(g.access),
            operation: modeOp,
            mode: "ephemeral",
          }),
        ),
      ).toEqual(retained);
      const input = {
        access: recoveryAccess(g.access),
        operation: operation(g.ownerId, "aged-delete"),
        maximumArtifacts: 1000,
      };
      const batch = completed(await run(f.deletion.prepareBatch(input)));
      expect(batch.artifacts).toHaveLength(0);
      expect(batch.sourceOwnerIds).toEqual([g.ownerId]);
      const foreign = await seedGuest(f, 802);
      for (const access of [
        { ...recoveryAccess(g.access), origin: "https://foreign.example" },
        { ...recoveryAccess(g.access), credentialId: foreign.credentialId },
      ])
        expect((await run(Effect.result(f.deletion.prepareBatch({ ...input, access }))))._tag).toBe(
          "Failure",
        );
      const successor = "R".repeat(21) + "A";
      await f.admin.query("SELECT issue_guest_rotation_v1($1,$2::text[],$3,$4,$5,$6,$7,$8,$9)", [
        origin,
        [g.credentialId],
        g.credentialId,
        g.ownerId,
        "recovery-native-rotation",
        hash("recovery-native-rotation"),
        "recovery-native-rotation-op",
        successor,
        hash("synthetic-successor-secret"),
      ]);
      await f.admin.query("SELECT acknowledge_guest_rotation_v1($1,$2::text[],$3,$4,$5)", [
        origin,
        [successor],
        g.credentialId,
        successor,
        g.ownerId,
      ]);
      expect(
        (
          await run(
            Effect.result(
              f.retention.set({
                access: recoveryAccess(g.access),
                operation: {
                  ...modeOp,
                  idempotencyKey: "revoked-mode",
                  requestHash: hash("revoked-mode"),
                },
                mode: "private_learning",
              }),
            ),
          )
        )._tag,
      ).toBe("Failure");
      // Accepted original callback has no renewed proof requirement.
      const done = completed(
        await run(
          f.deletion.confirmBatch({
            batch,
            storageDisposition: "absent",
            deletedAt: new Date().toISOString(),
          }),
        ),
      );
      expect(done.state).toBe("completed");
      expect(await financialFingerprint(f)).toEqual(finance);
    }),
  30000,
);

pgTest(
  "actual original deletion retains successful checkpoint, rejects key changes and new fences, and reconciles unknown exact batch",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 803),
        finance = await financialFingerprint(f);
      const cp = await run(d.checkpoint.persistBeforeArchive(d.success));
      expect(cp.state).toBe("completed");
      const tasks: Promise<unknown>[] = [];
      const archive = makeOwnerSpokenFencedArchiveStage(
        makeDirectPostgresControlPlaneLayer(f.guestUrl),
        { put: async () => ({ size: d.audio.length }) },
        (task) => tasks.push(task),
      );
      const stored = await run(
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
      expect(stored.state).toBe("stored");
      await Promise.all(tasks);
      const input = {
        access: recoveryAccess(d.guest.access),
        operation: operation(d.guest.ownerId, "real-audio-delete"),
        maximumArtifacts: 1000,
      };
      const prepared = await run(f.deletion.prepareBatch(input)),
        batch = completed(prepared);
      expect(batch.artifacts).toHaveLength(1);
      expect(await run(f.deletion.prepareBatch(input))).toEqual(prepared);
      for (const op of [
        { ...input.operation, requestHash: hash("changed") },
        operation(d.guest.ownerId, "another-fence"),
      ])
        expect(
          (await run(Effect.result(f.deletion.prepareBatch({ ...input, operation: op }))))._tag,
        ).toBe("Failure");
      const unknown = completed(
        await run(f.deletion.failBatch({ batch, storageDisposition: "unknown" })),
      );
      expect(unknown.state).toBe("pending");
      expect(
        await run(
          f.deletion.findOperation({
            access: recoveryAccess(d.guest.access),
            sourceOwnerId: d.guest.ownerId,
            idempotencyKey: input.operation.idempotencyKey,
          }),
        ),
      ).toEqual(unknown);
      const done = completed(
        await run(
          f.deletion.confirmBatch({
            batch,
            storageDisposition: "deleted",
            deletedAt: new Date().toISOString(),
          }),
        ),
      );
      expect(done.state).toBe("completed");
      const original = await run(
        d.checkpoint.findBeforeArchive({
          source: d.success.source,
          operation: d.success.operation,
          commandId: d.success.commandId,
          originalLeaseToken: d.success.result.leaseToken,
        }),
      );
      expect(original?.success).toEqual(d.success);
      expect(
        (
          await f.admin.query(
            "SELECT charged_cost_micros::text AS charged FROM guest_study_spoken_checkpoints",
          )
        ).rows,
      ).toEqual([{ charged: "1000" }]);
      expect(await financialFingerprint(f)).toEqual(finance);
    }),
  30000,
);

pgTest(
  "actual retention preference affects future capture and cannot rewrite original private audio",
  () =>
    fixture(async (f) => {
      const d = await dispatch(f, 804);
      const before = (
        await f.admin.query(
          "SELECT platform_retention,expires_at FROM learner_audio_artifacts WHERE learner_audio_artifact_id=$1",
          [d.success.result.artifactId],
        )
      ).rows;
      expect(before[0]?.platform_retention).toBe("private_learning");
      const op = {
        ...operation(d.guest.ownerId, "future-only-retention"),
        kind: "learning_retention" as const,
      };
      await run(
        f.retention.set({
          access: recoveryAccess(d.guest.access),
          operation: op,
          mode: "ephemeral",
        }),
      );
      expect(
        (
          await f.admin.query(
            "SELECT platform_retention,expires_at FROM learner_audio_artifacts WHERE learner_audio_artifact_id=$1",
            [d.success.result.artifactId],
          )
        ).rows,
      ).toEqual(before);
      const second = await dispatch(f, 805, d.guest);
      // Only a NEW capture reads the changed preference; old private audio stays unchanged.
      expect(
        (
          await f.admin.query(
            "SELECT platform_retention FROM learner_audio_artifacts WHERE learner_audio_artifact_id=$1",
            [second.success.result.artifactId],
          )
        ).rows,
      ).toEqual([{ platform_retention: "ephemeral" }]);
      expect(
        (
          await f.admin.query("SELECT mode FROM guest_learning_preferences WHERE owner_id=$1", [
            d.guest.ownerId,
          ])
        ).rows,
      ).toEqual([{ mode: "ephemeral" }]);
    }),
  30000,
);

pgTest(
  "actual runtime cannot invoke recovery internal helpers or raw deletion primitives",
  () =>
    fixture(async (f) => {
      for (const signature of [
        "require_guest_audio_recovery_access_private_v1(jsonb,text)",
        "read_guest_owner_audio_delete_batch_private_v1(text)",
        "prepare_learner_audio_delete_private_v1(text,text,text,text,text[],text,integer,text)",
      ])
        expect(
          (
            await f.guest.query(
              "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
              [signature],
            )
          ).rows,
        ).toEqual([{ allowed: false }]);
      expect(origin.startsWith("https://")).toBe(true);
    }),
  30000,
);
