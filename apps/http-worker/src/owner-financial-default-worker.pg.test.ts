// Owned five-principal default/HNS extension. No mutable candidate or true verifier.
import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  GuestAuthorityV1,
  GuestStudyPreparedContentV2,
  ListMyOwnerParticipationsV1,
  ListMyOwnerRewardCreditsV1,
} from "@pirate/contracts";
import { Schema } from "effect";
import { pgUrl, q } from "../../../packages/platform-cf/src/account-study-producer.pg-fixture.ts";
import { ownerFinancialGuestStudyReadinessSource } from "../../../packages/platform-cf/src/owner-financial-guest-study-readiness-source.ts";
import { ownerFinancialInheritedSourceDefaults } from "../../../packages/platform-cf/src/owner-financial-inherited-source-defaults.ts";
import { Browser, defaultWorkerFixture, source } from "./guest-study-default-worker.pg-fixture.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const pgTest = pgUrl ? test : test.skip;
async function adoptedSource() {
  const actual = await readFile(
    new URL(
      "../../../packages/platform-cf/src/owner-financial-guest-study-readiness-source.ts",
      import.meta.url,
    ),
  );
  expect(createHash("sha256").update(actual).digest("hex")).toBe(
    "fc69608523ff80f27abbd533e7364ee44d719ca138c9ce2d6e2b2e22d6ead003",
  );
  const value = ownerFinancialGuestStudyReadinessSource;
  if (value === null)
    throw new Error("Actual independently bound non-NULL compiled financial source required");
  expect(value.candidate.ledger).toHaveLength(267);
  expect(value.candidate.native_function_bodies).toHaveLength(423);
  expect(value.candidate.profiles.ordinaryAccount.functions).toHaveLength(124);
  return value;
}
async function decoded<S extends Schema.ConstraintDecoder<unknown>>(
  response: Response,
  schema: S,
): Promise<S["Type"]> {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(await response.json());
}
type WorkerFixture = Parameters<Parameters<typeof defaultWorkerFixture>[0]>[0];
async function accountBrowser(f: WorkerFixture) {
  const browser = new Browser();
  browser.cookies.set("__Host-pirate_session", await f.ordinarySessionToken());
  return browser;
}
async function bootstrap(
  browser: Browser,
  call: (
    name: "GetGuestAuthorityV1" | "IssueGuestBootstrapV1" | "ConfirmGuestBootstrapV1",
    body?: unknown,
  ) => Promise<Response>,
  key: string,
) {
  const discovered = await call("GetGuestAuthorityV1");
  expect(discovered.status).toBe(200);
  browser.apply(discovered);
  expect((await decoded(discovered, GuestAuthorityV1)).state).toBe("absent");
  const issued = await call("IssueGuestBootstrapV1", { idempotency_key: key });
  expect(issued.status).toBe(200);
  browser.apply(issued);
  const selected = (await decoded(issued, GuestAuthorityV1)).selected;
  if (selected === null) throw new Error("Real pending Guest authority required");
  browser.selected = selected.credential_id;
  const confirmed = await call("ConfirmGuestBootstrapV1", {
    credential_id: selected.credential_id,
    expected_owner_id: selected.owner_id,
  });
  expect(confirmed.status).toBe(200);
  browser.apply(confirmed);
  expect((await decoded(confirmed, GuestAuthorityV1)).state).toBe("confirmed");
  return selected;
}
pgTest(
  "actual default Worker binds five restricted LOGINs and compiled financial source before public/Account/Guest dispatch",
  async () => {
    await defaultWorkerFixture(
      async (f) => {
        const ordinary = f.principals.ordinaryAccount;
        if (ordinary === undefined) throw new Error("Actual fifth LOGIN required");
        const roles = Object.values(f.principals).map((p) => p.role);
        expect(new Set(roles).size).toBe(5);
        for (const p of Object.values(f.principals))
          expect(
            (
              await p.client.query(
                "SELECT current_user=session_user AS direct,rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user",
              )
            ).rows,
          ).toEqual([{ direct: true, rolsuper: false, rolbypassrls: false, rolinherit: false }]);
        await f.inspector.verify();
        const before = await f.snapshot(),
          worker = await f.makeWorker();
        const prepared = await f.request(
          worker,
          new Browser(),
          "GetPublicGuestStudyPreparedContentV2",
          { path: source },
        );
        expect(prepared.status).toBe(200);
        const content = await decoded(prepared, GuestStudyPreparedContentV2);
        expect(content.reward_preview).toBeNull();
        expect(content.reward_preview_terms_hash).toBeNull();
        const account = await accountBrowser(f);
        const credits = await f.request(worker, account, "ListMyOwnerRewardCreditsV1");
        expect(credits.status).toBe(200);
        expect((await decoded(credits, ListMyOwnerRewardCreditsV1.response)).items).toEqual([]);
        const parts = await f.request(worker, account, "ListMyOwnerParticipationsV1");
        expect(parts.status).toBe(200);
        expect((await decoded(parts, ListMyOwnerParticipationsV1.response)).items).toEqual([]);
        const browser = new Browser();
        await bootstrap(
          browser,
          (name, body) => f.request(worker, browser, name, body === undefined ? {} : { body }),
          "financial-default-authority",
        );
        const after = await f.snapshot();
        expect(after.guests).toBe(before.guests + 1);
        for (const k of [
          "accounts",
          "personas",
          "memberships",
          "calls",
          "checkpoints",
          "uploads",
        ] as const)
          expect(after[k]).toBe(before[k]);
        expect(f.providerCalls()).toBe(0);
        expect(f.objects.size).toBe(0);
      },
      await adoptedSource(),
    );
  },
  120000,
);
pgTest(
  "five-principal graph uses genuine HNS Access/HMAC and initiating-origin Guest proof with Account-only recovery reads",
  async () => {
    await defaultWorkerFixture(
      async (f) => {
        const direct = await f.makeWorker(),
          hns = await f.makeHns(),
          ordinary = new Browser();
        const original = await bootstrap(
          ordinary,
          (name, body) => f.request(direct, ordinary, name, body === undefined ? {} : { body }),
          "financial-direct-proof",
        );
        const before = await f.snapshot();
        const refused = await f.forwarded(hns, ordinary, "RenewGuestAuthorityV1", {
          body: { expected_owner_id: original.owner_id },
        });
        expect(refused.status).toBe(401);
        expect(await f.snapshot()).toEqual(before);
        const app = new Browser();
        const attached = await bootstrap(
          app,
          (name, body) => f.forwarded(hns, app, name, body === undefined ? {} : { body }),
          "financial-hns-proof",
        );
        expect(attached.owner_id).not.toBe(original.owner_id);
        const publicRead = await f.forwarded(hns, app, "GetPublicGuestStudyPreparedContentV2", {
          path: source,
        });
        expect(publicRead.status).toBe(200);
        expect((await decoded(publicRead, GuestStudyPreparedContentV2)).reward_preview).toBeNull();
        // Account-only reads ignore even a foreign-origin Guest cookie/selector.
        const account = await accountBrowser(f);
        for (const [key, value] of ordinary.cookies) account.cookies.set(key, value);
        account.selected = ordinary.selected;
        const parts = await f.forwarded(hns, account, "ListMyOwnerParticipationsV1");
        expect(parts.status).toBe(200);
        expect((await decoded(parts, ListMyOwnerParticipationsV1.response)).items).toEqual([]);
        const credits = await f.forwarded(hns, account, "ListMyOwnerRewardCreditsV1");
        expect(credits.status).toBe(200);
        expect((await decoded(credits, ListMyOwnerRewardCreditsV1.response)).items).toEqual([]);
        expect(hns.keyReads()).toBe(1);
        expect(f.providerCalls()).toBe(0);
        expect(f.objects.size).toBe(0);
      },
      await adoptedSource(),
    );
  },
  120000,
);
pgTest(
  "actual ordinary private-table ACL drift closes all four financial reads before decoder and restores positive readiness",
  async () => {
    await defaultWorkerFixture(
      async (f) => {
        const ordinary = f.principals.ordinaryAccount;
        if (ordinary === undefined) throw new Error("Actual fifth LOGIN required");
        const worker = await f.makeWorker(),
          hns = await f.makeHns(),
          account = await accountBrowser(f),
          before = await f.snapshot();
        const grant = `GRANT SELECT ON TABLE ${q(f.schema)}.owner_participation_admission_operations TO ${q(ordinary.role)}`;
        const revoke = `REVOKE SELECT ON TABLE ${q(f.schema)}.owner_participation_admission_operations FROM ${q(ordinary.role)}`;
        let armed = true;
        const restore = async () => {
          if (armed) {
            await f.admin.query(revoke);
            armed = false;
          }
        };
        f.registerRestoration(restore);
        let failed = false,
          primary: unknown;
        const cleanup: unknown[] = [];
        try {
          await f.admin.query(grant);
          await expect(f.inspector.verify()).rejects.toThrow(
            "Managed Guest Study readiness unavailable",
          );
          for (const [name, path] of [
            ["ListMyOwnerRewardCreditsV1", {}],
            ["ListMyOwnerParticipationsV1", {}],
            ["GetMyOwnerRewardCreditV1", { creditId: "x".repeat(129) }],
            ["GetMyOwnerParticipationV1", { participationId: "x".repeat(129) }],
          ] as const) {
            // Invalid detail locators would produce400 if decoding bypassed readiness.
            const response = await f.request(worker, account, name, { path });
            expect(response.status).toBe(500);
            expect(response.headers.get("cache-control")).toBe("private, no-store");
            expect(response.headers.getSetCookie()).toHaveLength(0);
          }
          const forwarded = await f.forwarded(hns, account, "GetMyOwnerParticipationV1", {
            path: { participationId: "x".repeat(129) },
          });
          expect(forwarded.status).toBe(500);
          expect(forwarded.headers.getSetCookie()).toHaveLength(0);
          expect(await f.snapshot()).toEqual(before);
          expect(f.providerCalls()).toBe(0);
          expect(f.objects.size).toBe(0);
        } catch (error) {
          failed = true;
          primary = error;
        } finally {
          try {
            await restore();
          } catch (error) {
            cleanup.push(error);
          }
        }
        if (failed || cleanup.length)
          throw new AggregateError(
            [...(failed ? [primary] : []), ...cleanup],
            "Owned ordinary-profile fault failed or restoration incomplete",
          );
        await f.inspector.verify();
        // A missing inherited PUBLIC capability is equally an actual failure;
        // it is not ignored because it is not a purpose-specific callback.
        const inherited = ownerFinancialInheritedSourceDefaults[0];
        if (inherited === undefined) throw new Error("Exact inherited source required");
        const restoreInheritedSql = `GRANT EXECUTE ON FUNCTION ${q(f.schema)}.${inherited.signature} TO PUBLIC`;
        let inheritedArmed = true;
        const restoreInherited = async () => {
          if (inheritedArmed) {
            await f.admin.query(restoreInheritedSql);
            inheritedArmed = false;
          }
        };
        f.registerRestoration(restoreInherited);
        let inheritedFailed = false,
          inheritedPrimary: unknown;
        const inheritedCleanup: unknown[] = [];
        try {
          await f.admin.query(
            `REVOKE EXECUTE ON FUNCTION ${q(f.schema)}.${inherited.signature} FROM PUBLIC`,
          );
          await expect(f.inspector.verify()).rejects.toThrow(
            "Managed Guest Study readiness unavailable",
          );
          expect((await f.request(worker, account, "ListMyOwnerParticipationsV1")).status).toBe(
            500,
          );
          expect(await f.snapshot()).toEqual(before);
        } catch (error) {
          inheritedFailed = true;
          inheritedPrimary = error;
        } finally {
          try {
            await restoreInherited();
          } catch (error) {
            inheritedCleanup.push(error);
          }
        }
        if (inheritedFailed || inheritedCleanup.length)
          throw new AggregateError(
            [...(inheritedFailed ? [inheritedPrimary] : []), ...inheritedCleanup],
            "Owned inherited-function fault or restoration failed",
          );
        await f.inspector.verify();
        const response = await f.request(worker, account, "ListMyOwnerParticipationsV1");
        expect(response.status).toBe(200);
        expect((await decoded(response, ListMyOwnerParticipationsV1.response)).items).toEqual([]);
      },
      await adoptedSource(),
    );
  },
  120000,
);
