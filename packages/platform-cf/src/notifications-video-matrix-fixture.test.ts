/** Socket-free fixture protocol regression, not PostgreSQL/ACL acceptance. */
import { expect, test } from "bun:test";
import type { Client } from "pg";
import { bindMatrixReaders, community } from "./notifications-video-matrix.pg-fixture.ts";

type Persona = {
  account_id: string;
  status: string;
  is_first_persona: boolean;
  wallet: boolean;
  profile: boolean;
  draft: boolean;
  community_id?: string;
};

function personaProtocol(options: { mixed?: boolean; failWallet?: boolean } = {}) {
  const users = ["inbox-owner", "inbox-author", "inbox-other"];
  const personas = Object.fromEntries(users.map((user) => [user, `first-${user}`]));
  const rows = new Map<string, Persona>(
    users.map((user) => [
      personas[user] as string,
      {
        account_id: user,
        status: "active",
        is_first_persona: true,
        wallet: true,
        profile: true,
        draft: false,
        community_id: "inbox-community",
      },
    ]),
  );
  const requirePersona = (id: string) => {
    const p = rows.get(id);
    if (!p) throw new Error(`Missing fixture persona: ${id}`);
    return p;
  };
  if (options.mixed) {
    rows.set("existing-active", {
      ...requirePersona(personas["inbox-owner"] as string),
      is_first_persona: false,
      community_id: community,
    });
    rows.set("existing-suspended", {
      ...requirePersona(personas["inbox-author"] as string),
      is_first_persona: false,
      status: "suspended",
      community_id: community,
    });
  }
  let transaction: Map<string, Persona> | undefined;
  const events: string[] = [];
  const failure = new Error("fixture wallet activation refused");
  const query = async (sql: string, values: unknown[] = []) => {
    events.push(sql);
    const reply = (result: Record<string, unknown>[] = []) => ({
      rows: result,
      rowCount: result.length,
    });
    const id = String(values[0]);
    if (sql === "BEGIN") {
      transaction = structuredClone(rows);
      return reply();
    }
    if (sql === "COMMIT") {
      transaction = undefined;
      return reply();
    }
    if (sql === "ROLLBACK") {
      if (!transaction) throw new Error("Missing transaction");
      rows.clear();
      for (const entry of transaction) rows.set(...entry);
      transaction = undefined;
      return reply();
    }
    if (sql.includes("FROM community_memberships")) return reply([{}]);
    if (sql.startsWith("SELECT") && sql.includes("p.persona_id=ANY")) {
      const ids = values[0] as string[];
      return reply(
        [...rows]
          .filter(([key]) => ids.includes(key))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([persona_id, persona]) => ({ persona_id, ...persona })),
      );
    }
    if (sql.startsWith("SELECT") && sql.includes("persona_community_bindings")) {
      return reply(
        [...rows]
          .filter(
            ([, p]) =>
              p.account_id === values[0] &&
              p.community_id === values[1] &&
              (!sql.includes("p.status='active'") || p.status === "active"),
          )
          .map(([persona_id]) => ({ persona_id })),
      );
    }
    if (sql.startsWith("INSERT INTO personas")) {
      if (rows.has(id)) throw new Error("Duplicate persona");
      rows.set(id, {
        account_id: String(values[1]),
        status: "pending_wallet",
        is_first_persona: false,
        wallet: false,
        profile: false,
        draft: false,
      });
      return reply();
    }
    if (sql.startsWith("INSERT INTO persona_community_bindings")) {
      const p = rows.get(id);
      if (p?.community_id)
        throw Object.assign(new Error("Immutable unique persona binding"), { code: "23505" });
      if (!p || p.account_id !== values[1] || p.status !== "active" || !p.wallet || !p.profile)
        throw new Error("An active wallet/profile-backed owned persona is required");
      p.community_id = String(values[2]);
      return reply();
    }
    if (sql.startsWith("INSERT INTO persona_pending_profiles")) {
      requirePersona(id).draft = true;
      return reply();
    }
    if (sql.startsWith("INSERT INTO persona_wallet_assignments")) return reply();
    const selected = (values[0] as string[]).map(requirePersona);
    if (sql.startsWith("UPDATE persona_wallet_assignments")) {
      if (options.failWallet) throw failure;
      for (const p of selected) p.wallet = true;
    } else if (sql.startsWith("INSERT INTO persona_profiles")) {
      for (const p of selected) {
        if (!p.draft) throw new Error("Pending profile is required");
        p.profile = true;
      }
    } else if (sql.startsWith("INSERT INTO public_handle_index")) {
      // Additional personas have no pending first handle to insert.
    } else if (sql.startsWith("UPDATE personas")) {
      for (const p of selected) {
        if (!p.wallet || !p.profile) throw new Error("Activation prerequisites missing");
        p.status = "active";
      }
    } else if (sql.startsWith("DELETE FROM persona_pending_profiles")) {
      for (const p of selected) p.draft = false;
    } else if (!sql.startsWith("DELETE FROM persona_pending_first_handles")) {
      throw new Error(`Unexpected fixture protocol statement: ${sql}`);
    }
    return reply();
  };
  return { rows, events, failure, fixture: { personas, admin: { query } as unknown as Client } };
}

test("matrix readers gain additional activated community personas; original first bindings survive and repeat calls reuse them", async () => {
  const p = personaProtocol();
  const originals = structuredClone(p.rows);
  const result = await bindMatrixReaders(p.fixture);
  expect(Object.keys(result)).toEqual(["inbox-owner", "inbox-author", "inbox-other"]);
  for (const [user, id] of Object.entries(result)) {
    expect(id).not.toBe(p.fixture.personas[user]);
    expect(p.rows.get(id)).toMatchObject({
      account_id: user,
      community_id: community,
      status: "active",
      is_first_persona: false,
      wallet: true,
      profile: true,
      draft: false,
    });
  }
  for (const [id, original] of originals) expect(p.rows.get(id)).toEqual(original);
  expect(p.events.filter((s) => s.startsWith("INSERT INTO personas"))).toHaveLength(3);
  const inserted = p.rows.size;
  expect(await bindMatrixReaders(p.fixture)).toEqual(result);
  expect(p.rows.size).toBe(inserted);
  expect(p.events.filter((s) => s.startsWith("INSERT INTO personas"))).toHaveLength(3);
});

test("matrix readers reuse an active bound persona, never a suspended one or another community's first persona", async () => {
  const p = personaProtocol({ mixed: true });
  const before = structuredClone(p.rows);
  const result = await bindMatrixReaders(p.fixture);
  expect(result["inbox-owner"]).toBe("existing-active");
  expect(result["inbox-author"]).not.toBe("existing-suspended");
  expect(p.events.filter((s) => s.startsWith("INSERT INTO personas"))).toHaveLength(2);
  for (const [id, original] of before) expect(p.rows.get(id)).toEqual(original);
});

test("failed maintained wallet activation propagates, rolls back and never binds an inactive persona", async () => {
  const p = personaProtocol({ failWallet: true });
  const original = structuredClone(p.rows);
  await expect(bindMatrixReaders(p.fixture)).rejects.toBe(p.failure);
  expect(p.rows).toEqual(original);
  expect(p.events).toContain("ROLLBACK");
  expect(p.events.some((s) => s.startsWith("INSERT INTO persona_community_bindings"))).toBe(false);
});
