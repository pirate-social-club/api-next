/** Native codec/ACL acceptance only; actual positive producer cases are separate. */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  buildMegapotOwnerBeneficiarySnapshot,
  MEGAPOT_OWNER_SNAPSHOT_DOMAIN,
} from "@pirate/domain";
import { Client } from "pg";
import {
  loadPostgresMigrations,
  runPostgresMigrations,
} from "../../../scripts/postgres-migrations.ts";
import { fixture, pgUrl } from "./account-study-producer.pg-fixture.ts";

const suite = pgUrl ? describe : describe.skip;
const digest = (b: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(b).digest());
const terms = `0x${"03".repeat(32)}`;
const beneficiaries = [
  {
    ownerId: "owner_account_fixture",
    ownerKind: "account" as const,
    qualificationId: "qualification_account_fixture",
    originalPersonaId: "persona_fixture",
    leafSalt: `0x${"01".repeat(32)}`,
  },
  {
    ownerId: "owner_guest_fixture",
    ownerKind: "guest" as const,
    qualificationId: "qualification_guest_fixture",
    originalPersonaId: null,
    leafSalt: `0x${"02".repeat(32)}`,
  },
];
suite("native owner snapshot byte codec", () => {
  test("matches the independent normative mixed vector and actual domain codec, keeps raw helpers inaccessible, rejects malformed input", async () => {
    const all = await loadPostgresMigrations();
    // The future SOURCE must be adopted as one maintained migration. Never
    // apply outside proposal SQL or install a fixture-only financial authority.
    const candidates = all.filter((m) =>
      m.sql.includes("CREATE FUNCTION freeze_owner_megapot_drawing_private_v1("),
    );
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0];
    if (candidate === undefined) throw new Error("Adopted complete financial source unavailable");
    const index = all.indexOf(candidate),
      accepted = all.slice(0, index + 1);
    expect(accepted.map((m) => Number(m.version.slice(0, 4)))).toEqual(
      Array.from({ length: accepted.length }, (_, i) => i + 1),
    );
    const historical = JSON.parse(
      await readFile(
        new URL("./disabled-owner-accounting.accepted-learning-prefix.json", import.meta.url),
        "utf8",
      ),
    );
    for (const m of accepted.slice(0, 264)) expect(m.checksum).toBe(historical[m.version]);
    expect(accepted[264]?.version).toBe("0265_account_karaoke_unclaimed_cancellation.sql");
    expect(accepted[264]?.checksum).toBe(
      "337b5469bdf01595413349517f1c0750530280a4a38ac8fd007a2d2e3c4e106f",
    );
    expect(accepted[265]?.version).toBe("0266_disabled_owner_financial_history.sql");
    expect(accepted[265]?.checksum).toBe(
      "a5ffb1317f5630c822c9d35a59ce2a35dadd8ed0b3de54a6c94ae9304fe4bc77",
    );
    await fixture(async (f) => {
      if (!pgUrl) throw new Error("Owned PG URL required");
      const url = new URL(pgUrl);
      url.searchParams.set("options", `-c search_path=${f.schema}`);
      await runPostgresMigrations({
        connectionString: url.toString(),
        migrations: accepted,
        expectedLedger: accepted.slice(0, 262),
      });
      expect(
        (await f.admin.query("SELECT version,checksum FROM schema_migrations ORDER BY version"))
          .rows,
      ).toEqual(accepted.map(({ version, checksum }) => ({ version, checksum })));
      const input = JSON.stringify(beneficiaries);
      const actual = (
        await f.admin.query<{ result: ReturnType<typeof buildMegapotOwnerBeneficiarySnapshot> }>(
          "SELECT build_owner_megapot_snapshot_private_v1($1,$2,$3,FALSE,$4::jsonb) AS result",
          ["pool_fixture", "7", terms, input],
        )
      ).rows[0]?.result;
      if (actual === undefined) throw new Error("Native snapshot output unavailable");
      const expected = buildMegapotOwnerBeneficiarySnapshot({
        poolLegId: "pool_fixture",
        drawingId: 7n,
        termsHash: terms,
        fallback: false,
        beneficiaries,
        sha256: digest,
      });
      expect(actual).toEqual(expected);
      expect(actual.published).toEqual({
        domain: MEGAPOT_OWNER_SNAPSHOT_DOMAIN,
        poolLegId: "pool_fixture",
        drawingId: "7",
        termsHash: terms,
        algorithmVersion: "equal_v1",
        fallback: false,
        leafCount: 2,
        leafCommitments: [
          "0x9230e632353302902193e4b9980e9a6b8c2ff992f6e49eba798d81fca675016b",
          "0x66cd0d74d85e2e8673ada357e68d96b8f9bf7d4910ee8a12f1b804067b3e61b4",
        ],
        snapshotHash: "0x77831756e074633b33ecb8d74cbaed95cda5c170d7eeed66c1f65750024749c8",
      });
      for (const field of [
        "ownerId",
        "ownerKind",
        "qualificationId",
        "originalPersonaId",
        "leafSalt",
        "orderKey",
        "credentialId",
      ])
        expect(JSON.stringify(actual.published)).not.toContain(field);
      const signatures = [
        "owner_megapot_lp_private_v1(text)",
        "owner_megapot_u256_private_v1(numeric)",
        "build_owner_megapot_snapshot_private_v1(text,numeric,text,boolean,jsonb)",
        "require_owner_megapot_snapshot_private_v1(text)",
        "require_owner_megapot_allocation_private_v1(text)",
        "owner_megapot_valid_id_private_v1(text)",
      ];
      for (const signature of signatures)
        expect(
          (
            await f.serving.query(
              "SELECT has_function_privilege(current_user,$1::regprocedure,'EXECUTE') AS allowed",
              [signature],
            )
          ).rows,
        ).toEqual([{ allowed: false }]);
      await expect(
        f.serving.query(
          "SELECT build_owner_megapot_snapshot_private_v1($1,$2,$3,FALSE,$4::jsonb)",
          ["pool_fixture", "7", terms, input],
        ),
      ).rejects.toMatchObject({ code: "42501" });
      for (const invalid of [
        [],
        [beneficiaries[0], beneficiaries[0]],
        [{ ...beneficiaries[1], originalPersonaId: "fabricated" }],
        [{ ...beneficiaries[0], leafSalt: "0x01" }],
        [{ ...beneficiaries[0], unexpected: "private" }],
      ])
        await expect(
          f.admin.query(
            "SELECT build_owner_megapot_snapshot_private_v1($1,$2,$3,FALSE,$4::jsonb)",
            ["pool_fixture", "7", terms, JSON.stringify(invalid)],
          ),
        ).rejects.toMatchObject({ code: "GP003" });
      await expect(
        f.admin.query("SELECT owner_megapot_u256_private_v1($1)", [(1n << 256n).toString()]),
      ).rejects.toMatchObject({ code: "GP003" });
      const accountLeaf = beneficiaries.find((leaf) => leaf.ownerKind === "account");
      if (accountLeaf === undefined) throw new Error("Original pure Account codec vector required");
      const invalidIds = [
        "a b",
        "a\tb",
        "a\nb",
        "a\u0001b",
        "a\u007fb",
        "a\u00a0b",
        "a\u1680b",
        "a\u2000b",
        "a\u200ab",
        "a\u2028b",
        "a\u2029b",
        "a\u202fb",
        "a\u205fb",
        "a\u3000b",
        "a\ufeffb",
        "x".repeat(129),
        "😀".repeat(65),
      ];
      for (const id of invalidIds) {
        expect(
          (await f.admin.query("SELECT owner_megapot_valid_id_private_v1($1) AS valid", [id])).rows,
        ).toEqual([{ valid: false }]);
        for (const field of ["pool", "ownerId", "qualificationId", "originalPersonaId"] as const) {
          const leaves = [{ ...accountLeaf, ...(field === "pool" ? {} : { [field]: id }) }];
          const pool = field === "pool" ? id : "pool_fixture";
          expect(() =>
            buildMegapotOwnerBeneficiarySnapshot({
              poolLegId: pool,
              drawingId: 7n,
              termsHash: terms,
              fallback: false,
              beneficiaries: leaves,
              sha256: digest,
            }),
          ).toThrow();
          await expect(
            f.admin.query(
              "SELECT build_owner_megapot_snapshot_private_v1($1,$2,$3,FALSE,$4::jsonb)",
              [pool, "7", terms, JSON.stringify(leaves)],
            ),
          ).rejects.toMatchObject({ code: "GP003" });
        }
      }
      // NEL U+0085 is NOT ECMAScript whitespace. Supplementary scalar counts
      // use UTF16 code units, so64 astral characters is the exact128 boundary.
      for (const id of ["x".repeat(128), "😀".repeat(64), "a\u0085b"]) {
        expect(
          (await f.admin.query("SELECT owner_megapot_valid_id_private_v1($1) AS valid", [id])).rows,
        ).toEqual([{ valid: true }]);
        for (const field of ["pool", "ownerId", "qualificationId", "originalPersonaId"] as const) {
          const leaves = [{ ...accountLeaf, ...(field === "pool" ? {} : { [field]: id }) }];
          const pool = field === "pool" ? id : "pool_fixture";
          const native = (
            await f.admin.query(
              "SELECT build_owner_megapot_snapshot_private_v1($1,$2,$3,FALSE,$4::jsonb) AS result",
              [pool, "7", terms, JSON.stringify(leaves)],
            )
          ).rows[0]?.result;
          expect(native).toEqual(
            buildMegapotOwnerBeneficiarySnapshot({
              poolLegId: pool,
              drawingId: 7n,
              termsHash: terms,
              fallback: false,
              beneficiaries: leaves,
              sha256: digest,
            }),
          );
        }
      }
      // Exact owning native functions must FIRST wait behind an independently
      // retained exclusive topology writer. No fake draw/owner/claim is seeded.
      // This probes entry lock order only, not successful money/readiness.
      const calls = [
        "SELECT freeze_owner_megapot_drawing_private_v1($1,$2,NULL::jsonb)",
        "SELECT prepare_owner_megapot_commitment_private_v1($1,$2,'absent_snapshot','{}','absent_hash','absent_key','absent_signature')",
        "SELECT confirm_owner_megapot_commitment_private_v1($1,$2,'absent_effect','absent_hash','absent_reference',clock_timestamp())",
        "SELECT allocate_owner_megapot_winnings_private_v1($1,$2)",
      ];
      const bounded = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("Owned native topology probe did not settle")),
                milliseconds,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      };
      for (const text of calls) {
        const peer = new Client({
          connectionString: pgUrl,
          options: `-c search_path=${f.schema}`,
          connectionTimeoutMillis: 2000,
          statement_timeout: 3000,
          query_timeout: 3500,
        });
        let original:
          | Promise<{ state: "success" } | { state: "error"; error: unknown }>
          | undefined;
        let primary: unknown,
          failed = false;
        const cleanup: unknown[] = [];
        try {
          await bounded(peer.connect(), 2500);
          const pid = (await peer.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          const blocker = (await f.admin.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
          if (!Number.isInteger(pid) || !Number.isInteger(blocker))
            throw new Error("Actual owned peer backend required");
          await f.admin.query("BEGIN");
          await f.admin.query("SELECT pg_advisory_xact_lock(83000003,1)");
          // Immediate handled observation; actual function output is never faked.
          original = peer.query(text, ["absent_topology_probe_pool", "7"]).then(
            () => ({ state: "success" as const }),
            (error) => ({ state: "error" as const, error }),
          );
          const deadline = Date.now() + 1000;
          let waiting = false;
          while (Date.now() < deadline) {
            const state = (
              await f.admin.query(
                "SELECT $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocked, wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1",
                [pid, blocker],
              )
            ).rows[0];
            if (
              state?.blocked === true &&
              state.wait_event_type === "Lock" &&
              state.wait_event === "advisory"
            ) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(waiting).toBe(true);
          await f.admin.query("ROLLBACK");
          const result = await bounded(original, 4000);
          expect(result.state).toBe("error");
          // Post-barrier missing-source/closed-readiness rejection earns no
          // readiness or successful financial pipeline credit.
        } catch (error) {
          primary = error;
          failed = true;
        } finally {
          try {
            await bounded(f.admin.query("ROLLBACK"), 3000);
          } catch (error) {
            cleanup.push(error);
            f.deferDestructiveCleanup();
          }
          if (original !== undefined)
            try {
              await bounded(original, 4000);
            } catch (error) {
              cleanup.push(error);
              f.deferDestructiveCleanup();
            }
          // Attempt physical close even after failed acquisition/drain.
          try {
            await bounded(peer.end(), 2000);
          } catch (error) {
            cleanup.push(error);
            f.deferDestructiveCleanup();
          }
        }
        if (cleanup.length > 0)
          throw new AggregateError(
            failed ? [primary, ...cleanup] : cleanup,
            "Owned topology probe cleanup requires physical parent barrier",
          );
        if (failed) throw primary;
      }
      // The source DDL must retain exact owner/ordinal integrity while removing
      // only the erroneous raw-order UNIQUE that conflicts with tie-breaking.
      expect(
        (
          await f.admin.query(
            "SELECT count(*)::INTEGER AS count FROM pg_constraint WHERE conrelid='megapot_owner_snapshot_leaves'::regclass AND contype='u' AND pg_get_constraintdef(oid)='UNIQUE (snapshot_id, order_key)'",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
    });
  }, 180000);
});
