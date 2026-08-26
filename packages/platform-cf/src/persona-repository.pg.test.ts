import { afterAll, describe, expect, test } from "bun:test";
import {
  type ControlPlaneDb,
  type PersonaRecord,
  PersonaStoreConflict,
  PersonaStoreRateLimited,
  PersonaWalletStoreConflict,
} from "@pirate/application";
import { Cause, Effect, Exit, Result } from "effect";
import { Client } from "pg";
import { loadPostgresMigrations } from "../../../scripts/postgres-migrations.ts";
import {
  makeControlPlanePersonaRepository,
  makeControlPlanePersonaWalletRepository,
} from "./persona-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { applyPostgresMigrations } from "./postgres-migrations.ts";

const connectionString = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
const required = process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1";
if (required && connectionString === undefined) {
  throw new Error("CONTROL_PLANE_POSTGRES_TEST_URL is required for the Postgres 17 suite");
}
const suite = connectionString === undefined ? describe.skip : describe;
const sentinelPath =
  process.env.CONTROL_PLANE_POSTGRES_PERSONA_TEST_SENTINEL ??
  "/tmp/api-next-control-plane-postgres-persona-suite-complete";
const sentinelContents = "api-next-control-plane-postgres-persona-suite-complete\n";
const migrations = await loadPostgresMigrations();
const testCount = 4;
let completedTestCount = 0;

const schemaIdentifier = (): string =>
  `api_next_persona_${crypto.randomUUID().replaceAll("-", "")}`;
const quoteIdentifier = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const connectionForSchema = (raw: string, schema: string): string => {
  const separator = raw.includes("?") ? "&" : "?";
  return `${raw}${separator}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
};

async function withSchema<A>(use: (admin: Client, connection: string) => Promise<A>): Promise<A> {
  if (connectionString === undefined) throw new Error("test URL was not configured");
  const schema = schemaIdentifier();
  const admin = new Client({ connectionString });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
  await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
  const scopedConnection = connectionForSchema(connectionString, schema);
  try {
    await Effect.runPromise(
      Effect.scoped(
        applyPostgresMigrations(migrations).pipe(
          Effect.provide(makeDirectPostgresControlPlaneLayer(scopedConnection)),
        ),
      ),
    );
    return await use(admin, scopedConnection);
  } finally {
    await admin.query("ROLLBACK");
    await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
    await admin.end();
  }
}

const run = <A, E>(connection: string, effect: Effect.Effect<A, E, ControlPlaneDb>) =>
  Effect.runPromise(
    Effect.scoped(effect.pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection)))),
  );

const runExit = <A, E>(connection: string, effect: Effect.Effect<A, E, ControlPlaneDb>) =>
  Effect.runPromiseExit(
    Effect.scoped(effect.pipe(Effect.provide(makeDirectPostgresControlPlaneLayer(connection)))),
  );

const personaRecord = (personaId: string, createdAt: string): PersonaRecord => ({
  persona_id: personaId,
  object: "persona",
  status: "active",
  profile: {
    persona_id: personaId,
    object: "persona_profile",
    revision: 1,
    display_name: "Sibling Persona",
    avatar_ref: null,
    cover_ref: null,
    bio: null,
    preferred_locale: "en",
    primary_public_handle: null,
  },
  wallet_set: { evm: null },
  created_at: createdAt,
  retired_at: null,
});

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
};

suite("Postgres 17 account persona and EVM wallet persistence", () => {
  test("enforces the lifetime slot ceiling and rolling additional-persona rate", async () => {
    await withSchema(async (admin, connection) => {
      await admin.query("INSERT INTO users (user_id) VALUES ('account-slot'),('account-rate')");
      const repository = makeControlPlanePersonaRepository();
      const create = (accountId: string, ordinal: number, createdAt: string) =>
        repository.create({
          accountId,
          idempotencyKey: `create-${ordinal}`,
          intent: { displayName: null, bio: null, preferredLocale: null },
          personaId: `persona_${accountId}_${ordinal}`,
          createdAt,
        });

      for (let ordinal = 1; ordinal <= 6; ordinal += 1) {
        await run(connection, create("account-slot", ordinal, `2020-01-0${ordinal}T00:00:00.000Z`));
      }
      const current = new Date().toISOString();
      for (let ordinal = 7; ordinal <= 9; ordinal += 1) {
        await run(connection, create("account-slot", ordinal, current));
      }
      const slotExit = await runExit(connection, create("account-slot", 10, current));
      expect(failureOf(slotExit)).toEqual(new PersonaStoreConflict({ reason: "slot-limit" }));

      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        await run(connection, create("account-rate", ordinal, current));
      }
      const rateExit = await runExit(connection, create("account-rate", 4, current));
      expect(failureOf(rateExit)).toBeInstanceOf(PersonaStoreRateLimited);
      expect((failureOf(rateExit) as PersonaStoreRateLimited).retryAfterSeconds).toBeGreaterThan(0);
    });
    completedTestCount += 1;
  });

  test("provisions an opaque first persona and round-trips persona-scoped creation replay", async () => {
    await withSchema(async (admin, connection) => {
      const createdAt = "2026-08-24T12:00:00.000Z";
      await admin.query(
        `INSERT INTO users (user_id, status, account, created_at)
         VALUES (
           'account-persona-a', 'active',
           '{"profile":{"display_name":"First Persona","preferred_locale":"en"}}'::jsonb,
           $1
         )`,
        [createdAt],
      );
      const first = await admin.query<{
        readonly persona_id: string;
        readonly display_name: string | null;
      }>(
        `SELECT persona.persona_id, profile.display_name
           FROM personas AS persona
           JOIN persona_pending_profiles AS profile USING (persona_id)
          WHERE persona.account_id='account-persona-a' AND persona.is_first_persona`,
      );
      expect(first.rows).toHaveLength(1);
      const firstPersonaId = first.rows[0]?.persona_id;
      if (firstPersonaId === undefined) throw new Error("first persona missing");
      expect(firstPersonaId).toMatch(/^persona_[0-9a-f]{32}$/u);
      expect(firstPersonaId).not.toContain("account-persona-a");
      expect(first.rows[0]?.display_name).toBe("First Persona");

      const repository = makeControlPlanePersonaRepository();
      const sibling = personaRecord("persona_sibling_a", "2026-08-24T12:01:00.000Z");
      const input = {
        accountId: "account-persona-a",
        idempotencyKey: "persona-create-a",
        intent: { displayName: "Sibling Persona", bio: null, preferredLocale: "en" },
        personaId: sibling.persona_id,
        createdAt: sibling.created_at,
      };
      const created = await run(connection, repository.create(input));
      expect(created).toMatchObject({ persona_id: sibling.persona_id, status: "pending" });
      expect(
        await run(connection, repository.create({ ...input, personaId: "persona_ignored" })),
      ).toEqual(created);
      const listed = await run(connection, repository.listByAccount("account-persona-a"));
      expect(listed).toEqual([]);
      const mismatch = await runExit(
        connection,
        repository.create({
          ...input,
          intent: { ...input.intent, displayName: "Changed" },
          personaId: "persona_changed",
        }),
      );
      expect(failureOf(mismatch)).toEqual(
        new PersonaStoreConflict({ reason: "idempotency-mismatch" }),
      );
    });
    completedTestCount += 1;
  });

  test("allocates distinct EVM indices and rejects address reuse across sibling personas", async () => {
    await withSchema(async (admin, connection) => {
      await admin.query(
        "INSERT INTO users (user_id) VALUES ('account-wallet-a'), ('account-wallet-b')",
      );
      const first = await admin.query<{ readonly persona_id: string }>(
        "SELECT persona_id FROM personas WHERE account_id='account-wallet-a' AND is_first_persona",
      );
      const other = await admin.query<{ readonly persona_id: string }>(
        "SELECT persona_id FROM personas WHERE account_id='account-wallet-b' AND is_first_persona",
      );
      const firstPersonaId = first.rows[0]?.persona_id;
      const otherPersonaId = other.rows[0]?.persona_id;
      if (firstPersonaId === undefined || otherPersonaId === undefined) {
        throw new Error("first persona missing");
      }
      const personas = makeControlPlanePersonaRepository();
      const sibling = personaRecord("persona_wallet_sibling", "2026-08-24T12:02:00.000Z");
      await run(
        connection,
        personas.create({
          accountId: "account-wallet-a",
          idempotencyKey: "persona-wallet-sibling",
          intent: { displayName: "Sibling Persona", bio: null, preferredLocale: "en" },
          personaId: sibling.persona_id,
          createdAt: sibling.created_at,
        }),
      );
      const wallets = makeControlPlanePersonaWalletRepository();
      const firstPreparation = await run(
        connection,
        wallets.reserveEvm({
          accountId: "account-wallet-a",
          personaId: firstPersonaId,
          idempotencyKey: "wallet-first",
        }),
      );
      const siblingPreparation = await run(
        connection,
        wallets.reserveEvm({
          accountId: "account-wallet-a",
          personaId: sibling.persona_id,
          idempotencyKey: "wallet-sibling",
        }),
      );
      expect(firstPreparation.hd_wallet_index).toBe(0);
      expect(siblingPreparation.hd_wallet_index).toBe(1);
      const firstAddress = "0x1111111111111111111111111111111111111111";
      await run(
        connection,
        wallets.confirmEvm({
          accountId: "account-wallet-a",
          personaId: firstPersonaId,
          attestation: {
            sourceUserId: "privy-wallet-a",
            privyWalletId: "privy-wallet-first",
            hdWalletIndex: 0,
            address: firstAddress,
          },
        }),
      );
      const siblingAssignment = await run(
        connection,
        wallets.confirmEvm({
          accountId: "account-wallet-a",
          personaId: sibling.persona_id,
          attestation: {
            sourceUserId: "privy-wallet-a",
            privyWalletId: "privy-wallet-sibling",
            hdWalletIndex: 1,
            address: "0x2222222222222222222222222222222222222222",
          },
        }),
      );
      expect(siblingAssignment.hd_wallet_index).toBe(1);

      await run(
        connection,
        wallets.reserveEvm({
          accountId: "account-wallet-b",
          personaId: otherPersonaId,
          idempotencyKey: "wallet-other",
        }),
      );
      const collision = await runExit(
        connection,
        wallets.confirmEvm({
          accountId: "account-wallet-b",
          personaId: otherPersonaId,
          attestation: {
            sourceUserId: "privy-wallet-b",
            privyWalletId: "privy-wallet-other",
            hdWalletIndex: 0,
            address: firstAddress,
          },
        }),
      );
      expect(failureOf(collision)).toEqual(
        new PersonaWalletStoreConflict({ reason: "wallet-address-collision" }),
      );
    });
    completedTestCount += 1;
  });

  test("fences foreign, inactive, rewritten, deleted, and reopened persona authority", async () => {
    await withSchema(async (admin, connection) => {
      await admin.query(
        "INSERT INTO users (user_id) VALUES ('account-fence-a'), ('account-fence-b')",
      );
      const ids = await admin.query<{ readonly account_id: string; readonly persona_id: string }>(
        "SELECT account_id, persona_id FROM personas WHERE is_first_persona ORDER BY account_id",
      );
      const personaA = ids.rows.find((row) => row.account_id === "account-fence-a")?.persona_id;
      const personaB = ids.rows.find((row) => row.account_id === "account-fence-b")?.persona_id;
      if (personaA === undefined || personaB === undefined) throw new Error("persona missing");
      const wallets = makeControlPlanePersonaWalletRepository();
      const foreign = await runExit(
        connection,
        wallets.reserveEvm({
          accountId: "account-fence-a",
          personaId: personaB,
          idempotencyKey: "foreign-wallet",
        }),
      );
      expect(failureOf(foreign)).toEqual(
        new PersonaWalletStoreConflict({ reason: "reservation-mismatch" }),
      );
      await run(
        connection,
        wallets.confirmEvm({
          accountId: "account-fence-a",
          personaId: personaA,
          attestation: {
            sourceUserId: "privy-fence-a",
            privyWalletId: "privy-fence-wallet",
            hdWalletIndex: 0,
            address: "0x3333333333333333333333333333333333333333",
          },
        }),
      );
      await admin.query("UPDATE personas SET status='suspended' WHERE persona_id=$1", [personaA]);
      const inactive = await runExit(
        connection,
        wallets.reserveEvm({
          accountId: "account-fence-a",
          personaId: personaA,
          idempotencyKey: "inactive-wallet",
        }),
      );
      expect(failureOf(inactive)).toEqual(
        new PersonaWalletStoreConflict({ reason: "reservation-mismatch" }),
      );
      await admin.query("UPDATE personas SET status='active' WHERE persona_id=$1", [personaA]);
      await run(
        connection,
        wallets.reserveEvm({
          accountId: "account-fence-a",
          personaId: personaA,
          idempotencyKey: "durable-wallet",
        }),
      );
      for (const statement of [
        "DELETE FROM personas WHERE persona_id=$1",
        "UPDATE personas SET persona_id='persona_rewritten' WHERE persona_id=$1",
        "DELETE FROM persona_wallet_assignments WHERE persona_id=$1",
        "UPDATE persona_wallet_assignments SET hd_wallet_index=9 WHERE persona_id=$1",
      ]) {
        await expect(admin.query(statement, [personaA])).rejects.toThrow();
      }
      await admin.query(
        "UPDATE personas SET status='retired', retired_at=clock_timestamp() WHERE persona_id=$1",
        [personaA],
      );
      await admin.query(
        `UPDATE persona_wallet_assignments
            SET status='tombstoned', tombstoned_at=clock_timestamp(), updated_at=clock_timestamp()
          WHERE persona_id=$1`,
        [personaA],
      );
      await expect(
        admin.query(
          `UPDATE persona_wallet_assignments
              SET status='active', tombstoned_at=NULL, updated_at=clock_timestamp()
            WHERE persona_id=$1`,
          [personaA],
        ),
      ).rejects.toThrow();
      const projection = await admin.query<{ readonly projection: Record<string, unknown> }>(
        "SELECT public_persona_projection($1) AS projection",
        [personaA],
      );
      expect(projection.rows[0]?.projection).toBeNull();
      expect(JSON.stringify(projection.rows[0]?.projection)).not.toContain("account-fence-a");
    });
    completedTestCount += 1;
  });
});

afterAll(async () => {
  if (completedTestCount === testCount) await Bun.write(sentinelPath, sentinelContents);
});
