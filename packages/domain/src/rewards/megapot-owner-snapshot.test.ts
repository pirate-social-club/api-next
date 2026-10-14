import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  allocateMegapotOwnerWinnings,
  buildMegapotOwnerBeneficiarySnapshot,
  type MegapotOwnerSnapshotBeneficiary,
  parseMegapotOwnerAtomicAmount,
} from "./megapot-owner-snapshot.ts";
import { buildMegapotBeneficiarySnapshot, type Digest32 } from "./megapot-pool.ts";

const sha256: Digest32 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const account = {
  ownerId: "owner_account_fixture",
  ownerKind: "account",
  qualificationId: "qualification_account_fixture",
  originalPersonaId: "persona_fixture",
  leafSalt: `0x${"01".repeat(32)}`,
} as const;
const guest = {
  ownerId: "owner_guest_fixture",
  ownerKind: "guest",
  qualificationId: "qualification_guest_fixture",
  originalPersonaId: null,
  leafSalt: `0x${"02".repeat(32)}`,
} as const;
const base = {
  poolLegId: "pool_fixture",
  drawingId: 7n,
  termsHash: `0x${"03".repeat(32)}`,
  fallback: false,
  beneficiaries: [account, guest],
  sha256,
} as const;

// These salts are specification fixtures, never serving/admission generators.
test("reproduces all five frozen spec027 v3 SHA-256 vectors", () => {
  const snapshot = buildMegapotOwnerBeneficiarySnapshot(base);
  expect(
    snapshot.privateLeaves.map(({ ownerId, orderKey, leafCommitment }) => ({
      ownerId,
      orderKey,
      leafCommitment,
    })),
  ).toEqual([
    {
      ownerId: guest.ownerId,
      orderKey: "0x16b0d365745932fa77555431f885162bd7b4cf0056537b74c977c51873b38fea",
      leafCommitment: "0x9230e632353302902193e4b9980e9a6b8c2ff992f6e49eba798d81fca675016b",
    },
    {
      ownerId: account.ownerId,
      orderKey: "0x6c8f2215cb1ed071e9e9d0f63b99be0cdfbe085c9b783a71a6e8221b1a56e91e",
      leafCommitment: "0x66cd0d74d85e2e8673ada357e68d96b8f9bf7d4910ee8a12f1b804067b3e61b4",
    },
  ]);
  expect(snapshot.published).toEqual({
    domain: "pirate.megapot-pool-beneficiary-snapshot.v3",
    poolLegId: "pool_fixture",
    drawingId: "7",
    termsHash: base.termsHash,
    algorithmVersion: "equal_v1",
    fallback: false,
    leafCount: 2,
    leafCommitments: [
      "0x9230e632353302902193e4b9980e9a6b8c2ff992f6e49eba798d81fca675016b",
      "0x66cd0d74d85e2e8673ada357e68d96b8f9bf7d4910ee8a12f1b804067b3e61b4",
    ],
    snapshotHash: "0x77831756e074633b33ecb8d74cbaed95cda5c170d7eeed66c1f65750024749c8",
  });
});

test("uses UTF-8 byte lengths and 32-byte big-endian drawing 256", () => {
  const snapshot = buildMegapotOwnerBeneficiarySnapshot({
    ...base,
    poolLegId: "pool_é",
    drawingId: 256n,
    beneficiaries: [{ ...guest, ownerId: "owner_é😀", qualificationId: "qualification_fixture" }],
  });
  expect(
    snapshot.privateLeaves.map(({ orderKey, leafCommitment }) => ({ orderKey, leafCommitment })),
  ).toEqual([
    {
      orderKey: "0xf69bb236f14736fbd5d52083c1cf7bf8b4a05a28fd305adda42a0411b296b3d2",
      leafCommitment: "0x60382b33e1f6d4d6d3f65f7406d4b98a406018d6f7963c17cb94f7a87b976603",
    },
  ]);
  expect(snapshot.published.snapshotHash).toBe(
    "0x9e2f3e5f78331ba7df75fb8f18693a3dbfd128e13cf354ac2f281e988987781e",
  );
});

test("orders equal order keys by raw UTF-8 owner bytes rather than locale or UTF-16", () => {
  // Deliberate digest collision isolates the specified secondary ordering rule.
  const collision: Digest32 = () => new Uint8Array(32);
  const owners = ["owner_😀", "owner_é", "owner_\ufffd", "owner_z"];
  const beneficiaries: readonly MegapotOwnerSnapshotBeneficiary[] = owners.map(
    (ownerId, index) => ({ ...guest, ownerId, qualificationId: `qualification_${index}` }),
  );
  const snapshot = buildMegapotOwnerBeneficiarySnapshot({
    ...base,
    sha256: collision,
    beneficiaries,
  });
  expect(snapshot.privateLeaves.map(({ ownerId }) => ownerId)).toEqual([
    "owner_z",
    "owner_é",
    "owner_\ufffd",
    "owner_😀",
  ]);
});

test("replays the same persisted salts regardless of caller order and ignores association", () => {
  const original = buildMegapotOwnerBeneficiarySnapshot(base);
  const attached = {
    ...guest,
    attachedAccountId: "account_after_signup",
    selectedClaimPersonaId: "persona_after_signup",
    credential: "private-proof",
  };
  const replay = buildMegapotOwnerBeneficiarySnapshot({
    ...base,
    beneficiaries: [attached, account],
  });
  expect(replay).toEqual(original);
  const publicBytes = JSON.stringify(replay.published);
  for (const secret of [
    account.ownerId,
    guest.ownerId,
    account.qualificationId,
    guest.qualificationId,
    account.originalPersonaId,
    account.leafSalt,
    guest.leafSalt,
    attached.attachedAccountId,
    attached.selectedClaimPersonaId,
    attached.credential,
  ]) {
    expect(publicBytes).not.toContain(secret);
  }
  expect(Object.keys(replay.published).sort()).toEqual([
    "algorithmVersion",
    "domain",
    "drawingId",
    "fallback",
    "leafCommitments",
    "leafCount",
    "poolLegId",
    "snapshotHash",
    "termsHash",
  ]);
  expect(JSON.stringify(replay.privateLeaves)).not.toContain(attached.credential);
});

test("binds original owner, qualification, persona, salt, drawing, pool and terms", () => {
  const original = buildMegapotOwnerBeneficiarySnapshot(base).published.snapshotHash;
  const changes = [
    { ...base, beneficiaries: [{ ...account, ownerId: "other_owner" }, guest] },
    { ...base, beneficiaries: [{ ...account, qualificationId: "other_qualification" }, guest] },
    { ...base, beneficiaries: [{ ...account, originalPersonaId: "other_persona" }, guest] },
    { ...base, beneficiaries: [{ ...account, leafSalt: `0x${"04".repeat(32)}` }, guest] },
    { ...base, drawingId: 8n },
    { ...base, poolLegId: "other_pool" },
    { ...base, termsHash: `0x${"04".repeat(32)}` },
  ];
  for (const changed of changes) {
    expect(buildMegapotOwnerBeneficiarySnapshot(changed).published.snapshotHash).not.toBe(original);
  }
});

test("allocates exact 5, 1 and 0 vectors and keeps every zero row", () => {
  const snapshot = buildMegapotOwnerBeneficiarySnapshot(base);
  for (const [netAtomic, expected] of [
    ["5", [3n, 2n]],
    ["1", [1n, 0n]],
    ["0", [0n, 0n]],
  ] as const) {
    const outcome = allocateMegapotOwnerWinnings({ netAtomic, snapshot, sha256 });
    expect(outcome.kind).toBe("owner_allocations");
    if (outcome.kind !== "owner_allocations") throw new Error("expected owner allocations");
    expect(outcome.allocations.map(({ amountAtomic }) => amountAtomic)).toEqual([...expected]);
    expect(outcome.allocations.map(({ ownerId, ordinal }) => ({ ownerId, ordinal }))).toEqual([
      { ownerId: guest.ownerId, ordinal: 0 },
      { ownerId: account.ownerId, ordinal: 1 },
    ]);
    expect(outcome.allocations.reduce((sum, row) => sum + row.amountAtomic, 0n)).toBe(
      BigInt(netAtomic),
    );
    expect(outcome.totalAtomic).toBe(BigInt(netAtomic));
  }
});

test("uses a separate sponsor outcome and the literal fallback qualification", () => {
  const snapshot = buildMegapotOwnerBeneficiarySnapshot({
    ...base,
    fallback: true,
    beneficiaries: [{ ...account, qualificationId: "fallback" }],
  });
  expect(
    snapshot.privateLeaves.map(({ orderKey, leafCommitment }) => ({ orderKey, leafCommitment })),
  ).toEqual([
    {
      orderKey: "0x6c8f2215cb1ed071e9e9d0f63b99be0cdfbe085c9b783a71a6e8221b1a56e91e",
      leafCommitment: "0xfd1401173753646de6c700af0b2366364df224ad2ec1b3789f628ceecbfb3254",
    },
  ]);
  expect(snapshot.published.snapshotHash).toBe(
    "0x4dee8361f1013fa52b92e927e074775b84bc20442064b06a409d150273d10651",
  );
  expect(allocateMegapotOwnerWinnings({ netAtomic: "5", snapshot, sha256 })).toEqual({
    kind: "fallback_sponsorship_credit",
    sponsorOwnerId: account.ownerId,
    sponsorPersonaId: account.originalPersonaId,
    amountAtomic: 5n,
  });
  expect(() => buildMegapotOwnerBeneficiarySnapshot({ ...base, fallback: true })).toThrow(
    "invalid-snapshot",
  );
  expect(() =>
    buildMegapotOwnerBeneficiarySnapshot({ ...base, fallback: true, beneficiaries: [account] }),
  ).toThrow("invalid-snapshot");
  expect(() =>
    buildMegapotOwnerBeneficiarySnapshot({
      ...base,
      fallback: true,
      beneficiaries: [{ ...guest, qualificationId: "fallback" }],
    }),
  ).toThrow("invalid-snapshot");
  expect(() =>
    buildMegapotOwnerBeneficiarySnapshot({
      ...base,
      beneficiaries: [{ ...account, qualificationId: "fallback" }],
    }),
  ).toThrow("invalid-snapshot");
  expect(() => buildMegapotOwnerBeneficiarySnapshot({ ...base, beneficiaries: [] })).toThrow(
    "empty-beneficiaries",
  );
});

test("rejects malformed identifiers, salts, hashes, duplicate owners and qualifications", () => {
  for (const ownerId of [
    "",
    " owner",
    "owner ",
    "owner\u0000bad",
    "owner_\ud800",
    "owner_\udc00",
    "owner\nid",
    "owner\tname",
    "owner\u0001id",
    "o".repeat(129),
  ]) {
    expect(() =>
      buildMegapotOwnerBeneficiarySnapshot({ ...base, beneficiaries: [{ ...guest, ownerId }] }),
    ).toThrow("invalid-identifier");
  }
  for (const leafSalt of [
    "",
    `0x${"01".repeat(31)}`,
    `0x${"01".repeat(33)}`,
    `0x${"AB".repeat(32)}`,
    `${guest.leafSalt}\n`,
    "02".repeat(32),
  ]) {
    expect(() =>
      buildMegapotOwnerBeneficiarySnapshot({ ...base, beneficiaries: [{ ...guest, leafSalt }] }),
    ).toThrow("invalid-hash");
  }
  expect(() =>
    buildMegapotOwnerBeneficiarySnapshot({ ...base, poolLegId: "pool\u0000bad" }),
  ).toThrow("invalid-identifier");
  expect(() =>
    buildMegapotOwnerBeneficiarySnapshot({ ...base, termsHash: `${base.termsHash}\n` }),
  ).toThrow("invalid-hash");
  expect(() =>
    buildMegapotOwnerBeneficiarySnapshot({
      ...base,
      beneficiaries: [{ ...account, originalPersonaId: "" }],
    }),
  ).toThrow("invalid-identifier");
  expect(() =>
    buildMegapotOwnerBeneficiarySnapshot({
      ...base,
      beneficiaries: [{ ...guest, qualificationId: "" }],
    }),
  ).toThrow("invalid-identifier");
  expect(() =>
    buildMegapotOwnerBeneficiarySnapshot({ ...base, beneficiaries: [guest, guest] }),
  ).toThrow("duplicate-beneficiary");
  expect(() =>
    buildMegapotOwnerBeneficiarySnapshot({
      ...base,
      beneficiaries: [guest, { ...guest, ownerId: "other_owner" }],
    }),
  ).toThrow("invalid-snapshot");
});

test("rejects out-of-u256 drawings, malformed digest results and noncanonical amounts", () => {
  for (const drawingId of [-1n, 1n << 256n]) {
    expect(() => buildMegapotOwnerBeneficiarySnapshot({ ...base, drawingId })).toThrow(
      "invalid-drawing",
    );
  }
  expect(() =>
    buildMegapotOwnerBeneficiarySnapshot({ ...base, sha256: () => new Uint8Array(31) }),
  ).toThrow("invalid-digest");
  expect(
    buildMegapotOwnerBeneficiarySnapshot({ ...base, drawingId: (1n << 256n) - 1n }).published
      .drawingId,
  ).toBe(((1n << 256n) - 1n).toString());
  const snapshot = buildMegapotOwnerBeneficiarySnapshot(base);
  for (const netAtomic of ["", "00", "01", "+1", "-1", "-0", "1.0", "1e2", " 1", "1 ", "1\n"]) {
    expect(() => allocateMegapotOwnerWinnings({ netAtomic, snapshot, sha256 })).toThrow(
      "invalid-amount",
    );
  }
  expect(parseMegapotOwnerAtomicAmount("0")).toBe(0n);
  expect(parseMegapotOwnerAtomicAmount("9007199254740993")).toBe(9007199254740993n);
});

test("refuses reordered or altered private leaves and mismatched published evidence", () => {
  const snapshot = buildMegapotOwnerBeneficiarySnapshot(base);
  const corrupt = [
    { ...snapshot, privateLeaves: [...snapshot.privateLeaves].reverse() },
    {
      ...snapshot,
      privateLeaves: snapshot.privateLeaves.map((leaf) => ({
        ...leaf,
        leafSalt: `0x${"04".repeat(32)}`,
      })),
    },
    {
      ...snapshot,
      privateLeaves: snapshot.privateLeaves.map((leaf) => ({
        ...leaf,
        orderKey: `0x${"00".repeat(32)}`,
      })),
    },
    { ...snapshot, published: { ...snapshot.published, leafCount: 1 } },
    {
      ...snapshot,
      published: {
        ...snapshot.published,
        leafCommitments: [...snapshot.published.leafCommitments].reverse(),
      },
    },
    { ...snapshot, published: { ...snapshot.published, snapshotHash: `0x${"00".repeat(32)}` } },
  ];
  for (const changed of corrupt) {
    expect(() =>
      allocateMegapotOwnerWinnings({ netAtomic: "5", snapshot: changed, sha256 }),
    ).toThrow("invalid-snapshot");
  }
  expect(() =>
    allocateMegapotOwnerWinnings({
      netAtomic: "5",
      sha256,
      snapshot: { ...snapshot, published: { ...snapshot.published, drawingId: "07" } },
    }),
  ).toThrow("invalid-drawing");
});

test("keeps accepted v2 SHA-256 commitment vectors unchanged", () => {
  const input = {
    poolLegId: "pool_fixture",
    drawingId: 7n,
    termsHash: base.termsHash,
    fallback: false,
    beneficiaries: [{ accountId: "account_fixture", personaId: "persona_fixture" }],
    sha256,
  };
  const snapshot = buildMegapotBeneficiarySnapshot(input);
  expect(snapshot.privateLeaves).toEqual([
    {
      accountId: "account_fixture",
      personaId: "persona_fixture",
      orderKey: "0xb27c30b7dae912c708de5264462e888ac50b9120f324c9aa09eb7cca51505536",
      leafCommitment: "0x788efcff9b785c3df3703b5f89218869e805dac46b231c242789ce396fae14da",
    },
  ]);
  expect(snapshot.published.snapshotHash).toBe(
    "0x521308c4dc381520a36c4c9805b08797336c59f94669428a47bb66e5368c04da",
  );
  expect(buildMegapotBeneficiarySnapshot({ ...input, fallback: true }).published.snapshotHash).toBe(
    "0xde4dcb31846fce1dd043e513223ac57abd8e4c7b1379ecb7dd9e37486355e4b8",
  );
});
