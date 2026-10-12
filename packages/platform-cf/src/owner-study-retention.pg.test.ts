// Actual preference-before-dispatch regression. Uses genuine maintained history
// and real restricted reserve; admin seeds an explicit PREEXISTING preference
// fact, not a replacement retention authority function or serving privilege.
import { expect, test } from "bun:test";
import { mutationFixture } from "./owner-study-mutations.pg-fixture.ts";
import {
  completed,
  hash,
  pgUrl,
  reserve,
  run,
  seedGuest,
} from "./owner-study-starter.pg-fixture.ts";
const pgTest = pgUrl ? test : test.skip;
pgTest(
  "ephemeral source preference binds a fresh captured recording to24h and an original-key observation cannot rewrite it",
  async () => {
    await mutationFixture(async (f) => {
      const proof = await seedGuest(f, 731),
        rsv = await reserve(f, proof.access, "ephemeral-start", 24);
      const started = completed(await run(f.store.startSession(rsv.input)));
      const current = started.result.session.lesson.current;
      if (current === null) throw new Error("Actual starter current item required");
      // Populate the actual preference + its retained exact-source completed
      // operation, with native FK/state guards enabled. No actor/test selector.
      await f.admin.query(
        `INSERT INTO guest_participation_operations(operation_id,source_owner_id,operation_kind,
      resource_scope,idempotency_key,request_hash,state,result_snapshot,created_at,resolved_at)
      VALUES('fixture-retention-ephemeral',$1,'learning_retention',jsonb_build_array('guest_learning_retention_v1',$1::text)::text,
        'fixture-retention-ephemeral',$2,'completed','{"object":"guest_learning_retention_v1","mode":"ephemeral"}',clock_timestamp(),clock_timestamp())`,
        [proof.ownerId, hash("fixture-preexisting-ephemeral-preference")],
      );
      await f.admin.query(
        "INSERT INTO guest_learning_preferences(owner_id,mode,changed_at,operation_id) VALUES($1,'ephemeral',clock_timestamp(),'fixture-retention-ephemeral')",
        [proof.ownerId],
      );
      const audio = new Uint8Array([7, 3, 1]),
        requestHash = hash("ephemeral-fresh-answer");
      const input = {
        access: proof.access,
        source: started.result.source,
        operation: {
          sourceOwnerId: proof.ownerId,
          kind: "study_answer" as const,
          idempotencyKey: "ephemeral-answer",
          requestHash,
        },
        sessionId: started.result.session.session_id,
        sessionItemId: current.session_item_id,
        attemptNumber: 1,
        audioByteSize: audio.byteLength,
        audioContentType: "audio/webm",
        audioDigest: hash(audio),
        audioDurationMs: 1000,
        commandId: "ephemeral-command",
        attemptId: "ephemeral-attempt",
        artifactId: "ephemeral-artifact",
        idempotencyKey: "ephemeral-answer",
        requestHash,
        leaseToken: "private-ephemeral-dispatch-token",
        providerRetention: "stored" as const,
        resourceReservationId: rsv.reservationId,
        deletionFenceRevision: 0,
      };
      const reserved = await run(f.mutationStore.reserveSpokenAnswer(input));
      expect(reserved.state).toBe("reserved");
      const facts = await f.admin.query(`SELECT a.platform_retention,a.provider_retention,
      a.expires_at=c.reserved_at+interval '24 hours' AS exactly24h,
      a.expires_at<=c.reserved_at+interval '24 hours' AS no_later_than24h,
      a.expires_at>c.reserved_at AS positive_lifetime,a.account_id,c.account_id AS command_account,
      cap.source_owner_id,cap.provider_retention AS captured_provider_retention
      FROM learner_audio_artifacts a JOIN study_spoken_answer_commands c ON c.learner_audio_artifact_id=a.learner_audio_artifact_id
      JOIN guest_study_spoken_captures cap ON cap.command_id=c.command_id AND cap.original_lease_token=c.lease_token
      WHERE c.command_id='ephemeral-command'`);
      expect(facts.rows).toEqual([
        {
          platform_retention: "ephemeral",
          provider_retention: "stored",
          exactly24h: true,
          no_later_than24h: true,
          positive_lifetime: true,
          account_id: null,
          command_account: null,
          source_owner_id: proof.ownerId,
          captured_provider_retention: "stored",
        },
      ]);
      const retained = await f.admin.query(
        "SELECT to_jsonb(a) AS artifact FROM learner_audio_artifacts a WHERE learner_audio_artifact_id='ephemeral-artifact'",
      );
      const capture = await f.admin.query(
        "SELECT to_jsonb(c) AS capture FROM guest_study_spoken_captures c WHERE command_id='ephemeral-command'",
      );
      await f.admin.query(
        "UPDATE guest_learning_preferences SET mode='private_learning',changed_at=clock_timestamp() WHERE owner_id=$1",
        [proof.ownerId],
      );
      expect(
        (
          await run(
            f.mutationStore.reserveSpokenAnswer({
              ...input,
              artifactId: "unused-new-artifact",
              commandId: "unused-new-command",
              attemptId: "unused-new-attempt",
            }),
          )
        ).state,
      ).toBe("pending_confirmation");
      expect(
        (
          await f.admin.query(
            "SELECT to_jsonb(a) AS artifact FROM learner_audio_artifacts a WHERE learner_audio_artifact_id='ephemeral-artifact'",
          )
        ).rows,
      ).toEqual(retained.rows);
      expect(
        (
          await f.admin.query(
            "SELECT to_jsonb(c) AS capture FROM guest_study_spoken_captures c WHERE command_id='ephemeral-command'",
          )
        ).rows,
      ).toEqual(capture.rows);
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::int AS n FROM guest_resource_provider_calls WHERE source_owner_id=$1",
            [proof.ownerId],
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
    });
  },
  30000,
);
