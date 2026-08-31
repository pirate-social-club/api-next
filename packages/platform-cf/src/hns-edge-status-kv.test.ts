import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  HNS_EDGE_STATUS_KV_KEY,
  type HnsEdgeStatusKvNamespace,
  makeCloudflareHnsEdgeStatusStore,
} from "./hns-edge-status-kv.ts";

const snapshot = {
  version: "pirate-hns-edge-status-v1" as const,
  received_at_unix_seconds: 1_800_000_000,
  report: {
    version: "pirate-hns-edge-status-v1" as const,
    observer_id: "pirate-hns-primary-vps-v1" as const,
    root: "jazleeuw" as const,
    observed_at_unix_seconds: 1_799_999_940,
    authority_views: [
      {
        view_id: "primary" as const,
        zone_serial: 2_026_080_805,
        rrsig_remaining_seconds: {
          dnskey: 900_000,
          soa: 900_000,
          app_a: 900_000,
          app_tlsa: 900_000,
          wildcard_tlsa: 900_000,
        },
      },
      {
        view_id: "secondary" as const,
        zone_serial: 2_026_080_805,
        rrsig_remaining_seconds: {
          dnskey: 900_000,
          soa: 900_000,
          app_a: 900_000,
          app_tlsa: 900_000,
          wildcard_tlsa: 900_000,
        },
      },
    ] as const,
    app: {
      certificate_not_after_unix_seconds: 1_802_592_000,
      served_spki_sha256: "a".repeat(64),
      primary_tlsa_spki_sha256: "a".repeat(64),
      secondary_tlsa_spki_sha256: "a".repeat(64),
      http_status: 200,
    },
    failed_units: [] as const,
  },
};

describe("HNS edge status KV adapter", () => {
  test("round-trips the single fixed snapshot key", async () => {
    const values = new Map<string, string>();
    const namespace: HnsEdgeStatusKvNamespace = {
      get: async (key) => values.get(key) ?? null,
      put: async (key, value) => {
        values.set(key, value);
      },
    };
    const store = makeCloudflareHnsEdgeStatusStore(namespace);

    expect(await Effect.runPromise(store.load())).toBeNull();
    await Effect.runPromise(store.save(snapshot));
    expect(values.has(HNS_EDGE_STATUS_KV_KEY)).toBe(true);
    expect(await Effect.runPromise(store.load())).toEqual(snapshot);
  });

  test("fails closed on malformed stored bytes", async () => {
    const namespace: HnsEdgeStatusKvNamespace = {
      get: async () => '{"version":"pirate-hns-edge-status-v1"}',
      put: async () => undefined,
    };
    await expect(
      Effect.runPromise(makeCloudflareHnsEdgeStatusStore(namespace).load()),
    ).rejects.toMatchObject({ reason: "storage-unavailable" });
  });
});
