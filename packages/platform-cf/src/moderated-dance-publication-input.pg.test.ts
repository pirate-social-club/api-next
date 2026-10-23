import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Client } from "pg";
import { createReusablePostgresTestSchemaOwner } from "../../../scripts/postgres-test-baseline.ts";
import { prepareDancePublicationInput } from "../../application/src/use-cases/dance/publication-input.ts";
import { crossDeadline, runBlockedQuery } from "./moderated-dance-authority.pg-fixture.ts";
import {
  command,
  makePublicationInputFixture,
  protocol,
  stored,
  token,
} from "./moderated-dance-publication-input.pg-fixture.ts";
import { makeModeratedDancePublicationCleanup } from "./moderated-dance-publication-storage.ts";
import { makeControlPlaneVideoPublicationStore } from "./video-publication-repository.ts";

const suite = process.env.CONTROL_PLANE_POSTGRES_TEST_URL === undefined ? describe.skip : describe;
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const sql = "SELECT moderated_dance_publication_input_v1($1,$2,$3::jsonb) packet";
setDefaultTimeout(30_000);
const reusableSchema = createReusablePostgresTestSchemaOwner();
const withFixture = makePublicationInputFixture(reusableSchema);
afterAll(async () => {
  await reusableSchema.dispose();
});

suite("native private Dance input adoption and irreversible copy grants", () => {
  test("a lost put reply cannot authorize another write; one adopted input enters normal analysis without multipart fiction", async () =>
    withFixture(async (f, admin, r) => {
      const { h } = await stored(admin, r),
        id = r.capture.reviewId,
        p = protocol(admin, id);
      expect(await p.put()).toEqual({ status: "unknown" });
      const before = (
        await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id])
      ).rows[0]?.state;
      const originalReceipt = (
        await admin.query(
          "SELECT receipt FROM dance_moderated_command_receipts_v1 WHERE operation='verdict'",
        )
      ).rows[0]?.receipt;
      const result = await p.adopt();
      expect(await p.adopt()).toEqual(result);
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM media_post_submissions WHERE submission_id=$1",
            [h.submission_id],
          )
        ).rows[0]?.n,
      ).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT phase,status,video_revision,event_sequence FROM media_post_submissions WHERE submission_id=$1",
            [h.submission_id],
          )
        ).rows[0],
      ).toEqual({
        phase: "analysis",
        status: "processing",
        video_revision: "1",
        event_sequence: "2",
      });
      expect(
        (
          await admin.query(
            "SELECT input_source,state,multipart_upload_id,multipart_completed_at FROM media_upload_reservations WHERE reservation_id=$1",
            [h.reservation_id],
          )
        ).rows[0],
      ).toEqual({
        input_source: "dance_handoff",
        state: "sealed",
        multipart_upload_id: null,
        multipart_completed_at: null,
      });
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM media_video_analysis_outbox WHERE submission_id=$1",
            [h.submission_id],
          )
        ).rows[0]?.n,
      ).toBe(1);
      const after = (
        await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id])
      ).rows[0]?.state;
      expect(after).toEqual({
        ...before,
        publication: "transferred",
        publicationRevision: before.publicationRevision + 1,
      });
      expect(
        (
          await admin.query(
            "SELECT receipt FROM dance_moderated_command_receipts_v1 WHERE operation='verdict'",
          )
        ).rows[0]?.receipt,
      ).toEqual(originalReceipt);
      expect((await command(admin, id, "inspect")).source_identity).toBeNull();
      expect(await p.cleanup()).toBeNull();
      expect(
        (await admin.query("SELECT claim_moderated_dance_publication_cleanup_v1('unused') packet"))
          .rows[0]?.packet,
      ).toBeNull();
      const normal = makeControlPlaneVideoPublicationStore(f.runtime);
      expect(
        await normal.getReservationForAccount({
          reservationId: h.reservation_id,
          actorAccountId: f.facts.accountId,
        }),
      ).toBeNull();
      await admin.query("SELECT begin_moderated_dance_account_erasure_v1($1)", [f.facts.accountId]);
      expect(await p.adopt()).toEqual(result);
      expect(await p.cleanup()).toBeNull();
    }));
  test("changed source/body/song/persona and disabled video cannot create a Post; every failed transaction leaves no partial adoption", async () =>
    withFixture(async (_f, admin, r) => {
      const { body } = await stored(admin, r),
        id = r.capture.reviewId;
      const prepared = prepareDancePublicationInput(await command(admin, id, "packet"));
      for (const changed of [
        { ...prepared, review: { ...prepared.review, qualificationRef: "forged" } },
        { ...prepared, initial: { ...prepared.initial, authorPersonaId: "foreign" } },
        { ...prepared, sealed: { ...prepared.sealed, phase: "publish" } },
        {
          ...prepared,
          initial: {
            ...prepared.initial,
            songPlan: { ...prepared.initial.songPlan, clipStartSamples: 0 },
          },
        },
      ])
        await expect(command(admin, id, "adopt", { prepared: changed })).rejects.toMatchObject({
          code: "DRV06",
        });
      await expect(
        command(admin, id, "plan", { body: { ...body, sourceSha256: "8".repeat(64) } }),
      ).rejects.toMatchObject({ code: "DRV06" });
      await expect(
        admin.query(sql, [
          id,
          "adopt",
          JSON.stringify({ token, videoTrackEnabled: false, prepared }),
        ]),
      ).rejects.toMatchObject({ code: "DRV05" });
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM media_post_submissions")).rows[0]?.n,
      ).toBe(0);
      await protocol(admin, id).adopt();
    }));
  test("a new song-owner prohibition after trimming refuses adoption without touching the passed verdict", async () =>
    withFixture(async (f, admin, r) => {
      await stored(admin, r);
      const id = r.capture.reviewId,
        p = protocol(admin, id);
      const before = (
        await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id])
      ).rows[0]?.state;
      await admin.query(
        "SELECT append_song_owner_policy_revision_v1($1,$2,'private-test-owner',1,'allowed','allowed','blocked')",
        [f.facts.communityId, f.facts.songPostId],
      );
      await expect(p.adopt()).rejects.toMatchObject({ code: "DRV05" });
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM media_post_submissions")).rows[0]?.n,
      ).toBe(0);
      expect(
        (await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id]))
          .rows[0]?.state,
      ).toEqual(before);
    }));
  test("cleanup grants remain one-shot and token-bound, and unresolved physical storage closes readiness", async () =>
    withFixture(async (_f, admin, r) => {
      await stored(admin, r);
      const id = r.capture.reviewId;
      expect(
        (
          await admin.query(
            "SELECT claim_moderated_dance_publication_cleanup_v1('first-fence') packet",
          )
        ).rows[0]?.packet,
      ).toBeNull();
      await protocol(admin, id).abandon();
      const claim = async (t: string) =>
        (await admin.query("SELECT claim_moderated_dance_publication_cleanup_v1($1) packet", [t]))
          .rows[0]?.packet;
      const finish = async (t: string, observation: unknown) =>
        (
          await admin.query(
            "SELECT finish_moderated_dance_publication_cleanup_v1($1,$2,$3::jsonb) packet",
            [id, t, JSON.stringify(observation)],
          )
        ).rows[0]?.packet;
      // A rolled-back grant dispatches nothing and may be freshly claimed.
      await admin.query("BEGIN");
      expect((await claim("rolled-back-fence")).delivery).toBe("fresh_grant");
      await admin.query("ROLLBACK");
      const first = await claim("first-fence"),
        recovery = await claim("replacement-refused");
      expect(first).toMatchObject({
        reviewId: id,
        delivery: "fresh_grant",
        fenceToken: "first-fence",
        inputToken: token,
      });
      expect(recovery).toEqual({ ...first, delivery: "recovery_only" });
      await expect(finish("replacement-refused", { outcome: "unknown" })).rejects.toMatchObject({
        code: "DRV05",
      });
      for (const changed of [
        { outcome: "absent" },
        { outcome: "fenced", key: first.key },
        { outcome: "unknown", extra: true },
      ])
        await expect(finish("first-fence", changed)).rejects.toMatchObject({ code: "DRV06" });
      expect(await finish("first-fence", { outcome: "unknown" })).toEqual({ status: "unknown" });
      expect((await command(admin, id, "inspect")).state).toBe("cleanup");
      await admin.query(
        "INSERT INTO dance_moderated_maintenance_readiness_v1 VALUES(TRUE,clock_timestamp(),clock_timestamp()+interval '1 minute') ON CONFLICT(singleton) DO UPDATE SET valid_until=EXCLUDED.valid_until",
      );
      await admin.query("SELECT record_moderated_dance_maintenance_v1()");
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM dance_moderated_maintenance_readiness_v1",
          )
        ).rows[0]?.n,
      ).toBe(0);
      expect((await claim("another-refused")).delivery).toBe("recovery_only");
    }));
  test("the composed CAS consumer commits only its observed fence and retains the receipt without altering qualification", async () =>
    withFixture(async (_f, admin, r) => {
      const { h, body } = await stored(admin, r),
        id = r.capture.reviewId;
      await protocol(admin, id).abandon();
      const before = (
        await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id])
      ).rows[0]?.state;
      let head: Awaited<
        ReturnType<Parameters<typeof makeModeratedDancePublicationCleanup>[0]["bucket"]["head"]>
      > = {
        version: "independent-v1",
        etag: "independent-etag",
        size: body.size,
        checksums: { sha256: Uint8Array.from({ length: 32 }, () => 0x99).buffer },
        httpMetadata: { contentType: "video/mp4" },
        customMetadata: { dancePublicationInput: token, dancePublicationReview: id },
      };
      let writes = 0;
      const cleanup = makeModeratedDancePublicationCleanup({
        randomId: () => "physical-fence",
        call: async (_label, text, values) =>
          (await admin.query(text, [...values])).rows[0]?.packet,
        bucket: {
          head: async (key) => {
            expect(key).toBe(h.destination_key);
            return head;
          },
          put: async (key, value, options) => {
            expect(key).toBe(h.destination_key);
            expect(options.onlyIf).toEqual({ etagMatches: "independent-etag" });
            writes++;
            head = {
              version: "fence-v1",
              etag: "fence-etag",
              size: value.length,
              httpMetadata: options.httpMetadata,
              customMetadata: options.customMetadata,
            };
            return head;
          },
        },
      });
      await cleanup.run();
      expect(writes).toBe(1);
      const saved = (
        await admin.query(
          "SELECT observation FROM dance_moderated_publication_cleanup_v1 WHERE review_id=$1",
          [id],
        )
      ).rows[0]?.observation;
      expect(saved).toMatchObject({
        outcome: "fenced",
        key: h.destination_key,
        version: "fence-v1",
        etag: "fence-etag",
        fenceToken: "physical-fence",
      });
      const journal = await command(admin, id, "inspect");
      expect(journal).toMatchObject({
        state: "cleaned",
        body_plan: null,
        body_identity: null,
        source_identity: null,
      });
      expect(journal.deadline_at).toBe(h.deadline_at);
      await cleanup.run();
      expect(writes).toBe(1);
      expect(
        (
          await admin.query(
            "SELECT finish_moderated_dance_publication_cleanup_v1($1,'physical-fence',$2::jsonb) packet",
            [id, JSON.stringify(saved)],
          )
        ).rows[0]?.packet,
      ).toEqual({ status: "cleaned" });
      await expect(
        admin.query(
          "SELECT finish_moderated_dance_publication_cleanup_v1($1,'physical-fence',$2::jsonb)",
          [id, JSON.stringify({ ...saved, version: "changed" })],
        ),
      ).rejects.toMatchObject({ code: "DRV05" });
      await expect(
        admin.query("DELETE FROM dance_moderated_publication_cleanup_v1 WHERE review_id=$1", [id]),
      ).rejects.toMatchObject({ code: "DRV01" });
      await expect(
        admin.query(
          "UPDATE dance_moderated_publication_cleanup_v1 SET fence_token='replaced' WHERE review_id=$1",
          [id],
        ),
      ).rejects.toMatchObject({ code: "DRV01" });
      expect(
        (await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id]))
          .rows[0]?.state,
      ).toEqual(before);
      await expect(protocol(admin, id).adopt()).rejects.toMatchObject({ code: "DRV05" });
    }));
  test("cleanup wins permanently before a late observation or adoption and does not change the passed qualification", async () =>
    withFixture(async (_f, admin, r) => {
      const { h } = await stored(admin, r),
        id = r.capture.reviewId,
        p = protocol(admin, id);
      const before = (
        await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id])
      ).rows[0]?.state;
      expect(await p.abandon()).toMatchObject({ key: h.destination_key });
      await expect(p.adopt()).rejects.toMatchObject({ code: "DRV05" });
      await expect(
        admin.query(sql, [id, "cleaned", JSON.stringify({ token, keyFenced: false })]),
      ).rejects.toMatchObject({ code: "DRV05" });
      // SQL protocol fixture only; the composed storage consumer separately
      // proves a physical fence before supplying this private observation.
      expect(await command(admin, id, "cleaned", { keyFenced: true })).toEqual({
        status: "cleaned",
      });
      expect(await p.cleanup()).toEqual({ status: "cleaned" });
      expect((await command(admin, id, "inspect")).body_identity).toBeNull();
      expect(
        (await admin.query("SELECT state FROM dance_moderated_reviews_v1 WHERE review_id=$1", [id]))
          .rows[0]?.state,
      ).toEqual(before);
      expect(
        (await admin.query("SELECT count(*)::INTEGER n FROM media_post_submissions")).rows[0]?.n,
      ).toBe(0);
    }));
  test("adoption waits on the actual account fence and then refuses erasure", async () =>
    withFixture(async (f, admin, r) => {
      await stored(admin, r);
      const id = r.capture.reviewId,
        prepared = prepareDancePublicationInput(await command(admin, id, "packet"));
      const other = new Client({ connectionString: f.connection });
      await other.connect();
      const otherPid = (await other.query("SELECT pg_backend_pid() pid")).rows[0]?.pid;
      try {
        await admin.query("BEGIN");
        await admin.query(
          "UPDATE dance_review_account_fences_v1 SET erasing=TRUE,revision=revision+1 WHERE account_id=$1",
          [f.facts.accountId],
        );
        const pending = other
          .query(sql, [id, "adopt", JSON.stringify({ token, videoTrackEnabled: true, prepared })])
          .then(
            () => null,
            (error) => error,
          );
        // Observe the actual row-lock wait before committing invalidation.
        const until = Date.now() + 3000;
        let blocked = false;
        while (Date.now() < until) {
          blocked =
            (
              await admin.query("SELECT pg_backend_pid()=ANY(pg_blocking_pids($1)) blocked", [
                otherPid,
              ])
            ).rows[0]?.blocked === true;
          if (blocked) break;
          await Bun.sleep(5);
        }
        expect(blocked).toBe(true);
        await admin.query("COMMIT");
        expect(await pending).toMatchObject({ code: "DRV05" });
      } finally {
        await admin.query("ROLLBACK");
        await other.end();
      }
    }));
  test("a delayed adoption cannot extend the original transfer deadline", async () =>
    withFixture(async (f, admin, r) => {
      await stored(admin, r);
      const id = r.capture.reviewId,
        prepared = prepareDancePublicationInput(await command(admin, id, "packet"));
      const deadline = new Date(r.transferDeadlineMs ?? 0);
      const outcome = await runBlockedQuery(
        f.connection,
        admin,
        {
          text: "SELECT * FROM song_owner_policies WHERE post_id=$1 FOR UPDATE",
          values: [f.facts.songPostId],
        },
        {
          text: sql,
          values: [id, "adopt", JSON.stringify({ token, videoTrackEnabled: true, prepared })],
        },
        () => crossDeadline(admin, deadline),
      );
      expect("error" in outcome ? outcome.error : null).toMatchObject({ code: "DRV05" });
      expect(await protocol(admin, id).cleanup()).toMatchObject({ status: "cleanup" });
    }, 1500));
  test("the media role can adopt through its function but cannot read raw private state, call the helper or rewrite ordinary upload authority", async () =>
    withFixture(
      async (f, admin, r) => {
        await stored(admin, r);
        const id = r.capture.reviewId,
          role = `dance_input_${crypto.randomUUID().replaceAll("-", "")}`,
          password = crypto.randomUUID();
        await admin.query(
          `CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
        );
        const schema = (await admin.query("SELECT current_schema() s")).rows[0]?.s;
        let confined: Client | undefined;
        try {
          expect(
            (
              await admin.query(
                "SELECT proconfig FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname='grant_moderated_dance_runtime_v1'",
              )
            ).rows[0]?.proconfig,
          ).toContain(`search_path=${schema}, pg_catalog, pg_temp`);
          await admin.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
          await admin.query("SELECT grant_moderated_dance_runtime_v1($1,'media')", [role]);
          const target = new URL(f.connection);
          target.username = role;
          target.password = password;
          confined = new Client({ connectionString: target.toString() });
          await confined.connect();
          await expect(
            confined.query("SELECT * FROM dance_moderated_publication_inputs_v1"),
          ).rejects.toMatchObject({ code: "42501" });
          await expect(
            confined.query("SELECT * FROM dance_moderated_publication_cleanup_v1"),
          ).rejects.toMatchObject({ code: "42501" });
          expect(
            (
              await confined.query(
                "SELECT claim_moderated_dance_publication_cleanup_v1('confined') packet",
              )
            ).rows[0]?.packet,
          ).toBeNull();
          await expect(
            confined.query("SELECT moderated_dance_publication_song_v1('{}')"),
          ).rejects.toMatchObject({ code: "42501" });
          const p = protocol(confined, id);
          await p.adopt();
          expect(await p.cleanup()).toBeNull();
        } finally {
          await confined?.end();
          await admin.query(`DROP OWNED BY ${quote(role)}`);
          await admin.query(`DROP ROLE ${quote(role)}`);
        }
      },
      undefined,
      true,
    ));
});
