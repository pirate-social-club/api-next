import { Schema } from "effect";
import {
  inspectKaraokeResetMarker,
  type KaraokeResetMarker,
  transitionKaraokeResetMarker,
} from "./karaoke-reset-marker.ts";

// Frozen provider inventory from the reset-runner's 2026-09-06 evidence.
export const KARAOKE_RESET_OBJECT_IDS = Object.freeze([
  "1876ca7b6c069cce4aa99a9b20d19e6d5fec983855474b34ec9adbd903032c24",
  "8203dbd18ff5c1ebdbb07ae8fd7f9b49eb1dd9e396d851e22523e8bce9199f11",
  "9eb852591d8e793fcc8f48c77feffc017693e5882fbc801a06660b2e6f624c0a",
  "ab0714f8e24150ef031a7cee90ba9056735374c2ea09a051c5dee62083d06fa3",
  "aea39c89ea97bc2aaea58c71b133abd2f4af85b0424811c2bf8ac9aba026214d",
  "c43c2c6116ead78d8ea927099e9446a01844e94e7421715650c0ecbd5a009a4c",
] as const);
export const KARAOKE_RESET_INVENTORY_DIGEST =
  "a909a00a14555f0152ce5bc9deb986eef0c4ffb2c50a8a7d6cf25343c26b05db";
export const KARAOKE_RESET_GENERATION = "staging-reset-v1";
export const KaraokeResetTarget = Schema.Struct({
  namespaceId: Schema.Literal("d692b9d32ecc4cb4825510bde88cf97a"),
  objectId: Schema.Literals(KARAOKE_RESET_OBJECT_IDS),
  generation: Schema.Literal(KARAOKE_RESET_GENERATION),
  inventoryDigest: Schema.Literal(KARAOKE_RESET_INVENTORY_DIGEST),
});
const Command = Schema.Struct({
  ...KaraokeResetTarget.fields,
  state: Schema.Literals(["active", "retired"]),
});
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const Axis = Schema.NullOr(Schema.Literals(["pending", "stored", "exhausted"]));
const Observation = Schema.Struct({
  alarm: Schema.NullOr(Count),
  sockets: Count,
  scoreState: Axis,
  recordingState: Axis,
  archiveKey: Schema.NullOr(Schema.String),
  uploadId: Schema.NullOr(Schema.String),
});
export const KaraokeResetReceiptSchema = Schema.Struct({
  ...Command.fields,
  initial: Observation,
  current: Observation,
  cancellationSucceeded: Schema.Boolean,
  quiescenceEstablished: Schema.Boolean,
});
export type KaraokeResetObservation = typeof Observation.Type;
export type KaraokeResetReceipt = typeof KaraokeResetReceiptSchema.Type;

/** Internal adapter contract, not an authenticated RPC or a deployed capability. */
export interface KaraokeResetInstallationPort {
  readonly environment: string;
  readonly enabled: boolean;
  readonly objectId: string;
  // Must authenticate server-side; a caller-supplied principal is not sufficient.
  admitOperator(): Promise<void>;
  exclusive<T>(work: () => Promise<T>): Promise<T>;
  readMarker(): Promise<unknown>;
  readInitialObservation(): Promise<unknown>;
  observe(): Promise<unknown>;
  // Atomically persist marker and original observation, preserving it on replay.
  persist(marker: KaraokeResetMarker, initial: KaraokeResetObservation): Promise<void>;
  persistReceipt?(receipt: KaraokeResetReceipt): Promise<void>;
  closeAdmission(): void;
  cancelAlarm(): Promise<void>;
  closeSockets(): Promise<void>;
  drain(): Promise<boolean>;
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);
  } catch {
    throw new Error("karaoke_reset_invalid_evidence");
  }
}

export function decodeKaraokeResetCommand(input: unknown): typeof Command.Type {
  return decode(Command, input);
}

/** Storage-only barrier; cancellation and bounded drain deliberately happen outside it. */
export async function applyKaraokeResetInstallation(
  port: KaraokeResetInstallationPort,
  input: unknown,
): Promise<KaraokeResetReceipt> {
  const command = decodeKaraokeResetCommand(input);
  if (port.environment !== "staging" || !port.enabled || port.objectId !== command.objectId) {
    throw new Error("karaoke_reset_admission_denied");
  }
  await port.admitOperator();
  const initial = await port.exclusive(async () => {
    const stored = await port.readMarker();
    const identity = {
      namespaceId: command.namespaceId,
      objectId: command.objectId,
      generation: command.generation,
    };
    const marker = transitionKaraokeResetMarker(stored, identity, command.state);
    const prior = inspectKaraokeResetMarker(stored, identity);
    const observation = decode(
      Observation,
      prior.state === "absent" ? await port.observe() : await port.readInitialObservation(),
    );
    // Latch admission before yielding to persistence. Failure never grants a
    // successful receipt, and never reopens this instance's producer admission.
    port.closeAdmission();
    await port.persist(marker, observation);
    return observation;
  });
  let cancellationSucceeded = true;
  try {
    await port.cancelAlarm();
  } catch {
    cancellationSucceeded = false;
  }
  try {
    await port.closeSockets();
  } catch {
    cancellationSucceeded = false;
  }
  let quiescenceEstablished = false;
  try {
    quiescenceEstablished = await port.drain();
  } catch {
    /* Incomplete, never success. */
  }
  return port.exclusive(async () => {
    const marker = inspectKaraokeResetMarker(await port.readMarker(), command);
    // Another authorized operation may retire the marker while this call drains.
    // Reject retirement already visible at this observation point.
    if (marker.state !== command.state) throw new Error("karaoke_reset_receipt_superseded");
    const current = decode(Observation, await port.observe());
    // Construct a point-in-time snapshot inside the final barrier, not a lease
    // preventing subsequent retirement after the observation is returned.
    const receipt = {
      ...command,
      initial,
      current,
      cancellationSucceeded:
        cancellationSucceeded && current.alarm === null && current.sockets === 0,
      quiescenceEstablished,
    };
    await port.persistReceipt?.(receipt);
    return receipt;
  });
}

/** Requires the exact inventory; timestamps/fresh live readback remain the operator's gate. */
export function verifyKaraokeResetReceipts(
  input: readonly unknown[],
  state: "active" | "retired",
): void {
  const receipts = input.map((value) => decode(KaraokeResetReceiptSchema, value));
  if (
    receipts.length !== KARAOKE_RESET_OBJECT_IDS.length ||
    new Set(receipts.map((receipt) => receipt.objectId)).size !== receipts.length ||
    receipts.some(
      (receipt) =>
        receipt.state !== state ||
        !receipt.cancellationSucceeded ||
        !receipt.quiescenceEstablished ||
        receipt.current.alarm !== null ||
        receipt.current.sockets !== 0,
    )
  )
    throw new Error("karaoke_reset_receipts_incomplete");
}

/** Instance-local accounting; durable marker denial must separately survive eviction. */
export class KaraokeResetProducerDrain {
  private closed = false;
  private readonly pending = new Set<Promise<void>>();

  get size(): number {
    return this.pending.size;
  }

  close(): void {
    this.closed = true;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("karaoke_reset_fenced");
    // Register before invoking the producer, including synchronous reentrancy.
    let settled = () => {};
    const pending = new Promise<void>((resolve) => {
      settled = resolve;
    });
    this.pending.add(pending);
    try {
      return await operation();
    } finally {
      this.pending.delete(pending);
      settled();
    }
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (!this.closed || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 10_000) {
      throw new Error("karaoke_reset_invalid_drain");
    }
    if (this.pending.size === 0) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.all([...this.pending]).then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
