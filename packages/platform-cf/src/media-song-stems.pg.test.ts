import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { insertActiveCommunityMembershipFixture } from "./community-follow.pg-fixture";
import { makeControlPlaneMediaSubmissionRepository } from "./media-submission-repository";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture";
import { makeDirectPostgresControlPlaneLayer } from "./postgres";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
const suite = connectionString === undefined ? describe.skip : describe;

const actor = "stem_pg_actor",
  community = "stem_pg_community",
  submission = "stem_pg_submission",
  operation = "stem_pg_operation";
const sha256 = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");
const responseBytes = new TextEncoder().encode('{"status":"accepted"}');
const responseSha256 = sha256(responseBytes);
const requestHash = "a".repeat(64);
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const scoped = (raw: string, schema: string): string =>
  `${raw}${raw.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-c search_path=${schema}`)}`;

async function withSeededSchema(
  use: (admin: Client, connection: string, personaId: string) => Promise<void>,
): Promise<void> {
  if (connectionString === undefined) throw new Error("Postgres test configuration is unavailable");
  const schema = `api_next_song_stems_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  try {
    const connection = scoped(connectionString, schema);
    await applyPostgresTestBaselineConnection({ connectionString: connection });
    await admin.query("INSERT INTO users (user_id) VALUES ($1)", [actor]);
    await activatePendingPersonaFixtures(admin);
    await admin.query(
      "INSERT INTO communities (community_id,display_name,status,created_by_user_id,created_at,updated_at) VALUES ($1,'Stem fixture','active',$2,now(),now())",
      [community, actor],
    );
    await insertActiveCommunityMembershipFixture(admin, {
      communityId: community,
      membershipId: "stem_pg_membership",
      userId: actor,
    });
    const persona = await admin.query<{ persona_id: string }>(
      "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
      [actor],
    );
    const personaId = persona.rows[0]?.persona_id;
    if (personaId === undefined) throw new Error("missing stem test persona");
    await admin.query(
      "INSERT INTO persona_community_bindings (persona_id, account_id, community_id, binding_source) VALUES ($1,$2,$3,'first_membership')",
      [personaId, actor, community],
    );
    await use(admin, connection, personaId);
  } finally {
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

const run = <A>(
  connection: string,
  program: (
    store: ReturnType<typeof makeControlPlaneMediaSubmissionRepository>,
  ) => Effect.Effect<A, unknown, ControlPlaneDb>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      program(makeControlPlaneMediaSubmissionRepository()).pipe(
        Effect.provide(makeDirectPostgresControlPlaneLayer(connection)),
      ),
    ),
  );

const reserve = (
  connection: string,
  personaId: string,
  reservationId: string,
  slot: "primary_audio" | "instrumental_audio" | "vocal_audio",
) =>
  run(connection, (store) =>
    store.reserve({
      communityId: community,
      actorUserId: actor,
      personaId,
      idempotencyKey: `reserve-${reservationId}`,
      requestHash,
      expectedContentType: "audio/mpeg",
      expectedSizeBytes: 16,
      uploadUrl: "https://upload.test/media",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      responseBytes,
      responseSha256,
      reservationId,
      slot,
    }),
  );

const createSong = (connection: string, personaId: string, reservationId: string) =>
  run(connection, (store) =>
    store.createSubmission({
      communityId: community,
      actorUserId: actor,
      personaId,
      idempotencyKey: `create-${reservationId}`,
      requestHash,
      title: "Stem fixture song",
      songType: "original",
      reservationId,
      submissionId: submission,
      operationId: operation,
      responseBytes,
      responseSha256,
    }),
  );

const creationRevision = async (connection: string): Promise<number> => {
  const client = new Client({ connectionString: connection });
  await client.connect();
  try {
    const result = await client.query<{ creation_revision: string }>(
      "SELECT creation_revision FROM media_post_submissions WHERE submission_id=$1",
      [submission],
    );
    return Number(result.rows[0]?.creation_revision);
  } finally {
    await client.end();
  }
};

const attach = async (
  connection: string,
  personaId: string,
  input: { slot: "instrumental_audio" | "vocal_audio"; reservationId: string; key: string },
) => {
  const expectedCreationRevision = await creationRevision(connection);
  return run(connection, (store) =>
    store.attachStem({
      communityId: community,
      submissionId: submission,
      actorUserId: actor,
      personaId,
      endpointTemplate: "/media-post-submissions/:submissionId/stems",
      idempotencyKey: input.key,
      requestHash,
      responseBytes,
      responseSha256,
      expectedCreationRevision,
      slot: input.slot,
      reservationId: input.reservationId,
      stemOperationId: `${operation}-stem-${input.slot}`,
      immutableObject: {
        immutableRef: `media://immutable/${operation}-stem-${input.slot}/audio/1`,
        destinationRef: `r2://immutable/${operation}-stem-${input.slot}/audio/1/${input.key}`,
        etag: "stem-etag",
        objectVersion: "stem-version",
        sizeBytes: 16,
        contentType: "audio/mpeg",
        canonicalSha256: "c".repeat(64),
      },
    }),
  );
};

suite("song stems persistence", () => {
  test("seals instrumental and vocals beside the primary audio and replays exactly", async () => {
    await withSeededSchema(async (admin, connection, personaId) => {
      await reserve(connection, personaId, "stem_primary", "primary_audio");
      expect(await createSong(connection, personaId, "stem_primary")).toMatchObject({
        kind: "created",
      });

      for (const slot of ["instrumental_audio", "vocal_audio"] as const) {
        await reserve(connection, personaId, `stem_${slot}`, slot);
        expect(
          await attach(connection, personaId, {
            slot,
            reservationId: `stem_${slot}`,
            key: `attach-${slot}`,
          }),
        ).toMatchObject({ kind: "committed", submissionId: submission });
      }
      expect(
        await run(connection, (store) =>
          store.getStemsForAuthor({
            communityId: community,
            submissionId: submission,
            actorUserId: actor,
            personaId,
          }),
        ),
      ).toEqual({
        instrumental_audio: { sizeBytes: 16, contentType: "audio/mpeg" },
        vocal_audio: { sizeBytes: 16, contentType: "audio/mpeg" },
      });
      // The same request replays; the submission's own audio is untouched.
      expect(
        await attach(connection, personaId, {
          slot: "vocal_audio",
          reservationId: "stem_vocal_audio",
          key: "attach-vocal_audio",
        }),
      ).toMatchObject({ kind: "replay" });
      const primary = await admin.query<{ audio_revision: string; audio_reservation_id: string }>(
        "SELECT audio_revision,audio_reservation_id FROM media_post_submissions WHERE submission_id=$1",
        [submission],
      );
      expect(primary.rows[0]).toMatchObject({
        audio_revision: "0",
        audio_reservation_id: "stem_primary",
      });
      const reservations = await admin.query<{
        reservation_id: string;
        state: string;
        operation_id: string;
      }>(
        "SELECT reservation_id,state,operation_id FROM media_upload_reservations ORDER BY reservation_id",
      );
      expect(reservations.rows).toEqual([
        {
          reservation_id: "stem_instrumental_audio",
          state: "sealed",
          operation_id: `${operation}-stem-instrumental_audio`,
        },
        { reservation_id: "stem_primary", state: "claimed", operation_id: operation },
        {
          reservation_id: "stem_vocal_audio",
          state: "sealed",
          operation_id: `${operation}-stem-vocal_audio`,
        },
      ]);
    });
  });

  test("refuses a second stem for a slot, a wrong-slot reservation and a stem as the master", async () => {
    await withSeededSchema(async (admin, connection, personaId) => {
      await reserve(connection, personaId, "stem_as_master", "instrumental_audio");
      await expect(createSong(connection, personaId, "stem_as_master")).rejects.toBeDefined();
      await reserve(connection, personaId, "stem_primary", "primary_audio");
      await createSong(connection, personaId, "stem_primary");
      await expect(
        attach(connection, personaId, {
          slot: "vocal_audio",
          reservationId: "stem_as_master",
          key: "wrong-slot",
        }),
      ).rejects.toBeDefined();
      await reserve(connection, personaId, "vocals_one", "vocal_audio");
      await attach(connection, personaId, {
        slot: "vocal_audio",
        reservationId: "vocals_one",
        key: "vocals-one",
      });
      await reserve(connection, personaId, "vocals_two", "vocal_audio");
      await expect(
        attach(connection, personaId, {
          slot: "vocal_audio",
          reservationId: "vocals_two",
          key: "vocals-two",
        }),
      ).rejects.toBeDefined();
      const stems = await admin.query("SELECT slot FROM media_song_stems");
      expect(stems.rows).toEqual([{ slot: "vocal_audio" }]);
    });
  });

  test("guards stem facts, slots and history in SQL", async () => {
    await withSeededSchema(async (admin, connection, personaId) => {
      await reserve(connection, personaId, "stem_primary", "primary_audio");
      await createSong(connection, personaId, "stem_primary");
      await reserve(connection, personaId, "vocals", "vocal_audio");
      await attach(connection, personaId, {
        slot: "vocal_audio",
        reservationId: "vocals",
        key: "vocals",
      });
      await expect(
        admin.query(
          "UPDATE media_upload_reservations SET slot='vocal_audio',updated_at=clock_timestamp() WHERE reservation_id='stem_primary'",
        ),
      ).rejects.toThrow("media reservation slot is immutable");
      await expect(admin.query("DELETE FROM media_song_stems")).rejects.toBeDefined();
      await expect(admin.query("UPDATE media_song_stems SET size_bytes=17")).rejects.toBeDefined();
      await reserve(connection, personaId, "instrumental", "instrumental_audio");
      await expect(
        admin.query(
          "INSERT INTO media_song_stems (submission_id,slot,community_id,actor_user_id,operation_id,reservation_id,immutable_ref,destination_ref,etag,object_version,size_bytes,content_type,canonical_sha256,author_persona_id) VALUES ($1,'instrumental_audio',$2,$3,$4,'instrumental','media://x','r2://x','e','v',16,'audio/mpeg',$5,$6)",
          [
            submission,
            community,
            actor,
            `${operation}-stem-instrumental_audio`,
            "d".repeat(64),
            personaId,
          ],
        ),
      ).rejects.toThrow("sealed song stem facts do not match its reservation and submission");
    });
  });
});
