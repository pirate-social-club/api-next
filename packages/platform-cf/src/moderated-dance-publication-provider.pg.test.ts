import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { Client } from "pg";
import { createReusablePostgresTestSchemaOwner } from "../../../scripts/postgres-test-baseline.ts";
import { crossDeadline, runBlockedQuery } from "./moderated-dance-authority.pg-fixture.ts";
import { makePublicationInputFixture } from "./moderated-dance-publication-input.pg-fixture.ts";

const suite = process.env.CONTROL_PLANE_POSTGRES_TEST_URL === undefined ? describe.skip : describe;
const reusableSchema = createReusablePostgresTestSchemaOwner(),
  withFixture = makePublicationInputFixture(reusableSchema);
setDefaultTimeout(30_000);
afterAll(async () => {
  await reusableSchema.dispose();
});
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const claim = async (admin: Client, token = "observer", video = true) =>
  (
    await admin.query("SELECT claim_moderated_dance_publication_v1($1,'test-media',$2) packet", [
      token,
      video,
    ])
  ).rows[0]?.packet;
type Work = {
  reviewId: string;
  inputToken: string;
  leaseToken: string;
  tag: string;
  deadlineMs: number;
  action: string;
};
const action = async (admin: Client, w: Work, kind: string, fields: Record<string, unknown> = {}) =>
  (
    await admin.query("SELECT moderated_dance_publication_provider_v1($1,$2,$3::jsonb) packet", [
      w.reviewId,
      kind,
      JSON.stringify({
        ...fields,
        inputToken: w.inputToken,
        leaseToken: w.leaseToken,
        videoTrackEnabled: true,
      }),
    ])
  ).rows[0]?.packet;
const digest = "d".repeat(64);
async function sourceAndCreate(admin: Client, w: Work) {
  await action(admin, w, "source", { capabilitySha256: digest });
  return action(admin, w, "create", { capabilitySha256: digest });
}
const resolve = async (admin: Client) =>
  (await admin.query("SELECT * FROM resolve_moderated_dance_publication_source_v1($1)", [digest]))
    .rows;

suite("native original Dance Post provider and source authority", () => {
  test("one committed create reserves its own spend and liability; unknown retry never restores either grant", async () =>
    withFixture(
      async (f, admin, r) => {
        expect(await claim(admin, "off", false)).toBeNull();
        const w = await claim(admin);
        expect(w).toMatchObject({
          reviewId: r.capture.reviewId,
          inputToken: "observer",
          action: "create",
          jobId: null,
        });
        expect(await claim(admin, "concurrent")).toBeNull();
        await action(admin, w, "source", { capabilitySha256: digest });
        expect(await resolve(admin)).toEqual([]);
        const before = (
          await admin.query(
            "SELECT coalesce(sum(charged_microunits),0)::TEXT amount FROM dance_moderated_provider_usage_v1",
          )
        ).rows[0]?.amount;
        expect(await action(admin, w, "create", { capabilitySha256: digest })).toMatchObject({
          status: "create",
          tag: w.tag,
        });
        const after = (
          await admin.query(
            "SELECT coalesce(sum(charged_microunits),0)::TEXT amount FROM dance_moderated_provider_usage_v1",
          )
        ).rows[0]?.amount;
        expect(BigInt(after) - BigInt(before)).toBe(
          2n * BigInt(f.facts.profile.maximumProviderSpendMicrounits),
        );
        const effect = (
          await admin.query(
            "SELECT provider_tag,provider_job_id,work_deadline FROM dance_moderated_provider_effects_v1 WHERE purpose='publication'",
          )
        ).rows;
        expect(effect).toHaveLength(1);
        expect(effect[0]?.provider_tag).toBe(w.tag);
        expect(effect[0]?.provider_job_id).toBeNull();
        expect(effect[0]?.work_deadline.getTime()).toBe(r.transferDeadlineMs);
        expect((await resolve(admin))[0]).toMatchObject({
          physical_key: `moderated-dance/originals/${r.capture.uploadId}/source`,
          canonical_sha256: r.capture.sourceDigest,
          identity_kind: "upload_version",
        });
        expect(await action(admin, w, "create", { capabilitySha256: digest })).toEqual({
          status: "unknown",
        });
        expect(
          (
            await admin.query(
              "SELECT coalesce(sum(charged_microunits),0)::TEXT amount FROM dance_moderated_provider_usage_v1",
            )
          ).rows[0]?.amount,
        ).toBe(after);
        await action(admin, w, "release");
        const recovery = await claim(admin, "recovery");
        expect(recovery).toMatchObject({
          inputToken: "observer",
          action: "observe",
          tag: w.tag,
          jobId: null,
        });
        expect(
          await action(admin, recovery, "source", { capabilitySha256: "e".repeat(64) }),
        ).toBeNull();
        expect(await action(admin, recovery, "create", { capabilitySha256: digest })).toEqual({
          status: "unknown",
        });
        expect(
          (
            await admin.query(
              "SELECT count(*)::INTEGER n FROM dance_moderated_publication_sources_v1",
            )
          ).rows[0]?.n,
        ).toBe(1);
      },
      undefined,
      false,
      7,
    ));
  test("old six-purpose profiles and missing observer tokens cannot acquire a new provider effect", async () =>
    withFixture(async (_f, admin, r) => {
      expect(await claim(admin)).toBeNull();
      const input = (
        await admin.query(
          "SELECT token FROM dance_moderated_publication_inputs_v1 WHERE review_id=$1",
          [r.capture.reviewId],
        )
      ).rows[0];
      await expect(
        admin.query("SELECT moderated_dance_publication_provider_v1($1,'source',$2::jsonb)", [
          r.capture.reviewId,
          JSON.stringify({
            inputToken: input?.token,
            videoTrackEnabled: true,
            capabilitySha256: digest,
          }),
        ]),
      ).rejects.toMatchObject({ code: "DRV05" });
      expect(
        (
          await admin.query(
            "SELECT count(*)::INTEGER n FROM dance_moderated_provider_effects_v1 WHERE purpose='publication'",
          )
        ).rows[0]?.n,
      ).toBe(0);
    }));
  test("a rolled-back create grant can be claimed; a committed grant survives observer loss without another create", async () =>
    withFixture(
      async (_f, admin) => {
        const w = await claim(admin);
        await action(admin, w, "source", { capabilitySha256: digest });
        await admin.query("BEGIN");
        expect((await action(admin, w, "create", { capabilitySha256: digest })).status).toBe(
          "create",
        );
        await admin.query("ROLLBACK");
        expect((await action(admin, w, "create", { capabilitySha256: digest })).status).toBe(
          "create",
        );
        expect((await action(admin, w, "create", { capabilitySha256: digest })).status).toBe(
          "unknown",
        );
        await action(admin, w, "identify", { jobId: "original-job", tag: w.tag });
        await expect(
          action(admin, w, "identify", { jobId: "replacement-job", tag: w.tag }),
        ).rejects.toMatchObject({ code: "DRV05" });
      },
      undefined,
      false,
      7,
    ));
  test("erasure revokes the source but a late original job identity remains cleanup knowledge", async () =>
    withFixture(
      async (f, admin) => {
        const w = await claim(admin);
        await sourceAndCreate(admin, w);
        expect(await resolve(admin)).toHaveLength(1);
        await admin.query("SELECT begin_moderated_dance_account_erasure_v1($1)", [
          f.facts.accountId,
        ]);
        expect(await resolve(admin)).toEqual([]);
        await action(admin, w, "identify", { jobId: "late-original", tag: w.tag });
        expect(
          (
            await admin.query(
              "SELECT provider_job_id FROM dance_moderated_provider_effects_v1 WHERE purpose='publication'",
            )
          ).rows[0]?.provider_job_id,
        ).toBe("late-original");
        await expect(action(admin, w, "observe")).rejects.toMatchObject({ code: "DRV05" });
        expect(await claim(admin, "after-erasure")).toBeNull();
      },
      undefined,
      false,
      7,
    ));
  test("screened capture and terminal session do not erase a live publication job; cancellation makes that same job disposable", async () =>
    withFixture(
      async (_f, admin) => {
        const w = await claim(admin);
        await sourceAndCreate(admin, w);
        await action(admin, w, "identify", { jobId: "new-body-job", tag: w.tag });
        for (let n = 0; n < 4; n++) {
          const item = (
            await admin.query("SELECT claim_moderated_dance_provider_cleanup_v1($1) packet", [
              `old-cleanup-${n}`,
            ])
          ).rows[0]?.packet;
          if (item !== null) expect(String(item.effectId).endsWith(":publication")).toBe(false);
        }
        expect(
          (
            await admin.query(
              "SELECT state,claim_token FROM dance_moderated_provider_effects_v1 WHERE purpose='publication'",
            )
          ).rows[0],
        ).toEqual({ state: "registered", claim_token: null });
        await admin.query("SELECT moderated_dance_publication_input_v1($1,'abandon',$2::jsonb)", [
          w.reviewId,
          JSON.stringify({ token: w.inputToken }),
        ]);
        const item = (
          await admin.query(
            "SELECT claim_moderated_dance_provider_cleanup_v1('body-cleanup') packet",
          )
        ).rows[0]?.packet;
        expect(item).toMatchObject({ provider: "cloudconvert", jobId: "new-body-job", tag: w.tag });
      },
      undefined,
      false,
      7,
    ));
  test("a real provider-budget lock wait cannot spend or dispatch past the original handoff deadline", async () =>
    withFixture(
      async (f, admin, r) => {
        const w = await claim(admin);
        await action(admin, w, "source", { capabilitySha256: digest });
        const before = (
          await admin.query(
            "SELECT coalesce(sum(charged_microunits),0)::TEXT n FROM dance_moderated_provider_usage_v1",
          )
        ).rows[0]?.n;
        const result = await runBlockedQuery(
          f.connection,
          admin,
          { text: "LOCK TABLE dance_moderated_provider_usage_v1 IN EXCLUSIVE MODE", values: [] },
          {
            text: "SELECT moderated_dance_publication_provider_v1($1,'create',$2::jsonb)",
            values: [
              w.reviewId,
              JSON.stringify({
                inputToken: w.inputToken,
                leaseToken: w.leaseToken,
                videoTrackEnabled: true,
                capabilitySha256: digest,
              }),
            ],
          },
          () => crossDeadline(admin, new Date(r.transferDeadlineMs ?? 0)),
        );
        expect("error" in result ? result.error : null).toMatchObject({ code: "DRV05" });
        expect(
          (
            await admin.query(
              "SELECT create_consumed FROM dance_moderated_publication_jobs_v1 WHERE review_id=$1",
              [w.reviewId],
            )
          ).rows[0]?.create_consumed,
        ).toBe(false);
        expect(
          (
            await admin.query(
              "SELECT coalesce(sum(charged_microunits),0)::TEXT n FROM dance_moderated_provider_usage_v1",
            )
          ).rows[0]?.n,
        ).toBe(before);
        expect(await resolve(admin)).toEqual([]);
      },
      1800,
      false,
      7,
    ));
  test("a PUT grant delayed by current song rights cannot cross the original transfer deadline", async () =>
    withFixture(
      async (f, admin, r) => {
        const w = await claim(admin),
          c = r.capture;
        await admin.query("SELECT moderated_dance_publication_input_v1($1,'plan',$2::jsonb)", [
          w.reviewId,
          JSON.stringify({
            token: w.inputToken,
            videoTrackEnabled: true,
            body: {
              key: `immutable/dance-post-operation:${w.reviewId}/video/1`,
              sha256: "9".repeat(64),
              size: 1000,
              sourceSha256: c.sourceDigest,
              bodyStartMs: c.bodyStartMs,
              bodyEndMs: c.bodyEndMs,
              durationMs: c.bodyEndMs - c.bodyStartMs,
              transformRevision: "dance-publication-body-v1",
            },
          }),
        ]);
        const result = await runBlockedQuery(
          f.connection,
          admin,
          {
            text: "SELECT * FROM song_owner_policies WHERE post_id=$1 FOR UPDATE",
            values: [f.facts.songPostId],
          },
          {
            text: "SELECT moderated_dance_publication_input_v1($1,'put',$2::jsonb)",
            values: [w.reviewId, JSON.stringify({ token: w.inputToken, videoTrackEnabled: true })],
          },
          () => crossDeadline(admin, new Date(r.transferDeadlineMs ?? 0)),
        );
        expect("error" in result ? result.error : null).toMatchObject({ code: "DRV05" });
        expect(
          (
            await admin.query(
              "SELECT put_consumed FROM dance_moderated_publication_inputs_v1 WHERE review_id=$1",
              [w.reviewId],
            )
          ).rows[0]?.put_consumed,
        ).toBe(false);
      },
      1800,
      false,
      7,
    ));
  test("migrated confined media and gateway LOGINs receive only their exact functions", async () =>
    withFixture(
      async (f, admin) => {
        const suffix = crypto.randomUUID().replaceAll("-", ""),
          media = `publication_media_${suffix}`,
          gateway = `publication_gateway_${suffix}`,
          password = crypto.randomUUID();
        const schema = (await admin.query("SELECT current_schema() s")).rows[0]?.s;
        const clients: Client[] = [];
        try {
          for (const [role, purpose] of [
            [media, "media"],
            [gateway, "source_gateway"],
          ] as const) {
            await admin.query(
              `CREATE ROLE ${quote(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB NOREPLICATION`,
            );
            await admin.query(`GRANT USAGE ON SCHEMA ${quote(schema)} TO ${quote(role)}`);
            await admin.query("SELECT grant_moderated_dance_runtime_v1($1,$2)", [role, purpose]);
            const url = new URL(f.connection);
            url.username = role;
            url.password = password;
            const client = new Client({ connectionString: url.toString() });
            await client.connect();
            clients.push(client);
            for (const table of [
              "dance_moderated_publication_jobs_v1",
              "dance_moderated_publication_sources_v1",
            ])
              await expect(client.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({
                code: "42501",
              });
          }
          const confined = clients[0],
            source = clients[1];
          if (confined === undefined || source === undefined)
            throw new Error("Confined clients missing");
          const w = await claim(confined);
          await sourceAndCreate(confined, w);
          expect(await resolve(source)).toHaveLength(1);
          await expect(claim(source, "forbidden")).rejects.toMatchObject({ code: "42501" });
          await expect(resolve(confined)).rejects.toMatchObject({ code: "42501" });
          for (const row of (
            await admin.query(
              "SELECT proconfig FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname=ANY($1::TEXT[])",
              [
                [
                  "grant_moderated_dance_runtime_v1",
                  "claim_moderated_dance_publication_v1",
                  "moderated_dance_publication_provider_v1",
                  "resolve_moderated_dance_publication_source_v1",
                  "claim_moderated_dance_provider_cleanup_v1",
                ],
              ],
            )
          ).rows)
            expect(row.proconfig).toContain(`search_path=${schema}, pg_catalog, pg_temp`);
        } finally {
          for (const client of clients) await client.end();
          for (const role of [media, gateway]) {
            await admin.query(`DROP OWNED BY ${quote(role)}`);
            await admin.query(`DROP ROLE IF EXISTS ${quote(role)}`);
          }
        }
      },
      undefined,
      true,
      7,
    ));
});
