import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import type { Client } from "pg";
import { withReusablePostgresTestSchema } from "../../../scripts/postgres-test-baseline.ts";
import { makeControlPlaneCommunityCreationStore } from "./community-creation-repository.ts";
import {
  makeControlPlanePersonaStore,
  makeControlPlanePersonaWalletStore,
} from "./persona-repository.ts";
import {
  activatePendingPersonaFixtures,
  createActivePersonaFixture,
} from "./persona-wallet.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";

const connection = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const suite = connection ? describe : describe.skip;
const account = "owner-setup-account";
const actor = { userId: account, kind: "user" as const };
const policy = {
  version: 1 as const,
  accessPaths: [
    {
      id: "human",
      operator: "and" as const,
      requirements: [{ requirement: "human-verification" as const }],
    },
  ] as const,
};

async function scenario(use: (h: ReturnType<typeof harness>, admin: Client) => Promise<void>) {
  if (!connection) throw new Error("PostgreSQL test URL required");
  await withReusablePostgresTestSchema({
    baseConnectionString: connection,
    schemaName: "community_owner_reservation_pg_test",
    use: async ({ admin, schema }) => {
      await admin.query(`SET search_path TO "${schema}"`);
      await admin.query("INSERT INTO users(user_id,status,account) VALUES($1,'active','{}')", [
        account,
      ]);
      await activatePendingPersonaFixtures(admin);
      await admin.query(
        "UPDATE persona_profiles SET display_name='Original profile',revision=revision+1",
      );
      const url = new URL(connection);
      url.searchParams.set("options", `-c search_path=${schema}`);
      await use(harness(url.toString()), admin);
    },
  });
}
function harness(url: string) {
  const layer = makeDirectPostgresControlPlaneLayer(url);
  const store = makeControlPlaneCommunityCreationStore(layer);
  const wallets = makeControlPlanePersonaWalletStore(layer);
  const personas = makeControlPlanePersonaStore(layer);
  const create = async (name: string) =>
    (
      await Effect.runPromise(
        store.create({
          actor,
          requestHash: "a".repeat(64),
          body: {
            idempotency_key: crypto.randomUUID(),
            draft: {
              persona: { kind: "create_new" },
              public_name: name,
              name: "Community",
              description: null,
              policy,
            },
          },
        }),
      )
    ).document;
  const commit = (intent: { intent_id: string; revision: number }, key = crypto.randomUUID()) =>
    Effect.runPromise(
      store.commit({
        actor,
        intentId: intent.intent_id,
        requestHash: "b".repeat(64),
        body: { expected_revision: intent.revision, idempotency_key: key },
      }),
    );
  const activate = async (personaId: string) => {
    const preparation = await Effect.runPromise(
      wallets.getEvmPreparation({ accountId: account, personaId }),
    );
    if (!preparation) throw new Error("missing wallet preparation");
    return Effect.runPromise(
      wallets.confirmEvm({
        accountId: account,
        personaId,
        attestation: {
          sourceUserId: account,
          privyWalletId: `fixture-${personaId}`,
          hdWalletIndex: preparation.hd_wallet_index,
          address: `0x${(preparation.hd_wallet_index + 1).toString(16).padStart(40, "0")}`,
        },
      }),
    );
  };
  return { store, wallets, personas, create, commit, activate };
}

suite("community owner reservation and recovery", () => {
  test("publishes once and leaves the exact wallet reservation pending", async () => {
    await scenario(async (h, admin) => {
      const intent = await h.create("River Room");
      const key = crypto.randomUUID();
      const [left, right] = await Promise.all([h.commit(intent, key), h.commit(intent, key)]);
      expect(left.document).toEqual(right.document);
      expect(left.document.status).toBe("committed");
      if (!("creation_contract_version" in left.document)) throw new Error("wrong contract");
      const personaId = left.document.persona_role_presentation?.persona.persona_id;
      if (personaId === undefined) throw new Error("expected published owner");
      expect(left.document.next_action).toEqual({ kind: "none", reason: "committed" });
      expect(await Effect.runPromise(h.personas.listPendingWallets("foreign-account"))).toEqual([]);
      expect(await Effect.runPromise(h.personas.listPendingWallets(account))).toEqual([]);
      const preparation = await Effect.runPromise(
        h.wallets.getEvmPreparation({ accountId: account, personaId }),
      );
      expect(preparation).toMatchObject({ persona_id: personaId, status: "pending" });
      expect(
        (await admin.query("SELECT public_persona_projection($1) AS profile", [personaId])).rows[0]
          .profile,
      ).toMatchObject({ persona_id: personaId, display_name: "River Room" });
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM communities WHERE created_by_user_id=$1",
            [account],
          )
        ).rows[0].n,
      ).toBe(1);
      await h.activate(personaId);
      expect(
        (
          await admin.query("SELECT status FROM persona_wallet_assignments WHERE persona_id=$1", [
            personaId,
          ])
        ).rows,
      ).toEqual([{ status: "active" }]);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM communities WHERE created_by_user_id=$1",
            [account],
          )
        ).rows[0].n,
      ).toBe(1);
    });
  }, 30_000);

  test("an account with its only profile already bound can finish a named new owner", async () => {
    await scenario(async (h, admin) => {
      const first = (await Effect.runPromise(h.personas.listByAccount(account)))[0];
      if (!first) throw new Error("Expected the account's first profile");
      const existing = await Effect.runPromise(
        h.store.create({
          actor,
          requestHash: "c".repeat(64),
          body: {
            idempotency_key: "existing-owner",
            draft: {
              persona: { kind: "existing", persona_id: first.persona_id },
              name: "First place",
              description: null,
              policy,
            },
          },
        }),
      );
      expect((await h.commit(existing.document)).document.status).toBe("committed");
      const complete = await h.commit(await h.create("River Room"));
      expect(complete.document.status).toBe("committed");
      if (!("creation_contract_version" in complete.document)) throw new Error("wrong contract");
      const personaId = complete.document.persona_role_presentation?.persona.persona_id;
      if (personaId === undefined) throw new Error("Expected published owner");
      expect(personaId).not.toBe(first.persona_id);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM communities WHERE created_by_user_id=$1",
            [account],
          )
        ).rows[0].n,
      ).toBe(2);
      const visible = await Effect.runPromise(h.personas.listByAccount(account));
      expect(
        visible.find((persona) => persona.persona_id === personaId)?.profile.display_name,
      ).toBe("River Room");
      expect(
        visible.find((persona) => persona.persona_id === personaId)?.community_binding,
      ).not.toBeNull();
    });
  }, 30_000);

  test("publishes a saved pre-amendment pending owner without replacing its wallet index", async () => {
    await scenario(async (h, admin) => {
      const intent = await h.create("Recovered draft");
      const personaId = "saved-pending-owner";
      await admin.query("BEGIN");
      await admin.query(
        "INSERT INTO personas(persona_id,account_id,status,is_first_persona,created_at) VALUES($1,$2,'pending_wallet',false,clock_timestamp())",
        [personaId, account],
      );
      await admin.query(
        "INSERT INTO persona_pending_profiles(persona_id,display_name,created_at) VALUES($1,'Recovered draft',clock_timestamp())",
        [personaId],
      );
      await admin.query(
        `INSERT INTO persona_wallet_assignments(
           assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,status,
           reservation_idempotency_key,created_at,updated_at
         ) VALUES('saved-pending-wallet',$1,$2,'evm',1,'pending','saved-pending',clock_timestamp(),clock_timestamp())`,
        [personaId, account],
      );
      await admin.query(
        `WITH advanced AS (
           UPDATE community_creation_intents
              SET minted_persona_id=$1,revision=revision+1,updated_at=clock_timestamp()
            WHERE intent_id=$2 AND actor_id=$3
            RETURNING intent_id,actor_id,revision,status
         ) INSERT INTO community_creation_intent_revisions (
           intent_id,revision,actor_id,operation_kind,idempotency_key,request_hash,status,state_snapshot
         ) SELECT advanced.intent_id,advanced.revision,advanced.actor_id,'commit','saved-reserve',repeat('d',64),advanced.status,
                  prior.state_snapshot || jsonb_build_object(
                    'revision',advanced.revision,
                    'next_action',jsonb_build_object('kind','activate_profile','persona_id',$1)
                  )
             FROM advanced JOIN LATERAL (
               SELECT state_snapshot FROM community_creation_intent_revisions
                WHERE intent_id=advanced.intent_id ORDER BY revision DESC LIMIT 1
             ) AS prior ON true`,
        [personaId, intent.intent_id, account],
      );
      await admin.query("COMMIT");
      const before = await Effect.runPromise(
        h.wallets.getEvmPreparation({ accountId: account, personaId }),
      );
      const complete = await h.commit({ ...intent, revision: intent.revision + 1 });
      expect(complete.document.status).toBe("committed");
      if (!("creation_contract_version" in complete.document)) throw new Error("wrong contract");
      expect(complete.document.persona_role_presentation?.persona).toMatchObject({
        persona_id: personaId,
        display_name: "Recovered draft",
      });
      expect(
        await Effect.runPromise(h.wallets.getEvmPreparation({ accountId: account, personaId })),
      ).toEqual(before);
      expect(
        (
          await admin.query(
            "SELECT status,(SELECT count(*)::int FROM persona_pending_profiles WHERE persona_id=$1) AS drafts FROM personas WHERE persona_id=$1",
            [personaId],
          )
        ).rows,
      ).toEqual([{ status: "active", drafts: 0 }]);
    });
  }, 30_000);

  test("total-cap refusal preserves the intent and explains retired slots", async () => {
    await scenario(async (h, admin) => {
      for (let i = 0; i < 9; i++)
        await createActivePersonaFixture(admin, {
          accountId: account,
          personaId: `capacity-${i}`,
          profile: { displayName: `Profile ${i}` },
        });
      const draft = await h.create("Still saved");
      await expect(h.commit(draft)).rejects.toThrow("profile limit");
      const read = await Effect.runPromise(h.store.get({ actor, intentId: draft.intent_id }));
      expect(read?.draft).toMatchObject({ public_name: "Still saved" });
      expect(read?.committed_resource).toBeNull();
    });
  }, 30_000);
  test("daily cap gives a retry time and foreign intent access remains hidden", async () => {
    await scenario(async (h, admin) => {
      for (let i = 0; i < 3; i++)
        await createActivePersonaFixture(admin, {
          accountId: account,
          personaId: `daily-${i}`,
          profile: { displayName: `Profile ${i}` },
        });
      const draft = await h.create("Tomorrow");
      await expect(h.commit(draft)).rejects.toThrow("after");
      expect(
        await Effect.runPromise(
          h.store.get({ actor: { ...actor, userId: "foreign" }, intentId: draft.intent_id }),
        ),
      ).toBeNull();
      const denied = await Effect.runPromiseExit(
        h.store.commit({
          actor: { ...actor, userId: "foreign" },
          intentId: draft.intent_id,
          requestHash: "c".repeat(64),
          body: { idempotency_key: "foreign", expected_revision: draft.revision },
        }),
      );
      expect(Exit.isFailure(denied)).toBe(true);
    });
  }, 30_000);
});
