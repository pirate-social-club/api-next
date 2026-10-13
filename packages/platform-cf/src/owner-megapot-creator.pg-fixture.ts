/** Narrow owned extension of the maintained genuine rewarded journey fixture.
 * Expected ordinary123 is a reviewed committed literal, never observed grants. */
import { expect } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  Clock,
  IdGen,
  makeSongRewardOfferService,
  prepareActivityPersona,
} from "@pirate/application";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import { keccak256 } from "viem";
import { bounded } from "./account-study-producer.pg-fixture.ts";
import { confirmWallet } from "./activity-participation-composed-identity.pg-fixture.ts";
import { makeControlPlaneMegapotDrawingObservationStore } from "./megapot-drawing-observation-repository.ts";
import { ownerFinancialInheritedSourceDefaults } from "./owner-financial-inherited-source-defaults.ts";
import {
  type RewardedFixture,
  rewardedFixture,
} from "./owner-megapot-rewarded-journey.pg-fixture.ts";
import { hash, pgUrl, q, run } from "./owner-study-starter.pg-fixture.ts";
import {
  makeControlPlanePersonaStore,
  makeControlPlanePersonaWalletStore,
} from "./persona-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRewardFundingStore } from "./reward-funding-repository.ts";
import {
  makeControlPlaneOwnerMegapotPoolLegCreator,
  makeControlPlaneSongRewardOfferStore,
} from "./song-reward-offer-repository.ts";

export const actor = "study-account";
export const endpoint = "/reward-offers/:offerId/megapot-pool-legs";
const creatorSignature = "authorize_owner_megapot_leg_creation_v1(text,text,text,text)";
export const bytecode = {
  jackpot: "0x6001",
  ticket: "0x6002",
  usdc: "0x6003",
} as const;
export const address = (c: string) => `0x${c.repeat(40)}`;
const Profile = Schema.Struct({
  columns: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  functions: Schema.Array(Schema.String),
  column_grants: Schema.Array(
    Schema.Struct({
      table_name: Schema.String,
      column_name: Schema.String,
      privilege: Schema.Literals(["SELECT", "INSERT", "UPDATE"]),
    }),
  ),
  table_grants: Schema.Array(
    Schema.Struct({
      table_name: Schema.String,
      privilege: Schema.Literal("DELETE"),
    }),
  ),
  sequence_grants: Schema.Array(
    Schema.Struct({ sequence_name: Schema.String, privilege: Schema.String }),
  ),
});
export const withClock = <A, E>(effect: Effect.Effect<A, E, Clock | IdGen>) =>
  run(
    effect.pipe(
      Effect.provideService(Clock, { now: Effect.sync(() => Date.now()) }),
      Effect.provideService(IdGen, {
        next: Effect.sync(() => crypto.randomUUID()),
      }),
    ),
  );
export const observed = <A>(promise: Promise<A>) =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
export async function peer(f: RewardedFixture) {
  if (pgUrl === undefined) throw new Error("Owned loopback PG required");
  const url = new URL(pgUrl);
  url.searchParams.set("options", `-c search_path=${f.schema},pg_catalog`);
  const client = new Client({
    connectionString: url.toString(),
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
  });
  // Observe transport events without logging data; actual query promises retain failures.
  client.on("error", () => {});
  let connected = false,
    failed = false,
    primary: unknown;
  const cleanup: unknown[] = [];
  try {
    await bounded(client.connect(), "creator peer connect", 3000);
    connected = true;
  } catch (error) {
    failed = true;
    primary = error;
  } finally {
    if (!connected)
      try {
        await bounded(client.end(), "creator failed-peer close", 2000);
      } catch (error) {
        cleanup.push(error);
      }
  }
  if (failed || cleanup.length)
    throw new AggregateError(
      [...(failed ? [primary] : []), ...cleanup],
      "Owned creator peer acquisition failed",
    );
  return client;
}
export async function waitForRoleLock(f: RewardedFixture, role: string) {
  const expires = Date.now() + 200;
  for (;;) {
    const rows = (
      await f.admin.query(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock' AND state='active') AS waiting",
        [role],
      )
    ).rows;
    const value = Schema.decodeUnknownSync(
      Schema.Array(Schema.Struct({ waiting: Schema.Boolean })),
      { onExcessProperty: "error" },
    )(rows);
    if (value.length !== 1) throw new Error("One owned wait observation required");
    if (value[0]?.waiting === true) return;
    if (Date.now() >= expires)
      throw new Error(
        "Creator did not enter actual native lock wait before unchanged application statement bound",
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}
export async function creatorFixture(
  use: (
    f: RewardedFixture & {
      ordinaryRole: string;
      ordinaryUrl: string;
      ordinary: Client;
      ordinaryRuntime: ReturnType<typeof makeDirectPostgresControlPlaneLayer>;
    },
  ) => Promise<void>,
  canonical = false,
) {
  await rewardedFixture(
    async (f) => {
      const bytes = await readFile(
        new URL("./owner-megapot-creator-profile.pg-fixture.json", import.meta.url),
        "utf8",
      );
      // Pin exactly the independently accepted literal; caller/env never supplies expected grants.
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        "dc98ecb01a8d57944eb543c3882e3eaf7b345040af6c88846d663da37c79d58b"
      )
        throw new Error("Reviewed creator123 profile differs");
      const profile = Schema.decodeUnknownSync(Profile, {
        onExcessProperty: "error",
      })(JSON.parse(bytes));
      expect(profile.functions).toHaveLength(123);
      expect(new Set(profile.functions).size).toBe(123);
      expect(profile.functions.filter((s) => s === creatorSignature)).toHaveLength(1);
      const inherited: readonly string[] = ownerFinancialInheritedSourceDefaults.map(
        (row) => row.signature,
      );
      expect(inherited).toHaveLength(37);
      expect(new Set(inherited).size).toBe(37);
      expect(profile.functions.filter((signature) => inherited.includes(signature))).toHaveLength(
        7,
      );
      const effectiveFunctions = [...new Set([...profile.functions, ...inherited])];
      expect(effectiveFunctions).toHaveLength(153);
      expect(profile.sequence_grants).toEqual([]);
      const native = (
        await f.admin.query(
          `SELECT p.proowner=c.relowner AS owner,p.pronamespace=c.relnamespace AS namespace,
   p.prosecdef AS definer,p.provolatile='v' AS volatile,
   p.proconfig=ARRAY[format('search_path=pg_catalog, %I, pg_temp',n.nspname)] AS pinned,
   encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=$2 AS source,
   NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner AND a.privilege_type='EXECUTE') AS private
   FROM pg_proc p CROSS JOIN pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE p.oid=$1::regprocedure AND c.oid='participation_owners'::regclass`,
          [creatorSignature, "b1d072ded2b7a1206db02130ddcbf96a493f6b761cce3bd289675090c1920899"],
        )
      ).rows;
      expect(native).toEqual([
        {
          owner: true,
          namespace: true,
          definer: true,
          volatile: true,
          pinned: true,
          source: true,
          private: true,
        },
      ]);
      const role = `creator_login_${crypto.randomUUID().replaceAll("-", "")}`,
        password = Array.from(randomBytes(32), (byte) => byte.toString(16).padStart(2, "0")).join(
          "",
        );
      const url = new URL(f.guestUrl);
      url.username = role;
      url.password = password;
      let created = false,
        client: Client | undefined,
        failed = false,
        primary: unknown;
      const cleanup: unknown[] = [];
      try {
        const ddl = Schema.decodeUnknownSync(Schema.Struct({ sql: Schema.String }), {
          onExcessProperty: "error",
        })(
          (
            await f.admin.query(
              "SELECT format('CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',$1::text,$2::text) AS sql",
              [role, password],
            )
          ).rows[0],
        );
        await f.admin.query(ddl.sql);
        created = true;
        await f.admin.query(`GRANT USAGE ON SCHEMA ${q(f.schema)} TO ${q(role)}`);
        // Exact current source-derived privileges. Grouped only to reduce setup round trips.
        const groups = new Map<string, { table: string; privilege: string; columns: string[] }>();
        for (const grant of profile.column_grants) {
          const key = JSON.stringify([grant.table_name, grant.privilege]);
          const group = groups.get(key) ?? {
            table: grant.table_name,
            privilege: grant.privilege,
            columns: [],
          };
          group.columns.push(grant.column_name);
          groups.set(key, group);
        }
        for (const group of groups.values())
          await f.admin.query(
            `GRANT ${group.privilege} (${group.columns.map(q).join(",")}) ON TABLE ${q(f.schema)}.${q(group.table)} TO ${q(role)}`,
          );
        for (const grant of profile.table_grants)
          await f.admin.query(
            `GRANT DELETE ON TABLE ${q(f.schema)}.${q(grant.table_name)} TO ${q(role)}`,
          );
        // Original37 already inherit PUBLIC EXECUTE. Preserve their exact native
        // ACLs by granting only purpose callbacks outside that closed source set.
        for (const signature of profile.functions.filter(
          (signature) => !inherited.includes(signature),
        )) {
          const command = Schema.decodeUnknownSync(Schema.Struct({ sql: Schema.String }), {
            onExcessProperty: "error",
          })(
            (
              await f.admin.query(
                "SELECT format('GRANT EXECUTE ON FUNCTION %I.%s TO %I',$1::text,$2::text,$3::text) AS sql",
                [f.schema, signature, role],
              )
            ).rows[0],
          );
          await f.admin.query(command.sql);
        }
        client = new Client({
          connectionString: url.toString(),
          connectionTimeoutMillis: 3000,
          statement_timeout: 5000,
        });
        client.on("error", () => {});
        await bounded(client.connect(), "creator login connect", 3000);
        // The full private source validator must still accept after actor grants.
        // No inherited PUBLIC ACL, manifest, source frame or helper grant changes.
        await f.admin.query("SELECT require_owner_accounting_ready_private_v1()");
        const FunctionOids = Schema.Array(Schema.Struct({ function_oid: Schema.String }));
        const expectedFunctionOids = Schema.decodeUnknownSync(FunctionOids, {
          onExcessProperty: "error",
        })(
          (
            await client.query(
              `SELECT signature::regprocedure::oid::text AS function_oid
             FROM unnest($1::text[]) signatures(signature)
             ORDER BY signature::regprocedure::oid::text COLLATE "C"`,
              [effectiveFunctions.map((signature) => `${f.schema}.${signature}`)],
            )
          ).rows,
        );
        expect(expectedFunctionOids).toHaveLength(153);
        const actualFunctionOids = Schema.decodeUnknownSync(FunctionOids, {
          onExcessProperty: "error",
        })(
          (
            await client.query(
              `SELECT p.oid::text AS function_oid FROM pg_proc p
             JOIN pg_namespace n ON n.oid=p.pronamespace
             WHERE n.nspname=$1 AND has_function_privilege(current_user,p.oid,'EXECUTE')
             ORDER BY p.oid::text COLLATE "C"`,
              [f.schema],
            )
          ).rows,
        );
        if (JSON.stringify(actualFunctionOids) !== JSON.stringify(expectedFunctionOids)) {
          // Refusal diagnostic only: source-owned expected153 never widens.
          // No OIDs, function bodies, role identities, values or SQL are emitted.
          try {
            const difference = await client.query(
              `WITH expected AS (
                 SELECT to_regprocedure(format('%I.%s',$1::text,signature))::oid AS function_oid
                 FROM unnest($2::text[]) signatures(signature)
               ), actor_role AS (SELECT oid FROM pg_roles WHERE rolname=current_user)
               SELECT format('%s(%s)',p.proname,replace(oidvectortypes(p.proargtypes),', ',',')) AS signature,
                 CASE WHEN has_function_privilege(current_user,p.oid,'EXECUTE') THEN 'unexpected' ELSE 'missing' END AS difference,
                 CASE WHEN format('%s(%s)',p.proname,replace(oidvectortypes(p.proargtypes),', ',','))=ANY($3::text[]) THEN 'purpose_callback'
                   WHEN format('%s(%s)',p.proname,replace(oidvectortypes(p.proargtypes),', ',','))=ANY($4::text[]) THEN 'native_original37'
                   ELSE 'unknown_extra' END AS profile_category,
                 p.prosecdef AS definer,p.proacl IS NULL AS uses_source_default_acl,
                 coalesce((SELECT jsonb_agg(jsonb_build_object(
                   'grantee_kind',CASE WHEN acl.grantee=0 THEN 'PUBLIC' WHEN acl.grantee=p.proowner THEN 'function_owner'
                     WHEN acl.grantee=actor_role.oid THEN 'creator' ELSE 'other_role' END,
                   'grantor_kind',CASE WHEN acl.grantor=p.proowner THEN 'function_owner'
                     WHEN acl.grantor=actor_role.oid THEN 'creator' ELSE 'other_role' END,
                   'privilege',acl.privilege_type,'grantable',acl.is_grantable))
                   FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl),'[]'::jsonb) AS acl
               FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN actor_role
               WHERE n.nspname=$1 AND has_function_privilege(current_user,p.oid,'EXECUTE')
                 IS DISTINCT FROM (p.oid IN(SELECT function_oid FROM expected))
               ORDER BY p.proname COLLATE "C",oidvectortypes(p.proargtypes) COLLATE "C" LIMIT 129`,
              [f.schema, effectiveFunctions, profile.functions, inherited],
            );
            console.error(
              JSON.stringify({
                fixture: "creator-effective-function-surface-refusal",
                expectedPurposeCount: 123,
                expectedInheritedCount: 37,
                expectedEffectiveCount: 153,
                diagnosticLimit: 128,
                truncated: difference.rows.length > 128,
                difference: difference.rows.slice(0, 128),
              }),
            );
          } catch {
            console.error(
              JSON.stringify({
                fixture: "creator-effective-function-surface-refusal",
                diagnostic: "catalogue_unavailable",
              }),
            );
          }
        }
        expect(actualFunctionOids).toEqual(expectedFunctionOids);
        expect(
          (
            await client.query(
              "SELECT current_user=session_user AS same,rolsuper,rolbypassrls,rolinherit,rolcreaterole,rolcreatedb,rolreplication FROM pg_roles WHERE rolname=current_user",
            )
          ).rows,
        ).toEqual([
          {
            same: true,
            rolsuper: false,
            rolbypassrls: false,
            rolinherit: false,
            rolcreaterole: false,
            rolcreatedb: false,
            rolreplication: false,
          },
        ]);
        for (const signature of [
          "require_owner_accounting_ready_private_v1()",
          "owner_credit_canonical_account_private_v1(text)",
          "lock_owner_participation_group_private_v1(text)",
        ]) {
          expect(
            (
              await client.query(
                "SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed",
                [signature],
              )
            ).rows,
          ).toEqual([{ allowed: false }]);
        }
        await expect(
          client.query("SELECT require_owner_accounting_ready_private_v1()"),
        ).rejects.toMatchObject({ code: "42501" });
        for (const table of [
          "owner_accounting_native_source_inventory_v1",
          "megapot_owner_shares",
          "megapot_owner_snapshot_leaves",
          "megapot_owner_allocations",
          "owner_participation_admission_operations",
          "owner_participation_admission_attempts",
          "owner_captured_guest_choice_commands",
          "guest_owner_associations",
          "guest_owner_association_conflicts",
          "participation_eligibility_decisions",
          "reward_credit_persona_bindings",
          "reward_credit_recipient_selections",
          "account_owner_reward_sources",
          "account_owner_reward_operations",
          "participation_owners",
        ]) {
          for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"])
            expect(
              (
                await client.query("SELECT has_table_privilege(current_user,$1,$2) AS allowed", [
                  table,
                  privilege,
                ])
              ).rows,
            ).toEqual([{ allowed: false }]);
          // has_table_privilege alone does not detect illicit column SELECT.
          expect(
            (
              await client.query(
                "SELECT has_any_column_privilege(current_user,$1,'SELECT') AS allowed",
                [table],
              )
            ).rows,
          ).toEqual([{ allowed: false }]);
        }
        const runtime = makeDirectPostgresControlPlaneLayer(url.toString(), {
          connectTimeoutMs: 3000,
          statementTimeoutMs: 2000,
          closeTimeoutMs: 2000,
        });
        await use({
          ...f,
          ordinaryRole: role,
          ordinaryUrl: url.toString(),
          ordinary: client,
          ordinaryRuntime: runtime,
        });
      } catch (error) {
        failed = true;
        primary = error;
      } finally {
        if (client !== undefined)
          try {
            await bounded(client.end(), "creator login close", 2000);
          } catch (error) {
            cleanup.push(error);
          }
        if (created)
          try {
            const own = Schema.decodeUnknownSync(Schema.Struct({ owns: Schema.Boolean }), {
              onExcessProperty: "error",
            })(
              (
                await f.admin.query(
                  "SELECT EXISTS(SELECT 1 FROM pg_shdepend WHERE refobjid=(SELECT oid FROM pg_roles WHERE rolname=$1) AND deptype='o') AS owns",
                  [role],
                )
              ).rows[0],
            );
            if (own.owns) {
              cleanup.push(
                new Error(
                  "Owned creator role unexpectedly owns objects; refuse destructive cleanup",
                ),
              );
            } else {
              await f.admin.query(`DROP OWNED BY ${q(role)}`);
              await f.admin.query(`DROP ROLE ${q(role)}`);
            }
          } catch (error) {
            cleanup.push(error);
          }
      }
      if (failed || cleanup.length)
        throw new AggregateError(
          [...(failed ? [primary] : []), ...cleanup],
          "Creator fixture failed or owned cleanup incomplete",
        );
    },
    canonical ? { canonicalManagedSchema: true } : undefined,
  );
}
export type CreatorFixture = Parameters<Parameters<typeof creatorFixture>[0]>[0];

export async function prepareCreatorSource(f: CreatorFixture, suffix: string) {
  // Genuine original operator/deployment prerequisites, only this owned schema.
  await f.admin.query("BEGIN");
  let configured = false;
  try {
    await f.admin.query(
      "SELECT set_config('pirate.reward_run_lease_requirement_change','deployment',true)",
    );
    await f.admin.query("UPDATE reward_operations_run_lease SET required=TRUE WHERE singleton");
    await f.admin.query("COMMIT");
    configured = true;
  } finally {
    if (!configured) await f.admin.query("ROLLBACK");
  }
  await f.admin.query("SELECT acquire_reward_run_lease_v1($1,600,600)", [
    `owned-creator-${suffix}`,
  ]);
  await f.admin.query(
    "SELECT set_reward_operations_paused_v1(revision,FALSE,'Owned creator source fixture') FROM reward_operations_control WHERE singleton",
  );
  await f.admin.query(
    `INSERT INTO reward_asset_whitelist(chain_id,token_address,decimals,symbol,asset_kind,environment,status,policy_version,activated_at,plain_erc20_verified_at)
 VALUES(84532,$1,6,'USDC','settlement_usdc','staging','active','base-sepolia-usdc-v1',clock_timestamp(),clock_timestamp())`,
    [address("1")],
  );
  await f.admin.query(
    `INSERT INTO megapot_deployment_attestations(attestation_id,environment,chain_id,jackpot_address,usdc_address,ticket_nft_address,custody_address,referrer_address,source_tag,jackpot_code_hash,usdc_code_hash,ticket_nft_code_hash,attestation_block_number,attestation_block_hash,abi_version,status,verified_at)
 VALUES('megapot-base-sepolia-v2','staging',84532,$1,$2,$3,$4,$5,$6,$7,$8,$9,100,$10,'megapot_v2','active',clock_timestamp())`,
    [
      address("2"),
      address("1"),
      address("3"),
      address("4"),
      address("5"),
      `0x${"6".repeat(64)}`,
      keccak256(bytecode.jackpot),
      keccak256(bytecode.usdc),
      keccak256(bytecode.ticket),
      `0x${"a".repeat(64)}`,
    ],
  );
  const personaStore = makeControlPlanePersonaStore(f.adminRuntime);
  const prepared = await run(
    prepareActivityPersona(
      {
        accountId: actor,
        communityId: "study-community",
        body: {
          idempotency_key: `creator-persona-${suffix}`,
          choice: { kind: "create_new" },
        },
      },
      {
        store: personaStore,
        nextPersonaId: () =>
          Effect.sync(() => `persona_${crypto.randomUUID().replaceAll("-", "")}`),
        nowIso: () => Effect.sync(() => new Date().toISOString()),
      },
    ),
  );
  expect(prepared.persona_status).toBe("pending_wallet");
  const personaId = prepared.persona_id;
  const walletPreparation = await run(
    makeControlPlanePersonaWalletStore(f.adminRuntime).getEvmPreparation({
      accountId: actor,
      personaId,
    }),
  );
  if (walletPreparation === null) throw new Error("Genuine prepared persona wallet required");
  expect(walletPreparation.status).toBe("pending");
  const wallet = await confirmWallet(f.adminRuntime)(actor, personaId);
  const now = new Date();
  await run(
    makeControlPlaneMegapotDrawingObservationStore(f.adminRuntime).recordAndOpen({
      observationId: `creator-observation-${suffix}`,
      attestationId: "megapot-base-sepolia-v2",
      chainId: 84532,
      drawingId: 101n,
      grossPrizePoolAtomic: 100000n,
      globalTicketsBought: 10n,
      ticketPriceAtomic: 10000n,
      drawingTime: new Date(now.getTime() + 3600000).toISOString(),
      ballMax: 25,
      bonusballMax: 13,
      drawingLocked: false,
      referralFeeWei: 100000000000000000n,
      referralWinShareWei: 100000000000000000n,
      blockNumber: 101n,
      blockHash: `0x${hash(suffix)}`,
      blockTimestamp: now.toISOString(),
      confirmations: 3,
      observedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 3600000).toISOString(),
      rawStateHash: hash(`state-${suffix}`),
      legacyRawStateHash: hash(`legacy-${suffix}`),
    }),
  );
  const ordinary = makeControlPlaneSongRewardOfferStore(f.ordinaryRuntime),
    creator = makeControlPlaneOwnerMegapotPoolLegCreator(f.ordinaryRuntime),
    funding = makeControlPlaneRewardFundingStore(f.ordinaryRuntime);
  const service = makeSongRewardOfferService({
    store: { ...ordinary, addMegapotPoolLeg: creator.addMegapotPoolLeg },
    funding: {
      plan: (input) =>
        funding
          .plan({
            fundingEffectId: `creator-funding-${suffix}`,
            legId: input.legId,
            funderAccountId: input.funderAccountId,
            senderAddress: input.senderAddress,
            expectedAmountAtomic: input.expectedAmountAtomic,
            requiredConfirmations: input.requiredConfirmations,
          })
          .pipe(
            Effect.flatMap((intent) =>
              intent.state === "planned"
                ? Effect.succeed({ kind: "planned" as const, intent })
                : Effect.fail(new Error("Genuine new planned funding required")),
            ),
          ),
      observe: () =>
        Effect.die(new Error("No provider funding observation in creator source fixture")),
    },
    requiredConfirmations: 3,
    externalFallbackPolicy: null,
  });
  const opened = await withClock(
    service.openOffer({
      accountId: actor,
      personaId,
      communityId: "study-community",
      postId: "study-post",
      idempotencyKey: `creator-offer-${suffix}`,
      startsAt: new Date(Date.now() - 1000).toISOString(),
      endsAt: new Date(Date.now() + 3600000).toISOString(),
    }),
  );
  const legInput = {
    accountId: actor,
    personaId,
    offerId: opened.offer.offerId,
    idempotencyKey: `creator-leg-${suffix}`,
    senderAddress: wallet.address,
    fundingAmountAtomic: 100000n,
    maxTicketPriceAtomic: 10000n,
    entryCutoffSeconds: 300,
    eligibleActivities: ["study"] as const,
    expectedQualificationPolicyVersions: {
      study: "study_session_first_pass_v2@1",
    },
    minScoreBps: 7000,
    emptyPoolPolicy: "no_purchase" as const,
    fallbackPayoutPersonaId: null,
    fallbackDisclosureAcknowledged: false,
  };
  return {
    ordinary,
    creator,
    service,
    personaId,
    offerId: opened.offer.offerId,
    legInput,
  };
}
