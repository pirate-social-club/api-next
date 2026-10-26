import { expect } from "bun:test";
import { Effect, Schema } from "effect";
import { Client } from "pg";
import {
  DANCE_SERVING_CONSUMERS,
  type DanceServingConsumer,
} from "../../../scripts/dance-serving-permission-contract.ts";
import { runDanceServingPermissionsPreflight } from "../../../scripts/dance-serving-permissions-preflight.ts";
import { runSongFundingPermissionsPreflight } from "../../../scripts/song-funding-permissions-preflight.ts";
import {
  makeSongMegapotContributionReads,
  makeSongMegapotContributions,
} from "../../application/src/rewards/song-megapot-contributions.ts";
import { ContributionReceiptV2 } from "../../contracts/src/rewards-song-contributions-v2.ts";
import { withDanceServingPermissionFixture } from "./dance-serving-permissions.pg-fixture.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { makeControlPlaneRewardRunAuthority } from "./reward-operations-control.ts";
import { makeControlPlaneSharedSongContextProducer } from "./shared-song-megapot-production.ts";
import { proveProspectiveSongFunding } from "./song-funding-prospective.pg-proof.ts";
import { seedSongContributionFixture } from "./song-megapot-contribution.pg-fixture.ts";
import {
  makeControlPlaneSongContributionPorts,
  makeControlPlaneSongContributionReadPorts,
  makeControlPlaneSongFundingRecoveryStore,
} from "./song-megapot-contribution-repository.ts";

export async function proveSongFundingPermissions(url: string) {
  await withDanceServingPermissionFixture(
    url,
    async (f) => {
      const http = await f.makeRole(),
        jobs = await f.makeRole();
      await f.owner.query(
        "SELECT bind_reward_contribution_purpose_v2($1,'http_commands'), grant_shared_song_funding_runtime_v2($1,'account')",
        [http.role],
      );
      await f.owner.query(
        "SELECT bind_reward_contribution_purpose_v2($1,'incoming_observer'), bind_reward_contribution_purpose_v2($1,'funding_recovery_jobs'), grant_shared_song_funding_runtime_v2($1,'context_worker')",
        [jobs.role],
      );
      // The five binders omit this supporting direct call. Prove it is needed.
      await expect(
        runSongFundingPermissionsPreflight(jobs.url, "jobs", f.schema),
      ).rejects.toThrow();
      await f.owner.query(
        `GRANT EXECUTE ON FUNCTION require_reward_run_authority_v1() TO ${f.quote(jobs.role)}`,
      );
      const paths = ["lock_song_contribution_context_v2", "read_song_contribution_context_v2"];
      const definitionSnapshot = async () =>
        (
          await f.owner.query(
            "SELECT oid,proowner,proacl,prosrc FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname=ANY($1::text[]) ORDER BY oid",
            [paths],
          )
        ).rows;
      const definitionBefore = await definitionSnapshot();
      const accountingSnapshot = async () =>
        (
          await f.owner.query(`SELECT oid,proowner,prosrc,prosecdef,proconfig,
          (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.grantee,a.privilege_type),'[]'::jsonb)
           FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
           WHERE a.grantee<>0) private_acl
          FROM pg_proc p WHERE p.oid='validate_asset_bonus_leg_accounting()'::regprocedure`)
        ).rows;
      const accountingBefore = await accountingSnapshot();
      expect(accountingBefore[0].prosecdef).toBe(false);
      const missing = await f.owner.query(
        "SELECT proname FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname=ANY($1::text[]) AND proconfig IS NULL ORDER BY proname",
        [paths],
      );
      expect(missing.rows.map((r) => r.proname)).toEqual([...paths].sort());
      await expect(
        runSongFundingPermissionsPreflight(http.url, "http", f.schema),
      ).rejects.toThrow();
      await f.upgrade();
      const expectedDefinitions = definitionBefore.map((row) => ({
        ...row,
        prosrc: row.prosrc
          .replace("FROM personas p JOIN", "FROM personas owned_persona JOIN")
          .replace("u.user_id=p.account_id", "u.user_id=owned_persona.account_id")
          .replace("WHERE p.account_id=", "WHERE owned_persona.account_id=")
          .replace("AND p.persona_id=persona", "AND owned_persona.persona_id=persona")
          .replace(
            "AND p.status IN('active','pending_wallet')",
            "AND owned_persona.status IN('active','pending_wallet')",
          ),
      }));
      expect(await definitionSnapshot()).toEqual(expectedDefinitions);
      expect(await accountingSnapshot()).toEqual(
        accountingBefore.map((row) => ({
          ...row,
          prosecdef: true,
          proconfig: [`search_path=pg_catalog, ${f.schema}, pg_temp`],
        })),
      );
      expect(
        (
          await f.owner.query(
            `SELECT
        has_function_privilege($1,'validate_asset_bonus_leg_accounting()','EXECUTE') http,
        has_function_privilege($2,'validate_asset_bonus_leg_accounting()','EXECUTE') jobs,
        EXISTS(SELECT 1 FROM pg_proc p,
          LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE p.oid='validate_asset_bonus_leg_accounting()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') public`,
            [http.role, jobs.role],
          )
        ).rows,
      ).toEqual([{ http: false, jobs: false, public: false }]);
      expect(await runSongFundingPermissionsPreflight(http.url, "http", f.schema)).toBe(http.role);
      expect(await runSongFundingPermissionsPreflight(jobs.url, "jobs", f.schema)).toBe(jobs.role);
      await expect(
        runSongFundingPermissionsPreflight(http.url, "jobs", f.schema),
      ).rejects.toThrow();
      await expect(
        runSongFundingPermissionsPreflight(jobs.url, "http", f.schema),
      ).rejects.toThrow();

      const dance = [];
      for (const consumer of Object.keys(DANCE_SERVING_CONSUMERS) as DanceServingConsumer[]) {
        const role = await f.makeRole();
        if (consumer === "apps/video-source-gateway/wrangler.jsonc") await f.gatewayBase(role.role);
        await f.apply(f.plan(role.role, [consumer]));
        expect(await runDanceServingPermissionsPreflight(role.url, consumer, f.schema)).toBe(
          role.role,
        );
        await expect(
          runSongFundingPermissionsPreflight(role.url, "http", f.schema),
        ).rejects.toThrow();
        dance.push({ consumer, ...role });
      }
      await expect(
        runDanceServingPermissionsPreflight(http.url, "apps/http-worker/wrangler.jsonc", f.schema),
      ).rejects.toThrow();
      await f.admin.query(`SET search_path TO ${f.quote(f.schema)},pg_catalog`);
      const seeded = await seedSongContributionFixture(f.admin);
      const layer = makeDirectPostgresControlPlaneLayer(http.url);
      const authorize = { authorize: () => Effect.succeed({ accountId: "a" }) };
      const service = (enabled: boolean) =>
        makeSongMegapotContributions(
          makeControlPlaneSongContributionPorts(layer, authorize, { rewardsEnabled: enabled }),
        );
      const scope = { communityId: "community", postId: "post", contributionId: null };
      const request = await seeded.request("a", "purpose_contribution_001");
      const receipt = Schema.decodeUnknownSync(ContributionReceiptV2)(
        await Effect.runPromise(
          service(true).execute("CreateSongMegapotContributionV2", scope, request),
        ),
      );
      expect(typeof receipt.contribution_id).toBe("string");
      // Off mode preserves original receipts; it cannot reopen new admission.
      expect(
        await Effect.runPromise(
          service(false).execute("CreateSongMegapotContributionV2", scope, request),
        ),
      ).toEqual(receipt);
      const reads = makeSongMegapotContributionReads(
        makeControlPlaneSongContributionReadPorts(layer, authorize, { rewardsEnabled: false }),
      );
      expect(
        await Effect.runPromise(
          reads.command(scope, "CreateSongMegapotContributionV2", request.idempotency_key),
        ),
      ).toEqual(receipt);
      const next = await seeded.request("b", "purpose_late_refusal_01", "7");
      const before = async () =>
        (
          await f.owner.query(`SELECT (SELECT count(*) FROM song_megapot_contributions_v2)::int contributions,
        (SELECT count(*) FROM reward_wallet_nonce_leases)::int nonces`)
        ).rows;
      const original = await before();
      await f.owner.query(`CREATE FUNCTION purpose_late_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.idempotency_key='purpose_late_refusal_01' AND NEW.refusal_code IS NULL THEN RAISE EXCEPTION 'fixture refusal' USING ERRCODE='PCV05'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER purpose_late_refusal BEFORE INSERT ON song_megapot_contribution_commands_v2 FOR EACH ROW EXECUTE FUNCTION purpose_late_refusal()`);
      const other = makeSongMegapotContributions(
        makeControlPlaneSongContributionPorts(
          layer,
          { authorize: () => Effect.succeed({ accountId: "b" }) },
          { rewardsEnabled: true },
        ),
      );
      await expect(
        Effect.runPromise(other.execute("CreateSongMegapotContributionV2", scope, next)),
      ).rejects.toMatchObject({
        code: "policy_unavailable",
        refusalReceipt: { allocation: "none" },
      });
      expect(await before()).toEqual(original);

      await Effect.runPromise(
        service(true).execute(
          "RecoverSongMegapotContributionV2",
          { ...scope, contributionId: receipt.contribution_id },
          {
            idempotency_key: "purpose_recovery_0001",
            expected_state_revision: 0,
            purpose: "reconcile_original",
          },
        ),
      );
      const jobsLayer = makeDirectPostgresControlPlaneLayer(jobs.url);
      const authority = makeControlPlaneRewardRunAuthority(jobsLayer);
      await f.admin.query(
        "SELECT set_reward_operations_paused_v1(revision,TRUE,'purpose_fixture_lease') FROM reward_operations_control WHERE singleton",
      );
      await f.admin.query(
        "BEGIN; SET LOCAL pirate.reward_run_lease_requirement_change='deployment'; UPDATE reward_operations_run_lease SET required=TRUE WHERE singleton; COMMIT",
      );
      await expect(Effect.runPromise(authority.ensure())).rejects.toMatchObject({
        reason: "paused",
      });
      await f.admin.query("SELECT acquire_reward_run_lease_v1('purpose-fixture-run',60,60)");
      await f.admin.query(
        "SELECT set_reward_operations_paused_v1(revision,FALSE,'purpose_fixture_running') FROM reward_operations_control WHERE singleton",
      );
      await Effect.runPromise(authority.ensure());
      const store = makeControlPlaneSongFundingRecoveryStore(jobsLayer);
      expect(await Effect.runPromise(store.list(1))).toHaveLength(1);
      const contexts = makeControlPlaneSharedSongContextProducer({
        runtime: jobsLayer,
        now: () => new Date().toISOString(),
        rpcFor: () => {
          throw Error("Empty context queue cannot reach a provider");
        },
      });
      await Effect.runPromise(contexts.run({ enabled: true, ensure: authority.ensure }));
      await proveProspectiveSongFunding({
        admin: f.admin,
        owner: f.owner,
        http: http.url,
        jobs: jobs.url,
      });
      await f.admin.query(
        "SELECT set_reward_operations_paused_v1(revision,TRUE,'purpose_fixture_pause') FROM reward_operations_control WHERE singleton",
      );
      await expect(Effect.runPromise(authority.ensure())).rejects.toMatchObject({
        reason: "paused",
      });
      for (const { consumer, role, url: target } of dance)
        expect(await runDanceServingPermissionsPreflight(target, consumer, f.schema)).toBe(role);
      expect(await runSongFundingPermissionsPreflight(http.url, "http", f.schema)).toBe(http.role);
      expect(await runSongFundingPermissionsPreflight(jobs.url, "jobs", f.schema)).toBe(jobs.role);
      const wrong = new Client({ connectionString: jobs.url });
      await wrong.connect();
      try {
        await expect(
          wrong.query("SELECT reserve_reward_funding_wallet_nonce_v2('{}')"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(wrong.query("SELECT * FROM users")).rejects.toMatchObject({ code: "42501" });
        await wrong.query("CREATE TEMP TABLE purpose_accounting_attachment(leg_id TEXT)");
        await expect(
          wrong.query(`CREATE TRIGGER purpose_accounting_attachment BEFORE INSERT ON
            purpose_accounting_attachment FOR EACH ROW EXECUTE FUNCTION validate_asset_bonus_leg_accounting()`),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await wrong.end();
      }
    },
    318,
  );
}
