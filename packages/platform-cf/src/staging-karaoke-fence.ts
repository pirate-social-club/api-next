/** Internal maintenance primitive; not an HTTP endpoint or deployment authorization. */
export interface KaraokeFencePort {
  readonly environment: string;
  readonly namespaceId: string;
  readonly objectId: string;
  now(): number;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
  readExpiry(): Promise<number>;
  readAlarm(): Promise<number | null>;
  deleteAlarm(): Promise<void>;
  closeSockets(): Promise<void>;
  socketCount(): number;
}

export const STAGING_KARAOKE_NAMESPACE = "d692b9d32ecc4cb4825510bde88cf97a";
/** Read-only provider inventory, 2026-09-06. A changed set needs renewed review. */
export const STAGING_KARAOKE_OBJECT_IDS = [
  "1876ca7b6c069cce4aa99a9b20d19e6d5fec983855474b34ec9adbd903032c24",
  "8203dbd18ff5c1ebdbb07ae8fd7f9b49eb1dd9e396d851e22523e8bce9199f11",
  "9eb852591d8e793fcc8f48c77feffc017693e5882fbc801a06660b2e6f624c0a",
  "ab0714f8e24150ef031a7cee90ba9056735374c2ea09a051c5dee62083d06fa3",
  "aea39c89ea97bc2aaea58c71b133abd2f4af85b0424811c2bf8ac9aba026214d",
  "c43c2c6116ead78d8ea927099e9446a01844e94e7421715650c0ecbd5a009a4c",
] as const;

export interface KaraokeFenceReceipt {
  readonly namespaceId: string;
  readonly objectId: string;
  readonly observedAt: number;
  readonly expiresAt: number;
  readonly priorAlarm: number | null;
  readonly remainingAlarm: number | null;
  readonly remainingSockets: number;
}

const timestamp = (value: number | null): boolean =>
  value === null || (Number.isSafeInteger(value) && value > 0);

/** The caller must persist the inspect receipt before requesting cancellation. */
export async function inspectKaraokeFence(
  port: KaraokeFencePort,
  reviewedObjectIds: readonly string[],
): Promise<KaraokeFenceReceipt> {
  assertTarget(port, reviewedObjectIds);
  return port.exclusive(() => snapshot(port));
}

export async function cancelKaraokeProducers(
  port: KaraokeFencePort,
  reviewedObjectIds: readonly string[],
  retained: KaraokeFenceReceipt,
): Promise<KaraokeFenceReceipt> {
  assertTarget(port, reviewedObjectIds);
  return port.exclusive(async () => {
    const before = await snapshot(port);
    if (
      retained.objectId !== before.objectId ||
      retained.namespaceId !== before.namespaceId ||
      retained.expiresAt !== before.expiresAt ||
      retained.priorAlarm !== before.priorAlarm
    ) {
      throw new Error("karaoke_fence_receipt_changed");
    }
    await port.deleteAlarm();
    await port.closeSockets();
    const after = await snapshot(port);
    if (after.remainingAlarm !== null || after.remainingSockets !== 0) {
      throw new Error("karaoke_fence_producer_not_drained");
    }
    return { ...after, priorAlarm: before.priorAlarm };
  });
}

export function assertKaraokeExpiryPassed(
  receipts: readonly KaraokeFenceReceipt[],
  reviewedObjectIds: readonly string[],
  now: number,
  drainedAt: number,
): void {
  assertReviewedObjects(reviewedObjectIds);
  if (
    !Number.isSafeInteger(now) ||
    !Number.isSafeInteger(drainedAt) ||
    drainedAt <= 0 ||
    drainedAt > now ||
    receipts.length !== reviewedObjectIds.length ||
    new Set(receipts.map((receipt) => receipt.objectId)).size !== receipts.length ||
    receipts.some(
      (receipt) =>
        !reviewedObjectIds.includes(receipt.objectId) ||
        receipt.namespaceId !== STAGING_KARAOKE_NAMESPACE ||
        !Number.isSafeInteger(receipt.observedAt) ||
        receipt.observedAt < drainedAt ||
        receipt.observedAt > now ||
        now - receipt.observedAt > 60_000 ||
        !timestamp(receipt.expiresAt) ||
        receipt.expiresAt === null ||
        receipt.remainingAlarm !== null ||
        receipt.remainingSockets !== 0 ||
        receipt.expiresAt >= receipt.observedAt,
    )
  ) {
    throw new Error("karaoke_fence_expiry_unproven");
  }
}

function assertReviewedObjects(ids: readonly string[]): void {
  if (
    ids.length !== 6 ||
    new Set(ids).size !== 6 ||
    ids.some((id) => !STAGING_KARAOKE_OBJECT_IDS.some((reviewed) => reviewed === id))
  ) {
    throw new Error("karaoke_fence_inventory_unproven");
  }
}

function assertTarget(port: KaraokeFencePort, ids: readonly string[]): void {
  assertReviewedObjects(ids);
  if (
    port.environment !== "staging" ||
    port.namespaceId !== STAGING_KARAOKE_NAMESPACE ||
    !ids.includes(port.objectId)
  ) {
    throw new Error("karaoke_fence_target_unproven");
  }
}

async function snapshot(port: KaraokeFencePort): Promise<KaraokeFenceReceipt> {
  const expiresAt = await port.readExpiry();
  const alarm = await port.readAlarm();
  const sockets = port.socketCount();
  const observedAt = port.now();
  if (
    !Number.isSafeInteger(observedAt) ||
    observedAt <= 0 ||
    !timestamp(expiresAt) ||
    expiresAt === null ||
    !timestamp(alarm) ||
    !Number.isSafeInteger(sockets) ||
    sockets < 0
  ) {
    throw new Error("karaoke_fence_state_unproven");
  }
  return {
    namespaceId: port.namespaceId,
    objectId: port.objectId,
    observedAt,
    expiresAt,
    priorAlarm: alarm,
    remainingAlarm: alarm,
    remainingSockets: sockets,
  };
}
