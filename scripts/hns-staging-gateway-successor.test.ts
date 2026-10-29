import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  decodeHnsDnsHealthDocumentV1,
  decodeHnsDnsZonePersistenceDocumentV1,
} from "../packages/application/src/hns-host-persistence.ts";
import { stagingGatewayFixture as fixture } from "./hns-staging-gateway/fixture.ts";
import { reference } from "./hns-staging-gateway/identity.mjs";
import {
  applyStagingGatewaySuccessor,
  prepareStagingGatewaySuccessor,
} from "./hns-staging-gateway-successor.mjs";

const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

describe("staging gateway fingerprint successor", () => {
  test("freezes distinct root operations, retains DNS identities and caps the actual health lifetime", async () => {
    const input = await fixture();
    const plan = await prepareStagingGatewaySuccessor(input);
    expect(plan.entries[0].successor_id).not.toBe(plan.entries[1].successor_id);
    expect(await prepareStagingGatewaySuccessor(input)).toEqual(plan);
    for (const entry of plan.entries) {
      const dns = await decodeHnsDnsZonePersistenceDocumentV1(Buffer.from(entry.dns_hex, "hex"));
      const health = decodeHnsDnsHealthDocumentV1(Buffer.from(entry.health_hex, "hex"));
      expect(dns.zone_bytes_digest).toBe(entry.predecessor.dns.zone_bytes_digest);
      expect(dns.zone_revision).toBe(Number(entry.predecessor.dns.zone_revision) + 1);
      expect(dns.gateway_deployment_reference).toBe(reference(input.nextManifest));
      expect(dns.pirate_dns_authority_inventory_digest).toBe(
        entry.predecessor.dns.pirate_dns_authority_inventory_digest,
      );
      expect(Date.parse(plan.execute_by) + health.valid_for_seconds * 1000).toBeLessThan(
        Date.parse(entry.health_deadline),
      );
      expect(entry.inherited_health_checked_at).toBe("2026-10-23T12:00:00.000Z");
    }
  });

  test("preserves native PostgreSQL timestamp precision across the frozen plan round trip", async () => {
    const input = await fixture();
    const deadline = "2026-10-25T11:59:59.106Z";
    for (const state of input.states) {
      state.health.valid_until = new Date(deadline);
      state.health.checked_at = new Date("2026-10-23T12:00:00.000Z");
      state.inventory.published_at = new Date(state.inventory.published_at);
      state.inventory.expires_at = new Date(state.inventory.expires_at);
    }
    const plan = await prepareStagingGatewaySuccessor(input);
    const frozen = JSON.parse(JSON.stringify(plan));
    const rebuilt = await prepareStagingGatewaySuccessor({
      ...input,
      states: frozen.entries.map((entry: { predecessor: unknown }) => entry.predecessor),
    });
    expect(rebuilt).toEqual(frozen);
    for (const entry of plan.entries) expect(entry.health_deadline).toBe(deadline);
  });

  test("refuses a broader manifest change and a different or stale readiness observation", async () => {
    const input = await fixture();
    for (const change of [
      { nextManifest: `${input.nextManifest}\n` },
      {
        nextManifest: JSON.stringify({
          ...JSON.parse(input.nextManifest),
          bundle_sha256: "0".repeat(64),
        }),
      },
      { readiness: { ...input.readiness, observed_at: "2026-10-23T10:00:00.000Z" } },
      { readiness: { ...input.readiness, manifest_json: input.previousManifest } },
      { executeBy: "2026-10-23T12:15:01.000Z" },
    ])
      await expect(prepareStagingGatewaySuccessor({ ...input, ...change })).rejects.toThrow();
  });

  test("refuses expired, contradictory, mixed or incomplete predecessor evidence", async () => {
    for (const mutate of [
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states.pop();
      },
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states[0].health.valid_until = value.executeBy;
      },
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states[0].health.ds_authenticates_zone = false;
      },
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states[0].health.observed_zone_bytes_digest = "0".repeat(64);
      },
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states[0].app.dns_zone_activation_generation = "999";
      },
      (value: Awaited<ReturnType<typeof fixture>>) => {
        value.states[0].inventory.expires_at = value.executeBy;
      },
    ]) {
      const input = await fixture();
      mutate(input);
      await expect(prepareStagingGatewaySuccessor(input)).rejects.toThrow();
    }
  });

  test("rejects edited reviewed bytes before connecting or opening a transaction", async () => {
    const plan = await prepareStagingGatewaySuccessor(await fixture());
    const hash = sha(JSON.stringify(plan));
    const query = () => {
      throw new Error("must not reach database");
    };
    const changed = structuredClone(plan);
    changed.entries[0].health_hex = changed.entries[1].health_hex;
    await expect(
      applyStagingGatewaySuccessor({ client: { query }, plan: changed, confirmedSha256: hash }),
    ).rejects.toThrow("Unreviewed plan");
    await expect(
      applyStagingGatewaySuccessor({
        client: { query },
        plan: changed,
        confirmedSha256: sha(JSON.stringify(changed)),
      }),
    ).rejects.toThrow("Plan does not reproduce exactly");
  });
});
