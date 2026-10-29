import { describe, expect, test } from "bun:test";
import { decodeHnsDnsHealthDocumentV1 } from "../packages/application/src/hns-host-persistence.ts";
import {
  cookieCensusIdentity,
  requireCookieCensus,
  requireUnchangedCookieCensus,
} from "./hns-staging-gateway/census.mjs";
import { cookieProfileFixture } from "./hns-staging-gateway/cookie.fixture.ts";
import {
  applyCookieProfileSuccessor,
  prepareCookieProfileSuccessor,
} from "./hns-staging-gateway/cookie.mjs";
import {
  decodeCookiePlan,
  NEXT_GATEWAY,
  PREVIOUS_GATEWAY,
  requireCookieManifestPair,
} from "./hns-staging-gateway/cookie-plan.ts";
import { stagingGatewayFixture } from "./hns-staging-gateway/fixture.ts";
import { digest, reference } from "./hns-staging-gateway/identity.mjs";
import {
  applyStagingGatewaySuccessor,
  prepareStagingGatewaySuccessor,
} from "./hns-staging-gateway-successor.mjs";

describe("exact staging cookie-profile successor", () => {
  test("binds the accepted six-field transition and retains old observation provenance/earlier expiry", async () => {
    const input = await cookieProfileFixture();
    expect(reference(input.previousManifest)).toBe(PREVIOUS_GATEWAY);
    expect(reference(input.nextManifest)).toBe(NEXT_GATEWAY);
    requireCookieManifestPair(input.previousManifest, input.nextManifest);
    const plan = await prepareCookieProfileSuccessor(input);
    expect(await prepareCookieProfileSuccessor(input)).toEqual(plan);
    expect(plan.entries.map((entry) => entry.root)).toEqual(["8s28"]);
    expect(plan.census.roots.map((entry) => entry.root)).toEqual(["8s28", "a18n"]);
    expect(plan.census_sha256).toBe(cookieCensusIdentity(input.census));
    expect(plan.entries[0]?.inherited_health_checked_at).toBe(input.states[0].health.checked_at);
    const entry = plan.entries[0];
    if (!entry) throw new Error("Expected selected entry");
    const health = decodeHnsDnsHealthDocumentV1(Buffer.from(entry.health_hex, "hex"));
    expect(Date.parse(plan.execute_by) + health.valid_for_seconds * 1000).toBeLessThan(
      Date.parse(input.states[0].inventory.expires_at),
    );
    expect(entry.health_deadline).toBe(input.states[0].inventory.expires_at);
    expect(decodeCookiePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  test("refuses every mutated, removed or added manifest field, malformed/canonical/profile/schema bytes", async () => {
    const input = await cookieProfileFixture();
    for (const side of ["previousManifest", "nextManifest"] as const) {
      const original = JSON.parse(input[side]);
      for (const field of Object.keys(original)) {
        for (const value of [
          undefined,
          typeof original[field] === "number"
            ? original[field] + 1
            : `${String(original[field])}-changed`,
        ]) {
          const changed = { ...original, [field]: value };
          const candidate = { ...input, [side]: JSON.stringify(changed) };
          expect(() =>
            requireCookieManifestPair(candidate.previousManifest, candidate.nextManifest),
          ).toThrow();
        }
      }
      for (const bad of [
        input[side] + "\n",
        "{}",
        "[]",
        "null",
        JSON.stringify({ ...original, extra: true }),
        JSON.stringify(Object.fromEntries(Object.entries(original).reverse())),
      ]) {
        const candidate = { ...input, [side]: bad };
        expect(() =>
          requireCookieManifestPair(candidate.previousManifest, candidate.nextManifest),
        ).toThrow();
      }
    }
  });

  test("keeps fingerprint and cookie schemas/modes separate before any database query", async () => {
    const cookie = await prepareCookieProfileSuccessor(await cookieProfileFixture());
    const oldInput = await stagingGatewayFixture();
    const old = await prepareStagingGatewaySuccessor(oldInput);
    const client = {
      query: () => {
        throw new Error("must not reach database");
      },
    };
    await expect(
      applyStagingGatewaySuccessor({ client, plan: cookie, confirmedSha256: digest(cookie) }),
    ).rejects.toThrow("Wrong fingerprint plan schema");
    await expect(
      applyCookieProfileSuccessor({ client, plan: old, confirmedSha256: digest(old) }),
    ).rejects.toThrow();
    await expect(
      prepareStagingGatewaySuccessor({
        ...oldInput,
        previousManifest: cookie.previous_manifest,
        nextManifest: cookie.next_manifest,
      }),
    ).rejects.toThrow("Only the Solid ingress fingerprint");
    expect(() => decodeCookiePlan({ ...cookie, arbitrary_roots: ["a18n"] })).toThrow();
    const edited = structuredClone(cookie);
    edited.entries[0]!.health_hex = "00";
    await expect(
      applyCookieProfileSuccessor({ client, plan: edited, confirmedSha256: digest(edited) }),
    ).rejects.toThrow("does not reproduce exactly");
  });

  test("refuses unavailable/unknown selected, live/unknown unselected, omitted hosts/tables and changed/reordered root sets", async () => {
    const base = await cookieProfileFixture();
    requireCookieCensus(base.census, base.states[0]);
    const mutations = [
      (v: typeof base) => {
        v.census.roots.shift();
      },
      (v: typeof base) => {
        v.census.roots.reverse();
      },
      (v: typeof base) => {
        v.census.roots.push(v.census.roots[1]!);
      },
      (v: typeof base) => {
        v.census.roots[1]!.apps[0]!.state.dns_zone.stable_chain_delegation_matches = true;
      },
      (v: typeof base) => {
        v.census.roots[0]!.apps[0]!.state.route_authority_effective = false;
      },
      (v: typeof base) => {
        v.census.roots[1]!.handles.pop();
      },
      (v: typeof base) => {
        delete v.census.roots[1]!.rows.hns_dns_zone_health_observations;
      },
      (v: typeof base) => {
        v.census.roots[1]!.apps[0]!.state.dns_zone.gateway_deployment_reference = NEXT_GATEWAY;
      },
      (v: typeof base) => {
        v.states.push(v.states[0]);
      },
    ];
    for (const mutate of mutations) {
      const v = structuredClone(base);
      mutate(v);
      await expect(prepareCookieProfileSuccessor(v)).rejects.toThrow();
    }
    for (const target of [0, 1]) {
      const v = structuredClone(base);
      Object.assign(v.census.roots[target]!.apps[0]!, { state: null });
      await expect(prepareCookieProfileSuccessor(v)).rejects.toThrow("Unknown host authority");
    }
    const changed = structuredClone(base.census);
    changed.roots[1]!.rows.hns_dns_zone_activation_current!.push({ current_generation: 99 });
    expect(() => requireUnchangedCookieCensus(base.census, changed, true)).toThrow(
      "census changed",
    );
    expect(() =>
      requireUnchangedCookieCensus(
        base.census,
        { ...base.census, roots: [base.census.roots[0]!] },
        true,
      ),
    ).toThrow("root set changed");
  });

  test("refuses future/stale evidence and zero, expired or overlong execution windows", async () => {
    const base = await cookieProfileFixture();
    for (const mutate of [
      (v: typeof base) => {
        v.executeBy = v.census.database_time;
      },
      (v: typeof base) => {
        v.executeBy = "2026-10-23T12:15:00.001Z";
      },
      (v: typeof base) => {
        v.states[0].health.valid_until = v.executeBy;
      },
      (v: typeof base) => {
        const tenant = v.census.roots[0];
        if (tenant?.recovery === null || tenant?.recovery === undefined)
          throw new Error("Expected selected recovery fixture");
        tenant.recovery.expires_at = v.executeBy;
      },
      (v: typeof base) => {
        v.states[0].inventory.published_at = v.executeBy;
      },
      (v: typeof base) => {
        v.states[0].health.checked_at = v.executeBy;
      },
      (v: typeof base) => {
        v.readiness.observed_at = v.executeBy;
      },
      (v: typeof base) => {
        v.readiness.observed_at = "2026-10-23T10:00:00.000Z";
      },
      (v: typeof base) => {
        v.census.database_time = "2026-10-23T12:01:00.001Z";
      },
    ]) {
      const v = structuredClone(base);
      mutate(v);
      await expect(prepareCookieProfileSuccessor(v)).rejects.toThrow();
    }
  });
});
