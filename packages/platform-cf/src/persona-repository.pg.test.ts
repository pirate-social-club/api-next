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
import { activatePendingPersonaFixtures } from "./persona-wallet.pg-fixture.ts";
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
const testCount = 6;
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
  test("fails the wallet activation migration before changing a retained walletless schema", async () => {
    if (connectionString === undefined) throw new Error("test URL was not configured");
    const schema = schemaIdentifier();
    const admin = new Client({ connectionString });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
    const scopedConnection = connectionForSchema(connectionString, schema);
    const migrationIndex = migrations.findIndex(
      ({ version }) => version === "0060_persona_wallet_provisioning.sql",
    );
    const migration = migrations[migrationIndex];
    if (migration === undefined) {
      throw new Error("persona wallet migration is required for this fixture");
    }
    try {
      await Effect.runPromise(
        Effect.scoped(
          applyPostgresMigrations(migrations.slice(0, migrationIndex)).pipe(
            Effect.provide(makeDirectPostgresControlPlaneLayer(scopedConnection)),
          ),
        ),
      );
      await admin.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await admin.query(
        `INSERT INTO users (user_id, status, account)
         VALUES ('retained-walletless-account', 'active', '{}'::jsonb)`,
      );

      const migrationExit = await Effect.runPromiseExit(
        Effect.scoped(
          applyPostgresMigrations(migrations.slice(0, migrationIndex + 1)).pipe(
            Effect.provide(makeDirectPostgresControlPlaneLayer(scopedConnection)),
          ),
        ),
      );
      expect(Exit.isFailure(migrationExit)).toBe(true);
      const retained = await admin.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count
           FROM personas
          WHERE status='active' AND account_id='retained-walletless-account'`,
      );
      expect(retained.rows[0]?.count).toBe("1");
      const pendingProfiles = await admin.query<{ readonly relation: string | null }>(
        "SELECT to_regclass('persona_pending_profiles')::text AS relation",
      );
      expect(pendingProfiles.rows[0]?.relation).toBeNull();
      const ledger = await admin.query<{ readonly count: string }>(
        "SELECT count(*)::text AS count FROM schema_migrations WHERE version=$1",
        [migration.version],
      );
      expect(ledger.rows[0]?.count).toBe("0");
    } finally {
      await admin.query("ROLLBACK");
      await admin.query(`DROP SCHEMA ${quoteIdentifier(schema)} CASCADE`);
      await admin.end();
    }
    completedTestCount += 1;
  });

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
        const reservationTime = await admin.query<{ readonly created_at: Date }>(
          "SELECT created_at FROM persona_wallet_assignments WHERE persona_id=$1",
          [`persona_account-slot_${ordinal}`],
        );
        expect(reservationTime.rows[0]?.created_at.getUTCFullYear()).toBeGreaterThan(2020);
        await admin.query("SET session_replication_role = replica");
        try {
          await admin.query(
            `UPDATE persona_wallet_assignments
                SET created_at='2020-01-01T00:00:00.000Z',
                    updated_at='2020-01-01T00:00:00.000Z'
              WHERE persona_id=$1`,
            [`persona_account-slot_${ordinal}`],
          );
        } finally {
          await admin.query("SET session_replication_role = origin");
        }
      }
      const current = new Date().toISOString();
      for (let ordinal = 7; ordinal <= 9; ordinal += 1) {
        await run(connection, create("account-slot", ordinal, current));
      }
      const slotExit = await runExit(connection, create("account-slot", 10, current));
      expect(failureOf(slotExit)).toEqual(new PersonaStoreConflict({ reason: "slot-limit" }));

      for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
        await run(connection, create("account-rate", ordinal, "2020-01-01T00:00:00.000Z"));
      }
      const rateExit = await runExit(
        connection,
        create("account-rate", 4, "2020-01-01T00:00:00.000Z"),
      );
      expect(failureOf(rateExit)).toBeInstanceOf(PersonaStoreRateLimited);
      expect((failureOf(rateExit) as PersonaStoreRateLimited).retryAfterSeconds).toBeGreaterThan(0);
    });
    completedTestCount += 1;
  });

  test("reserves a pending first handle against rename and preserves it through activation", async () => {
    await withSchema(async (admin, connection) => {
      await admin.query(
        `INSERT INTO users (user_id,status,account) VALUES
          ('account-pending-label','active',
           '{"profile":{"display_name":"Pending"},"global_handle":{"global_handle_id":"handle-pending-label","label_display":"reservedlabel.pirate"}}'::jsonb),
          ('account-published-label','active',
           '{"profile":{"display_name":"Published"},"global_handle":{"global_handle_id":"handle-published-label","label_display":"publishedlabel.pirate"}}'::jsonb)`,
      );
      const personas = await admin.query<{
        readonly account_id: string;
        readonly persona_id: string;
      }>("SELECT account_id,persona_id FROM personas WHERE is_first_persona ORDER BY account_id");
      const pendingPersona = personas.rows.find(
        ({ account_id }) => account_id === "account-pending-label",
      )?.persona_id;
      const publishedPersona = personas.rows.find(
        ({ account_id }) => account_id === "account-published-label",
      )?.persona_id;
      if (pendingPersona === undefined || publishedPersona === undefined) {
        throw new Error("first persona missing");
      }
      await activatePendingPersonaFixtures(admin, [publishedPersona]);
      await expect(
        admin.query(
          `INSERT INTO public_handle_index (
             handle_id,label_normalized,label_display,status,
             owner_user_id,owner_persona_id,redirect_target_handle_id
           ) VALUES (
             'handle-rename-collision','reservedlabel','reservedlabel.pirate','active',
             'account-published-label',$1,NULL
           )`,
          [publishedPersona],
        ),
      ).rejects.toMatchObject({
        code: "23505",
        constraint: "first_persona_handle_reservation_unique",
      });

      const wallets = makeControlPlanePersonaWalletRepository();
      await run(
        connection,
        wallets.confirmEvm({
          accountId: "account-pending-label",
          personaId: pendingPersona,
          attestation: {
            sourceUserId: "privy-pending-label",
            privyWalletId: "wallet-pending-label",
            hdWalletIndex: 0,
            address: "0x5555555555555555555555555555555555555555",
          },
        }),
      );
      const published = await admin.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count FROM public_handle_index
          WHERE owner_persona_id=$1 AND label_normalized='reservedlabel'`,
        [pendingPersona],
      );
      expect(published.rows[0]?.count).toBe("1");
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
      const reusedPreparationKey = await runExit(
        connection,
        wallets.reserveEvm({
          accountId: "account-wallet-a",
          personaId: sibling.persona_id,
          idempotencyKey: "wallet-first",
        }),
      );
      expect(failureOf(reusedPreparationKey)).toEqual(
        new PersonaWalletStoreConflict({ reason: "idempotency-mismatch" }),
      );
      const concurrentPersonas = [
        personaRecord("persona_wallet_concurrent_a", "2020-02-01T00:00:00.000Z"),
        personaRecord("persona_wallet_concurrent_b", "2020-02-01T00:00:01.000Z"),
      ];
      const concurrentPreparations = await Promise.all(
        concurrentPersonas.map((candidate, index) =>
          run(
            connection,
            personas.create({
              accountId: "account-wallet-a",
              idempotencyKey: `persona-wallet-concurrent-${index}`,
              intent: { displayName: "Concurrent Persona", bio: null, preferredLocale: "en" },
              personaId: candidate.persona_id,
              createdAt: candidate.created_at,
            }),
          ),
        ),
      );
      expect(concurrentPreparations.map((entry) => entry.hd_wallet_index).sort()).toEqual([2, 3]);
      const concurrentPreparation = concurrentPreparations[0];
      if (concurrentPreparation === undefined) throw new Error("concurrent preparation missing");
      const concurrentAttestation = {
        sourceUserId: "privy-wallet-a",
        privyWalletId: "privy-wallet-concurrent",
        hdWalletIndex: concurrentPreparation.hd_wallet_index,
        address: "0x4444444444444444444444444444444444444444",
      };
      const concurrentAssignments = await Promise.all([
        run(
          connection,
          wallets.confirmEvm({
            accountId: "account-wallet-a",
            personaId: concurrentPreparation.persona_id,
            attestation: concurrentAttestation,
          }),
        ),
        run(
          connection,
          wallets.confirmEvm({
            accountId: "account-wallet-a",
            personaId: concurrentPreparation.persona_id,
            attestation: concurrentAttestation,
          }),
        ),
      ]);
      expect(concurrentAssignments[1]).toEqual(concurrentAssignments[0]);
      const activated = await admin.query<{ readonly count: string }>(
        `SELECT count(*)::text AS count FROM persona_profiles WHERE persona_id=$1`,
        [concurrentPreparation.persona_id],
      );
      expect(activated.rows[0]?.count).toBe("1");
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
      const firstRetirement = await runExit(
        connection,
        wallets.retire({
          accountId: "account-fence-a",
          personaId: personaA,
          idempotencyKey: "retire-persona-a",
        }),
      );
      expect(failureOf(firstRetirement)).toEqual(
        new PersonaWalletStoreConflict({ reason: "first-persona-required" }),
      );
      const personas = makeControlPlanePersonaRepository();
      const retirementPersona = "persona_retirement_fixture";
      await run(
        connection,
        personas.create({
          accountId: "account-fence-a",
          idempotencyKey: "create-retirement-persona",
          intent: { displayName: "Retirement fixture", bio: null, preferredLocale: null },
          personaId: retirementPersona,
          createdAt: "2026-08-24T12:00:00.000Z",
        }),
      );
      const retirement = await run(
        connection,
        wallets.retire({
          accountId: "account-fence-a",
          personaId: retirementPersona,
          idempotencyKey: "retire-persona-sibling",
        }),
      );
      expect(retirement).toMatchObject({ persona_id: retirementPersona, status: "retired" });
      expect(
        await run(
          connection,
          wallets.retire({
            accountId: "account-fence-a",
            personaId: retirementPersona,
            idempotencyKey: "retire-persona-sibling",
          }),
        ),
      ).toEqual(retirement);
      await expect(
        admin.query(
          `UPDATE persona_wallet_assignments
              SET status='active', tombstoned_at=NULL, updated_at=clock_timestamp()
            WHERE persona_id=$1`,
          [retirementPersona],
        ),
      ).rejects.toThrow();
      const projection = await admin.query<{ readonly projection: Record<string, unknown> }>(
        "SELECT public_persona_projection($1) AS projection",
        [retirementPersona],
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
