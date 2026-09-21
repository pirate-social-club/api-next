import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { AvatarFailure } from "@pirate/application/avatars/ports";
import { makeUnverifiedIdentityAccount } from "@pirate/application/use-cases/identity-registration";
import type { CommunityCreationDraftV2 } from "@pirate/contracts";
import { Effect } from "effect";
import { Client } from "pg";
import { applyPostgresTestBaselineConnection } from "../../../scripts/postgres-test-baseline.ts";
import { makeAvatarStore } from "./avatar-store.ts";
import { makeControlPlaneCommunityCreationStore } from "./community-creation-repository.ts";
import { makeControlPlaneCommunityStore } from "./community-repository.ts";
import { makeControlPlaneIdentityRepository } from "./identity-repository.ts";
import { makeControlPlanePersonaWalletStore } from "./persona-repository.ts";
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw new Error("Postgres test URL required");
const suite = url ? describe : describe.skip;
const actor = { userId: "avatar-owner", kind: "user" as const };
const image = { digest: "a".repeat(64), width: 512, height: 256, byteLength: 100 };
async function fixture(
  run: (context: {
    admin: Client;
    databaseUrl: string;
    runtime: ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
    avatars: ReturnType<typeof makeAvatarStore>;
    creation: ReturnType<typeof makeControlPlaneCommunityCreationStore>;
    draft: CommunityCreationDraftV2;
  }) => Promise<void>,
) {
  if (!url) throw new Error("Missing URL");
  const schema = `avatar_test_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query(`SET search_path TO ${schema}`);
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema}`);
  try {
    await applyPostgresTestBaselineConnection({ connectionString: scoped.toString() });
    await admin.query("INSERT INTO users(user_id,status,account) VALUES($1,'active',$2::jsonb)", [
      actor.userId,
      JSON.stringify(
        makeUnverifiedIdentityAccount({
          userId: actor.userId,
          credentialId: "avatar-credential",
          handleId: "avatar-handle",
          handleLabel: "avatar-owner.pirate",
          createdAt: "2026-08-19T00:00:00.000Z",
        }),
      ),
    ]);
    await admin.query(
      "INSERT INTO users(user_id,status,account) VALUES('another-account','active','{}')",
    );
    await activatePendingPersonaFixtures(admin);
    const persona = (
      await admin.query<{ persona_id: string }>(
        "SELECT persona_id FROM personas WHERE account_id=$1 AND is_first_persona",
        [actor.userId],
      )
    ).rows[0]?.persona_id;
    if (!persona) throw new Error("Missing persona");
    await admin.query(
      "UPDATE persona_profiles SET display_name='Owner',revision=revision+1 WHERE persona_id=$1",
      [persona],
    );
    const runtime = makeDirectPostgresControlPlaneLayer(scoped.toString());
    await run({
      admin,
      databaseUrl: scoped.toString(),
      runtime,
      avatars: makeAvatarStore(runtime),
      creation: makeControlPlaneCommunityCreationStore(runtime, {
        next_community_id: () => `community_${crypto.randomUUID()}`,
      }),
      draft: {
        persona: { kind: "existing", persona_id: persona },
        name: "Image community",
        description: null,
        policy: {
          version: 1,
          accessPaths: [
            {
              id: "verified-people",
              operator: "and",
              requirements: [{ requirement: "human-verification" }],
            },
          ],
        },
      },
    });
  } finally {
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
const reserve = (
  avatars: ReturnType<typeof makeAvatarStore>,
  purpose: "community" | "persona",
  owner = actor.userId,
  key: string = purpose,
) =>
  Effect.runPromise(
    avatars.reserve(owner, {
      idempotency_key: key,
      purpose,
      content_type: "image/png",
      byte_length: 100,
    }),
  );
const create = (
  creation: ReturnType<typeof makeControlPlaneCommunityCreationStore>,
  draft: CommunityCreationDraftV2,
  key = "create",
) =>
  Effect.runPromise(
    creation.create({
      actor,
      requestHash: (key === "create" ? "1" : "3").repeat(64),
      body: { idempotency_key: key, draft },
    }),
  );
const commit = (creation: ReturnType<typeof makeControlPlaneCommunityCreationStore>, id: string) =>
  Effect.runPromise(
    creation.commit({
      actor,
      intentId: id,
      requestHash: "2".repeat(64),
      body: { idempotency_key: "commit", expected_revision: 1 },
    }),
  );

suite("creation avatar lifecycle", () => {
  test("serializes account reservation limits across concurrent requests", async () =>
    fixture(async ({ avatars }) => {
      for (let index = 0; index < 19; index++)
        await reserve(avatars, "community", actor.userId, `quota-${index}`);
      const results = await Promise.all(
        ["quota-a", "quota-b"].map((key) =>
          Effect.runPromise(
            avatars
              .reserve(actor.userId, {
                idempotency_key: key,
                purpose: "community",
                content_type: "image/png",
                byte_length: 100,
              })
              .pipe(
                Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "reserved" }),
              ),
          ),
        ),
      );
      expect(results.sort()).toEqual(["rate-limited", "reserved"]);
    }));
  test("cleanup skips in-flight finalization and retries its expired orphan", async () =>
    fixture(async ({ admin, avatars }) => {
      const asset = await reserve(avatars, "community");
      await admin.query(
        "UPDATE avatar_assets SET expires_at=clock_timestamp()+interval '1 second',next_cleanup_at=clock_timestamp() WHERE asset_id=$1",
        [asset.assetId],
      );
      let release = () => {};
      let signal = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const finishing = Effect.runPromise(
        avatars
          .finalize(actor.userId, asset.assetId, () =>
            Effect.promise(async () => {
              signal();
              await gate;
              return image;
            }),
          )
          .pipe(Effect.match({ onSuccess: () => "ready", onFailure: (error) => error.reason })),
      );
      await started;
      try {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const removed: string[] = [];
        expect(
          await Effect.runPromise(
            avatars.cleanup((key) =>
              Effect.sync(() => {
                removed.push(key);
              }),
            ),
          ).then((count) => ({ count, removed })),
        ).toEqual({ count: { removed: 0, failed: 0 }, removed: [] });
      } finally {
        release();
      }
      expect(await finishing).toBe("conflict");
      expect(await Effect.runPromise(avatars.cleanup(() => Effect.void))).toEqual({
        removed: 1,
        failed: 0,
      });
      expect((await admin.query("SELECT state FROM avatar_assets")).rows[0]?.state).toBe("removed");
    }));

  test("a new persona receives its image only after wallet activation", async () =>
    fixture(async ({ admin, runtime, avatars, creation, draft }) => {
      const asset = await reserve(avatars, "persona");
      await Effect.runPromise(
        avatars.finalize(actor.userId, asset.assetId, () => Effect.succeed(image)),
      );
      const intent = await create(creation, {
        ...draft,
        persona: { kind: "create_new" },
        public_name: "Community owner",
        persona_avatar_ref: asset.assetId,
      });
      const pending = await commit(creation, intent.document.intent_id);
      expect(pending.document.status).toBe("commit_ready");
      expect((await admin.query("SELECT state FROM avatar_assets")).rows[0]?.state).toBe("ready");
      const reservation = (
        await admin.query<{ persona_id: string; hd_wallet_index: string }>(
          "SELECT p.persona_id, w.hd_wallet_index FROM personas p JOIN persona_wallet_assignments w USING(persona_id) WHERE p.account_id=$1 AND p.status='pending_wallet'",
          [actor.userId],
        )
      ).rows[0];
      if (!reservation) throw new Error("Missing pending owner wallet");
      await Effect.runPromise(
        makeControlPlanePersonaWalletStore(runtime).confirmEvm({
          accountId: actor.userId,
          personaId: reservation.persona_id,
          attestation: {
            sourceUserId: "avatar-wallet-source",
            privyWalletId: "avatar-wallet",
            hdWalletIndex: Number(reservation.hd_wallet_index),
            address: "0x5555555555555555555555555555555555555555",
          },
        }),
      );
      const committed = await Effect.runPromise(
        creation.commit({
          actor,
          intentId: intent.document.intent_id,
          requestHash: "4".repeat(64),
          body: { idempotency_key: "terminal", expected_revision: pending.document.revision },
        }),
      );
      expect(committed.document).toMatchObject({
        status: "committed",
        avatar_outcomes: { persona: "attached" },
        persona_role_presentation: { persona: { avatar_ref: `/api/avatars/${asset.assetId}` } },
      });
    }));
  test("identity sync preserves accepted image and preview exposes its controlled URL", async () =>
    fixture(async ({ runtime, avatars, creation, draft }) => {
      const community = await reserve(avatars, "community"),
        persona = await reserve(avatars, "persona");
      for (const asset of [community, persona])
        await Effect.runPromise(
          avatars.finalize(actor.userId, asset.assetId, () => Effect.succeed(image)),
        );
      const intent = await create(creation, {
        ...draft,
        community_avatar_ref: community.assetId,
        persona_avatar_ref: persona.assetId,
      });
      const result = await commit(creation, intent.document.intent_id);
      const account = makeUnverifiedIdentityAccount({
        userId: actor.userId,
        credentialId: "avatar-credential",
        handleId: "avatar-handle",
        handleLabel: "avatar-owner.pirate",
        createdAt: "2026-08-19T00:00:00.000Z",
      });
      await Effect.runPromise(
        makeControlPlaneIdentityRepository()
          .upsertAccount({ userId: actor.userId, account })
          .pipe(Effect.provide(runtime)),
      );
      const current = await Effect.runPromise(
        creation.get({ actor, intentId: intent.document.intent_id }),
      );
      expect(current).toMatchObject({
        persona_role_presentation: { persona: { avatar_ref: `/api/avatars/${persona.assetId}` } },
      });
      const preview = await Effect.runPromise(
        makeControlPlaneCommunityStore(runtime).getPreview({
          communityId: result.document.committed_resource?.community_id ?? "",
        }),
      );
      expect(preview).toMatchObject({ avatar_ref: `/api/avatars/${community.assetId}` });
    }));

  test("attaches both owned sealed images and freezes replay", async () =>
    fixture(async ({ admin, avatars, creation, draft }) => {
      const community = await reserve(avatars, "community"),
        persona = await reserve(avatars, "persona");
      for (const asset of [community, persona])
        await Effect.runPromise(
          avatars.finalize(actor.userId, asset.assetId, () => Effect.succeed(image)),
        );
      const intent = await create(creation, {
        ...draft,
        community_avatar_ref: community.assetId,
        persona_avatar_ref: persona.assetId,
      });
      const result = await commit(creation, intent.document.intent_id);
      expect(result.document).toMatchObject({
        status: "committed",
        avatar_outcomes: { community: "attached", persona: "attached" },
      });
      expect((await commit(creation, intent.document.intent_id)).document).toEqual(result.document);
      expect(
        (
          await admin.query("SELECT avatar_ref FROM communities WHERE community_id=$1", [
            result.document.committed_resource?.community_id,
          ])
        ).rows[0]?.avatar_ref,
      ).toBe(`/api/avatars/${community.assetId}`);
      expect(
        (
          await admin.query("SELECT avatar_ref FROM persona_profiles WHERE persona_id=$1", [
            draft.persona.kind === "existing" ? draft.persona.persona_id : "",
          ])
        ).rows[0]?.avatar_ref,
      ).toBe(`/api/avatars/${persona.assetId}`);
      expect((await Effect.runPromise(avatars.delivery(community.assetId))).digest).toBe(
        image.digest,
      );
      await Effect.runPromise(
        avatars.finalize(actor.userId, community.assetId, () => Effect.die("Must not reseal")),
      );
    }));
  test("foreign, wrong-purpose and unfinished references never block creation", async () =>
    fixture(async ({ avatars, creation, draft }) => {
      const foreign = await reserve(avatars, "community", "another-account"),
        wrong = await reserve(avatars, "community");
      for (const asset of [foreign, wrong])
        await Effect.runPromise(
          avatars.finalize(asset.ownerId, asset.assetId, () => Effect.succeed(image)),
        );
      const intent = await create(creation, {
        ...draft,
        community_avatar_ref: foreign.assetId,
        persona_avatar_ref: wrong.assetId,
      });
      expect((await commit(creation, intent.document.intent_id)).document).toMatchObject({
        status: "committed",
        avatar_outcomes: { community: "omitted_unavailable", persona: "omitted_unavailable" },
      });
    }));
  test("late finalize cannot alter a committed intent and existing persona image stays", async () =>
    fixture(async ({ admin, avatars, creation, draft }) => {
      await admin.query(
        "UPDATE persona_profiles SET avatar_ref='https://images.invalid/existing.jpg',revision=revision+1",
      );
      const community = await reserve(avatars, "community"),
        persona = await reserve(avatars, "persona");
      await Effect.runPromise(
        avatars.finalize(actor.userId, persona.assetId, () => Effect.succeed(image)),
      );
      const intent = await create(creation, {
        ...draft,
        community_avatar_ref: community.assetId,
        persona_avatar_ref: persona.assetId,
      });
      const result = await commit(creation, intent.document.intent_id);
      expect(result.document).toMatchObject({
        avatar_outcomes: { community: "omitted_unavailable", persona: "preserved_existing" },
      });
      await Effect.runPromise(
        avatars.finalize(actor.userId, community.assetId, () => Effect.succeed(image)),
      );
      expect((await commit(creation, intent.document.intent_id)).document).toEqual(result.document);
      expect(
        await Effect.runPromise(avatars.delivery(community.assetId).pipe(Effect.flip)),
      ).toMatchObject({ reason: "not-found" });
    }));
  test("binds to the first intent and rejects ownership and reservation replay conflicts", async () =>
    fixture(async ({ avatars, creation, draft }) => {
      const asset = await reserve(avatars, "community");
      expect((await reserve(avatars, "community")).assetId).toBe(asset.assetId);
      expect(
        await Effect.runPromise(
          avatars
            .finalize("another-account", asset.assetId, () => Effect.succeed(image))
            .pipe(Effect.flip),
        ),
      ).toMatchObject({ reason: "not-found" });
      await Effect.runPromise(
        avatars.finalize(actor.userId, asset.assetId, () => Effect.succeed(image)),
      );
      await create(creation, { ...draft, community_avatar_ref: asset.assetId });
      const second = await create(
        creation,
        { ...draft, community_avatar_ref: asset.assetId },
        "second",
      );
      expect((await commit(creation, second.document.intent_id)).document).toMatchObject({
        avatar_outcomes: { community: "omitted_unavailable" },
      });
    }));
  test("cleanup retries failures, preserves attached masters and revokes delivery", async () =>
    fixture(async ({ admin, databaseUrl, avatars, creation, draft }) => {
      const asset = await reserve(avatars, "community");
      await Effect.runPromise(
        avatars.finalize(actor.userId, asset.assetId, () => Effect.succeed(image)),
      );
      const intent = await create(creation, { ...draft, community_avatar_ref: asset.assetId });
      await commit(creation, intent.document.intent_id);
      await admin.query(
        "UPDATE avatar_assets SET next_cleanup_at=clock_timestamp()-interval '1 second'",
      );
      const deleted: string[] = [];
      await Effect.runPromise(
        avatars.cleanup((key) =>
          Effect.sync(() => {
            deleted.push(key);
          }),
        ),
      );
      expect(deleted).toEqual([asset.ingressKey]);
      const removeArgs = [
        "scripts/remove-avatar.ts",
        "--database-url-env",
        "AVATAR_TEST_OPERATOR_DATABASE",
        "--asset-id",
        asset.assetId,
      ];
      const runRemoval = (apply: boolean) =>
        spawnSync("bun", [...removeArgs, ...(apply ? ["--apply"] : [])], {
          env: { ...process.env, AVATAR_TEST_OPERATOR_DATABASE: databaseUrl },
          encoding: "utf8",
          timeout: 10000,
        });
      const preview = runRemoval(false);
      expect(preview.status).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        apply: false,
        asset: { state: "attached" },
      });
      expect(await Effect.runPromise(avatars.delivery(asset.assetId))).toMatchObject({
        digest: image.digest,
      });
      const removed = runRemoval(true);
      expect(removed.status).toBe(0);
      expect(JSON.parse(removed.stdout)).toMatchObject({
        asset_id: asset.assetId,
        delivery_revoked: true,
      });
      expect(
        await Effect.runPromise(avatars.delivery(asset.assetId).pipe(Effect.flip)),
      ).toMatchObject({ reason: "not-found" });
      await admin.query(
        "UPDATE avatar_assets SET next_cleanup_at=clock_timestamp()-interval '1 second'",
      );
      await Effect.runPromise(
        avatars.cleanup(() => Effect.fail(new AvatarFailure({ reason: "unavailable" }))),
      );
      expect((await admin.query("SELECT state FROM avatar_assets")).rows[0]?.state).toBe(
        "deleting",
      );
      await admin.query(
        "UPDATE avatar_assets SET next_cleanup_at=clock_timestamp()-interval '1 second'",
      );
      await Effect.runPromise(avatars.cleanup(() => Effect.void));
      expect((await admin.query("SELECT state FROM avatar_assets")).rows[0]?.state).toBe("removed");
    }));
});
