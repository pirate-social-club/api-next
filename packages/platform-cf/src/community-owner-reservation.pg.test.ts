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
  for (const activateBeforeAbandonment of [false, true]) {
    test(`reclaims the same never-bound owner after abandonment (activated=${activateBeforeAbandonment})`, async () => {
      await scenario(async (h, admin) => {
        const first = await h.create("First public name");
        const key = crypto.randomUUID();
        const [left, right] = await Promise.all([h.commit(first, key), h.commit(first, key)]);
        expect(left.document).toEqual(right.document);
        const action = left.document.next_action;
        if (action.kind !== "activate_profile") throw new Error("expected activation");
        const personaId = action.persona_id;
        expect(await Effect.runPromise(h.personas.listPendingWallets("foreign-account"))).toEqual(
          [],
        );
        expect(
          (await Effect.runPromise(h.personas.listPendingWallets(account))).map(
            (p) => p.persona_id,
          ),
        ).toContain(personaId);
        if (activateBeforeAbandonment) await h.activate(personaId);
        const before = (
          await admin.query(
            "SELECT assignment_id,hd_wallet_index FROM persona_wallet_assignments WHERE persona_id=$1",
            [personaId],
          )
        ).rows;
        const newer = await h.create("River Room");
        const resumed = await h.commit(newer);
        const after = (
          await admin.query(
            "SELECT assignment_id,hd_wallet_index FROM persona_wallet_assignments WHERE persona_id=$1",
            [personaId],
          )
        ).rows;
        expect(after).toEqual(before);
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM persona_wallet_assignments WHERE account_id=$1",
              [account],
            )
          ).rows[0].n,
        ).toBe(2);
        expect(
          (await Effect.runPromise(h.store.get({ actor, intentId: first.intent_id })))?.status,
        ).toBe("cancelled");
        await expect(h.commit(left.document)).rejects.toThrow();
        expect(
          (
            await admin.query(
              "SELECT count(*)::int AS n FROM communities WHERE created_by_user_id=$1",
              [account],
            )
          ).rows[0].n,
        ).toBe(0);
        await h.activate(personaId);
        const published = await h.commit(resumed.document);
        expect(published.document.status).toBe("committed");
        if (!("creation_contract_version" in published.document)) throw new Error("wrong contract");
        expect(published.document.persona_role_presentation?.persona).toMatchObject({
          persona_id: personaId,
          display_name: "River Room",
        });
        expect(
          (await Effect.runPromise(h.personas.listByAccount(account))).find(
            (p) => p.persona_id === personaId,
          )?.profile.display_name,
        ).toBe("River Room");
        const another = await h.create("Another public name");
        const anotherReserved = await h.commit(another);
        expect(anotherReserved.document.next_action).not.toEqual(action);
      });
    }, 30_000);
  }
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
      const reserved = await h.commit(await h.create("River Room"));
      const action = reserved.document.next_action;
      if (action.kind !== "activate_profile") throw new Error("Expected private activation");
      expect(action.persona_id).not.toBe(first.persona_id);
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM communities WHERE created_by_user_id=$1",
            [account],
          )
        ).rows[0].n,
      ).toBe(1);
      await h.activate(action.persona_id);
      const complete = await h.commit(reserved.document);
      expect(complete.document.status).toBe("committed");
      const visible = await Effect.runPromise(h.personas.listByAccount(account));
      expect(
        visible.find((persona) => persona.persona_id === action.persona_id)?.profile.display_name,
      ).toBe("River Room");
      expect(
        visible.find((persona) => persona.persona_id === action.persona_id)?.community_binding,
      ).not.toBeNull();
    });
  }, 30_000);

  test("expired setup is reclaimed and suspension remains fenced", async () => {
    await scenario(async (h, admin) => {
      const reserved = await h.commit(await h.create("Expired draft"));
      const action = reserved.document.next_action;
      if (action.kind !== "activate_profile") throw new Error("Expected activation");
      await admin.query(
        "UPDATE community_creation_intents SET expires_at=now()-interval '1 second',revision=revision+1 WHERE intent_id=$1",
        [reserved.document.intent_id],
      );
      const reclaimed = await h.commit(await h.create("Recovered draft"));
      expect(reclaimed.document.next_action).toEqual(action);
      expect(
        (await Effect.runPromise(h.store.get({ actor, intentId: reserved.document.intent_id })))
          ?.status,
      ).toBe("expired");
      await h.activate(action.persona_id);
      await admin.query("UPDATE personas SET status='suspended' WHERE persona_id=$1", [
        action.persona_id,
      ]);
      await expect(h.commit(reclaimed.document)).rejects.toThrow();
      expect(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM communities WHERE created_by_user_id=$1",
            [account],
          )
        ).rows[0].n,
      ).toBe(0);
    });
  }, 30_000);

  test("retirement fences activation and recovery without recycling the index", async () => {
    await scenario(async (h, admin) => {
      const reserved = await h.commit(await h.create("Private name"));
      const action = reserved.document.next_action;
      if (action.kind !== "activate_profile") throw new Error("expected activation");
      const old = await Effect.runPromise(
        h.wallets.getEvmPreparation({ accountId: account, personaId: action.persona_id }),
      );
      await Effect.runPromise(
        h.wallets.retire({
          accountId: account,
          personaId: action.persona_id,
          idempotencyKey: "retire-setup",
        }),
      );
      await expect(h.commit(reserved.document)).rejects.toThrow();
      const next = await h.commit(await h.create("New name"));
      if (next.document.next_action.kind !== "activate_profile")
        throw new Error("expected activation");
      const fresh = await Effect.runPromise(
        h.wallets.getEvmPreparation({
          accountId: account,
          personaId: next.document.next_action.persona_id,
        }),
      );
      if (!fresh || !old) throw new Error("Expected wallet reservations");
      expect(fresh.hd_wallet_index).toBeGreaterThan(old.hd_wallet_index);
      expect(
        (await admin.query("SELECT public_persona_projection($1) AS p", [action.persona_id]))
          .rows[0].p,
      ).toBeNull();
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
