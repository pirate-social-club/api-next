import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyKaraokeResetInstallation,
  KARAOKE_RESET_GENERATION,
  KARAOKE_RESET_INVENTORY_DIGEST,
  KARAOKE_RESET_OBJECT_IDS,
  type KaraokeResetInstallationPort,
  type KaraokeResetObservation,
  KaraokeResetProducerDrain,
  type KaraokeResetReceipt,
  verifyKaraokeResetReceipts,
} from "./karaoke-reset-installation.ts";

const command = {
  namespaceId: "d692b9d32ecc4cb4825510bde88cf97a",
  objectId: KARAOKE_RESET_OBJECT_IDS[0],
  generation: KARAOKE_RESET_GENERATION,
  inventoryDigest: KARAOKE_RESET_INVENTORY_DIGEST,
  state: "active",
} as const;

function fixture() {
  const calls: string[] = [];
  let marker: unknown;
  let initial: unknown;
  const current: { -readonly [K in keyof KaraokeResetObservation]: KaraokeResetObservation[K] } = {
    alarm: 123,
    sockets: 1,
    scoreState: "pending",
    recordingState: "pending",
    archiveKey: "karaoke/fixture/attempt.pcm",
    uploadId: null,
  };
  let inBarrier = false;
  const port: KaraokeResetInstallationPort = {
    environment: "staging",
    enabled: true,
    objectId: command.objectId,
    admitOperator: async () => {
      calls.push("authenticate");
    },
    exclusive: async (work) => {
      inBarrier = true;
      try {
        return await work();
      } finally {
        inBarrier = false;
      }
    },
    readMarker: async () => marker,
    readInitialObservation: async () => initial,
    observe: async () => ({ ...current }),
    persist: async (value, observation) => {
      expect(inBarrier).toBe(true);
      calls.push("persist");
      marker = value;
      initial = structuredClone(observation);
    },
    closeAdmission: () => {
      calls.push("close-admission");
    },
    cancelAlarm: async () => {
      expect(inBarrier).toBe(false);
      expect(marker).toBeDefined();
      calls.push("cancel");
      current.alarm = null;
    },
    closeSockets: async () => {
      expect(inBarrier).toBe(false);
      expect(marker).toBeDefined();
      calls.push("close-sockets");
      current.sockets = 0;
    },
    drain: async () => {
      expect(inBarrier).toBe(false);
      calls.push("drain");
      return true;
    },
  };
  return { port, calls, current, marker: () => marker };
}

describe("internal Karaoke reset installation protocol", () => {
  test("pins the exact inventory digest", () => {
    expect(
      createHash("sha256")
        .update(JSON.stringify([...KARAOKE_RESET_OBJECT_IDS].sort()))
        .digest("hex"),
    ).toBe(KARAOKE_RESET_INVENTORY_DIGEST);
  });

  test("persists first and retains original evidence on replay and retirement", async () => {
    const f = fixture();
    const first = await applyKaraokeResetInstallation(f.port, command);
    expect(f.calls).toEqual([
      "authenticate",
      "close-admission",
      "persist",
      "cancel",
      "close-sockets",
      "drain",
    ]);
    expect(first.initial.alarm).toBe(123);
    expect(first.cancellationSucceeded).toBe(true);
    const replay = await applyKaraokeResetInstallation(f.port, command);
    expect(replay.initial).toEqual(first.initial);
    const retired = await applyKaraokeResetInstallation(f.port, { ...command, state: "retired" });
    expect(retired.initial).toEqual(first.initial);
    expect(retired.state).toBe("retired");
    await expect(applyKaraokeResetInstallation(f.port, command)).rejects.toThrow(
      "karaoke_reset_retired",
    );
  });

  test("unauthenticated calls cannot observe or write", async () => {
    const f = fixture();
    f.port.admitOperator = async () => {
      throw new Error("unauthorized");
    };
    await expect(applyKaraokeResetInstallation(f.port, command)).rejects.toThrow("unauthorized");
    expect(f.calls).toEqual([]);
    expect(f.marker()).toBeUndefined();
  });

  test("rejects production, disabled admission, fresh objects and replayed generations", async () => {
    for (const patch of [
      { environment: "production" },
      { enabled: false },
      { objectId: "f".repeat(64) },
    ]) {
      const f = fixture();
      await expect(
        applyKaraokeResetInstallation({ ...f.port, ...patch }, command),
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
    for (const patch of [
      { generation: "fresh" },
      { objectId: "f".repeat(64) },
      { inventoryDigest: "wrong" },
    ]) {
      const f = fixture();
      await expect(
        applyKaraokeResetInstallation(f.port, { ...command, ...patch }),
      ).rejects.toThrow();
      expect(f.calls).toEqual([]);
    }
  });

  test("persistence failure never cancels or grants a receipt", async () => {
    const f = fixture();
    f.port.persist = async () => {
      throw new Error("storage-failed");
    };
    await expect(applyKaraokeResetInstallation(f.port, command)).rejects.toThrow("storage-failed");
    expect(f.calls).toEqual(["authenticate", "close-admission"]);
  });

  test("cancellation failure retains marker and incomplete receipt", async () => {
    const f = fixture();
    f.port.cancelAlarm = async () => {
      throw new Error("cancellation-failed");
    };
    const receipt = await applyKaraokeResetInstallation(f.port, command);
    expect(f.marker()).toMatchObject({ state: "active" });
    expect(receipt.cancellationSucceeded).toBe(false);
    expect(receipt.current.alarm).toBe(123);
    expect(f.calls).toContain("close-sockets");
  });

  test("unsettled work is incomplete and late upload evidence is included", async () => {
    const f = fixture();
    f.port.drain = async () => {
      f.current.uploadId = "late-upload";
      return false;
    };
    const receipt = await applyKaraokeResetInstallation(f.port, command);
    expect(receipt.quiescenceEstablished).toBe(false);
    expect(receipt.current.uploadId).toBe("late-upload");
    expect(f.marker()).toMatchObject({ state: "active" });
  });

  test("requires all six distinct complete matching-state receipts", async () => {
    const receipts: KaraokeResetReceipt[] = [];
    for (const objectId of KARAOKE_RESET_OBJECT_IDS) {
      const f = fixture();
      receipts.push(
        await applyKaraokeResetInstallation({ ...f.port, objectId }, { ...command, objectId }),
      );
    }
    expect(() => verifyKaraokeResetReceipts(receipts, "active")).not.toThrow();
    expect(() => verifyKaraokeResetReceipts(receipts.slice(1), "active")).toThrow();
    expect(() =>
      verifyKaraokeResetReceipts([...receipts.slice(1), receipts[1]], "active"),
    ).toThrow();
    expect(() => verifyKaraokeResetReceipts(receipts, "retired")).toThrow();
    expect(() =>
      verifyKaraokeResetReceipts(
        receipts.map((r) => ({ ...r, quiescenceEstablished: false })),
        "active",
      ),
    ).toThrow();
    expect(() =>
      verifyKaraokeResetReceipts(
        receipts.map((r) => ({ ...r, unexpected: true })),
        "active",
      ),
    ).toThrow();
  });

  test("does not return a stale active receipt after concurrent retirement", async () => {
    const f = fixture();
    f.port.drain = async () => {
      f.port.readMarker = async () => ({
        version: 1,
        namespaceId: command.namespaceId,
        objectId: command.objectId,
        generation: command.generation,
        state: "retired",
      });
      return true;
    };
    await expect(applyKaraokeResetInstallation(f.port, command)).rejects.toThrow(
      "karaoke_reset_receipt_superseded",
    );
  });
});

describe("bounded producer drain", () => {
  test("timeout does not pretend to cancel earlier work and new work is denied", async () => {
    const gate = new KaraokeResetProducerDrain();
    const suspended = Promise.withResolvers<void>();
    const running = gate.run(() => suspended.promise);
    gate.close();
    expect(await gate.drain(0)).toBe(false);
    await expect(gate.run(async () => {})).rejects.toThrow("karaoke_reset_fenced");
    suspended.resolve();
    await running;
    expect(await gate.drain(0)).toBe(true);
  });

  test("a rejected producer settles accounting without masking its error", async () => {
    const gate = new KaraokeResetProducerDrain();
    await expect(
      gate.run(async () => {
        throw new Error("producer-failed");
      }),
    ).rejects.toThrow("producer-failed");
    gate.close();
    expect(await gate.drain(1)).toBe(true);
    await expect(gate.drain(10_001)).rejects.toThrow("karaoke_reset_invalid_drain");
  });
});
