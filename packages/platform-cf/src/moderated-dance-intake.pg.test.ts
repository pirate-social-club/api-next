import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { prepareModeratedDancePolicyPublication } from "../../application/src/use-cases/dance/moderated-policy.ts";
import { moderatedDanceIntakeFacts } from "../../testing/src/moderated-dance-intake-fixture.ts";
import { makeControlPlaneModeratedDanceIntakeStore } from "./dance-moderated-intake-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

// Source-only until the coordinator registers the prospective migrations and
// generates their maintained baseline. No pending SQL/archive fixture is loaded
// here. All data/profile/provenance below is fictional isolated test input.
const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url === undefined ? describe.skip : describe;
const owner = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30_000);
afterAll(() => owner.dispose());
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

async function withFixture(
  use: (f: Awaited<ReturnType<typeof seed>>, admin: Client) => Promise<void>,
) {
  if (url === undefined) throw new Error("Isolated target not configured");
  return owner.run({
    baseConnectionString: url,
    schemaName: "moderated_dance_intake_pg_v1",
    use: async ({ admin, schema }) => {
      const scoped = new URL(url);
      scoped.searchParams.set("options", `-c search_path=${schema}`);
      await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
      await admin.query(`SET search_path TO ${quote(schema)}`);
      expect(
        (
          await admin.query(
            "SELECT to_regprocedure('read_moderated_dance_capture_options_v1(text,text,text,text)') IS NOT NULL AS present",
          )
        ).rows[0]?.present,
      ).toBe(true);
      await use(await seed(admin, scoped.toString()), admin);
    },
  });
}

async function seed(admin: Client, connection: string) {
  const f = moderatedDanceIntakeFacts(),
    now = Date.now(),
    hash = "a".repeat(64);
  const publication = await Effect.runPromise(
    prepareModeratedDancePolicyPublication({
      version: "dance-moderated-policy-publication-v1",
      policy_id: "private-test-policy",
      community_id: f.communityId,
      policy: f.policy,
      profile: f.profile,
      safety_policy: f.safetyPolicy,
      disposition: {
        ...f.disposition,
        validUntilMs: now + 10 * 86400000,
        hold: { ...f.disposition.hold, disposeByMs: now + 10 * 86400000 },
      },
      disclosure: {
        version: "dance-moderated-disclosure-v1",
        consent_text: "Fictional consent",
        retention_text: "Fictional finite retention",
        publication_text: "Fictional independent optional Post",
        owner_rubric_text: "Fictional cue/routine owner attestation",
      },
      valid_from: new Date(now - 1000).toISOString(),
      valid_until: new Date(now + 3600000).toISOString(),
      accepted_by: "test-operator",
      acceptance_ref: "isolated-test-only",
      acceptance_hash: hash,
      producer_registration: {
        status: "active",
        acceptance_ref: "isolated-test-producer",
        acceptance_hash: hash,
      },
    }),
  );
  // The pre-existing public-song graph is bootstrap fixture data, not evidence
  // of a real renderer/provider. New intake commands run with all guards ON.
  await admin.query("BEGIN");
  try {
    await admin.query("SET LOCAL session_replication_role=replica");
    await admin.query("INSERT INTO users(user_id) VALUES($1),('private-test-owner')", [
      f.accountId,
    ]);
    await admin.query(
      "INSERT INTO personas(persona_id,account_id) VALUES($1,$2),('private-owner-persona','private-test-owner')",
      [f.personaId, f.accountId],
    );
    await admin.query(
      "INSERT INTO communities(community_id,display_name,status,created_by_user_id) VALUES($1,'Private Dance test','active','private-test-owner')",
      [f.communityId],
    );
    await admin.query(
      "INSERT INTO persona_community_bindings(persona_id,account_id,community_id,binding_source) VALUES($1,$2,$3,'activity_participation')",
      [f.personaId, f.accountId, f.communityId],
    );
    await admin.query(
      "INSERT INTO community_role_assignments(role_assignment_id,community_id,account_id,role) VALUES('private-owner-assignment',$1,'private-test-owner','owner')",
      [f.communityId],
    );
    await admin.query(
      "INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,visibility) VALUES($1,$2,'private-test-owner','private-owner-persona','song','published','public'),($1,'private-reference','private-test-owner','private-owner-persona','video','published','public')",
      [f.communityId, f.songPostId],
    );
    await admin.query(
      "INSERT INTO media_publication_projections(submission_id,community_id,actor_user_id,author_persona_id,operation_id,post_id,creation_revision,audio_revision,analysis_revision,decision_revision,canonical_audio_sha256,title,audio_asset_ref,language_status,lyrics_explicitness,alignment,data_registration,locked_delivery) VALUES('private-song-submission',$1,'private-test-owner','private-owner-persona','private-song-operation',$2,1,$3,1,1,$4,'Test song','test/song','not_applicable','not_applicable','not_applicable','pending','not_required')",
      [f.communityId, f.songPostId, f.audioRevision, hash],
    );
    await admin.query(
      "INSERT INTO dance_song_segments(segment_id,community_id,song_post_id,song_submission_id,audio_revision,start_ms,end_ms,canonical_audio_duration_ms,canonical_segment_audio_ref,canonical_segment_sha256,extraction_policy_version,source_media_sha256,segment_terms_hash) VALUES($1,$2,$3,'private-song-submission',$4,10000,20000,180000,'test/segment',$5,'test-canonical-extraction',$5,$5)",
      [f.segmentId, f.communityId, f.songPostId, f.audioRevision, hash],
    );
    await admin.query(
      "INSERT INTO dance_moderator_reference_revisions_v1(choreography_id,revision,community_id,song_post_id,audio_revision,segment_id,reference_post_id,video_render_revision,reference_digest,source_binding,alignment_evidence,terms_hash) VALUES($1,1,$2,$3,$4,$5,'private-reference','fictional-verified-master',$6,'{}','{}',$6)",
      [f.choreographyId, f.communityId, f.songPostId, f.audioRevision, f.segmentId, hash],
    );
    await admin.query(
      "INSERT INTO account_streak_clocks(account_id,timezone,timezone_updated_at,next_change_allowed_at) VALUES($1,'UTC',statement_timestamp(),statement_timestamp()+interval '7 days')",
      [f.accountId],
    );
    await admin.query("COMMIT");
  } catch (error) {
    await admin.query("ROLLBACK");
    throw error;
  }
  await admin.query("SELECT publish_moderated_dance_policy_v1($1::jsonb)", [
    JSON.stringify(publication),
  ]);
  const runtime = makeDirectPostgresControlPlaneLayer(connection);
  const store = makeControlPlaneModeratedDanceIntakeStore(runtime, f.accountId, {
    signer: {
      presign: async () => {
        throw new Error("No storage URL requested by these SQL cases");
      },
    },
    randomU32: () => 1,
  });
  const create = {
    version: "dance-moderated-intake-v1",
    operation: "create",
    idempotency_key: "private-create",
    community_id: f.communityId,
    song_post_id: f.songPostId,
    persona_id: f.personaId,
    choreography_id: f.choreographyId,
    choreography_revision: 1,
    expected_policy_hash: publication.policy.hash,
  } as const;
  const ready = async () => {
    await admin.query("SELECT record_moderated_dance_maintenance_v1()");
    await admin.query("SELECT announce_moderated_dance_processor_v1($1,$2,$3::jsonb)", [
      f.profile.mediaRuntimeRevision,
      f.profile.safetyProviderRevision,
      JSON.stringify(f.profile.replayCompatibleEpochs),
    ]);
  };
  return { store, create, ready, facts: f };
}

suite("private moderated Dance intake on the maintained generated baseline", () => {
  test("missing processor refuses before allocation; real readiness admits a non-member, and replay precedes fresh readiness", async () =>
    withFixture(async (f, admin) => {
      await expect(Effect.runPromise(f.store.command(f.create))).rejects.toMatchObject({
        reason: "unavailable",
      });
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_sessions_v1")).rows[0]
          ?.n,
      ).toBe(0);
      await f.ready();
      const receipt = await Effect.runPromise(f.store.command(f.create));
      expect(receipt.session.score_bps).toBeNull();
      expect(receipt.session.state).toBe("created");
      expect(
        (
          await admin.query(
            "SELECT audio_revision::INTEGER,bindings FROM reward_activity_objective_captures_v2 WHERE source_id=$1",
            [receipt.session.session_id],
          )
        ).rows,
      ).toEqual([{ audio_revision: f.facts.audioRevision, bindings: [] }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM community_memberships WHERE user_id=$1",
            [f.facts.accountId],
          )
        ).rows[0]?.n,
      ).toBe(0);
      await admin.query("DELETE FROM dance_moderated_processor_readiness_v1");
      expect(await Effect.runPromise(f.store.command(f.create))).toEqual(receipt);
      await expect(
        Effect.runPromise(f.store.command({ ...f.create, song_post_id: "other-song" })),
      ).rejects.toMatchObject({ reason: "idempotency_conflict" });
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_intake_commands_v1"))
          .rows[0]?.n,
      ).toBe(1);
    }));

  test("consent precedes reservation; immutable replay preserves one upload and its three disposition targets", async () =>
    withFixture(async (f, admin) => {
      await f.ready();
      const first = await Effect.runPromise(f.store.command(f.create)),
        s = first.session;
      const reserve = {
        version: "dance-moderated-intake-v1",
        operation: "reserve",
        idempotency_key: "private-reserve",
        community_id: s.community_id,
        session_id: s.session_id,
        terms_hash: s.terms_hash,
        content_type: "video/mp4",
        size_bytes: 1000,
        duration_ms: s.body_end_ms,
      } as const;
      await expect(Effect.runPromise(f.store.command(reserve))).rejects.toMatchObject({
        reason: "revision_conflict",
      });
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_uploads_v1")).rows[0]
          ?.n,
      ).toBe(0);
      const consent = {
        version: "dance-moderated-intake-v1",
        operation: "consent",
        idempotency_key: "private-consent",
        community_id: s.community_id,
        session_id: s.session_id,
        terms_hash: s.terms_hash,
        consent_version: s.consent_version,
        consent_hash: s.consent_hash,
        retention_hash: s.retention_hash,
      } as const;
      await Effect.runPromise(f.store.command(consent));
      const upload = await Effect.runPromise(f.store.command(reserve));
      expect(await Effect.runPromise(f.store.command(reserve))).toEqual(upload);
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_uploads_v1")).rows[0]
          ?.n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT kind,state FROM dance_moderated_media_dispositions_v1 ORDER BY kind",
          )
        ).rows,
      ).toEqual([
        { kind: "derived", state: "held" },
        { kind: "ingress", state: "held" },
        { kind: "original", state: "held" },
      ]);
      await admin.query("SELECT begin_moderated_dance_account_erasure_v1($1)", [f.facts.accountId]);
      const claim = (
        await admin.query(
          "SELECT claim_moderated_dance_owned_cleanup_v1('original-cleanup-token') AS packet",
        )
      ).rows[0]?.packet;
      expect(claim).toMatchObject({ delivery: "fresh_grant", token: "original-cleanup-token" });
      expect((await admin.query("SELECT state FROM dance_moderated_sessions_v1")).rows).toEqual([
        { state: "terminal" },
      ]);
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM dance_moderated_active_slots_v1"))
          .rows[0]?.n,
      ).toBe(0);
      // Other never-observed owned targets progress before the uncertain first
      // one is observed again. None of those observations restores its grant.
      await admin.query("SELECT claim_moderated_dance_owned_cleanup_v1('second-target-token')");
      await admin.query("SELECT claim_moderated_dance_owned_cleanup_v1('third-target-token')");
      const recover = (
        await admin.query(
          "SELECT claim_moderated_dance_owned_cleanup_v1('must-not-regrant') AS packet",
        )
      ).rows[0]?.packet;
      expect(recover).toMatchObject({ delivery: "recovery_only", token: "original-cleanup-token" });
      await expect(
        admin.query("SELECT finish_moderated_dance_owned_cleanup_v1($1,$2,$3,$4::jsonb)", [
          claim.uploadId,
          claim.kind,
          claim.token,
          JSON.stringify({ outcome: "owned_payload_fenced", observations: [] }),
        ]),
      ).rejects.toMatchObject({ code: "DRV06" });
      expect(
        (
          await admin.query(
            "SELECT state FROM dance_moderated_media_dispositions_v1 WHERE upload_id=$1 AND kind=$2",
            [claim.uploadId, claim.kind],
          )
        ).rows,
      ).toEqual([{ state: "running" }]);
      await expect(Effect.runPromise(f.store.command(reserve))).rejects.toMatchObject({
        reason: "not_found",
      });
    }));

  test("discovery pages beyond twenty references without mixing accounts, songs or policy revisions", async () =>
    withFixture(async (f, admin) => {
      await f.ready();
      await admin.query(
        "INSERT INTO dance_moderator_reference_revisions_v1 SELECT 'page-'||lpad(n::TEXT,2,'0'),revision,community_id,song_post_id,audio_revision,segment_id,reference_post_id,video_render_revision,reference_digest,source_binding,alignment_evidence,terms_hash,created_at FROM dance_moderator_reference_revisions_v1 CROSS JOIN generate_series(1,21) n WHERE choreography_id=$1",
        [f.facts.choreographyId],
      );
      const first = await Effect.runPromise(
        f.store.captureOptions(f.facts.communityId, f.facts.songPostId),
      );
      expect(first.choreographies).toHaveLength(20);
      expect(first.next_cursor).not.toBeNull();
      expect(first.choreographies[0]).toMatchObject({
        canonical_song_start_ms: 10000,
        canonical_song_end_ms: 20000,
      });
      const second = await Effect.runPromise(
        f.store.captureOptions(f.facts.communityId, f.facts.songPostId, first.next_cursor),
      );
      expect(second.choreographies).toHaveLength(2);
      expect(second.next_cursor).toBeNull();
      expect(
        new Set([...first.choreographies, ...second.choreographies].map((c) => c.choreography_id))
          .size,
      ).toBe(22);
      await expect(
        Effect.runPromise(
          f.store.captureOptions(f.facts.communityId, f.facts.songPostId, "f".repeat(64)),
        ),
      ).rejects.toMatchObject({ reason: "invalid_request" });
    }));
});
