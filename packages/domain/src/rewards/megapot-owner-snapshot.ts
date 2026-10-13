import {
  type Digest32,
  MEGAPOT_BENEFICIARY_ALGORITHM_VERSION,
  MegapotPoolInvariantError,
} from "./megapot-pool.ts";

export const MEGAPOT_OWNER_SNAPSHOT_DOMAIN = "pirate.megapot-pool-beneficiary-snapshot.v3" as const;

/** Kind/persona facts come from secured persisted share lineage, never a caller claim. */
export type MegapotOwnerSnapshotBeneficiary = Readonly<{
  ownerId: string;
  qualificationId: string;
  /** Canonical bytes32 hex of the once-persisted admission salt. Never generated here. */
  leafSalt: string;
}> &
  (
    | Readonly<{ ownerKind: "account"; originalPersonaId: string }>
    | Readonly<{ ownerKind: "guest"; originalPersonaId: null }>
  );

export type MegapotOwnerSnapshotPrivateLeaf = MegapotOwnerSnapshotBeneficiary &
  Readonly<{
    orderKey: string;
    leafCommitment: string;
  }>;

export type MegapotOwnerPublishedSnapshot = Readonly<{
  domain: typeof MEGAPOT_OWNER_SNAPSHOT_DOMAIN;
  poolLegId: string;
  drawingId: string;
  termsHash: string;
  algorithmVersion: typeof MEGAPOT_BENEFICIARY_ALGORITHM_VERSION;
  fallback: boolean;
  leafCount: number;
  leafCommitments: readonly string[];
  snapshotHash: string;
}>;

export type MegapotOwnerBeneficiarySnapshot = Readonly<{
  privateLeaves: readonly MegapotOwnerSnapshotPrivateLeaf[];
  published: MegapotOwnerPublishedSnapshot;
}>;

export type MegapotOwnerAllocationOutcome =
  | Readonly<{
      kind: "owner_allocations";
      allocations: readonly Readonly<{ ownerId: string; ordinal: number; amountAtomic: bigint }>[];
      totalAtomic: bigint;
    }>
  | Readonly<{
      kind: "fallback_sponsorship_credit";
      sponsorOwnerId: string;
      sponsorPersonaId: string;
      amountAtomic: bigint;
    }>;

const encoder = new TextEncoder();
const domain = encoder.encode(MEGAPOT_OWNER_SNAPSHOT_DOMAIN);
const bytes32Pattern = /^0x[0-9a-f]{64}$/u;

function validId(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /\s/u.test(value)) {
    return false;
  }
  // TextEncoder replaces unpaired UTF-16 surrogates. Reject instead of committing
  // different malformed identifiers to the same replacement UTF-8 bytes.
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit < 0x20 || unit === 0x7f) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      index += 1;
      const next = value.charCodeAt(index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

function bytes32(value: string): Uint8Array {
  if (typeof value !== "string" || value.length !== 66 || !bytes32Pattern.test(value))
    throw new MegapotPoolInvariantError("invalid-hash");
  return Uint8Array.from({ length: 32 }, (_, index) =>
    Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16),
  );
}

function hex(value: Uint8Array): string {
  return `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function checkedDigest(digest: Digest32, input: Uint8Array): Uint8Array {
  const output = digest(input);
  if (!(output instanceof Uint8Array) || output.byteLength !== 32) {
    throw new MegapotPoolInvariantError("invalid-digest");
  }
  return new Uint8Array(output);
}

function concat(...values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function u32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new MegapotPoolInvariantError("invalid-range");
  }
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function u256(value: bigint): Uint8Array {
  if (typeof value !== "bigint" || value < 0n || value >= 1n << 256n) {
    throw new MegapotPoolInvariantError("invalid-drawing");
  }
  const output = new Uint8Array(32);
  let remaining = value;
  for (let index = 31; index >= 0; index -= 1) {
    output[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return output;
}

function lp(value: string): Uint8Array {
  const body = encoder.encode(value);
  return concat(u32(body.byteLength), body);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined || r === undefined) throw new MegapotPoolInvariantError("invalid-range");
    if (l !== r) return l - r;
  }
  return left.byteLength - right.byteLength;
}

/** Unsigned canonical decimal amounts; no rounding, exponent, sign or leading zero. */
export function parseMegapotOwnerAtomicAmount(value: string): bigint {
  if (typeof value !== "string" || value !== value.trim() || !/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new MegapotPoolInvariantError("invalid-amount");
  }
  return BigInt(value);
}

/** Pure v3 codec. Caller supplies stable, persisted salts and secured share facts. */
export function buildMegapotOwnerBeneficiarySnapshot(input: {
  readonly poolLegId: string;
  readonly drawingId: bigint;
  readonly termsHash: string;
  readonly fallback: boolean;
  readonly beneficiaries: readonly MegapotOwnerSnapshotBeneficiary[];
  readonly sha256: Digest32;
}): MegapotOwnerBeneficiarySnapshot {
  if (!validId(input.poolLegId)) throw new MegapotPoolInvariantError("invalid-identifier");
  if (typeof input.fallback !== "boolean") throw new MegapotPoolInvariantError("invalid-snapshot");
  const poolBytes = lp(input.poolLegId);
  const drawingBytes = u256(input.drawingId);
  const terms = bytes32(input.termsHash);
  if (input.beneficiaries.length === 0) throw new MegapotPoolInvariantError("empty-beneficiaries");
  if (input.fallback && input.beneficiaries.length !== 1) {
    throw new MegapotPoolInvariantError("invalid-snapshot");
  }
  u32(input.beneficiaries.length);
  const seen = new Set<string>();
  const qualifications = new Set<string>();
  const leaves = input.beneficiaries.map((beneficiary) => {
    if (!validId(beneficiary.ownerId) || !validId(beneficiary.qualificationId)) {
      throw new MegapotPoolInvariantError("invalid-identifier");
    }
    if (
      (beneficiary.ownerKind === "account" && !validId(beneficiary.originalPersonaId)) ||
      (beneficiary.ownerKind === "guest" && beneficiary.originalPersonaId !== null) ||
      (beneficiary.ownerKind !== "account" && beneficiary.ownerKind !== "guest")
    )
      throw new MegapotPoolInvariantError("invalid-identifier");
    if (seen.has(beneficiary.ownerId)) throw new MegapotPoolInvariantError("duplicate-beneficiary");
    seen.add(beneficiary.ownerId);
    if (qualifications.has(beneficiary.qualificationId))
      throw new MegapotPoolInvariantError("invalid-snapshot");
    qualifications.add(beneficiary.qualificationId);
    if (
      (input.fallback &&
        (beneficiary.ownerKind !== "account" || beneficiary.qualificationId !== "fallback")) ||
      (!input.fallback && beneficiary.qualificationId === "fallback")
    )
      throw new MegapotPoolInvariantError("invalid-snapshot");
    const salt = bytes32(beneficiary.leafSalt);
    const ownerBytes = encoder.encode(beneficiary.ownerId);
    const orderKeyBytes = checkedDigest(
      input.sha256,
      concat(
        domain,
        Uint8Array.of(0),
        encoder.encode("order"),
        lp(beneficiary.ownerId),
        poolBytes,
        drawingBytes,
        salt,
      ),
    );
    const leafCommitment = hex(
      checkedDigest(
        input.sha256,
        concat(
          domain,
          Uint8Array.of(0),
          encoder.encode("leaf"),
          orderKeyBytes,
          lp(beneficiary.ownerId),
          lp(beneficiary.qualificationId),
          lp(beneficiary.originalPersonaId ?? ""),
          salt,
        ),
      ),
    );
    // Explicit fields prevent unrelated association/credential properties from
    // entering the private output as well as the public commitment.
    const leaf: MegapotOwnerSnapshotPrivateLeaf =
      beneficiary.ownerKind === "account"
        ? {
            ownerId: beneficiary.ownerId,
            ownerKind: "account",
            qualificationId: beneficiary.qualificationId,
            originalPersonaId: beneficiary.originalPersonaId,
            leafSalt: beneficiary.leafSalt,
            orderKey: hex(orderKeyBytes),
            leafCommitment,
          }
        : {
            ownerId: beneficiary.ownerId,
            ownerKind: "guest",
            qualificationId: beneficiary.qualificationId,
            originalPersonaId: null,
            leafSalt: beneficiary.leafSalt,
            orderKey: hex(orderKeyBytes),
            leafCommitment,
          };
    return { leaf, orderKeyBytes, ownerBytes };
  });
  leaves.sort(
    (left, right) =>
      compareBytes(left.orderKeyBytes, right.orderKeyBytes) ||
      compareBytes(left.ownerBytes, right.ownerBytes),
  );
  const privateLeaves = leaves.map(({ leaf }) => leaf);
  const commitments = privateLeaves.map((leaf) => leaf.leafCommitment);
  const snapshotHash = hex(
    checkedDigest(
      input.sha256,
      concat(
        domain,
        Uint8Array.of(0),
        poolBytes,
        drawingBytes,
        terms,
        lp(MEGAPOT_BENEFICIARY_ALGORITHM_VERSION),
        Uint8Array.of(input.fallback ? 1 : 0),
        u32(privateLeaves.length),
        ...commitments.map(bytes32),
      ),
    ),
  );
  return {
    privateLeaves,
    published: {
      domain: MEGAPOT_OWNER_SNAPSHOT_DOMAIN,
      poolLegId: input.poolLegId,
      drawingId: input.drawingId.toString(),
      termsHash: input.termsHash,
      algorithmVersion: MEGAPOT_BENEFICIARY_ALGORITHM_VERSION,
      fallback: input.fallback,
      leafCount: privateLeaves.length,
      leafCommitments: commitments,
      snapshotHash,
    },
  };
}

/** Validate original snapshot facts before allocating, including explicit zero rows. */
export function allocateMegapotOwnerWinnings(input: {
  readonly netAtomic: string;
  readonly snapshot: MegapotOwnerBeneficiarySnapshot;
  readonly sha256: Digest32;
}): MegapotOwnerAllocationOutcome {
  const net = parseMegapotOwnerAtomicAmount(input.netAtomic);
  const actual = input.snapshot;
  if (
    actual.published.drawingId !== actual.published.drawingId.trim() ||
    !/^(?:0|[1-9][0-9]*)$/u.test(actual.published.drawingId)
  ) {
    throw new MegapotPoolInvariantError("invalid-drawing");
  }
  const expected = buildMegapotOwnerBeneficiarySnapshot({
    poolLegId: actual.published.poolLegId,
    drawingId: BigInt(actual.published.drawingId),
    termsHash: actual.published.termsHash,
    fallback: actual.published.fallback,
    beneficiaries: actual.privateLeaves,
    sha256: input.sha256,
  });
  if (
    actual.published.domain !== expected.published.domain ||
    actual.published.algorithmVersion !== expected.published.algorithmVersion ||
    actual.published.snapshotHash !== expected.published.snapshotHash ||
    actual.published.leafCount !== expected.published.leafCount ||
    actual.published.leafCommitments.length !== expected.published.leafCount ||
    actual.privateLeaves.some((leaf, index) => {
      const ordered = expected.privateLeaves[index];
      return (
        ordered === undefined ||
        leaf.ownerId !== ordered.ownerId ||
        leaf.orderKey !== ordered.orderKey ||
        leaf.leafCommitment !== ordered.leafCommitment ||
        actual.published.leafCommitments[index] !== ordered.leafCommitment
      );
    })
  )
    throw new MegapotPoolInvariantError("invalid-snapshot");
  if (expected.published.fallback) {
    const sponsor = expected.privateLeaves[0];
    if (sponsor === undefined || sponsor.ownerKind !== "account") {
      throw new MegapotPoolInvariantError("invalid-snapshot");
    }
    return {
      kind: "fallback_sponsorship_credit",
      sponsorOwnerId: sponsor.ownerId,
      sponsorPersonaId: sponsor.originalPersonaId,
      amountAtomic: net,
    };
  }
  const count = BigInt(expected.privateLeaves.length);
  const base = net / count;
  const remainder = net % count;
  return {
    kind: "owner_allocations",
    totalAtomic: net,
    allocations: expected.privateLeaves.map((leaf, ordinal) => ({
      ownerId: leaf.ownerId,
      ordinal,
      amountAtomic: base + (BigInt(ordinal) < remainder ? 1n : 0n),
    })),
  };
}
