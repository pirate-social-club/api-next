import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { Effect } from "effect";
import { Client } from "pg";
import { danceServingGrantPlan } from "../../../scripts/dance-serving-grant-plan.ts";
import {
  DANCE_SERVING_CONSUMERS,
  type DanceServingConsumer,
  danceServingPrivilegeParameters,
} from "../../../scripts/dance-serving-permission-contract.ts";
import {
  assertDanceServingPrivileges,
  DANCE_SERVING_PRIVILEGES_SQL,
} from "../../../scripts/dance-serving-permission-query.ts";
import { runDanceServingPermissionsPreflight } from "../../../scripts/dance-serving-permissions-preflight.ts";
import { withDanceServingPermissionFixture } from "./dance-serving-permissions.pg-fixture.ts";
import { makeControlPlaneNotificationDeliveryStore } from "./notification-delivery-repository.ts";
import { makeDirectPostgresControlPlaneLayer } from "./postgres.ts";
import { proveSongFundingPermissions } from "./song-funding-permissions.pg-proof.ts";
import { makeVideoSourceGrantResolver } from "./video-source-grant-resolver.ts";

const url = process.env.CONTROL_PLANE_POSTGRES_TEST_URL;
if (process.env.CONTROL_PLANE_POSTGRES_TEST_REQUIRED === "1" && !url)
  throw Error("Disposable native PostgreSQL target required");
const suite = url ? describe : describe.skip;
setDefaultTimeout(30000);

suite("native source-bound Dance serving permission plan", () => {
  test("distinct Funding purposes coexist with all four unchanged Dance identities through migrations 318 to 323", async () => {
    if (!url) throw Error("Disposable native target required");
    await proveSongFundingPermissions(url);
  }, 120_000);

  test("actual migration ACLs and purpose bindings admit all four consumers without raw data or erasure authority", async () => {
    if (!url) throw Error("Disposable native target required");
    await withDanceServingPermissionFixture(url, async (f) => {
      const consumers = Object.keys(DANCE_SERVING_CONSUMERS) as DanceServingConsumer[];
      const targets = new Map<DanceServingConsumer, Awaited<ReturnType<typeof f.makeRole>>>();
      for (const consumer of consumers) {
        const target = await f.makeRole();
        targets.set(consumer, target);
        if (consumer === "apps/video-source-gateway/wrangler.jsonc")
          await f.gatewayBase(target.role);
        await expect(
          runDanceServingPermissionsPreflight(target.url, consumer, f.schema),
        ).rejects.toThrow("permissions refused");
        await f.apply(f.plan(target.role, [consumer]));
        expect(await runDanceServingPermissionsPreflight(target.url, consumer, f.schema)).toBe(
          target.role,
        );
      }
      const http = targets.get("apps/http-worker/wrangler.jsonc"),
        jobs = targets.get("apps/jobs-worker/wrangler.jsonc"),
        gateway = targets.get("apps/video-source-gateway/wrangler.jsonc");
      if (!http || !jobs || !gateway) throw Error("Consumer fixture missing");
      expect(
        await Effect.runPromise(
          makeControlPlaneNotificationDeliveryStore(
            makeDirectPostgresControlPlaneLayer(jobs.url),
          ).recover(),
        ),
      ).toEqual({ examined: 0, processed: 0, delivered: 0, suppressed: 0 });
      expect(
        await makeVideoSourceGrantResolver(
          makeDirectPostgresControlPlaneLayer(gateway.url),
        ).resolve("A".repeat(43), new AbortController().signal),
      ).toBeNull();
      await f.owner.query("ALTER FUNCTION resolve_moderated_dance_source_v1(TEXT) VOLATILE");
      await expect(
        runDanceServingPermissionsPreflight(
          gateway.url,
          "apps/video-source-gateway/wrangler.jsonc",
          f.schema,
        ),
      ).rejects.toThrow();
      await f.owner.query("ALTER FUNCTION resolve_moderated_dance_source_v1(TEXT) STABLE");
      // The production read-only constructor pins api_next. This test uses the
      // direct scoped-schema adapter to exercise the unchanged resolver SQL.
      const probe = () =>
        runDanceServingPermissionsPreflight(http.url, "apps/http-worker/wrangler.jsonc", f.schema);
      const client = new Client({ connectionString: http.url });
      await client.connect();
      try {
        await expect(
          client.query("SELECT begin_moderated_dance_account_erasure_v1('absent')"),
        ).rejects.toMatchObject({ code: "42501" });
        await f.owner.query(
          `GRANT SELECT(session_id) ON dance_moderated_sessions_v1 TO ${f.quote(http.role)}`,
        );
        await expect(probe()).rejects.toThrow();
        await f.owner.query(
          `REVOKE SELECT(session_id) ON dance_moderated_sessions_v1 FROM ${f.quote(http.role)}`,
        );
        await f.owner.query(
          `REVOKE EXECUTE ON FUNCTION read_owned_moderated_dance_capture_context_v1(TEXT,TEXT,TEXT) FROM ${f.quote(http.role)}`,
        );
        await expect(probe()).rejects.toThrow();
        await f.owner.query(
          `GRANT EXECUTE ON FUNCTION read_owned_moderated_dance_capture_context_v1(TEXT,TEXT,TEXT) TO ${f.quote(http.role)}`,
        );
        await f.owner.query(
          "GRANT EXECUTE ON FUNCTION read_owned_moderated_dance_capture_context_v1(TEXT,TEXT,TEXT) TO PUBLIC",
        );
        await expect(probe()).rejects.toThrow();
        await f.owner.query(
          "REVOKE EXECUTE ON FUNCTION read_owned_moderated_dance_capture_context_v1(TEXT,TEXT,TEXT) FROM PUBLIC",
        );
        await f.owner.query(
          `ALTER FUNCTION read_owned_moderated_dance_capture_context_v1(TEXT,TEXT,TEXT) SET search_path=public`,
        );
        await expect(probe()).rejects.toThrow();
        await f.owner.query(
          `ALTER FUNCTION read_owned_moderated_dance_capture_context_v1(TEXT,TEXT,TEXT) SET search_path=${f.quote(f.schema)},pg_catalog,pg_temp`,
        );
        await f.admin.query(
          `GRANT ${f.quote(f.ownerRole)} TO ${f.quote(http.role)} WITH INHERIT FALSE, SET TRUE`,
        );
        await expect(probe()).rejects.toThrow();
        await client.query(`SET ROLE ${f.quote(f.ownerRole)}`);
        const switched = await client.query(DANCE_SERVING_PRIVILEGES_SQL, [
          ...danceServingPrivilegeParameters(f.schema, "apps/http-worker/wrangler.jsonc"),
        ]);
        expect(() =>
          assertDanceServingPrivileges(switched.rows, "apps/http-worker/wrangler.jsonc"),
        ).toThrow();
        await client.query("RESET ROLE");
        await f.admin.query(`REVOKE ${f.quote(f.ownerRole)} FROM ${f.quote(http.role)}`);
        expect(await probe()).toBe(http.role);
      } finally {
        await client.end();
      }

      const spare = await f.makeRole(),
        original = f.plan(spare.role, ["apps/http-worker/wrangler.jsonc"]);
      await expect(
        f.apply(
          danceServingGrantPlan({
            role: spare.role,
            schema: f.schema,
            consumers: ["apps/http-worker/wrangler.jsonc"],
            ledgerSha256: "a".repeat(64),
          }),
        ),
      ).rejects.toThrow();
      // A late failure must roll back both EXECUTE and the purpose registry.
      const injected = [...original.statements];
      injected.splice(
        -2,
        0,
        `GRANT SELECT ON dance_moderated_sessions_v1 TO ${f.quote(spare.role)}`,
      );
      await expect(f.apply({ ...original, statements: injected })).rejects.toThrow();
      expect(
        (
          await f.owner.query(
            "SELECT has_function_privilege($1,'read_moderated_dance_capture_options_v1(text,text,text,text)','EXECUTE') allowed",
            [spare.role],
          )
        ).rows,
      ).toEqual([{ allowed: false }]);
      expect(
        (
          await f.owner.query(
            "SELECT count(*)::int n FROM dance_moderated_runtime_roles_v1 WHERE role_oid=$1::regrole::oid",
            [spare.role],
          )
        ).rows,
      ).toEqual([{ n: 0 }]);
    });
  });
});
