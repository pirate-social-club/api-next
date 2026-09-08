import { expect, test } from "bun:test";
import {
  assertKaraokeExpiryPassed,
  cancelKaraokeProducers,
  inspectKaraokeFence,
  type KaraokeFencePort,
  STAGING_KARAOKE_NAMESPACE,
  STAGING_KARAOKE_OBJECT_IDS,
} from "./staging-karaoke-fence";

const ids = STAGING_KARAOKE_OBJECT_IDS;
function fixture() {
  let alarm: number | null = 200;
  let sockets = 1;
  let mutations = 0;
  let exclusive = false;
  const port: KaraokeFencePort = {
    environment: "staging",
    namespaceId: STAGING_KARAOKE_NAMESPACE,
    objectId: ids[0] ?? "",
    now: () => 301,
    exclusive: async (operation) => {
      exclusive = true;
      try {
        return await operation();
      } finally {
        exclusive = false;
      }
    },
    readExpiry: async () => 300,
    readAlarm: async () => alarm,
    deleteAlarm: async () => {
      expect(exclusive).toBe(true);
      mutations++;
      alarm = null;
    },
    closeSockets: async () => {
      expect(exclusive).toBe(true);
      mutations++;
      sockets = 0;
    },
    socketCount: () => sockets,
  };
  return { port, mutations: () => mutations };
}

test("inspection is read-only and cancellation preserves the prior alarm receipt", async () => {
  const { port, mutations } = fixture();
  const retained = await inspectKaraokeFence(port, ids);
  expect(mutations()).toBe(0);
  const result = await cancelKaraokeProducers(port, ids, retained);
  expect(result).toMatchObject({ priorAlarm: 200, remainingAlarm: null, remainingSockets: 0 });
  expect(mutations()).toBe(2);
});

test("refuses production, another namespace and an unreviewed object before any mutation", async () => {
  for (const change of [
    { environment: "production" },
    { namespaceId: "other" },
    { objectId: "f".repeat(64) },
  ]) {
    const { port, mutations } = fixture();
    const retained = await inspectKaraokeFence(port, ids);
    await expect(cancelKaraokeProducers({ ...port, ...change }, ids, retained)).rejects.toThrow(
      "target_unproven",
    );
    expect(mutations()).toBe(0);
  }
});

test("changed alarm or authority invalidates the retained receipt before mutation", async () => {
  for (const change of [{ readAlarm: async () => 201 }, { readExpiry: async () => 301 }]) {
    const { port, mutations } = fixture();
    const retained = await inspectKaraokeFence(port, ids);
    await expect(cancelKaraokeProducers({ ...port, ...change }, ids, retained)).rejects.toThrow(
      "receipt_changed",
    );
    expect(mutations()).toBe(0);
  }
});

test("does not claim a fence when socket closure or alarm cancellation remains pending", async () => {
  for (const change of [{ deleteAlarm: async () => {} }, { closeSockets: async () => {} }]) {
    const { port } = fixture();
    const retained = await inspectKaraokeFence(port, ids);
    await expect(cancelKaraokeProducers({ ...port, ...change }, ids, retained)).rejects.toThrow(
      "producer_not_drained",
    );
  }
});

test("unknown or malformed authority fails closed rather than being classified expired", async () => {
  for (const expiry of [Number.NaN, -1]) {
    const { port, mutations } = fixture();
    await expect(
      inspectKaraokeFence({ ...port, readExpiry: async () => expiry }, ids),
    ).rejects.toThrow("state_unproven");
    expect(mutations()).toBe(0);
  }
});

test("six arbitrary well-formed IDs cannot replace the reviewed provider inventory", async () => {
  const { port } = fixture();
  const substituted = [port.objectId, ...Array.from({ length: 5 }, (_, i) => String(i).repeat(64))];
  await expect(inspectKaraokeFence(port, substituted)).rejects.toThrow("inventory_unproven");
});

test("unfence requires a complete unique inventory and elapsed expiry for every object", async () => {
  const { port } = fixture();
  const result = await cancelKaraokeProducers(port, ids, await inspectKaraokeFence(port, ids));
  const receipts = ids.map((objectId) => ({ ...result, objectId }));
  expect(() => assertKaraokeExpiryPassed(receipts, ids, 301, 301)).not.toThrow();
  expect(() => assertKaraokeExpiryPassed(receipts, ids, 300, 300)).toThrow("expiry_unproven");
  expect(() => assertKaraokeExpiryPassed(receipts, ids, 302, 302)).toThrow("expiry_unproven");
  expect(() => assertKaraokeExpiryPassed(receipts, ids, 60_302, 301)).toThrow("expiry_unproven");
  expect(() => assertKaraokeExpiryPassed(receipts.slice(1), ids, 301, 301)).toThrow(
    "expiry_unproven",
  );
  expect(() =>
    assertKaraokeExpiryPassed(
      receipts.map(() => result),
      ids,
      301,
      301,
    ),
  ).toThrow("expiry_unproven");
});
