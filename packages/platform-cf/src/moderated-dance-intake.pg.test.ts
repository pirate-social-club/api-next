import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import type { Client } from "pg";
import {
  applyPostgresTestBaselineConnection,
  createReusablePostgresTestSchemaOwner,
} from "../../../scripts/postgres-test-baseline.ts";
import { seedModeratedDanceIntake as seed } from "./moderated-dance-intake.pg-fixture.ts";
import { moderatedDanceReplayDigests } from "./moderated-dance-normalization.ts";

// These native cases use the maintained baseline and fictional bootstrap inputs.
// They make no provider request, upload or real-recording acceptance claim.
const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && url === undefined)
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required");
const suite = url === undefined ? describe.skip : describe;
const reusableSchema = createReusablePostgresTestSchemaOwner();
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

async function withFixture(
  use: (f: Awaited<ReturnType<typeof seed>>, admin: Client) => Promise<void>,
  options: Parameters<typeof seed>[3] = {},
) {
  if (url === undefined) throw new Error("Isolated target not configured");
  return reusableSchema.run({
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
      await use(await seed(admin, scoped.toString(), undefined, options), admin);
    },
  });
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
        "INSERT INTO dance_moderator_reference_revisions_v1 SELECT 'page-'||lpad(n::TEXT,2,'0'),revision,community_id,song_post_id,audio_revision,segment_id,reference_post_id,video_render_revision,reference_digest,source_binding,alignment_evidence,terms_hash,created_at,reference_community_id FROM dance_moderator_reference_revisions_v1 CROSS JOIN generate_series(1,21) n WHERE choreography_id=$1",
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
        admin.query("SELECT read_moderated_dance_capture_options_v1($1,$2,$3,$4)", [
          f.facts.accountId,
          f.facts.communityId,
          f.facts.songPostId,
          "f".repeat(64),
        ]),
      ).rejects.toMatchObject({ code: "DRV06" });
      await expect(
        Effect.runPromise(
          f.store.captureOptions(f.facts.communityId, f.facts.songPostId, "f".repeat(64)),
        ),
      ).rejects.toMatchObject({ reason: "invalid_request" });
    }));
  for (const claimedProvider of [true, false]) {
    test(`expired work releases capacity with ${claimedProvider ? "settled provider work" : "no inner provider claim"}`, async () =>
      withFixture(
        async (f, admin) => {
          await f.ready();
          const first = await Effect.runPromise(f.store.command(f.create)),
            session = first.session;
          const shared = {
            version: "dance-moderated-intake-v1",
            community_id: session.community_id,
            session_id: session.session_id,
            terms_hash: session.terms_hash,
          } as const;
          await Effect.runPromise(
            f.store.command({
              ...shared,
              operation: "consent",
              idempotency_key: "capacity-consent",
              consent_version: session.consent_version,
              consent_hash: session.consent_hash,
              retention_hash: session.retention_hash,
            }),
          );
          const reserved = await Effect.runPromise(
            f.store.command({
              ...shared,
              operation: "reserve",
              idempotency_key: "capacity-reserve",
              content_type: "video/mp4",
              size_bytes: 1000,
              duration_ms: session.body_end_ms,
            }),
          );
          const upload = reserved.session.upload_id;
          expect(upload).not.toBeNull();
          await Effect.runPromise(
            f.store.command({
              ...shared,
              operation: "finalize",
              idempotency_key: "capacity-finalize",
              upload_id: upload,
            }),
          );
          const claim = async (token: string) =>
            (
              await admin.query(
                "SELECT claim_moderated_dance_media_v1($1,$2,$3,$4::jsonb) packet",
                [
                  token,
                  f.facts.profile.mediaRuntimeRevision,
                  f.facts.profile.safetyProviderRevision,
                  JSON.stringify(f.facts.profile.replayCompatibleEpochs),
                ],
              )
            ).rows[0]?.packet;
          const seal = await claim("capacity-seal");
          const ingress = (
            await admin.query(
              "SELECT private_object_key FROM dance_moderated_uploads_v1 WHERE upload_id=$1",
              [upload],
            )
          ).rows[0]?.private_object_key;
          await Bun.sleep(2);
          // Fictional verified storage/provider observations in an isolated SQL test.
          await admin.query("SELECT persist_moderated_dance_seal_v1($1,$2,$3::jsonb)", [
            upload,
            seal.token,
            JSON.stringify({
              outcome: "sealed",
              immutable_ref: `private-dance://${upload}/source`,
              destination_ref: `moderated-dance/originals/${upload}/source`,
              etag: "capacity-etag",
              version: "capacity-version",
              size_bytes: 1000,
              canonical_sha256: "c".repeat(64),
              firstStoredAtMs: Date.now(),
              ingress_identity: {
                key: ingress,
                version: "capacity-ingress-version",
                etag: "capacity-ingress-etag",
                size: 1000,
              },
            }),
          ]);
          const work = await claim("capacity-work");
          expect(work).toMatchObject({ action: "dispatch", uploadId: upload });
          if (claimedProvider) {
            const probe = (
              await admin.query("SELECT claim_moderated_dance_probe_v1($1,$2) packet", [
                upload,
                work.token,
              ])
            ).rows[0]?.packet;
            await admin.query("SELECT persist_moderated_dance_probe_v1($1,$2,$3::jsonb)", [
              upload,
              work.token,
              JSON.stringify({
                status: "submitted",
                attempt: {
                  ...probe.attempt,
                  providerJobId: "capacity-probe-job",
                  providerJobPhase: "allocated",
                },
              }),
            ]);
          }
          const state = async () =>
            (
              await admin.query(
                "SELECT state,completed_at FROM dance_moderated_processing_v1 WHERE upload_id=$1",
                [upload],
              )
            ).rows[0];
          await f.ready();
          expect(await state()).toEqual({ state: "claimed", completed_at: null });
          // Let the admitted short fixture window expire; do not edit captured clocks.
          await Bun.sleep(Math.max(0, session.expires_at_ms - Date.now()) + 30);
          const cleanups: (
            | {
                kind: "derived";
                token: string;
                identity: { frames: { identity: { key: string } }[] };
              }
            | {
                kind: "ingress" | "original";
                token: string;
                identity: { destination_ref?: string; key: string };
              }
          )[] = [];
          for (let index = 0; index < 3; index++) {
            const packet = (
              await admin.query("SELECT claim_moderated_dance_owned_cleanup_v1($1) packet", [
                `capacity-cleanup-${index}`,
              ])
            ).rows[0]?.packet;
            expect(packet).toMatchObject({ uploadId: upload, delivery: "fresh_grant" });
            cleanups.push(packet);
          }
          expect(
            (
              await admin.query(
                "SELECT state FROM dance_moderated_sessions_v1 WHERE session_id=$1",
                [session.session_id],
              )
            ).rows,
          ).toEqual([{ state: "terminal" }]);
          const finish = async (packet: (typeof cleanups)[number], complete: boolean) => {
            const keys =
              packet.kind === "derived"
                ? packet.identity.frames.map(
                    (frame: { identity: { key: string } }) => frame.identity.key,
                  )
                : [packet.identity.destination_ref ?? packet.identity.key];
            await admin.query(
              "SELECT finish_moderated_dance_owned_cleanup_v1($1,$2,$3,$4::jsonb)",
              [
                upload,
                packet.kind,
                packet.token,
                JSON.stringify({
                  outcome: complete ? "owned_payload_fenced" : "unknown",
                  observations: complete
                    ? keys.map((key: string) => ({
                        key,
                        outcome: "payload_fenced",
                        version: "cleanup-version",
                        etag: "cleanup-etag",
                      }))
                    : [],
                }),
              ],
            );
          };
          const [firstCleanup, secondCleanup, thirdCleanup] = cleanups;
          if (!firstCleanup || !secondCleanup || !thirdCleanup)
            throw new Error("Expected three owned cleanup targets");
          await finish(firstCleanup, true);
          await finish(secondCleanup, true);
          await finish(thirdCleanup, false);
          await admin.query("SELECT record_moderated_dance_maintenance_v1()");
          expect(await state()).toEqual({ state: "claimed", completed_at: null });
          await finish(thirdCleanup, true);
          await admin.query("SELECT record_moderated_dance_maintenance_v1()");
          if (claimedProvider) {
            expect(await state()).toEqual({ state: "claimed", completed_at: null });
            const provider = (
              await admin.query(
                "SELECT claim_moderated_dance_provider_cleanup_v1('capacity-provider-cleanup') packet",
              )
            ).rows[0]?.packet;
            expect(provider).toMatchObject({
              provider: "cloudconvert",
              jobId: "capacity-probe-job",
            });
            await admin.query(
              "SELECT finish_moderated_dance_provider_cleanup_v1($1,$2,$3::jsonb)",
              [
                provider.effectId,
                provider.token,
                JSON.stringify({ outcome: "deleted", jobId: provider.jobId, tag: provider.tag }),
              ],
            );
          }
          await f.ready();
          const second = await Effect.runPromise(
            f.store.command({ ...f.create, idempotency_key: "capacity-after-disposal" }),
          );
          expect(second.session.state).toBe("created");
          expect(second.session.session_id).not.toBe(session.session_id);
          expect(await state()).toEqual({ state: "failed", completed_at: expect.any(Date) });
          expect(
            (
              await admin.query(
                "SELECT charged_calls FROM dance_moderated_processing_v1 WHERE upload_id=$1",
                [upload],
              )
            ).rows,
          ).toEqual([{ charged_calls: "6" }]);
          expect(
            (
              await admin.query(
                "SELECT count(*)::INTEGER n FROM dance_moderated_provider_effects_v1 WHERE upload_id=$1",
                [upload],
              )
            ).rows[0]?.n,
          ).toBe(claimedProvider ? 1 : 0);
        },
        {
          profile: {
            mediaRuntimeRevision: "dance-moderated-media-v2",
            maximumPendingMediaPerAccount: 1,
            maximumPendingMediaGlobal: 1,
            sessionTtlMs: 3000,
            uploadTtlMs: 2000,
            presignTtlSeconds: 1,
            providerWaitMs: 1000,
            readinessLeaseMs: 1000,
            workLeaseMs: 500,
          },
        },
      ));
  }

  test("known-ID unknown probe recovers once and persists the complete normalized body without restoring provider grants", async () =>
    withFixture(async (f, admin) => {
      await f.ready();
      const first = await Effect.runPromise(f.store.command(f.create)),
        session = first.session;
      const shared = {
        version: "dance-moderated-intake-v1",
        community_id: session.community_id,
        session_id: session.session_id,
        terms_hash: session.terms_hash,
      } as const;
      await Effect.runPromise(
        f.store.command({
          ...shared,
          operation: "consent",
          idempotency_key: "probe-consent",
          consent_version: session.consent_version,
          consent_hash: session.consent_hash,
          retention_hash: session.retention_hash,
        }),
      );
      const reserved = await Effect.runPromise(
        f.store.command({
          ...shared,
          operation: "reserve",
          idempotency_key: "probe-reserve",
          content_type: "video/mp4",
          size_bytes: 1000,
          duration_ms: session.body_end_ms,
        }),
      );
      const uploadId = reserved.session.upload_id;
      expect(uploadId).not.toBeNull();
      await Effect.runPromise(
        f.store.command({
          ...shared,
          operation: "finalize",
          idempotency_key: "probe-finalize",
          upload_id: uploadId,
        }),
      );
      const claim = async (token: string) =>
        (
          await admin.query("SELECT claim_moderated_dance_media_v1($1,$2,$3,$4::jsonb) AS packet", [
            token,
            f.facts.profile.mediaRuntimeRevision,
            f.facts.profile.safetyProviderRevision,
            JSON.stringify(f.facts.profile.replayCompatibleEpochs),
          ])
        ).rows[0]?.packet;
      const seal = await claim("probe-seal-observation");
      expect(seal).toMatchObject({ action: "seal", uploadId });
      const ingress = (
        await admin.query(
          "SELECT private_object_key FROM dance_moderated_uploads_v1 WHERE upload_id=$1",
          [uploadId],
        )
      ).rows[0]?.private_object_key;
      // This is fictional verified storage evidence for a SQL transition test,
      // never proof of an R2 operation. Wait beyond timestamp precision once.
      await Bun.sleep(2);
      await admin.query("SELECT persist_moderated_dance_seal_v1($1,$2,$3::jsonb)", [
        uploadId,
        seal.token,
        JSON.stringify({
          outcome: "sealed",
          immutable_ref: `private-dance://${uploadId}/source`,
          destination_ref: `moderated-dance/originals/${uploadId}/source`,
          etag: "test-immutable-etag",
          version: "test-immutable-version",
          size_bytes: 1000,
          canonical_sha256: "a".repeat(64),
          firstStoredAtMs: Date.now(),
          ingress_identity: {
            key: ingress,
            version: "test-ingress-version",
            etag: "test-ingress-etag",
            size: 1000,
          },
        }),
      ]);
      const work = await claim("probe-owned-observation");
      expect(work).toMatchObject({ action: "dispatch", uploadId });
      const probeClaim = async () =>
        (
          await admin.query("SELECT claim_moderated_dance_probe_v1($1,$2) AS packet", [
            uploadId,
            work.token,
          ])
        ).rows[0]?.packet;
      const persist = (value: unknown) =>
        admin.query("SELECT persist_moderated_dance_probe_v1($1,$2,$3::jsonb)", [
          uploadId,
          work.token,
          JSON.stringify(value),
        ]);
      const allocated = await probeClaim();
      expect(allocated).toMatchObject({ fresh: true, phase: "allocating" });
      await persist({
        status: "submitted",
        attempt: {
          ...allocated.attempt,
          providerJobId: "original-probe-job",
          providerJobPhase: "allocated",
        },
      });
      const start = await probeClaim();
      expect(start).toMatchObject({
        fresh: true,
        phase: "submitting",
        attempt: { providerJobId: "original-probe-job", providerJobPhase: "submitting" },
      });
      await persist({ status: "retryable_failure", reason: "transport", attempt: start.attempt });
      const unknown = await probeClaim();
      expect(unknown).toEqual({ ...start, fresh: false, phase: "unknown" });
      const before = (
        await admin.query(
          "SELECT work_token,charged_calls,charged_spend_microunits,normalization_claimed_at FROM dance_moderated_processing_v1 WHERE upload_id=$1",
          [uploadId],
        )
      ).rows[0];
      const completed = {
        status: "completed",
        attempt: { ...start.attempt, providerJobPhase: "started" },
        probe: {
          durationMs: session.body_end_ms,
          hasAudio: true,
          audioCodec: "aac",
          videoCodec: "h264",
          width: 1280,
          height: 720,
          evidenceRef: "fictional-original-probe-evidence",
        },
      };
      await expect(
        persist({
          ...completed,
          attempt: { ...completed.attempt, providerJobId: "foreign-probe-job" },
        }),
      ).rejects.toMatchObject({ code: "DRV05" });
      await expect(
        persist({ ...completed, attempt: { ...completed.attempt, providerJobPhase: "allocated" } }),
      ).rejects.toMatchObject({ code: "DRV06" });
      await expect(
        admin.query("SELECT persist_moderated_dance_probe_v1($1,'foreign-observation',$2::jsonb)", [
          uploadId,
          JSON.stringify(completed),
        ]),
      ).rejects.toMatchObject({ code: "DRV05" });
      await expect(
        persist({
          ...completed,
          attempt: {
            ...completed.attempt,
            runtimeFence: {
              ...completed.attempt.runtimeFence,
              runtimeDeadlineMs: completed.attempt.runtimeFence.runtimeDeadlineMs + 1,
            },
          },
        }),
      ).rejects.toMatchObject({ code: "DRV05" });
      await persist({ status: "processing", attempt: completed.attempt });
      expect(await probeClaim()).toMatchObject({
        fresh: false,
        phase: "started",
        attempt: completed.attempt,
      });
      await persist({
        status: "retryable_failure",
        reason: "transport",
        attempt: completed.attempt,
      });
      expect(await probeClaim()).toMatchObject({ fresh: false, phase: "unknown" });
      await persist(completed);
      const final = await probeClaim();
      expect(final).toMatchObject({
        fresh: false,
        phase: "complete",
        attempt: completed.attempt,
        probe: completed.probe,
      });
      expect(final.attempt.runtimeFence).toEqual(start.attempt.runtimeFence);
      expect(
        (
          await admin.query(
            "SELECT work_token,charged_calls,charged_spend_microunits,normalization_claimed_at FROM dance_moderated_processing_v1 WHERE upload_id=$1",
            [uploadId],
          )
        ).rows[0],
      ).toEqual(before);
      // Exercise the real persistence function after the real intake/probe
      // transitions. Storage/provider inputs remain explicitly fictional.
      expect(
        (
          await admin.query("SELECT claim_moderated_dance_normalization_v1($1,$2) packet", [
            uploadId,
            work.token,
          ])
        ).rows[0]?.packet,
      ).toBe(true);
      await admin.query("SELECT attach_moderated_dance_provider_v1($1,$2,$3,$4)", [
        uploadId,
        work.token,
        "original-normalization-job",
        work.providerTag,
      ]);
      const frames = [0, 1, 2].map((index) => ({
        index,
        sha256: String(index + 6).repeat(64),
        timestampMs: [
          0,
          Math.floor(session.body_start_ms / 2),
          Math.floor((session.body_start_ms + session.body_end_ms) / 2),
        ][index],
        identity: {
          key: `moderated-dance/derived/${uploadId}/frame-${index}.jpg`,
          version: "fixture-v1",
          etag: "fixture-etag",
          size: 4,
        },
      }));
      const replay = await moderatedDanceReplayDigests({
        scope: f.facts.profile.replayScope,
        sourceSha256: "a".repeat(64),
        frames: Array.from(
          {
            length: Math.ceil(
              ((session.body_end_ms - session.body_start_ms) * f.facts.profile.normalizationFps) /
                1000,
            ),
          },
          () => "c".repeat(64),
        ),
        keys: f.replayKeys,
      });
      const normalize = (selectedFrames: unknown) =>
        admin.query(
          "SELECT persist_moderated_dance_normalization_v1($1,$2,$3::jsonb,$4::jsonb) packet",
          [uploadId, work.token, JSON.stringify(selectedFrames), JSON.stringify(replay.claims)],
        );
      // This raw source deliberately matches the seeded public reference:
      // persistence must finish while retaining the blocked integrity result.
      expect((await normalize(frames)).rows[0]?.packet).toEqual({ integrity: "blocked" });
      expect(
        (
          await admin.query(
            "SELECT frame_index::INTEGER,timestamp_ms::INTEGER FROM dance_moderated_frame_artifacts_v1 WHERE upload_id=$1 ORDER BY frame_index",
            [uploadId],
          )
        ).rows,
      ).toEqual(
        frames.map((frame) => ({ frame_index: frame.index, timestamp_ms: frame.timestampMs })),
      );
      expect(
        (
          await admin.query(
            "SELECT state,normalized_digest,normalization_hash FROM dance_moderated_uploads_v1 WHERE upload_id=$1",
            [uploadId],
          )
        ).rows[0],
      ).toEqual({
        state: "sealed",
        normalized_digest: replay.claims.find((c) => c.kind === "body")?.digest,
        normalization_hash: session.normalization_hash,
      });
      await expect(normalize([frames[0], frames[0], frames[2]])).rejects.toMatchObject({
        code: "DRV05",
      });
      expect(
        (
          await admin.query(
            "SELECT proconfig FROM pg_proc WHERE oid='persist_moderated_dance_normalization_v1(text,text,jsonb,jsonb)'::regprocedure",
          )
        ).rows[0]?.proconfig,
      ).toContain(
        `search_path=${(await admin.query("SELECT current_schema() schema")).rows[0]?.schema}, pg_catalog, pg_temp`,
      );
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM dance_moderated_provider_calls_v1 WHERE upload_id=$1",
            [uploadId],
          )
        ).rows[0]?.n,
      ).toBe(0);
    }));
});
